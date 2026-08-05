import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const registerExternalRecoveryOffsetMock = jest.fn();
const authorizeExternalRecoveryResumeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));

jest.unstable_mockModule('../../services/integrations/externalInterfaceRecoveryService.js', () => ({
  authorizeExternalRecoveryResume: authorizeExternalRecoveryResumeMock,
  registerExternalRecoveryOffset: registerExternalRecoveryOffsetMock,
}));

const {
  authorizeExternalRecoveryOperabilityResume,
  registerExternalRecoveryOperabilityOffset,
} = await import('../../services/downtime/externalRecoveryOperabilityService.js');
const {
  parseExternalRecoveryRegister,
  parseExternalRecoveryResume,
} = await import('../../validators/externalRecoveryOperabilitySchemas.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const OFFSET = '22222222-2222-4222-8222-222222222222';

function registerInput() {
  return parseExternalRecoveryRegister({
    interface_family: 'I01',
    source_partition: 'lis-primary',
    generation: 3,
    initial_position: '42',
    initial_token: 'oru-42',
    retained_from_position: '1',
    retained_from_token: 'oru-1',
    policy_version: 'c-d8-v1',
    policy_signature: 'policy-signature',
    retention_policy: 'clinical-continuity',
    retention_until: '2033-08-04T00:00:00.000Z',
    owner_evidence_reference: 'owner-evidence-2026-08-04',
    owner_evidence_signature: 'owner-signature',
    reason_code: 'initial_marker_reconciled',
    reason_detail: 'Verified the exact retained LIS marker and source count.',
  });
}

function offsetRow(overrides = {}) {
  return {
    offset_id: OFFSET,
    tenant_id: TENANT,
    facility_scope: 'tenant',
    facility_id: null,
    interface_family: 'I01',
    direction: 'inbound',
    source_partition: 'lis-primary',
    generation: 3,
    high_water_position: '42',
    high_water_token: 'oru-42',
    retained_from_position: '1',
    retained_from_token: 'oru-1',
    resume_cutoff_position: null,
    resume_cutoff_token: null,
    recovery_state: 'paused',
    reconciliation_reason: null,
    policy_version: 'c-d8-v1',
    retention_policy: 'clinical-continuity',
    retention_until: '2033-08-04T00:00:00.000Z',
    intake_retired_at: null,
    subpath: null,
    protocol: null,
    ...overrides,
  };
}

describe('externalRecoveryOperabilityService', () => {
  let tx;

  beforeEach(() => {
    tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    setTenantTxMock.mockReset();
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
    recordClinicalAuditEventMock.mockReset();
    recordClinicalAuditEventMock.mockResolvedValue({ id: 'audit-event-1' });
    registerExternalRecoveryOffsetMock.mockReset();
    registerExternalRecoveryOffsetMock.mockResolvedValue({
      disposition: 'applied',
      recovery_state: 'paused',
    });
    authorizeExternalRecoveryResumeMock.mockReset();
    authorizeExternalRecoveryResumeMock.mockResolvedValue({
      disposition: 'applied',
      recovery_state: 'replaying',
    });
  });

  it('registers one exact partition with server-derived catalog and current-admin fields', async () => {
    tx.$queryRawUnsafe.mockResolvedValueOnce([{ uid: ACTOR, role: 'ADMIN' }]);

    const receipt = await registerExternalRecoveryOperabilityOffset({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      requestId: 'request-register-1',
      idempotencyKey: 'register-I01-lis-primary-3',
      parsed: registerInput(),
    });

    expect(receipt).toEqual({ disposition: 'applied', recovery_state: 'paused' });
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        action: 'external_recovery.offset.register',
        actorUid: ACTOR,
        actorRole: 'ADMIN',
      }),
      { db: tx },
    );
    expect(registerExternalRecoveryOffsetMock).toHaveBeenCalledTimes(1);
    const command = registerExternalRecoveryOffsetMock.mock.calls[0][0].operabilityCommand;
    expect(command).toMatchObject({
      tenant_id: TENANT,
      interface_family: 'I01',
      facility_scope: 'tenant',
      facility_id: null,
      direction: 'inbound',
      source_partition: 'lis-primary',
      generation: 3,
      actor_uid: ACTOR,
      actor_role: 'ADMIN',
      command_class: 'register_paused_offset',
    });
    expect(command).not.toHaveProperty('recovery_state');
    expect(command).not.toHaveProperty('scope_kind');
  });

  it('rejects a stale or forged administrator claim before registration', async () => {
    tx.$queryRawUnsafe.mockResolvedValue([{ uid: ACTOR, role: 'DOCTOR' }]);

    await expect(registerExternalRecoveryOperabilityOffset({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      requestId: 'request-forged-admin',
      idempotencyKey: 'register-forged-admin',
      parsed: registerInput(),
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OPERABILITY_FORBIDDEN' });

    expect(registerExternalRecoveryOffsetMock).not.toHaveBeenCalled();
    expect(recordClinicalAuditEventMock).not.toHaveBeenCalled();
  });

  it('rejects resume state drift before an audit or state-changing command', async () => {
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'SUPER_ADMIN' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([offsetRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'SUPER_ADMIN' }])
      .mockResolvedValueOnce([{ receipt: { outcome: 'refused_drift' } }]);
    const parsed = parseExternalRecoveryResume({
      expected_state_fingerprint: '0'.repeat(64),
      resume_cutoff_position: '50',
      resume_cutoff_token: 'oru-50',
      owner_evidence_reference: 'owner-evidence-2026-08-04',
      owner_evidence_signature: 'owner-signature',
      reason_code: 'resume_cutoff_reconciled',
      reason_detail: 'Verified the exact replay cutoff against the retained source.',
    });

    await expect(authorizeExternalRecoveryOperabilityResume({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'request-resume-drift',
      idempotencyKey: 'resume-I01-lis-primary-3',
      offsetId: OFFSET,
      parsed,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OPERABILITY_STATE_DRIFT' });

    expect(recordClinicalAuditEventMock).not.toHaveBeenCalled();
    expect(authorizeExternalRecoveryResumeMock).not.toHaveBeenCalled();
    const refusalCall = tx.$queryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('external_recovery_operability_record_refusal')
    ));
    expect(JSON.parse(refusalCall[1])).toMatchObject({
      action: 'authorize_resume',
      actor_uid: ACTOR,
      actor_role: 'SUPER_ADMIN',
      outcome: 'refused_drift',
      refusal_code: 'EXTERNAL_RECOVERY_OPERABILITY_STATE_DRIFT',
    });
  });
});
