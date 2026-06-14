import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { populateAdmissionCareTeam } = await import('../../services/security/careTeamPopulationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ADMITTING = '22222222-2222-4222-8222-222222222222';
const ATTENDING = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
});

function admissionRow(extra = {}) {
  return {
    id: 77,
    tenant_id: TENANT,
    patient_uid: PATIENT_UID,
    admitting_doctor: ADMITTING,
    attending_doctor: ATTENDING,
    created_by: ADMITTING,
    ...extra,
  };
}

describe('populateAdmissionCareTeam', () => {
  it('creates an ip care team and adds admitting + attending doctors when none exists', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // no existing team
      .mockResolvedValueOnce([{ id: 500 }]); // INSERT ... RETURNING id (new team)
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined); // member inserts

    const result = await populateAdmissionCareTeam(admissionRow());

    expect(result.careTeamId).toBe(500);
    expect(result.membersAttempted).toBe(2);

    // First query: existence check against care_teams.
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FROM care_teams/i);
    // Second query: INSERT INTO care_teams ... team_kind 'ip'.
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toMatch(/INSERT INTO care_teams/i);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toMatch(/'ip'/);

    // Two member inserts, both into care_team_members with ON CONFLICT DO NOTHING.
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.$executeRawUnsafe.mock.calls) {
      expect(call[0]).toMatch(/INSERT INTO care_team_members/i);
      expect(call[0]).toMatch(/ON CONFLICT/i);
      expect(call[0]).toMatch(/DO NOTHING/i);
    }
    // Relationship kinds: primary_consultant + attending_doctor.
    const relKinds = prismaMock.$executeRawUnsafe.mock.calls.map((c) => c[7]);
    expect(relKinds).toContain('primary_consultant');
    expect(relKinds).toContain('attending_doctor');
    // staff_uid carries the doctor uids.
    const staffUids = prismaMock.$executeRawUnsafe.mock.calls.map((c) => c[4]);
    expect(staffUids).toContain(ADMITTING);
    expect(staffUids).toContain(ATTENDING);
  });

  it('reuses an existing active care team (idempotent — no second team insert)', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ id: 900 }]); // existing team
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);

    const result = await populateAdmissionCareTeam(admissionRow());

    expect(result.careTeamId).toBe(900);
    // Only the existence SELECT ran on $queryRawUnsafe — no INSERT team.
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('adds explicitly-supplied ward nurses as nurse members', async () => {
    const NURSE = '44444444-4444-4444-8444-444444444444';
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 501 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);

    const result = await populateAdmissionCareTeam(admissionRow(), { wardNurseUids: [NURSE] });

    expect(result.membersAttempted).toBe(3);
    const relKinds = prismaMock.$executeRawUnsafe.mock.calls.map((c) => c[7]);
    expect(relKinds).toContain('nurse');
  });

  it('skips silently when patient_uid or admission id is missing (not an error)', async () => {
    const result = await populateAdmissionCareTeam({ id: null, patient_uid: null });
    expect(result.careTeamId).toBeNull();
    expect(result.membersAttempted).toBe(0);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('NEVER throws — a DB failure is swallowed and the admission stands', async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('db exploded'));
    await expect(populateAdmissionCareTeam(admissionRow())).resolves.toEqual({
      careTeamId: null,
      membersAttempted: 0,
    });
  });

  it('handles a missing attending doctor (admitting only)', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 502 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);

    const result = await populateAdmissionCareTeam(admissionRow({ attending_doctor: null }));

    expect(result.membersAttempted).toBe(1);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][7]).toBe('primary_consultant');
  });
});
