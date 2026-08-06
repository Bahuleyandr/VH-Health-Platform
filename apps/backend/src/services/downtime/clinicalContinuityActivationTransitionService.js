import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const SERIALIZABLE_ATTEMPTS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sqlState(error) {
  return (
    error?.meta?.code
    || error?.meta?.driverAdapterError?.cause?.originalCode
    || error?.cause?.code
    || error?.code
  );
}

function isRetryable(error) {
  return ['23505', '40001', 'P2002', 'P2034'].includes(sqlState(error));
}

async function runSerializableCommand(tenantId, command) {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await setTenantTx(tenantId, command, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (attempt < SERIALIZABLE_ATTEMPTS && isRetryable(error)) continue;
      throw error;
    }
  }
  throw AppError.internal(
    'Activation transition serializable retry exhausted',
    'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_RETRY_EXHAUSTED',
  );
}

function normalizedRole(value) {
  return String(value || '').trim().toUpperCase();
}

function requiredUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw AppError.badRequest(
      `${label} must be a UUID`,
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_INPUT_INVALID',
      { safe: true },
    );
  }
  return normalized;
}

function requiredFacilityId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw AppError.badRequest(
      'facility_id must be a positive integer',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_INPUT_INVALID',
      { safe: true },
    );
  }
  return normalized;
}

function idempotencyIdentity(value) {
  const normalized = String(value || '').trim();
  if (!isValidIdempotencyKey(normalized)) {
    throw AppError.badRequest(
      'A valid Idempotency-Key is required',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_IDEMPOTENCY_KEY_REQUIRED',
      { safe: true },
    );
  }
  return Object.freeze({
    sha256: createHash('sha256').update(normalized, 'utf8').digest('hex'),
  });
}

function deterministicUuid(value) {
  const chars = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadCurrentStaffTx(tx, { tenantId, actorUid, authenticatedRole }) {
  const uid = requiredUuid(actorUid, 'actor_uid');
  const claimedRole = normalizedRole(authenticatedRole);
  if (!claimedRole || claimedRole === 'PATIENT') {
    throw AppError.forbidden(
      'Activation transition requires authenticated staff',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_FORBIDDEN',
      { safe: true },
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text, UPPER(BTRIM(role)) AS role
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
        AND is_active = TRUE AND is_deleted = FALSE AND status = 'active'
        AND UPPER(BTRIM(role)) <> 'PATIENT'
      LIMIT 2
      FOR SHARE`,
    tenantId,
    uid,
  );
  const role = normalizedRole(rows[0]?.role);
  if (rows.length !== 1 || role !== claimedRole) {
    throw AppError.forbidden(
      'Current staff authority could not be verified',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_FORBIDDEN',
      { safe: true },
    );
  }
  return Object.freeze({ uid, role });
}

async function requiredAudit(tx, input) {
  const row = await recordClinicalAuditEvent(input, { db: tx });
  if (!row) {
    throw AppError.internal(
      'Activation transition clinical audit evidence was not recorded',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_AUDIT_REQUIRED',
    );
  }
  return row;
}

function translateDatabaseError(error) {
  if (error instanceof AppError) return error;
  const code = sqlState(error);
  const message = String(error?.message || '');
  if (code === '42501') {
    return AppError.forbidden(
      'Activation transition roster authority was not verified',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_AUTHORITY_REQUIRED',
      { safe: true },
    );
  }
  if (code === '40001' || message.includes('fingerprint changed')) {
    return AppError.conflict(
      'Activation state changed; refresh the fingerprint before retrying',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_STATE_DRIFT',
      { safe: true },
    );
  }
  if (code === '23505') {
    return AppError.conflict(
      'Activation transition identity drifted or was already consumed',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_IDEMPOTENCY_DRIFT',
      { safe: true },
    );
  }
  if (code === '23503') {
    return AppError.notFound(
      'Activation transition authority record was not found',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_NOT_FOUND',
      { safe: true },
    );
  }
  if (code === '23514') {
    const evidence = /evidence|shadow duration|clean drill/i.test(message);
    return AppError.conflict(
      evidence
        ? 'Activation evidence gate is not satisfied'
        : 'Activation policy is not eligible for the requested transition',
      evidence
        ? 'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_EVIDENCE_REQUIRED'
        : 'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_POLICY_INELIGIBLE',
      { safe: true },
    );
  }
  return error;
}

async function currentStateTx(tx, tenantId, facilityId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT public.clinical_continuity_activation_state_snapshot(
       $1::uuid, $2::integer
     ) AS state`,
    tenantId,
    facilityId,
  );
  if (!rows[0]?.state) {
    throw AppError.internal(
      'Activation transition state snapshot was unavailable',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_STATE_UNAVAILABLE',
    );
  }
  return rows[0].state;
}

async function loadPriorCommandTx(tx, { tenantId, idempotencyKeySha256 }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, action, actor_uid::text, roster_entry_id::text,
            intent_event_id::text, expected_state_fingerprint,
            reason_code, reason_detail, evidence_references, receipt
       FROM clinical_continuity_activation_transition_events
      WHERE tenant_id = $1::uuid
        AND idempotency_key_sha256 = $2::text
        AND outcome = 'applied'
      LIMIT 2
      FOR SHARE`,
    tenantId,
    idempotencyKeySha256,
  );
  return rows;
}

function exactDuplicate(rows, expected) {
  if (rows.length === 0) return null;
  const evidenceMatches = !Object.hasOwn(expected, 'evidenceReferences')
    || JSON.stringify(rows[0].evidence_references) === JSON.stringify(expected.evidenceReferences);
  const exact = rows.length === 1
    && rows[0].id === expected.eventId
    && rows[0].action === expected.action
    && rows[0].actor_uid === expected.actorUid
    && rows[0].roster_entry_id === expected.rosterEntryId
    && rows[0].intent_event_id === (expected.intentEventId || null)
    && rows[0].expected_state_fingerprint === expected.expectedStateFingerprint
    && rows[0].reason_code === expected.reasonCode
    && rows[0].reason_detail === expected.reasonDetail
    && evidenceMatches;
  if (!exact) {
    throw AppError.conflict(
      'Activation transition idempotency identity drifted',
      'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_IDEMPOTENCY_DRIFT',
      { safe: true },
    );
  }
  return Object.freeze({ ...rows[0].receipt, disposition: 'exact_duplicate' });
}

export async function getClinicalContinuityActivationState({
  tenantId,
  actorUid,
  actorRole,
  facilityId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const fid = requiredFacilityId(facilityId);
  try {
    return await setTenantTx(tid, async tx => {
      await loadCurrentStaffTx(tx, {
        tenantId: tid,
        actorUid,
        authenticatedRole: actorRole,
      });
      return currentStateTx(tx, tid, fid);
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

export async function createClinicalContinuityAdvanceIntent({
  tenantId,
  actorUid,
  actorRole,
  requestId = null,
  idempotencyKey,
  facilityId,
  parsed,
} = {}) {
  const tid = requireTenantId(tenantId);
  const fid = requiredFacilityId(facilityId);
  const requestIdentity = idempotencyIdentity(idempotencyKey);
  const eventId = deterministicUuid(`cc-activation:${tid}:${requestIdentity.sha256}`);
  try {
    return await runSerializableCommand(tid, async tx => {
      const actor = await loadCurrentStaffTx(tx, {
        tenantId: tid,
        actorUid,
        authenticatedRole: actorRole,
      });
      const rows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_activation_advance_intent($1::jsonb) AS receipt`,
        JSON.stringify({
          tenant_id: tid,
          facility_id: fid,
          event_id: eventId,
          actor_uid: actor.uid,
          actor_role: actor.role,
          target_policy_id: parsed.targetPolicyId,
          roster_entry_id: parsed.rosterEntryId,
          evidence_gate_config_id: parsed.evidenceGateConfigId,
          expected_state_fingerprint: parsed.expectedStateFingerprint,
          evidence_references: parsed.evidenceReferences,
          idempotency_key_sha256: requestIdentity.sha256,
          reason_code: parsed.reasonCode,
          reason_detail: parsed.reasonDetail,
          request_id: requestId,
        }),
      );
      return rows[0]?.receipt;
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

export async function countersignClinicalContinuityAdvance({
  tenantId,
  actorUid,
  actorRole,
  requestId = null,
  idempotencyKey,
  facilityId,
  intentEventId,
  parsed,
} = {}) {
  const tid = requireTenantId(tenantId);
  const fid = requiredFacilityId(facilityId);
  const intentId = requiredUuid(intentEventId, 'intent_event_id');
  const requestIdentity = idempotencyIdentity(idempotencyKey);
  const eventId = deterministicUuid(`cc-activation:${tid}:${requestIdentity.sha256}`);
  try {
    return await runSerializableCommand(tid, async tx => {
      const actor = await loadCurrentStaffTx(tx, {
        tenantId: tid,
        actorUid,
        authenticatedRole: actorRole,
      });
      const prior = exactDuplicate(
        await loadPriorCommandTx(tx, {
          tenantId: tid,
          idempotencyKeySha256: requestIdentity.sha256,
        }),
        {
          eventId,
          action: 'advance',
          actorUid: actor.uid,
          rosterEntryId: parsed.rosterEntryId,
          intentEventId: intentId,
          expectedStateFingerprint: parsed.expectedStateFingerprint,
          reasonCode: parsed.reasonCode,
          reasonDetail: parsed.reasonDetail,
        },
      );
      if (prior) return prior;
      const intents = await tx.$queryRawUnsafe(
        `SELECT id::text, prior_state, next_state, target_policy_id::text,
                expected_state_fingerprint
           FROM clinical_continuity_activation_transition_events
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND id = $3::uuid AND action = 'advance'
            AND outcome = 'awaiting_counterkey'
          LIMIT 2
          FOR SHARE`,
        tid,
        fid,
        intentId,
      );
      if (intents.length !== 1) {
        throw AppError.notFound(
          'Advance intent not found',
          'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_NOT_FOUND',
          { safe: true },
        );
      }
      if (intents[0].expected_state_fingerprint !== parsed.expectedStateFingerprint) {
        throw AppError.conflict(
          'Advance intent fingerprint does not match',
          'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_STATE_DRIFT',
          { safe: true },
        );
      }
      const audit = await requiredAudit(tx, {
        tenantId: tid,
        action: 'clinical_continuity.activation.advance_applied',
        actorUid: actor.uid,
        actorRole: actor.role,
        resourceType: 'clinical_continuity_activation_transition_event',
        resourceTable: 'clinical_continuity_activation_transition_events',
        resourceId: eventId,
        requestId,
        beforeState: intents[0].prior_state,
        afterState: {
          ...intents[0].next_state,
          event_id: eventId,
          intent_event_id: intentId,
          target_policy_id: intents[0].target_policy_id,
          expected_state_fingerprint: parsed.expectedStateFingerprint,
        },
        idempotencyKey: `clinical-continuity-activation-advance:${intentId}`,
      });
      const rows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_activation_advance_countersign(
           $1::jsonb
         ) AS receipt`,
        JSON.stringify({
          tenant_id: tid,
          facility_id: fid,
          event_id: eventId,
          intent_event_id: intentId,
          actor_uid: actor.uid,
          actor_role: actor.role,
          roster_entry_id: parsed.rosterEntryId,
          expected_state_fingerprint: parsed.expectedStateFingerprint,
          idempotency_key_sha256: requestIdentity.sha256,
          reason_code: parsed.reasonCode,
          reason_detail: parsed.reasonDetail,
          request_id: requestId,
          audit_event_id: audit.id,
        }),
      );
      return rows[0]?.receipt;
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

export async function haltClinicalContinuityActivation({
  tenantId,
  actorUid,
  actorRole,
  requestId = null,
  idempotencyKey,
  facilityId,
  parsed,
} = {}) {
  const tid = requireTenantId(tenantId);
  const fid = requiredFacilityId(facilityId);
  const requestIdentity = idempotencyIdentity(idempotencyKey);
  const eventId = deterministicUuid(`cc-activation:${tid}:${requestIdentity.sha256}`);
  try {
    return await runSerializableCommand(tid, async tx => {
      const actor = await loadCurrentStaffTx(tx, {
        tenantId: tid,
        actorUid,
        authenticatedRole: actorRole,
      });
      const prior = exactDuplicate(
        await loadPriorCommandTx(tx, {
          tenantId: tid,
          idempotencyKeySha256: requestIdentity.sha256,
        }),
        {
          eventId,
          action: 'halt',
          actorUid: actor.uid,
          rosterEntryId: parsed.rosterEntryId,
          expectedStateFingerprint: parsed.expectedStateFingerprint,
          reasonCode: parsed.reasonCode,
          reasonDetail: parsed.reasonDetail,
          evidenceReferences: parsed.evidenceReferences,
        },
      );
      if (prior) return prior;
      const state = await currentStateTx(tx, tid, fid);
      if (state.state_fingerprint !== parsed.expectedStateFingerprint) {
        throw AppError.conflict(
          'Activation state changed; refresh the fingerprint before retrying',
          'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_STATE_DRIFT',
          { safe: true },
        );
      }
      const audit = await requiredAudit(tx, {
        tenantId: tid,
        action: 'clinical_continuity.activation.halt_applied',
        actorUid: actor.uid,
        actorRole: actor.role,
        resourceType: 'clinical_continuity_activation_transition_event',
        resourceTable: 'clinical_continuity_activation_transition_events',
        resourceId: eventId,
        requestId,
        beforeState: state,
        afterState: {
          event_id: eventId,
          state: 'off',
          expected_state_fingerprint: parsed.expectedStateFingerprint,
        },
        idempotencyKey: `clinical-continuity-activation-halt:${eventId}`,
      });
      const rows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_activation_halt($1::jsonb) AS receipt`,
        JSON.stringify({
          tenant_id: tid,
          facility_id: fid,
          event_id: eventId,
          actor_uid: actor.uid,
          actor_role: actor.role,
          roster_entry_id: parsed.rosterEntryId,
          expected_state_fingerprint: parsed.expectedStateFingerprint,
          evidence_references: parsed.evidenceReferences,
          idempotency_key_sha256: requestIdentity.sha256,
          reason_code: parsed.reasonCode,
          reason_detail: parsed.reasonDetail,
          request_id: requestId,
          audit_event_id: audit.id,
        }),
      );
      return rows[0]?.receipt;
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

export const __testing__ = Object.freeze({ deterministicUuid, requiredFacilityId });

export default Object.freeze({
  countersignClinicalContinuityAdvance,
  createClinicalContinuityAdvanceIntent,
  getClinicalContinuityActivationState,
  haltClinicalContinuityActivation,
});
