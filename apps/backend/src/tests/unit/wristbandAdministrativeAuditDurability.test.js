/**
 * Owner decision 2026-08-25, third clause — "make the audit write unable to
 * break the print".
 *
 * A wristband is a bedside safety artifact on a PHI READ path. The
 * administrative-access audit row the owner asked for must never be able to
 * turn a band into a 500: an audit sink that is down is an operations problem,
 * not a reason to leave a nurse at the bedside without a patient identity band.
 *
 * Two layers are asserted here, with logAudit itself replaced by a thrower so
 * the repo's own swallow-inside-logAudit is bypassed and the ROUTE's wrapper is
 * what is actually under test:
 *   1. recordAdministrativeWristbandAudit RESOLVES (never rejects) when the
 *      sink throws, and reports the failure at error level so it is visible.
 *   2. It is a no-op — no sink call at all — for a relationship-backed
 *      decision, which is what keeps a nursing print from being labelled
 *      administrative.
 *
 * Pure unit test: prisma, logger and logAudit are mocked, no DB.
 */

import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

const errorMock = jest.fn();
const warnMock = jest.fn();

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

const logAuditMock = jest.fn();
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

const {
  recordAdministrativeWristbandAudit,
  WRISTBAND_ADMIN_AUDIT_ACTION,
} = await import('../../routes/clinical/bcmaRoutes.js');

const PATIENT = {
  id: 42,
  uid: '11111111-1111-4111-8111-111111111111',
  name: 'Wristband Fixture Patient',
};

function reqWith(decision) {
  return {
    id: 'req-wristband-1',
    method: 'GET',
    originalUrl: `/api/v1/bcma/wristband/${PATIENT.uid}`,
    headers: {},
    user: { uid: '22222222-2222-4222-8222-222222222222', role: 'ADMIN', rawRole: 'ADMIN' },
    patientAccessDecision: decision,
  };
}

const ADMINISTRATIVE_DECISION = {
  allowed: true,
  accessSource: 'role',
  policy_code: 'patient.wristband.print',
  administrativeAccess: true,
  administrativeGrant: 'administrator_no_relationship',
  reason: 'ADMIN holds the administrator_no_relationship administrative grant',
};

const RELATIONSHIP_DECISION = {
  allowed: true,
  accessSource: 'admission',
  policy_code: 'patient.wristband.print',
  reason: 'active admission relationship',
};

beforeEach(() => {
  logAuditMock.mockReset();
  errorMock.mockReset();
  warnMock.mockReset();
});

describe('recordAdministrativeWristbandAudit — best-effort by construction', () => {
  it('writes exactly one administrative-action row for an administrative decision', async () => {
    logAuditMock.mockResolvedValue(undefined);

    await expect(
      recordAdministrativeWristbandAudit(reqWith(ADMINISTRATIVE_DECISION), PATIENT, 'html'),
    ).resolves.toBe(true);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [, action, metadata, options] = logAuditMock.mock.calls[0];
    expect(action).toBe(WRISTBAND_ADMIN_AUDIT_ACTION);
    expect(metadata.patient_uid).toBe(PATIENT.uid);
    expect(metadata.care_relationship).toBe('none');
    expect(metadata.break_glass).toBe(false);
    expect(metadata.discloses_patient_name).toBe(true);
    expect(metadata.administrative_grant).toBe('administrator_no_relationship');
    expect(metadata.format).toBe('printable_html');
    expect(options).toEqual({ resource: 'patient_wristband', resourceId: PATIENT.uid });
  });

  it('does NOT reject when the audit sink throws — the band still prints', async () => {
    logAuditMock.mockRejectedValue(new Error('audit_logs is unavailable'));

    await expect(
      recordAdministrativeWristbandAudit(reqWith(ADMINISTRATIVE_DECISION), PATIENT, 'json'),
    ).resolves.toBe(false);

    // The failure is loud in the error log — best-effort must never be silent.
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][0])).toMatch(/Administrative wristband audit failed/);
  });

  it('does NOT reject when the audit sink throws synchronously', async () => {
    logAuditMock.mockImplementation(() => {
      throw new Error('sink exploded before returning a promise');
    });

    await expect(
      recordAdministrativeWristbandAudit(reqWith(ADMINISTRATIVE_DECISION), PATIENT, 'html'),
    ).resolves.toBe(false);
    expect(errorMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a relationship-backed decision — a nursing print is never labelled administrative', async () => {
    await expect(
      recordAdministrativeWristbandAudit(reqWith(RELATIONSHIP_DECISION), PATIENT, 'html'),
    ).resolves.toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no access decision on the request at all', async () => {
    await expect(
      recordAdministrativeWristbandAudit(reqWith(undefined), PATIENT, 'json'),
    ).resolves.toBe(false);
    await expect(
      recordAdministrativeWristbandAudit({}, PATIENT, 'json'),
    ).resolves.toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
