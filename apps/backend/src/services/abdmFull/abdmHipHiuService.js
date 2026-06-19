/**
 * ABDM HIP/HIU service (Phase D1).
 *
 * Manages the eight tables added in migration 124:
 *   - abha_profiles               (per-patient ABHA master)
 *   - abdm_facility_mappings      (HFR — Health Facility Registry)
 *   - abdm_practitioner_mappings  (HPR — Health Professional Registry)
 *   - abdm_care_contexts          (HIP-side linked records)
 *   - abdm_consent_requests       (HIU-side request to HIE-CM)
 *   - abdm_consent_artifacts      (HIE-CM-issued, signed artifact)
 *   - abdm_data_transfers         (HIP push of bundle to HIU)
 *   - abdm_webhook_events         (idempotency-tracked inbound log)
 *
 * Each table is environment-aware (sandbox / production) so a tenant
 * can run dual-track without conflict during certification.
 *
 * Decision-support only: this service stores + transitions records.
 * The actual outbound HTTP calls to ABDM gateway live in a separate
 * adapter (abdmGatewayAdapter); this service is the persistence +
 * audit floor.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const KYC_METHODS = ['aadhaar_otp', 'mobile_otp', 'face_auth', 'manual', 'other'];
export const ABHA_STATUSES = ['active', 'suspended', 'deactivated', 'archived'];
export const FACILITY_OWNERSHIPS = [
  'private', 'government', 'trust', 'corporate', 'cooperative', 'public_private', 'other',
];
export const FACILITY_KINDS = [
  'hospital', 'clinic', 'lab', 'pharmacy', 'imaging_center', 'wellness_center', 'other',
];
export const REGISTRATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected', 'suspended'];
export const HI_TYPES = [
  'OPConsultation', 'DischargeSummary', 'Prescription',
  'DiagnosticReport', 'ImmunizationRecord', 'WellnessRecord',
  'HealthDocumentRecord',
];
export const CARE_CONTEXT_STATUSES = ['draft', 'linked', 'unlinked', 'archived'];
export const CONSENT_FLOW_KINDS = ['hiu', 'hip', 'self'];
export const CONSENT_PERMISSIONS = ['view', 'store', 'view_store'];
export const CONSENT_PURPOSES = ['CAREMGT', 'BTG', 'PUBHTH', 'HPAYMT', 'DSRCH', 'PATRQT', 'OTHER'];
export const CONSENT_REQUEST_STATUSES = ['requested', 'granted', 'denied', 'revoked', 'expired', 'failed'];
export const CONSENT_ARTIFACT_STATUSES = ['active', 'revoked', 'expired'];
export const DATA_TRANSFER_DIRECTIONS = ['out', 'in'];
export const DATA_TRANSFER_STATUSES = ['pending', 'in_flight', 'succeeded', 'failed', 'partial'];
export const ENCRYPTION_KINDS = [
  'ecdh_aes_256_gcm', 'ecdh_aes_128_gcm', 'rsa_oaep', 'manual', 'other',
];
export const WEBHOOK_STATUSES = ['pending', 'processed', 'duplicate', 'failed', 'rejected'];
export const ENVIRONMENTS = ['sandbox', 'production'];

const REQUEST_TRANSITIONS = {
  requested: ['granted', 'denied', 'revoked', 'expired', 'failed'],
  granted: ['revoked', 'expired'],
  denied: [],
  revoked: [],
  expired: [],
  failed: [],
};

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeStringArray(value, label, { allowed = null, max = 50 } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  if (value.length > max) throw AppError.badRequest(`${label} max length is ${max}`);
  return value.map((v) => {
    const text = safeText(v, 120);
    if (!text) throw AppError.badRequest(`${label} entries cannot be empty`);
    if (allowed && !allowed.includes(text)) {
      throw AppError.badRequest(`${label} entries must be one of: ${allowed.join(', ')}`);
    }
    return text;
  });
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  return text;
}

function envOrDefault(value) {
  return normalizeEnum(value, ENVIRONMENTS, 'environment') || 'sandbox';
}

// ---------------------------------------------------------------------------
// abha_profiles
// ---------------------------------------------------------------------------

const ABHA_RETURNING = `id, tenant_id, patient_uid, abha_id, abha_address,
  full_name, date_of_birth, gender, state_code, district_code, pincode,
  kyc_verified, kyc_method, status, linked_at,
  metadata, created_at, updated_at`;

export async function upsertAbhaProfile({
  tenantId = null,
  patientUid,
  abhaId,
  abhaAddress = null,
  fullName = null,
  dateOfBirth = null,
  gender = null,
  stateCode = null,
  districtCode = null,
  pincode = null,
  kycVerified = false,
  kycMethod = null,
  status = 'active',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(patientUid, 'patient_uid', { required: true });
  const cleanAbha = safeText(abhaId, 40);
  if (!cleanAbha) throw AppError.badRequest('abha_id is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abha_profiles
         (tenant_id, patient_uid, abha_id, abha_address, full_name, date_of_birth,
          gender, state_code, district_code, pincode,
          kyc_verified, kyc_method, status, linked_at, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date,
         $7, $8, $9, $10,
         $11, $12, $13, NOW(), $14::jsonb)
       ON CONFLICT (tenant_id, abha_id) DO UPDATE SET
         patient_uid = EXCLUDED.patient_uid,
         abha_address = EXCLUDED.abha_address,
         full_name = EXCLUDED.full_name,
         date_of_birth = EXCLUDED.date_of_birth,
         gender = EXCLUDED.gender,
         state_code = EXCLUDED.state_code,
         district_code = EXCLUDED.district_code,
         pincode = EXCLUDED.pincode,
         kyc_verified = EXCLUDED.kyc_verified,
         kyc_method = EXCLUDED.kyc_method,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING ${ABHA_RETURNING}`,
      tid, cleanUid, cleanAbha,
      safeText(abhaAddress, 120),
      safeText(fullName, SHORT_MAX),
      normalizeDate(dateOfBirth, 'date_of_birth'),
      safeText(gender, 20),
      safeText(stateCode, 20),
      safeText(districtCode, 20),
      safeText(pincode, 20),
      normalizeBoolean(kycVerified, false),
      normalizeEnum(kycMethod, KYC_METHODS, 'kyc_method'),
      normalizeEnum(status, ABHA_STATUSES, 'status') || 'active',
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict('ABHA profile already linked to a different patient');
    }
    throw err;
  }
}

export async function getAbhaProfileByAbhaId({ tenantId = null, abhaId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanAbha = safeText(abhaId, 40);
  if (!cleanAbha) throw AppError.badRequest('abha_id is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ABHA_RETURNING} FROM abha_profiles
       WHERE tenant_id = $1::uuid AND abha_id = $2 LIMIT 1`,
      tid, cleanAbha,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listAbhaProfiles({
  tenantId = null, status = null, kycVerified = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, ABHA_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (kycVerified !== null) {
    params.push(normalizeBoolean(kycVerified));
    filters.push(`kyc_verified = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ABHA_RETURNING} FROM abha_profiles
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { profiles: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { profiles: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// abdm_facility_mappings (HFR)
// ---------------------------------------------------------------------------

const FACILITY_RETURNING = `id, tenant_id, facility_id, hfr_id, facility_name,
  ownership_kind, facility_kind, registration_status,
  state_code, district_code, pincode,
  metadata, created_by, created_at, updated_at`;

export async function upsertFacilityMapping({
  tenantId = null, facilityId = null,
  hfrId, facilityName, ownershipKind = null, facilityKind = null,
  registrationStatus = 'unverified',
  stateCode = null, districtCode = null, pincode = null,
  metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanHfr = safeText(hfrId, 120);
  if (!cleanHfr) throw AppError.badRequest('hfr_id is required');
  const cleanName = safeText(facilityName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('facility_name is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_facility_mappings
         (tenant_id, facility_id, hfr_id, facility_name,
          ownership_kind, facility_kind, registration_status,
          state_code, district_code, pincode, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::uuid)
       ON CONFLICT (tenant_id, hfr_id) DO UPDATE SET
         facility_id = EXCLUDED.facility_id,
         facility_name = EXCLUDED.facility_name,
         ownership_kind = EXCLUDED.ownership_kind,
         facility_kind = EXCLUDED.facility_kind,
         registration_status = EXCLUDED.registration_status,
         state_code = EXCLUDED.state_code,
         district_code = EXCLUDED.district_code,
         pincode = EXCLUDED.pincode,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING ${FACILITY_RETURNING}`,
      tid,
      facilityId ? normalizeId(facilityId, 'facility_id') : null,
      cleanHfr, cleanName,
      normalizeEnum(ownershipKind, FACILITY_OWNERSHIPS, 'ownership_kind'),
      normalizeEnum(facilityKind, FACILITY_KINDS, 'facility_kind'),
      normalizeEnum(registrationStatus, REGISTRATION_STATUSES, 'registration_status') || 'unverified',
      safeText(stateCode, 20), safeText(districtCode, 20), safeText(pincode, 20),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid facility_id');
    throw err;
  }
}

export async function listFacilityMappings({
  tenantId = null, registrationStatus = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (registrationStatus) {
    params.push(normalizeEnum(registrationStatus, REGISTRATION_STATUSES, 'registration_status'));
    filters.push(`registration_status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${FACILITY_RETURNING} FROM abdm_facility_mappings
       WHERE ${filters.join(' AND ')}
       ORDER BY facility_name`,
      ...params,
    );
    return { mappings: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { mappings: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// abdm_practitioner_mappings (HPR)
// ---------------------------------------------------------------------------

const PRACTITIONER_RETURNING = `id, tenant_id, staff_uid, hpr_id, full_name,
  specialty, council_name, registration_number, registration_year,
  qualification, status, metadata, created_at, updated_at`;

export async function upsertPractitionerMapping({
  tenantId = null, staffUid = null,
  hprId, fullName,
  specialty = null, councilName = null, registrationNumber = null,
  registrationYear = null, qualification = null,
  status = 'unverified', metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanHpr = safeText(hprId, 120);
  if (!cleanHpr) throw AppError.badRequest('hpr_id is required');
  const cleanName = safeText(fullName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('full_name is required');
  let regYear = null;
  if (registrationYear !== null && registrationYear !== undefined) {
    const y = Number.parseInt(registrationYear, 10);
    if (!Number.isFinite(y) || y < 1900 || y > 2100) {
      throw AppError.badRequest('registration_year must be 1900..2100');
    }
    regYear = y;
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_practitioner_mappings
       (tenant_id, staff_uid, hpr_id, full_name, specialty, council_name,
        registration_number, registration_year, qualification, status, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (tenant_id, hpr_id) DO UPDATE SET
       staff_uid = EXCLUDED.staff_uid,
       full_name = EXCLUDED.full_name,
       specialty = EXCLUDED.specialty,
       council_name = EXCLUDED.council_name,
       registration_number = EXCLUDED.registration_number,
       registration_year = EXCLUDED.registration_year,
       qualification = EXCLUDED.qualification,
       status = EXCLUDED.status,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING ${PRACTITIONER_RETURNING}`,
    tid, maybeUuid(staffUid, 'staff_uid'),
    cleanHpr, cleanName,
    safeText(specialty, 120), safeText(councilName, 120),
    safeText(registrationNumber, 120), regYear,
    safeText(qualification, SHORT_MAX),
    normalizeEnum(status, REGISTRATION_STATUSES, 'status') || 'unverified',
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listPractitionerMappings({ tenantId = null, status = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, REGISTRATION_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PRACTITIONER_RETURNING} FROM abdm_practitioner_mappings
       WHERE ${filters.join(' AND ')}
       ORDER BY full_name`,
      ...params,
    );
    return { mappings: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { mappings: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// abdm_care_contexts
// ---------------------------------------------------------------------------

const CARE_CONTEXT_RETURNING = `id, tenant_id, abha_profile_id, patient_uid,
  facility_mapping_id, reference_id, display, hi_type,
  source_resource_type, source_resource_id, status,
  linked_at, unlinked_at, metadata, created_at, updated_at`;

export async function linkCareContext({
  tenantId = null, abhaProfileId = null,
  patientUid, facilityMappingId = null,
  referenceId, display = null, hiType,
  sourceResourceType = null, sourceResourceId = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanRef = safeText(referenceId, 120);
  if (!cleanRef) throw AppError.badRequest('reference_id is required');
  const cleanUid = maybeUuid(patientUid, 'patient_uid', { required: true });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_care_contexts
         (tenant_id, abha_profile_id, patient_uid, facility_mapping_id,
          reference_id, display, hi_type,
          source_resource_type, source_resource_id, status, linked_at, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7,
               $8, $9, 'linked', NOW(), $10::jsonb)
       RETURNING ${CARE_CONTEXT_RETURNING}`,
      tid,
      abhaProfileId ? normalizeId(abhaProfileId, 'abha_profile_id') : null,
      cleanUid,
      facilityMappingId ? normalizeId(facilityMappingId, 'facility_mapping_id') : null,
      cleanRef, safeText(display, SHORT_MAX),
      normalizeEnum(hiType, HI_TYPES, 'hi_type', { required: true }),
      safeText(sourceResourceType, 60), safeText(sourceResourceId, 120),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('Care context with that reference_id already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid abha_profile_id or facility_mapping_id');
    throw err;
  }
}

export async function unlinkCareContext({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const ctxId = normalizeId(id, 'care_context id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_care_contexts
     SET status = 'unlinked', unlinked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'linked'
     RETURNING ${CARE_CONTEXT_RETURNING}`,
    ctxId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Care context not found or not linked');
  return rows[0];
}

export async function listCareContexts({
  tenantId = null, patientUid = null, hiType = null, status = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (hiType) {
    params.push(normalizeEnum(hiType, HI_TYPES, 'hi_type'));
    filters.push(`hi_type = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, CARE_CONTEXT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${CARE_CONTEXT_RETURNING} FROM abdm_care_contexts
       WHERE ${filters.join(' AND ')}
       ORDER BY linked_at DESC NULLS LAST, created_at DESC`,
      ...params,
    );
    return { care_contexts: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { care_contexts: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// abdm_consent_requests + abdm_consent_artifacts
// ---------------------------------------------------------------------------

const REQUEST_RETURNING = `id, tenant_id, request_id, flow_kind,
  abha_id, abha_profile_id, patient_uid, requester_uid,
  hi_types, permission_kind, data_from, data_to, expiry_at, purpose_code,
  status, requested_at, decided_at, notification_failure,
  environment, metadata, created_at, updated_at`;

export async function createConsentRequest({
  tenantId = null,
  requestId,
  flowKind = 'hiu',
  abhaId = null,
  abhaProfileId = null,
  patientUid = null,
  requesterUid = null,
  hiTypes = [],
  permissionKind = 'view',
  dataFrom = null,
  dataTo = null,
  expiryAt = null,
  purposeCode = 'CAREMGT',
  environment = 'sandbox',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanReq = safeText(requestId, 120);
  if (!cleanReq) throw AppError.badRequest('request_id is required');
  const env = envOrDefault(environment);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_consent_requests
         (tenant_id, request_id, flow_kind, abha_id, abha_profile_id, patient_uid,
          requester_uid, hi_types, permission_kind, data_from, data_to, expiry_at,
          purpose_code, status, environment, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid,
         $8::text[], $9, $10::timestamptz, $11::timestamptz, $12::timestamptz,
         $13, 'requested', $14, $15::jsonb)
       RETURNING ${REQUEST_RETURNING}`,
      tid, cleanReq,
      normalizeEnum(flowKind, CONSENT_FLOW_KINDS, 'flow_kind') || 'hiu',
      safeText(abhaId, 40),
      abhaProfileId ? normalizeId(abhaProfileId, 'abha_profile_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(requesterUid, 'requester_uid'),
      normalizeStringArray(hiTypes, 'hi_types', { allowed: HI_TYPES }),
      normalizeEnum(permissionKind, CONSENT_PERMISSIONS, 'permission_kind') || 'view',
      normalizeTimestamp(dataFrom, 'data_from'),
      normalizeTimestamp(dataTo, 'data_to'),
      normalizeTimestamp(expiryAt, 'expiry_at'),
      normalizeEnum(purposeCode, CONSENT_PURPOSES, 'purpose_code') || 'CAREMGT',
      env,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('Consent request_id already exists for this environment');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid abha_profile_id');
    throw err;
  }
}

export async function transitionConsentRequest({
  tenantId = null, id, nextStatus, notificationFailure = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const reqId = normalizeId(id, 'consent_request id');
  const cleanStatus = normalizeEnum(nextStatus, CONSENT_REQUEST_STATUSES, 'next_status', { required: true });
  const current = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM abdm_consent_requests
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    reqId, tid,
  );
  if (!current[0]) throw AppError.notFound('Consent request not found');
  const allowed = REQUEST_TRANSITIONS[current[0].status] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(current[0].status, cleanStatus, allowed);
  }
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus !== 'requested') {
    params.push(new Date().toISOString());
    updates.push(`decided_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'failed' && notificationFailure) {
    params.push(safeText(notificationFailure));
    updates.push(`notification_failure = $${params.length}`);
  }
  params.push(reqId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_consent_requests SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${REQUEST_RETURNING}`,
    ...params,
  );
  return rows[0];
}

const ARTIFACT_RETURNING = `id, tenant_id, consent_request_id, artifact_id,
  abha_id, patient_uid, hi_types, permission_kind,
  data_from, data_to, expiry_at, status,
  signed_payload, signature_kid, signature_algorithm,
  granted_at, revoked_at, expired_at, environment,
  metadata, created_at, updated_at`;

export async function recordConsentArtifact({
  tenantId = null,
  consentRequestId = null,
  artifactId,
  abhaId = null,
  patientUid = null,
  hiTypes = [],
  permissionKind,
  dataFrom = null,
  dataTo = null,
  expiryAt = null,
  signedPayload = null,
  signatureKid = null,
  signatureAlgorithm = null,
  environment = 'sandbox',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanArtifact = safeText(artifactId, 120);
  if (!cleanArtifact) throw AppError.badRequest('artifact_id is required');
  const env = envOrDefault(environment);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_consent_artifacts
         (tenant_id, consent_request_id, artifact_id, abha_id, patient_uid,
          hi_types, permission_kind, data_from, data_to, expiry_at,
          status, signed_payload, signature_kid, signature_algorithm,
          granted_at, environment, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid,
         $6::text[], $7, $8::timestamptz, $9::timestamptz, $10::timestamptz,
         'active', $11::jsonb, $12, $13, NOW(), $14, $15::jsonb)
       RETURNING ${ARTIFACT_RETURNING}`,
      tid,
      consentRequestId ? normalizeId(consentRequestId, 'consent_request_id') : null,
      cleanArtifact,
      safeText(abhaId, 40),
      maybeUuid(patientUid, 'patient_uid'),
      normalizeStringArray(hiTypes, 'hi_types', { allowed: HI_TYPES }),
      normalizeEnum(permissionKind, CONSENT_PERMISSIONS, 'permission_kind', { required: true }),
      normalizeTimestamp(dataFrom, 'data_from'),
      normalizeTimestamp(dataTo, 'data_to'),
      normalizeTimestamp(expiryAt, 'expiry_at'),
      JSON.stringify(normalizeJsonObject(signedPayload, 'signed_payload')),
      safeText(signatureKid, 120),
      safeText(signatureAlgorithm, 40),
      env,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('Consent artifact_id already exists for this environment');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid consent_request_id');
    throw err;
  }
}

export async function revokeConsentArtifact({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const aId = normalizeId(id, 'artifact id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_consent_artifacts
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'active'
     RETURNING ${ARTIFACT_RETURNING}`,
    aId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Active consent artifact not found');
  return rows[0];
}

export async function expireConsentArtifacts({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE abdm_consent_artifacts
       SET status = 'expired', expired_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1::uuid AND status = 'active'
         AND expiry_at IS NOT NULL AND expiry_at < NOW()
       RETURNING id`,
      tid,
    );
    return { expired_count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { expired_count: 0 };
    throw err;
  }
}

export async function listConsentArtifacts({
  tenantId = null, status = null, abhaId = null, environment = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, CONSENT_ARTIFACT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (abhaId) {
    params.push(safeText(abhaId, 40));
    filters.push(`abha_id = $${params.length}`);
  }
  if (environment) {
    params.push(envOrDefault(environment));
    filters.push(`environment = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ARTIFACT_RETURNING} FROM abdm_consent_artifacts
       WHERE ${filters.join(' AND ')}
       ORDER BY granted_at DESC`,
      ...params,
    );
    return { artifacts: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { artifacts: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// abdm_data_transfers
// ---------------------------------------------------------------------------

const TRANSFER_RETURNING = `id, tenant_id, consent_artifact_id, transaction_id,
  patient_uid, abha_id, direction, bundle_kind, payload_size_bytes,
  encryption_kind, destination_url, status, attempt_count,
  started_at, completed_at, failure_reason, hi_types, environment,
  metadata, created_at, updated_at`;

export async function createDataTransfer({
  tenantId = null,
  consentArtifactId = null,
  transactionId,
  patientUid = null,
  abhaId = null,
  direction = 'out',
  bundleKind = null,
  payloadSizeBytes = null,
  encryptionKind = null,
  destinationUrl = null,
  hiTypes = [],
  environment = 'sandbox',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTxn = safeText(transactionId, 120);
  if (!cleanTxn) throw AppError.badRequest('transaction_id is required');
  let payloadSize = null;
  if (payloadSizeBytes !== null && payloadSizeBytes !== undefined) {
    const n = Number(payloadSizeBytes);
    if (!Number.isFinite(n) || n < 0) throw AppError.badRequest('payload_size_bytes must be >= 0');
    payloadSize = Math.round(n);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_data_transfers
         (tenant_id, consent_artifact_id, transaction_id, patient_uid, abha_id,
          direction, bundle_kind, payload_size_bytes, encryption_kind, destination_url,
          status, hi_types, environment, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5,
         $6, $7, $8, $9, $10, 'pending', $11::text[], $12, $13::jsonb)
       RETURNING ${TRANSFER_RETURNING}`,
      tid,
      consentArtifactId ? normalizeId(consentArtifactId, 'consent_artifact_id') : null,
      cleanTxn, maybeUuid(patientUid, 'patient_uid'),
      safeText(abhaId, 40),
      normalizeEnum(direction, DATA_TRANSFER_DIRECTIONS, 'direction') || 'out',
      safeText(bundleKind, 60),
      payloadSize,
      normalizeEnum(encryptionKind, ENCRYPTION_KINDS, 'encryption_kind'),
      safeText(destinationUrl),
      normalizeStringArray(hiTypes, 'hi_types', { allowed: HI_TYPES }),
      envOrDefault(environment),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('transaction_id already exists for this environment');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid consent_artifact_id');
    throw err;
  }
}

export async function transitionDataTransfer({
  tenantId = null, id, nextStatus, failureReason = null, attemptIncrement = false,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const transferId = normalizeId(id, 'data_transfer id');
  const cleanStatus = normalizeEnum(nextStatus, DATA_TRANSFER_STATUSES, 'next_status', { required: true });
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'in_flight') {
    params.push(new Date().toISOString());
    updates.push(`started_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'succeeded' || cleanStatus === 'failed' || cleanStatus === 'partial') {
    params.push(new Date().toISOString());
    updates.push(`completed_at = $${params.length}::timestamptz`);
  }
  if (failureReason) {
    params.push(safeText(failureReason));
    updates.push(`failure_reason = $${params.length}`);
  }
  if (attemptIncrement) {
    updates.push(`attempt_count = attempt_count + 1`);
  }
  params.push(transferId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_data_transfers SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${TRANSFER_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Data transfer not found');
  return rows[0];
}

export async function listDataTransfers({
  tenantId = null, status = null, direction = null, environment = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, DATA_TRANSFER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (direction) {
    params.push(normalizeEnum(direction, DATA_TRANSFER_DIRECTIONS, 'direction'));
    filters.push(`direction = $${params.length}`);
  }
  if (environment) {
    params.push(envOrDefault(environment));
    filters.push(`environment = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TRANSFER_RETURNING} FROM abdm_data_transfers
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { transfers: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { transfers: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// abdm_webhook_events (idempotency-tracked)
// ---------------------------------------------------------------------------

const WEBHOOK_RETURNING = `id, tenant_id, external_event_id, event_type, source,
  signature_verified, signature_kid, payload, received_at, status,
  processed_at, failure_reason, related_request_id, related_artifact_id,
  related_transfer_id, environment, metadata, created_at`;

/**
 * Idempotency-aware webhook intake. If an event with the same
 * (tenant, external_event_id, environment) already exists, returns the
 * existing row + status='duplicate' without re-inserting.
 */
export async function recordWebhookEvent({
  tenantId = null,
  externalEventId,
  eventType,
  source = null,
  signatureVerified = false,
  signatureKid = null,
  payload = null,
  environment = 'sandbox',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanExt = safeText(externalEventId, 160);
  if (!cleanExt) throw AppError.badRequest('external_event_id is required');
  const cleanType = safeText(eventType, 120);
  if (!cleanType) throw AppError.badRequest('event_type is required');
  const env = envOrDefault(environment);
  // Idempotency check first.
  try {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT ${WEBHOOK_RETURNING} FROM abdm_webhook_events
       WHERE tenant_id = $1::uuid AND external_event_id = $2 AND environment = $3
       LIMIT 1`,
      tid, cleanExt, env,
    );
    if (existing[0]) {
      return { event: existing[0], duplicate: true };
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source,
          signature_verified, signature_kid, payload, status, environment, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $9::jsonb)
       RETURNING ${WEBHOOK_RETURNING}`,
      tid, cleanExt, cleanType,
      safeText(source, 80),
      normalizeBoolean(signatureVerified, false),
      safeText(signatureKid, 120),
      JSON.stringify(normalizeJsonObject(payload, 'payload')),
      env,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return { event: rows[0], duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT ${WEBHOOK_RETURNING} FROM abdm_webhook_events
         WHERE tenant_id = $1::uuid AND external_event_id = $2 AND environment = $3
         LIMIT 1`,
        tid, cleanExt, env,
      );
      return { event: existing[0], duplicate: true };
    }
    throw err;
  }
}

export async function markWebhookProcessed({
  tenantId = null, id, status = 'processed', failureReason = null,
  relatedRequestId = null, relatedArtifactId = null, relatedTransferId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const evtId = normalizeId(id, 'webhook id');
  const cleanStatus = normalizeEnum(status, WEBHOOK_STATUSES, 'status') || 'processed';
  const updates = ['status = $1', 'processed_at = NOW()'];
  const params = [cleanStatus];
  if (failureReason) {
    params.push(safeText(failureReason));
    updates.push(`failure_reason = $${params.length}`);
  }
  if (relatedRequestId) {
    params.push(normalizeId(relatedRequestId, 'related_request_id'));
    updates.push(`related_request_id = $${params.length}`);
  }
  if (relatedArtifactId) {
    params.push(normalizeId(relatedArtifactId, 'related_artifact_id'));
    updates.push(`related_artifact_id = $${params.length}`);
  }
  if (relatedTransferId) {
    params.push(normalizeId(relatedTransferId, 'related_transfer_id'));
    updates.push(`related_transfer_id = $${params.length}`);
  }
  params.push(evtId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_webhook_events SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${WEBHOOK_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Webhook event not found');
  return rows[0];
}

export async function listWebhookEvents({
  tenantId = null, status = null, eventType = null, environment = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, WEBHOOK_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (eventType) {
    params.push(safeText(eventType, 120));
    filters.push(`event_type = $${params.length}`);
  }
  if (environment) {
    params.push(envOrDefault(environment));
    filters.push(`environment = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${WEBHOOK_RETURNING} FROM abdm_webhook_events
       WHERE ${filters.join(' AND ')}
       ORDER BY received_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { events: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { events: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  REQUEST_TRANSITIONS,
  HI_TYPES,
  CONSENT_REQUEST_STATUSES,
  ENVIRONMENTS,
};

export default {
  upsertAbhaProfile,
  getAbhaProfileByAbhaId,
  listAbhaProfiles,
  upsertFacilityMapping,
  listFacilityMappings,
  upsertPractitionerMapping,
  listPractitionerMappings,
  linkCareContext,
  unlinkCareContext,
  listCareContexts,
  createConsentRequest,
  transitionConsentRequest,
  recordConsentArtifact,
  revokeConsentArtifact,
  expireConsentArtifacts,
  listConsentArtifacts,
  createDataTransfer,
  transitionDataTransfer,
  listDataTransfers,
  recordWebhookEvent,
  markWebhookProcessed,
  listWebhookEvents,
};
