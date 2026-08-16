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
import { uploadFileToR2, getFileFromR2 } from '../../utils/r2Storage.js';
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
  parts_received, initiated_by_uid, requested_at, acknowledged_at,
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
  if (!Array.isArray(hiTypes) || hiTypes.length === 0) {
    throw AppError.badRequest('At least one hiType is required', 'MISSING_HI_TYPES');
  }
  if (!dataFrom || !dataTo) {
    throw AppError.badRequest('dataFrom and dataTo are required', 'MISSING_DATE_RANGE');
  }

  const requestId = crypto.randomUUID();
  const row = await createConsentRequest({
    tenantId: tid,
    requestId,
    flowKind: 'hiu',
    abhaId: null,
    patientUid,
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
  });
  if (eventIntake.duplicate) {
    return { duplicate: true };
  }

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
  await markWebhookProcessed({ tenantId: tid, id: Number(eventIntake.event.id), status: 'processed' })
    .catch(() => {});
  return { duplicate: false, cmConsentRequestId };
}

/**
 * CM consent notification for the HIU (GRANTED / DENIED / REVOKED / EXPIRED).
 * Artefact signatures are verified through the EXISTING
 * abdmService._verifyConsentArtefact machinery when a signed detail rides the
 * notification (enforcement itself is operator-gated by
 * ABDM_VERIFY_CONSENT_ARTEFACT, same as the HIP side).
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
  });
  if (eventIntake.duplicate) {
    return { duplicate: true };
  }

  // Locate our request row by our request_id OR the CM id recorded on-init.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, hi_types, patient_uid, data_from, data_to, expiry_at
       FROM abdm_consent_requests
      WHERE tenant_id = $1::uuid AND environment = $2::text
        AND (request_id = $3::text OR metadata->>'cm_consent_request_id' = $3::text)
      LIMIT 1`,
    tid, environment, cmConsentRequestId,
  );
  const requestRow = rows[0] || null;

  const STATUS_MAP = {
    GRANTED: 'granted', DENIED: 'denied', REVOKED: 'revoked', EXPIRED: 'expired',
  };
  const nextStatus = STATUS_MAP[status];
  if (requestRow && nextStatus && requestRow.status === 'requested') {
    await transitionConsentRequest({ tenantId: tid, id: requestRow.id, nextStatus });
  } else if (requestRow && nextStatus === 'revoked' && requestRow.status === 'granted') {
    await transitionConsentRequest({ tenantId: tid, id: requestRow.id, nextStatus });
  }

  const artifacts = [];
  if (status === 'GRANTED') {
    const entries = Array.isArray(notification.consentArtefacts)
      ? notification.consentArtefacts : [];
    for (const entry of entries) {
      const artifactId = String(entry?.id || '').trim();
      if (!artifactId) continue;
      const detail = entry.consentDetail || entry.consentArtefact || null;
      const signature = entry.signature || body.signature || null;
      let signedPayload = {};
      if (detail) {
        // Throws when verification is enabled and the signature is bad/missing;
        // returns null when the operator has not enabled verification.
        abdmService._verifyConsentArtefact({
          consentRequestId: cmConsentRequestId,
          consentArtefact: detail,
          signature,
        });
        signedPayload = typeof detail === 'string' ? { raw: detail } : detail;
      }
      try {
        const artifact = await recordConsentArtifact({
          tenantId: tid,
          consentRequestId: requestRow?.id ?? null,
          artifactId,
          patientUid: requestRow?.patient_uid ?? null,
          hiTypes: requestRow?.hi_types ?? [],
          permissionKind: 'view',
          dataFrom: requestRow?.data_from ?? null,
          dataTo: requestRow?.data_to ?? null,
          expiryAt: requestRow?.expiry_at ?? null,
          signedPayload,
          environment,
          metadata: { source: 'hiu_consent_notify' },
        });
        artifacts.push(artifact);
      } catch (err) {
        if (err.statusCode === 409) continue; // artefact replay — already recorded
        throw err;
      }
    }
  }

  await markWebhookProcessed({
    tenantId: tid,
    id: Number(eventIntake.event.id),
    status: 'processed',
    relatedRequestId: requestRow?.id ?? null,
  }).catch(() => {});
  return { duplicate: false, status, artifacts: artifacts.length };
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
    `SELECT id, artifact_id, patient_uid, hi_types, data_from, data_to, status
       FROM abdm_consent_artifacts
      WHERE id = $1::integer AND tenant_id = $2::uuid LIMIT 1`,
    artId, tid,
  );
  const artifact = artifacts[0];
  if (!artifact) {
    throw AppError.notFound('Consent artifact not found', 'ABDM_ARTIFACT_NOT_FOUND');
  }
  if (artifact.status !== 'active') {
    throw AppError.conflict('Consent artifact is not active', 'ABDM_ARTIFACT_INACTIVE');
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
  });
  if (eventIntake.duplicate) return { duplicate: true };

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
  await markWebhookProcessed({ tenantId: tid, id: Number(eventIntake.event.id), status: 'processed' })
    .catch(() => {});
  return { duplicate: false };
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

  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: `${transactionId}:page:${pageNumber}`,
    eventType: 'hiu_data_push',
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: { transactionId, pageNumber, pageCount, entryCount: (body.entries || []).length },
    environment,
  });
  if (eventIntake.duplicate) {
    return { duplicate: true, transactionId };
  }

  const sessions = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING}, key_material_private_ciphertext, key_material_nonce
       FROM abdm_hiu_fetch_sessions
      WHERE tenant_id = $1::uuid AND transaction_id = $2::text AND environment = $3::text
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

  const entries = Array.isArray(body.entries) ? body.entries : [];
  const senderKeyMaterial = body.keyMaterial || null;
  let stored = 0;
  let failed = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] || {};
    const partNumber = (pageNumber - 1) * 1000 + i;
    if (!entry.content) {
      // Link-style entries (deferred fetch) are out of the thin-leg scope.
      failed += 1;
      continue;
    }
    try {
      const checksumOk = !entry.checksum
        || crypto.createHash('md5').update(String(entry.content)).digest('hex') === String(entry.checksum);
      if (!checksumOk) {
        failed += 1;
        logger.warn('ABDM HIU entry checksum mismatch — part rejected', {
          sessionId: session.id, partNumber,
        });
        continue;
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
      const storageKey = `abdm-hiu/${tid}/${session.id}/${partNumber}.json`;
      await uploadFileToR2(bytes, storageKey, 'application/fhir+json');
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
      if (insertedBundle[0]) stored += 1;
    } catch (err) {
      failed += 1;
      logger.warn('ABDM HIU entry could not be decrypted/stored — part rejected', {
        sessionId: session.id, partNumber, code: err.code, error: err.message,
      });
    }
  }

  const finalPage = pageNumber >= pageCount;
  let updatedSession;
  if (finalPage) {
    const anyFailed = failed > 0;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = $3::text, parts_received = parts_received + $4::int,
              parts_expected = COALESCE(parts_expected, $5::int),
              completed_at = NOW(),
              key_material_private_ciphertext = NULL,
              updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid
        RETURNING ${SESSION_RETURNING}`,
      session.id, tid, anyFailed ? 'partial' : 'completed', stored, pageCount,
    );
    updatedSession = rows[0];
    if (session.data_transfer_id) {
      await transitionDataTransfer({
        tenantId: tid,
        id: session.data_transfer_id,
        nextStatus: anyFailed ? 'partial' : 'succeeded',
        attemptIncrement: true,
      }).catch(() => {});
    }
    // Best-effort HIU-side transfer notification.
    try {
      await abdmGateway.notifyHiuHealthInfoStatus({
        transactionId,
        consentId: body?.consent?.id || null,
        sessionStatus: anyFailed ? 'FAILED' : 'TRANSFERRED',
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
              parts_expected = COALESCE(parts_expected, $4::int), updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid
        RETURNING ${SESSION_RETURNING}`,
      session.id, tid, stored, pageCount,
    );
    updatedSession = rows[0];
  }

  await markWebhookProcessed({ tenantId: tid, id: Number(eventIntake.event.id), status: 'processed' })
    .catch(() => {});
  logger.info('ABDM HIU data push handled', {
    sessionId: session.id, pageNumber, pageCount, stored, failed,
  });
  return {
    duplicate: false,
    transactionId,
    session: publicSession(updatedSession),
    stored,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Reads + sweep
// ---------------------------------------------------------------------------

export async function listFetchSessions({ tenantId = null, status = null, limit = 50 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING} FROM abdm_hiu_fetch_sessions
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR status = $2::text)
      ORDER BY requested_at DESC LIMIT $3::int`,
    tid, status ? String(status).trim().toLowerCase() : null, safeLimit,
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
