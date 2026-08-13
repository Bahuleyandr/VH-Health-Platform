import { jest } from '@jest/globals';

const authorizePatientAccessRequest = jest.fn();

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  authorizePatientAccessRequest,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn() },
}));

const { authorizeSubscriptionChannel } = await import(
  '../../utils/websocket/subscriptionAuth.js'
);

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const GUARDIAN_UID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHANNEL = `patient:${PATIENT_UID}:appointments`;

function socketIdentity(overrides = {}) {
  return {
    userId: ACTOR_UID,
    revocationOwnerUid: ACTOR_UID,
    role: 'DOCTOR',
    tenantId: TENANT_ID,
    jti: 'ws-ticket-jti',
    ...overrides,
  };
}

describe('patient realtime subscription authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('authorizes the patient owner through the governed access decision', async () => {
    authorizePatientAccessRequest.mockResolvedValue({ allowed: true, accessSource: 'guardian' });

    await expect(authorizeSubscriptionChannel(CHANNEL, socketIdentity({
      userId: PATIENT_UID,
      revocationOwnerUid: PATIENT_UID,
      role: 'PATIENT',
    }))).resolves.toEqual({ allowed: true });

    expect(authorizePatientAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        user: expect.objectContaining({
          uid: PATIENT_UID,
          role: 'PATIENT',
          tenant_id: TENANT_ID,
        }),
      }),
      expect.objectContaining({
        policyCode: 'patient.realtime.subscribe',
        patient: { uid: PATIENT_UID },
        requireResolvedPatient: true,
        shadowMode: false,
      }),
    );
  });

  test('preserves the guardian actor on a delegated-subject ticket', async () => {
    authorizePatientAccessRequest.mockResolvedValue({ allowed: true, accessSource: 'guardian' });

    await expect(authorizeSubscriptionChannel(CHANNEL, socketIdentity({
      userId: PATIENT_UID,
      revocationOwnerUid: GUARDIAN_UID,
      role: 'PATIENT',
    }))).resolves.toEqual({ allowed: true });

    expect(authorizePatientAccessRequest.mock.calls[0][0].acting).toEqual({
      actorUid: GUARDIAN_UID,
      actorRole: 'PATIENT',
      actorRawRole: 'PATIENT',
      subjectUid: PATIENT_UID,
    });
  });

  test.each(['care_team', 'break_glass'])(
    'accepts a canonical %s decision',
    async (accessSource) => {
      authorizePatientAccessRequest.mockResolvedValue({ allowed: true, accessSource });

      await expect(authorizeSubscriptionChannel(CHANNEL, socketIdentity())).resolves.toEqual({
        allowed: true,
      });
    },
  );

  test.each(['DOCTOR', 'ADMIN', 'SUPER_ADMIN'])(
    'denies an unrelated %s without exposing the governed denial reason',
    async (role) => {
      authorizePatientAccessRequest.mockResolvedValue({
        allowed: false,
        reason: 'No active care-team or break-glass relationship',
      });

      await expect(authorizeSubscriptionChannel(CHANNEL, socketIdentity({ role }))).resolves.toEqual({
        allowed: false,
        reason: 'Patient channel access denied',
      });
    },
  );

  test('fails closed for an unresolved tenant-scoped patient', async () => {
    authorizePatientAccessRequest.mockResolvedValue({
      allowed: false,
      no_patient_context: true,
    });

    await expect(authorizeSubscriptionChannel(CHANNEL, socketIdentity({
      tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }))).resolves.toEqual({
      allowed: false,
      reason: 'Patient channel access denied',
    });
  });

  test('fails closed when the governed decision service is unavailable', async () => {
    authorizePatientAccessRequest.mockRejectedValue(new Error('database unavailable'));

    await expect(authorizeSubscriptionChannel(CHANNEL, socketIdentity())).resolves.toEqual({
      allowed: false,
      reason: 'Patient channel access denied',
    });
  });

  test.each([
    'patient:51:appointments',
    `patient:${PATIENT_UID}:unknown`,
    `patient:${PATIENT_UID}`,
  ])('rejects invalid personal channel %s without a governed lookup', async (channel) => {
    const decision = await authorizeSubscriptionChannel(channel, socketIdentity());

    expect(decision.allowed).toBe(false);
    expect(authorizePatientAccessRequest).not.toHaveBeenCalled();
  });

  test('keeps non-patient board authorization synchronous and separate', async () => {
    await expect(authorizeSubscriptionChannel('staff:beds', socketIdentity())).resolves.toEqual({
      allowed: true,
    });
    expect(authorizePatientAccessRequest).not.toHaveBeenCalled();
  });
});
