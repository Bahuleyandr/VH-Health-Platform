// src/services/abdm/abdmHiuService.js
//
// THIN HIU (migration 703, extending the 124 abdmFull layer) — consent
// request creation/status plus health-information fetch sessions.
//
// Deliberate layering (703 header): consent objects live in the EXISTING
// abdmFull tables (abdm_consent_requests flow_kind='hiu',
// abdm_consent_artifacts) driven through abdmHipHiuService primitives, and
// each fetch creates an abdm_data_transfers direction='in' row. This module
// adds only what a real fetch was missing:
//
//   * abdm_hiu_fetch_sessions — the cm/health-information txn state machine:
//       requested → acknowledged → receiving → completed | partial | failed | expired
//     Unlike the HIP push leg (ephemeral keys never persisted), the HIU
//     RECEIVE leg must hold its X25519 private key across the async
//     hi-request → data-push gap. The key is persisted encryptField()-encrypted
//     for the txn lifetime and NULLed immediately after all parts decrypt —
//     key material is a liability, not evidence.
//   * abdm_hiu_received_bundles — R2 references to decrypted FHIR bundles.
//     PHI bytes go to R2 (vh-health-records, abdm-hiu/<tenant>/<session>/…),
//     NEVER into Postgres.
//
// Clinical-timeline posture (703 header + design doc): bundles are stored as
// REFERENCES ONLY and rendered transiently — that is PHI access
// (logPhiAccess at the route), not a clinical write, so NO
// clinical_timeline_events row. A future importer that persists a fetched
// record into the local chart takes the detail+timeline+audit same-tx rule.
//
// PRE-RLS callbacks: tenant resolved by validateABDMRequest; every write here
// carries tenant_id explicitly.

import crypto from 'crypto';

import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { uploadFileToR2, getFileFromR2, deleteObject } from '../../utils/r2Storage.js';
import {
  createConsentRequest,
  createDataTransfer,
  markWebhookProcessed,
  recordConsentArtifact,
  recordWebhookEvent,
  transitionConsentRequest,
  transitionDataTransfer,
} from '../abdmFull/abdmHipHiuService.js';
import { getAbdmHiuSettings } from '../tenant/tenantSettingsService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { generateKeyMaterial, decryptFhirBundle } from './abdmCrypto.js';
import abdmGateway from './abdmGateway.js';
import abdmService from './abdmService.js';

const KEY_TTL_MINUTES = 30;
const LIVE_SESSION_STATUSES = ['requested', 'acknowledged', 'receiving'];

const SESSION_RETURNING = `id, tenant_id, environment, consent_artifact_id,
  data_transfer_id, patient_uid, transaction_id, request_id, hi_types,
  date_range_from, date_range_to, data_push_url, status, parts_expected,
  parts_received, pages_expected, next_page_number, initiated_by_uid, requested_at, acknowledged_at,
  completed_at, failure_reason, metadata, created_at, updated_at`;

const BUNDLE_RETURNING = `id, tenant_id, fetch_session_id, care_context_reference,
  hi_type, part_number, bundle_storage_key, bundle_sha256, checksum_verified,
  media_type, received_at, metadata, created_at`;

/** Public projection: NEVER exposes key material columns. */
function publicSession(row) {
  if (!row) return null;
  const {
    key_material_private_ciphertext: _key,
    key_material_nonce: _nonce,
    ...rest
  } = row;
  return rest;
}

async function assertHiuEnabled(tenantId) {
  if (!ABDM_CONFIG.enabled) {
    throw new AppError('ABDM integration is not enabled', 503, 'ABDM_NOT_ENABLED');
  }
  const settings = await getAbdmHiuSettings(tenantId);
  if (!settings.enabled) {
    throw AppError.forbidden(
      'ABDM HIU data fetch is not enabled for this tenant',
      'ABDM_HIU_DISABLED',
    );
  }
}

function hiuDataPushUrl() {
  const base = String(ABDM_CONFIG.callbackUrl || '').replace(/\/+$/, '');
  if (!base) {
    throw AppError.internal(
      'ABDM_CALLBACK_URL must be configured for the HIU data-push leg',
      'ABDM_CALLBACK_URL_MISSING',
    );
  }
  return `${base}/api/v1/abdm/hiu/health-info/push`;
}

function normalizeConsentText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizedHiTypes(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result = [...new Set(value.map((item) => normalizeConsentText(item)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return result.length > 0 ? result : null;
}

function sameTimestamp(left, right) {
  if (!left || !right) return false;
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function assertHiuConsentBinding({ requestRow, artifactId, detail, verification, hipId }) {
  const payload = verification?.payload;
  const mismatches = [];
  if (!requestRow || requestRow.flow_kind !== 'hiu' || requestRow.status !== 'requested') {
    mismatches.push('consentRequest');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    mismatches.push('artefact');
  } else {
    if (normalizeConsentText(payload.consentId) !== artifactId) mismatches.push('consentId');
    if (normalizeConsentText(payload.patient?.id)?.toLowerCase()
        !== normalizeConsentText(requestRow?.metadata?.abha_address)?.toLowerCase()) {
      mismatches.push('patient.id');
    }
    if (normalizeConsentText(payload.hip?.id) !== hipId) mismatches.push('hip.id');
    if (!ABDM_CONFIG.hiuId || normalizeConsentText(payload.hiu?.id) !== ABDM_CONFIG.hiuId) {
      mismatches.push('hiu.id');
    }
    if (normalizeConsentText(payload.purpose?.code ?? payload.purpose)
        !== normalizeConsentText(requestRow?.purpose_code)) mismatches.push('purpose');
    const verifiedHiTypes = normalizedHiTypes(payload.hiTypes);
    const requestedHiTypes = normalizedHiTypes(requestRow?.hi_types);
    if (!verifiedHiTypes || !requestedHiTypes
        || JSON.stringify(verifiedHiTypes) !== JSON.stringify(requestedHiTypes)) {
      mismatches.push('hiTypes');
    }
    if (!sameTimestamp(payload.permission?.dateRange?.from, requestRow?.data_from)) {
      mismatches.push('dateRange.from');
    }
    if (!sameTimestamp(payload.permission?.dateRange?.to, requestRow?.data_to)) {
      mismatches.push('dateRange.to');
    }
    if (!sameTimestamp(payload.permission?.dataEraseAt, requestRow?.expiry_at)) {
      mismatches.push('expiry');
    }
  }
  if (!detail || !verification || mismatches.length > 0) {
    throw AppError.forbidden(
      'Consent artefact does not match the HIU request',
      'ABDM_CONSENT_BINDING_MISMATCH',
      { fields: [...new Set(mismatches.length > 0 ? mismatches : ['artefact'])] },
    );
  }
}

async function markWebhookFailed(tenantId, event, err) {
  if (!event?.id) return;
  await markWebhookProcessed({
    tenantId,
    id: Number(event.id),
    status: 'failed',
    failureReason: String(err?.message || 'callback processing failed').slice(0, 500),
  }).catch((markErr) => logger.error('Failed to mark ABDM HIU webhook failed', {
    eventId: event.id,
    error: markErr.message,
  }));
}

// ---------------------------------------------------------------------------
// Consent request leg
// ---------------------------------------------------------------------------

/**
 * Clinician-initiated HIU consent request: persist the abdmFull row FIRST
 * (durable evidence), then init at the gateway; a gateway refusal transitions
 * the row to failed.
 */
export async function createHiuConsentRequest({
  tenantId = null,
  patientUid = null,
  abhaAddress,
  purposeCode = 'CAREMGT',
  hiTypes = [],
  dataFrom,
  dataTo,
  expiryAt,
  requesterUid = null,
  requesterName = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await assertHiuEnabled(tid);
  const cleanAddress = String(abhaAddress || '').trim().toLowerCase();
  if (!cleanAddress || !cleanAddress.includes('@')) {
    throw AppError.badRequest(
      'Patient ABHA address (name@abdm) is required',
      'INVALID_ABHA_ADDRESS',
    );
  }
  const expectedPatientUid = String(patientUid || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedPatientUid)) {
    throw AppError.badRequest('A valid patient UID is required', 'INVALID_PATIENT_UID');
  }
  if (!Array.isArray(hiTypes) || hiTypes.length === 0) {
    throw AppError.badRequest('At least one hiType is required', 'MISSING_HI_TYPES');
  }
  if (!dataFrom || !dataTo || !expiryAt) {
    throw AppError.badRequest('dataFrom, dataTo and expiryAt are required', 'MISSING_DATE_RANGE');
  }
  const fromMs = new Date(dataFrom).getTime();
  const toMs = new Date(dataTo).getTime();
  const expiryMs = new Date(expiryAt).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !Number.isFinite(expiryMs)
      || fromMs > toMs || expiryMs <= Date.now()) {
    throw AppError.badRequest('Consent dates are invalid or expired', 'INVALID_CONSENT_DATES');
  }
  const patients = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
        AND role = 'PATIENT' AND is_active = TRUE AND is_deleted = FALSE
        AND abha_verification_status = 'verified'
        AND LOWER(abha_address) = $3::text
      LIMIT 1`,
    tid,
    expectedPatientUid,
    cleanAddress,
  );
  if (!patients[0]) {
    throw AppError.forbidden(
      'Patient ABHA address is not verified for this patient',
      'ABDM_PATIENT_ABHA_MISMATCH',
    );
  }

  const requestId = crypto.randomUUID();
  const row = await createConsentRequest({
    tenantId: tid,
    requestId,
    flowKind: 'hiu',
    abhaId: null,
    patientUid: expectedPatientUid,
    requesterUid,
    hiTypes,
    permissionKind: 'view',
    dataFrom,
    dataTo,
    expiryAt,
    purposeCode,
    environment: ABDM_CONFIG.environment,
    metadata: { abha_address: cleanAddress },
  });

  try {
    await abdmGateway.initHiuConsentRequest({
      requestId,
      patientAbhaAddress: cleanAddress,
      purposeCode,
      hiTypes,
      dateFrom: dataFrom,
      dateTo: dataTo,
      expiryAt,
      requesterName,
    });
  } catch (err) {
    try {
      await transitionConsentRequest({
        tenantId: tid,
        id: row.id,
        nextStatus: 'failed',
        notificationFailure: err.message,
      });
    } catch (markErr) {
      logger.error('Failed to mark HIU consent request failed', {
        consentRequestId: row.id,
        error: markErr.message,
      });
    }
    throw err;
  }
  return row;
}

/** Gateway ack for consent-requests/init (callback leg). */
export async function handleHiuConsentOnInit({
  tenantId = null, environment = 'sandbox', body = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const originalRequestId = String(body?.resp?.requestId || '').trim();
  if (!originalRequestId) {
    throw AppError.badRequest('on-init resp.requestId is required', 'ABDM_HIU_ON_INIT_SHAPE');
  }
  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: String(body.requestId || crypto.randomUUID()),
    eventType: 'hiu_consent_on_init',
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: body,
    environment,
    retryFailed: true,
  });
  if (eventIntake.duplicate) {
    return { duplicate: true };
  }

  try {
  const cmConsentRequestId = body?.consentRequest?.id || null;
  if (body?.error) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM abdm_consent_requests
        WHERE tenant_id = $1::uuid AND request_id = $2::text AND environment = $3::text
        LIMIT 1`,
      tid, originalRequestId, environment,
    );
    if (rows[0]) {
      await transitionConsentRequest({
        tenantId: tid,
        id: rows[0].id,
        nextStatus: 'failed',
        notificationFailure: String(body.error?.message || 'consent-request init rejected').slice(0, 500),
      });
    }
  } else if (cmConsentRequestId) {
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_consent_requests
          SET metadata = metadata || jsonb_build_object('cm_consent_request_id', $4::text),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND request_id = $2::text AND environment = $3::text`,
      tid, originalRequestId, environment, String(cmConsentRequestId),
    );
  }
  await markWebhookProcessed({ tenantId: tid, id: Number(eventIntake.event.id), status: 'processed' });
  return { duplicate: false, cmConsentRequestId };
  } catch (err) {
    await markWebhookFailed(tid, eventIntake.event, err);
    throw err;
  }
}

/**
 * CM consent notification for the HIU (GRANTED / DENIED / REVOKED / EXPIRED).
 * This path requires a signed artefact regardless of the optional HIP-side
 * verification toggle and binds every verified field to the local request.
 */
export async function handleHiuConsentNotify({
  tenantId = null, environment = 'sandbox', body = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const notification = body?.notification || {};
  const cmConsentRequestId = String(notification.consentRequestId || '').trim();
  const status = String(notification.status || '').trim().toUpperCase();
  if (!cmConsentRequestId || !status) {
    throw AppError.badRequest('Consent notification shape is invalid', 'ABDM_HIU_NOTIFY_SHAPE');
  }

  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: String(body.requestId || `${cmConsentRequestId}:${status}`),
    eventType: 'hiu_consent_notify',
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: body,
    environment,
    retryFailed: true,
  });
  if (eventIntake.duplicate) {
    return { duplicate: true };
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, request_id, flow_kind, status, hi_types, patient_uid,
              data_from, data_to, expiry_at, purpose_code, metadata
         FROM abdm_consent_requests
        WHERE tenant_id = $1::uuid AND environment = $2::text
          AND (request_id = $3::text OR metadata->>'cm_consent_request_id' = $3::text)
        LIMIT 1`,
      tid, environment, cmConsentRequestId,
    );
    const requestRow = rows[0] || null;
    if (!requestRow || requestRow.flow_kind !== 'hiu') {
      throw AppError.notFound('HIU consent request not found', 'ABDM_HIU_CONSENT_REQUEST_NOT_FOUND');
    }

    const STATUS_MAP = {
      GRANTED: 'granted', DENIED: 'denied', REVOKED: 'revoked', EXPIRED: 'expired',
    };
    const nextStatus = STATUS_MAP[status];
    if (!nextStatus) {
      throw AppError.badRequest('Unsupported consent notification status', 'ABDM_HIU_NOTIFY_STATUS');
    }

    const verifiedEntries = [];
    if (status === 'GRANTED') {
      const entries = Array.isArray(notification.consentArtefacts)
        ? notification.consentArtefacts : [];
      if (entries.length === 0) {
        throw AppError.forbidden('A signed consent artefact is required', 'ABDM_CONSENT_UNSIGNED');
      }
      for (const entry of entries) {
        const artifactId = String(entry?.id || '').trim();
        const detail = entry?.consentDetail || entry?.consentArtefact || null;
        const signature = entry?.signature || body.signature || null;
        const hipId = normalizeConsentText(entry?.hip?.id ?? notification?.hip?.id);
        if (!artifactId || !detail || !signature || !hipId) {
          throw AppError.forbidden('Consent protocol evidence is incomplete', 'ABDM_CONSENT_UNSIGNED');
        }
        const verification = abdmService._verifyConsentArtefact({
          consentRequestId: artifactId,
          consentArtefact: detail,
          signature,
          required: true,
        });
        assertHiuConsentBinding({ requestRow, artifactId, detail, verification, hipId });
        verifiedEntries.push({ artifactId, verification, hipId });
      }
    }

    if (status === 'GRANTED' && requestRow.status !== 'requested') {
      throw AppError.conflict('HIU consent request is not awaiting a grant', 'ABDM_HIU_CONSENT_NOT_REQUESTED');
    }
    if (status !== 'GRANTED' && requestRow.status === 'requested'
        && ['denied', 'expired'].includes(nextStatus)) {
      await transitionConsentRequest({ tenantId: tid, id: requestRow.id, nextStatus });
    } else if (requestRow.status === 'granted' && ['revoked', 'expired'].includes(nextStatus)) {
      await transitionConsentRequest({ tenantId: tid, id: requestRow.id, nextStatus });
    }

    const artifacts = [];
    for (const verifiedEntry of verifiedEntries) {
      try {
        const artifact = await recordConsentArtifact({
          tenantId: tid,
          consentRequestId: requestRow.id,
          artifactId: verifiedEntry.artifactId,
          patientUid: requestRow.patient_uid,
          hiTypes: requestRow.hi_types,
          permissionKind: 'view',
          dataFrom: requestRow.data_from,
          dataTo: requestRow.data_to,
          expiryAt: requestRow.expiry_at,
          signedPayload: verifiedEntry.verification.payload,
          environment,
          metadata: {
            source: 'hiu_consent_notify',
            signature_verified: true,
            artefact_sha256: verifiedEntry.verification.sha256,
            hip_id: verifiedEntry.hipId,
            hiu_id: ABDM_CONFIG.hiuId,
          },
        });
        artifacts.push(artifact);
      } catch (err) {
        if (err.statusCode === 409) continue;
        throw err;
      }
    }

    if (status === 'GRANTED') {
      await transitionConsentRequest({ tenantId: tid, id: requestRow.id, nextStatus });
    }

    if (nextStatus === 'revoked' || nextStatus === 'expired') {
      await prisma.$executeRawUnsafe(
        `UPDATE abdm_consent_artifacts
            SET status = $3::text,
                revoked_at = CASE WHEN $3::text = 'revoked' THEN NOW() ELSE revoked_at END,
                expired_at = CASE WHEN $3::text = 'expired' THEN NOW() ELSE expired_at END,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND consent_request_id = $2::integer
            AND environment = $4::text AND status = 'active'`,
        tid,
        requestRow.id,
        nextStatus,
        environment,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE abdm_hiu_fetch_sessions s
            SET status = 'expired',
                key_material_private_ciphertext = NULL,
                failure_reason = $3::text,
                updated_at = NOW()
           FROM abdm_consent_artifacts a
          WHERE a.id = s.consent_artifact_id
            AND a.tenant_id = $1::uuid AND s.tenant_id = $1::uuid
            AND a.consent_request_id = $2::integer
            AND s.environment = $4::text
            AND s.status IN ('requested', 'acknowledged', 'receiving')`,
        tid,
        requestRow.id,
        `consent ${nextStatus}`,
        environment,
      );
    }

    await markWebhookProcessed({
      tenantId: tid,
      id: Number(eventIntake.event.id),
      status: 'processed',
      relatedRequestId: requestRow.id,
    });
    return { duplicate: false, status, artifacts: artifacts.length };
  } catch (err) {
    await markWebhookFailed(tid, eventIntake.event, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fetch leg
// ---------------------------------------------------------------------------

/**
 * Start a health-information fetch against a granted consent artefact.
 * Generates the X25519 receive keypair, persists the PRIVATE key
 * encryptField()-encrypted for the txn lifetime (703), hands the PUBLIC
 * envelope + our dataPushUrl to the CM.
 *
 * transaction_id is provisionally our requestId; the CM's on-request ack
 * carries the real transactionId and the ack handler re-stamps it (the column
 * is NOT NULL + unique, and the data push references the CM's id).
 */
export async function startHiuFetch({
  tenantId = null,
  artifactId,
  initiatedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await assertHiuEnabled(tid);
  const artId = Number.parseInt(artifactId, 10);
  if (!Number.isFinite(artId) || artId <= 0) {
    throw AppError.badRequest('artifactId must be a positive integer', 'INVALID_ARTIFACT_ID');
  }
  const artifacts = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.artifact_id, a.patient_uid, a.hi_types, a.data_from,
            a.data_to, a.expiry_at, a.status
       FROM abdm_consent_artifacts a
       JOIN abdm_consent_requests r
         ON r.id = a.consent_request_id AND r.tenant_id = $2::uuid
       JOIN users u
         ON u.uid = a.patient_uid AND u.tenant_id = $2::uuid
      WHERE a.id = $1::integer AND a.tenant_id = $2::uuid
        AND a.environment = $3::text AND r.environment = $3::text
        AND a.status = 'active' AND a.expiry_at > NOW()
        AND r.flow_kind = 'hiu' AND r.status = 'granted'
        AND r.expiry_at > NOW() AND r.patient_uid = a.patient_uid
        AND u.role = 'PATIENT' AND u.is_active = TRUE AND u.is_deleted = FALSE
        AND u.abha_verification_status = 'verified'
        AND LOWER(u.abha_address) = LOWER(r.metadata->>'abha_address')
      LIMIT 1`,
    artId, tid, ABDM_CONFIG.environment,
  );
  const artifact = artifacts[0];
  if (!artifact) {
    throw AppError.notFound('Consent artifact not found', 'ABDM_ARTIFACT_NOT_FOUND');
  }

  const requestId = crypto.randomUUID();
  const dataPushUrl = hiuDataPushUrl();
  const keys = generateKeyMaterial({ expiryMinutes: KEY_TTL_MINUTES });
  // Persist the private key for the async gap — encryptField ciphertext only.
  const privatePkcs8B64 = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const encryptedPrivate = encryptField(privatePkcs8B64, { tenantId: tid });

  const sessions = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_hiu_fetch_sessions
       (tenant_id, environment, consent_artifact_id, patient_uid, transaction_id,
        request_id, hi_types, date_range_from, date_range_to, data_push_url,
        key_material_private_ciphertext, key_material_nonce,
        key_material_expires_at, status, initiated_by_uid)
     VALUES ($1::uuid, $2::text, $3::integer, $4::uuid, $5::text,
             $5::text, $6::text[], $7::timestamptz, $8::timestamptz, $9::text,
             $10::text, $11::text,
             NOW() + ($12::int * INTERVAL '1 minute'), 'requested', $13::uuid)
     RETURNING ${SESSION_RETURNING}`,
    tid, ABDM_CONFIG.environment, artifact.id, artifact.patient_uid, requestId,
    artifact.hi_types || [], artifact.data_from, artifact.data_to, dataPushUrl,
    encryptedPrivate, keys.nonce, KEY_TTL_MINUTES, initiatedBy,
  );
  const session = sessions[0];

  const transfer = await createDataTransfer({
    tenantId: tid,
    consentArtifactId: artifact.id,
    transactionId: requestId,
    patientUid: artifact.patient_uid,
    direction: 'in',
    encryptionKind: 'ecdh_aes_256_gcm',
    hiTypes: artifact.hi_types || [],
    environment: ABDM_CONFIG.environment,
    metadata: { fetch_session_id: session.id },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE abdm_hiu_fetch_sessions SET data_transfer_id = $3::integer, updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid`,
    session.id, tid, transfer.id,
  );

  try {
    await abdmGateway.requestHealthInformation({
      requestId,
      consentId: artifact.artifact_id,
      dateFrom: artifact.data_from,
      dateTo: artifact.data_to,
      dataPushUrl,
      keyMaterial: keys.keyMaterial,
    });
  } catch (err) {
    // Gateway refusal: fail the session and destroy the key immediately.
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'failed', failure_reason = $3::text,
              key_material_private_ciphertext = NULL, updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      session.id, tid, String(err.message).slice(0, 500),
    ).catch(() => {});
    await transitionDataTransfer({
      tenantId: tid, id: transfer.id, nextStatus: 'failed', failureReason: err.message,
    }).catch(() => {});
    throw err;
  }

  logger.info('ABDM HIU fetch session started', { sessionId: session.id, tenantId: tid });
  return publicSession({ ...session, data_transfer_id: transfer.id });
}

/** CM ack of the hi-request: stamps the real transactionId (callback leg). */
export async function handleHiuHealthInfoOnRequest({
  tenantId = null, environment = 'sandbox', body = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const originalRequestId = String(body?.resp?.requestId || '').trim();
  if (!originalRequestId) {
    throw AppError.badRequest('on-request resp.requestId is required', 'ABDM_HIU_ON_REQUEST_SHAPE');
  }
  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: String(body.requestId || crypto.randomUUID()),
    eventType: 'hiu_health_info_on_request',
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: body,
    environment,
    retryFailed: true,
  });
  if (eventIntake.duplicate) return { duplicate: true };

  try {
  if (body?.error) {
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'failed', failure_reason = $3::text,
              key_material_private_ciphertext = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND request_id = $2::text
          AND status IN ('requested', 'acknowledged')`,
      tid, originalRequestId, String(body.error?.message || 'hi-request rejected').slice(0, 500),
    );
  } else {
    const cmTransactionId = String(body?.hiRequest?.transactionId || '').trim();
    if (cmTransactionId) {
      await prisma.$executeRawUnsafe(
        `UPDATE abdm_hiu_fetch_sessions
            SET transaction_id = $3::text, status = 'acknowledged',
                acknowledged_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND request_id = $2::text
            AND status = 'requested'`,
        tid, originalRequestId, cmTransactionId,
      );
    }
  }
  await markWebhookProcessed({ tenantId: tid, id: Number(eventIntake.event.id), status: 'processed' });
  return { duplicate: false };
  } catch (err) {
    await markWebhookFailed(tid, eventIntake.event, err);
    throw err;
  }
}

/**
 * HIP → HIU data push (callback leg). Decrypts each entry with the persisted
 * receive key, verifies the transport checksum, uploads the DECRYPTED bundle
 * to R2, and records the reference row. On the final page the session
 * completes and the private key is NULLed.
 */
export async function handleHiuDataPush({
  tenantId = null, environment = 'sandbox', body = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const transactionId = String(body.transactionId || '').trim();
  if (!transactionId) {
    throw AppError.badRequest('Data push transactionId is required', 'ABDM_HIU_PUSH_SHAPE');
  }
  const pageNumber = Number(body.pageNumber ?? 1);
  const pageCount = Number(body.pageCount ?? 1);
  if (!Number.isSafeInteger(pageNumber) || !Number.isSafeInteger(pageCount)
      || pageNumber < 1 || pageCount < 1 || pageNumber > pageCount
      || !Array.isArray(body.entries)) {
    throw AppError.badRequest('Data push page contract is invalid', 'ABDM_HIU_PAGE_INVALID');
  }

  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: `${transactionId}:page:${pageNumber}`,
    eventType: 'hiu_data_push',
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: { transactionId, pageNumber, pageCount, entryCount: (body.entries || []).length },
    environment,
    retryFailed: true,
  });
  if (eventIntake.duplicate) {
    return { duplicate: true, transactionId };
  }

  try {
  const sessions = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING}, key_material_private_ciphertext, key_material_nonce,
            key_material_expires_at,
            (SELECT a.artifact_id FROM abdm_consent_artifacts a
              WHERE a.id = s.consent_artifact_id AND a.tenant_id = $1::uuid) AS artifact_id
       FROM abdm_hiu_fetch_sessions s
      WHERE tenant_id = $1::uuid AND transaction_id = $2::text AND environment = $3::text
        AND EXISTS (
          SELECT 1 FROM abdm_consent_artifacts a
          JOIN abdm_consent_requests r
            ON r.id = a.consent_request_id AND r.tenant_id = $1::uuid
          JOIN users u
            ON u.uid = a.patient_uid AND u.tenant_id = $1::uuid
          WHERE a.id = s.consent_artifact_id AND a.tenant_id = $1::uuid
            AND a.environment = $3::text AND r.environment = $3::text
            AND a.status = 'active' AND a.expiry_at > NOW()
            AND r.flow_kind = 'hiu' AND r.status = 'granted' AND r.expiry_at > NOW()
            AND r.patient_uid = a.patient_uid AND s.patient_uid = a.patient_uid
            AND u.role = 'PATIENT' AND u.is_active = TRUE AND u.is_deleted = FALSE
            AND u.abha_verification_status = 'verified'
            AND LOWER(u.abha_address) = LOWER(r.metadata->>'abha_address')
        )
      LIMIT 1`,
    tid, transactionId, environment,
  );
  const session = sessions[0];
  if (!session) {
    throw AppError.notFound('No fetch session for this transaction', 'ABDM_HIU_SESSION_NOT_FOUND');
  }
  if (!LIVE_SESSION_STATUSES.includes(session.status)) {
    throw AppError.conflict('Fetch session is not receiving', 'ABDM_HIU_SESSION_NOT_LIVE');
  }
  if (Number(session.next_page_number) !== pageNumber
      || (session.pages_expected != null && Number(session.pages_expected) !== pageCount)) {
    throw AppError.conflict('Data push page is out of order', 'ABDM_HIU_PAGE_OUT_OF_ORDER');
  }
  if (!body?.consent?.id || String(body.consent.id) !== String(session.artifact_id)) {
    throw AppError.forbidden('Data push consent does not match the fetch session', 'ABDM_HIU_CONSENT_MISMATCH');
  }
  if (!session.key_material_private_ciphertext) {
    throw AppError.conflict('Fetch session key material is gone', 'ABDM_HIU_KEY_UNAVAILABLE');
  }
  if (session.key_material_expires_at
      && new Date(session.key_material_expires_at).getTime() < Date.now()) {
    throw AppError.conflict('Fetch session key material has expired', 'ABDM_HIU_KEY_EXPIRED');
  }

  let receiverPrivateKey;
  try {
    const pkcs8B64 = decryptField(session.key_material_private_ciphertext);
    receiverPrivateKey = crypto.createPrivateKey({
      key: Buffer.from(pkcs8B64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (err) {
    logger.error('ABDM HIU receive key could not be reconstructed', {
      sessionId: session.id, error: err.message,
    });
    throw AppError.internal('Fetch session key material is unreadable', 'ABDM_HIU_KEY_UNREADABLE');
  }

  const entries = body.entries;
  const senderKeyMaterial = body.keyMaterial || null;
  let stored = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] || {};
    const partNumber = (pageNumber - 1) * 1000 + i;
    if (!entry.content || !entry.checksum || !entry.careContextReference || !entry.hiType) {
      throw AppError.badRequest('Data push entry evidence is incomplete', 'ABDM_HIU_ENTRY_INVALID');
    }
    if (!session.hi_types?.includes(String(entry.hiType))) {
      throw AppError.forbidden('Data push HI type is outside the granted consent', 'ABDM_HIU_HI_TYPE_MISMATCH');
    }
    const checksumOk = crypto.createHash('md5').update(String(entry.content)).digest('hex')
      === String(entry.checksum).toLowerCase();
    if (!checksumOk) {
      throw AppError.badRequest('Data push entry checksum is invalid', 'ABDM_HIU_CHECKSUM_INVALID');
    }
    let uploadedStorageKey = null;
    try {
      const bundle = decryptFhirBundle({
        content: entry.content,
        senderKeyMaterial,
        receiverPrivateKey,
        receiverNonce: session.key_material_nonce,
      });
      const bytes = Buffer.from(
        typeof bundle === 'string' ? bundle : JSON.stringify(bundle), 'utf8',
      );
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const storageKey = `abdm-hiu/${tid}/${session.id}/${pageNumber}-${partNumber}-${crypto.randomUUID()}.json`;
      await uploadFileToR2(bytes, storageKey, 'application/fhir+json');
      uploadedStorageKey = storageKey;
      const insertedBundle = await prisma.$queryRawUnsafe(
        `INSERT INTO abdm_hiu_received_bundles
           (tenant_id, fetch_session_id, care_context_reference, hi_type,
            part_number, bundle_storage_key, bundle_sha256, checksum_verified,
            media_type)
         VALUES ($1::uuid, $2::integer, $3::text, $4::text,
                 $5::integer, $6::text, $7::text, true, $8::text)
         ON CONFLICT (tenant_id, fetch_session_id, bundle_sha256) DO NOTHING
         RETURNING id`,
        tid, session.id,
        entry.careContextReference ? String(entry.careContextReference).slice(0, 120) : null,
        entry.hiType ? String(entry.hiType).slice(0, 60) : null,
        partNumber, storageKey, sha256,
        String(entry.media || 'application/fhir+json').slice(0, 60),
      );
      if (!insertedBundle[0]) {
        await deleteObject(storageKey);
        uploadedStorageKey = null;
      } else {
        stored += 1;
      }
    } catch (err) {
      if (uploadedStorageKey) {
        await deleteObject(uploadedStorageKey).catch((cleanupErr) => logger.error(
          'ABDM HIU orphan cleanup failed',
          { sessionId: session.id, storageKey: uploadedStorageKey, error: cleanupErr.message },
        ));
      }
      throw err;
    }
  }

  const finalPage = pageNumber === pageCount;
  let updatedSession;
  if (finalPage) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'completed', parts_received = parts_received + $3::int,
              pages_expected = COALESCE(pages_expected, $4::int),
              next_page_number = next_page_number + 1,
              completed_at = NOW(),
              key_material_private_ciphertext = NULL,
              updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid
          AND next_page_number = $5::int
          AND (pages_expected IS NULL OR pages_expected = $4::int)
        RETURNING ${SESSION_RETURNING}`,
      session.id, tid, stored, pageCount, pageNumber,
    );
    updatedSession = rows[0];
    if (!updatedSession) {
      throw AppError.conflict('Data push page lost its ordering claim', 'ABDM_HIU_PAGE_OUT_OF_ORDER');
    }
    if (session.data_transfer_id) {
      await transitionDataTransfer({
        tenantId: tid,
        id: session.data_transfer_id,
        nextStatus: 'succeeded',
        attemptIncrement: true,
      }).catch(() => {});
    }
    // Best-effort HIU-side transfer notification.
    try {
      await abdmGateway.notifyHiuHealthInfoStatus({
        transactionId,
        consentId: body?.consent?.id || null,
        sessionStatus: 'TRANSFERRED',
      });
    } catch (err) {
      logger.warn('ABDM HIU health-information notify failed (non-blocking)', {
        sessionId: session.id, error: err.message,
      });
    }
  } else {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'receiving', parts_received = parts_received + $3::int,
              pages_expected = COALESCE(pages_expected, $4::int),
              next_page_number = next_page_number + 1, updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid
          AND next_page_number = $5::int
          AND (pages_expected IS NULL OR pages_expected = $4::int)
        RETURNING ${SESSION_RETURNING}`,
      session.id, tid, stored, pageCount, pageNumber,
    );
    updatedSession = rows[0];
    if (!updatedSession) {
      throw AppError.conflict('Data push page lost its ordering claim', 'ABDM_HIU_PAGE_OUT_OF_ORDER');
    }
  }

  await markWebhookProcessed({ tenantId: tid, id: Number(eventIntake.event.id), status: 'processed' })
    .catch(() => {});
  logger.info('ABDM HIU data push handled', {
    sessionId: session.id, pageNumber, pageCount, stored,
  });
  return {
    duplicate: false,
    transactionId,
    session: publicSession(updatedSession),
    stored,
    failed: 0,
  };
  } catch (err) {
    await markWebhookFailed(tid, eventIntake.event, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads + sweep
// ---------------------------------------------------------------------------

export async function listFetchSessions({
  tenantId = null, status = null, patientUid = null, limit = 50,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING} FROM abdm_hiu_fetch_sessions
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR status = $2::text)
        AND patient_uid = $3::uuid
      ORDER BY requested_at DESC LIMIT $4::int`,
    tid, status ? String(status).trim().toLowerCase() : null, patientUid, safeLimit,
  );
  return { sessions: rows.map(publicSession), count: rows.length };
}

export async function getFetchSession({ tenantId = null, sessionId } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING} FROM abdm_hiu_fetch_sessions
      WHERE id = $1::integer AND tenant_id = $2::uuid LIMIT 1`,
    Number(sessionId), tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Fetch session not found', 'ABDM_HIU_SESSION_NOT_FOUND');
  }
  return publicSession(rows[0]);
}

export async function listReceivedBundles({ tenantId = null, sessionId } = {}) {
  const tid = requireTenantId(tenantId);
  await getFetchSession({ tenantId: tid, sessionId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${BUNDLE_RETURNING} FROM abdm_hiu_received_bundles
      WHERE tenant_id = $1::uuid AND fetch_session_id = $2::integer
      ORDER BY part_number ASC NULLS LAST, received_at ASC`,
    tid, Number(sessionId),
  );
  return { bundles: rows, count: rows.length };
}

/**
 * Stream one decrypted bundle back from R2 for transient rendering. The route
 * MUST logPhiAccess this read — it is PHI access, not a clinical write.
 */
export async function getReceivedBundleContent({ tenantId = null, sessionId, bundleId } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${BUNDLE_RETURNING} FROM abdm_hiu_received_bundles
      WHERE id = $1::integer AND tenant_id = $2::uuid AND fetch_session_id = $3::integer
      LIMIT 1`,
    Number(bundleId), tid, Number(sessionId),
  );
  const row = rows[0];
  if (!row) {
    throw AppError.notFound('Received bundle not found', 'ABDM_HIU_BUNDLE_NOT_FOUND');
  }
  const bytes = Buffer.from(await getFileFromR2(row.bundle_storage_key));
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString('utf8'));
  } catch {
    bundle = bytes.toString('utf8');
  }
  return { bundle: row, content: bundle };
}

/**
 * Cron sweep (abdm-hiu-fetch-expiry): expire live sessions whose key material
 * aged out, and destroy any key a terminal session still holds — key material
 * is a liability, not evidence.
 */
export async function sweepExpiredHiuFetchSessions() {
  const expired = await prisma.$queryRawUnsafe(
    `UPDATE abdm_hiu_fetch_sessions
        SET status = 'expired', key_material_private_ciphertext = NULL,
            failure_reason = COALESCE(failure_reason, 'key material expired before transfer'),
            updated_at = NOW()
      WHERE status IN ('${LIVE_SESSION_STATUSES.join("', '")}')
        AND key_material_expires_at IS NOT NULL AND key_material_expires_at < NOW()
      RETURNING id`,
  );
  const scrubbed = await prisma.$queryRawUnsafe(
    `UPDATE abdm_hiu_fetch_sessions
        SET key_material_private_ciphertext = NULL, updated_at = NOW()
      WHERE status IN ('completed', 'partial', 'failed', 'expired')
        AND key_material_private_ciphertext IS NOT NULL
      RETURNING id`,
  );
  if (expired.length > 0 || scrubbed.length > 0) {
    logger.info('ABDM HIU fetch expiry sweep complete', {
      expired: expired.length,
      keysScrubbed: scrubbed.length,
    });
  }
  return { expired: expired.length, keysScrubbed: scrubbed.length };
}

export default {
  createHiuConsentRequest,
  handleHiuConsentOnInit,
  handleHiuConsentNotify,
  startHiuFetch,
  handleHiuHealthInfoOnRequest,
  handleHiuDataPush,
  listFetchSessions,
  getFetchSession,
  listReceivedBundles,
  getReceivedBundleContent,
  sweepExpiredHiuFetchSessions,
};
