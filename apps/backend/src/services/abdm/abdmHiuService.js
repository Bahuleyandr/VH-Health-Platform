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
import prisma, { setTenantTx } from '../../lib/prisma.js';
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
const PAGE_CLAIM_TTL_MINUTES = 5;
const MAX_DATA_PUSH_ENTRIES_PER_PAGE = 1000;
const MAX_HIU_SESSION_PAGES = 100;
const MAX_HIU_SESSION_BUNDLES = 1000;
const MAX_HIU_DATA_PUSH_BYTES = 1024 * 1024;
const MAX_HIU_BUNDLE_BYTES = 512 * 1024;
const MAX_HIU_SESSION_BYTES = 20 * 1024 * 1024;
const POSTGRES_INTEGER_MAX = 2147483647;
const BUNDLE_READ_TX_TIMEOUT_MS = 100000;
const BUNDLE_UPLOAD_CLAIM_TX_TIMEOUT_MS = 100000;
const BUNDLE_PURGE_TX_TIMEOUT_MS = 35000;
const MAX_BUNDLE_PURGE_BATCH = 200;

const SESSION_RETURNING = `id, tenant_id, environment, consent_artifact_id,
  data_transfer_id, patient_uid, transaction_id, request_id, hi_types,
  date_range_from, date_range_to, data_push_url, status, parts_expected,
  parts_received, pages_expected, next_page_number, initiated_by_uid, requested_at, acknowledged_at,
  completed_at, failure_reason, metadata, created_at, updated_at`;

const BUNDLE_SELECT = `b.id, b.tenant_id, b.fetch_session_id, b.fetch_page_id, b.page_number,
  b.care_context_reference, b.hi_type, b.part_number, b.bundle_storage_key, b.bundle_sha256,
  b.checksum_verified, b.media_type, b.received_at, b.metadata, b.created_at`;

// Consent-chain activity is independent of the fetch lifecycle: requested and
// acknowledged sessions still need to survive the retention sweep. Bundle
// reads additionally require a state in which decrypted content may exist.
const ACTIVE_HIU_CONSENT_CHAIN_PREDICATE = `
  s.consent_artifact_id IS NOT NULL
  AND s.patient_uid IS NOT NULL
  AND a.id IS NOT NULL
  AND a.environment = s.environment
  AND a.patient_uid = s.patient_uid
  AND a.status = 'active'
  AND a.expiry_at IS NOT NULL
  AND a.expiry_at > clock_timestamp()
  AND r.id IS NOT NULL
  AND r.tenant_id = s.tenant_id
  AND r.environment = s.environment
  AND r.flow_kind = 'hiu'
  AND r.patient_uid = s.patient_uid
  AND r.status = 'granted'
  AND r.expiry_at IS NOT NULL
  AND r.expiry_at > clock_timestamp()
  AND u.uid = s.patient_uid
  AND u.role = 'PATIENT'
  AND u.is_active = TRUE
  AND u.is_deleted = FALSE
  AND u.abha_verification_status = 'verified'
  AND LOWER(u.abha_address) = LOWER(r.metadata->>'abha_address')`;

const ACTIVE_BUNDLE_CONSENT_PREDICATE = `
  s.status IN ('receiving', 'completed', 'partial')
  AND ${ACTIVE_HIU_CONSENT_CHAIN_PREDICATE}`;

function inactiveHiuConsentError() {
  return AppError.forbidden(
    'HIU consent is no longer active for this bundle',
    'ABDM_HIU_CONSENT_INACTIVE',
  );
}

function assertBundleTimeWindow(row) {
  const artifactExpiry = new Date(row?.artifact_expiry_at).getTime();
  const requestExpiry = new Date(row?.request_expiry_at).getTime();
  const now = Date.now();
  if (!Number.isFinite(artifactExpiry) || !Number.isFinite(requestExpiry)
      || artifactExpiry <= now || requestExpiry <= now) {
    throw inactiveHiuConsentError();
  }
}

function payloadTooLarge(message, code, details = null) {
  return new AppError(message, 413, code, details);
}

function sessionBundleBytes(session) {
  const value = session?.metadata?.hiu_bundle_bytes_received;
  if (value == null && Number(session?.parts_received ?? 0) === 0) return 0;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw AppError.conflict(
      'Fetch session byte accounting is unavailable',
      'ABDM_HIU_SESSION_BYTE_ACCOUNTING_UNAVAILABLE',
    );
  }
  return bytes;
}

function assertSessionObjectCapacity(session, incomingCount) {
  const nextCount = Number(session?.parts_received ?? 0) + Number(incomingCount);
  if (!Number.isSafeInteger(nextCount) || nextCount > MAX_HIU_SESSION_BUNDLES) {
    throw payloadTooLarge(
      'Fetch session exceeds the supported bundle count',
      'ABDM_HIU_SESSION_BUNDLE_LIMIT',
      { maximum: MAX_HIU_SESSION_BUNDLES },
    );
  }
  return nextCount;
}

function assertPreparedBundleCapacity(sessionBytes, preparedBundles) {
  let pageBytes = 0;
  for (const prepared of preparedBundles) {
    if (prepared.byteLength > MAX_HIU_BUNDLE_BYTES) {
      throw payloadTooLarge(
        'Decrypted FHIR bundle exceeds the supported size',
        'ABDM_HIU_BUNDLE_SIZE_LIMIT',
        { maximumBytes: MAX_HIU_BUNDLE_BYTES },
      );
    }
    pageBytes += prepared.byteLength;
  }
  if (!Number.isSafeInteger(pageBytes) || pageBytes > MAX_HIU_DATA_PUSH_BYTES) {
    throw payloadTooLarge(
      'Decrypted data-push page exceeds the supported byte limit',
      'ABDM_HIU_DATA_PUSH_SIZE_LIMIT',
      { maximumBytes: MAX_HIU_DATA_PUSH_BYTES },
    );
  }
  if (!Number.isSafeInteger(sessionBytes + pageBytes)
      || sessionBytes + pageBytes > MAX_HIU_SESSION_BYTES) {
    throw payloadTooLarge(
      'Fetch session exceeds the supported decrypted-byte limit',
      'ABDM_HIU_SESSION_BYTE_LIMIT',
      { maximumBytes: MAX_HIU_SESSION_BYTES },
    );
  }
  return { pageBytes, sessionBytesAfter: sessionBytes + pageBytes };
}

function assertReadableSessionAccounting(session) {
  const partsReceived = Number(session?.parts_received ?? 0);
  if (!Number.isSafeInteger(partsReceived) || partsReceived < 0
      || partsReceived > MAX_HIU_SESSION_BUNDLES) {
    throw AppError.conflict(
      'Fetch session bundle accounting is outside the supported limit',
      'ABDM_HIU_SESSION_BUNDLE_ACCOUNTING_INVALID',
    );
  }
  const bytes = sessionBundleBytes(session);
  if (bytes > MAX_HIU_SESSION_BYTES) {
    throw AppError.conflict(
      'Fetch session byte accounting is outside the supported limit',
      'ABDM_HIU_SESSION_BYTE_ACCOUNTING_INVALID',
    );
  }
  return bytes;
}

function bundleByteLength(row) {
  const bytes = Number(row?.metadata?.byte_length);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw AppError.conflict(
      'Received bundle byte accounting is unavailable',
      'ABDM_HIU_BUNDLE_BYTE_ACCOUNTING_UNAVAILABLE',
    );
  }
  if (bytes > MAX_HIU_BUNDLE_BYTES) {
    throw AppError.conflict(
      'Received bundle byte accounting exceeds the supported limit',
      'ABDM_HIU_BUNDLE_BYTE_ACCOUNTING_INVALID',
    );
  }
  return bytes;
}

function publicBundle(row) {
  if (!row) return null;
  const {
    bundle_storage_key: _storageKey,
    metadata: _metadata,
    ...rest
  } = row;
  return { ...rest, byte_length: bundleByteLength(row) };
}

function boundedListInteger(value, {
  name, fallback, minimum = 0, maximum = POSTGRES_INTEGER_MAX,
}) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw AppError.badRequest(
      `${name} must be an integer between ${minimum} and ${maximum}`,
      'ABDM_HIU_BUNDLE_PAGE_INVALID',
    );
  }
  return parsed;
}

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

function consentArtifactHipId({ artifact_hip_id: metadataHipId, artifact_signed_payload: stored } = {}) {
  const normalizedMetadataHipId = normalizeConsentText(metadataHipId);
  if (normalizedMetadataHipId) return normalizedMetadataHipId;
  let payload = stored;
  if (typeof payload?.raw === 'string') {
    try {
      payload = JSON.parse(payload.raw);
    } catch (_err) {
      return null;
    }
  }
  return normalizeConsentText(payload?.hip?.id);
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

async function deleteClaimStorageKeys(storageKeys, { sessionId = null } = {}) {
  const failed = [];
  for (const storageKey of [...new Set(storageKeys)]) {
    try {
      await deleteObject(storageKey);
    } catch (err) {
      failed.push(storageKey);
      logger.error('ABDM HIU orphan cleanup failed', {
        sessionId,
        storageKey,
        error: err.message,
      });
    }
  }
  return failed;
}

async function mergeClaimCleanupEvidence({
  tenantId, eventId, claimId, storageKeys, markFailed = false,
}) {
  if (!eventId || !claimId || storageKeys.length === 0) return;
  await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE abdm_webhook_events w
        SET status = CASE WHEN $5::boolean THEN 'failed' ELSE w.status END,
            processed_at = CASE WHEN $5::boolean THEN NOW() ELSE w.processed_at END,
            failure_reason = CASE
              WHEN $5::boolean THEN 'HIU claimant R2 cleanup pending'
              ELSE w.failure_reason
            END,
            metadata = jsonb_set(
              COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
                'hiu_claim_cleanup',
                COALESCE(w.metadata->'hiu_claim_cleanup', '{}'::jsonb)
              ),
              ARRAY['hiu_claim_cleanup', $4::text],
              (
                SELECT COALESCE(jsonb_agg(DISTINCT cleanup_key), '[]'::jsonb)
                  FROM (
                    SELECT jsonb_array_elements_text(
                      COALESCE(
                        w.metadata #> ARRAY['hiu_claim_cleanup', $4::text],
                        '[]'::jsonb
                      )
                    ) AS cleanup_key
                    UNION ALL
                    SELECT jsonb_array_elements_text($3::jsonb) AS cleanup_key
                  ) pending
              ),
              true
            )
      WHERE id = $1 AND tenant_id = $2::uuid
      RETURNING id`,
    Number(eventId), tenantId, JSON.stringify(storageKeys), claimId, markFailed,
  ));
}

async function persistOrphanCleanupEvidence(args) {
  await mergeClaimCleanupEvidence({ ...args, markFailed: true });
}

async function clearClaimCleanupEvidence({ tenantId, eventId, claimId }) {
  if (!eventId || !claimId) return;
  await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE abdm_webhook_events w
        SET metadata = jsonb_set(
          COALESCE(w.metadata, '{}'::jsonb),
          '{hiu_claim_cleanup}',
          COALESCE(w.metadata->'hiu_claim_cleanup', '{}'::jsonb) - $3::text,
          true
        )
      WHERE id = $1 AND tenant_id = $2::uuid
      RETURNING id`,
    Number(eventId), tenantId, claimId,
  ));
}

async function drainOrphanCleanupEvidence({ tenantId, event }) {
  if (!event?.id) {
    throw AppError.serviceUnavailable(
      'Prior HIU claimant object cleanup evidence is unavailable',
      'ABDM_HIU_ORPHAN_CLEANUP_PENDING',
    );
  }
  const currentEvents = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, metadata
       FROM abdm_webhook_events
      WHERE id = $1 AND tenant_id = $2::uuid
      FOR SHARE`,
    Number(event.id), tenantId,
  ));
  const currentEvent = currentEvents[0];
  if (!currentEvent) {
    throw AppError.serviceUnavailable(
      'Prior HIU claimant object cleanup evidence is unavailable',
      'ABDM_HIU_ORPHAN_CLEANUP_PENDING',
    );
  }
  const legacyKeys = Array.isArray(currentEvent.metadata?.hiu_orphan_storage_keys)
    ? currentEvent.metadata.hiu_orphan_storage_keys.filter(
      (key) => typeof key === 'string' && key,
    )
    : [];
  const claimEvidence = currentEvent.metadata?.hiu_claim_cleanup;
  const claimKeys = claimEvidence && typeof claimEvidence === 'object'
    ? Object.values(claimEvidence).flatMap((keys) => (
      Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key) : []
    ))
    : [];
  const storageKeys = [...new Set([...legacyKeys, ...claimKeys])];
  if (storageKeys.length === 0) return;
  const referencedRows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT bundle_storage_key
       FROM abdm_hiu_received_bundles
      WHERE tenant_id = $1::uuid AND bundle_storage_key = ANY($2::text[])`,
    tenantId, storageKeys,
  ));
  const referencedKeys = new Set(referencedRows.map((row) => row.bundle_storage_key));
  const orphanKeys = storageKeys.filter((key) => !referencedKeys.has(key));
  const failed = await deleteClaimStorageKeys(orphanKeys);
  if (failed.length > 0) {
    await persistOrphanCleanupEvidence({
      tenantId,
      eventId: currentEvent.id,
      claimId: 'retry',
      storageKeys: failed,
    });
    throw AppError.serviceUnavailable(
      'Prior HIU claimant object cleanup is still pending',
      'ABDM_HIU_ORPHAN_CLEANUP_PENDING',
    );
  }
  await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE abdm_webhook_events
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          - 'hiu_orphan_storage_keys' - 'hiu_claim_cleanup'
      WHERE id = $1 AND tenant_id = $2::uuid
      RETURNING id`,
    Number(currentEvent.id), tenantId,
  ));
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
        key_material_expires_at, status, initiated_by_uid, metadata)
     VALUES ($1::uuid, $2::text, $3::integer, $4::uuid, $5::text,
             $5::text, $6::text[], $7::timestamptz, $8::timestamptz, $9::text,
             $10::text, $11::text,
             NOW() + ($12::int * INTERVAL '1 minute'), 'requested', $13::uuid,
             jsonb_build_object('hiu_bundle_bytes_received', 0, 'hiu_limits_version', 1))
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
  tenantId = null, environment = 'sandbox', body = {}, rawBody = null,
  authenticatedHipId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const providerHipId = normalizeConsentText(authenticatedHipId);
  if (!providerHipId) {
    throw AppError.unauthorized(
      'Authenticated HIP identity is required for a data push',
      'ABDM_HIU_PROVIDER_IDENTITY_REQUIRED',
    );
  }
  const transactionId = String(body.transactionId || '').trim();
  if (!transactionId) {
    throw AppError.badRequest('Data push transactionId is required', 'ABDM_HIU_PUSH_SHAPE');
  }
  const pageNumber = Number(body.pageNumber ?? 1);
  const pageCount = Number(body.pageCount ?? 1);
  if (!Number.isSafeInteger(pageNumber) || !Number.isSafeInteger(pageCount)
      || pageNumber < 1 || pageCount < 1 || pageNumber > pageCount
      || pageNumber > POSTGRES_INTEGER_MAX || pageCount > POSTGRES_INTEGER_MAX
      || !Array.isArray(body.entries)) {
    throw AppError.badRequest('Data push page contract is invalid', 'ABDM_HIU_PAGE_INVALID');
  }
  if (body.entries.length > MAX_DATA_PUSH_ENTRIES_PER_PAGE) {
    throw payloadTooLarge(
      'Data push page exceeds the supported entry limit',
      'ABDM_HIU_PAGE_ENTRY_LIMIT',
      { maximum: MAX_DATA_PUSH_ENTRIES_PER_PAGE },
    );
  }
  if (pageCount > MAX_HIU_SESSION_PAGES) {
    throw payloadTooLarge(
      'Data push exceeds the supported page count',
      'ABDM_HIU_SESSION_PAGE_LIMIT',
      { maximum: MAX_HIU_SESSION_PAGES },
    );
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw AppError.badRequest('Exact data-push request bytes are required', 'ABDM_HIU_RAW_BODY_REQUIRED');
  }
  if (rawBody.length > MAX_HIU_DATA_PUSH_BYTES) {
    throw payloadTooLarge(
      'Data push request exceeds the supported byte limit',
      'ABDM_HIU_DATA_PUSH_SIZE_LIMIT',
      { maximumBytes: MAX_HIU_DATA_PUSH_BYTES },
    );
  }
  const payloadSha256 = crypto.createHash('sha256').update(rawBody).digest('hex');

  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: `${transactionId}:page:${pageNumber}`,
    eventType: 'hiu_data_push',
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: {
      transactionId,
      pageNumber,
      pageCount,
      payloadSha256,
      entryCount: body.entries.length,
      authenticatedHipId: providerHipId,
    },
    environment,
    retryFailed: true,
  });
  const ownsWebhookEvent = eventIntake.duplicate !== true;
  const claimId = crypto.randomUUID();
  let pageClaim = null;
  const uploadedStorageKeys = [];
  let commitStarted = false;
  try {
    pageClaim = await setTenantTx(tid, async (tx) => {
      const sessions = await tx.$queryRawUnsafe(
        `SELECT ${SESSION_RETURNING}, key_material_private_ciphertext, key_material_nonce,
                key_material_expires_at,
                (SELECT a.artifact_id FROM abdm_consent_artifacts a
                  WHERE a.id = s.consent_artifact_id AND a.tenant_id = $1::uuid) AS artifact_id,
                (SELECT NULLIF(BTRIM(a.metadata->>'hip_id'), '')
                   FROM abdm_consent_artifacts a
                  WHERE a.id = s.consent_artifact_id
                    AND a.tenant_id = $1::uuid
                    AND a.environment = $3::text) AS artifact_hip_id,
                (SELECT a.signed_payload
                   FROM abdm_consent_artifacts a
                  WHERE a.id = s.consent_artifact_id
                    AND a.tenant_id = $1::uuid
                    AND a.environment = $3::text) AS artifact_signed_payload
           FROM abdm_hiu_fetch_sessions s
          WHERE tenant_id = $1::uuid AND transaction_id = $2::text AND environment = $3::text
          LIMIT 1
          FOR UPDATE`,
        tid, transactionId, environment,
      );
      const session = sessions[0];
      if (!session) {
        throw AppError.notFound('No fetch session for this transaction', 'ABDM_HIU_SESSION_NOT_FOUND');
      }
      const consentHipId = consentArtifactHipId(session);
      if (!consentHipId || consentHipId !== providerHipId) {
        throw AppError.forbidden(
          'Authenticated HIP does not match the fetch consent',
          'ABDM_HIU_PROVIDER_IDENTITY_MISMATCH',
        );
      }
      const declaredHipId = normalizeConsentText(body?.hip?.id);
      if (declaredHipId && declaredHipId !== providerHipId) {
        throw AppError.forbidden(
          'Data push HIP identity does not match the authenticated provider',
          'ABDM_HIU_PROVIDER_IDENTITY_MISMATCH',
        );
      }

      const pageRows = await tx.$queryRawUnsafe(
        `SELECT id, page_number, page_count, payload_sha256, status, claim_id,
                claimed_at, parts_count
           FROM abdm_hiu_fetch_pages
          WHERE tenant_id = $1::uuid AND fetch_session_id = $2::integer
            AND page_number = $3::integer
          LIMIT 1
          FOR UPDATE`,
        tid, session.id, pageNumber,
      );
      const existingPage = pageRows[0] ?? null;
      if (existingPage && (
        Number(existingPage.page_count) !== pageCount
        || existingPage.payload_sha256 !== payloadSha256
      )) {
        throw AppError.conflict(
          'Data push page identity changed across retries',
          'ABDM_HIU_PAGE_IDENTITY_MISMATCH',
        );
      }
      if (existingPage?.status === 'completed') {
        return {
          session,
          page: existingPage,
          completed: true,
          cleanupPriorClaims: true,
        };
      }

      if (!LIVE_SESSION_STATUSES.includes(session.status)) {
        throw AppError.conflict('Fetch session is not receiving', 'ABDM_HIU_SESSION_NOT_LIVE');
      }
      const sessionBytesBefore = sessionBundleBytes(session);
      assertSessionObjectCapacity(session, body.entries.length);
      if (Number(session.next_page_number) !== pageNumber
          || (session.pages_expected != null && Number(session.pages_expected) !== pageCount)) {
        throw AppError.conflict('Data push page is out of order', 'ABDM_HIU_PAGE_OUT_OF_ORDER');
      }
      if (!body?.consent?.id || String(body.consent.id) !== String(session.artifact_id)) {
        throw AppError.forbidden('Data push consent does not match the fetch session', 'ABDM_HIU_CONSENT_MISMATCH');
      }
      const consentRows = await tx.$queryRawUnsafe(
        `SELECT 1 FROM abdm_consent_artifacts a
          JOIN abdm_consent_requests r
            ON r.id = a.consent_request_id AND r.tenant_id = $1::uuid
          JOIN users u
            ON u.uid = a.patient_uid AND u.tenant_id = $1::uuid
         WHERE a.id = $2::integer AND a.tenant_id = $1::uuid
           AND a.environment = $3::text AND r.environment = $3::text
           AND a.status = 'active' AND a.expiry_at > NOW()
           AND r.flow_kind = 'hiu' AND r.status = 'granted' AND r.expiry_at > NOW()
           AND r.patient_uid = a.patient_uid AND $4::uuid = a.patient_uid
           AND u.role = 'PATIENT' AND u.is_active = TRUE AND u.is_deleted = FALSE
           AND u.abha_verification_status = 'verified'
           AND LOWER(u.abha_address) = LOWER(r.metadata->>'abha_address')
         LIMIT 1`,
        tid, session.consent_artifact_id, environment, session.patient_uid,
      );
      if (!consentRows[0]) {
        throw AppError.forbidden('Fetch consent is inactive or unbound', 'ABDM_HIU_CONSENT_INACTIVE');
      }
      if (!session.key_material_private_ciphertext) {
        throw AppError.conflict('Fetch session key material is gone', 'ABDM_HIU_KEY_UNAVAILABLE');
      }
      if (session.key_material_expires_at
          && new Date(session.key_material_expires_at).getTime() < Date.now()) {
        throw AppError.conflict('Fetch session key material has expired', 'ABDM_HIU_KEY_EXPIRED');
      }

      let page;
      let cleanupPriorClaims = false;
      if (existingPage) {
        const freshClaim = existingPage.status === 'claimed'
          && new Date(existingPage.claimed_at).getTime()
            > Date.now() - PAGE_CLAIM_TTL_MINUTES * 60 * 1000;
        if (freshClaim) {
          throw AppError.conflict('Data push page is already being processed', 'ABDM_HIU_PAGE_IN_PROGRESS');
        }
        const reclaimed = await tx.$queryRawUnsafe(
          `UPDATE abdm_hiu_fetch_pages
              SET status = 'claimed', claim_id = $4::uuid, claimed_at = NOW(),
                  failure_reason = NULL, updated_at = NOW()
            WHERE id = $1::integer AND tenant_id = $2::uuid
              AND payload_sha256 = $3::char(64)
              AND status IN ('claimed', 'failed')
            RETURNING id, page_number, page_count, payload_sha256, status,
                      claim_id, claimed_at, parts_count`,
          existingPage.id, tid, payloadSha256, claimId,
        );
        page = reclaimed[0];
        cleanupPriorClaims = true;
      } else {
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO abdm_hiu_fetch_pages
             (tenant_id, fetch_session_id, page_number, page_count,
              payload_sha256, status, claim_id, claimed_at)
           VALUES ($1::uuid, $2::integer, $3::integer, $4::integer,
                   $5::char(64), 'claimed', $6::uuid, NOW())
           RETURNING id, page_number, page_count, payload_sha256, status,
                     claim_id, claimed_at, parts_count`,
          tid, session.id, pageNumber, pageCount, payloadSha256, claimId,
        );
        page = inserted[0];
      }
      if (!page) {
        throw AppError.conflict('Data push page claim was lost', 'ABDM_HIU_PAGE_CLAIM_LOST');
      }
      return {
        session,
        page,
        completed: false,
        cleanupPriorClaims,
        sessionBytesBefore,
      };
    });

    // Cleanup evidence belongs to a prior claimant. It is safe to drain only
    // after this transaction proves the page completed or atomically replaces
    // a stale/failed claim. A duplicate observing a fresh claim must not touch
    // that active claimant's R2 objects.
    if (pageClaim.cleanupPriorClaims) {
      await drainOrphanCleanupEvidence({ tenantId: tid, event: eventIntake.event });
    }

    if (pageClaim.completed) {
      if (ownsWebhookEvent) {
        await markWebhookProcessed({
          tenantId: tid, id: Number(eventIntake.event.id), status: 'processed',
        });
      }
      return {
        duplicate: true,
        transactionId,
        session: publicSession(pageClaim.session),
        stored: Number(pageClaim.page.parts_count),
        failed: 0,
      };
    }

    const session = pageClaim.session;

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

    const preparedBundles = [];
    const senderKeyMaterial = body.keyMaterial || null;
    for (let i = 0; i < body.entries.length; i += 1) {
      const entry = body.entries[i] || {};
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
      const storageKey = `abdm-hiu/${tid}/${session.id}/page-${pageNumber}/${payloadSha256}/claim-${claimId}/${i}-${sha256}.json`;
      preparedBundles.push({
        partNumber: i,
        careContextReference: String(entry.careContextReference).slice(0, 120),
        hiType: String(entry.hiType).slice(0, 60),
        storageKey,
        sha256,
        bytes,
        byteLength: bytes.length,
        mediaType: String(entry.media || 'application/fhir+json').slice(0, 60),
      });
    }
    assertPreparedBundleCapacity(
      pageClaim.sessionBytesBefore,
      preparedBundles,
    );
    await mergeClaimCleanupEvidence({
      tenantId: tid,
      eventId: eventIntake.event?.id,
      claimId,
      storageKeys: preparedBundles.map((prepared) => prepared.storageKey),
    });
    await setTenantTx(tid, async (tx) => {
      const activeClaimRows = await tx.$queryRawUnsafe(
        `SELECT p.id
           FROM abdm_hiu_fetch_pages p
          WHERE p.id = $1::integer AND p.tenant_id = $2::uuid
            AND p.status = 'claimed' AND p.claim_id = $3::uuid
            AND p.payload_sha256 = $4::char(64)
          FOR SHARE OF p`,
        pageClaim.page.id, tid, claimId, payloadSha256,
      );
      if (!activeClaimRows[0]) {
        throw AppError.conflict(
          'Data push page claim was lost before storage',
          'ABDM_HIU_PAGE_CLAIM_LOST',
        );
      }
      // The SHARE lock spans the R2 writes. A successor cannot replace this
      // claim (and drain its planned keys) until every possible upload has
      // materialized; a claimant paused before this fence cannot upload after
      // a successor takes over.
      for (const prepared of preparedBundles) {
        await uploadFileToR2(prepared.bytes, prepared.storageKey, 'application/fhir+json');
        uploadedStorageKeys.push(prepared.storageKey);
      }
    }, { timeout: BUNDLE_UPLOAD_CLAIM_TX_TIMEOUT_MS });

    commitStarted = true;
    const commitResult = await setTenantTx(tid, async (tx) => {
      const pageRows = await tx.$queryRawUnsafe(
        `SELECT id FROM abdm_hiu_fetch_pages
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND status = 'claimed' AND claim_id = $3::uuid
            AND payload_sha256 = $4::char(64) AND page_count = $5::integer
          FOR UPDATE`,
        pageClaim.page.id, tid, claimId, payloadSha256, pageCount,
      );
      if (!pageRows[0]) {
        throw AppError.conflict('Data push page claim was lost', 'ABDM_HIU_PAGE_CLAIM_LOST');
      }
      const lockedSessions = await tx.$queryRawUnsafe(
        `SELECT status, next_page_number, pages_expected, parts_received, metadata,
                key_material_expires_at
           FROM abdm_hiu_fetch_sessions
          WHERE id = $1::integer AND tenant_id = $2::uuid
          FOR UPDATE`,
        session.id, tid,
      );
      const lockedSession = lockedSessions[0];
      if (!lockedSession || !LIVE_SESSION_STATUSES.includes(lockedSession.status)
          || Number(lockedSession.next_page_number) !== pageNumber
          || (lockedSession.pages_expected != null
            && Number(lockedSession.pages_expected) !== pageCount)
          || (lockedSession.key_material_expires_at
            && new Date(lockedSession.key_material_expires_at).getTime() < Date.now())) {
        throw AppError.conflict('Data push page lost its ordering claim', 'ABDM_HIU_PAGE_OUT_OF_ORDER');
      }
      const lockedSessionBytes = sessionBundleBytes(lockedSession);
      assertSessionObjectCapacity(lockedSession, preparedBundles.length);
      const lockedCapacity = assertPreparedBundleCapacity(lockedSessionBytes, preparedBundles);

      // The consent was checked before decrypt/upload, but a signed revoke or
      // dataEraseAt may land while R2 is in flight. Re-lock the complete
      // binding immediately before the durable bundle references are written.
      // A concurrent revoke waits behind these SHARE locks; if it committed
      // first, this query returns no row and the catch path deletes the upload.
      const activeConsentRows = await tx.$queryRawUnsafe(
        `SELECT a.expiry_at AS artifact_expiry_at,
                r.expiry_at AS request_expiry_at
           FROM abdm_hiu_fetch_sessions s
           JOIN abdm_consent_artifacts a
             ON a.id = s.consent_artifact_id AND a.tenant_id = s.tenant_id
           JOIN abdm_consent_requests r
             ON r.id = a.consent_request_id AND r.tenant_id = s.tenant_id
           JOIN users u
             ON u.uid = s.patient_uid AND u.tenant_id = s.tenant_id
          WHERE s.id = $1::integer AND s.tenant_id = $2::uuid
            AND ${ACTIVE_HIU_CONSENT_CHAIN_PREDICATE}
          FOR SHARE OF a, r, u`,
        session.id, tid,
      );
      if (!activeConsentRows[0]) throw inactiveHiuConsentError();

      for (const prepared of preparedBundles) {
        await tx.$queryRawUnsafe(
          `INSERT INTO abdm_hiu_received_bundles
             (tenant_id, fetch_session_id, fetch_page_id, page_number,
              care_context_reference, hi_type, part_number, bundle_storage_key,
              bundle_sha256, checksum_verified, media_type, metadata)
           VALUES ($1::uuid, $2::integer, $3::integer, $4::integer,
                   $5::text, $6::text, $7::integer, $8::text,
                   $9::char(64), true, $10::text,
                   jsonb_build_object('byte_length', $11::integer))
           RETURNING id`,
          tid, session.id, pageClaim.page.id, pageNumber,
          prepared.careContextReference, prepared.hiType, prepared.partNumber,
          prepared.storageKey, prepared.sha256, prepared.mediaType, prepared.byteLength,
        );
      }

      const finalPage = pageNumber === pageCount;
      const rows = await tx.$queryRawUnsafe(
        `UPDATE abdm_hiu_fetch_sessions
            SET status = $3::text,
                parts_received = parts_received + $4::int,
                pages_expected = COALESCE(pages_expected, $5::int),
                next_page_number = next_page_number + 1,
                completed_at = CASE WHEN $6::boolean THEN NOW() ELSE completed_at END,
                key_material_private_ciphertext = CASE
                  WHEN $6::boolean THEN NULL ELSE key_material_private_ciphertext
                END,
                metadata = jsonb_set(
                  metadata,
                  '{hiu_bundle_bytes_received}',
                  to_jsonb($8::bigint),
                  true
                ),
                updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND next_page_number = $7::int
            AND (pages_expected IS NULL OR pages_expected = $5::int)
            AND status IN ('requested', 'acknowledged', 'receiving')
          RETURNING ${SESSION_RETURNING}`,
        session.id, tid, finalPage ? 'completed' : 'receiving',
        preparedBundles.length, pageCount, finalPage, pageNumber,
        lockedCapacity.sessionBytesAfter,
      );
      if (!rows[0]) {
        throw AppError.conflict('Data push page lost its ordering claim', 'ABDM_HIU_PAGE_OUT_OF_ORDER');
      }
      const completedPages = await tx.$queryRawUnsafe(
        `UPDATE abdm_hiu_fetch_pages
            SET status = 'completed', parts_count = $4::integer,
                completed_at = NOW(), failure_reason = NULL, updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND claim_id = $3::uuid AND status = 'claimed'
          RETURNING id`,
        pageClaim.page.id, tid, claimId, preparedBundles.length,
      );
      if (!completedPages[0]) {
        throw AppError.conflict('Data push page claim was lost', 'ABDM_HIU_PAGE_CLAIM_LOST');
      }
      return { session: rows[0], finalPage };
    });

    const updatedSession = commitResult.session;
    await clearClaimCleanupEvidence({
      tenantId: tid,
      eventId: eventIntake.event?.id,
      claimId,
    });
    if (commitResult.finalPage) {
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
    }

    await markWebhookProcessed({
      tenantId: tid, id: Number(eventIntake.event.id), status: 'processed',
    }).catch(() => {});
    logger.info('ABDM HIU data push handled', {
      sessionId: session.id, pageNumber, pageCount, stored: preparedBundles.length,
    });
    return {
      duplicate: false,
      transactionId,
      session: publicSession(updatedSession),
      stored: preparedBundles.length,
      failed: 0,
    };
  } catch (err) {
    let committedPage = null;
    let completionCheckSucceeded = false;
    if (commitStarted && pageClaim?.page?.id) {
      try {
        const completedRows = await prisma.$queryRawUnsafe(
          `SELECT p.parts_count,
                  COALESCE(
                    ARRAY_AGG(b.bundle_storage_key ORDER BY b.part_number)
                      FILTER (WHERE b.id IS NOT NULL),
                    ARRAY[]::varchar[]
                  ) AS referenced_storage_keys
             FROM abdm_hiu_fetch_pages p
             LEFT JOIN abdm_hiu_received_bundles b
               ON b.tenant_id = p.tenant_id
              AND b.fetch_session_id = p.fetch_session_id
              AND b.fetch_page_id = p.id
              AND b.page_number = p.page_number
            WHERE p.id = $1::integer AND p.tenant_id = $2::uuid
              AND p.payload_sha256 = $3::char(64) AND p.status = 'completed'
            GROUP BY p.id, p.parts_count
            LIMIT 1`,
          pageClaim.page.id, tid, payloadSha256,
        );
        completionCheckSucceeded = true;
        committedPage = completedRows[0] ?? null;
      } catch (checkErr) {
        logger.error('ABDM HIU page completion check failed; object cleanup deferred', {
          pageId: pageClaim.page.id, error: checkErr.message,
        });
      }
    }
    if (commitStarted && !completionCheckSucceeded) {
      await persistOrphanCleanupEvidence({
        tenantId: tid,
        eventId: eventIntake.event?.id,
        claimId,
        storageKeys: uploadedStorageKeys,
      });
      throw AppError.serviceUnavailable(
        'HIU claimant commit reconciliation is pending retry',
        'ABDM_HIU_ORPHAN_CLEANUP_PENDING',
      );
    }
    if (completionCheckSucceeded) {
      const referencedKeys = new Set(committedPage?.referenced_storage_keys ?? []);
      const staleClaimKeys = uploadedStorageKeys.filter((key) => !referencedKeys.has(key));
      const failedCleanupKeys = await deleteClaimStorageKeys(staleClaimKeys, {
        sessionId: pageClaim?.session?.id,
      });
      if (failedCleanupKeys.length > 0) {
        await persistOrphanCleanupEvidence({
          tenantId: tid,
          eventId: eventIntake.event?.id,
          claimId,
          storageKeys: failedCleanupKeys,
        });
        throw AppError.serviceUnavailable(
          'HIU claimant object cleanup is pending retry',
          'ABDM_HIU_ORPHAN_CLEANUP_PENDING',
        );
      }
      await clearClaimCleanupEvidence({
        tenantId: tid,
        eventId: eventIntake.event?.id,
        claimId,
      });
    }
    if (committedPage) {
      if (ownsWebhookEvent) {
        await markWebhookProcessed({
          tenantId: tid, id: Number(eventIntake.event.id), status: 'processed',
        }).catch(() => {});
      }
      return {
        duplicate: true,
        transactionId,
        session: publicSession(pageClaim.session),
        stored: Number(committedPage.parts_count),
        failed: 0,
      };
    }
    if (!commitStarted) {
      const failedCleanupKeys = await deleteClaimStorageKeys(uploadedStorageKeys, {
        sessionId: pageClaim?.session?.id,
      });
      if (failedCleanupKeys.length > 0) {
        await persistOrphanCleanupEvidence({
          tenantId: tid,
          eventId: eventIntake.event?.id,
          claimId,
          storageKeys: failedCleanupKeys,
        });
      } else {
        await clearClaimCleanupEvidence({
          tenantId: tid,
          eventId: eventIntake.event?.id,
          claimId,
        });
      }
    }
    if (pageClaim?.page?.id) {
      await prisma.$executeRawUnsafe(
        `UPDATE abdm_hiu_fetch_pages
            SET status = 'failed', failure_reason = $4::text, updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND claim_id = $3::uuid AND status = 'claimed'`,
        pageClaim.page.id, tid, claimId,
        String(err?.message || 'page processing failed').slice(0, 500),
      ).catch(() => {});
    }
    if (ownsWebhookEvent) await markWebhookFailed(tid, eventIntake.event, err);
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

async function lockActiveHiuSessionAccess(tx, tenantId, sessionId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT s.id, s.patient_uid, s.parts_received, s.metadata,
            a.expiry_at AS artifact_expiry_at,
            r.expiry_at AS request_expiry_at
       FROM abdm_hiu_fetch_sessions s
       JOIN abdm_consent_artifacts a
         ON a.id = s.consent_artifact_id AND a.tenant_id = s.tenant_id
       JOIN abdm_consent_requests r
         ON r.id = a.consent_request_id AND r.tenant_id = s.tenant_id
       JOIN users u
         ON u.uid = s.patient_uid AND u.tenant_id = s.tenant_id
      WHERE s.id = $1::integer AND s.tenant_id = $2::uuid
        AND ${ACTIVE_BUNDLE_CONSENT_PREDICATE}
      FOR SHARE OF s, a, r, u`,
    Number(sessionId), tenantId,
  );
  if (!rows[0]) throw inactiveHiuConsentError();
  assertBundleTimeWindow(rows[0]);
  assertReadableSessionAccounting(rows[0]);
  return rows[0];
}

export async function listReceivedBundles({
  tenantId = null, sessionId, limit = 50, offset = 0,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = boundedListInteger(limit, {
    name: 'limit', fallback: 50, minimum: 1, maximum: 100,
  });
  const safeOffset = boundedListInteger(offset, {
    name: 'offset', fallback: 0,
  });
  return setTenantTx(tid, async (tx) => {
    const access = await lockActiveHiuSessionAccess(tx, tid, sessionId);
    const totals = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS total
         FROM abdm_hiu_received_bundles b
        WHERE b.tenant_id = $1::uuid AND b.fetch_session_id = $2::integer`,
      tid, Number(sessionId),
    );
    const total = Number(totals[0]?.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_HIU_SESSION_BUNDLES) {
      throw AppError.conflict(
        'Fetch session bundle count is outside the supported limit',
        'ABDM_HIU_SESSION_BUNDLE_ACCOUNTING_INVALID',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${BUNDLE_SELECT} FROM abdm_hiu_received_bundles b
        WHERE b.tenant_id = $1::uuid AND b.fetch_session_id = $2::integer
        ORDER BY b.page_number ASC, b.part_number ASC, b.received_at ASC
        LIMIT $3::integer OFFSET $4::integer
        FOR SHARE OF b`,
      tid, Number(sessionId), safeLimit, safeOffset,
    );
    assertBundleTimeWindow(access);
    return {
      bundles: rows.map(publicBundle),
      count: rows.length,
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  });
}

/**
 * Stream one decrypted bundle back from R2 for transient rendering. The route
 * MUST logPhiAccess this read — it is PHI access, not a clinical write.
 */
export async function getReceivedBundleContent({ tenantId = null, sessionId, bundleId } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const access = await lockActiveHiuSessionAccess(tx, tid, sessionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${BUNDLE_SELECT} FROM abdm_hiu_received_bundles b
        WHERE b.id = $1::integer AND b.tenant_id = $2::uuid
          AND b.fetch_session_id = $3::integer
        LIMIT 1
        FOR SHARE OF b`,
      Number(bundleId), tid, Number(sessionId),
    );
    const row = rows[0];
    if (!row) {
      throw AppError.notFound('Received bundle not found', 'ABDM_HIU_BUNDLE_NOT_FOUND');
    }
    const declaredByteLength = bundleByteLength(row);

    // Keep the consent/request/session SHARE locks until the decrypted bytes
    // are ready. A revoke cannot commit underneath this read, and a purge
    // cannot delete the object before the read completes. dataEraseAt is a
    // clock boundary rather than a row mutation, so check it again after R2.
    const bytes = Buffer.from(await getFileFromR2(row.bundle_storage_key));
    assertBundleTimeWindow(access);
    if (bytes.length !== declaredByteLength || bytes.length > MAX_HIU_BUNDLE_BYTES) {
      throw AppError.conflict(
        'Received bundle bytes do not match durable accounting',
        'ABDM_HIU_BUNDLE_SIZE_MISMATCH',
      );
    }
    const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== row.bundle_sha256) {
      throw AppError.conflict(
        'Received bundle bytes failed integrity verification',
        'ABDM_HIU_BUNDLE_INTEGRITY_MISMATCH',
      );
    }
    let bundle;
    try {
      bundle = JSON.parse(bytes.toString('utf8'));
    } catch {
      bundle = bytes.toString('utf8');
    }
    return { bundle: publicBundle(row), content: bundle };
  }, { timeout: BUNDLE_READ_TX_TIMEOUT_MS });
}

/**
 * Delete R2 bundles whose consent chain is no longer readable. The reference
 * row is the durable retry ledger: it is removed only after the object delete
 * succeeds, so an R2 failure cannot orphan PHI without its cleanup pointer.
 */
export async function purgeInactiveHiuBundles({
  tenantId = null,
  limit = MAX_BUNDLE_PURGE_BATCH,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(
    Math.max(Number.parseInt(limit, 10) || MAX_BUNDLE_PURGE_BATCH, 1),
    1000,
  );
  const candidates = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT b.id, b.tenant_id
       FROM abdm_hiu_received_bundles b
       JOIN abdm_hiu_fetch_sessions s
         ON s.id = b.fetch_session_id AND s.tenant_id = b.tenant_id
       LEFT JOIN abdm_consent_artifacts a
         ON a.id = s.consent_artifact_id AND a.tenant_id = s.tenant_id
       LEFT JOIN abdm_consent_requests r
         ON r.id = a.consent_request_id AND r.tenant_id = s.tenant_id
       LEFT JOIN users u
         ON u.uid = s.patient_uid AND u.tenant_id = s.tenant_id
      WHERE b.tenant_id = $1::uuid
        AND (${ACTIVE_BUNDLE_CONSENT_PREDICATE}) IS NOT TRUE
      ORDER BY b.id ASC
      LIMIT $2::integer`,
    tid, safeLimit,
  ));

  let purged = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const deleted = await setTenantTx(tid, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT b.id, b.bundle_storage_key
             FROM abdm_hiu_received_bundles b
             JOIN abdm_hiu_fetch_sessions s
               ON s.id = b.fetch_session_id AND s.tenant_id = b.tenant_id
             LEFT JOIN abdm_consent_artifacts a
               ON a.id = s.consent_artifact_id AND a.tenant_id = s.tenant_id
             LEFT JOIN abdm_consent_requests r
               ON r.id = a.consent_request_id AND r.tenant_id = s.tenant_id
             LEFT JOIN users u
               ON u.uid = s.patient_uid AND u.tenant_id = s.tenant_id
            WHERE b.id = $1::integer AND b.tenant_id = $2::uuid
              AND (${ACTIVE_BUNDLE_CONSENT_PREDICATE}) IS NOT TRUE
            FOR UPDATE OF b`,
          Number(candidate.id), tid,
        );
        if (!rows[0]) return false;
        await deleteObject(rows[0].bundle_storage_key);
        const removed = await tx.$queryRawUnsafe(
          `DELETE FROM abdm_hiu_received_bundles
            WHERE id = $1::integer AND tenant_id = $2::uuid
            RETURNING id`,
          Number(candidate.id), tid,
        );
        return Boolean(removed[0]);
      }, { timeout: BUNDLE_PURGE_TX_TIMEOUT_MS });
      if (deleted) purged += 1;
    } catch (err) {
      errors += 1;
      logger.error('ABDM HIU bundle purge failed; durable reference retained for retry', {
        tenantId: tid,
        bundleId: candidate.id,
        error: err.message,
      });
    }
  }
  return { candidates: candidates.length, purged, errors };
}

/**
 * Tenant-scoped cron sweep: persist dataEraseAt expiry, expire unsafe live
 * sessions and keys, then erase decrypted bundles with durable retry semantics.
 */
export async function sweepExpiredHiuFetchSessions({ tenantId = null } = {}) {
  const tid = requireTenantId(tenantId);
  const state = await setTenantTx(tid, async (tx) => {
    const artifactsExpired = await tx.$queryRawUnsafe(
      `UPDATE abdm_consent_artifacts a
          SET status = 'expired', expired_at = clock_timestamp(), updated_at = NOW()
         FROM abdm_consent_requests r
        WHERE a.tenant_id = $1::uuid
          AND r.id = a.consent_request_id AND r.tenant_id = a.tenant_id
          AND r.flow_kind = 'hiu'
          AND a.status = 'active' AND a.expiry_at IS NOT NULL
          AND a.expiry_at <= clock_timestamp()
        RETURNING a.id`,
      tid,
    );
    const requestsExpired = await tx.$queryRawUnsafe(
      `UPDATE abdm_consent_requests
          SET status = 'expired', decided_at = clock_timestamp(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND flow_kind = 'hiu' AND status = 'granted'
          AND expiry_at IS NOT NULL AND expiry_at <= clock_timestamp()
        RETURNING id`,
      tid,
    );
    const expired = await tx.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions s
          SET status = 'expired', key_material_private_ciphertext = NULL,
              failure_reason = COALESCE(
                failure_reason,
                CASE
                  WHEN s.key_material_expires_at IS NOT NULL
                   AND s.key_material_expires_at <= clock_timestamp()
                    THEN 'key material expired before transfer'
                  ELSE 'consent inactive or data retention elapsed'
                END
              ),
              updated_at = NOW()
        WHERE s.tenant_id = $1::uuid
          AND s.status IN ('${LIVE_SESSION_STATUSES.join("', '")}')
          AND (
            (s.key_material_expires_at IS NOT NULL
              AND s.key_material_expires_at <= clock_timestamp())
            OR NOT EXISTS (
              SELECT 1
                FROM abdm_consent_artifacts a
                JOIN abdm_consent_requests r
                  ON r.id = a.consent_request_id AND r.tenant_id = a.tenant_id
                JOIN users u
                  ON u.uid = s.patient_uid AND u.tenant_id = s.tenant_id
               WHERE a.id = s.consent_artifact_id AND a.tenant_id = s.tenant_id
                 AND ${ACTIVE_HIU_CONSENT_CHAIN_PREDICATE}
            )
          )
        RETURNING s.id`,
      tid,
    );
    const scrubbed = await tx.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET key_material_private_ciphertext = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND status IN ('completed', 'partial', 'failed', 'expired')
          AND key_material_private_ciphertext IS NOT NULL
        RETURNING id`,
      tid,
    );
    return {
      artifactsExpired: artifactsExpired.length,
      requestsExpired: requestsExpired.length,
      expired: expired.length,
      keysScrubbed: scrubbed.length,
    };
  });
  const cleanup = await purgeInactiveHiuBundles({ tenantId: tid });
  if (state.expired > 0 || state.keysScrubbed > 0 || state.artifactsExpired > 0
      || state.requestsExpired > 0 || cleanup.purged > 0 || cleanup.errors > 0) {
    logger.info('ABDM HIU retention sweep complete', {
      tenantId: tid,
      ...state,
      bundlesPurged: cleanup.purged,
      cleanupErrors: cleanup.errors,
    });
  }
  return {
    ...state,
    bundlesPurged: cleanup.purged,
    cleanupErrors: cleanup.errors,
  };
}

export const __testing__ = Object.freeze({
  MAX_HIU_SESSION_PAGES,
  MAX_HIU_SESSION_BUNDLES,
  MAX_HIU_DATA_PUSH_BYTES,
  MAX_HIU_BUNDLE_BYTES,
  MAX_HIU_SESSION_BYTES,
  assertPreparedBundleCapacity,
  persistOrphanCleanupEvidence,
  drainOrphanCleanupEvidence,
});

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
  purgeInactiveHiuBundles,
  sweepExpiredHiuFetchSessions,
  __testing__,
};
