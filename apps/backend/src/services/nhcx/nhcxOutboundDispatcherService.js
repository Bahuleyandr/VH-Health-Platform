// src/services/nhcx/nhcxOutboundDispatcherService.js
//
// Durable outbound dispatcher for NL-2 P1 NHCX messages. It keeps the local
// workflow spine in insurance_policies / insurance_preauth, and treats
// nhcx_messages as the exchange envelope plus retry state.

import crypto from 'node:crypto';
import { CompactEncrypt, importJWK, importSPKI } from 'jose';

import { NHCX_CONFIG } from '../../config/nhcxConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { safeFetch } from '../../utils/ssrfGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import {
  lockPharmacyFundingAdmissionTx,
  lockPharmacyFundingAuthorityTx,
  resolvePharmacyFundingPatientUidTx,
} from '../pharmacy/pharmacyCapService.js';
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
const NHCX_PROJECTION_ROLES = new Set([
  'INSURANCE_COORDINATOR',
  'CLAIMS_MANAGER',
  'ADMIN',
  'SUPER_ADMIN',
]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function clean(value) {
  return String(value ?? '').trim();
}

function safeText(value, max = 1_000) {
  const text = clean(value);
  return text ? text.slice(0, max) : null;
}

function projectionRequestSha256({ messageId, transportResponseSha256 }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    contract: 'nhcx_accepted_projection_retry_v1',
    message_id: String(messageId),
    transport_response_sha256: String(transportResponseSha256),
  }), 'utf8').digest('hex');
}

async function assertProjectionActorTx(tx, { tenantId, actorUid }) {
  if (!actorUid) {
    throw AppError.forbidden(
      'Accepted NHCX projection retry requires an authenticated insurance owner',
      'NHCX_PROJECTION_ACTOR_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid,UPPER(role) AS role
       FROM users
      WHERE tenant_id=$1::uuid AND uid=$2::uuid
        AND is_active=TRUE AND status='active' AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      FOR KEY SHARE`,
    requireTenantId(tenantId),
    String(actorUid),
  );
  if (!rows.length || !NHCX_PROJECTION_ROLES.has(String(rows[0].role))) {
    throw AppError.forbidden(
      'Accepted NHCX projection retry requires an active insurance coordinator',
      'NHCX_PROJECTION_ACTOR_FORBIDDEN',
    );
  }
  return rows[0];
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

async function persistGatewayTransportReceipt(row, {
  httpStatus,
  gatewayStatus,
  gatewayReference,
  responseExcerpt,
} = {}) {
  const responseSha256 = crypto.createHash('sha256')
    .update(String(responseExcerpt || ''), 'utf8')
    .digest('hex');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = 'accepted',
            hcx_status = COALESCE($2, hcx_status),
            last_error = NULL,
            next_retry_at = NULL,
            sent_at = COALESCE(sent_at,NOW()),
            transport_accepted_at = NOW(),
            transport_http_status = $3::int,
            transport_response_sha256 = $4,
            transport_gateway_reference = $5,
            transport_response_excerpt = $6,
            projection_status = 'pending',
            projection_error = NULL,
            projection_evidence = NULL,
            projection_task_id = NULL,
            projection_updated_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::bigint AND tenant_id=$7::uuid
        AND direction='outbound' AND transport_accepted_at IS NULL
      RETURNING *`,
    String(row.id),
    gatewayStatus || gatewayReference || responseExcerpt || 'accepted',
    Number(httpStatus),
    responseSha256,
    gatewayReference || null,
    safeText(responseExcerpt, RESPONSE_EXCERPT_MAX),
    requireTenantId(row.tenant_id),
  );
  if (rows[0]) return rows[0];
  const existing = await prisma.$queryRawUnsafe(
    `SELECT * FROM nhcx_messages
      WHERE tenant_id=$1::uuid AND id=$2::bigint AND transport_accepted_at IS NOT NULL`,
    requireTenantId(row.tenant_id),
    String(row.id),
  );
  if (existing.length === 1
      && Number(existing[0].transport_http_status) === Number(httpStatus)
      && String(existing[0].transport_response_sha256) === responseSha256) {
    return existing[0];
  }
  throw AppError.conflict(
    'The NHCX transport receipt could not be durably bound to this exact response',
    'NHCX_TRANSPORT_RECEIPT_CONFLICT',
  );
}

// Only two of the six outbound cycles own a local workflow row that a gateway
// acceptance projects onto: `claim` → tpa_claims and `preauth` →
// insurance_preauth. Eligibility, claim-status (`task`), Communication and
// payment-notice envelopes have no local projection target at all — the
// pre-receipt `applyGatewayAcceptance` returned a benign null for exactly those
// and only logged a warning when a claim/pre-auth row was already past its
// projectable window. Gate the projection on this predicate so those cycles
// close out instead of stranding every accepted receipt in
// `reconciliation_required` behind a coordinator task no retry could clear.
function hasLocalProjectionTarget(row) {
  if (String(row?.cycle) === 'claim') return row.claim_id != null;
  if (String(row?.cycle) === 'preauth') return row.preauth_id != null;
  return false;
}

async function lockGatewayProjectionAuthorityTx(tx, row) {
  if (!row.patient_uid) {
    throw AppError.conflict(
      'The accepted NHCX receipt has no exact patient authority',
      'NHCX_GATEWAY_PROJECTION_PATIENT_REQUIRED',
    );
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: row.tenant_id,
    patientUid: String(row.patient_uid),
    admissionId: row.admission_id == null ? null : Number(row.admission_id),
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: row.tenant_id, patientUid });
  if (row.admission_id != null) {
    await lockPharmacyFundingAdmissionTx(tx, {
      tenantId: row.tenant_id,
      patientUid,
      admissionId: Number(row.admission_id),
    });
  }

  if (row.cycle === 'claim' && row.claim_id) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id,patient_uid,admission_id,status,submission_channel,tpa_reference_id
         FROM tpa_claims
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      row.tenant_id,
      Number(row.claim_id),
    );
    if (!rows.length
        || String(rows[0].patient_uid) !== patientUid
        || (rows[0].admission_id == null ? null : Number(rows[0].admission_id))
          !== (row.admission_id == null ? null : Number(row.admission_id))) {
      throw AppError.conflict(
        'The accepted NHCX claim target no longer matches its exact patient and admission',
        'NHCX_GATEWAY_PROJECTION_TARGET_MISMATCH',
      );
    }
    if (!['submitted', 'queried'].includes(String(rows[0].status))) return null;
    return { kind: 'claim', target: rows[0], patientUid };
  }

  if (row.cycle === 'preauth' && row.preauth_id) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id,patient_uid,admission_id,status,submission_channel,tpa_reference_id
         FROM insurance_preauth
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      row.tenant_id,
      Number(row.preauth_id),
    );
    if (!rows.length
        || String(rows[0].patient_uid) !== patientUid
        || (rows[0].admission_id == null ? null : Number(rows[0].admission_id))
          !== (row.admission_id == null ? null : Number(row.admission_id))) {
      throw AppError.conflict(
        'The accepted NHCX pre-auth target no longer matches its exact patient and admission',
        'NHCX_GATEWAY_PROJECTION_TARGET_MISMATCH',
      );
    }
    if (!['draft', 'submitted', 'queried'].includes(String(rows[0].status))) return null;
    return { kind: 'preauth', target: rows[0], patientUid };
  }

  return null;
}

async function projectGatewayAcceptanceTargetTx(tx, row, authority, {
  gatewayReference = null,
} = {}) {
  if (authority?.kind === 'claim') {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE tpa_claims
          SET submission_channel='nhcx',
              tpa_reference_id=COALESCE($3,tpa_reference_id),updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND patient_uid=$4::uuid
          AND admission_id IS NOT DISTINCT FROM $5::int
          AND status IN ('submitted','queried')
        RETURNING id,status,submission_channel,tpa_reference_id,submitted_at`,
      row.tenant_id,
      Number(row.claim_id),
      gatewayReference || row.transport_gateway_reference || null,
      authority.patientUid,
      row.admission_id == null ? null : Number(row.admission_id),
    );
    return rows[0] || null;
  }
  if (authority?.kind === 'preauth') {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE insurance_preauth
          SET status=CASE WHEN status='draft' THEN 'submitted' ELSE status END,
              submitted_at=COALESCE(submitted_at,NOW()),submission_channel='nhcx',
              tpa_reference_id=COALESCE($3,tpa_reference_id),updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND patient_uid=$4::uuid
          AND admission_id IS NOT DISTINCT FROM $5::int
          AND status IN ('draft','submitted','queried')
        RETURNING id,status,submission_channel,tpa_reference_id,submitted_at`,
      row.tenant_id,
      Number(row.preauth_id),
      gatewayReference || row.transport_gateway_reference || null,
      authority.patientUid,
      row.admission_id == null ? null : Number(row.admission_id),
    );
    return rows[0] || null;
  }
  return null;
}

const PROJECTION_APPLIED_CONTRACT = 'nhcx_gateway_projection_applied_v1';
const PROJECTION_NOT_APPLICABLE_CONTRACT = 'nhcx_gateway_projection_not_applicable_v1';

async function markGatewayProjectionAppliedTx(tx, row, projection, {
  actorUid = null,
  contract = PROJECTION_APPLIED_CONTRACT,
  reason = null,
} = {}) {
  let completedTask = null;
  if (row.projection_task_id != null) {
    const taskRows = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET status='completed',completed_at=NOW(),
              metadata=COALESCE(metadata,'{}'::jsonb) || $4::jsonb,
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type='nhcx_gateway_projection'
          AND related_resource_id=$3
          AND assigned_to_role='INSURANCE_COORDINATOR'
          AND status IN ('open','in_progress','blocked','overdue')
          AND metadata->>'transport_response_sha256'=$5
        RETURNING id,status,assigned_to_role,completed_at`,
      row.tenant_id,
      Number(row.projection_task_id),
      String(row.id),
      JSON.stringify({
        nhcx_projection_completed: true,
        transport_response_sha256: String(row.transport_response_sha256),
        completed_by: actorUid == null ? null : String(actorUid),
      }),
      String(row.transport_response_sha256),
    );
    if (!taskRows.length) {
      throw AppError.conflict(
        'The exact NHCX projection task is no longer actionable',
        'NHCX_GATEWAY_PROJECTION_TASK_CONFLICT',
      );
    }
    completedTask = taskRows[0];
  }
  const evidence = {
    contract,
    transport_response_sha256: String(row.transport_response_sha256),
    cycle: row.cycle,
    claim_id: row.claim_id == null ? null : Number(row.claim_id),
    preauth_id: row.preauth_id == null ? null : Number(row.preauth_id),
    projection,
    no_local_projection_target_reason: reason,
    task_id: completedTask == null ? null : Number(completedTask.id),
    completed_by: actorUid == null ? null : String(actorUid),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET projection_status='applied',projection_error=NULL,
            projection_evidence=$3::jsonb,projection_task_id=NULL,
            projection_updated_at=NOW(),updated_at=NOW()
      WHERE tenant_id=$1::uuid AND id=$2::bigint
        AND transport_accepted_at IS NOT NULL AND status='accepted'
        AND projection_status IN ('pending','reconciliation_required')
      RETURNING *`,
    requireTenantId(row.tenant_id),
    String(row.id),
    JSON.stringify(evidence),
  );
  if (!rows.length) {
    throw AppError.conflict(
      'The accepted NHCX response could not be projected from its durable receipt',
      'NHCX_GATEWAY_PROJECTION_STATE_CONFLICT',
    );
  }
  return { message: rows[0], projection, task: completedTask, evidence };
}

async function applyAcceptedGatewayProjection(row, {
  gatewayReference = null,
  actorUid = null,
} = {}) {
  return setTenantTx(requireTenantId(row.tenant_id), async (tx) => {
    const messageRows = await tx.$queryRawUnsafe(
      `SELECT * FROM nhcx_messages
        WHERE tenant_id=$1::uuid AND id=$2::bigint
          AND status='accepted' AND transport_accepted_at IS NOT NULL
          AND projection_status IN ('pending','reconciliation_required')
        FOR UPDATE`,
      row.tenant_id,
      String(row.id),
    );
    if (!messageRows.length
        || String(messageRows[0].transport_response_sha256)
          !== String(row.transport_response_sha256)) {
      throw AppError.conflict(
        'The durable NHCX transport receipt changed before local projection',
        'NHCX_GATEWAY_PROJECTION_STATE_CONFLICT',
      );
    }
    const lockedMessage = messageRows[0];
    const exactTargetFields = [
      'cycle', 'claim_id', 'preauth_id', 'patient_uid', 'admission_id',
    ];
    if (exactTargetFields.some((field) => String(lockedMessage[field] ?? '')
      !== String(row[field] ?? ''))) {
      throw AppError.conflict(
        'The durable NHCX transport target changed before local projection',
        'NHCX_GATEWAY_PROJECTION_TARGET_MISMATCH',
      );
    }
    if (!hasLocalProjectionTarget(lockedMessage)) {
      return markGatewayProjectionAppliedTx(tx, lockedMessage, null, {
        actorUid,
        contract: PROJECTION_NOT_APPLICABLE_CONTRACT,
        reason: 'cycle_has_no_local_projection_target',
      });
    }
    const authority = await lockGatewayProjectionAuthorityTx(tx, lockedMessage);
    if (!authority) {
      // The exact patient/admission authority matched, but the local row is
      // already past its projectable window. The pre-receipt path warned and
      // returned null here; there is nothing a coordinator could reconcile, so
      // close the projection rather than raise into a task no retry can clear.
      logger.warn('NHCX gateway acceptance had no projectable local workflow row', {
        nhcx_message_id: String(lockedMessage.id),
        tenant_id: lockedMessage.tenant_id,
        cycle: lockedMessage.cycle,
        claim_id: lockedMessage.claim_id,
        preauth_id: lockedMessage.preauth_id,
      });
      return markGatewayProjectionAppliedTx(tx, lockedMessage, null, {
        actorUid,
        contract: PROJECTION_NOT_APPLICABLE_CONTRACT,
        reason: 'local_target_not_in_projectable_state',
      });
    }
    const projection = await projectGatewayAcceptanceTargetTx(
      tx,
      lockedMessage,
      authority,
      { gatewayReference },
    );
    if (!projection) {
      throw AppError.conflict(
        'The accepted NHCX response has no actionable local claim or pre-auth target',
        'NHCX_GATEWAY_PROJECTION_TARGET_REQUIRED',
      );
    }
    return markGatewayProjectionAppliedTx(tx, lockedMessage, projection, { actorUid });
  });
}

async function markGatewayProjectionReconciliation(row, projectionError) {
  const detail = safeText(projectionError?.message || 'NHCX gateway projection failed', 2_000);
  return setTenantTx(requireTenantId(row.tenant_id), async (tx) => {
    const messageRows = await tx.$queryRawUnsafe(
      `SELECT * FROM nhcx_messages
        WHERE tenant_id=$1::uuid AND id=$2::bigint
          AND status='accepted' AND transport_accepted_at IS NOT NULL
          AND projection_status IN ('pending','reconciliation_required')
        FOR UPDATE`,
      row.tenant_id,
      String(row.id),
    );
    if (!messageRows.length) return null;
    const lockedMessage = messageRows[0];
    const created = await createTask({
      tenantId: lockedMessage.tenant_id,
      taskKind: 'review',
      title: `Reconcile accepted NHCX ${lockedMessage.cycle} response`,
      description: 'The gateway accepted this exact outbound message. External resend is forbidden; reconcile only the local claim/pre-auth projection.',
      patientUid: lockedMessage.patient_uid || null,
      relatedResourceType: 'nhcx_gateway_projection',
      relatedResourceId: String(lockedMessage.id),
      priority: 'high',
      assignedToRole: 'INSURANCE_COORDINATOR',
      createdBy: null,
      slaCompletionSemantics: 'none',
      tx,
      onConflictResourceDoNothing: true,
      metadata: {
        contract: 'nhcx_gateway_projection_reconciliation_v1',
        transport_response_sha256: String(lockedMessage.transport_response_sha256),
        claim_id: lockedMessage.claim_id == null ? null : Number(lockedMessage.claim_id),
        preauth_id: lockedMessage.preauth_id == null ? null : Number(lockedMessage.preauth_id),
        admission_id: lockedMessage.admission_id == null ? null : Number(lockedMessage.admission_id),
        deep_link: `/billing-desk?nhcx_projection_message_id=${String(lockedMessage.id)}`,
      },
    });
    const task = created || (await tx.$queryRawUnsafe(
      `SELECT * FROM tasks
        WHERE tenant_id=$1::uuid AND related_resource_type='nhcx_gateway_projection'
          AND related_resource_id=$2 AND status IN ('open','in_progress','blocked','overdue')
          AND assigned_to_role='INSURANCE_COORDINATOR'
          AND metadata->>'transport_response_sha256'=$3
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      lockedMessage.tenant_id,
      String(lockedMessage.id),
      String(lockedMessage.transport_response_sha256),
    ))[0];
    if (!task) {
      throw AppError.conflict(
        'The accepted NHCX response requires a durable projection owner',
        'NHCX_GATEWAY_PROJECTION_TASK_REQUIRED',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE nhcx_messages
          SET projection_status='reconciliation_required',projection_error=$3,
              projection_evidence=$4::jsonb,projection_task_id=$5::int,
              projection_updated_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::bigint
          AND transport_accepted_at IS NOT NULL AND status='accepted'
          AND projection_status IN ('pending','reconciliation_required')
        RETURNING *`,
      lockedMessage.tenant_id,
      String(lockedMessage.id),
      detail,
      JSON.stringify({
        contract: 'nhcx_gateway_projection_reconciliation_v1',
        transport_response_sha256: String(lockedMessage.transport_response_sha256),
        task_id: Number(task.id),
        error: detail,
      }),
      Number(task.id),
    );
    if (!rows.length) {
      throw AppError.conflict(
        'The accepted NHCX projection reconciliation state changed concurrently',
        'NHCX_GATEWAY_PROJECTION_STATE_CONFLICT',
      );
    }
    return rows[0];
  });
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
      WHERE id = $1::bigint AND transport_accepted_at IS NULL
      RETURNING *`,
    String(row.id),
    status,
    httpStatus ? `HTTP_${httpStatus}` : null,
    safeText(detail || 'NHCX dispatch failed', 2_000),
    nextRetryAt,
  );
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
             AND transport_accepted_at IS NULL
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
             AND (
               (recovery_inbox_id IS NULL AND owner_release_client_event_id IS NULL)
               OR (
                 recovery_inbox_id IS NOT NULL
                 AND recovery_disposition = 'manual_redrive_requested'
                 AND cycle <> 'payment_notice'
                 AND owner_release_client_event_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM clinical_continuity_replay_receipts AS receipt
                     JOIN clinical_continuity_replay_effect_evidence AS effect
                       ON effect.tenant_id = receipt.tenant_id
                      AND effect.client_event_id = receipt.client_event_id
                    WHERE receipt.tenant_id = nhcx_messages.tenant_id
                      AND receipt.client_event_id = nhcx_messages.owner_release_client_event_id
                      AND receipt.source_kind = 'held_message_release'
                      AND receipt.disposition = 'applied'
                      AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                      AND effect.interface_family = 'I19'
                      AND effect.nhcx_message_id = nhcx_messages.id
                      AND effect.network_send_performed = false
                 )
               )
             )
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
             AND transport_accepted_at IS NULL
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
             AND (
               (recovery_inbox_id IS NULL AND owner_release_client_event_id IS NULL)
               OR (
                 recovery_inbox_id IS NOT NULL
                 AND recovery_disposition = 'manual_redrive_requested'
                 AND cycle <> 'payment_notice'
                 AND owner_release_client_event_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM clinical_continuity_replay_receipts AS receipt
                     JOIN clinical_continuity_replay_effect_evidence AS effect
                       ON effect.tenant_id = receipt.tenant_id
                      AND effect.client_event_id = receipt.client_event_id
                    WHERE receipt.tenant_id = nhcx_messages.tenant_id
                      AND receipt.client_event_id = nhcx_messages.owner_release_client_event_id
                      AND receipt.source_kind = 'held_message_release'
                      AND receipt.disposition = 'applied'
                      AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                      AND effect.interface_family = 'I19'
                      AND effect.nhcx_message_id = nhcx_messages.id
                      AND effect.network_send_performed = false
                 )
               )
             )
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
    let transportReceipt = null;
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
        transportReceipt = await persistGatewayTransportReceipt(prepared, {
          httpStatus: response.status,
          gatewayStatus,
          gatewayReference,
          responseExcerpt,
        });
        try {
          await applyAcceptedGatewayProjection(transportReceipt, { gatewayReference });
        } catch (projectionError) {
          logger.error('Accepted NHCX response requires local projection reconciliation', {
            nhcx_message_id: String(row.id),
            tenant_id: row.tenant_id,
            transport_response_sha256: transportReceipt.transport_response_sha256,
            error: projectionError?.message,
          });
          try {
            await markGatewayProjectionReconciliation(transportReceipt, projectionError);
          } catch (reconciliationError) {
            logger.error('Accepted NHCX response could not materialize projection work item', {
              nhcx_message_id: String(row.id),
              tenant_id: row.tenant_id,
              transport_response_sha256: transportReceipt.transport_response_sha256,
              error: reconciliationError?.message,
            });
          }
        }
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
      if (transportReceipt?.transport_accepted_at) {
        try {
          await markGatewayProjectionReconciliation(transportReceipt, err);
        } catch (reconciliationError) {
          logger.error('Accepted NHCX response remains projection-pending', {
            nhcx_message_id: String(row.id),
            tenant_id: row.tenant_id,
            transport_response_sha256: transportReceipt.transport_response_sha256,
            error: reconciliationError?.message,
          });
        }
        accepted += 1;
        continue;
      }
      const updated = await markFailed(row, {
        errorMessage: err?.message || 'NHCX dispatch failed',
      });
      if (updated?.status === 'dead' || updated?.status === 'rejected') dead += 1;
      else failed += 1;
    }
  }

  return { dispatched: claimed.length, accepted, failed, dead };
}

export async function getAcceptedNHCXProjectionRecovery({
  tenantId,
  messageId,
  actorUid,
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = normalizePositiveInt(messageId, 'NHCX projection message id');
  return setTenantTx(tid, async (tx) => {
    await assertProjectionActorTx(tx, { tenantId: tid, actorUid });
    const rows = await tx.$queryRawUnsafe(
      `SELECT message.id,message.cycle,message.claim_id,message.preauth_id,
              message.patient_uid,message.admission_id,message.status,
              message.transport_accepted_at,message.transport_http_status,
              message.transport_response_sha256,message.transport_gateway_reference,
              message.projection_status,message.projection_error,
              message.projection_evidence,
              COALESCE(
                message.projection_task_id,
                CASE WHEN message.projection_evidence->>'task_id' ~ '^[1-9][0-9]*$'
                     THEN (message.projection_evidence->>'task_id')::int END
              ) AS effective_task_id,
              task.status AS task_status,task.assigned_to_role AS owner_role
         FROM nhcx_messages message
         LEFT JOIN tasks task
           ON task.tenant_id=message.tenant_id
          AND task.id=COALESCE(
            message.projection_task_id,
            CASE WHEN message.projection_evidence->>'task_id' ~ '^[1-9][0-9]*$'
                 THEN (message.projection_evidence->>'task_id')::int END
          )
          AND task.related_resource_type='nhcx_gateway_projection'
          AND task.related_resource_id=message.id::text
          AND task.metadata->>'transport_response_sha256'=btrim(message.transport_response_sha256)
        WHERE message.tenant_id=$1::uuid AND message.id=$2::bigint
          AND message.direction='outbound' AND message.status='accepted'
          AND message.transport_accepted_at IS NOT NULL
          AND message.projection_status IN ('applied','reconciliation_required')`,
      tid,
      String(id),
    );
    if (!rows.length) {
      throw AppError.notFound(
        'Accepted NHCX projection recovery was not found',
        'NHCX_PROJECTION_RECOVERY_NOT_FOUND',
      );
    }
    const row = rows[0];
    if (row.projection_status === 'reconciliation_required'
        && (row.effective_task_id == null
          || row.task_status == null
          || !['open', 'in_progress', 'blocked', 'overdue'].includes(String(row.task_status))
          || row.owner_role !== 'INSURANCE_COORDINATOR')) {
      throw AppError.conflict(
        'Accepted NHCX projection has no exact active insurance task',
        'NHCX_GATEWAY_PROJECTION_TASK_REQUIRED',
      );
    }
    return {
      message_id: Number(row.id),
      cycle: row.cycle,
      claim_id: row.claim_id == null ? null : Number(row.claim_id),
      preauth_id: row.preauth_id == null ? null : Number(row.preauth_id),
      patient_uid: row.patient_uid == null ? null : String(row.patient_uid),
      admission_id: row.admission_id == null ? null : Number(row.admission_id),
      status: row.status,
      transport_accepted_at: row.transport_accepted_at,
      transport_http_status: Number(row.transport_http_status),
      transport_response_sha256: String(row.transport_response_sha256),
      transport_gateway_reference: row.transport_gateway_reference || null,
      projection_status: row.projection_status,
      projection_error: row.projection_error || null,
      projection_evidence: row.projection_evidence || null,
      task_id: row.effective_task_id == null ? null : Number(row.effective_task_id),
      task_status: row.task_status || (row.projection_status === 'applied' ? 'completed' : null),
      owner_role: row.owner_role || (row.projection_status === 'applied'
        ? 'INSURANCE_COORDINATOR'
        : null),
      deep_link: `/billing-desk?nhcx_projection_message_id=${String(row.id)}`,
      next_action: row.projection_status === 'applied'
        ? 'nhcx_projection_complete'
        : 'retry_accepted_nhcx_projection',
    };
  });
}

export async function retryAcceptedNHCXProjection({
  tenantId,
  messageId,
  expectedTransportResponseSha256,
  actorUid,
  commandKeySha256,
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = normalizePositiveInt(messageId, 'NHCX projection message id');
  const expectedHash = clean(expectedTransportResponseSha256).toLowerCase();
  const commandHash = clean(commandKeySha256).toLowerCase();
  if (!SHA256_HEX_RE.test(expectedHash)) {
    throw AppError.badRequest(
      'expected_transport_response_sha256 must be a SHA-256 hex digest',
      'NHCX_PROJECTION_TRANSPORT_HASH_REQUIRED',
    );
  }
  if (!SHA256_HEX_RE.test(commandHash)) {
    throw AppError.badRequest(
      'A durable SHA-256 idempotency command is required',
      'NHCX_PROJECTION_COMMAND_REQUIRED',
    );
  }
  return setTenantTx(tid, async (tx) => {
    const messageRows = await tx.$queryRawUnsafe(
      `SELECT * FROM nhcx_messages
        WHERE tenant_id=$1::uuid AND id=$2::bigint
          AND direction='outbound' AND status='accepted'
          AND transport_accepted_at IS NOT NULL
          AND projection_status IN ('reconciliation_required','applied')
        FOR UPDATE`,
      tid,
      String(id),
    );
    if (!messageRows.length) {
      throw AppError.notFound(
        'Accepted NHCX projection recovery was not found',
        'NHCX_PROJECTION_RECOVERY_NOT_FOUND',
      );
    }
    const message = messageRows[0];
    const actor = await assertProjectionActorTx(tx, { tenantId: tid, actorUid });
    if (String(message.transport_response_sha256) !== expectedHash) {
      throw AppError.conflict(
        'Accepted NHCX transport receipt does not match the requested retry',
        'NHCX_PROJECTION_TRANSPORT_HASH_STALE',
      );
    }
    const requestSha256 = projectionRequestSha256({
      messageId: message.id,
      transportResponseSha256: expectedHash,
    });
    const existingReceipts = await tx.$queryRawUnsafe(
      `SELECT * FROM nhcx_projection_commands
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        FOR UPDATE`,
      tid,
      commandHash,
    );
    if (existingReceipts.length) {
      const existing = existingReceipts[0];
      if (Number(existing.nhcx_message_id) !== Number(message.id)
          || String(existing.actor_uid) !== String(actor.uid)
          || String(existing.request_sha256) !== requestSha256
          || String(existing.transport_response_sha256) !== expectedHash) {
        throw AppError.unprocessable(
          'Idempotency command was already bound to a different NHCX projection request',
          'NHCX_PROJECTION_IDEMPOTENCY_MISMATCH',
        );
      }
      if (existing.status === 'COMPLETE' && existing.response) return existing.response;
      throw AppError.conflict(
        'NHCX projection command is still in progress',
        'NHCX_PROJECTION_COMMAND_IN_PROGRESS',
      );
    }
    if (message.projection_status === 'applied') {
      throw AppError.conflict(
        'The accepted NHCX receipt is already projected under a different command',
        'NHCX_GATEWAY_PROJECTION_ALREADY_APPLIED',
      );
    }
    // A message whose cycle owns no local claim/pre-auth row has nothing to
    // project. Do not raise here: that would leave the coordinator's task
    // permanently unclearable through the only endpoint that can clear it.
    // The command receipt is still claimed below, and the projection closes as
    // not-applicable with its reason recorded on the durable evidence.
    const authority = hasLocalProjectionTarget(message)
      ? await lockGatewayProjectionAuthorityTx(tx, message)
      : null;
    const taskRows = await tx.$queryRawUnsafe(
      `SELECT id,status,assigned_to_role
         FROM tasks
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type='nhcx_gateway_projection'
          AND related_resource_id=$3
          AND assigned_to_role='INSURANCE_COORDINATOR'
          AND status IN ('open','in_progress','blocked','overdue')
          AND metadata->>'transport_response_sha256'=$4
        FOR UPDATE`,
      tid,
      Number(message.projection_task_id),
      String(message.id),
      expectedHash,
    );
    if (!taskRows.length) {
      throw AppError.conflict(
        'The exact NHCX projection task is no longer actionable',
        'NHCX_GATEWAY_PROJECTION_TASK_CONFLICT',
      );
    }
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO nhcx_projection_commands
         (tenant_id,nhcx_message_id,task_id,actor_uid,actor_role,
          command_key_sha256,request_sha256,transport_response_sha256,status)
       VALUES ($1::uuid,$2::bigint,$3::int,$4::uuid,$5,$6,$7,$8,'IN_PROGRESS')
       ON CONFLICT (tenant_id,command_key_sha256) DO NOTHING
       RETURNING *`,
      tid,
      String(message.id),
      Number(taskRows[0].id),
      String(actor.uid),
      String(actor.role),
      commandHash,
      requestSha256,
      expectedHash,
    );
    let receipt = inserted[0];
    if (!receipt) {
      const receipts = await tx.$queryRawUnsafe(
        `SELECT * FROM nhcx_projection_commands
          WHERE tenant_id=$1::uuid AND command_key_sha256=$2
          FOR UPDATE`,
        tid,
        commandHash,
      );
      receipt = receipts[0];
      if (!receipt
          || Number(receipt.nhcx_message_id) !== Number(message.id)
          || Number(receipt.task_id) !== Number(taskRows[0].id)
          || String(receipt.actor_uid) !== String(actor.uid)
          || String(receipt.request_sha256) !== requestSha256
          || String(receipt.transport_response_sha256) !== expectedHash) {
        throw AppError.unprocessable(
          'Idempotency command was already bound to a different NHCX projection request',
          'NHCX_PROJECTION_IDEMPOTENCY_MISMATCH',
        );
      }
      if (receipt.status === 'COMPLETE' && receipt.response) return receipt.response;
      throw AppError.conflict(
        'NHCX projection command is still in progress',
        'NHCX_PROJECTION_COMMAND_IN_PROGRESS',
      );
    }

    const projection = authority
      ? await projectGatewayAcceptanceTargetTx(
        tx,
        message,
        authority,
        { gatewayReference: message.transport_gateway_reference },
      )
      : null;
    if (authority && !projection) {
      throw AppError.conflict(
        'The accepted NHCX response has no actionable local claim or pre-auth target',
        'NHCX_GATEWAY_PROJECTION_TARGET_REQUIRED',
      );
    }
    const applied = await markGatewayProjectionAppliedTx(tx, message, projection, {
      actorUid: actor.uid,
      contract: projection
        ? PROJECTION_APPLIED_CONTRACT
        : PROJECTION_NOT_APPLICABLE_CONTRACT,
      reason: projection
        ? null
        : (hasLocalProjectionTarget(message)
          ? 'local_target_not_in_projectable_state'
          : 'cycle_has_no_local_projection_target'),
    });
    const response = {
      message_id: Number(message.id),
      patient_uid: message.patient_uid == null ? null : String(message.patient_uid),
      admission_id: message.admission_id == null ? null : Number(message.admission_id),
      status: 'accepted',
      transport_accepted_at: message.transport_accepted_at,
      transport_http_status: Number(message.transport_http_status),
      projection_status: 'applied',
      projection_error: null,
      projection_evidence: applied.evidence,
      transport_response_sha256: expectedHash,
      transport_gateway_reference: message.transport_gateway_reference || null,
      cycle: message.cycle,
      claim_id: message.claim_id == null ? null : Number(message.claim_id),
      preauth_id: message.preauth_id == null ? null : Number(message.preauth_id),
      task_id: Number(taskRows[0].id),
      task_status: 'completed',
      owner_role: 'INSURANCE_COORDINATOR',
      deep_link: `/billing-desk?nhcx_projection_message_id=${String(message.id)}`,
      next_action: 'nhcx_projection_complete',
    };
    const completed = await tx.$queryRawUnsafe(
      `UPDATE nhcx_projection_commands
          SET status='COMPLETE',response=$3::jsonb,completed_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='IN_PROGRESS'
        RETURNING id`,
      tid,
      String(receipt.id),
      JSON.stringify(response),
    );
    if (!completed.length) {
      throw AppError.conflict(
        'NHCX projection command receipt could not be completed',
        'NHCX_PROJECTION_COMMAND_CONFLICT',
      );
    }
    return response;
  });
}

export async function materializeAcceptedNHCXProjectionOrphans({
  tenantId = null,
  batchSize = DEFAULT_BATCH,
} = {}) {
  const tid = tenantId == null ? null : requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM nhcx_messages
      WHERE direction='outbound' AND status='accepted'
        AND transport_accepted_at IS NOT NULL
        AND projection_status='pending' AND projection_task_id IS NULL
        AND ($1::uuid IS NULL OR tenant_id=$1::uuid)
      ORDER BY transport_accepted_at,id
      LIMIT $2::int`,
    tid,
    clampBatchSize(batchSize),
  );
  let materialized = 0;
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (!hasLocalProjectionTarget(row)) {
        // Nothing local to project, so there is nothing a coordinator could
        // reconcile. Close the receipt out of the pending window instead of
        // opening a task the retry endpoint could never clear.
        await applyAcceptedGatewayProjection(row);
        completed += 1;
        continue;
      }
      const result = await markGatewayProjectionReconciliation(
        row,
        AppError.conflict(
          'Accepted NHCX transport receipt requires local projection retry',
          'NHCX_GATEWAY_PROJECTION_ORPHANED',
        ),
      );
      if (result) materialized += 1;
    } catch (err) {
      failed += 1;
      logger.error('Accepted NHCX projection orphan could not be materialized', {
        nhcx_message_id: String(row.id),
        tenant_id: row.tenant_id,
        error: err?.message,
      });
    }
  }
  return { scanned: rows.length, materialized, completed, failed };
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
        AND transport_accepted_at IS NULL
        AND sent_at IS NULL
        AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
      RETURNING id`,
    Number(staleMinutes) || 15,
  );
  const projectionOrphans = await materializeAcceptedNHCXProjectionOrphans();
  return { reaped: rows.length, projection_orphans: projectionOrphans };
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
  projectionRequestSha256,
};

export default {
  dispatchPendingNHCXMessages,
  enqueueClaimStatusCheck,
  enqueueClaimSubmit,
  enqueueCommunicationResponse,
  enqueueCoverageEligibilityCheck,
  enqueuePreauthSubmit,
  getAcceptedNHCXProjectionRecovery,
  getNHCXMessage,
  listNHCXMessages,
  materializeAcceptedNHCXProjectionOrphans,
  reapStaleNHCXDispatches,
  redriveNHCXMessage,
  retryAcceptedNHCXProjection,
};
