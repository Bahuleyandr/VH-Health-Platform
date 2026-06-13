import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const referralsFindUniqueMock = jest.fn();
const referralsUpdateMock = jest.fn();
const referralsCreateMock = jest.fn();
const referralsCountMock = jest.fn();
const referralsFindManyMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  referrals: {
    findUnique: referralsFindUniqueMock,
    update: referralsUpdateMock,
    create: referralsCreateMock,
    count: referralsCountMock,
    findMany: referralsFindManyMock,
  },
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
}));

jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));

const referralService = (await import('../../services/referral/referralService.js')).default;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '22222222-2222-4222-8222-222222222222';
const OTHER_DOCTOR_UID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  referralsFindUniqueMock.mockReset();
  referralsUpdateMock.mockReset();
  referralsCreateMock.mockReset();
  referralsCountMock.mockReset();
  referralsFindManyMock.mockReset();
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
  loggerErrorMock.mockReset();
  sendStaffNotificationsMock.mockReset();
});

describe('referralService specialist referral authorization', () => {
  it('allows a matching department consultant to accept a department-only referral', async () => {
    referralsFindUniqueMock.mockResolvedValueOnce({
      id: 12,
      status: 'pending',
      tenant_id: TENANT_ID,
      referred_to_doctor: null,
      referred_to_department: 'Cardiology',
      accepted_by: null,
      performer_id: null,
      first_seen_at: null,
    });
    queryRawUnsafeMock.mockResolvedValueOnce([{ token: 'cardiology' }]);
    referralsUpdateMock.mockResolvedValueOnce({
      id: 12,
      status: 'accepted',
      referred_to_doctor: DOCTOR_UID,
      performer_id: DOCTOR_UID,
    });

    const referral = await referralService.acceptReferral(12, DOCTOR_UID, {
      actorRole: 'DOCTOR',
    });

    expect(referral.status).toBe('accepted');
    expect(referralsUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 12 },
      data: expect.objectContaining({
        referred_to_doctor: DOCTOR_UID,
        performer_id: DOCTOR_UID,
      }),
    }));
  });

  it('blocks an unrelated doctor from accepting another doctor-specific referral', async () => {
    referralsFindUniqueMock.mockResolvedValueOnce({
      id: 13,
      status: 'pending',
      tenant_id: TENANT_ID,
      referred_to_doctor: OTHER_DOCTOR_UID,
      referred_to_department: 'Cardiology',
      accepted_by: null,
      performer_id: null,
      first_seen_at: null,
    });

    await expect(referralService.acceptReferral(13, DOCTOR_UID, {
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    expect(referralsUpdateMock).not.toHaveBeenCalled();
  });

  it('returns department-only pending referrals for doctors in that department', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ token: 'cardiology' }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        {
          id: 14,
          referral_number: 'REF-202606-0001',
          referred_to_department: 'Cardiology',
          status: 'pending',
        },
      ]);

    const result = await referralService.getIncomingReferrals(DOCTOR_UID, {
      tenantId: TENANT_ID,
      page: 1,
      limit: 20,
    });

    expect(result.referrals).toHaveLength(1);
    expect(result.referrals[0].referral_number).toBe('REF-202606-0001');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('referred_to_doctor IS NULL');
  });

  it('blocks the requesting doctor from completing their own outgoing referral', async () => {
    referralsFindUniqueMock.mockResolvedValueOnce({
      id: 15,
      status: 'accepted',
      tenant_id: TENANT_ID,
      referred_to_doctor: OTHER_DOCTOR_UID,
      referred_to_department: 'Cardiology',
      accepted_by: OTHER_DOCTOR_UID,
      performer_id: OTHER_DOCTOR_UID,
    });

    await expect(referralService.completeReferral(15, 'Reviewed', {
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    expect(referralsUpdateMock).not.toHaveBeenCalled();
  });

  it('allows the requesting doctor to decline a still-pending outgoing referral', async () => {
    referralsFindUniqueMock.mockResolvedValueOnce({
      id: 16,
      status: 'pending',
      tenant_id: TENANT_ID,
      referring_doctor: DOCTOR_UID,
      requester_id: DOCTOR_UID,
      referred_to_doctor: OTHER_DOCTOR_UID,
      referred_to_department: 'Cardiology',
      accepted_by: null,
      performer_id: null,
    });
    referralsUpdateMock.mockResolvedValueOnce({
      id: 16,
      status: 'declined',
      response_notes: 'Recalled by primary doctor',
    });

    const referral = await referralService.declineReferral(
      16,
      'Recalled by primary doctor',
      { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' },
    );

    expect(referral.status).toBe('declined');
    expect(referralsUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 16 },
      data: expect.objectContaining({
        status: 'declined',
        response_notes: 'Recalled by primary doctor',
      }),
    }));
  });

  it('blocks an unrelated doctor from declining another referral', async () => {
    referralsFindUniqueMock.mockResolvedValueOnce({
      id: 17,
      status: 'pending',
      tenant_id: TENANT_ID,
      referring_doctor: OTHER_DOCTOR_UID,
      requester_id: OTHER_DOCTOR_UID,
      referred_to_doctor: OTHER_DOCTOR_UID,
      referred_to_department: 'Cardiology',
      accepted_by: null,
      performer_id: null,
    });

    await expect(referralService.declineReferral(17, 'No', {
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    expect(referralsUpdateMock).not.toHaveBeenCalled();
  });
});
