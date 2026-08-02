import { jest } from '@jest/globals';
import { parseHL7 } from '../../services/hl7/hl7Parser.js';

const queryRawUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryRawUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: jest.fn((_tenantId, callback) => callback(prismaMock)),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { emitSignedResultsOru } = await import('../../services/hl7/hl7OutboundService.js');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PATIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function resultRow({
  id,
  tenantId = TENANT_A,
  patientUid = PATIENT_A,
  investigationId = null,
  testCode = `TEST-${id}`,
  orderedTestCode = null,
  orderedTestName = null,
} = {}) {
  return {
    id,
    tenant_id: tenantId,
    patient_uid: patientUid,
    investigation_id: investigationId,
    test_code: testCode,
    test_name: `Test ${id}`,
    ordered_test_code: orderedTestCode,
    ordered_test_name: orderedTestName,
    value_text: String(id),
    value_numeric: null,
    unit: 'unit',
    reference_range: '1-10',
    abnormal_flag: '',
  };
}

describe('outbound signed-result ORU tenant and patient binding', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
  });

  it('rejects a cross-tenant caller-supplied patient UID that differs from the result owner', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([resultRow({ id: 1 })]);

    const queued = await emitSignedResultsOru({
      resultIds: [1],
      tenantId: TENANT_A,
      patientUid: PATIENT_B,
    });

    expect(queued).toBe(0);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the requested IDs are not all owned by the asserted tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([resultRow({ id: 1 })]);

    const queued = await emitSignedResultsOru({
      resultIds: [1, 2],
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
    });

    expect(queued).toBe(0);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([[1, 2], TENANT_A]);
  });

  it('rejects a mixed-patient result batch before loading a patient or queueing', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      resultRow({ id: 1, patientUid: PATIENT_A }),
      resultRow({ id: 2, patientUid: PATIENT_B }),
    ]);

    const queued = await emitSignedResultsOru({
      resultIds: [1, 2],
      tenantId: TENANT_A,
    });

    expect(queued).toBe(0);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('derives the queued tenant and patient only from a homogeneous result batch', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([
        resultRow({ id: 1 }),
        resultRow({ id: 2 }),
      ])
      .mockResolvedValueOnce([{
        uid: PATIENT_A,
        tenant_id: TENANT_A,
        name: 'Bound Patient',
        phone: '+919999999999',
        gender: 'female',
        birthday: new Date('1990-01-01T00:00:00.000Z'),
        address: 'Test address',
      }])
      .mockResolvedValueOnce([{ id: 31 }])
      .mockResolvedValueOnce([{ id: 77 }]);

    const queued = await emitSignedResultsOru({
      resultIds: [1, 2],
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
    });

    expect(queued).toBe(1);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(4);

    const patientLookup = queryRawUnsafeMock.mock.calls[1];
    expect(patientLookup[0]).toMatch(/uid = \$1::uuid[\s\S]*tenant_id = \$2::uuid/);
    expect(patientLookup.slice(1)).toEqual([PATIENT_A, TENANT_A]);

    const queueInsert = queryRawUnsafeMock.mock.calls[3];
    expect(queueInsert[1]).toBe(TENANT_A);
    expect(queueInsert[6]).toBe('lab_results');
    expect(queueInsert[8]).toBe(PATIENT_A);
  });

  it('rejects rows spanning tenants even when no tenant assertion is supplied', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      resultRow({ id: 1, tenantId: TENANT_A, patientUid: PATIENT_A }),
      resultRow({ id: 2, tenantId: TENANT_B, patientUid: PATIENT_B }),
    ]);

    const queued = await emitSignedResultsOru({ resultIds: [1, 2] });

    expect(queued).toBe(0);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the investigation namespace instead of mislabelling a lab-result id', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([resultRow({
        id: 901,
        investigationId: 77,
        testCode: 'GLU',
        orderedTestCode: 'GLU',
        orderedTestName: 'Glucose',
      })])
      .mockResolvedValueOnce([{
        uid: PATIENT_A,
        tenant_id: TENANT_A,
        name: 'Bound Patient',
      }])
      .mockResolvedValueOnce([{ id: 32 }])
      .mockResolvedValueOnce([{ id: 88 }]);

    await expect(emitSignedResultsOru({
      resultIds: [901],
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
    })).resolves.toBe(1);

    const queuedPayload = queryRawUnsafeMock.mock.calls[3][5];
    const parsed = parseHL7(queuedPayload);
    expect(parsed.obr.placerOrderNumber).toBe('VHINV-77');
    expect(parsed.obr.placerOrderNumber).not.toBe('VHINV-901');
    expect(parsed.obr.testCode).toBe('GLU^Glucose');
    expect(parsed.obx[0].observationId).toBe('GLU^Test 901');
  });
});
