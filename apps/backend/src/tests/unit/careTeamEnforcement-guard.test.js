import { jest } from '@jest/globals';

// CareTeam ABAC Phase 0 — guard behaviour under each per-tenant enforcement
// mode. Proves the CRITICAL non-breaking guarantee:
//   * off     → ABAC skipped entirely, no prisma access, next() called.
//   * shadow  → would-be denial is ALLOWED (next called) but a 'deny' audit row
//               is still written. NEVER 403.
//   * shadow  → an unexpected engine error FAILS OPEN (next called), never 500.
//   * enforce → a genuine denial returns 403.

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Control the per-tenant mode directly.
const modeMock = jest.fn(async () => 'shadow');
jest.unstable_mockModule('../../services/security/careTeamEnforcement.js', () => ({
  CARE_TEAM_ENFORCEMENT_MODES: { OFF: 'off', SHADOW: 'shadow', ENFORCE: 'enforce' },
  resolveEnforcementModeForRequest: modeMock,
}));

const { patientAccessGuard } = await import('../../middleware/phiAccessMiddleware.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
  modeMock.mockReset();
  modeMock.mockResolvedValue('shadow');
});

function resStub() {
  return {
    statusCode: 200,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    on: jest.fn(),
  };
}

// A DOCTOR with NO relationship to the patient — the engine denies this.
function unrelatedDoctorReq() {
  return {
    id: 'req-x',
    method: 'GET',
    originalUrl: '/api/v1/lab?patient_id=15',
    params: {},
    query: { patient_id: '15' },
    body: {},
    user: {
      id: 9,
      uid: ACTOR_UID,
      role: 'DOCTOR',
      tenant_id: '00000000-0000-4000-8000-000000000001',
    },
  };
}

// Engine call sequence for an unrelated DOCTOR under patient.record.view:
//   [0] patient resolve, [1] care_team, [2] referral, [3] appointment,
//   [4] admission  → all empty → deny.
function mockUnrelatedDoctorDenied() {
  prismaMock.$queryRawUnsafe
    .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }]) // patient resolve
    .mockResolvedValueOnce([]) // care_team
    .mockResolvedValueOnce([]) // referral
    .mockResolvedValueOnce([]) // appointment
    .mockResolvedValueOnce([]); // admission
  prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined); // audit row
}

describe('patientAccessGuard — enforcement mode off', () => {
  it('skips ABAC entirely and calls next without touching prisma', async () => {
    modeMock.mockResolvedValue('off');
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('patientAccessGuard — enforcement mode shadow', () => {
  it('ALLOWS a would-be denial (next called, no 403) but still writes a deny audit row', async () => {
    modeMock.mockResolvedValue('shadow');
    mockUnrelatedDoctorDenied();
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    // Non-breaking: the request proceeds.
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    // But the would-be denial is audited (access_decision='deny', shadow_mode=true).
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const auditArgs = prismaMock.$executeRawUnsafe.mock.calls[0];
    expect(auditArgs[5]).toBe('deny'); // access_decision
    const metadata = JSON.parse(auditArgs[13]);
    expect(metadata.shadow_mode).toBe(true);
  });

  it('FAILS OPEN (next called, no 500) when the engine throws an unexpected error', async () => {
    modeMock.mockResolvedValue('shadow');
    // Patient resolve throws a non-schema-missing error.
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('connection reset'));
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('patientAccessGuard — enforcement mode enforce', () => {
  it('returns 403 on a genuine denial', async () => {
    modeMock.mockResolvedValue('enforce');
    mockUnrelatedDoctorDenied();
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_DENIED',
    }));
    // The deny audit row is still written in enforce mode.
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('deny');
  });

  it('FAILS CLOSED (500) on an unexpected engine error', async () => {
    modeMock.mockResolvedValue('enforce');
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('connection reset'));
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('patientAccessGuard — non-breaking on a legitimate request', () => {
  it('a doctor WITH an active care-team relationship is allowed in every mode', async () => {
    for (const mode of ['shadow', 'enforce']) {
      modeMock.mockResolvedValue(mode);
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }]) // patient resolve
        .mockResolvedValueOnce([{ id: 4, care_team_id: 5 }]); // care_team hit
      prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined); // allow audit
      const next = jest.fn();
      const res = resStub();

      await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('allow');

      prismaMock.$queryRawUnsafe.mockReset();
      prismaMock.$executeRawUnsafe.mockReset();
    }
  });
});

describe('patientAccessGuard — legacy (non-care-team-governed) sites are unchanged', () => {
  it('ignores the per-tenant mode and ALWAYS enforces (403) when careTeamModeGoverned is not set', async () => {
    // Even if a tenant were set to shadow/off, a legacy call site must keep its
    // historical enforce contract — the per-tenant flag only governs the new
    // care-team coverage. The resolver must not even be consulted here.
    modeMock.mockResolvedValue('shadow');
    mockUnrelatedDoctorDenied();
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT')(unrelatedDoctorReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(modeMock).not.toHaveBeenCalled();
  });
});
