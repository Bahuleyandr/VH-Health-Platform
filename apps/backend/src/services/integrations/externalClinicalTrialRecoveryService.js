import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = new Set([
  'schema',
  'sync_run_id',
  'source_partition',
  'provider_revision',
  'provider_page_token',
  'provider_page_sha256',
  'provider_page',
  'occurred_at',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'evidence',
]);

function refuse(message, code = 'I23_TRIAL_RECOVERY_INVALID', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requireText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) refuse(`${label} is invalid`);
  return text;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) refuse(`${label} must be a positive integer`);
  return parsed;
}

function requireSha256(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(text)) refuse(`${label} must be lowercase SHA-256`);
  return text;
}

function requireTimestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

export function parseI23ClinicalTrialRecoveryPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I23 clinical trial recovery payload is invalid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I23 clinical trial recovery payload must be an object');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I23 clinical trial recovery payload fields do not match the registered schema');
  }
  if (payload.schema !== 'vhhealth.i23.clinical-trial-page-owner-reconciliation/v1') {
    refuse('I23 clinical trial recovery payload schema is not registered');
  }
  const providerPage = String(payload.provider_page || '');
  if (!providerPage) refuse('provider_page is required');
  let page;
  try {
    page = JSON.parse(providerPage);
  } catch {
    refuse('provider_page is invalid JSON');
  }
  if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.studies)) {
    refuse('provider_page must contain the exact ClinicalTrials.gov studies page');
  }
  const providerPageSha256 = requireSha256(payload.provider_page_sha256, 'provider_page_sha256');
  if (sha256(Buffer.from(providerPage, 'utf8')) !== providerPageSha256) {
    refuse('provider_page_sha256 does not match exact provider page bytes');
  }
  return Object.freeze({
    schema: payload.schema,
    syncRunId: requirePositiveInteger(payload.sync_run_id, 'sync_run_id'),
    sourcePartition: requireText(payload.source_partition, 'source_partition', 160),
    providerRevision: requireText(payload.provider_revision, 'provider_revision', 64),
    providerPageToken: requireText(payload.provider_page_token, 'provider_page_token', 4096),
    providerPageSha256,
    providerPage,
    providerNextPageToken: page.nextPageToken == null
      ? null
      : requireText(page.nextPageToken, 'provider_next_page_token', 4096),
    occurredAt: requireTimestamp(payload.occurred_at, 'occurred_at'),
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I23 owner recovery command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) {
    refuse('I23 owner recovery command contains unknown fields', undefined, { unexpected });
  }
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I23 owner evidence must be a non-empty object');
  }
  return command;
}

export async function persistLateClinicalTrialPageRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  sourcePartition,
  sourcePosition,
  duplicateKey,
  occurredAt,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I23 recovery requires the canonical recovery transaction', 'I23_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I23',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I23 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const rawPayloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  if (requireSha256(input.payload_sha256, 'payload_sha256') !== rawPayloadHash) {
    refuse('I23 recovery payload hash does not match exact bytes');
  }
  const payload = parseI23ClinicalTrialRecoveryPayload(rawPayload);
  if (payload.syncRunId !== Number(sourcePosition)) {
    refuse('I23 source position must equal clinical_ai_trial_sync_runs.id');
  }
  if (payload.sourcePartition !== sourcePartition) {
    refuse('I23 source partition does not match the canonical query');
  }
  if (payload.occurredAt !== requireTimestamp(occurredAt, 'occurred_at')) {
    refuse('I23 occurred_at does not match the durable page occurrence');
  }
  const tokenSha256 = sha256(payload.providerPageToken);
  const expectedDuplicate = `i23:${payload.syncRunId}:${tokenSha256}:${payload.providerPageSha256}`;
  if (duplicateKey !== expectedDuplicate) {
    refuse('I23 duplicate key does not match immutable provider-page evidence');
  }

  const candidates = await tx.$queryRawUnsafe(
    `SELECT id, status, provider_page_complete, source_partition,
            provider_page_token, provider_page_token_sha256::text,
            provider_next_page_token, provider_revision,
            provider_page_sha256::text, started_at::text,
            recovery_inbox_id::text
       FROM clinical_ai_trial_sync_runs
      WHERE tenant_id = $1::uuid AND id = $2::integer
      FOR UPDATE`,
    tid,
    payload.syncRunId,
  );
  const candidate = candidates[0];
  if (!candidate
      || candidate.status !== 'failed'
      || candidate.provider_page_complete
      || candidate.recovery_inbox_id
      || candidate.source_partition !== payload.sourcePartition
      || candidate.provider_page_token !== payload.providerPageToken
      || candidate.provider_page_token_sha256 !== tokenSha256
      || candidate.provider_revision !== payload.providerRevision
      || candidate.provider_page_sha256 !== payload.providerPageSha256
      || candidate.provider_next_page_token !== payload.providerNextPageToken
      || new Date(candidate.started_at).toISOString() !== payload.occurredAt) {
    refuse('I23 provider page is not eligible for exact owner recovery');
  }

  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const rows = await tx.$queryRawUnsafe(
    `UPDATE clinical_ai_trial_sync_runs
        SET recovery_inbox_id = $3::uuid,
            recovery_interface_family = 'I23',
            recovery_owner_uid = $4::uuid,
            recovery_owner_reason = $5::text,
            recovery_evidence = $6::jsonb,
            effect_disposition = 'late_pending_only'
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND status = 'failed' AND NOT provider_page_complete
        AND recovery_inbox_id IS NULL
      RETURNING id, status, source_partition, sync_session_id::text,
                provider_page_number, provider_page_token,
                provider_revision, provider_page_sha256::text,
                provider_page_complete, recovery_inbox_id::text,
                effect_disposition, started_at`,
    tid,
    payload.syncRunId,
    inboxId,
    actorUid,
    ownerReason,
    JSON.stringify({
      ...input.evidence,
      recovery_payload_sha256: rawPayloadHash,
      exact_provider_page_byte_parity_verified: true,
      provider_revision_verified: true,
      provider_token_verified: true,
      status_is_not_hwm: true,
      upsert_coverage_is_not_hwm: true,
      provider_page_applied: false,
      late_release_executor_present: false,
    }),
  );
  const receipt = rows[0];
  if (!receipt) refuse('I23 recovery claim was lost');

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review held ClinicalTrials.gov page ${payload.syncRunId}`,
    description: 'The exact provider page was bound to recovery evidence and held. No catalog upsert or continuation release was performed.',
    relatedResourceType: 'clinical_ai_trial_sync_run',
    relatedResourceId: String(payload.syncRunId),
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I23',
      recovery_inbox_id: inboxId,
      source_partition: payload.sourcePartition,
      provider_revision: payload.providerRevision,
      provider_page_token_sha256: tokenSha256,
      provider_page_sha256: payload.providerPageSha256,
      provider_page_applied: false,
      late_release_executor_present: false,
      target_domain_effect_performed: false,
    },
  });

  return Object.freeze({
    receipt: Object.freeze(receipt),
    task,
    outcomeCode: 'i23_trial_page_pending_owner_reconciliation',
    recoveryCursorAction: 'pause',
  });
}

export default Object.freeze({
  parseI23ClinicalTrialRecoveryPayload,
  persistLateClinicalTrialPageRecovery,
});
