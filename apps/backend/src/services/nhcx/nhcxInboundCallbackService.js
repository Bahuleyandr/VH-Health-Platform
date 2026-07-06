// src/services/nhcx/nhcxInboundCallbackService.js
//
// NHCX inbound callback processing. Public-route authentication lives in the
// router; this service decrypts the JWE, records the exchange envelope
// idempotently, validates the FHIR profile layer, and applies the narrow P1
// domain mutation for preauth ClaimResponse callbacks.

import crypto from 'node:crypto';
import { compactDecrypt, importJWK, importPKCS8 } from 'jose';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  payloadHash,
  validateNHCXInboundBundle,
} from './nhcxFhirProfileService.js';
import { loadNHCXRuntimeConfig } from './nhcxTenantConfigService.js';
import { recordInboundCommunicationRequest } from './nhcxCommunicationService.js';

const ENDPOINTS = Object.freeze({
  'coverageeligibility/on_check': {
    cycle: 'eligibility',
    expectedMainResourceType: 'CoverageEligibilityResponse',
  },
  'preauth/on_submit': {
    cycle: 'preauth',
    expectedMainResourceType: 'ClaimResponse',
  },
  'claim/on_submit': {
    cycle: 'claim',
    expectedMainResourceType: 'ClaimResponse',
  },
  'claim/on_status': {
    cycle: 'task',
    expectedMainResourceType: 'Task',
  },
  'communication/request': {
    cycle: 'communication',
    expectedMainResourceType: 'CommunicationRequest',
    correlationCycles: ['claim', 'preauth', 'communication'],
  },
});

function clean(value) {
  return String(value ?? '').trim();
}

function safeText(value, max = 1_000) {
  const text = clean(value);
  return text ? text.slice(0, max) : null;
}

function headerValue(headers = {}, names = []) {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

function nestedValue(body, ...keys) {
  if (!body || typeof body !== 'object') return null;
  for (const key of keys) {
    const direct = body[key];
    if (direct !== undefined && direct !== null && direct !== '') return String(direct);
    const protectedHeaders = body.protected_headers || body.protectedHeaders || body.headers;
    const nested = protectedHeaders && typeof protectedHeaders === 'object' ? protectedHeaders[key] : null;
    if (nested !== undefined && nested !== null && nested !== '') return String(nested);
  }
  return null;
}

export function extractNHCXProtocolContext({ headers = {}, body = {}, participantCodeSelf = null } = {}) {
  return {
    participantCodeSelf: safeText(
      participantCodeSelf
        || headerValue(headers, ['x-hcx-recipient_code', 'x-hcx-recipient-code', 'x-nhcx-recipient-code'])
        || nestedValue(body, 'recipient_code', 'recipientCode'),
      255,
    ),
    participantCodeCounterparty: safeText(
      headerValue(headers, ['x-hcx-sender_code', 'x-hcx-sender-code', 'x-nhcx-sender-code'])
        || nestedValue(body, 'sender_code', 'senderCode'),
      255,
    ),
    hcxApiCallId: safeText(
      headerValue(headers, ['x-hcx-api_call_id', 'x-hcx-api-call-id', 'x-request-id', 'request-id'])
        || nestedValue(body, 'x-hcx-api_call_id', 'api_call_id', 'apiCallId', 'requestId', 'request_id'),
      120,
    ),
    hcxCorrelationId: safeText(
      headerValue(headers, ['x-hcx-correlation_id', 'x-hcx-correlation-id'])
        || nestedValue(body, 'x-hcx-correlation_id', 'correlation_id', 'correlationId'),
      120,
    ),
    hcxWorkflowId: safeText(
      headerValue(headers, ['x-hcx-workflow_id', 'x-hcx-workflow-id'])
        || nestedValue(body, 'x-hcx-workflow_id', 'workflow_id', 'workflowId'),
      120,
    ),
    hcxStatus: safeText(
      headerValue(headers, ['x-hcx-status'])
        || nestedValue(body, 'hcx_status', 'status'),
      80,
    ),
  };
}

function extractCiphertext(body = {}) {
  const value = body.payload || body.jwe || body.encrypted_payload || body.encryptedPayload;
  const text = safeText(value, 2_000_000);
  if (!text) throw AppError.badRequest('NHCX callback payload is required', 'NHCX_PAYLOAD_REQUIRED');
  return text;
}

async function defaultInboundJweKeyResolver(runtime) {
  const material = clean(runtime?.credentials?.jwePrivateKey);
  if (!material) {
    throw AppError.badRequest('NHCX JWE private key is missing', 'NHCX_JWE_KEY_MISSING');
  }
  if (material.startsWith('{')) {
    const jwk = JSON.parse(material);
    const alg = jwk.alg || (jwk.kty === 'oct' ? 'dir' : 'RSA-OAEP-256');
    return {
      key: await importJWK(jwk, alg === 'dir' ? 'A256GCM' : alg),
      alg,
    };
  }
  if (material.includes('BEGIN PRIVATE KEY')) {
    return {
      key: await importPKCS8(material, 'RSA-OAEP-256'),
      alg: 'RSA-OAEP-256',
    };
  }
  if (material.includes('BEGIN PUBLIC KEY')) {
    throw AppError.badRequest('NHCX inbound decrypt requires private key material', 'NHCX_JWE_PRIVATE_KEY_REQUIRED');
  }
  return {
    key: crypto.createHash('sha256').update(material).digest(),
    alg: 'dir',
  };
}

export async function decryptNHCXCallbackPayload({
  ciphertext,
  runtime,
  jweKeyResolver = defaultInboundJweKeyResolver,
} = {}) {
  const resolved = await jweKeyResolver(runtime);
  const { plaintext, protectedHeader } = await compactDecrypt(ciphertext, resolved.key);
  const text = new TextDecoder().decode(plaintext);
  return {
    bundle: JSON.parse(text),
    protectedHeaders: protectedHeader || {},
  };
}

function resources(bundle) {
  return (bundle?.entry || []).map((item) => item.resource).filter(Boolean);
}

function firstResource(bundle, resourceType) {
  return resources(bundle).find((resource) => resource.resourceType === resourceType) || null;
}

function numberFromReference(value) {
  const match = clean(value).match(/preauth-(\d+)|insurance-preauth-id\D*(\d+)|^(\d+)$/i);
  const raw = match?.[1] || match?.[2] || match?.[3];
  return raw ? Number(raw) : null;
}

function claimNumberFromReference(value) {
  const match = clean(value).match(/claim-(\d+)|tpa-claim-id\D*(\d+)|^(\d+)$/i);
  const raw = match?.[1] || match?.[2] || match?.[3];
  return raw ? Number(raw) : null;
}

function extractPreauthIdFromClaimResponse(claimResponse) {
  if (!claimResponse) return null;
  const candidates = [
    claimResponse.request?.reference,
    claimResponse.request?.identifier?.value,
    ...(claimResponse.identifier || [])
      .filter((item) => clean(item.system).includes('preauth'))
      .map((item) => item.value),
  ];
  for (const candidate of candidates) {
    const parsed = numberFromReference(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function extractClaimIdFromClaimResponse(claimResponse) {
  if (!claimResponse) return null;
  const candidates = [
    claimResponse.request?.reference,
    claimResponse.request?.identifier?.value,
    ...(claimResponse.identifier || [])
      .filter((item) => clean(item.system).includes('tpa-claim') || clean(item.system).includes('claim-id'))
      .map((item) => item.value),
  ];
  for (const candidate of candidates) {
    const parsed = claimNumberFromReference(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function amountValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function sanctionedAmountFromClaimResponse(claimResponse) {
  const paymentAmount = amountValue(claimResponse?.payment?.amount?.value);
  if (paymentAmount != null) return paymentAmount;
  const totals = (claimResponse?.total || [])
    .map((item) => amountValue(item.amount?.value))
    .filter((value) => value != null);
  if (totals.length) return Math.max(...totals);
  const itemAmounts = (claimResponse?.item || [])
    .flatMap((item) => item.adjudication || [])
    .map((adjudication) => amountValue(adjudication.amount?.value))
    .filter((value) => value != null);
  return itemAmounts.length ? Math.max(...itemAmounts) : null;
}

function notesText(claimResponse) {
  return (claimResponse?.processNote || [])
    .map((note) => clean(note.text))
    .filter(Boolean)
    .join('\n') || null;
}

export function mapClaimResponseToPreauthResponse(claimResponse, { participantCodeCounterparty = null } = {}) {
  if (!claimResponse || claimResponse.resourceType !== 'ClaimResponse') {
    throw AppError.badRequest('NHCX preauth callback must contain ClaimResponse', 'NHCX_CLAIM_RESPONSE_REQUIRED');
  }
  const combined = [
    claimResponse.outcome,
    claimResponse.status,
    claimResponse.disposition,
    notesText(claimResponse),
  ].filter(Boolean).join(' ').toLowerCase();

  let responseType = null;
  if (/den(y|ied|ial)|reject|error/.test(combined)) responseType = 'denied';
  else if (/query|additional|information|document/.test(combined)) responseType = 'queried';
  else if (/partial|partially/.test(combined)) responseType = 'partially_approved';
  else if (/complete|approved|approve|benefit/.test(combined)) responseType = 'approved';
  if (!responseType) {
    throw AppError.badRequest('NHCX ClaimResponse outcome is not mappable', 'NHCX_CLAIM_RESPONSE_UNMAPPABLE');
  }

  const sanctionedAmount = sanctionedAmountFromClaimResponse(claimResponse);
  const details = notesText(claimResponse) || claimResponse.disposition || null;
  return {
    response_type: responseType,
    sanctioned_amount: responseType === 'approved' || responseType === 'partially_approved' ? sanctionedAmount : null,
    validity_until: claimResponse.preAuthPeriod?.end || null,
    conditions: responseType === 'approved' || responseType === 'partially_approved' ? details : null,
    query_text: responseType === 'queried' ? details : null,
    denial_reason: responseType === 'denied' ? details : null,
    raw_response: {
      insurer: participantCodeCounterparty || null,
      nhcx_claim_response: claimResponse,
    },
  };
}

export function mapClaimResponseToClaimDecision(claimResponse, {
  participantCodeCounterparty = null,
  claim = null,
} = {}) {
  if (!claimResponse || claimResponse.resourceType !== 'ClaimResponse') {
    throw AppError.badRequest('NHCX claim callback must contain ClaimResponse', 'NHCX_CLAIM_RESPONSE_REQUIRED');
  }
  if (claimResponse.use && claimResponse.use !== 'claim') {
    throw AppError.badRequest('NHCX claim callback ClaimResponse.use must be claim', 'NHCX_CLAIM_RESPONSE_USE_INVALID');
  }

  const combined = [
    claimResponse.outcome,
    claimResponse.status,
    claimResponse.disposition,
    notesText(claimResponse),
  ].filter(Boolean).join(' ').toLowerCase();
  const amount = sanctionedAmountFromClaimResponse(claimResponse);
  const claimedAmount = claim ? Number(claim.claimed_amount || 0) : 0;
  const details = notesText(claimResponse) || claimResponse.disposition || null;

  let decision = null;
  if (/query|additional|information|document|more\s+info|more-information/.test(combined)) {
    decision = 'queried';
  } else if (/den(y|ied|ial)|reject|error|declin/.test(combined)) {
    decision = 'denied';
  } else if (/partial|partially|shortfall|disallow/.test(combined)) {
    decision = 'partially_approved';
  } else if (/complete|approved|approve|benefit|adjudicat/.test(combined)) {
    decision = claimedAmount > 0 && amount != null && amount + 0.01 < claimedAmount
      ? 'partially_approved'
      : 'approved';
  }
  if (!decision) {
    throw AppError.badRequest('NHCX ClaimResponse outcome is not mappable', 'NHCX_CLAIM_RESPONSE_UNMAPPABLE');
  }

  const disallowedAmount = amount != null && claimedAmount > amount
    ? Number((claimedAmount - amount).toFixed(2))
    : null;
  return {
    decision,
    approved_amount: ['approved', 'partially_approved'].includes(decision) ? amount : null,
    disallowed_amount: decision === 'partially_approved' ? disallowedAmount : null,
    denial_reason: decision === 'denied' ? details : null,
    query_text: decision === 'queried' ? details : null,
    raw_response: {
      insurer: participantCodeCounterparty || null,
      nhcx_claim_response: claimResponse,
    },
  };
}

async function findOutboundContext({ tenantId, cycle, cycles = null, hcxCorrelationId, hcxWorkflowId }) {
  if (!hcxCorrelationId && !hcxWorkflowId) return null;
  const filters = ['tenant_id = $1::uuid', "direction = 'outbound'"];
  const params = [tenantId];
  if (Array.isArray(cycles) && cycles.length) {
    const placeholders = cycles.map((_, index) => `$${params.length + index + 1}`).join(', ');
    filters.push(`cycle IN (${placeholders})`);
    params.push(...cycles);
  } else if (cycle) {
    params.push(cycle);
    filters.push(`cycle = $${params.length}`);
  }
  if (hcxCorrelationId) {
    params.push(hcxCorrelationId);
    filters.push(`hcx_correlation_id = $${params.length}`);
  }
  if (hcxWorkflowId) {
    params.push(hcxWorkflowId);
    filters.push(`hcx_workflow_id = $${params.length}`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, claim_id, preauth_id, policy_id, patient_uid, admission_id,
            participant_code_self, participant_code_counterparty
       FROM nhcx_messages
      WHERE ${filters.join(' AND ')}
      ORDER BY CASE
                 WHEN cycle = 'claim' THEN 0
                 WHEN cycle = 'preauth' THEN 1
                 WHEN cycle = 'communication' THEN 2
                 ELSE 3
               END,
               created_at DESC
      LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

async function insertInboundEnvelope({
  tenantId,
  environment,
  endpoint,
  cycle,
  context,
  payloadHashValue,
  ciphertext,
  bundle,
  profileResult,
  domainContext = {},
  signatureVerified = false,
}) {
  const protectedHeaders = {
    'x-hcx-api_call_id': context.hcxApiCallId,
    'x-hcx-correlation_id': context.hcxCorrelationId,
    'x-hcx-workflow_id': context.hcxWorkflowId,
    sender_code: context.participantCodeCounterparty,
    recipient_code: context.participantCodeSelf,
  };
  const baseArgs = [
    tenantId,
    environment,
    cycle,
    endpoint,
    context.participantCodeSelf,
    context.participantCodeCounterparty,
    context.hcxApiCallId,
    context.hcxCorrelationId,
    context.hcxWorkflowId,
    domainContext.claimId || null,
    domainContext.preauthId || null,
    domainContext.policyId || null,
    domainContext.patientUid || null,
    domainContext.admissionId || null,
    ENDPOINTS[endpoint].expectedMainResourceType,
    bundle?.meta?.profile?.[0] || null,
    bundle?.meta?.versionId || null,
    payloadHashValue,
    JSON.stringify(protectedHeaders),
    ciphertext,
    signatureVerified === true,
    JSON.stringify(profileResult.issues || []),
    context.hcxStatus || null,
  ];

  const insertSql = `WITH ins AS (
    INSERT INTO nhcx_messages
       (tenant_id, environment, direction, cycle, endpoint,
        participant_code_self, participant_code_counterparty,
        hcx_api_call_id, hcx_correlation_id, hcx_workflow_id,
        claim_id, preauth_id, policy_id, patient_uid, admission_id,
        domain_resource_type, profile_url, profile_version, payload_hash,
        protected_headers, payload_ciphertext, signature_verified,
        validation_issues, hcx_status, status, received_at, created_at, updated_at)
     VALUES ($1::uuid, $2, 'inbound', $3, $4,
             $5, $6, $7, $8, $9,
             $10::int, $11::int, $12::int, $13::uuid, $14::int,
             $15, $16, $17, $18,
             $19::jsonb, $20, $21::boolean,
             $22::jsonb, $23, 'accepted', NOW(), NOW(), NOW())
     ON CONFLICT (tenant_id, hcx_api_call_id, environment) DO NOTHING
     RETURNING *, true AS inserted
  )
  SELECT * FROM ins
  UNION ALL
  SELECT existing.*, false AS inserted
    FROM nhcx_messages existing
   WHERE existing.tenant_id = $1::uuid
     AND existing.hcx_api_call_id = $7
     AND existing.environment = $2
     AND NOT EXISTS (SELECT 1 FROM ins)
   LIMIT 1`;

  try {
    const rows = await prisma.$queryRawUnsafe(insertSql, ...baseArgs);
    return rows[0];
  } catch (err) {
    const code = err?.meta?.code
      || err?.meta?.driverAdapterError?.cause?.originalCode
      || err?.code;
    if (code !== '23505') throw err;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT *, false AS inserted
         FROM nhcx_messages
        WHERE tenant_id = $1::uuid
          AND hcx_correlation_id = $2
          AND endpoint = $3
          AND direction = 'inbound'
          AND payload_hash = $4
          AND environment = $5
        LIMIT 1`,
      tenantId,
      context.hcxCorrelationId,
      endpoint,
      payloadHashValue,
      environment,
    );
    return rows[0];
  }
}

async function markEnvelope({ id, status, issues = [], errorMessage = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = $2,
            validation_issues = $3::jsonb,
            last_error = $4,
            processed_at = CASE WHEN $2 = 'processed' THEN NOW() ELSE processed_at END,
            updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING *`,
    String(id),
    status,
    JSON.stringify(issues || []),
    errorMessage ? safeText(errorMessage, 2_000) : null,
  );
  return rows[0] || null;
}

async function defaultRecordPreauthResponse(args) {
  const { recordPreauthResponse } = await import('../insurance/claimsService.js');
  return recordPreauthResponse(args);
}

async function defaultRecordClaimDecision(args) {
  const { recordClaimDecision } = await import('../insurance/claimsService.js');
  return recordClaimDecision(args);
}

async function defaultGetClaim(args) {
  const { getClaim } = await import('../insurance/claimsService.js');
  return getClaim(args);
}

async function processPreauthCallback({
  tenantId,
  bundle,
  context,
  outboundContext,
  recordPreauthResponseImpl = defaultRecordPreauthResponse,
}) {
  const claimResponse = firstResource(bundle, 'ClaimResponse');
  const mapped = mapClaimResponseToPreauthResponse(claimResponse, {
    participantCodeCounterparty: context.participantCodeCounterparty,
  });
  const preauthId = outboundContext?.preauth_id || extractPreauthIdFromClaimResponse(claimResponse);
  if (!preauthId) {
    throw AppError.badRequest('NHCX ClaimResponse could not be linked to a preauth', 'NHCX_PREAUTH_CONTEXT_MISSING');
  }
  const result = await recordPreauthResponseImpl({
    tenantId,
    preauth_id: Number(preauthId),
    ...mapped,
    raw_response: {
      ...mapped.raw_response,
      hcx: {
        api_call_id: context.hcxApiCallId,
        correlation_id: context.hcxCorrelationId,
        workflow_id: context.hcxWorkflowId,
      },
    },
    decided_by_tpa_user: context.participantCodeCounterparty || 'nhcx',
  });
  return { preauthId: Number(preauthId), result };
}

async function processClaimCallback({
  tenantId,
  bundle,
  context,
  outboundContext,
  recordClaimDecisionImpl = defaultRecordClaimDecision,
  getClaimImpl = defaultGetClaim,
}) {
  const claimResponse = firstResource(bundle, 'ClaimResponse');
  const claimId = outboundContext?.claim_id || extractClaimIdFromClaimResponse(claimResponse);
  if (!claimId) {
    throw AppError.badRequest('NHCX ClaimResponse could not be linked to a TPA claim', 'NHCX_CLAIM_CONTEXT_MISSING');
  }
  const claim = await getClaimImpl({ tenantId, id: Number(claimId) });
  const mapped = mapClaimResponseToClaimDecision(claimResponse, {
    participantCodeCounterparty: context.participantCodeCounterparty,
    claim,
  });
  const subject = mapped.decision === 'queried'
    ? 'NHCX claim query'
    : `NHCX claim decision: ${mapped.decision}`;
  const body = [
    `Decision: ${mapped.decision}`,
    mapped.approved_amount != null ? `Approved: ${mapped.approved_amount}` : null,
    mapped.disallowed_amount != null ? `Disallowed: ${mapped.disallowed_amount}` : null,
    mapped.denial_reason ? `Reason: ${mapped.denial_reason}` : null,
    mapped.query_text ? `Query: ${mapped.query_text}` : null,
    context.hcxApiCallId ? `HCX API call: ${context.hcxApiCallId}` : null,
    context.hcxCorrelationId ? `HCX correlation: ${context.hcxCorrelationId}` : null,
  ].filter(Boolean).join('\n');

  const result = await recordClaimDecisionImpl({
    tenantId,
    id: Number(claimId),
    decision: mapped.decision,
    approved_amount: mapped.approved_amount,
    disallowed_amount: mapped.disallowed_amount,
    denial_reason: mapped.denial_reason,
    insurer: context.participantCodeCounterparty || null,
    raw_response: {
      ...mapped.raw_response,
      hcx: {
        api_call_id: context.hcxApiCallId,
        correlation_id: context.hcxCorrelationId,
        workflow_id: context.hcxWorkflowId,
      },
    },
    recorded_by: null,
    correspondence_channel: 'nhcx',
    correspondence_subject: subject,
    correspondence_body: body,
    skip_ledger_shift: true,
  });
  return { claimId: Number(claimId), decision: mapped.decision, result };
}

export async function processNHCXCallback({
  tenantId,
  endpoint,
  body = {},
  headers = {},
  participantCodeSelf = null,
  signatureVerified = false,
  runtimeResolver = null,
  jweKeyResolver = null,
  decryptPayload = null,
  recordPreauthResponseImpl = defaultRecordPreauthResponse,
  recordClaimDecisionImpl = defaultRecordClaimDecision,
  getClaimImpl = defaultGetClaim,
} = {}) {
  const definition = ENDPOINTS[endpoint];
  if (!definition) {
    throw AppError.notFound('Unsupported NHCX callback endpoint', 'NHCX_CALLBACK_ENDPOINT_UNSUPPORTED');
  }
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');

  const context = extractNHCXProtocolContext({ headers, body, participantCodeSelf });
  if (!context.participantCodeSelf) {
    throw AppError.unauthorized('NHCX recipient participant code is required', 'NHCX_PARTICIPANT_CODE_REQUIRED');
  }
  context.hcxApiCallId = context.hcxApiCallId || context.hcxCorrelationId || `nhcx-${crypto.randomUUID()}`;

  const ciphertext = extractCiphertext(body);
  const runtime = runtimeResolver
    ? await runtimeResolver(tenantId)
    : await loadNHCXRuntimeConfig(tenantId, { forceRefresh: true });
  const decrypted = decryptPayload
    ? await decryptPayload({ ciphertext, runtime, context })
    : await decryptNHCXCallbackPayload({ ciphertext, runtime, jweKeyResolver });
  const bundle = decrypted.bundle;
  const hash = payloadHash(bundle);
  const profileResult = validateNHCXInboundBundle(bundle, {
    expectedMainResourceType: definition.expectedMainResourceType,
  });
  const outboundContext = await findOutboundContext({
    tenantId,
    cycle: definition.cycle,
    cycles: definition.correlationCycles || null,
    hcxCorrelationId: context.hcxCorrelationId,
    hcxWorkflowId: context.hcxWorkflowId,
  });
  const domainContext = {
    claimId: outboundContext?.claim_id || null,
    preauthId: outboundContext?.preauth_id || null,
    policyId: outboundContext?.policy_id || null,
    patientUid: outboundContext?.patient_uid || null,
    admissionId: outboundContext?.admission_id || null,
  };
  const envelope = await insertInboundEnvelope({
    tenantId,
    environment: runtime.environment || 'sandbox',
    endpoint,
    cycle: definition.cycle,
    context,
    payloadHashValue: hash,
    ciphertext,
    bundle,
    profileResult,
    domainContext,
    signatureVerified,
  });
  if (!envelope?.inserted) {
    return { duplicate: true, envelope, processed: false };
  }
  if ((profileResult.issues || []).length > 0) {
    const updated = await markEnvelope({
      id: envelope.id,
      status: 'manual_review',
      issues: profileResult.issues,
      errorMessage: 'NHCX inbound FHIR profile warnings require manual review',
    });
    return { duplicate: false, envelope: updated || envelope, processed: false, validation: profileResult };
  }

  try {
    let domainResult = null;
    if (endpoint === 'preauth/on_submit') {
      domainResult = await processPreauthCallback({
        tenantId,
        bundle,
        context,
        outboundContext,
        recordPreauthResponseImpl,
      });
    } else if (endpoint === 'claim/on_submit') {
      domainResult = await processClaimCallback({
        tenantId,
        bundle,
        context,
        outboundContext,
        recordClaimDecisionImpl,
        getClaimImpl,
      });
    } else if (endpoint === 'claim/on_status') {
      domainResult = { statusOnly: true, workflowMutation: false };
    } else if (endpoint === 'communication/request') {
      domainResult = await recordInboundCommunicationRequest({
        tenantId,
        bundle,
        context,
        outboundContext,
        envelope,
      });
    }
    const updated = await markEnvelope({ id: envelope.id, status: 'processed', issues: [] });
    return { duplicate: false, envelope: updated || envelope, processed: true, domainResult, validation: profileResult };
  } catch (err) {
    logger.warn('NHCX callback routed to manual review', {
      nhcx_message_id: String(envelope.id),
      tenantId,
      endpoint,
      error: err?.message,
    });
    const updated = await markEnvelope({
      id: envelope.id,
      status: 'manual_review',
      issues: profileResult.issues,
      errorMessage: err?.message || 'NHCX callback could not be mapped',
    });
    return { duplicate: false, envelope: updated || envelope, processed: false, validation: profileResult };
  }
}

export const __testing__ = {
  defaultInboundJweKeyResolver,
  extractCiphertext,
  findOutboundContext,
  firstResource,
  sanctionedAmountFromClaimResponse,
};

export default {
  decryptNHCXCallbackPayload,
  extractNHCXProtocolContext,
  mapClaimResponseToPreauthResponse,
  processNHCXCallback,
};
