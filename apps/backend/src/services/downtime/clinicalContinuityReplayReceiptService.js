import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { evaluateClinicalContinuityActionRequest } from './clinicalContinuityActionRegistryService.js';
import {
  CLINICAL_CONTINUITY_PRIVATE_DRAFT_EFFECT,
  resolveClinicalContinuityActionBinding
} from './clinicalContinuityActionBindingRegistry.js';
import { resolveMergedPatientUidSet } from '../clinical/mergedPatientReadUnion.js';
import { hashCanonicalValue } from './continuityPackCanonical.js';
import { loadClinicalContinuityDeviceLossRouteTx } from './clinicalContinuityDeviceLossService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERIALIZABLE_ATTEMPTS = 3;

class ReplaySerializationRetryError extends Error {
  constructor() {
    super('Clinical continuity receipt owner was not visible in this serializable snapshot');
    this.code = '40001';
  }
}

function sqlState(error) {
  return (
    error?.meta?.code ||
    error?.meta?.driverAdapterError?.cause?.originalCode ||
    error?.cause?.code ||
    error?.code
  );
}

function isSerializationFailure(error) {
  return ['40001', 'P2034'].includes(sqlState(error));
}

function reviewError(code = 'CONTINUITY_REPLAY_NEEDS_REVIEW', details = {}) {
  return AppError.conflict('Clinical continuity replay requires manual review', code, {
    decision: 'needs_review',
    safe: true,
    ...details
  });
}

function committedReview(code, details = null) {
  return Object.freeze({ reviewCode: code, reviewDetails: details });
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function idempotencyKeyHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeUuid(value) {
  const normalized = String(value || '').toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function typedOutcome(row, { replayed }) {
  if (!row.note_draft_id) {
    return Object.freeze({
      client_event_id: row.client_event_id,
      disposition: 'already_applied',
      replayed
    });
  }
  return Object.freeze({
    client_event_id: row.client_event_id,
    disposition: 'applied',
    outcome: 'draft_stored',
    replayed,
    resource: Object.freeze({
      note_draft_id: String(row.note_draft_id),
      revision: String(row.draft_revision),
      updated_at: iso(row.draft_updated_at)
    })
  });
}

async function appendAttemptTx(
  tx,
  {
    tenantId,
    clientEventId,
    receiptLinked = false,
    replayActorUid,
    replayRole,
    facilityContext,
    requestId,
    attemptClass,
    reasonCode,
    result,
    idempotencyKey
  }
) {
  await tx.$executeRawUnsafe(
    `INSERT INTO clinical_continuity_replay_attempts (
       tenant_id, client_event_id, receipt_client_event_id,
       replay_actor_uid, replay_role, facility_context_id,
       facility_context_revision, request_id, attempt_class,
       reason_code, result, idempotency_key_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4::uuid, $5, $6::uuid,
       $7::bigint, $8::uuid, $9,
       $10, $11, $12
     )`,
    tenantId,
    clientEventId,
    receiptLinked ? clientEventId : null,
    safeUuid(replayActorUid),
    replayRole || null,
    safeUuid(facilityContext?.contextId),
    facilityContext?.contextRevision ?? null,
    safeUuid(requestId),
    attemptClass,
    reasonCode,
    result,
    idempotencyKey ? idempotencyKeyHash(idempotencyKey) : null
  );
}

async function loadReceiptTx(tx, tenantId, clientEventId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT receipt.client_event_id::text,
            receipt.original_idempotency_key,
            receipt.receipt_fingerprint,
            receipt.action_id,
            receipt.facility_id,
            receipt.capture_actor_uid::text,
            receipt.patient_uid::text,
            receipt.disposition,
            receipt.outcome_code,
            receipt.recorded_at,
            effect.note_draft_id,
            effect.draft_revision,
            effect.draft_updated_at
       FROM clinical_continuity_replay_receipts AS receipt
       LEFT JOIN clinical_continuity_replay_effect_evidence AS effect
         ON effect.tenant_id = receipt.tenant_id
        AND effect.client_event_id = receipt.client_event_id
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.client_event_id = $2::uuid
      LIMIT 1`,
    tenantId,
    clientEventId
  );
  return rows[0] || null;
}

async function resolveExistingReceiptTx(
  tx,
  { tenantId, parsed, replayActorUid, replayRole, facilityContext, requestId }
) {
  const envelope = parsed.envelope;
  const row = await loadReceiptTx(tx, tenantId, envelope.client_event_id);
  if (!row) return null;
  // Merged-uid union: clinical_continuity_replay_receipts is excluded from
  // the patient-merge FK sweep (append-only, fail-closed RLS), so a receipt
  // recorded before a merge keeps the merged-away patient uid. A replay
  // referencing the surviving patient must still recognise that receipt as
  // its own.
  const envelopePatientUids = await resolveMergedPatientUidSet(tx, {
    tenantId,
    patientUid: envelope.patient_reference,
  });
  // Non-uuid / absent patient references resolve to an empty set; keep the
  // original strict equality for those so the semantics only widen for real
  // merged-uid chains.
  const patientMatches = envelopePatientUids.length
    ? envelopePatientUids.includes(row.patient_uid)
    : row.patient_uid === envelope.patient_reference;
  const targetAuthorized =
    row.action_id === envelope.action_id &&
    Number(row.facility_id) === envelope.facility_id &&
    row.capture_actor_uid === replayActorUid &&
    patientMatches;
  if (!targetAuthorized) {
    await appendAttemptTx(tx, {
      tenantId,
      clientEventId: envelope.client_event_id,
      replayActorUid,
      replayRole,
      facilityContext,
      requestId,
      attemptClass: 'receipt_probe',
      reasonCode: 'CONTINUITY_REPLAY_RECEIPT_NOT_AUTHORIZED',
      result: 'denied',
      idempotencyKey: envelope.idempotency_key
    });
    return committedReview('CONTINUITY_REPLAY_NOT_AUTHORIZED');
  }
  if (row.original_idempotency_key !== envelope.idempotency_key) {
    await appendAttemptTx(tx, {
      tenantId,
      clientEventId: envelope.client_event_id,
      receiptLinked: true,
      replayActorUid,
      replayRole,
      facilityContext,
      requestId,
      attemptClass: 'identity_mismatch',
      reasonCode: 'CONTINUITY_REPLAY_IDEMPOTENCY_IDENTITY_MISMATCH',
      result: 'needs_review',
      idempotencyKey: envelope.idempotency_key
    });
    return committedReview('CONTINUITY_REPLAY_IDEMPOTENCY_IDENTITY_MISMATCH');
  }
  if (row.receipt_fingerprint !== parsed.receiptFingerprint) {
    await appendAttemptTx(tx, {
      tenantId,
      clientEventId: envelope.client_event_id,
      receiptLinked: true,
      replayActorUid,
      replayRole,
      facilityContext,
      requestId,
      attemptClass: 'fingerprint_mismatch',
      reasonCode: 'CONTINUITY_REPLAY_FINGERPRINT_MISMATCH',
      result: 'needs_review',
      idempotencyKey: envelope.idempotency_key
    });
    return committedReview('CONTINUITY_REPLAY_FINGERPRINT_MISMATCH');
  }
  if (row.disposition !== 'applied') {
    await appendAttemptTx(tx, {
      tenantId,
      clientEventId: envelope.client_event_id,
      receiptLinked: true,
      replayActorUid,
      replayRole,
      facilityContext,
      requestId,
      attemptClass: 'manual_review_return',
      reasonCode: row.outcome_code || 'CONTINUITY_REPLAY_NEEDS_REVIEW',
      result: 'needs_review',
      idempotencyKey: envelope.idempotency_key
    });
    return committedReview(row.outcome_code || 'CONTINUITY_REPLAY_NEEDS_REVIEW');
  }
  await appendAttemptTx(tx, {
    tenantId,
    clientEventId: envelope.client_event_id,
    receiptLinked: true,
    replayActorUid,
    replayRole,
    facilityContext,
    requestId,
    attemptClass: row.note_draft_id ? 'duplicate_lookup' : 'tombstone_lookup',
    reasonCode: row.note_draft_id
      ? 'CONTINUITY_REPLAY_EXACT_DUPLICATE'
      : 'CONTINUITY_REPLAY_ALREADY_APPLIED',
    result: 'duplicate',
    idempotencyKey: envelope.idempotency_key
  });
  return typedOutcome(row, { replayed: true });
}

export async function precheckClinicalContinuityReplay(input) {
  const result = await setTenantTx(input.tenantId, tx => resolveExistingReceiptTx(tx, input), {
    isolationLevel: 'RepeatableRead'
  });
  if (result?.reviewCode) throw reviewError(result.reviewCode);
  return result;
}

async function recheckFacilityTx(tx, { tenantId, replayActorUid, facilityContext }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT 1
       FROM clinical_continuity_edge_access_grants AS grant_row
       JOIN user_devices AS device
         ON device.tenant_id = grant_row.tenant_id
        AND device.user_uid = $2::uuid
        AND device.device_id = grant_row.device_id
        AND device.facility_id = grant_row.facility_id
        AND device.continuity_grant_id = grant_row.id
        AND device.continuity_grant_purpose = grant_row.grant_purpose
        AND device.continuity_capture_revision = grant_row.capture_revision
        AND device.continuity_context_id = $5::uuid
        AND device.continuity_context_revision = $6::bigint
        AND device.continuity_session_jti_sha256 = $7
        AND device.continuity_validation_state = 'active'
        AND device.continuity_expires_at > clock_timestamp()
       LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
         ON revocation.tenant_id = grant_row.tenant_id
        AND revocation.facility_id = grant_row.facility_id
        AND revocation.grant_id = grant_row.id
        AND revocation.grant_purpose = grant_row.grant_purpose
      WHERE grant_row.tenant_id = $1::uuid
        AND grant_row.facility_id = $3::integer
        AND grant_row.id = $4::uuid
        AND grant_row.device_id = $8
        AND grant_row.valid_from <= clock_timestamp()
        AND grant_row.valid_until > clock_timestamp()
        AND revocation.id IS NULL
        AND (
          grant_row.grant_purpose = 'capture_fixed_device'
          OR (
            grant_row.grant_purpose = 'capture_staff_facility'
            AND grant_row.staff_uid = $2::uuid
          )
        )
      LIMIT 1
      FOR SHARE OF grant_row`,
    tenantId,
    replayActorUid,
    facilityContext.facilityId,
    facilityContext.grantId,
    facilityContext.contextId,
    facilityContext.contextRevision,
    facilityContext.sessionJtiSha256,
    facilityContext.deviceId
  );
  if (rows.length !== 1) throw reviewError('CONTINUITY_REPLAY_FACILITY_RECHECK_FAILED');
}

async function recheckPatientTx(tx, { tenantId, patientUid, appointmentId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT patient.id
       FROM users AS patient
       LEFT JOIN appointments AS appointment
         ON appointment.tenant_id = patient.tenant_id
        AND appointment.id = $3::integer
        AND appointment.patient_id = patient.id
      WHERE patient.tenant_id = $1::uuid
        AND patient.uid = $2::uuid
        AND patient.role = 'PATIENT'
        AND ($3::integer IS NULL OR appointment.id IS NOT NULL)
      LIMIT 1
      FOR SHARE OF patient`,
    tenantId,
    patientUid,
    appointmentId
  );
  if (rows.length !== 1) throw reviewError('CONTINUITY_REPLAY_TARGET_RECHECK_FAILED');
  return Number(rows[0].id);
}

async function assertNoForbiddenEffectsTx(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*) FROM clinical_timeline_events
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       + (SELECT COUNT(*) FROM clinical_audit_events
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       + (SELECT COUNT(*) FROM workflow_sla_instances
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       + (SELECT COUNT(*) FROM notification_outbox
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       + (SELECT COUNT(*) FROM event_outbox
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       + (SELECT COUNT(*) FROM care_pathway_transition_events
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       + (SELECT COUNT(*) FROM tasks
         WHERE tenant_id = $1::uuid AND xmin = (txid_current()::text)::xid)
       AS forbidden_effects`,
    tenantId
  );
  if (Number(rows[0]?.forbidden_effects || 0) !== 0) {
    throw new Error('Private draft replay produced a forbidden clinical effect');
  }
}

function receiptRecord({ tenantId, parsed, binding, targetPatientId }) {
  const envelope = parsed.envelope;
  return {
    tenant_id: tenantId,
    client_event_id: envelope.client_event_id,
    source_kind: parsed.sourceKind,
    facility_id: envelope.facility_id,
    incident_id: envelope.incident_id,
    paper_item_id: null,
    original_idempotency_key: envelope.idempotency_key,
    action_id: envelope.action_id,
    binding_id: binding.bindingId,
    http_method: binding.method,
    schema_id: binding.schemaRecord.id,
    schema_version: binding.schemaRecord.version,
    schema_checksum: binding.schemaRecord.checksum,
    client_command_fingerprint: envelope.command_fingerprint,
    receipt_fingerprint: parsed.receiptFingerprint,
    payload_hash: parsed.payloadHash,
    capture_actor_uid: envelope.capture_actor_uuid,
    capture_role: envelope.capture_role,
    patient_id: targetPatientId,
    patient_uid: envelope.patient_reference,
    appointment_id: envelope.appointment_id,
    encounter_id: envelope.encounter_id,
    admission_id: envelope.admission_id,
    unit_id: envelope.unit_id,
    device_id: envelope.device_id,
    device_posture: envelope.device_posture,
    capture_session_id: envelope.capture_session_id,
    occurred_at: envelope.occurred_at,
    captured_at: envelope.captured_at,
    queued_at: envelope.queued_at,
    expires_at: envelope.expires_at,
    clock_evidence_hash: hashCanonicalValue(envelope.clock_evidence),
    cached_sources_hash: hashCanonicalValue(envelope.cached_sources),
    source_cache_version: envelope.source_cache_version,
    app_version: envelope.app_version,
    envelope_schema_version: envelope.envelope_schema_version,
    queue_schema_version: envelope.queue_schema_version,
    action_version: envelope.action_version,
    action_checksum: envelope.action_checksum,
    policy_id: envelope.policy_id,
    policy_version: envelope.policy_version,
    policy_checksum: envelope.policy_checksum,
    policy_signing_key_id: envelope.policy_signing_key_id,
    policy_effective_from: envelope.policy_effective_from,
    policy_effective_until: envelope.policy_effective_until,
    policy_supersedes_id: envelope.policy_supersedes_id,
    policy_revocation_epoch: envelope.policy_revocation_epoch,
    registry_version: envelope.registry_version,
    registry_checksum: envelope.registry_checksum,
    minimum_app_version: envelope.minimum_app_version,
    base_revision: envelope.base_revision,
    base_etag: envelope.base_etag,
    ordering_key: envelope.ordering_key,
    ordering_key_digest: envelope.ordering_key_digest,
    sequence_no: envelope.sequence,
    predecessor_client_event_id: envelope.predecessor_client_event_id,
    supersession_generation: envelope.supersession_generation,
    human_review_required: envelope.human_review_required
  };
}

async function claimReceiptTx(tx, input) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT clinical_continuity_replay_receipt_claim($1::uuid, $2::jsonb) AS claimed`,
    input.tenantId,
    JSON.stringify(receiptRecord(input))
  );
  return rows[0]?.claimed === true;
}

async function finalizeReceiptTx(tx, tenantId, clientEventId, disposition, outcomeCode) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT clinical_continuity_replay_receipt_finalize(
       $1::uuid, $2::uuid, $3::varchar, $4::varchar
     ) AS finalized`,
    tenantId,
    clientEventId,
    disposition,
    outcomeCode
  );
  if (rows[0]?.finalized !== true) {
    throw new Error('Clinical continuity receipt finalization failed');
  }
}

async function appendPostRollbackAttempt(input, { attemptClass, reasonCode, result }) {
  try {
    await setTenantTx(input.tenantId, tx =>
      appendAttemptTx(tx, {
        ...input,
        clientEventId: input.parsed.envelope.client_event_id,
        attemptClass,
        reasonCode,
        result,
        idempotencyKey: input.parsed.envelope.idempotency_key
      })
    );
  } catch (error) {
    throw new AggregateError(
      [input.originalError, error],
      'Replay transaction and failure-attempt persistence both failed'
    );
  }
}

export async function applyClinicalContinuityReplay(input) {
  const envelope = input.parsed.envelope;
  let result;
  try {
    for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        result = await setTenantTx(
          input.tenantId,
          async tx => {
            const deviceLossRoute = await loadClinicalContinuityDeviceLossRouteTx(tx, {
              tenantId: input.tenantId,
              stableDeviceId: envelope.device_id,
              facilityId: input.facilityContext.facilityId
            });
            if (deviceLossRoute) {
              await appendAttemptTx(tx, {
                ...input,
                clientEventId: envelope.client_event_id,
                receiptLinked: false,
                attemptClass: 'lost_device_route',
                reasonCode: 'CONTINUITY_REPLAY_DEVICE_LOSS_NEEDS_REVIEW',
                result: 'needs_review',
                idempotencyKey: envelope.idempotency_key
              });
              return committedReview('CONTINUITY_REPLAY_DEVICE_LOSS_NEEDS_REVIEW', {
                fallback_principal: deviceLossRoute.fallback_principal,
                assigned_to_uid: deviceLossRoute.assigned_to_uid,
                device_loss_operation_id: deviceLossRoute.operation_id
              });
            }
            await recheckFacilityTx(tx, input);
            const targetPatientId = await recheckPatientTx(tx, {
              tenantId: input.tenantId,
              patientUid: envelope.patient_reference,
              appointmentId: envelope.appointment_id
            });
            const binding = resolveClinicalContinuityActionBinding({
              actionId: envelope.action_id,
              method: input.binding.method,
              path: input.binding.fullRoutePath
            });
            if (
              !binding ||
              binding !== input.binding ||
              binding.transactionalHandler !== input.binding.transactionalHandler ||
              binding.effectContract !== CLINICAL_CONTINUITY_PRIVATE_DRAFT_EFFECT
            ) {
              throw reviewError('CONTINUITY_REPLAY_BINDING_RECHECK_FAILED');
            }
            const policyResult = await evaluateClinicalContinuityActionRequest({
              tenantId: input.tenantId,
              facilityId: input.facilityContext.facilityId,
              capturedPolicyId: input.authorization.authorityClaims.policyId,
              capturedPolicyVersion: input.authorization.authorityClaims.policyVersion,
              requestContext: input.authorization.requestContext,
              scopeRunner: async (_tenantId, callback) => callback(tx)
            });
            if (!policyResult.proceed) {
              throw reviewError(policyResult.reasonCode);
            }
            const claimed = await claimReceiptTx(tx, {
              ...input,
              binding,
              targetPatientId
            });
            if (!claimed) {
              const existing = await resolveExistingReceiptTx(tx, input);
              if (!existing) throw new ReplaySerializationRetryError();
              return existing;
            }

            let draft;
            try {
              draft = await binding.transactionalHandler(
                tx,
                {
                  tenantId: input.tenantId,
                  authorUid: envelope.capture_actor_uuid,
                  patientUid: envelope.patient_reference,
                  appointmentId: envelope.appointment_id,
                  noteType: input.body.note_type,
                  content: input.body.content
                },
                { baseRevision: envelope.base_revision }
              );
            } catch (error) {
              if (error?.code !== 'CONTINUITY_REPLAY_CONCURRENCY_NEEDS_REVIEW') throw error;
              await appendAttemptTx(tx, {
                ...input,
                clientEventId: envelope.client_event_id,
                receiptLinked: true,
                attemptClass: 'concurrency_conflict',
                reasonCode: error.code,
                result: 'needs_review',
                idempotencyKey: envelope.idempotency_key
              });
              await finalizeReceiptTx(
                tx,
                input.tenantId,
                envelope.client_event_id,
                'needs_review',
                error.code
              );
              return { reviewCode: error.code };
            }
            await tx.$executeRawUnsafe(
              `INSERT INTO clinical_continuity_replay_effect_evidence (
             tenant_id, client_event_id, note_draft_id, outcome_code,
             draft_revision, draft_updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'draft_stored', $4::bigint, $5::timestamptz)`,
              input.tenantId,
              envelope.client_event_id,
              draft.id,
              draft.revision,
              draft.updated_at
            );
            await appendAttemptTx(tx, {
              ...input,
              clientEventId: envelope.client_event_id,
              receiptLinked: true,
              attemptClass: 'first_apply',
              reasonCode: 'CONTINUITY_REPLAY_DRAFT_STORED',
              result: 'applied',
              idempotencyKey: envelope.idempotency_key
            });
            await assertNoForbiddenEffectsTx(tx, input.tenantId);
            await finalizeReceiptTx(
              tx,
              input.tenantId,
              envelope.client_event_id,
              'applied',
              'draft_stored'
            );
            return typedOutcome(
              {
                client_event_id: envelope.client_event_id,
                note_draft_id: draft.id,
                draft_revision: draft.revision,
                draft_updated_at: draft.updated_at
              },
              { replayed: false }
            );
          },
          { isolationLevel: 'Serializable' }
        );
        break;
      } catch (error) {
        if (attempt < SERIALIZABLE_ATTEMPTS && isSerializationFailure(error)) continue;
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof AppError) {
      await appendPostRollbackAttempt(
        { ...input, originalError: error },
        {
          attemptClass: 'transaction_review',
          reasonCode: error.code,
          result: error.details?.decision === 'deny' ? 'denied' : 'needs_review'
        }
      );
      throw error;
    }
    await appendPostRollbackAttempt(
      { ...input, originalError: error },
      {
        attemptClass: 'transaction_failure',
        reasonCode: error?.code || 'CONTINUITY_REPLAY_TRANSACTION_FAILED',
        result: 'failed'
      }
    );
    throw error;
  }
  if (result?.reviewCode) throw reviewError(result.reviewCode, result.reviewDetails || {});
  return result;
}

export const __testing__ = Object.freeze({
  receiptRecord,
  typedOutcome
});
