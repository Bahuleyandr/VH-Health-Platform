import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

// Fake tx used by setTenantTx — sequences $queryRawUnsafe return values.
const txQueryMock = jest.fn();
const txMock = { $queryRawUnsafe: txQueryMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(txMock)),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const settingsMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getBirthNotificationSettings: settingsMock,
}));

const canonicalMock = jest.fn();
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: canonicalMock,
}));

const svc = await import('../../services/clinical/birthNotificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const MOTHER = '11111111-1111-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  txQueryMock.mockReset();
  settingsMock.mockReset();
  canonicalMock.mockReset();
  delete process.env.BIRTH_NOTIFICATION_ENABLED;
});

describe('dark gate', () => {
  test('env off → 503 BIRTH_NOTIFICATION_NOT_ENABLED', async () => {
    await expect(svc.requireBirthNotificationEnabled(TENANT)).rejects.toMatchObject({
      statusCode: 503, code: 'BIRTH_NOTIFICATION_NOT_ENABLED',
    });
  });

  test('env on + tenant off → 403 BIRTH_NOTIFICATION_DISABLED', async () => {
    process.env.BIRTH_NOTIFICATION_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: false });
    await expect(svc.requireBirthNotificationEnabled(TENANT)).rejects.toMatchObject({
      statusCode: 403, code: 'BIRTH_NOTIFICATION_DISABLED',
    });
  });

  test('env on + tenant on → resolves', async () => {
    process.env.BIRTH_NOTIFICATION_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: true });
    await expect(svc.requireBirthNotificationEnabled(TENANT)).resolves.toEqual({ enabled: true });
  });
});

describe('pure helpers', () => {
  test('STATUS_TRANSITIONS is a fail-closed walk', () => {
    expect(svc._internal.STATUS_TRANSITIONS.draft).toEqual(['certified', 'cancelled']);
    expect(svc._internal.STATUS_TRANSITIONS.registered).toEqual([]);
    expect(svc._internal.STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  test('validateForCertification flags missing required fields', () => {
    expect(svc.validateForCertification({})).toEqual(
      expect.arrayContaining([
        'date_of_birth required', 'time_of_birth required',
        'mother_patient_uid required',
      ]),
    );
    expect(svc.validateForCertification({
      date_of_birth: '2026-01-01', time_of_birth: '10:00',
      mother_patient_uid: MOTHER, sex: 'female',
    })).toEqual([]);
  });

  test('isMultipleFromOrder', () => {
    expect(svc._internal.isMultipleFromOrder(1)).toBe(false);
    expect(svc._internal.isMultipleFromOrder(2)).toBe(true);
  });
});

describe('createBirthNotification', () => {
  beforeEach(() => {
    process.env.BIRTH_NOTIFICATION_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: true });
  });

  test('inserts detail row + writes canonical timeline/audit in the tx', async () => {
    txQueryMock
      .mockResolvedValueOnce([{ uid: MOTHER }]) // tenant-scoped mother resolution
      .mockResolvedValueOnce([{ id: 42, newborn_id: null, mother_patient_uid: MOTHER, sex: 'female', outcome: 'live' }]);
    const rec = await svc.createBirthNotification({
      tenantId: TENANT,
      mother_patient_uid: MOTHER,
      date_of_birth: '2026-08-01',
      time_of_birth: '09:30',
      sex: 'female',
      created_by: '22222222-2222-4000-8000-000000000002',
    });
    expect(rec.id).toBe(42);
    // Resolution + INSERT both ran on the tx client (not plain prisma), the
    // resolution tenant- and PATIENT-role-scoped.
    expect(txQueryMock).toHaveBeenCalledTimes(2);
    expect(txQueryMock.mock.calls[0][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(txQueryMock.mock.calls[0][0]).toMatch(/role = 'PATIENT'/);
    // Canonical clinical event was recorded strictly on the same tx.
    expect(canonicalMock).toHaveBeenCalledTimes(1);
    const [input, options] = canonicalMock.mock.calls[0];
    expect(input.resourceTable).toBe('birth_notifications');
    expect(input.patientUid).toBe(MOTHER);
    expect(options).toMatchObject({ db: txMock, strict: true });
  });

  test('rejects when required identity cannot resolve', async () => {
    await expect(svc.createBirthNotification({
      tenantId: TENANT, date_of_birth: '2026-08-01', time_of_birth: '09:30',
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a non-UUID manual mother_patient_uid with 400, before any SQL runs', async () => {
    await expect(svc.createBirthNotification({
      tenantId: TENANT, mother_patient_uid: 'not-a-uuid',
      date_of_birth: '2026-08-01', time_of_birth: '09:30', sex: 'female',
    })).rejects.toMatchObject({ statusCode: 400, code: 'BIRTH_NOTIFICATION_MOTHER_UID_INVALID' });
    expect(txQueryMock).not.toHaveBeenCalled();
  });

  test('rejects a dangling / cross-tenant manual mother UUID with 404', async () => {
    txQueryMock.mockResolvedValueOnce([]); // resolution finds no patient in tenant
    await expect(svc.createBirthNotification({
      tenantId: TENANT, mother_patient_uid: MOTHER,
      date_of_birth: '2026-08-01', time_of_birth: '09:30', sex: 'female',
    })).rejects.toMatchObject({ statusCode: 404, code: 'BIRTH_NOTIFICATION_MOTHER_NOT_FOUND' });
    expect(canonicalMock).not.toHaveBeenCalled();
  });
});
