import { jest } from '@jest/globals';

// The admin care-team writer must refuse any shape the patient-access engine
// cannot honour, BEFORE it reaches the database.
//
// The migration-260 CHECK constraint is far looser than the engine: it accepts
// any of nine team kinds in any combination of episode ids. Two of those
// combinations match none of the engine's three branches, so the row inserts,
// the API answers 201, and the clinician the operator was unblocking still
// gets a 403 that names no cause. These tests pin the refusal — and pin that
// no INSERT was attempted, since a rejection that still wrote the row would be
// worse than the silence it replaces.

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (value) => value || TENANT_ID,
}));

jest.unstable_mockModule('../../services/clinical/mergedPatientReadUnion.js', () => ({
  mergedPatientUidsSubquery: () => 'SELECT 1',
}));

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a6666666-6666-4666-8666-666666666a01';
const ACTOR_UID = 'a6666666-6666-4666-8666-666666666a03';

const { createCareTeam } = await import('../../services/governance/clinicalGovernanceService.js');
const {
  CARE_TEAM_SHAPE_REJECTIONS,
} = await import('../../config/careTeamContextShapes.js');

beforeEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
  prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 1 }]);
});

const baseArgs = {
  tenantId: TENANT_ID,
  patientUid: PATIENT_UID,
  createdBy: ACTOR_UID,
};

describe('createCareTeam — refuses unhonourable shapes at the door', () => {
  it.each(['op', 'ip', 'er', 'icu', 'day_care', 'dialysis', 'perioperative', 'other'])(
    'rejects a context-free %s team with a 400 and writes nothing',
    async (teamKind) => {
      await expect(createCareTeam({ ...baseArgs, teamKind })).rejects.toMatchObject({
        statusCode: 400,
        code: CARE_TEAM_SHAPE_REJECTIONS.CONTEXT_FREE_REQUIRES_LONGITUDINAL,
      });
      expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it('rejects a team scoped to BOTH an admission and an appointment', async () => {
    await expect(createCareTeam({
      ...baseArgs,
      teamKind: 'longitudinal',
      admissionId: 11,
      appointmentId: 22,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: CARE_TEAM_SHAPE_REJECTIONS.AMBIGUOUS_EPISODE_CONTEXT,
    });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('createCareTeam — still accepts every shape the engine honours', () => {
  it('accepts a context-free longitudinal team (the default kind)', async () => {
    await expect(createCareTeam({ ...baseArgs })).resolves.toEqual({ id: 1 });
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    // Positional args: tenant, patient, admission_id, appointment_id, team_kind.
    const args = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(args[3]).toBeNull();
    expect(args[4]).toBeNull();
    expect(args[5]).toBe('longitudinal');
  });

  it('accepts an appointment-scoped op team — the shape the booking hook writes', async () => {
    await expect(createCareTeam({
      ...baseArgs, teamKind: 'op', appointmentId: 22,
    })).resolves.toEqual({ id: 1 });
    const args = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(args[3]).toBeNull();
    expect(args[4]).toBe(22);
    expect(args[5]).toBe('op');
  });

  it('accepts an admission-scoped ip team — the shape the admission hook writes', async () => {
    await expect(createCareTeam({
      ...baseArgs, teamKind: 'ip', admissionId: 11,
    })).resolves.toEqual({ id: 1 });
    const args = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(args[3]).toBe(11);
    expect(args[4]).toBeNull();
    expect(args[5]).toBe('ip');
  });
});
