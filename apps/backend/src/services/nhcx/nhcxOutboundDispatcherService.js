// src/services/nhcx/nhcxOutboundDispatcherService.js
//
// Durable outbound dispatcher for NL-2 P1 NHCX messages. It keeps the local
// workflow spine in insurance_policies / insurance_preauth, and treats
// nhcx_messages as the exchange envelope plus retry state.

import crypto from 'node:crypto';
import { CompactEncrypt, importJWK, importSPKI } from 'jose';

import { NHCX_CONFIG } from '../../config/nhcxConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { safeFetch } from '../../utils/ssrfGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  buildClaimRequestBundle,
  buildClaimStatusTaskBundle,
  buildCommunicationResponseBundle,
  buildCoverageEligibilityRequestBundle,
  buildPreauthClaimRequestBundle,
  persistOutboundNHCXEnvelope,
} from './nhcxFhirProfileService.js';
import { loadNHCXRuntimeConfig } from './nhcxTenantConfigService.js';
import { submitClaim } from '../insurance/claimsService.js';
import { createOutboundCommunicationResponse } from './nhcxCommunicationService.js';

export const NHCX_RETRY_LIMIT = 7;
export const NHCX_BACKOFF_SECONDS = [30, 120, 600, 1_800, 3_600, 14_400, 28_800];
export const NHCX_OUTBOUND_STATUSES = ['pending', 'sent', 'accepted', 'failed', 'dead', 'rejected'];

const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_EXCERPT_MAX = 2_000;

function clean(value) {
  return String(value ?? '').trim();
}

function safeText(value, max = 1_000) {
  const text = clean(value);
  return text ? text.slice(0, max) : null;
}

function normalizePositiveInt(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function clampBatchSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH;
  return Math.min(Math.max(parsed, 1), MAX_BATCH);
}

function isNHCXGloballyEnabled() {
  return String(process.env.NHCX_ENABLED || '').toLowerCase() === 'true' || NHCX_CONFIG.enabled === true;
}

function assertNHCXGloballyEnabled({ allowDisabled = false } = {}) {
  if (!allowDisabled && !isNHCXGloballyEnabled()) {
    throw AppError.forbidden('NHCX is disabled', 'NHCX_DISABLED');
  }
}

function ensureRuntimeReady(runtime, { allowDisabled = false } = {}) {
  if (!runtime) throw AppError.badRequest('NHCX runtime config is required', 'NHCX_RUNTIME_CONFIG_REQUIRED');
  const enabled = runtime.effectiveEnabled === true || (isNHCXGloballyEnabled() && runtime.enabled === true);
  if (!allowDisabled && !enabled) {
    throw AppError.forbidden('NHCX is disabled for this tenant', 'NHCX_DISABLED');
  }
  const missing = Array.isArray(runtime.missing) ? runtime.missing.filter(Boolean) : [];
  if (missing.length > 0) {
    throw AppError.badRequest('NHCX tenant configuration is incomplete', 'NHCX_CONFIG_INCOMPLETE', { missing });
  }
  if (!runtime.gatewayBaseUrl) {
    throw AppError.badRequest('NHCX gateway URL is missing', 'NHCX_GATEWAY_URL_MISSING');
  }
  return runtime;
}

function backoffSecondsForAttempt(attemptNumber) {
  const idx = Math.max(0, Math.min(Number(attemptNumber) || 0, NHCX_BACKOFF_SECONDS.length - 1));
  return NHCX_BACKOFF_SECONDS[idx];
}

function computeNextRetryAt(attemptNumber) {
  return new Date(Date.now() + backoffSecondsForAttempt(attemptNumber) * 1000);
}

function isRetryable(httpStatus) {
  if (httpStatus == null) return true;
  if (httpStatus >= 500 && httpStatus < 600) return true;
  return httpStatus === 408 || httpStatus === 425 || httpStatus === 429;
}

function generateHcxId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hcxHeaders({
  hcxApiCallId,
  hcxCorrelationId,
  hcxWorkflowId = null,
  participantCodeSelf,
  participantCodeCounterparty,
}) {
  return Object.fromEntries(Object.entries({
    'x-hcx-api_call_id': hcxApiCallId,
    'x-hcx-correlation_id': hcxCorrelationId,
    'x-hcx-workflow_id': hcxWorkflowId,
    sender_code: participantCodeSelf,
    recipient_code: participantCodeCounterparty,
  }).filter(([, value]) => clean(value)));
}

function endpointUrl(gatewayBaseUrl, endpoint) {
  const base = clean(gatewayBaseUrl);
  const url = new URL(base.endsWith('/') ? base : `${base}/`);
  return new URL(clean(endpoint).replace(/^\/+/, ''), url).toString();
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readResponseExcerpt(response) {
  try {
    const text = await response.text();
    return text ? text.slice(0, RESPONSE_EXCERPT_MAX) : null;
  } catch {
    return null;
  }
}

function responseValue(body, ...keys) {
  if (!body || typeof body !== 'object') return null;
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

function extractGatewayStatus(response, body) {
  return safeText(
    response?.headers?.get?.('x-hcx-status')
      || responseValue(body, 'hcx_status', 'status', 'code')
      || (response?.status ? `HTTP_${response.status}` : null),
    80,
  );
}

function extractGatewayReference(response, body) {
  return safeText(
    response?.headers?.get?.('x-hcx-reference-id')
      || response?.headers?.get?.('x-hcx-api_call_id')
      || responseValue(body, 'reference_id', 'transaction_id', 'api_call_id', 'hcx_api_call_id'),
    120,
  );
}

async function defaultJweKeyResolver(runtime) {
  const material = clean(runtime?.credentials?.jwePrivateKey);
  if (!material) {
    throw AppError.badRequest('NHCX JWE key material is missing', 'NHCX_JWE_KEY_MISSING');
  }

  if (material.startsWith('{')) {
    const jwk = JSON.parse(material);
    const alg = jwk.alg || (jwk.kty === 'oct' ? 'dir' : 'RSA-OAEP-256');
    return {
      key: await importJWK(jwk, alg === 'dir' ? 'A256GCM' : alg),
      alg,
      enc: jwk.enc || 'A256GCM',
      keyId: jwk.kid || null,
    };
  }

  if (material.includes('BEGIN PUBLIC KEY')) {
    return {
      key: await importSPKI(material, 'RSA-OAEP-256'),
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      keyId: null,
    };
  }

  // P1 is mock-first until the live NHCX registry/certificate contract is
  // locked. A high-entropy tenant secret still produces a standards-compliant
  // compact JWE using direct AES-GCM encryption; operators must replace this
  // with registry public-key material before live gateway certification.
  return {
    key: crypto.createHash('sha256').update(material).digest(),
    alg: 'dir',
    enc: 'A256GCM',
    keyId: 'tenant-secret-sha256',
  };
}

async function encryptBundleAsJWE({
  bundle,
  protectedHeaders,
  runtime,
  jweKeyResolver = defaultJweKeyResolver,
}) {
  const resolved = await jweKeyResolver(runtime);
  const body = new TextEncoder().encode(JSON.stringify(bundle));
  const headers = {
    alg: resolved.alg,
    enc: resolved.enc || 'A256GCM',
    typ: 'JWE',
    cty: 'application/fhir+json',
    ...protectedHeaders,
  };
  if (resolved.keyId) headers.kid = resolved.keyId;
  const ciphertext = await new CompactEncrypt(body).setProtectedHeader(headers).encrypt(resolved.key);
  return {
    ciphertext,
    registryKeyId: resolved.keyId || null,
    protectedHeaders: headers,
  };
}

function runtimeLoader(runtimeResolver) {
  return runtimeResolver || ((tenantId) => loadNHCXRuntimeConfig(tenantId));
}

async function loadRuntimeForTenant(tenantId, options) {
  const runtime = await runtimeLoader(options.runtimeResolver)(tenantId);
  return ensureRuntimeReady(runtime, options);
}

export async function enqueueCoverageEligibilityCheck({
  tenantId,
  policyId,
  admissionId = null,
  hcxApiCallId = generateHcxId('eligibility'),
  hcxCorrelationId = generateHcxId('corr'),
  hcxWorkflowId = null,
  runtimeResolver = null,
  allowDisabled = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  assertNHCXGloballyEnabled({ allowDisabled });
  const runtime = await loadRuntimeForTenant(tid, { runtimeResolver, allowDisabled });
  const built = await buildCoverageEligibilityRequestBundle({
    tenantId: tid,
    policyId,
    admissionId,
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
  });
  const workflowId = hcxWorkflowId || (built.admissionId ? String(built.admissionId) : `policy-${built.policyId}`);
  return persistOutboundNHCXEnvelope({
    tenantId: tid,
    environment: runtime.environment,
    cycle: 'eligibility',
    endpoint: 'coverageeligibility/check',
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
    hcxApiCallId,
    hcxCorrelationId,
    hcxWorkflowId: workflowId,
    policyId: built.policyId,
    patientUid: built.patientUid,
    admissionId: built.admissionId,
    domainResourceType: built.domainResourceType,
    profileUrl: built.profileUrl,
    profileVersion: built.profileVersion,
    bundle: built.bundle,
  });
}

export async function enqueuePreauthSubmit({
  tenantId,
  preauthId,
  hcxApiCallId = generateHcxId('preauth'),
  hcxCorrelationId = generateHcxId('corr'),
  hcxWorkflowId = null,
  runtimeResolver = null,
  allowDisabled = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  assertNHCXGloballyEnabled({ allowDisabled });
  const runtime = await loadRuntimeForTenant(tid, { runtimeResolver, allowDisabled });
  const built = await buildPreauthClaimRequestBundle({
    tenantId: tid,
    preauthId,
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
  });
  return persistOutboundNHCXEnvelope({
    tenantId: tid,
    environment: runtime.environment,
    cycle: 'preauth',
    endpoint: 'preauth/submit',
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
    hcxApiCallId,
    hcxCorrelationId,
    hcxWorkflowId: hcxWorkflowId || built.workflowId,
    preauthId: built.preauthId,
    policyId: built.policyId,
    patientUid: built.patientUid,
    admissionId: built.admissionId,
    domainResourceType: built.domainResourceType,
    profileUrl: built.profileUrl,
    profileVersion: built.profileVersion,
    bundle: built.bundle,
  });
}

export async function enqueueClaimSubmit({
  tenantId,
  claimId,
  documentIds = null,
  submittedBy = null,
  hcxApiCallId = generateHcxId('claim'),
  hcxCorrelationId = generateHcxId('corr'),
  hcxWorkflowId = null,
  runtimeResolver = null,
  allowDisabled = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeClaimId = normalizePositiveInt(claimId, 'claimId');
  assertNHCXGloballyEnabled({ allowDisabled });
  const runtime = await loadRuntimeForTenant(tid, { runtimeResolver, allowDisabled });

  // Strict profile check before the workflow mutation, then the existing
  // claimsService submit path enforces packet, state, invoice, and discharge
  // gates. The post-submit rebuild captures any standard docs that submitClaim
  // auto-assembled before the envelope is queued.
  await buildClaimRequestBundle({
    tenantId: tid,
    claimId: safeClaimId,
    documentIds,
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
  });
  await submitClaim({
    tenantId: tid,
    id: safeClaimId,
    submitted_by: submittedBy,
    submission_channel: 'nhcx',
  });
  const built = await buildClaimRequestBundle({
    tenantId: tid,
    claimId: safeClaimId,
    documentIds,
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
  });
  return persistOutboundNHCXEnvelope({
    tenantId: tid,
    environment: runtime.environment,
    cycle: 'claim',
    endpoint: 'claim/submit',
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
    hcxApiCallId,
    hcxCorrelationId,
    hcxWorkflowId: hcxWorkflowId || built.workflowId,
    claimId: built.claimId,
    preauthId: built.preauthId,
    policyId: built.policyId,
    patientUid: built.patientUid,
    admissionId: built.admissionId,
    domainResourceType: built.domainResourceType,
    profileUrl: built.profileUrl,
    profileVersion: built.profileVersion,
    bundle: built.bundle,
  });
}

export async function enqueueClaimStatusCheck({
  tenantId,
  claimId,
  hcxApiCallId = generateHcxId('claim-status'),
  hcxCorrelationId = generateHcxId('corr'),
  hcxWorkflowId = null,
  runtimeResolver = null,
  allowDisabled = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeClaimId = normalizePositiveInt(claimId, 'claimId');
  assertNHCXGloballyEnabled({ allowDisabled });
  const runtime = await loadRuntimeForTenant(tid, { runtimeResolver, allowDisabled });
  const built = await buildClaimStatusTaskBundle({
    tenantId: tid,
    claimId: safeClaimId,
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
  });
  return persistOutboundNHCXEnvelope({
    tenantId: tid,
    environment: runtime.environment,
    cycle: 'task',
    endpoint: 'claim/status',
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
    hcxApiCallId,
    hcxCorrelationId,
    hcxWorkflowId: hcxWorkflowId || built.workflowId,
    claimId: built.claimId,
    preauthId: built.preauthId,
    policyId: built.policyId,
    patientUid: built.patientUid,
    admissionId: built.admissionId,
    domainResourceType: built.domainResourceType,
    profileUrl: built.profileUrl,
    profileVersion: built.profileVersion,
    bundle: built.bundle,
  });
}

export async function enqueueCommunicationResponse({
  tenantId,
  inboundCorrespondenceId,
  responseText,
  documentIds = [],
  recordedBy = null,
  hcxApiCallId = null,
  hcxCorrelationId = null,
  hcxWorkflowId = null,
  runtimeResolver = null,
  allowDisabled = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  assertNHCXGloballyEnabled({ allowDisabled });
  const runtime = await loadRuntimeForTenant(tid, { runtimeResolver, allowDisabled });

  const response = await createOutboundCommunicationResponse({
    tenantId: tid,
    inboundCorrespondenceId,
    responseText,
    documentIds,
    recordedBy,
    hcxApiCallId: hcxApiCallId || generateHcxId('communication'),
    hcxCorrelationId,
    hcxWorkflowId,
  });
  const built = await buildCommunicationResponseBundle({
    tenantId: tid,
    hcxApiCallId: response.hcx.apiCallId,
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
  });
  const queued = await persistOutboundNHCXEnvelope({
    tenantId: tid,
    environment: runtime.environment,
    cycle: 'communication',
    endpoint: 'communication/request',
    participantCodeSelf: runtime.participantCode,
    participantCodeCounterparty: runtime.counterpartyParticipantCode,
    hcxApiCallId: response.hcx.apiCallId,
    hcxCorrelationId: response.hcx.correlationId,
    hcxWorkflowId: response.hcx.workflowId || built.workflowId,
    claimId: built.claimId,
    preauthId: built.preauthId,
    policyId: built.policyId,
    patientUid: built.patientUid,
    admissionId: built.admissionId,
    domainResourceType: built.domainResourceType,
    profileUrl: built.profileUrl,
    profileVersion: built.profileVersion,
    bundle: built.bundle,
  });
  return {
    ...queued,
    correspondence: response.correspondence,
    documentIds: built.documentIds,
  };
}

async function buildCurrentBundleForEnvelope(row, runtime) {
  const participantCodeSelf = row.participant_code_self || runtime.participantCode;
  const participantCodeCounterparty = row.participant_code_counterparty || runtime.counterpartyParticipantCode;

  if (row.cycle === 'eligibility' && row.endpoint === 'coverageeligibility/check') {
    return buildCoverageEligibilityRequestBundle({
      tenantId: row.tenant_id,
      policyId: row.policy_id,
      admissionId: row.admission_id || null,
      participantCodeSelf,
      participantCodeCounterparty,
    });
  }
  if (row.cycle === 'preauth' && row.endpoint === 'preauth/submit') {
    return buildPreauthClaimRequestBundle({
      tenantId: row.tenant_id,
      preauthId: row.preauth_id,
      participantCodeSelf,
      participantCodeCounterparty,
    });
  }
  if (row.cycle === 'claim' && row.endpoint === 'claim/submit') {
    return buildClaimRequestBundle({
      tenantId: row.tenant_id,
      claimId: row.claim_id,
      participantCodeSelf,
      participantCodeCounterparty,
    });
  }
  if (row.cycle === 'task' && row.endpoint === 'claim/status') {
    return buildClaimStatusTaskBundle({
      tenantId: row.tenant_id,
      claimId: row.claim_id,
      participantCodeSelf,
      participantCodeCounterparty,
    });
  }
  if (row.cycle === 'communication' && row.endpoint === 'communication/request') {
    // Version-lock banner: live NHCX may split request/response actions or
    // require binary packaging changes. P3 remains inert/mock-first until the
    // live gateway contract is locked.
    return buildCommunicationResponseBundle({
      tenantId: row.tenant_id,
      hcxApiCallId: row.hcx_api_call_id,
      participantCodeSelf,
      participantCodeCounterparty,
    });
  }
  throw AppError.badRequest(
    `Unsupported NHCX outbound envelope ${row.cycle}/${row.endpoint}`,
    'NHCX_OUTBOUND_UNSUPPORTED',
  );
}

async function prepareEnvelopeForDispatch(row, built, encrypted) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET payload_hash = $2,
            payload_ciphertext = $3,
            protected_headers = $4::jsonb,
            registry_key_id = COALESCE($5, registry_key_id),
            profile_url = $6,
            profile_version = $7,
            domain_resource_type = $8,
            validation_issues = '[]'::jsonb,
            updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING *`,
    String(row.id),
    built.payloadHash,
    encrypted.ciphertext,
    JSON.stringify(encrypted.protectedHeaders),
    encrypted.registryKeyId,
    built.profileUrl,
    built.profileVersion,
    built.domainResourceType,
  );
  return rows[0] || row;
}

async function markAccepted(row, {
  gatewayStatus,
  gatewayReference,
  responseExcerpt,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = 'accepted',
            hcx_status = COALESCE($2, hcx_status),
            last_error = NULL,
            next_retry_at = NULL,
            sent_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING *`,
    String(row.id),
    gatewayStatus || gatewayReference || responseExcerpt || 'accepted',
  );
  return rows[0] || null;
}

async function markFailed(row, {
  httpStatus = null,
  responseExcerpt = null,
  errorMessage = null,
} = {}) {
  const attemptCount = Number(row.attempt_count || 1);
  const retryable = isRetryable(httpStatus) && attemptCount < NHCX_RETRY_LIMIT;
  const status = retryable ? 'failed' : (httpStatus && httpStatus >= 400 && httpStatus < 500 ? 'rejected' : 'dead');
  const nextRetryAt = retryable ? computeNextRetryAt(attemptCount - 1) : null;
  const detail = [
    httpStatus ? `HTTP ${httpStatus}` : null,
    errorMessage,
    responseExcerpt,
  ].filter(Boolean).join(' | ');

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = $2,
            hcx_status = COALESCE($3, hcx_status),
            last_error = $4,
            next_retry_at = $5,
            updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING *`,
    String(row.id),
    status,
    httpStatus ? `HTTP_${httpStatus}` : null,
    safeText(detail || 'NHCX dispatch failed', 2_000),
    nextRetryAt,
  );
  return rows[0] || null;
}

async function applyGatewayAcceptance(row, { gatewayReference = null } = {}) {
  if (row.cycle === 'claim' && row.claim_id) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE tpa_claims
          SET submission_channel = 'nhcx',
              tpa_reference_id = COALESCE($3, tpa_reference_id),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND status IN ('submitted', 'queried')
        RETURNING id, status, submission_channel, tpa_reference_id, submitted_at`,
      row.tenant_id,
      Number(row.claim_id),
      gatewayReference || null,
    );
    if (!rows[0]) {
      logger.warn('NHCX claim acceptance did not update a workflow row', {
        nhcx_message_id: String(row.id),
        tenant_id: row.tenant_id,
        claim_id: row.claim_id,
      });
    }
    return rows[0] || null;
  }

  if (row.cycle !== 'preauth' || !row.preauth_id) return null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE insurance_preauth
        SET status = CASE WHEN status = 'draft' THEN 'submitted' ELSE status END,
            submitted_at = COALESCE(submitted_at, NOW()),
            submission_channel = 'nhcx',
            tpa_reference_id = COALESCE($3, tpa_reference_id),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status IN ('draft', 'submitted', 'queried')
      RETURNING id, status, submission_channel, tpa_reference_id, submitted_at`,
    row.tenant_id,
    Number(row.preauth_id),
    gatewayReference || null,
  );
  if (!rows[0]) {
    logger.warn('NHCX preauth acceptance did not update a workflow row', {
      nhcx_message_id: String(row.id),
      tenant_id: row.tenant_id,
      preauth_id: row.preauth_id,
    });
  }
  return rows[0] || null;
}

export async function dispatchPendingNHCXMessages({
  tenantId = null,
  batchSize = DEFAULT_BATCH,
  fetchImpl = null,
  runtimeResolver = null,
  jweKeyResolver = null,
  allowDisabled = false,
} = {}) {
  if (!allowDisabled && !isNHCXGloballyEnabled()) {
    return { halted: true, reason: 'nhcx_disabled', dispatched: 0, accepted: 0, failed: 0, dead: 0 };
  }

  const cap = clampBatchSize(batchSize);
  const fetcher = fetchImpl || ((url, opts) => safeFetch(url, opts, {
    label: 'NHCX gateway URL',
    allowlistEnv: 'NHCX_GATEWAY_HOST_ALLOWLIST',
    allowPrivateEnv: 'NHCX_GATEWAY_ALLOW_PRIVATE_TARGETS',
  }));

  const claimSql = tenantId
    ? `UPDATE nhcx_messages
          SET status = 'sent',
              attempt_count = attempt_count + 1,
              updated_at = NOW()
        WHERE id IN (
          SELECT id FROM nhcx_messages
           WHERE tenant_id = $1::uuid
             AND direction = 'outbound'
             AND status IN ('pending', 'failed')
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           ORDER BY COALESCE(next_retry_at, created_at), id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING *`
    : `UPDATE nhcx_messages
          SET status = 'sent',
              attempt_count = attempt_count + 1,
              updated_at = NOW()
        WHERE id IN (
          SELECT id FROM nhcx_messages
           WHERE direction = 'outbound'
             AND status IN ('pending', 'failed')
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           ORDER BY COALESCE(next_retry_at, created_at), id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING *`;

  const claimed = tenantId
    ? await prisma.$queryRawUnsafe(claimSql, tenantId, cap)
    : await prisma.$queryRawUnsafe(claimSql, cap);

  let accepted = 0;
  let failed = 0;
  let dead = 0;
  for (const row of claimed) {
    try {
      const runtime = await loadRuntimeForTenant(row.tenant_id, { runtimeResolver, allowDisabled });
      const built = await buildCurrentBundleForEnvelope(row, runtime);
      const protectedHeaders = hcxHeaders({
        hcxApiCallId: row.hcx_api_call_id,
        hcxCorrelationId: row.hcx_correlation_id,
        hcxWorkflowId: row.hcx_workflow_id,
        participantCodeSelf: row.participant_code_self || runtime.participantCode,
        participantCodeCounterparty: row.participant_code_counterparty || runtime.counterpartyParticipantCode,
      });
      const encrypted = await encryptBundleAsJWE({
        bundle: built.bundle,
        protectedHeaders,
        runtime,
        jweKeyResolver: jweKeyResolver || defaultJweKeyResolver,
      });
      const prepared = await prepareEnvelopeForDispatch(row, built, encrypted);
      const response = await fetcher(endpointUrl(runtime.gatewayBaseUrl, row.endpoint), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.credentials.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...Object.fromEntries(Object.entries(protectedHeaders).map(([key, value]) => [key, String(value)])),
        },
        body: JSON.stringify({ payload: encrypted.ciphertext }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const responseExcerpt = await readResponseExcerpt(response);
      const responseBody = parseMaybeJson(responseExcerpt);
      if (response.status >= 200 && response.status < 300) {
        const gatewayStatus = extractGatewayStatus(response, responseBody);
        const gatewayReference = extractGatewayReference(response, responseBody);
        await applyGatewayAcceptance(prepared, { gatewayReference });
        await markAccepted(prepared, { gatewayStatus, gatewayReference, responseExcerpt });
        accepted += 1;
      } else {
        const updated = await markFailed(prepared, {
          httpStatus: response.status,
          responseExcerpt,
        });
        if (updated?.status === 'dead' || updated?.status === 'rejected') dead += 1;
        else failed += 1;
      }
    } catch (err) {
      logger.warn('NHCX outbound dispatch failed', {
        nhcx_message_id: String(row.id),
        tenant_id: row.tenant_id,
        error: err?.message,
      });
      const updated = await markFailed(row, {
        errorMessage: err?.message || 'NHCX dispatch failed',
      });
      if (updated?.status === 'dead' || updated?.status === 'rejected') dead += 1;
      else failed += 1;
    }
  }

  return { dispatched: claimed.length, accepted, failed, dead };
}

export async function reapStaleNHCXDispatches({ staleMinutes = 15 } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = 'failed',
            last_error = 'reaped: stale sent outbound dispatch',
            next_retry_at = NOW(),
            updated_at = NOW()
      WHERE direction = 'outbound'
        AND status = 'sent'
        AND sent_at IS NULL
        AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
      RETURNING id`,
    Number(staleMinutes) || 15,
  );
  return { reaped: rows.length };
}

export async function redriveNHCXMessage({
  tenantId,
  id,
  runtimeResolver = null,
  allowDisabled = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  const messageId = normalizePositiveInt(id, 'NHCX message id');
  assertNHCXGloballyEnabled({ allowDisabled });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM nhcx_messages
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
        AND direction = 'outbound'
        AND status IN ('failed', 'dead', 'rejected')
      LIMIT 1`,
    String(messageId),
    tid,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('NHCX outbound message not eligible for redrive', 'NHCX_MESSAGE_NOT_REDRIVEABLE');

  const runtime = await loadRuntimeForTenant(tid, { runtimeResolver, allowDisabled });
  const built = await buildCurrentBundleForEnvelope(row, runtime);
  const protectedHeaders = hcxHeaders({
    hcxApiCallId: row.hcx_api_call_id,
    hcxCorrelationId: row.hcx_correlation_id,
    hcxWorkflowId: row.hcx_workflow_id,
    participantCodeSelf: row.participant_code_self || runtime.participantCode,
    participantCodeCounterparty: row.participant_code_counterparty || runtime.counterpartyParticipantCode,
  });
  const updated = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = 'pending',
            attempt_count = 0,
            payload_hash = $3,
            payload_ciphertext = NULL,
            protected_headers = $4::jsonb,
            profile_url = $5,
            profile_version = $6,
            domain_resource_type = $7,
            validation_issues = '[]'::jsonb,
            last_error = NULL,
            next_retry_at = NOW(),
            sent_at = NULL,
            updated_at = NOW()
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      RETURNING *`,
    String(messageId),
    tid,
    built.payloadHash,
    JSON.stringify(protectedHeaders),
    built.profileUrl,
    built.profileVersion,
    built.domainResourceType,
  );
  return updated[0];
}

export async function listNHCXMessages({
  tenantId,
  status = null,
  cycle = null,
  direction = null,
  limit = 50,
} = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    const cleanStatus = clean(status);
    if (!NHCX_OUTBOUND_STATUSES.includes(cleanStatus)
        && !['processed', 'duplicate', 'manual_review', 'processing', 'recovery_pending'].includes(cleanStatus)) {
      throw AppError.badRequest('Invalid NHCX message status', 'NHCX_STATUS_INVALID');
    }
    params.push(cleanStatus);
    filters.push(`status = $${params.length}`);
  }
  if (cycle) {
    params.push(clean(cycle));
    filters.push(`cycle = $${params.length}`);
  }
  if (direction) {
    params.push(clean(direction));
    filters.push(`direction = $${params.length}`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 500);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, environment, direction, cycle, endpoint,
            participant_code_self, participant_code_counterparty,
            hcx_api_call_id, hcx_correlation_id, hcx_workflow_id, hcx_status,
            claim_id, preauth_id, policy_id, patient_uid, admission_id,
            domain_resource_type, profile_url, profile_version, payload_hash,
            protected_headers, signature_verified, registry_key_id,
            certificate_thumbprint, validation_issues, status, attempt_count,
            last_error, next_retry_at, received_at, sent_at, processed_at,
            created_at, updated_at
       FROM nhcx_messages
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}`,
    ...params,
    safeLimit,
  );
  return { messages: rows, count: rows.length };
}

export async function getNHCXMessage({ tenantId, id } = {}) {
  const tid = requireTenantId(tenantId);
  const messageId = normalizePositiveInt(id, 'NHCX message id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM nhcx_messages
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    String(messageId),
    tid,
  );
  if (!rows[0]) throw AppError.notFound('NHCX message not found', 'NHCX_MESSAGE_NOT_FOUND');
  return rows[0];
}

export const __testing__ = {
  NHCX_BACKOFF_SECONDS,
  NHCX_RETRY_LIMIT,
  backoffSecondsForAttempt,
  computeNextRetryAt,
  defaultJweKeyResolver,
  endpointUrl,
  encryptBundleAsJWE,
  hcxHeaders,
  isRetryable,
};

export default {
  dispatchPendingNHCXMessages,
  enqueueClaimStatusCheck,
  enqueueClaimSubmit,
  enqueueCommunicationResponse,
  enqueueCoverageEligibilityCheck,
  enqueuePreauthSubmit,
  getNHCXMessage,
  listNHCXMessages,
  reapStaleNHCXDispatches,
  redriveNHCXMessage,
};
