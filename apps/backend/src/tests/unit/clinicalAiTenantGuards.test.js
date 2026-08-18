import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  assertPatientConsentInTenant,
  assertPatientInTenant,
  normalizeConsentReference,
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

  it('normalizes numeric patient consent references', () => {
    expect(normalizeConsentReference('42')).toEqual({ id: 42, reference: '42' });
    expect(normalizeConsentReference('consent:42')).toEqual({ id: 42, reference: '42' });
    expect(normalizeConsentReference('patient_consent:42')).toEqual({ id: 42, reference: '42' });
  });

  it('rejects non-row consent references before querying', async () => {
    await expect(assertPatientConsentInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      consentReference: 'consent:test:1',
      referenceInvalidCode: 'TEST_CONSENT_REF_INVALID',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TEST_CONSENT_REF_INVALID',
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('returns a verified active consent reference for the same patient tenant', async () => {
    queryRawUnsafeMock.mockResolvedValue([{
      id: 7,
      patient_uid: PATIENT_UID,
      consent_type: 'recording_consent',
      granted: true,
      status: 'active',
      expires_at: null,
      expires_at_epoch_ms: null,
      tenant_id: TENANT_ID,
    }]);

    await expect(assertPatientConsentInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      consentReference: '7',
    })).resolves.toMatchObject({
      id: 7,
      reference: '7',
      consentType: 'recording_consent',
      patientUid: PATIENT_UID,
    });
  });

  it('rejects consent references for a different patient', async () => {
    queryRawUnsafeMock.mockResolvedValue([{
      id: 7,
      patient_uid: '33333333-3333-4333-8333-333333333333',
      consent_type: 'treatment',
      granted: true,
      status: 'active',
      expires_at: null,
      expires_at_epoch_ms: null,
      tenant_id: TENANT_ID,
    }]);

    await expect(assertPatientConsentInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      consentReference: '7',
      patientMismatchCode: 'TEST_CONSENT_PATIENT_MISMATCH',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TEST_CONSENT_PATIENT_MISMATCH',
    });
  });

  it('rejects inactive consent references', async () => {
    queryRawUnsafeMock.mockResolvedValue([{
      id: 7,
      patient_uid: PATIENT_UID,
      consent_type: 'treatment',
      granted: false,
      status: 'revoked',
      expires_at: null,
      expires_at_epoch_ms: null,
      tenant_id: TENANT_ID,
    }]);

    await expect(assertPatientConsentInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      consentReference: '7',
      inactiveCode: 'TEST_CONSENT_INACTIVE',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TEST_CONSENT_INACTIVE',
    });
  });

  it('rejects an expired consent read through the absolute-instant twin', async () => {
    // The gate reads expires_at_epoch_ms, not the driver-materialised
    // expires_at (PR #881). A past instant must deny even though the row is
    // otherwise granted and active — this is the branch the null fixtures
    // above can never reach.
    const expiredAt = Date.now() - 60_000;
    queryRawUnsafeMock.mockResolvedValue([{
      id: 7,
      patient_uid: PATIENT_UID,
      consent_type: 'treatment',
      granted: true,
      status: 'active',
      expires_at: new Date(expiredAt),
      expires_at_epoch_ms: BigInt(expiredAt),
      tenant_id: TENANT_ID,
    }]);

    await expect(assertPatientConsentInTenant({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      consentReference: '7',
      inactiveCode: 'TEST_CONSENT_INACTIVE',
    })).rejects.toMatchObject({
      statusCode: 403,
      // Expiry throws its own dedicated code, distinct from inactiveCode —
      // pinning it proves the EXPIRY branch fired, not the active/granted one.
      code: 'CLINICAL_AI_CONSENT_EXPIRED',
    });
  });
});
