import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '10000000-0000-4000-8000-000000000001';

const prismaMock = {
  admissions: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  allergies: { findMany: jest.fn() },
  beds: { findMany: jest.fn() },
  cds_alerts: { findMany: jest.fn() },
  clinical_notes: { findMany: jest.fn() },
  clinical_orders: { findMany: jest.fn() },
  diagnoses: { findMany: jest.fn() },
  discharge_consults: { findMany: jest.fn() },
  discharge_summaries: { findMany: jest.fn() },
  patient_allergies: { findMany: jest.fn() },
  users: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  getHospitalNumberMap: jest.fn(async () => new Map()),
}));

const patientCommandBoardService = await import('../../services/emr/patientCommandBoardService.js');

beforeEach(() => {
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) {
      fn.mockReset();
      fn.mockResolvedValue([]);
    }
  }
  prismaMock.admissions.count.mockResolvedValue(46);
});

describe('patientCommandBoardService', () => {
  it('reports the full scoped inpatient total separately from the fetched rows', async () => {
    prismaMock.admissions.findMany.mockResolvedValueOnce([
      {
        id: 1,
        tenant_id: TENANT,
        encounter_id: '20000000-0000-4000-8000-000000000001',
        patient_uid: '30000000-0000-4000-8000-000000000001',
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        ward: 'First Floor Ward',
        bed_id: 10,
        bed_number: '101',
        status: 'admitted',
        admission_type: 'IPD',
        priority: 'routine',
        allergies: [],
        admitted_at: new Date('2026-05-31T08:00:00.000Z'),
      },
      {
        id: 2,
        tenant_id: TENANT,
        encounter_id: '20000000-0000-4000-8000-000000000002',
        patient_uid: '30000000-0000-4000-8000-000000000002',
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        ward: 'First Floor Ward',
        bed_id: 11,
        bed_number: '102',
        status: 'admitted',
        admission_type: 'IPD',
        priority: 'urgent',
        allergies: [],
        admitted_at: new Date('2026-05-31T09:00:00.000Z'),
      },
    ]);

    const result = await patientCommandBoardService.default.getPatientCommandBoard(
      { limit: 2 },
      { uid: DOCTOR_UID, role: 'CONSULTANT', tenantId: TENANT },
    );

    const countWhere = prismaMock.admissions.count.mock.calls[0][0].where;
    const findWhere = prismaMock.admissions.findMany.mock.calls[0][0].where;
    expect(countWhere).toEqual(findWhere);
    expect(JSON.stringify(countWhere)).toContain(TENANT);
    expect(prismaMock.admissions.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.board.counts).toEqual(expect.objectContaining({
      total: 46,
      returned: 2,
      loaded: 2,
      limit: 2,
      has_more: true,
    }));
  });
});
