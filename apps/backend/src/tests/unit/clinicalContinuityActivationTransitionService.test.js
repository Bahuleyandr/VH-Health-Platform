import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));

const {
  countersignClinicalContinuityAdvance,
  createClinicalContinuityAdvanceIntent,
  getClinicalContinuityActivationState,
  haltClinicalContinuityActivation,
  __testing__,
} = await import('../../services/downtime/clinicalContinuityActivationTransitionService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';
const POLICY = '44444444-4444-4444-8444-444444444444';
const ROSTER = '55555555-5555-4555-8555-555555555555';
const HASH = 'a'.repeat(64);

function advanceParsed() {
  return {
    targetPolicyId: POLICY,
    rosterEntryId: ROSTER,
    evidenceGateConfigId: null,
    expectedStateFingerprint: HASH,
    evidenceReferences: [{ reference: 'phase-h:shadow', sha256: 'b'.repeat(64) }],
    reasonCode: 'enter_shadow',
    reasonDetail: 'The exact facility shadow intent was independently reviewed.',
  };
}

describe('clinicalContinuityActivationTransitionService', () => {
  let tx;

  beforeEach(() => {
    tx = { $queryRawUnsafe: jest.fn() };
    setTenantTxMock.mockReset();
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
    recordClinicalAuditEventMock.mockReset();
    recordClinicalAuditEventMock.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
    });
  });

  test('reads the canonical CAS state under current staff authority', async () => {
    const state = { state: 'off', state_fingerprint: HASH };
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'DOCTOR' }])
      .mockResolvedValueOnce([{ state }]);

    await expect(getClinicalContinuityActivationState({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      facilityId: 7,
    })).resolves.toEqual(state);
  });

  test('records the first authenticated advance key without claiming an audit or state change', async () => {
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'DOCTOR' }])
      .mockResolvedValueOnce([{ receipt: {
        disposition: 'awaiting_counterkey',
        intent_event_id: INTENT,
      } }]);

    const receipt = await createClinicalContinuityAdvanceIntent({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      facilityId: 7,
      requestId: 'request-advance-intent',
      idempotencyKey: 'cc-advance-intent-7-shadow',
      parsed: advanceParsed(),
    });

    expect(receipt.disposition).toBe('awaiting_counterkey');
    expect(recordClinicalAuditEventMock).not.toHaveBeenCalled();
    const command = JSON.parse(tx.$queryRawUnsafe.mock.calls[1][1]);
    expect(command).toMatchObject({
      tenant_id: TENANT,
      facility_id: 7,
      actor_uid: ACTOR,
      actor_role: 'DOCTOR',
      target_policy_id: POLICY,
      roster_entry_id: ROSTER,
      expected_state_fingerprint: HASH,
    });
  });

  test('binds the complementary authenticated key to one clinical audit and DB command', async () => {
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'ADMIN' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: INTENT,
        prior_state: { state: 'off', state_fingerprint: HASH },
        next_state: { state: 'shadow', state_fingerprint: 'c'.repeat(64) },
        target_policy_id: POLICY,
        expected_state_fingerprint: HASH,
      }])
      .mockResolvedValueOnce([{ receipt: { disposition: 'applied' } }]);

    await expect(countersignClinicalContinuityAdvance({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      facilityId: 7,
      intentEventId: INTENT,
      requestId: 'request-advance-counterkey',
      idempotencyKey: 'cc-advance-counterkey-7-shadow',
      parsed: {
        rosterEntryId: ROSTER,
        expectedStateFingerprint: HASH,
        reasonCode: 'enter_shadow',
        reasonDetail: 'The complementary exact facility key was independently verified.',
      },
    })).resolves.toEqual({ disposition: 'applied' });

    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clinical_continuity.activation.advance_applied',
        actorUid: ACTOR,
        resourceTable: 'clinical_continuity_activation_transition_events',
      }),
      { db: tx },
    );
    expect(tx.$queryRawUnsafe.mock.calls[3][0]).toContain(
      'clinical_continuity_activation_advance_countersign',
    );
  });

  test('halts with one authenticated rollback key and permits a no-justification veto', async () => {
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'DOCTOR' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: { state: 'active', state_fingerprint: HASH } }])
      .mockResolvedValueOnce([{ receipt: { disposition: 'applied', next_state: { state: 'off' } } }]);

    await expect(haltClinicalContinuityActivation({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      facilityId: 7,
      requestId: 'request-halt',
      idempotencyKey: 'cc-halt-7-veto',
      parsed: {
        rosterEntryId: ROSTER,
        expectedStateFingerprint: HASH,
        evidenceReferences: [],
        reasonCode: 'clinical_lead_veto',
        reasonDetail: null,
      },
    })).resolves.toMatchObject({ disposition: 'applied', next_state: { state: 'off' } });

    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'clinical_continuity.activation.halt_applied' }),
      { db: tx },
    );
    const command = JSON.parse(tx.$queryRawUnsafe.mock.calls[3][1]);
    expect(command).toMatchObject({ reason_code: 'clinical_lead_veto', reason_detail: null });
  });

  test('maps an empty roster refusal to a safe fail-closed authority error', async () => {
    const databaseError = Object.assign(new Error('active activation roster authority required'), {
      code: '42501',
    });
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'DOCTOR' }])
      .mockRejectedValueOnce(databaseError);

    await expect(createClinicalContinuityAdvanceIntent({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      facilityId: 7,
      idempotencyKey: 'cc-empty-roster-refusal',
      parsed: advanceParsed(),
    })).rejects.toMatchObject({
      code: 'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_AUTHORITY_REQUIRED',
      statusCode: 403,
    });
  });

  test('rejects an idempotency-key replay when halt evidence or reason drifts', async () => {
    const idempotencyKey = 'cc-halt-replay-evidence-drift';
    const idempotencySha256 = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
    const eventId = __testing__.deterministicUuid(
      `cc-activation:${TENANT}:${idempotencySha256}`,
    );
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'DOCTOR' }])
      .mockResolvedValueOnce([{
        id: eventId,
        action: 'halt',
        actor_uid: ACTOR,
        roster_entry_id: ROSTER,
        intent_event_id: null,
        expected_state_fingerprint: HASH,
        reason_code: 'clinical_lead_veto',
        reason_detail: null,
        evidence_references: [{ reference: 'phase-h:prior', sha256: 'c'.repeat(64) }],
        receipt: { disposition: 'applied' },
      }]);

    await expect(haltClinicalContinuityActivation({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      facilityId: 7,
      idempotencyKey,
      parsed: {
        rosterEntryId: ROSTER,
        expectedStateFingerprint: HASH,
        evidenceReferences: [],
        reasonCode: 'clinical_lead_veto',
        reasonDetail: null,
      },
    })).rejects.toMatchObject({
      code: 'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_IDEMPOTENCY_DRIFT',
      statusCode: 409,
    });
    expect(recordClinicalAuditEventMock).not.toHaveBeenCalled();
  });
});
