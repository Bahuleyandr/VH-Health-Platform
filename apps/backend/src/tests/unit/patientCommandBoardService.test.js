import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '10000000-0000-4000-8000-000000000001';
const DUTY_DOCTOR_UID = '10000000-0000-4000-8000-000000000002';
const HOUSEKEEPING_UID = '40000000-0000-4000-8000-000000000001';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
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
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
  for (const [key, model] of Object.entries(prismaMock)) {
    if (key === '$queryRawUnsafe') continue;
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

  it('normalizes consultant aliases before selecting board actions and scope labels', async () => {
    prismaMock.admissions.count.mockResolvedValueOnce(1);
    prismaMock.admissions.findMany.mockResolvedValueOnce([
      {
        id: 9,
        tenant_id: TENANT,
        encounter_id: '20000000-0000-4000-8000-000000009999',
        patient_uid: '30000000-0000-4000-8000-000000009999',
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        ward: 'Consultant Ward',
        bed_id: 19,
        bed_number: 'C19',
        status: 'admitted',
        admission_type: 'IPD',
        priority: 'routine',
        allergies: [],
        admitted_at: new Date('2026-05-31T08:00:00.000Z'),
      },
    ]);

    const result = await patientCommandBoardService.default.getPatientCommandBoard(
      { limit: 10 },
      { uid: DOCTOR_UID, role: 'CONSULTANT_PHYSICIAN', tenantId: TENANT },
    );

    expect(result.board.actor).toEqual(expect.objectContaining({
      role: 'CONSULTANT',
      view_label: 'Consultant ward round',
    }));
    expect(result.board.scope.role_scope).toEqual(expect.objectContaining({
      type: 'own_patients',
      source: 'doctor_assignment',
    }));
    expect(result.rows[0].actions.map((action) => action.key)).toEqual(
      expect.arrayContaining(['notes', 'orders', 'drug_chart', 'case_sheet', 'discharge']),
    );
  });

  it('scopes duty doctors to the floors currently assigned to them', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          assignment_id: 21,
          department: 'medical',
          assignment_target_type: 'floor',
          assignment_target_label: 'Second Floor',
          floor: '2',
        },
        {
          assignment_id: 22,
          department: 'medical',
          assignment_target_type: 'floor',
          assignment_target_label: 'Third Floor',
          floor: '3',
        },
      ])
      .mockResolvedValueOnce([
        { id: 2, name: 'Second Floor Ward', floor: 2 },
        { id: 3, name: 'Third Floor Ward', floor: 3 },
      ])
      .mockResolvedValueOnce([
        { id: 201, ward_name: 'Second Floor Ward', floor: 2, ward_id: 2 },
        { id: 301, ward_name: 'Third Floor Ward', floor: 3, ward_id: 3 },
      ]);
    prismaMock.admissions.count.mockResolvedValueOnce(8);
    prismaMock.admissions.findMany.mockResolvedValueOnce([]);

    const result = await patientCommandBoardService.default.getPatientCommandBoard(
      { limit: 50 },
      { uid: DUTY_DOCTOR_UID, id: 12, role: 'FLOOR_DOCTOR', tenantId: TENANT },
    );

    expect(result.board.actor.role).toBe('DUTY_DOCTOR');
    expect(result.board.scope.role_scope).toEqual(expect.objectContaining({
      type: 'duty_doctor',
      source: 'current_published_medical_roster',
      floors: [2, 3],
      wards: ['Second Floor Ward', 'Third Floor Ward'],
    }));
    expect(result.board.counts).toEqual(expect.objectContaining({
      total: 8,
      returned: 0,
      has_more: true,
    }));
    const countWhere = JSON.stringify(prismaMock.admissions.count.mock.calls[0][0].where);
    expect(countWhere).toContain('Second Floor Ward');
    expect(countWhere).toContain('Third Floor Ward');
    expect(countWhere).toContain('bed_id');
  });

  it('gives medical superintendent a full tenant command count without roster lookup', async () => {
    prismaMock.admissions.count.mockResolvedValueOnce(46);
    prismaMock.admissions.findMany.mockResolvedValueOnce([]);

    const result = await patientCommandBoardService.default.getPatientCommandBoard(
      { limit: 20 },
      { uid: DOCTOR_UID, role: 'MEDICAL_SUPERINTENDANT', tenantId: TENANT },
    );

    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result.board.actor).toEqual(expect.objectContaining({
      role: 'MEDICAL_SUPERINTENDENT',
      view_label: 'Medical superintendent command',
    }));
    expect(result.board.scope.role_scope).toEqual(expect.objectContaining({
      type: 'full',
      source: 'governance_role',
    }));
    expect(result.board.counts.total).toBe(46);
  });

  it('gives nursing incharge full inpatient visibility but nursing actions only', async () => {
    prismaMock.admissions.count.mockResolvedValueOnce(1);
    prismaMock.admissions.findMany.mockResolvedValueOnce([
      {
        id: 18,
        tenant_id: TENANT,
        encounter_id: '20000000-0000-4000-8000-000000000018',
        patient_uid: '30000000-0000-4000-8000-000000000018',
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        ward: 'ICU',
        bed_id: 118,
        bed_number: 'ICU-18',
        status: 'admitted',
        admission_type: 'IPD',
        priority: 'urgent',
        allergies: [],
        admitted_at: new Date('2026-05-31T08:00:00.000Z'),
      },
    ]);

    const result = await patientCommandBoardService.default.getPatientCommandBoard(
      { limit: 20 },
      { uid: '20000000-0000-4000-8000-000000000018', role: 'NURSING_IN_CHARGE', tenantId: TENANT },
    );

    expect(result.board.actor).toEqual(expect.objectContaining({
      role: 'NURSING_INCHARGE',
      view_label: 'Nursing command',
    }));
    expect(result.board.scope.role_scope).toEqual(expect.objectContaining({
      type: 'full',
      source: 'governance_role',
    }));
    const actions = result.rows[0].actions.map((action) => action.key);
    expect(actions).toEqual(expect.arrayContaining(['vitals', 'notes', 'drug_chart', 'handover', 'discharge']));
    expect(actions).not.toContain('orders');
  });

  it('scopes housekeeping staff to their floor and minimizes patient PHI', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          assignment_id: 42,
          department: 'housekeeping',
          assignment_target_type: 'floor',
          assignment_target_label: 'Third Floor',
          floor: '3',
        },
      ])
      .mockResolvedValueOnce([{ id: 3, name: 'Third Floor Ward', floor: 3 }])
      .mockResolvedValueOnce([{ id: 301, ward_name: 'Third Floor Ward', floor: 3, ward_id: 3 }]);
    prismaMock.admissions.count.mockResolvedValueOnce(1);
    prismaMock.admissions.findMany.mockResolvedValueOnce([
      {
        id: 33,
        tenant_id: TENANT,
        encounter_id: '20000000-0000-4000-8000-000000000033',
        patient_uid: '30000000-0000-4000-8000-000000000033',
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        ward: 'Third Floor Ward',
        bed_id: 301,
        bed_number: '301-A',
        status: 'admitted',
        admission_type: 'IPD',
        priority: 'routine',
        allergies: [],
        admitted_at: new Date('2026-05-31T08:00:00.000Z'),
      },
    ]);

    const result = await patientCommandBoardService.default.getPatientCommandBoard(
      { limit: 20 },
      { uid: HOUSEKEEPING_UID, id: 35, role: 'HOUSEKEEPING_ATTENDANT', tenantId: TENANT },
    );

    expect(result.board.actor).toEqual(expect.objectContaining({
      role: 'HOUSEKEEPING_STAFF',
      view_label: 'Housekeeping floor board',
    }));
    expect(result.board.scope.role_scope).toEqual(expect.objectContaining({
      type: 'housekeeping',
      source: 'active_housekeeping_floor_assignment',
      floors: [3],
      wards: ['Third Floor Ward'],
    }));
    expect(result.board.counts.total).toBe(1);
    expect(result.rows[0]).toEqual(expect.objectContaining({
      patient_uid: null,
      actions: [],
    }));
    expect(result.rows[0].patient).toEqual(expect.objectContaining({
      uid: null,
      name: 'Occupied',
      phone: null,
    }));
    expect(result.rows[0].diagnosis).toEqual(expect.objectContaining({
      status: 'hidden',
      source: 'minimized',
    }));
  });
});
