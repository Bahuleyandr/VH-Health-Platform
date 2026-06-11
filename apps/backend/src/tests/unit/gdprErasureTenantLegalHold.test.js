import { jest } from '@jest/globals';

const modelMocks = {
  notifications: { deleteMany: jest.fn() },
  user_devices: { deleteMany: jest.fn() },
  devices: { deleteMany: jest.fn() },
  invalidated_tokens: { deleteMany: jest.fn() },
  otp_logs: { deleteMany: jest.fn() },
  auth_logs: { deleteMany: jest.fn() },
  pharmacy_orders: { updateMany: jest.fn() },
  investigations: { updateMany: jest.fn() },
  health_records: { updateMany: jest.fn() },
  consultations: { updateMany: jest.fn() },
  appointments: { updateMany: jest.fn() },
  feedback: { updateMany: jest.fn() },
  patient_consents: { updateMany: jest.fn() },
  audit_logs: { updateMany: jest.fn() },
  file_metadata: { updateMany: jest.fn() },
};

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  legal_holds: { findMany: jest.fn() },
  gdpr_erasure_log: { create: jest.fn() },
  users: { updateMany: jest.fn() },
  ...modelMocks,
};

const logPhiAccessMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

const {
  checkLegalHold,
  executeErasure,
} = await import('../../services/gdpr/dataErasureService.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PHONE = '+15550000000';

function resetModelMocks() {
  for (const model of Object.values(modelMocks)) {
    model.deleteMany?.mockReset().mockResolvedValue({ count: 1 });
    model.updateMany?.mockReset().mockResolvedValue({ count: 1 });
  }
  prismaMock.users.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prismaMock.legal_holds.findMany.mockReset();
  prismaMock.gdpr_erasure_log.create.mockReset().mockResolvedValue({});
}

beforeEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  resetModelMocks();
  logPhiAccessMock.mockReset();
});

describe('GDPR erasure tenant and legal-hold controls', () => {
  it('checks legal holds through the tenant-scoped user row', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{
      id: 9,
      reason: 'litigation',
      created_at: new Date('2026-01-01T00:00:00Z'),
    }]);

    const result = await checkLegalHold(PATIENT_UID, { tenantId: TENANT });

    expect(result.hasHold).toBe(true);
    const [sql, uid, tenantId] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(String(sql)).toMatch(/JOIN users/i);
    expect(String(sql)).toMatch(/u\.tenant_id = \$2::uuid/i);
    expect(uid).toBe(PATIENT_UID);
    expect(tenantId).toBe(TENANT);
  });

  it('blocks admin erasure before touching target tables when a legal hold exists', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: PATIENT_UID, phone: PHONE, tenant_id: TENANT }])
      .mockResolvedValueOnce([{
        id: 9,
        reason: 'litigation',
        created_at: new Date('2026-01-01T00:00:00Z'),
      }]);

    await expect(executeErasure({
      uid: PATIENT_UID,
      requestedBy: ACTOR_UID,
      reason: 'patient request',
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'LEGAL_HOLD_ACTIVE',
      statusCode: 403,
    });

    expect(prismaMock.notifications.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.users.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.gdpr_erasure_log.create).not.toHaveBeenCalled();
    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });

  it('applies tenant predicates to tenant-scoped erasure targets', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ uid: PATIENT_UID, phone: PHONE, tenant_id: TENANT }])
      .mockResolvedValueOnce([]);

    const result = await executeErasure({
      uid: PATIENT_UID,
      requestedBy: ACTOR_UID,
      reason: 'patient request',
      tenantId: TENANT,
    });

    expect(result.success).toBe(true);
    expect(prismaMock.notifications.deleteMany).toHaveBeenCalledWith({
      where: { AND: [{ uid: PATIENT_UID }, { tenant_id: TENANT }] },
    });
    expect(prismaMock.pharmacy_orders.updateMany.mock.calls[0][0].where).toEqual({
      AND: [{ phone: PHONE }, { tenant_id: TENANT }],
    });
    expect(prismaMock.patient_consents.updateMany.mock.calls[0][0].where).toEqual({
      AND: [{ patient_uid: PATIENT_UID }, { tenant_id: TENANT }],
    });
    expect(prismaMock.users.updateMany.mock.calls[0][0].where).toEqual({
      uid: PATIENT_UID,
      tenant_id: TENANT,
    });
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      patientId: PATIENT_UID,
      recordType: 'GDPR_ERASURE',
    }));
  });
});
