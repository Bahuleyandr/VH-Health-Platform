import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/fhir/fhirAdapter.js', () => ({
  fromFhirPatient: jest.fn((resource) => ({
    uid: resource.id,
    phone: resource.telecom?.[0]?.value || '+15550000000',
    name: resource.name?.[0]?.text || 'Imported Patient',
  })),
}));

const { generateCCD } = await import('../../services/documents/ccdaGenerator.js');
const { importFhirBundle } = await import('../../services/import/patientDataImport.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const IMPORTER_UID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
});

describe('document import/export tenant authorization', () => {
  it('binds every CCD export read to the caller tenant', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        uid: PATIENT_UID,
        name: 'Tenant Patient',
        phone: '+15550000000',
        gender: 'Female',
        birthday: '1980-01-01',
        address: 'Unit Test Lane',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const xml = await generateCCD(PATIENT_UID, { tenantId: TENANT });

    expect(xml).toContain('<ClinicalDocument');
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(7);
    for (const call of prismaMock.$queryRawUnsafe.mock.calls) {
      expect(String(call[0])).toMatch(/tenant_id/i);
      expect(call).toContain(TENANT);
    }
  });

  it('requires authenticated receipt authority before external clinical-assertion intake', async () => {
    await expect(importFhirBundle({
      resourceType: 'Bundle',
      entry: [{
        resource: {
          resourceType: 'Condition',
          id: 'condition-1',
          subject: { reference: `Patient/${PATIENT_UID}` },
          code: { text: 'External condition' },
        },
      }],
    }, IMPORTER_UID, {
      tenantId: TENANT,
      authority: { patientUid: PATIENT_UID },
    })).rejects.toMatchObject({
      code: 'IMPORT_ACTOR_AUTHORITY_MISMATCH',
    });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
