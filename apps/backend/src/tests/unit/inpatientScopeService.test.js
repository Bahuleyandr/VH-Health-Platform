import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  admissions: {
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));

const {
  resolveInpatientAdmissionScope,
  resolveInpatientLocationScope,
  __testing__,
} = await import('../../services/emr/inpatientScopeService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '10000000-0000-4000-8000-000000000001';
const NURSE_UID = '20000000-0000-4000-8000-000000000001';

beforeEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.admissions.findMany.mockReset();
});

describe('resolveInpatientAdmissionScope', () => {
  it('scopes consultants and ordinary doctors to their own admissions', async () => {
    const result = await resolveInpatientAdmissionScope({
      actor: { uid: DOCTOR_UID, role: 'CONSULTANT', tenantId: TENANT },
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'own_patients',
      source: 'doctor_assignment',
    }));
    expect(result.where).toEqual({
      tenant_id: TENANT,
      OR: [
        { admitting_doctor: DOCTOR_UID },
        { attending_doctor: DOCTOR_UID },
      ],
    });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([
    'CMO',
    'CHIEF_MEDICAL_OFFICER',
    'MEDICAL_SUPERINTENDENT',
    'NURSING_INCHARGE',
    'CNO',
    'NURSING_SUPERINTENDENT',
    'HOUSEKEEPING_INCHARGE',
  ])('gives %s full tenant inpatient scope', async (role) => {
    await expect(resolveInpatientAdmissionScope({
      actor: { role, tenantId: TENANT },
    })).resolves.toEqual(expect.objectContaining({
      where: { tenant_id: TENANT },
      scope: expect.objectContaining({ type: 'full', source: 'governance_role' }),
    }));
  });

  it('scopes staff nurses to their current published roster floor', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        assignment_id: 7,
        department: 'nursing',
        assignment_target_type: 'ward',
        assignment_target_id: 12,
        assignment_target_label: 'First Floor Ward',
        floor: '1',
      }])
      .mockResolvedValueOnce([{ id: 12, name: 'First Floor Ward', floor: 1 }])
      .mockResolvedValueOnce([{ id: 91, ward_name: 'First Floor Ward', floor: 1, ward_id: 12 }]);

    const result = await resolveInpatientAdmissionScope({
      actor: { uid: NURSE_UID, id: 22, role: 'NURSING_STAFF', tenantId: TENANT },
      now: new Date('2026-05-31T08:30:00.000Z'),
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'ward_nursing',
      source: 'current_published_nursing_roster',
      floors: [1],
      wards: ['First Floor Ward'],
    }));
    expect(result.where).toEqual({
      tenant_id: TENANT,
      OR: [
        { ward: { in: ['First Floor Ward'] } },
        { bed_id: { in: [91] } },
      ],
    });
  });

  it('accepts legacy staff-nurse role aliases for ward-scoped nursing', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        assignment_id: 8,
        department: 'nursing',
        assignment_target_type: 'ward',
        assignment_target_id: 12,
        assignment_target_label: 'First Floor Ward',
        floor: '1',
      }])
      .mockResolvedValueOnce([{ id: 12, name: 'First Floor Ward', floor: 1 }])
      .mockResolvedValueOnce([{ id: 91, ward_name: 'First Floor Ward', floor: 1, ward_id: 12 }]);

    const result = await resolveInpatientAdmissionScope({
      actor: { uid: NURSE_UID, id: 22, role: 'STAFF_NURSE', tenantId: TENANT },
      now: new Date('2026-05-31T08:30:00.000Z'),
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'ward_nursing',
      source: 'current_published_nursing_roster',
      floors: [1],
      wards: ['First Floor Ward'],
    }));
  });

  it('scopes duty doctors to all currently rostered floors they cover', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          assignment_id: 11,
          department: 'medical',
          assignment_target_type: 'medical_unit',
          assignment_target_id: null,
          assignment_target_label: 'First Floor Coverage',
          floor: '1',
        },
        {
          assignment_id: 12,
          department: 'medical',
          assignment_target_type: 'medical_unit',
          assignment_target_id: null,
          assignment_target_label: 'Second Floor Coverage',
          floor: '2',
        },
      ])
      .mockResolvedValueOnce([
        { id: 21, name: 'First Floor Ward', floor: 1 },
        { id: 22, name: 'Second Floor Ward', floor: 2 },
      ])
      .mockResolvedValueOnce([
        { id: 201, ward_name: 'First Floor Ward', floor: 1, ward_id: 21 },
        { id: 202, ward_name: 'Second Floor Ward', floor: 2, ward_id: 22 },
      ]);

    const result = await resolveInpatientAdmissionScope({
      actor: { uid: DOCTOR_UID, id: 15, role: 'DUTY_DOCTOR', tenantId: TENANT },
      now: new Date('2026-05-31T08:30:00.000Z'),
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'duty_doctor',
      source: 'current_published_medical_roster',
      floors: [1, 2],
      wards: ['First Floor Ward', 'Second Floor Ward'],
    }));
    expect(result.where).toEqual({
      tenant_id: TENANT,
      OR: [
        { ward: { in: ['First Floor Ward', 'Second Floor Ward'] } },
        { bed_id: { in: [201, 202] } },
      ],
    });
  });

  it('falls duty doctors back to own patients when no current roster is published', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await resolveInpatientAdmissionScope({
      actor: { uid: DOCTOR_UID, id: 15, role: 'DUTY_DOCTOR', tenantId: TENANT },
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'duty_doctor',
      source: 'own_patient_fallback_no_current_roster',
      assignment_count: 0,
    }));
    expect(result.where.OR).toEqual([
      { admitting_doctor: DOCTOR_UID },
      { attending_doctor: DOCTOR_UID },
    ]);
  });

  it('scopes housekeeping staff to their current rostered floor', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        assignment_id: 19,
        department: 'housekeeping',
        assignment_target_type: 'housekeeping_zone',
        assignment_target_id: null,
        assignment_target_label: 'Third Floor',
        floor: '3',
      }])
      .mockResolvedValueOnce([{ id: 31, name: 'Third Floor Ward', floor: 3 }])
      .mockResolvedValueOnce([{ id: 301, ward_name: 'Third Floor Ward', floor: 3, ward_id: 31 }]);

    const result = await resolveInpatientAdmissionScope({
      actor: { uid: NURSE_UID, id: 35, role: 'HOUSEKEEPING_STAFF', tenantId: TENANT },
      now: new Date('2026-05-31T08:30:00.000Z'),
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'housekeeping',
      source: 'current_published_housekeeping_roster',
      floors: [3],
      wards: ['Third Floor Ward'],
    }));
    expect(result.where).toEqual({
      tenant_id: TENANT,
      OR: [
        { ward: { in: ['Third Floor Ward'] } },
        { bed_id: { in: [301] } },
      ],
    });
  });

  it('returns zero-scope for rostered support roles with no current posting', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await resolveInpatientAdmissionScope({
      actor: { uid: NURSE_UID, id: 35, role: 'HOUSEKEEPING_STAFF', tenantId: TENANT },
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'housekeeping',
      source: 'no_current_roster_assignment',
      assignment_count: 0,
    }));
    expect(result.where).toEqual({ tenant_id: TENANT, id: -1 });
  });
});

describe('inpatient scope coverage helpers', () => {
  it('keeps doctor location scope to their occupied bed ids only', async () => {
    prismaMock.admissions.findMany.mockResolvedValueOnce([
      { bed_id: 10 },
      { bed_id: 11 },
      { bed_id: null },
    ]);

    const result = await resolveInpatientLocationScope({
      actor: { uid: DOCTOR_UID, role: 'CONSULTANT', tenantId: TENANT },
    });

    expect(result.scope).toEqual(expect.objectContaining({
      type: 'own_patients',
      source: 'doctor_assignment',
    }));
    expect(result).toEqual(expect.objectContaining({
      allLocations: false,
      wardIds: [],
      wardNames: [],
      bedIds: [10, 11],
      floors: [],
    }));
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('parses text floors used by roster boards', () => {
    expect(__testing__.parseFloor('Ground')).toBe(0);
    expect(__testing__.parseFloor('First floor')).toBe(1);
    expect(__testing__.parseFloor('Floor 3')).toBe(3);
    expect(__testing__.parseFloor('All floors')).toBe('all');
  });
});
