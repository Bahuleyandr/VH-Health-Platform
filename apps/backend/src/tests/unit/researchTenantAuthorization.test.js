import { jest } from '@jest/globals';

const txMock = {
  $queryRawUnsafe: jest.fn(),
};

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $transaction: jest.fn(async (callback) => callback(txMock)),
};

const recordCanonicalClinicalEventMock = jest.fn();

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

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const {
  captureCrfResponse,
  enrollPatient,
} = await import('../../services/research/researchRegistryService.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

function activeRegistry() {
  return {
    id: 42,
    tenant_id: TENANT,
    code: 'CARDIO',
    title: 'Cardiology Registry',
    kind: 'registry',
    status: 'active',
  };
}

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$transaction.mockClear();
  txMock.$queryRawUnsafe.mockReset();
  recordCanonicalClinicalEventMock.mockReset();
});

describe('research tenant and object authorization', () => {
  it('requires the enrollment patient to exist in the caller tenant', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([activeRegistry()])
      .mockResolvedValueOnce([]);

    await expect(enrollPatient(42, {
      patientUid: PATIENT_UID,
    }, {
      actorUid: ACTOR_UID,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'RESEARCH_PATIENT_NOT_FOUND',
      statusCode: 404,
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    const [sql, patientUid, tenantId] = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(String(sql)).toMatch(/tenant_id = \$2::uuid/i);
    expect(patientUid).toBe(PATIENT_UID);
    expect(tenantId).toBe(TENANT);
  });

  it('requires consent_ref to belong to the same patient and tenant', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([activeRegistry()])
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([]);

    await expect(enrollPatient(42, {
      patientUid: PATIENT_UID,
      consentRef: 'consent-123',
    }, {
      actorUid: ACTOR_UID,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'RESEARCH_CONSENT_REF_INVALID',
      statusCode: 400,
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    const [sql, consentRef, patientUid, tenantId] = prismaMock.$queryRawUnsafe.mock.calls[2];
    expect(String(sql)).toMatch(/patient_consents/i);
    expect(String(sql)).toMatch(/tenant_id = \$3::uuid/i);
    expect(consentRef).toBe('consent-123');
    expect(patientUid).toBe(PATIENT_UID);
    expect(tenantId).toBe(TENANT);
  });

  it('does not resolve CRF forms across tenants', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(captureCrfResponse(77, {
      enrollmentId: 8,
      data: { score: 1 },
    }, {
      actorUid: ACTOR_UID,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'RESEARCH_FORM_NOT_FOUND',
      statusCode: 404,
    });

    const [sql, formId, tenantId] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(String(sql)).toMatch(/f\.tenant_id = \$2::uuid/i);
    expect(formId).toBe(77);
    expect(tenantId).toBe(TENANT);
  });

  it('stores CRF responses with the scoped tenant on legitimate capture', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 77,
        tenant_id: TENANT,
        registry_id: 42,
        name: 'Baseline',
        version: 1,
        status: 'published',
        field_schema: JSON.stringify([
          { key: 'score', label: 'Score', type: 'number', required: false },
        ]),
      }])
      .mockResolvedValueOnce([{
        id: 8,
        tenant_id: TENANT,
        registry_id: 42,
        patient_uid: PATIENT_UID,
        subject_code: 'CARDIO-0008',
        status: 'enrolled',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 501,
        tenant_id: TENANT,
        form_id: 77,
        enrollment_id: 8,
        visit_label: 'baseline',
        data: { score: 9 },
        autofilled: {},
        status: 'draft',
      }]);

    const response = await captureCrfResponse(77, {
      enrollmentId: 8,
      data: { score: 9 },
    }, {
      actorUid: ACTOR_UID,
      tenantId: TENANT,
    });

    expect(response.id).toBe(501);
    const insertCall = prismaMock.$queryRawUnsafe.mock.calls[3];
    expect(String(insertCall[0])).toMatch(/INSERT INTO research_crf_responses\s+\(tenant_id/i);
    expect(insertCall[1]).toBe(TENANT);
  });
});
