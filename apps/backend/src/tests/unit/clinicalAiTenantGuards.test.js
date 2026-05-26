import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

const {
  assertPatientInTenant,
  normalizePatientUid,
} = await import('../../services/ai/clinicalAiTenantGuards.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('clinicalAiTenantGuards', () => {
  it('normalizes optional blank patient_uid values', () => {
    expect(normalizePatientUid('')).toBeNull();
    expect(normalizePatientUid(null)).toBeNull();
  });

  it('rejects malformed patient_uid values before querying', async () => {
    await expect(assertPatientInTenant({
      tenantId: TENANT_ID,
      patientUid: 'not-a-uuid',
      invalidCode: 'TEST_INVALID_UID',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TEST_INVALID_UID',
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('returns the patient uid when the user is a patient in the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValue([{
      uid: PATIENT_UID,
      tenant_id: TENANT_ID,
      role: 'PATIENT',
    }]);

    await expect(assertPatientInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
    })).resolves.toBe(PATIENT_UID);
  });

  it('rejects cross-tenant patients', async () => {
    queryRawUnsafeMock.mockResolvedValue([{
      uid: PATIENT_UID,
      tenant_id: '33333333-3333-4333-8333-333333333333',
      role: 'PATIENT',
    }]);

    await expect(assertPatientInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      tenantMismatchCode: 'TEST_TENANT_MISMATCH',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TEST_TENANT_MISMATCH',
    });
  });

  it('rejects staff users when a patient uid is required', async () => {
    queryRawUnsafeMock.mockResolvedValue([{
      uid: PATIENT_UID,
      tenant_id: TENANT_ID,
      role: 'DOCTOR',
    }]);

    await expect(assertPatientInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      roleInvalidCode: 'TEST_ROLE_INVALID',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TEST_ROLE_INVALID',
    });
  });
});
