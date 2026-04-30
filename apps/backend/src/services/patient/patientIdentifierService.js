/**
 * Patient identifier CRUD + lookup (Phase A2 PR1).
 *
 * Manages many-to-one identifier rows per patient_uid (MRN, ABHA, mobile,
 * Aadhaar token, passport, insurance, etc.). Backs the duplicate
 * detection + merge workflow that lands in PR2.
 *
 * Sensitive identifiers (Aadhaar, passport, insurance) should be passed
 * with `hashValue: true` so the plaintext is stored in identifier_value
 * but a stable SHA-256 hash is also indexed for fast lookups without
 * round-tripping the raw value through every search endpoint.
 *
 * Decision-support only: this service never mutates the underlying
 * users.uid — it only attaches identifier rows. Merging two patient
 * records is a separate workflow gated by patient_merge_requests.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

export const IDENTIFIER_TYPES = [
  'mrn', 'uhid', 'abha', 'abha_address', 'mobile', 'aadhaar_token',
  'passport', 'insurance', 'tpa_card', 'employee_id', 'external_emr',
  'national_id', 'driving_license', 'other',
];

export const IDENTIFIER_STATUSES = ['active', 'retired', 'merged_into'];

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const VALUE_MAX = 255;
const ISSUER_MAX = 255;

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max) {
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

function maybeUuid(value, label = 'patient_uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeIdentifierType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    throw AppError.badRequest('identifier_type is required');
  }
  if (!IDENTIFIER_TYPES.includes(normalized)) {
    throw AppError.badRequest(
      `identifier_type must be one of: ${IDENTIFIER_TYPES.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeMetadata(value) {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be a JSON object');
  }
  return value;
}

/**
 * Hash a raw identifier value for indexed lookup. Stable across calls so
 * `lookupByIdentifier` can find existing rows without a plaintext compare.
 */
export function hashIdentifierValue(value) {
  return crypto.createHash('sha256').update(String(value || '').trim()).digest('hex');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Attach an identifier to a patient. If the (tenant, type, value) pair
 * already exists in the active set, returns 409.
 */
export async function addPatientIdentifier({
  tenantId = null,
  patientUid,
  identifierType,
  identifierValue,
  hashValue = false,
  issuer = null,
  assignedAt = null,
  expiresAt = null,
  isPrimary = false,
  metadata = {},
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const uid = maybeUuid(patientUid, 'patient_uid');
  if (!uid) throw AppError.badRequest('patient_uid is required');
  const type = normalizeIdentifierType(identifierType);
  const value = safeText(identifierValue, VALUE_MAX);
  if (!value) throw AppError.badRequest('identifier_value is required');
  const valueHash = hashValue ? hashIdentifierValue(value) : null;
  const cleanIssuer = safeText(issuer, ISSUER_MAX);
  const cleanMetadata = normalizeMetadata(metadata);

  try {
    // If isPrimary=true, demote any other primary of the same type for
    // this patient first. Run in a single transaction so the partial
    // unique index never sees two primaries simultaneously.
    return await prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.$queryRawUnsafe(
          `UPDATE patient_identifiers
           SET is_primary = false, updated_at = NOW()
           WHERE tenant_id = $1::uuid
             AND patient_uid = $2::uuid
             AND identifier_type = $3
             AND status = 'active'
             AND is_primary = true`,
          tid, uid, type,
        );
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO patient_identifiers
           (tenant_id, patient_uid, identifier_type, identifier_value,
            identifier_value_hash, issuer, assigned_at, expires_at,
            is_primary, status, metadata, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
                 $7::timestamptz, $8::timestamptz, $9, 'active', $10::jsonb, $11::uuid)
         RETURNING id, tenant_id, patient_uid, identifier_type, identifier_value,
                   identifier_value_hash, issuer, assigned_at, expires_at,
                   is_primary, status, metadata, created_by, created_at, updated_at`,
        tid, uid, type, value, valueHash, cleanIssuer,
        assignedAt, expiresAt, isPrimary, JSON.stringify(cleanMetadata), createdBy,
      );
      return rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        `An active ${type} identifier with that value already exists`,
      );
    }
    throw err;
  }
}

export async function listPatientIdentifiers({
  tenantId = null,
  patientUid,
  status = null,
  identifierType = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const uid = maybeUuid(patientUid, 'patient_uid');
  if (!uid) throw AppError.badRequest('patient_uid is required');
  const filters = ['tenant_id = $1::uuid', 'patient_uid = $2::uuid'];
  const params = [tid, uid];
  if (status) {
    if (!IDENTIFIER_STATUSES.includes(String(status))) {
      throw AppError.badRequest(`status must be one of: ${IDENTIFIER_STATUSES.join(', ')}`);
    }
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (identifierType) {
    params.push(normalizeIdentifierType(identifierType));
    filters.push(`identifier_type = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, identifier_type, identifier_value,
              identifier_value_hash, issuer, assigned_at, expires_at,
              is_primary, status, merged_into_uid, metadata, created_by,
              created_at, updated_at
       FROM patient_identifiers
       WHERE ${filters.join(' AND ')}
       ORDER BY identifier_type, is_primary DESC, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { identifiers: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { identifiers: [], count: 0 };
    throw err;
  }
}

/**
 * Reverse lookup — find the patient_uid for a given (type, value). Used by
 * the dedupe detector and by the route that resolves "patient by ABHA"
 * style requests.
 */
export async function lookupByIdentifier({
  tenantId = null,
  identifierType,
  identifierValue,
  hashValue = false,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const type = normalizeIdentifierType(identifierType);
  const value = safeText(identifierValue, VALUE_MAX);
  if (!value) throw AppError.badRequest('identifier_value is required');
  const filters = ['tenant_id = $1::uuid', 'identifier_type = $2', "status = 'active'"];
  const params = [tid, type];
  if (hashValue) {
    params.push(hashIdentifierValue(value));
    filters.push(`identifier_value_hash = $${params.length}`);
  } else {
    params.push(value);
    filters.push(`identifier_value = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, identifier_type, identifier_value,
              issuer, is_primary, assigned_at, expires_at, metadata,
              created_at, updated_at
       FROM patient_identifiers
       WHERE ${filters.join(' AND ')}
       LIMIT 5`,
      ...params,
    );
    return { identifiers: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { identifiers: [], count: 0 };
    throw err;
  }
}

export async function getPatientIdentifier({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const idVal = normalizeId(id, 'identifier id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, identifier_type, identifier_value,
            identifier_value_hash, issuer, assigned_at, expires_at,
            is_primary, status, merged_into_uid, metadata, created_by,
            created_at, updated_at
     FROM patient_identifiers
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    idVal, tid,
  );
  if (!rows[0]) throw AppError.notFound('Patient identifier not found');
  return rows[0];
}

export async function retirePatientIdentifier({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const idVal = normalizeId(id, 'identifier id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE patient_identifiers
     SET status = 'retired', is_primary = false, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'active'
     RETURNING id, tenant_id, patient_uid, identifier_type, identifier_value,
               status, is_primary, updated_at`,
    idVal, tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Active patient identifier not found');
  }
  return rows[0];
}

export async function setPrimaryIdentifier({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const idVal = normalizeId(id, 'identifier id');
  return await prisma.$transaction(async (tx) => {
    const targetRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, identifier_type, status
       FROM patient_identifiers
       WHERE id = $1 AND tenant_id = $2::uuid
       LIMIT 1`,
      idVal, tid,
    );
    const target = targetRows[0];
    if (!target) throw AppError.notFound('Patient identifier not found');
    if (target.status !== 'active') {
      throw AppError.badRequest('Only active identifiers can be set as primary');
    }
    await tx.$queryRawUnsafe(
      `UPDATE patient_identifiers
       SET is_primary = false, updated_at = NOW()
       WHERE tenant_id = $1::uuid
         AND patient_uid = $2::uuid
         AND identifier_type = $3
         AND status = 'active'
         AND is_primary = true
         AND id <> $4`,
      tid, target.patient_uid, target.identifier_type, idVal,
    );
    const rows = await tx.$queryRawUnsafe(
      `UPDATE patient_identifiers
       SET is_primary = true, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2::uuid
       RETURNING id, tenant_id, patient_uid, identifier_type, identifier_value,
                 issuer, is_primary, status, metadata, created_at, updated_at`,
      idVal, tid,
    );
    return rows[0];
  });
}

/**
 * Move all ACTIVE identifiers from secondary_uid into primary_uid as part
 * of a merge execution. Marks the moved rows status='merged_into' with
 * merged_into_uid pointing at the survivor; the primary's own identifiers
 * stay unchanged.
 *
 * Internal-only: used by the merge workflow service. Wraps the writes in
 * the caller's transaction so a partial merge can roll back cleanly.
 */
export async function reassignIdentifiersForMerge(tx, {
  tenantId,
  primaryUid,
  secondaryUid,
}) {
  const tid = resolveTenantId({ tenantId });
  const primary = maybeUuid(primaryUid, 'primary_uid');
  const secondary = maybeUuid(secondaryUid, 'secondary_uid');
  if (!primary || !secondary || primary === secondary) {
    throw AppError.badRequest('reassignIdentifiersForMerge needs distinct primary + secondary UIDs');
  }
  const result = await tx.$queryRawUnsafe(
    `UPDATE patient_identifiers
     SET patient_uid = $1::uuid,
         status = 'merged_into',
         merged_into_uid = $1::uuid,
         is_primary = false,
         updated_at = NOW()
     WHERE tenant_id = $3::uuid
       AND patient_uid = $2::uuid
       AND status = 'active'
     RETURNING id, identifier_type, identifier_value`,
    primary, secondary, tid,
  );
  return { reassigned: result, count: result.length };
}

export const __testing__ = {
  IDENTIFIER_TYPES,
  IDENTIFIER_STATUSES,
  hashIdentifierValue,
  isMissingSchemaError,
  isUniqueViolation,
  normalizeIdentifierType,
};

export default {
  addPatientIdentifier,
  getPatientIdentifier,
  hashIdentifierValue,
  listPatientIdentifiers,
  lookupByIdentifier,
  reassignIdentifiersForMerge,
  retirePatientIdentifier,
  setPrimaryIdentifier,
};
