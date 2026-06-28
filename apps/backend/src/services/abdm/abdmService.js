// src/services/abdm/abdmService.js
// ABDM Business Logic — ABHA registration, consent management, health data exchange

import crypto from 'crypto';

import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { assertSafeOutboundUrl } from '../../utils/ssrfGuard.js';
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

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for ABDM operations', 'ABDM_TENANT_REQUIRED');
  }
  return tenantId;
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
   * Link an ABHA ID to a patient account. Verifies via ABDM gateway first.
   * @param {string} patientUid - Patient's UUID
   * @param {string} abhaNumber - 14-digit ABHA number
   * @param {string} abhaAddress - ABHA address (user@abdm)
   * @returns {Object} Updated patient record
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
    const cleanAbha = abhaNumber.replace(/-/g, '');
    if (!/^\d{14}$/.test(cleanAbha)) {
      throw AppError.badRequest('Invalid ABHA number format. Must be 14 digits.', 'INVALID_ABHA_FORMAT');
    }

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

    // Check ABHA not already linked to another patient
    const existingAbha = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users
       WHERE tenant_id = $1::uuid
         AND abha_number = $2
         AND uid != $3::uuid
       LIMIT 1`,
      tid, abhaNumber, patientUid
    );
    if (existingAbha.length > 0) {
      throw AppError.conflict('This ABHA number is already linked to another patient', 'ABHA_ALREADY_LINKED');
    }

    // Verify ABHA with ABDM gateway (if enabled)
    if (ABDM_CONFIG.enabled) {
      try {
        await abdmGateway.verifyABHA(abhaNumber);
      } catch (err) {
        logger.warn('ABDM ABHA verification failed, proceeding with local registration', {
          abhaNumber,
          error: err.message,
        });
        // Don't block registration if gateway is unreachable — record locally
      }
    }

    // Update patient with ABHA details
    const result = await prisma.$queryRawUnsafe(
      `UPDATE users
       SET abha_number = $1, abha_address = $2, updated_at = NOW()
       WHERE uid = $3::uuid AND tenant_id = $4::uuid
       RETURNING uid, tenant_id, name, phone, abha_number, abha_address, updated_at`,
      abhaNumber, abhaAddress || null, patientUid, tid
    );

    logger.info('ABHA linked to patient', {
      patientUid,
      abhaNumber,
      abhaAddress: abhaAddress || null,
    });

    return result[0];
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

    const result = await prisma.$queryRawUnsafe(
      `SELECT uid, tenant_id, name, phone, email, gender, birthday, abha_number, abha_address, registered_at
       FROM users
       WHERE tenant_id = $1::uuid
         AND abha_number = $2
         AND is_active = true
       LIMIT 1`,
      tid, abhaNumber
    );

    if (result.length === 0) {
      throw AppError.notFound('No patient found with this ABHA number', 'ABHA_NOT_FOUND');
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
    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, tenant_id FROM users
       WHERE abha_number = $1 AND is_active = true AND role = 'PATIENT'`,
      abhaNumber,
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
    return { patientUid: rows[0].uid, tenantId: rows[0].tenant_id };
  }

  _verifyConsentArtefact({ consentRequestId, consentArtefact, signature }) {
    if (!consentArtefactVerificationEnabled()) {
      logger.warn(
        'ABDM consent-artefact signature verification is DISABLED — set ABDM_VERIFY_CONSENT_ARTEFACT=true and ABDM_CM_PUBLIC_KEY before production',
        { consentRequestId },
      );
      return;
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
    const payload = typeof consentArtefact === 'string'
      ? consentArtefact
      : JSON.stringify(consentArtefact);
    let verified = false;
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(payload);
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
  }

  async handleConsentRequest(consentRequest) {
    const {
      consentRequestId,
      purpose,
      hiTypes,
      patient,
      hiu,
      requester,
      dateRange,
      expiry,
      consentArtefact,
      signature,
    } = consentRequest;

    if (!consentRequestId || !purpose || !patient?.id) {
      throw AppError.badRequest('Invalid consent request payload', 'INVALID_CONSENT_REQUEST');
    }

    // Validate purpose
    if (!ABDM_CONFIG.PURPOSES.includes(purpose)) {
      throw AppError.badRequest(`Invalid consent purpose: ${purpose}`, 'INVALID_PURPOSE');
    }

    // Verify the CM-signed consent artefact BEFORE trusting any of the
    // notification body (#3). When the operator has supplied the CM public key
    // + enabled verification, a missing/invalid signature is rejected; when
    // verification is not configured we proceed but record that the chain is
    // operator-gated (never hardcode a sandbox trust in prod).
    this._verifyConsentArtefact({ consentRequestId, consentArtefact, signature });

    // Resolve the patient AND their tenant from the ABHA. ABHA numbers are a
    // national id, so the same person can be registered at facilities in more
    // than one tenant. If the ABHA resolves in exactly one tenant we bind to
    // it; if it spans MULTIPLE tenants we cannot deterministically pick one
    // from the (tenant-less) ABDM notification, so we reject rather than
    // silently leak into the default tenant.
    const { patientUid, tenantId } = await this._resolvePatientTenantByAbha(patient.id);

    // Everything below runs scoped to the patient's tenant so the abdm_consents
    // insert is RLS-checked into THAT tenant (the GUC-reading column default
    // resolves to it) and the duplicate probe only sees that tenant's rows.
    return setTenant(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id FROM abdm_consents WHERE consent_id = $1 AND tenant_id = $2::uuid LIMIT 1`,
        consentRequestId, tenantId,
      );
      if (existing.length > 0) {
        throw AppError.conflict('Consent request already exists', 'DUPLICATE_CONSENT');
      }

      const expiryDate = expiry ? new Date(expiry) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // default 30 days

      const result = await tx.$queryRawUnsafe(
        `INSERT INTO abdm_consents
          (consent_id, patient_uid, tenant_id, hip_id, hiu_id, purpose, hi_types,
           date_range_from, date_range_to, expiry_date, status, requester_name, created_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, 'REQUESTED', $11, NOW())
         RETURNING id, consent_id, patient_uid, purpose, hi_types, status, expiry_date, requester_name, created_at`,
        consentRequestId,
        patientUid,
        tenantId,
        ABDM_CONFIG.hipId || null,
        hiu?.id || null,
        purpose,
        hiTypes || [],
        dateRange?.from ? new Date(dateRange.from) : null,
        dateRange?.to ? new Date(dateRange.to) : null,
        expiryDate,
        requester?.name || null,
      );

      logger.info('ABDM consent request created', {
        consentId: consentRequestId,
        patientUid,
        purpose,
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
    const consentArtifact = {
      schemaVersion: '1.0',
      consentId,
      createdAt: new Date().toISOString(),
      purpose: { code: consent.purpose },
      patient: { id: consent.patient_abha },
      hip: { id: consent.hip_id || ABDM_CONFIG.hipId },
      hiu: { id: consent.hiu_id },
      consentManager: { id: consentManagerId() },
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
       SET status = 'GRANTED', granted_at = NOW(), consent_artifact = $1
       WHERE consent_id = $2
       RETURNING id, consent_id, patient_uid, purpose, status, granted_at, consent_artifact`,
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
    ).catch((err) => {
      logger.error('Failed to process ABDM data request', {
        transactionId,
        error: err.message,
      });
      // Mark as FAILED (tenant-scoped).
      setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
        `UPDATE abdm_data_requests SET status = 'FAILED' WHERE transaction_id = $1 AND tenant_id = $2::uuid`,
        transactionId, tenantId,
      )).catch(() => {});
    });

    return requestResult[0];
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
              c.status, c.requester_name, c.granted_at, c.revoked_at,
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
