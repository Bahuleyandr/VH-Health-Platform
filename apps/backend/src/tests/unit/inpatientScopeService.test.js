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

  it('gives medical superintendent and nursing incharge full tenant inpatient scope', async () => {
    await expect(resolveInpatientAdmissionScope({
      actor: { role: 'MEDICAL_SUPERINTENDENT', tenantId: TENANT },
    })).resolves.toEqual(expect.objectContaining({
      where: { tenant_id: TENANT },
      scope: expect.objectContaining({ type: 'full', source: 'governance_role' }),
    }));

    await expect(resolveInpatientAdmissionScope({
      actor: { role: 'NURSING_INCHARGE', tenantId: TENANT },
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
