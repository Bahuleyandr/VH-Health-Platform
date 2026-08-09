// src/services/abdm/abdmService.js
// ABDM Business Logic — ABHA registration, consent management, health data exchange

import crypto from 'crypto';

import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { maskEmail, maskGeneric } from '../../utils/piiMask.js';
import { assertSafeOutboundUrl } from '../../utils/ssrfGuard.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { encryptFhirBundle } from './abdmCrypto.js';
import abdmGateway from './abdmGateway.js';

// ---------------------------------------------------------------------------
// ABDM consent-artefact verification config (#3). Operator-supplied — never a
// hardcoded sandbox trust in prod. Read from env so the abdmConfig surface is
// untouched:
//   ABDM_VERIFY_CONSENT_ARTEFACT = 'true'  -> enforce CM-signature verification
//   ABDM_CM_PUBLIC_KEY           = PEM      -> the Consent Manager public key
//   ABDM_CM_ID                              -> Consent Manager id stamped on the
//                                              consent artefact (was hardcoded 'sbx')
// ---------------------------------------------------------------------------
function consentArtefactVerificationEnabled() {
  return String(process.env.ABDM_VERIFY_CONSENT_ARTEFACT || '').toLowerCase() === 'true';
}
function consentManagerPublicKey() {
  const pem = process.env.ABDM_CM_PUBLIC_KEY || '';
  return pem.includes('BEGIN') ? pem.replace(/\\n/g, '\n') : (pem || null);
}
function consentManagerId() {
  // Sandbox 'sbx' is only an explicit dev fallback; prod must set ABDM_CM_ID.
  return process.env.ABDM_CM_ID || (ABDM_CONFIG.enabled ? null : 'sbx');
}

const CONSENT_ARTEFACT_REPLAY_NAMESPACE = 'abdm-consent-artefact-sha256';

function normalizeConsentText(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeConsentTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeConsentHiTypes(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value.map(normalizeConsentText);
  return normalized.some((item) => !item) ? null : normalized;
}

function canonicalConsentHiTypes(value) {
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

function consentBindingMismatch(fields) {
  return AppError.forbidden(
    'Consent artefact does not match the notification wrapper',
    'ABDM_CONSENT_BINDING_MISMATCH',
    { fields: [...new Set(fields)] },
  );
}

function projectVerifiedConsent(payload) {
  const invalidFields = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw consentBindingMismatch(['artefact']);
  }

  const projection = {
    consentId: normalizeConsentText(payload.consentId),
    patientAbha: normalizeConsentText(payload.patient?.id),
    hipId: normalizeConsentText(payload.hip?.id),
    hiuId: normalizeConsentText(payload.hiu?.id),
    consentManagerId: normalizeConsentText(payload.consentManager?.id),
    purpose: normalizeConsentText(payload.purpose?.code ?? payload.purpose),
    hiTypes: normalizeConsentHiTypes(payload.hiTypes),
    dateFrom: normalizeConsentTimestamp(payload.permission?.dateRange?.from),
    dateTo: normalizeConsentTimestamp(payload.permission?.dateRange?.to),
    expiryDate: normalizeConsentTimestamp(payload.permission?.dataEraseAt),
    requesterName: normalizeConsentText(payload.requester?.name),
  };

  const requiredScalars = [
    ['consentId', projection.consentId],
    ['patient.id', projection.patientAbha],
    ['hip.id', projection.hipId],
    ['hiu.id', projection.hiuId],
    ['consentManager.id', projection.consentManagerId],
    ['purpose', projection.purpose],
  ];
  for (const [field, value] of requiredScalars) {
    if (!value) invalidFields.push(field);
  }
  if (!projection.hiTypes) invalidFields.push('hiTypes');
  if (!projection.dateFrom) invalidFields.push('dateRange.from');
  if (!projection.dateTo) invalidFields.push('dateRange.to');
  if (!projection.expiryDate) invalidFields.push('expiry');

  if (invalidFields.length > 0) {
    throw consentBindingMismatch(invalidFields);
  }
  return projection;
}

function assertConsentWrapperBinding(wrapper, verified) {
  const mismatches = [];

  const compareText = (field, outerValue, verifiedValue, { required = false } = {}) => {
    if (outerValue === undefined || outerValue === null || outerValue === '') {
      if (required) mismatches.push(field);
      return;
    }
    if (normalizeConsentText(outerValue) !== verifiedValue) mismatches.push(field);
  };
  const compareTimestamp = (field, outerValue, verifiedValue, { required = false } = {}) => {
    if (outerValue === undefined || outerValue === null || outerValue === '') {
      if (required) mismatches.push(field);
      return;
    }
    const normalized = normalizeConsentTimestamp(outerValue);
    if (!normalized || normalized.getTime() !== verifiedValue.getTime()) mismatches.push(field);
  };

  const required = { required: true };
  compareText('consentId', wrapper.consentRequestId, verified.consentId, required);
  compareText('patient.id', wrapper.patient?.id, verified.patientAbha, required);
  compareText('hip.id', wrapper.hip?.id, verified.hipId, required);
  compareText('hip.id', wrapper.authenticatedHipId, verified.hipId, required);
  compareText('hiu.id', wrapper.hiu?.id, verified.hiuId, required);
  compareText('purpose', wrapper.purpose?.code ?? wrapper.purpose, verified.purpose, required);
  compareText(
    'consentManager.id',
    wrapper.consentManager?.id,
    verified.consentManagerId,
    required,
  );
  compareText(
    'consentManager.id',
    wrapper.authenticatedConsentManagerId,
    verified.consentManagerId,
  );

  const configuredConsentManagerId = normalizeConsentText(process.env.ABDM_CM_ID);
  if (configuredConsentManagerId) {
    compareText('consentManager.id', configuredConsentManagerId, verified.consentManagerId);
  }

  const normalizedWrapperHiTypes = normalizeConsentHiTypes(wrapper.hiTypes);
  if (!normalizedWrapperHiTypes || JSON.stringify(canonicalConsentHiTypes(normalizedWrapperHiTypes))
    !== JSON.stringify(canonicalConsentHiTypes(verified.hiTypes))) {
    mismatches.push('hiTypes');
  }

  compareTimestamp('dateRange.from', wrapper.dateRange?.from, verified.dateFrom, required);
  compareTimestamp('dateRange.to', wrapper.dateRange?.to, verified.dateTo, required);
  compareTimestamp('expiry', wrapper.expiry, verified.expiryDate, required);

  if (mismatches.length > 0) {
    throw consentBindingMismatch(mismatches);
  }
}

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for ABDM operations', 'ABDM_TENANT_REQUIRED');
  }
  return tenantId;
}

/** Render 14 ABHA digits in the canonical 2-4-4-4 hyphenated spelling. */
function hyphenateAbhaNumber(cleanAbha) {
  return `${cleanAbha.slice(0, 2)}-${cleanAbha.slice(2, 6)}-${cleanAbha.slice(6, 10)}-${cleanAbha.slice(10)}`;
}

/**
 * Validate + normalize an optional ABHA address ("user@abdm").
 *
 * Deliberately shape-only: the suffix differs by environment (`@abdm` in
 * production, `@sbx` in the sandbox) and the handle rules are set by NHA, so
 * pinning either here would reject valid addresses. This rejects the failure
 * that actually happens — a phone number, a plain name, or an ABHA number
 * typed into the address field — and leaves the rest to the gateway.
 */
function normalizeAbhaAddress(abhaAddress) {
  if (abhaAddress === undefined || abhaAddress === null) return null;
  const trimmed = String(abhaAddress).trim().toLowerCase();
  if (!trimmed) return null;
  // users.abha_address is VARCHAR(100); refuse rather than let Postgres 22001.
  if (trimmed.length > 100 || !/^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]{0,34}$/.test(trimmed)) {
    throw AppError.badRequest(
      'Invalid ABHA address. Expected the form name@abdm.',
      'INVALID_ABHA_ADDRESS',
    );
  }
  return trimmed;
}

function isCanonicalAbhaUniqueViolation(err) {
  const sqlState = err?.meta?.code
    ?? err?.meta?.driverAdapterError?.cause?.originalCode
    ?? err?.code;
  const detail = [
    err?.message,
    err?.meta?.message,
    err?.meta?.target,
    err?.meta?.driverAdapterError?.cause?.originalMessage,
  ].filter(Boolean).join(' ');
  const isUniqueViolation = String(sqlState) === '23505'
    || String(sqlState) === 'P2002'
    || /duplicate key value/i.test(detail);
  return isUniqueViolation && detail.includes('uniq_users_tenant_abha_number_canonical');
}

class ABDMService {
  async getAdminStatus({ tenantId = null } = {}) {
    const tid = requireTenantId(tenantId);
    const checkedAt = new Date().toISOString();
    const defaultConsentCounts = {
      total: 0,
      pending: 0,
      granted: 0,
      denied: 0,
    };

    let abhaCounts = {
      abha_registrations: 0,
      health_records_linked: 0,
    };
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE abha_number IS NOT NULL OR abha_address IS NOT NULL)::int AS abha_registrations,
           COUNT(*) FILTER (WHERE abha_number IS NOT NULL OR abha_address IS NOT NULL)::int AS health_records_linked
         FROM users
         WHERE tenant_id = $1::uuid
           AND COALESCE(is_active, true) = true`,
        tid
      );
      abhaCounts = rows[0] || abhaCounts;
    } catch (err) {
      logger.warn('ABDM admin status ABHA counts unavailable', { error: err.message });
    }

    const consentTableAvailable = await this._tableExists('abdm_consents');
    let consentCounts = defaultConsentCounts;
    if (consentTableAvailable) {
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'REQUESTED')::int AS pending,
             COUNT(*) FILTER (WHERE status = 'GRANTED')::int AS granted,
             COUNT(*) FILTER (WHERE status = 'DENIED')::int AS denied
           FROM abdm_consents
           WHERE tenant_id = $1::uuid`,
          tid
        );
        consentCounts = rows[0] || defaultConsentCounts;
      } catch (err) {
        logger.warn('ABDM admin status consent counts unavailable', { error: err.message });
      }
    }

    return {
      connected: Boolean(ABDM_CONFIG.enabled),
      bridge_url: ABDM_CONFIG.bridgeUrl,
      gateway_url: ABDM_CONFIG.gatewayUrl,
      hip_id: ABDM_CONFIG.hipId || null,
      hip_name: ABDM_CONFIG.hipName,
      last_heartbeat: checkedAt,
      abha_registrations: Number(abhaCounts.abha_registrations || 0),
      health_records_linked: Number(abhaCounts.health_records_linked || 0),
      consent_requests_total: Number(consentCounts.total || 0),
      consent_requests_pending: Number(consentCounts.pending || 0),
      consent_requests_granted: Number(consentCounts.granted || 0),
      consent_requests_denied: Number(consentCounts.denied || 0),
      services: [
        {
          name: 'ABDM Gateway',
          status: ABDM_CONFIG.enabled ? 'up' : 'down',
          last_check: checkedAt,
        },
        {
          name: 'ABDM Bridge',
          status: ABDM_CONFIG.enabled ? 'up' : 'down',
          last_check: checkedAt,
        },
        {
          name: 'Consent Store',
          status: consentTableAvailable ? 'up' : 'degraded',
          last_check: checkedAt,
        },
      ],
    };
  }

  async listConsentRequests({ status = null, limit = 50, offset = 0, tenantId = null } = {}) {
    const tid = requireTenantId(tenantId);
    if (!(await this._tableExists('abdm_consents'))) {
      return [];
    }

    const normalizedStatus = status ? String(status).toUpperCase() : null;
    const allowedStatuses = new Set(['REQUESTED', 'GRANTED', 'DENIED', 'EXPIRED', 'REVOKED']);
    if (normalizedStatus && !allowedStatuses.has(normalizedStatus)) {
      throw AppError.badRequest('Invalid ABDM consent status filter', 'INVALID_CONSENT_STATUS');
    }

    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);

    return prisma.$queryRawUnsafe(
      `SELECT
         c.id::text AS id,
         c.consent_id AS request_id,
         c.patient_uid::text AS patient_id,
         COALESCE(u.name, u.phone, c.patient_uid::text) AS patient_name,
         c.purpose,
         c.hip_id,
         COALESCE($5::text, c.hip_id) AS hip_name,
         c.hiu_id,
         c.status,
         c.date_range_from,
         c.date_range_to,
         c.expiry_date,
         c.created_at,
         COALESCE(c.granted_at, c.revoked_at, c.created_at) AS updated_at
       FROM abdm_consents c
       LEFT JOIN users u ON u.uid = c.patient_uid
       WHERE c.tenant_id = $1::uuid
         AND ($2::text IS NULL OR c.status = $2::text)
       ORDER BY c.created_at DESC
       LIMIT $3 OFFSET $4`,
      tid,
      normalizedStatus,
      safeLimit,
      safeOffset,
      ABDM_CONFIG.hipName
    );
  }

  /**
   * Link an ABHA the patient ALREADY HOLDS to their VH Health account.
   *
   * This is a LINK operation, not an enrolment: it binds an existing national
   * health identifier to a local patient row. Creating a brand-new ABHA is an
   * ABDM enrolment flow (Aadhaar/mobile OTP) that this platform does not
   * implement and cannot reach — `abdmGateway` exposes no enrolment call.
   * Patients without an ABHA obtain one from the ABHA app or an enrolment
   * centre and then link it here.
   *
   * Works with ABDM credentials unset: gateway verification is applied only
   * when `ABDM_CONFIG.enabled`, and fails closed when it is.
   *
   * @param {string} patientUid - Patient's UUID
   * @param {string} abhaNumber - 14-digit ABHA number (hyphens permitted)
   * @param {string} abhaAddress - ABHA address (user@abdm), optional
   * @returns {{linked: boolean, abhaNumber: string|null, abhaAddress: string|null}}
   *   The resulting linkage, in the same shape as `getMyAbhaLinkage`.
   */
  async registerABHA(patientUid, abhaNumber, abhaAddress, { tenantId = null } = {}) {
    const tid = requireTenantId(tenantId);
    if (!patientUid) {
      throw AppError.badRequest('Patient UID is required', 'MISSING_PATIENT_UID');
    }
    if (!abhaNumber) {
      throw AppError.badRequest('ABHA number is required', 'MISSING_ABHA_NUMBER');
    }

    // Validate ABHA number format (14 digits, may contain hyphens)
    const cleanAbha = String(abhaNumber).trim().replace(/-/g, '');
    if (!/^\d{14}$/.test(cleanAbha)) {
      throw AppError.badRequest('Invalid ABHA number format. Must be 14 digits.', 'INVALID_ABHA_FORMAT');
    }
    const normalizedAbha = hyphenateAbhaNumber(cleanAbha);
    const normalizedAddress = normalizeAbhaAddress(abhaAddress);

    // Check patient exists
    const patientResult = await prisma.$queryRawUnsafe(
      `SELECT uid, name, phone, tenant_id FROM users
       WHERE uid = $1::uuid
         AND tenant_id = $2::uuid
         AND role = 'PATIENT'
         AND is_active = true
       LIMIT 1`,
      patientUid, tid
    );
    if (patientResult.length === 0) {
      throw AppError.notFound('Patient not found', 'PATIENT_NOT_FOUND');
    }

    // Check ABHA not already linked to another patient. Legacy rows may use
    // either plain digits or canonical 2-4-4-4 spelling, so compare both; an
    // IN over the two literals still uses idx_users_abha_number. New writes are
    // canonicalized below.
    const existingAbha = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users
       WHERE tenant_id = $1::uuid
         AND abha_number IN ($2, $3)
         AND uid != $4::uuid
       LIMIT 1`,
      tid, cleanAbha, hyphenateAbhaNumber(cleanAbha), patientUid
    );
    if (existingAbha.length > 0) {
      throw AppError.conflict('This ABHA number is already linked to another patient', 'ABHA_ALREADY_LINKED');
    }

    // Verify ABHA with ABDM gateway (if enabled)
    if (ABDM_CONFIG.enabled) {
      try {
        await abdmGateway.verifyABHA(normalizedAbha);
      } catch (err) {
        logger.warn('ABDM ABHA verification failed', {
          abhaNumber: maskGeneric(normalizedAbha),
          error: err.message,
        });
        // CAN-025: FAIL CLOSED — do not bind an unverified national health
        // identifier while ABDM is enabled (was: proceed on gateway error). An
        // explicit, audited override permits local-only linkage during a
        // confirmed gateway outage.
        if (String(process.env.ABDM_ABHA_ALLOW_UNVERIFIED || '').toLowerCase() !== 'true') {
          throw new AppError(
            'ABHA could not be verified with the ABDM gateway; linkage refused',
            503,
            'ABHA_VERIFICATION_FAILED',
          );
        }
        logger.warn('ABDM_ABHA_ALLOW_UNVERIFIED override active — linking unverified ABHA', {
          abhaNumber: maskGeneric(normalizedAbha),
        });
      }
    }

    // Update patient with ABHA details
    let result;
    try {
      result = await prisma.$queryRawUnsafe(
        `UPDATE users
         SET abha_number = $1, abha_address = $2, updated_at = NOW()
         WHERE uid = $3::uuid AND tenant_id = $4::uuid
         RETURNING uid, tenant_id, name, phone, abha_number, abha_address, updated_at`,
        normalizedAbha, normalizedAddress, patientUid, tid
      );
    } catch (err) {
      if (isCanonicalAbhaUniqueViolation(err)) {
        throw AppError.conflict(
          'This ABHA number is already linked to another patient',
          'ABHA_ALREADY_LINKED',
        );
      }
      throw err;
    }

    // An ABHA number is a national health identifier — mask it in logs, per the
    // house rule for user data (this line previously logged it in the clear).
    logger.info('ABHA linked to patient', {
      patientUid,
      abhaNumber: maskGeneric(normalizedAbha),
      abhaAddress: normalizedAddress ? maskEmail(normalizedAddress) : null,
    });

    // Return the linkage, not the user row: the row carries name/phone/tenant
    // the caller did not ask for, and this shape matches getMyAbhaLinkage so a
    // client can render the linked state straight from either response.
    const row = result[0] || {};
    return {
      linked: true,
      abhaNumber: row.abha_number ?? normalizedAbha,
      abhaAddress: row.abha_address ?? normalizedAddress,
    };
  }

  /**
   * Resolve the CALLING patient's own ABHA linkage state.
   *
   * Deliberately reads only the local linkage columns on `users` and never
   * touches `abdmGateway` — every gateway-backed route 503s while ABDM
   * credentials are unset, and a patient must still be able to see whether
   * their account is already linked. Returns an honest empty state
   * (`linked: false`) rather than 404 when the patient simply has no ABHA yet;
   * a 404 here means "no such patient record", which is a different fact.
   *
   * Scoped with an explicit tenant predicate rather than relying on RLS, so the
   * scoping holds in every environment and is observable from a test.
   *
   * @param {string} patientUid - Caller's own UUID (from the JWT, never a param)
   * @returns {Object} { linked, abhaNumber, abhaAddress }
   */
  async getMyAbhaLinkage(patientUid, { tenantId = null } = {}) {
    const tid = requireTenantId(tenantId);
    if (!patientUid) {
      throw AppError.badRequest('Patient UID is required', 'MISSING_PATIENT_UID');
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT uid, abha_number, abha_address
       FROM users
       WHERE uid = $1::uuid
         AND tenant_id = $2::uuid
         AND role = 'PATIENT'
         AND is_active = true
       LIMIT 1`,
      patientUid, tid
    );

    if (result.length === 0) {
      throw AppError.notFound('Patient not found', 'PATIENT_NOT_FOUND');
    }

    const abhaNumber = result[0].abha_number || null;
    const abhaAddress = result[0].abha_address || null;

    return {
      linked: Boolean(abhaNumber || abhaAddress),
      abhaNumber,
      abhaAddress,
    };
  }

  /**
   * Lookup a patient by their ABHA number.
   * @param {string} abhaNumber - ABHA number
   * @returns {Object} Patient record
   */
  async getPatientByABHA(abhaNumber, { tenantId = null } = {}) {
    const tid = requireTenantId(tenantId);
    if (!abhaNumber) {
      throw AppError.badRequest('ABHA number is required', 'MISSING_ABHA_NUMBER');
    }
    const cleanAbha = String(abhaNumber).trim().replace(/-/g, '');
    if (!/^\d{14}$/.test(cleanAbha)) {
      throw AppError.badRequest('Invalid ABHA number format. Must be 14 digits.', 'INVALID_ABHA_FORMAT');
    }
    const canonicalAbha = hyphenateAbhaNumber(cleanAbha);

    const result = await prisma.$queryRawUnsafe(
      `SELECT uid, tenant_id, name, phone, email, gender, birthday, abha_number, abha_address, registered_at
       FROM users
       WHERE tenant_id = $1::uuid
         AND abha_number IN ($2, $3)
         AND is_active = true
         AND role = 'PATIENT'`,
      tid, cleanAbha, canonicalAbha
    );

    if (result.length === 0) {
      throw AppError.notFound('No patient found with this ABHA number', 'ABHA_NOT_FOUND');
    }
    if (new Set(result.map((row) => String(row.uid))).size > 1) {
      throw AppError.conflict(
        'ABHA number is linked to multiple patients; manual reconciliation is required',
        'ABHA_MULTIPLE_PATIENTS',
      );
    }

    return result[0];
  }

  /**
   * Handle an incoming consent request from ABDM consent manager.
   * Creates an abdm_consents record for the patient to review.
   * @param {Object} consentRequest - Consent request from ABDM gateway
   * @returns {Object} Created consent record
   */
  /**
   * Verify the Consent Manager's signature over the consent artefact BEFORE
   * trusting the (otherwise unauthenticated) notification body (audit 2026-06-18).
   * Operator-gated: enable with ABDM_VERIFY_CONSENT_ARTEFACT=true + ABDM_CM_PUBLIC_KEY.
   * When enabled, a missing/invalid signature is rejected (fail-closed); when not
   * configured we proceed but log loudly that the artefact chain is unverified.
   */
  /**
   * Resolve a patient AND their tenant from a (national) ABHA number for an
   * inbound, tenant-less ABDM callback (audit C-4). The same person can be
   * registered at facilities in more than one tenant, so:
   *   - exactly one matching tenant  → bind to it
   *   - more than one tenant         → reject (cannot disambiguate from the
   *                                     tenant-less notification; never default-pick)
   *   - none                         → notFound
   * This replaces the old `WHERE abha_number=$1 LIMIT 1` (no tenant scope) that
   * let a non-default patient's consent/data-request land in the default tenant.
   */
  async _resolvePatientTenantByAbha(abhaNumber) {
    if (!abhaNumber) {
      throw AppError.badRequest('ABHA number is required to resolve a patient', 'ABDM_ABHA_REQUIRED');
    }
    const cleanAbha = String(abhaNumber).trim().replace(/-/g, '');
    if (!/^\d{14}$/.test(cleanAbha)) {
      throw AppError.badRequest('Invalid ABHA number format. Must be 14 digits.', 'INVALID_ABHA_FORMAT');
    }
    const canonicalAbha = hyphenateAbhaNumber(cleanAbha);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, tenant_id FROM users
       WHERE abha_number IN ($1, $2) AND is_active = true AND role = 'PATIENT'`,
      cleanAbha,
      canonicalAbha,
    );
    if (!rows.length) {
      throw AppError.notFound('No active patient found for the supplied ABHA number', 'ABDM_PATIENT_NOT_FOUND');
    }
    const tenants = [...new Set(rows.map((r) => String(r.tenant_id)))];
    if (tenants.length > 1) {
      logger.warn('ABDM callback rejected: ABHA resolves across multiple tenants', {
        abhaTenantCount: tenants.length,
      });
      throw AppError.conflict(
        'ABHA number resolves to patients in multiple tenants; cannot bind deterministically',
        'ABDM_ABHA_MULTI_TENANT',
      );
    }
    if (new Set(rows.map((row) => String(row.uid))).size > 1) {
      logger.warn('ABDM callback rejected: ABHA resolves to multiple patients in one tenant', {
        abhaPatientCount: rows.length,
      });
      throw AppError.conflict(
        'ABHA number resolves to multiple patients; cannot bind deterministically',
        'ABDM_ABHA_MULTI_PATIENT',
      );
    }
    return { patientUid: rows[0].uid, tenantId: rows[0].tenant_id };
  }

  _verifyConsentArtefact({ consentRequestId, consentArtefact, signature }) {
    if (!consentArtefactVerificationEnabled()) {
      logger.warn(
        'ABDM consent-artefact signature verification is DISABLED — set ABDM_VERIFY_CONSENT_ARTEFACT=true and ABDM_CM_PUBLIC_KEY before production',
        { consentRequestId },
      );
      return null;
    }
    const publicKey = consentManagerPublicKey();
    if (!publicKey) {
      throw AppError.forbidden(
        'Consent-artefact verification is enabled but ABDM_CM_PUBLIC_KEY is not configured',
        'ABDM_CM_KEY_MISSING',
      );
    }
    if (!consentArtefact || !signature) {
      throw AppError.forbidden(
        'Consent artefact or signature missing — refusing to trust an unsigned consent notification',
        'ABDM_CONSENT_UNSIGNED',
      );
    }
    let serializedPayload;
    try {
      serializedPayload = typeof consentArtefact === 'string'
        ? consentArtefact
        : JSON.stringify(consentArtefact);
    } catch (_err) {
      throw consentBindingMismatch(['artefact']);
    }
    if (!serializedPayload) {
      throw consentBindingMismatch(['artefact']);
    }
    let verified = false;
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(serializedPayload);
      verifier.end();
      // This is a Node crypto `Verify` object — the algorithm is already pinned
      // at createVerify('RSA-SHA256') above, and the arg order here is the crypto
      // Verify.verify(publicKey, signature) shape, NOT jwt.verify(token, secret).
      // There is no algorithm-confusion surface and crypto Verify has no
      // `algorithms` option, so the jwt allowlist rule is a false positive here.
      // nosemgrep: vh-jwt-no-alg-allowlist
      verified = verifier.verify(publicKey, Buffer.from(String(signature), 'base64'));
    } catch (err) {
      logger.error('ABDM consent-artefact signature verification error', {
        consentRequestId,
        error: err.message,
      });
      throw AppError.forbidden(
        'Consent artefact signature could not be verified',
        'ABDM_CONSENT_SIG_INVALID',
      );
    }
    if (!verified) {
      throw AppError.forbidden(
        'Consent artefact signature is invalid',
        'ABDM_CONSENT_SIG_INVALID',
      );
    }

    let verifiedPayload;
    try {
      verifiedPayload = JSON.parse(serializedPayload);
    } catch (_err) {
      throw consentBindingMismatch(['artefact']);
    }

    return {
      payload: verifiedPayload,
      rawPayload: serializedPayload,
      sha256: crypto.createHash('sha256').update(serializedPayload).digest('hex'),
    };
  }

  async handleConsentRequest(consentRequest, { callbackTenantId = null, strict = false } = {}) {
    const {
      consentRequestId,
      purpose,
      hiTypes,
      patient,
      hip,
      hiu,
      consentManager,
      authenticatedHipId,
      authenticatedConsentManagerId,
      requester,
      dateRange,
      expiry,
      consentArtefact,
      signature,
    } = consentRequest;

    // Verify the CM-signed consent artefact BEFORE trusting any of the
    // notification body (#3). When the operator has supplied the CM public key
    // + enabled verification, a missing/invalid signature is rejected; when
    // verification is not configured we proceed but record that the chain is
    // operator-gated (never hardcode a sandbox trust in prod).
    const verification = this._verifyConsentArtefact({
      consentRequestId,
      consentArtefact,
      signature,
    });

    let authoritative;
    if (verification) {
      authoritative = projectVerifiedConsent(verification.payload);
      assertConsentWrapperBinding({
        consentRequestId,
        purpose,
        hiTypes,
        patient,
        hip,
        hiu,
        consentManager,
        authenticatedHipId,
        authenticatedConsentManagerId,
        dateRange,
        expiry,
      }, authoritative);
    } else {
      if (!consentRequestId || !purpose || !patient?.id) {
        throw AppError.badRequest('Invalid consent request payload', 'INVALID_CONSENT_REQUEST');
      }
      authoritative = {
        consentId: consentRequestId,
        patientAbha: patient.id,
        hipId: ABDM_CONFIG.hipId || null,
        hiuId: hiu?.id || null,
        consentManagerId: consentManager?.id || consentManagerId(),
        purpose,
        hiTypes: hiTypes || [],
        dateFrom: dateRange?.from ? new Date(dateRange.from) : null,
        dateTo: dateRange?.to ? new Date(dateRange.to) : null,
        expiryDate: expiry
          ? new Date(expiry)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        requesterName: requester?.name || null,
      };
    }

    if (!ABDM_CONFIG.PURPOSES.includes(authoritative.purpose)) {
      throw AppError.badRequest(
        `Invalid consent purpose: ${authoritative.purpose}`,
        'INVALID_PURPOSE',
      );
    }

    // Resolve the patient AND their tenant from the ABHA. ABHA numbers are a
    // national id, so the same person can be registered at facilities in more
    // than one tenant. If the ABHA resolves in exactly one tenant we bind to
    // it; if it spans MULTIPLE tenants we cannot deterministically pick one
    // from the (tenant-less) ABDM notification, so we reject rather than
    // silently leak into the default tenant.
    const { patientUid, tenantId } = await this._resolvePatientTenantByAbha(authoritative.patientAbha);
    if (strict && (!callbackTenantId || String(callbackTenantId) !== String(tenantId))) {
      throw consentBindingMismatch(['tenant']);
    }
    // Guard-now / retire-later (2026-08-06): the env-backed default callback
    // secret (strict === false) is the legacy single-tenant credential. It
    // keeps working unchanged for DEFAULT-tenant patients, but must no longer
    // bind a consent into any other ABHA-resolved tenant — per-tenant callback
    // secrets (strict) are the sanctioned multi-tenant route. Retiring the
    // default-secret path entirely is the follow-up.
    if (!strict && String(tenantId) !== String(DEFAULT_TENANT_ID)) {
      throw AppError.forbidden(
        'Legacy default callback secret cannot bind a consent outside the default tenant',
        'ABDM_DEFAULT_SECRET_TENANT_FORBIDDEN',
      );
    }

    // Everything below runs scoped to the patient's tenant so the abdm_consents
    // insert is RLS-checked into THAT tenant (the GUC-reading column default
    // resolves to it) and the duplicate probe only sees that tenant's rows.
    return setTenant(tenantId, async (tx) => {
      if (verification) {
        const replayClaim = await tx.$queryRawUnsafe(
          `INSERT INTO interop_replay_guard (namespace, request_id, expires_at)
           VALUES ($1, $2, 'infinity'::timestamptz)
           ON CONFLICT (namespace, request_id) DO NOTHING
           RETURNING id`,
          CONSENT_ARTEFACT_REPLAY_NAMESPACE,
          verification.sha256,
        );
        if (replayClaim.length === 0) {
          throw AppError.conflict(
            'Consent artefact has already been used',
            'ABDM_CONSENT_ARTEFACT_REUSED',
          );
        }
      }

      const existing = await tx.$queryRawUnsafe(
        `SELECT id FROM abdm_consents WHERE consent_id = $1 AND tenant_id = $2::uuid LIMIT 1`,
        authoritative.consentId, tenantId,
      );
      if (existing.length > 0) {
        throw AppError.conflict('Consent request already exists', 'DUPLICATE_CONSENT');
      }

      const artefactEvidence = verification
        ? JSON.stringify({
          verification: {
            signatureVerified: true,
            artefactHash: verification.sha256,
            patientAbha: authoritative.patientAbha,
            consentManagerId: authoritative.consentManagerId,
          },
        })
        : null;

      const result = await tx.$queryRawUnsafe(
        `INSERT INTO abdm_consents
          (consent_id, patient_uid, tenant_id, hip_id, hiu_id, purpose, hi_types,
           date_range_from, date_range_to, expiry_date, status, requester_name,
           consent_artifact, created_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
                 'REQUESTED', $11, $12::jsonb, NOW())
         RETURNING id, consent_id, patient_uid, purpose, hi_types, status, expiry_date, requester_name, created_at`,
        authoritative.consentId,
        patientUid,
        tenantId,
        authoritative.hipId,
        authoritative.hiuId,
        authoritative.purpose,
        authoritative.hiTypes,
        authoritative.dateFrom,
        authoritative.dateTo,
        authoritative.expiryDate,
        authoritative.requesterName,
        artefactEvidence,
      );

      logger.info('ABDM consent request created', {
        consentId: authoritative.consentId,
        patientUid,
        purpose: authoritative.purpose,
      });

      return result[0];
    });
  }

  /**
   * Grant a consent request — patient approves data sharing.
   * @param {string} consentId - Consent UUID
   * @param {string} patientUid - Patient's UUID (for ownership verification)
   * @returns {Object} Updated consent record
   */
  async grantConsent(consentId, patientUid) {
    // Verify consent exists and belongs to patient
    const consent = await this._getConsentForPatient(consentId, patientUid);

    if (consent.status !== 'REQUESTED') {
      throw AppError.badRequest(
        `Cannot grant consent in status: ${consent.status}. Only REQUESTED consents can be granted.`,
        'INVALID_CONSENT_STATUS'
      );
    }

    // Check expiry
    if (new Date(consent.expiry_date) < new Date()) {
      await prisma.$queryRawUnsafe(
        `UPDATE abdm_consents SET status = 'EXPIRED' WHERE consent_id = $1`,
        consentId
      );
      throw AppError.badRequest('Consent request has expired', 'CONSENT_EXPIRED');
    }

    // Build consent artifact
    const verifiedPatientAbha = consent.consent_artifact?.verification?.patientAbha;
    const verifiedConsentManagerId = consent.consent_artifact?.verification?.consentManagerId;
    const consentArtifact = {
      schemaVersion: '1.0',
      consentId,
      createdAt: new Date().toISOString(),
      purpose: { code: consent.purpose },
      patient: { id: verifiedPatientAbha || consent.patient_abha },
      hip: { id: consent.hip_id || ABDM_CONFIG.hipId },
      hiu: { id: consent.hiu_id },
      consentManager: { id: verifiedConsentManagerId || consentManagerId() },
      hiTypes: consent.hi_types,
      permission: {
        accessMode: 'VIEW',
        dateRange: {
          from: consent.date_range_from,
          to: consent.date_range_to,
        },
        dataEraseAt: consent.expiry_date,
      },
    };

    const result = await prisma.$queryRawUnsafe(
      `UPDATE abdm_consents
       SET status = 'GRANTED', granted_at = NOW(),
           consent_artifact = jsonb_set(
             COALESCE(consent_artifact, '{}'::jsonb),
             '{grantedPayload}',
             $1::jsonb,
             true
           )
       WHERE consent_id = $2
       RETURNING id, consent_id, patient_uid, purpose, status, granted_at,
                 $1::jsonb AS consent_artifact`,
      JSON.stringify(consentArtifact), consentId
    );

    // Notify ABDM gateway asynchronously
    if (ABDM_CONFIG.enabled) {
      abdmGateway.notifyConsentStatus(consentId, 'GRANTED', consentArtifact).catch((err) => {
        logger.error('Failed to notify ABDM of consent grant', {
          consentId,
          error: err.message,
        });
      });
    }

    logger.info('ABDM consent granted', { consentId, patientUid });

    return result[0];
  }

  /**
   * Deny a consent request.
   * @param {string} consentId - Consent UUID
   * @param {string} patientUid - Patient's UUID
   * @param {string} reason - Reason for denial
   * @returns {Object} Updated consent record
   */
  async denyConsent(consentId, patientUid, reason) {
    const consent = await this._getConsentForPatient(consentId, patientUid);

    if (consent.status !== 'REQUESTED') {
      throw AppError.badRequest(
        `Cannot deny consent in status: ${consent.status}. Only REQUESTED consents can be denied.`,
        'INVALID_CONSENT_STATUS'
      );
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE abdm_consents
       SET status = 'DENIED'
       WHERE consent_id = $1
       RETURNING id, consent_id, patient_uid, purpose, status`,
      consentId
    );

    // Notify ABDM gateway asynchronously
    if (ABDM_CONFIG.enabled) {
      abdmGateway.notifyConsentStatus(consentId, 'DENIED').catch((err) => {
        logger.error('Failed to notify ABDM of consent denial', {
          consentId,
          error: err.message,
        });
      });
    }

    logger.info('ABDM consent denied', { consentId, patientUid, reason: reason || 'not specified' });

    return result[0];
  }

  /**
   * Revoke a previously granted consent.
   * @param {string} consentId - Consent UUID
   * @param {string} patientUid - Patient's UUID
   * @returns {Object} Updated consent record
   */
  async revokeConsent(consentId, patientUid) {
    const consent = await this._getConsentForPatient(consentId, patientUid);

    if (consent.status !== 'GRANTED') {
      throw AppError.badRequest(
        `Cannot revoke consent in status: ${consent.status}. Only GRANTED consents can be revoked.`,
        'INVALID_CONSENT_STATUS'
      );
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE abdm_consents
       SET status = 'REVOKED', revoked_at = NOW()
       WHERE consent_id = $1
       RETURNING id, consent_id, patient_uid, purpose, status, revoked_at`,
      consentId
    );

    // Notify ABDM gateway asynchronously
    if (ABDM_CONFIG.enabled) {
      abdmGateway.notifyConsentStatus(consentId, 'REVOKED').catch((err) => {
        logger.error('Failed to notify ABDM of consent revocation', {
          consentId,
          error: err.message,
        });
      });
    }

    logger.info('ABDM consent revoked', { consentId, patientUid });

    return result[0];
  }

  /**
   * Handle a data request from HIU — collect, format, encrypt, and send health data.
   * @param {Object} dataRequest - Data request payload from ABDM
   * @returns {Object} Created data request record
   */
  async handleDataRequest(dataRequest, opts = {}) {
    const {
      transactionId,
      consentId,
      hiTypes,
      dateRange,
      keyMaterial,
      dataPushUrl,
    } = dataRequest;

    if (!transactionId || !consentId) {
      throw AppError.badRequest('Invalid data request payload', 'INVALID_DATA_REQUEST');
    }

    const safeDataPushUrl = dataPushUrl ? String(dataPushUrl).trim() : null;
    if (safeDataPushUrl) {
      await assertSafeOutboundUrl(safeDataPushUrl, {
        label: 'dataPushUrl',
        allowlistEnv: 'ABDM_DATA_PUSH_HOST_ALLOWLIST',
        allowPrivateEnv: 'ABDM_DATA_PUSH_ALLOW_PRIVATE_TARGETS',
      });
    }

    // Verify consent exists and is GRANTED. The consent row carries the tenant
    // this exchange belongs to; we read it (permissively, by consent_id, which
    // is globally unique) and then scope EVERY subsequent read/write to it.
    const consentResult = await prisma.$queryRawUnsafe(
      `SELECT consent_id, patient_uid, tenant_id::text AS tenant_id, status, hi_types,
              date_range_from, date_range_to, expiry_date
       FROM abdm_consents
       WHERE consent_id = $1
       LIMIT 1`,
      consentId
    );

    if (consentResult.length === 0) {
      throw AppError.notFound('Consent not found', 'CONSENT_NOT_FOUND');
    }

    const consent = consentResult[0];
    const tenantId = consent.tenant_id;
    if (!tenantId) {
      // A consent with no tenant cannot be safely scoped — refuse rather than
      // export under the default tenant.
      throw AppError.forbidden('Consent has no tenant binding', 'ABDM_CONSENT_NO_TENANT');
    }
    // CAN-007: when the callback was authenticated by a PER-TENANT secret
    // (resolved from x-hip-id), the consent it names MUST belong to that same
    // tenant — otherwise a tenant-A HIP callback could pull tenant-B PHI to its
    // own dataPushUrl. The shared-secret/default path (opts.strict false) keeps
    // the legacy single-tenant behavior.
    if (opts.strict && opts.callbackTenantId && String(tenantId) !== String(opts.callbackTenantId)) {
      throw AppError.forbidden(
        'Consent tenant does not match the authenticated callback tenant',
        'ABDM_CONSENT_TENANT_MISMATCH',
      );
    }
    // Guard-now / retire-later (2026-08-06): the env-backed default callback
    // secret (opts.strict false) may no longer export PHI for a consent bound
    // to any non-DEFAULT tenant — the legacy single-tenant behavior survives
    // only for DEFAULT-tenant consents. Per-tenant callback secrets (strict)
    // are the sanctioned multi-tenant route; retiring the default-secret path
    // entirely is the follow-up. Refused before any write (including the
    // expiry status flip below).
    if (!opts.strict && String(tenantId) !== String(DEFAULT_TENANT_ID)) {
      throw AppError.forbidden(
        'Legacy default callback secret cannot export data for a consent outside the default tenant',
        'ABDM_DEFAULT_SECRET_TENANT_FORBIDDEN',
      );
    }

    if (consent.status !== 'GRANTED') {
      throw AppError.forbidden('Consent is not in GRANTED status', 'CONSENT_NOT_GRANTED');
    }

    // Check consent expiry
    if (new Date(consent.expiry_date) < new Date()) {
      await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
        `UPDATE abdm_consents SET status = 'EXPIRED' WHERE consent_id = $1 AND tenant_id = $2::uuid`,
        consentId, tenantId,
      ));
      throw AppError.forbidden('Consent has expired', 'CONSENT_EXPIRED');
    }

    // Consent-scope clamp (#1): the request must NOT exceed the granted consent.
    // Clamp the requested HI types to the grant's set and the requested date
    // window to the grant's [from, to], so a misbehaving / over-broad HIU can
    // never pull data types or a date range the patient never consented to. A
    // request that omits a field inherits the grant value (unchanged); an
    // out-of-scope request is narrowed to the consented intersection.
    const grantedHiTypes = Array.isArray(consent.hi_types) ? consent.hi_types : [];
    const requestedHiTypes = Array.isArray(hiTypes) && hiTypes.length > 0 ? hiTypes : null;
    const effectiveHiTypes = requestedHiTypes
      ? requestedHiTypes.filter((t) => grantedHiTypes.includes(t))
      : grantedHiTypes;
    if (requestedHiTypes && effectiveHiTypes.length === 0) {
      throw AppError.forbidden(
        'Requested HI types are outside the granted consent scope',
        'ABDM_HITYPE_OUT_OF_SCOPE'
      );
    }

    const grantFrom = consent.date_range_from ? new Date(consent.date_range_from) : null;
    const grantTo = consent.date_range_to ? new Date(consent.date_range_to) : null;
    const reqFrom = dateRange?.from ? new Date(dateRange.from) : null;
    const reqTo = dateRange?.to ? new Date(dateRange.to) : null;
    // Never start before the grant; never end after it.
    const effectiveFrom = reqFrom && grantFrom
      ? new Date(Math.max(reqFrom.getTime(), grantFrom.getTime()))
      : (reqFrom || grantFrom);
    const effectiveTo = reqTo && grantTo
      ? new Date(Math.min(reqTo.getTime(), grantTo.getTime()))
      : (reqTo || grantTo);
    if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
      throw AppError.forbidden(
        'Requested date range is outside the granted consent window',
        'ABDM_DATERANGE_OUT_OF_SCOPE'
      );
    }

    // Create data request record — scoped to the consent's tenant so the row
    // (and its tenant_id default) lands in that tenant under the RLS WITH CHECK.
    const requestResult = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO abdm_data_requests
        (transaction_id, consent_id, patient_uid, tenant_id, hi_types, date_range_from, date_range_to, key_material, data_push_url, status, created_at)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, 'PROCESSING', NOW())
       RETURNING id, transaction_id, consent_id, patient_uid, status, created_at`,
      transactionId,
      consentId,
      consent.patient_uid,
      tenantId,
      effectiveHiTypes,
      effectiveFrom,
      effectiveTo,
      keyMaterial ? JSON.stringify(keyMaterial) : null,
      safeDataPushUrl,
    ));

    // Collect and send health data asynchronously, scoped to the same tenant.
    this._processDataRequest(
      transactionId,
      consentId,
      consent.patient_uid,
      effectiveHiTypes,
      effectiveFrom,
      effectiveTo,
      keyMaterial,
      safeDataPushUrl,
      tenantId,
    ).catch(async (err) => {
      logger.error('Failed to process ABDM data request', {
        transactionId,
        error: err.message,
      });
      // Mark as FAILED (tenant-scoped) with a bounded retry. Previously this
      // marker write was itself fire-and-forget, so a DB failure left the
      // consent-bound request 'PROCESSING' forever with no signal (BE-M7);
      // sweepStuckDataRequests is the backstop when even the retries fail.
      await this._markDataRequestFailed(transactionId, tenantId);
    });

    return requestResult[0];
  }

  /**
   * Mark a data request FAILED, retrying the marker write a bounded number of
   * times. Never throws — this runs on the async tail of a callback whose
   * HTTP response has already been sent. Returns true when the marker landed.
   * Runs pre-RLS callbacks' tenant model: every query carries an explicit
   * `AND tenant_id = $N::uuid` predicate in addition to setTenant().
   * @param {string} transactionId
   * @param {string} tenantId
   * @param {Object} [options]
   * @param {number} [options.attempts] - Total write attempts (default 3)
   * @param {number} [options.backoffMs] - Base linear backoff between attempts
   * @returns {Promise<boolean>}
   */
  async _markDataRequestFailed(transactionId, tenantId, { attempts = 3, backoffMs = 500 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
          `UPDATE abdm_data_requests SET status = 'FAILED'
            WHERE transaction_id = $1 AND tenant_id = $2::uuid AND status = 'PROCESSING'`,
          transactionId, tenantId,
        ));
        return true;
      } catch (markErr) {
        logger.error('ABDM data request FAILED-marker write failed', {
          transactionId,
          tenantId,
          attempt,
          attempts,
          error: markErr.message,
        });
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
      }
    }
    logger.error(
      'ABDM data request is stuck in PROCESSING — FAILED-marker retries exhausted; the stuck-request sweep will retry',
      { transactionId, tenantId },
    );
    return false;
  }

  /**
   * Sweep for data requests stuck in PROCESSING (cron backstop for BE-M7).
   * A PROCESSING row only means "an in-process async pipeline is running";
   * after a crash/restart — or when the FAILED-marker write above lost its
   * retries — nothing owns the row and it would stay PROCESSING forever.
   * Marks stale rows FAILED per tenant. Rows carrying an I16 recovery claim
   * (recovery_inbox_id) belong to the owner-driven recovery workbench
   * (migration 618) and are never touched here.
   * @param {Object} [options]
   * @param {number} [options.olderThanMinutes] - Staleness threshold (default 60)
   * @param {number} [options.limit] - Max rows per run (default 100)
   * @returns {Promise<{ scanned: number, swept: number, failed: number }>}
   */
  async sweepStuckDataRequests({ olderThanMinutes = 60, limit = 100 } = {}) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT transaction_id, tenant_id::text AS tenant_id
         FROM abdm_data_requests
        WHERE status = 'PROCESSING'
          AND recovery_inbox_id IS NULL
          AND created_at < NOW() - ($1::int * INTERVAL '1 minute')
        ORDER BY created_at
        LIMIT $2::int`,
      olderThanMinutes, limit,
    );
    if (rows.length === 0) {
      return { scanned: 0, swept: 0, failed: 0 };
    }

    logger.error('ABDM stuck data requests found in PROCESSING past the deadline', {
      count: rows.length,
      older_than_minutes: olderThanMinutes,
      transaction_ids: rows.slice(0, 20).map((row) => row.transaction_id),
    });

    let swept = 0;
    let failed = 0;
    for (const row of rows) {
      const marked = await this._markDataRequestFailed(row.transaction_id, row.tenant_id, { attempts: 1 });
      if (marked) swept += 1; else failed += 1;
    }
    return { scanned: rows.length, swept, failed };
  }

  /**
   * Get all ABDM consents for a patient.
   * @param {string} patientUid - Patient's UUID
   * @returns {Array} List of consent records
   */
  async getPatientConsents(patientUid) {
    if (!patientUid) {
      throw AppError.badRequest('Patient UID is required', 'MISSING_PATIENT_UID');
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, consent_id, hip_id, hiu_id, purpose, hi_types,
              date_range_from, date_range_to, expiry_date, status,
              requester_name, granted_at, revoked_at, created_at
       FROM abdm_consents
       WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC`,
      patientUid
    );

    return result;
  }

  /**
   * Collect health data for a patient based on HI types and date range.
   * Queries existing tables (prescriptions, investigations, discharge summaries, etc.)
   * and formats as a simplified FHIR-style bundle.
   * @param {string} patientUid - Patient UUID
   * @param {string[]} hiTypes - Health information types to collect
   * @param {Date|string|null} dateFrom - Start date
   * @param {Date|string|null} dateTo - End date
   * @param {Object} [options]
   * @param {string|null} [options.tenantId] - When set, every read runs under
   *   setTenant(tenantId) so the export is RLS-scoped to that tenant (PHI for a
   *   patient_uid is only returned for the consented tenant). When omitted,
   *   legacy permissive behaviour (single-tenant / non-tenant-aware callers).
   * @returns {Object} FHIR-style bundle
   */
  async collectHealthData(patientUid, hiTypes, dateFrom, dateTo, { tenantId = null } = {}) {
    const runReads = (db) => this._collectHealthDataReads(db, patientUid, hiTypes, dateFrom, dateTo, tenantId);
    if (tenantId) {
      return setTenant(tenantId, (tx) => runReads(tx));
    }
    return runReads(prisma);
  }

  /**
   * Internal: the actual HI-type reads. `db` is either a tenant-scoped tx
   * (from setTenant) or the plain prisma client. Kept separate so the tenant
   * scope is applied uniformly to every query in one place.
   * @private
   */
  async _collectHealthDataReads(db, patientUid, hiTypes, dateFrom, dateTo, tenantId = null) {
    const entries = [];

    const dateFilter = [];
    const dateParams = [patientUid];
    let paramIdx = 2;

    if (dateFrom) {
      dateFilter.push(`created_at >= $${paramIdx}`);
      dateParams.push(new Date(dateFrom));
      paramIdx++;
    }
    if (dateTo) {
      dateFilter.push(`created_at <= $${paramIdx}`);
      dateParams.push(new Date(dateTo));
      paramIdx++;
    }

    const dateClause = dateFilter.length > 0 ? ` AND ${dateFilter.join(' AND ')}` : '';

    // Audit C-4: explicit tenant_id filter (defense-in-depth ON TOP OF setTenant)
    // so a tenant-scoped export never returns another tenant's rows even when the
    // connecting role bypasses RLS. Tables without a tenant_id column (immunizations)
    // are scoped by the globally-unique patient_uid alone.
    let tenantClause = '';
    if (tenantId) {
      tenantClause = ` AND tenant_id = $${paramIdx}::uuid`;
      dateParams.push(tenantId);
      paramIdx++;
    }

    for (const hiType of hiTypes) {
      switch (hiType) {
        case 'Prescription': {
          const rxResult = await db.$queryRawUnsafe(
            `SELECT id, medication_name, dosage, frequency, duration_days, status, issued_at, created_at
             FROM prescriptions
             WHERE patient_uid = $1${dateClause}${tenantClause}
             ORDER BY created_at DESC
             LIMIT 100`,
            ...dateParams
          );
          for (const rx of rxResult) {
            entries.push({
              resourceType: 'MedicationRequest',
              hiType: 'Prescription',
              id: String(rx.id),
              medicationName: rx.medication_name,
              dosage: rx.dosage,
              frequency: rx.frequency,
              durationDays: rx.duration_days,
              status: rx.status,
              date: rx.issued_at || rx.created_at,
            });
          }
          break;
        }

        case 'DiagnosticReport': {
          // lab_results is the canonical signed-off result store (B3).
          const labResult = await db.$queryRawUnsafe(
            `SELECT id, loinc_code, test_code, test_name, value_text, value_numeric, unit,
                    reference_range, abnormal_flag, status, performed_at, created_at
             FROM lab_results
             WHERE patient_uid = $1${dateClause}${tenantClause}
             ORDER BY created_at DESC
             LIMIT 100`,
            ...dateParams
          );
          for (const lab of labResult) {
            entries.push({
              resourceType: 'DiagnosticReport',
              hiType: 'DiagnosticReport',
              id: String(lab.id),
              loincCode: lab.loinc_code,
              testCode: lab.test_code,
              testName: lab.test_name,
              resultValue: lab.value_numeric !== null && lab.value_numeric !== undefined
                ? Number(lab.value_numeric)
                : lab.value_text,
              resultUnit: lab.unit,
              referenceRange: lab.reference_range,
              abnormalFlag: lab.abnormal_flag,
              status: lab.status,
              date: lab.performed_at || lab.created_at,
            });
          }
          break;
        }

        case 'DischargeSummary': {
          const dcResult = await db.$queryRawUnsafe(
            `SELECT id, admission_id, primary_diagnosis, secondary_diagnoses, icd10_codes,
                    procedures_performed, ward_at_discharge, discharged_at, signed_by_name, status, created_at
             FROM discharge_summaries
             WHERE patient_uid = $1${dateClause}${tenantClause}
             ORDER BY created_at DESC
             LIMIT 50`,
            ...dateParams
          );
          for (const dc of dcResult) {
            entries.push({
              resourceType: 'DocumentReference',
              hiType: 'DischargeSummary',
              id: String(dc.id),
              admissionId: dc.admission_id,
              primaryDiagnosis: dc.primary_diagnosis,
              secondaryDiagnoses: dc.secondary_diagnoses,
              icd10Codes: dc.icd10_codes,
              proceduresPerformed: dc.procedures_performed,
              wardAtDischarge: dc.ward_at_discharge,
              dischargedAt: dc.discharged_at,
              signedByName: dc.signed_by_name,
              status: dc.status,
              date: dc.created_at,
            });
          }
          break;
        }

        case 'OPConsultation': {
          // appointments keys patients by integer id — resolve from the uid.
          const opResult = await db.$queryRawUnsafe(
            `SELECT id, doctor_name, reason, notes, status, appointment_date, created_at
             FROM appointments
             WHERE patient_id = (SELECT id FROM users WHERE uid = $1::uuid LIMIT 1)
               AND status = 'completed'${dateClause}${tenantClause}
             ORDER BY created_at DESC
             LIMIT 100`,
            ...dateParams
          );
          for (const op of opResult) {
            entries.push({
              resourceType: 'Encounter',
              hiType: 'OPConsultation',
              id: String(op.id),
              doctorName: op.doctor_name,
              reason: op.reason,
              notes: op.notes,
              appointmentDate: op.appointment_date,
              date: op.created_at,
            });
          }
          break;
        }

        case 'ImmunizationRecord': {
          // Query immunization records if available
          try {
            const immResult = await db.$queryRawUnsafe(
              `SELECT id, vaccine_name, dose_number, administered_date, administered_by, lot_number, created_at
               FROM immunizations
               WHERE patient_uid = $1${dateClause}
               ORDER BY created_at DESC
               LIMIT 100`,
              ...dateParams
            );
            for (const imm of immResult) {
              entries.push({
                resourceType: 'Immunization',
                hiType: 'ImmunizationRecord',
                id: String(imm.id),
                vaccineName: imm.vaccine_name,
                doseNumber: imm.dose_number,
                administeredDate: imm.administered_date,
                administeredBy: imm.administered_by,
                lotNumber: imm.lot_number,
                date: imm.created_at,
              });
            }
          } catch (err) {
            // Table may not exist — skip gracefully
            logger.warn('Immunization table query failed, skipping', { error: err.message });
          }
          break;
        }

        default:
          logger.warn('Unknown ABDM HI type requested, skipping', { hiType });
          break;
      }
    }

    return {
      resourceType: 'Bundle',
      type: 'collection',
      total: entries.length,
      entry: entries,
    };
  }

  // ====================================
  // PRIVATE HELPERS
  // ====================================

  /**
   * Get a consent record and verify it belongs to the patient.
   * @private
   */
  async _getConsentForPatient(consentId, patientUid) {
    if (!consentId || !patientUid) {
      throw AppError.badRequest('Consent ID and patient UID are required');
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT c.id, c.consent_id, c.patient_uid, c.hip_id, c.hiu_id, c.purpose,
              c.hi_types, c.date_range_from, c.date_range_to, c.expiry_date,
               c.status, c.requester_name, c.consent_artifact, c.granted_at, c.revoked_at,
              u.abha_number AS patient_abha
       FROM abdm_consents c
       LEFT JOIN users u ON u.uid = c.patient_uid
       WHERE c.consent_id = $1
       LIMIT 1`,
      consentId
    );

    if (result.length === 0) {
      throw AppError.notFound('Consent not found', 'CONSENT_NOT_FOUND');
    }

    const consent = result[0];

    // IDOR check — patient can only manage their own consents
    if (String(consent.patient_uid) !== String(patientUid)) {
      throw AppError.forbidden('You do not have permission to manage this consent', 'CONSENT_FORBIDDEN');
    }

    return consent;
  }

  async _tableExists(tableName) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = $1
       ) AS exists`,
      tableName
    );
    return Boolean(rows[0]?.exists);
  }

  /**
   * Process a data request — collect, ENCRYPT, and push to the HIU
   * (roadmap C1 follow-up). The bundle is encrypted FIDELIUS-style
   * (ECDH Curve25519 + HKDF-SHA256 + AES-256-GCM) against the HIU's key
   * material; plaintext PHI is never pushed — a request without usable
   * key material fails and is marked FAILED by the caller's catch.
   * @private
   */
  async _processDataRequest(transactionId, consentId, patientUid, hiTypes, dateFrom, dateTo, keyMaterial, dataPushUrl = null, tenantId = null) {
    if (dataPushUrl) {
      await assertSafeOutboundUrl(dataPushUrl, {
        label: 'dataPushUrl',
        allowlistEnv: 'ABDM_DATA_PUSH_HOST_ALLOWLIST',
        allowPrivateEnv: 'ABDM_DATA_PUSH_ALLOW_PRIVATE_TARGETS',
      });
    }

    // Collect health data — scoped to the consent's tenant so only that
    // tenant's PHI for the patient_uid is ever bundled/exported.
    const bundle = await this.collectHealthData(patientUid, hiTypes, dateFrom, dateTo, { tenantId });

    if (!keyMaterial?.dhPublicKey?.keyValue || !keyMaterial?.nonce) {
      throw AppError.badRequest(
        'HIU key material missing or incomplete — refusing to push unencrypted health information',
        'ABDM_KEY_MATERIAL_MISSING'
      );
    }

    const { content, checksum, senderKeyMaterial } = encryptFhirBundle(bundle, keyMaterial);

    // Resolve a care-context reference for the entry; fall back to a
    // transaction-scoped reference when the patient has none registered.
    let careContextReference = `VH-BUNDLE-${transactionId}`;
    try {
      const ccLookup = (db) => db.$queryRawUnsafe(
        `SELECT care_context_reference FROM abdm_care_contexts
         WHERE patient_uid = $1${tenantId ? ' AND tenant_id = $2::uuid' : ''}
         ORDER BY created_at DESC
         LIMIT 1`,
        ...(tenantId ? [patientUid, tenantId] : [patientUid]),
      );
      const ccRows = tenantId
        ? await setTenant(tenantId, (tx) => ccLookup(tx))
        : await ccLookup(prisma);
      if (ccRows.length && ccRows[0].care_context_reference) {
        careContextReference = ccRows[0].care_context_reference;
      }
    } catch (err) {
      logger.warn('ABDM care-context lookup failed; using transaction reference', {
        transactionId,
        error: err.message,
      });
    }

    const entries = [
      { content, media: 'application/fhir+json', checksum, careContextReference },
    ];

    // Send via ABDM gateway / HIU data-push endpoint
    if (ABDM_CONFIG.enabled) {
      await abdmGateway.sendHealthData(transactionId, entries, senderKeyMaterial, { dataPushUrl });

      // Phase 1.5 best-effort: transfer-status notification must never
      // fail the delivered transfer.
      abdmGateway
        .notifyHealthInfoTransfer({
          transactionId,
          consentId,
          sessionStatus: 'TRANSFERRED',
          careContextReferences: [careContextReference],
        })
        .catch((err) => {
          logger.warn('ABDM health-information notify failed (transfer already delivered)', {
            transactionId,
            error: err.message,
          });
        });
    }

    // Mark as delivered; keep our public key material for traceability.
    // Tenant-scoped so the status write is RLS-checked into the right tenant.
    const markDelivered = (db) => db.$queryRawUnsafe(
      `UPDATE abdm_data_requests
       SET status = 'DELIVERED', delivered_at = NOW(), sender_key_material = $2
       WHERE transaction_id = $1${tenantId ? ' AND tenant_id = $3::uuid' : ''}`,
      ...(tenantId
        ? [transactionId, JSON.stringify(senderKeyMaterial), tenantId]
        : [transactionId, JSON.stringify(senderKeyMaterial)])
    );
    if (tenantId) {
      await setTenant(tenantId, (tx) => markDelivered(tx));
    } else {
      await markDelivered(prisma);
    }

    logger.info('ABDM data request processed (encrypted)', {
      transactionId,
      patientUid,
      entriesCount: bundle.total,
      pushedDirect: Boolean(dataPushUrl),
    });
  }
}

export default new ABDMService();
