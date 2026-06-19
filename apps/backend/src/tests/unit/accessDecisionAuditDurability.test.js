/**
 * Audit §3 (PHI/audit) fail-safe regression — patient-access audit durability.
 *
 * accessDecisionService.writePatientAccessAudit() persists every patient PHI
 * access decision to patient_access_audit_log. Two gaps violated "audit never
 * lost":
 *   1. A DB-write failure was swallowed (catch → logger.warn) with NO durable
 *      file fallback carrying the decision — the audit row was lost on DB error.
 *   2. When the patient could not be resolved, the function early-returned and
 *      wrote NO row at all — a denied access attempt left no audit trail.
 *
 * This test asserts (1) the failure path emits a durable file fallback carrying
 * the decision tuple, and (2) an unresolved-patient denial still emits an audit
 * record marked as such. Neither path may throw (audit is non-blocking).
 *
 * Pure unit test: prisma + logger fully mocked, no DB.
 */

import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

const warnMock = jest.fn();
const errorMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
    error: errorMock,
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { ACCESS_POLICY_CODES, authorizePatientAccessRequest } = await import(
  '../../services/security/accessDecisionService.js'
);

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const TENANT = '00000000-0000-4000-8000-000000000001';

function reqFor(role, extras = {}) {
  return {
    id: 'req-audit-1',
    method: 'GET',
    originalUrl: '/api/v1/records?patient_id=15',
    params: {},
    query: { patient_id: '15' },
    body: {},
    user: {
      id: 9,
      uid: ACTOR_UID,
      role,
      tenant_id: TENANT,
      ...extras.user,
    },
    ...extras,
  };
}

function patientLookup() {
  return [{ id: 15, uid: PATIENT_UID }];
}

beforeEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
  warnMock.mockReset();
  errorMock.mockReset();
});

describe('patient-access audit durability', () => {
  it('writes a durable file fallback carrying the decision when the audit DB write fails', async () => {
    // Resolve patient, then deny (no relationship). The audit INSERT then fails.
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup()) // resolvePatientForAccess
      .mockResolvedValue([]); // relationship probes → none
    prismaMock.$executeRawUnsafe.mockRejectedValueOnce(new Error('audit table missing'));

    let decision;
    await expect(
      (async () => {
        decision = await authorizePatientAccessRequest(reqFor('CNO'), {
          policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
          recordType: 'MEDICAL_RECORD',
        });
      })(),
    ).resolves.not.toThrow();

    // The access decision itself is unaffected by the audit failure.
    expect(decision.allowed).toBe(false);

    // Durable fallback fired, carrying enough of the decision to reconstruct it.
    expect(warnMock).toHaveBeenCalled();
    const fallbackCall = warnMock.mock.calls.find(
      (c) => c[1] && typeof c[1] === 'object' && 'access_decision' in c[1],
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall[1]).toEqual(
      expect.objectContaining({
        tenant_id: TENANT,
        patient_uid: PATIENT_UID,
        actor_uid: ACTOR_UID,
        access_decision: 'deny',
      }),
    );
  });

  it('still emits an audit record (marked unresolved) when the patient cannot be resolved', async () => {
    // resolvePatientForAccess returns nothing → unresolved patient.
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('DOCTOR'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/could not be resolved/i);

    // patient_access_audit_log.patient_uid is NOT NULL, so a patientless attempt
    // cannot be a DB row — but the denied access attempt MUST still leave an
    // audit trail. It is emitted to the durable Winston file sink with an
    // explicit unresolved-patient marker, never silently dropped.
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
    const unresolvedCall = warnMock.mock.calls.find(
      (c) => c[1] && typeof c[1] === 'object' && c[1].patient_unresolved === true,
    );
    expect(unresolvedCall).toBeDefined();
    expect(unresolvedCall[1]).toEqual(
      expect.objectContaining({
        tenant_id: TENANT,
        actor_uid: ACTOR_UID,
        access_decision: 'deny',
        patient_unresolved: true,
      }),
    );
  });

  it('does not throw when emitting the unresolved-patient audit record', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(
      authorizePatientAccessRequest(reqFor('DOCTOR'), {
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
        recordType: 'MEDICAL_RECORD',
        patient: { id: 15 },
        requireResolvedPatient: true,
      }),
    ).resolves.toMatchObject({ allowed: false });

    // The unresolved record reached the durable file fallback, not lost.
    expect(warnMock).toHaveBeenCalled();
  });
});
