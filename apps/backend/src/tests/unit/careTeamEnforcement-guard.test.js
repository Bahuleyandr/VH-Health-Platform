import { jest } from '@jest/globals';

// CareTeam ABAC Phase 0 — guard behaviour under each per-tenant enforcement
// mode. Proves the CRITICAL non-breaking guarantee:
//   * off     → ABAC skipped entirely, no prisma access, next() called.
//   * shadow  → would-be denial is ALLOWED (next called) but a 'deny' audit row
//               is still written. NEVER 403.
//   * shadow  → an unexpected engine error FAILS CLOSED; shadow only affects a
//               successfully-computed relationship denial.
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

const loggerWarnMock = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: loggerWarnMock,
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

const {
  patientAccessGuard,
  patientAccessGuardForResource,
} = await import('../../middleware/phiAccessMiddleware.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
  loggerWarnMock.mockReset();
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

  it('allows and audits a required patient context that cannot be resolved', async () => {
    modeMock.mockResolvedValue('shadow');
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('ONCOLOGY_DIAGNOSIS', {
      careTeamModeGoverned: true,
      patientSelector: async () => null,
      requirePatientContext: true,
    })(unrelatedDoctorReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Patient access audit file fallback:',
      expect.objectContaining({
        access_decision: 'deny',
        patient_unresolved: true,
        shadow_mode: true,
      }),
    );
  });

  it('allows an unresolved resource and records the would-be denial', async () => {
    modeMock.mockResolvedValue('shadow');
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const next = jest.fn();
    const res = resStub();
    const req = unrelatedDoctorReq();
    req.params = { id: '404' };

    await patientAccessGuardForResource('ONCOLOGY_DIAGNOSIS', {
      resourceType: 'oncology_diagnosis',
      careTeamModeGoverned: true,
    })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Patient access audit file fallback:',
      expect.objectContaining({
        access_decision: 'deny',
        patient_unresolved: true,
        shadow_mode: true,
      }),
    );
  });

  it('FAILS CLOSED when the engine throws an unexpected error', async () => {
    modeMock.mockResolvedValue('shadow');
    // Patient resolve throws a non-schema-missing error.
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('connection reset'));
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_CHECK_FAILED',
    }));
  });

  it('FAILS CLOSED when resource ownership resolution throws', async () => {
    modeMock.mockResolvedValue('shadow');
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('connection reset'));
    const next = jest.fn();
    const res = resStub();
    const req = unrelatedDoctorReq();
    req.params = { id: '404' };

    await patientAccessGuardForResource('ONCOLOGY_DIAGNOSIS', {
      resourceType: 'oncology_diagnosis',
      careTeamModeGoverned: true,
    })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_CHECK_FAILED',
    }));
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

describe('patientAccessGuard — enforcement mode resolution failure', () => {
  it('returns 500 instead of silently downgrading an unknown tenant posture to shadow', async () => {
    modeMock.mockRejectedValueOnce(new Error('tenant settings unavailable'));
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true })(unrelatedDoctorReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CARE_TEAM_MODE_UNAVAILABLE',
    }));
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
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

  it('allows an enforce-mode oncology write derived from a tenant-scoped pathology report', async () => {
    modeMock.mockResolvedValue('enforce');
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }]) // pathology report owner
      .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }]) // canonical patient
      .mockResolvedValueOnce([{ id: 4, care_team_id: 5 }]); // care-team relationship
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    const res = resStub();
    const req = unrelatedDoctorReq();
    req.params = { id: '73' };

    await patientAccessGuardForResource('ONCOLOGY', {
      resourceType: 'pathology_report',
      careTeamModeGoverned: true,
      requirePatientContext: true,
    })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('FROM ap_reports');
  });

  it('keeps direct patient context valid when an optional derived resource is absent', async () => {
    modeMock.mockResolvedValue('enforce');
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }]) // canonical patient
      .mockResolvedValueOnce([{ id: 4, care_team_id: 5 }]); // care-team relationship
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    const res = resStub();
    const req = unrelatedDoctorReq();
    req.query = {};
    req.body = { patient_uid: PATIENT_UID };

    await patientAccessGuardForResource('ONCOLOGY', {
      resourceType: 'pathology_report',
      idSelector: (request) => request.body?.pathology_report_id,
      careTeamModeGoverned: true,
      requirePatientContext: true,
    })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('FROM users');
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

  it('FAILS CLOSED (500, never next()) when the engine throws on a legacy site', async () => {
    // Legacy sites are the shape that serves most PHI routes today — including
    // GET /api/v1/emr/timeline/:patientUid. They never see shadow, so the
    // fail-open branch removed in d192410dc was never reachable from them and
    // an erroring engine here has always had to deny. Pin it: a broken
    // authorization engine must not become an open door on the busiest shape.
    modeMock.mockResolvedValue('shadow');
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('connection reset'));
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('EMR_TIMELINE', { policyCode: 'patient.timeline.view' })(
      unrelatedDoctorReq(), res, next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_CHECK_FAILED',
    }));
  });

  it('distinguishes a computed DENIAL (403) from a broken engine (500)', async () => {
    // The whole diagnosis of the emr-chart-read regression turned on this
    // distinction: a 403 carrying PATIENT_ACCESS_DENIED is the engine working
    // and saying no, so the cause is the relationship data, not an exception.
    // A guard that collapsed both into one status would have sent the
    // investigation after a non-existent thrown error.
    mockUnrelatedDoctorDenied();
    const denyRes = resStub();
    await patientAccessGuard('EMR_TIMELINE', { policyCode: 'patient.timeline.view' })(
      unrelatedDoctorReq(), denyRes, jest.fn(),
    );
    expect(denyRes.status).toHaveBeenCalledWith(403);
    expect(denyRes.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_DENIED',
    }));

    prismaMock.$queryRawUnsafe.mockReset();
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('connection reset'));
    const errorRes = resStub();
    await patientAccessGuard('EMR_TIMELINE', { policyCode: 'patient.timeline.view' })(
      unrelatedDoctorReq(), errorRes, jest.fn(),
    );
    expect(errorRes.status).toHaveBeenCalledWith(500);
    expect(errorRes.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_CHECK_FAILED',
    }));
  });
});
