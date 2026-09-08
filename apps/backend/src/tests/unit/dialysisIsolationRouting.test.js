import { jest } from '@jest/globals';

const assessIsolationTx = jest.fn();
const cohortCompatibilityTx = jest.fn();
jest.unstable_mockModule('../../services/clinical/dialysisReuseService.js', () => ({
  assessIsolationTx, cohortCompatibilityTx,
}));
jest.unstable_mockModule('../../services/clinical/dialysisIsolationEmergencyService.js', () => ({
  boundIsolationEmergencyIdTx: jest.fn(async () => null),
  validateIsolationEmergencyTx: jest.fn(),
}));
const { computeIsolationWarnings, planIsolationTx, admitIsolationTx } = await import(
  '../../services/clinical/dialysisIsolationRoutingService.js'
);

const tenantId = '00000000-0000-4000-8000-000000000011';
const patientUid = '00000000-0000-4000-8000-000000000012';
const machine = { id: 1, status: 'active', isolation_group: 'Bay One' };
const isolationGroups = { hbsag: 'Bay One', hcv: 'Bay Two', hiv: 'Bay Two', isolation_mixed: 'Bay Three' };
const restricted = { status: 'restricted', isolation_class: 'hbsag' };
const settings = { isolation_enforcement: 'warn', isolation_groups: isolationGroups };
const db = { $queryRawUnsafe: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  assessIsolationTx.mockResolvedValue(restricted);
  cohortCompatibilityTx.mockResolvedValue({ verdict: 'compatible' });
  db.$queryRawUnsafe.mockImplementation(async (sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('FROM reprocessing_domain_settings')) return [settings];
    if (sql.includes('FROM dialysis_machines')) return [machine];
    if (sql.includes('FROM dialysis_sessions')) return [];
    throw new Error(`Unexpected routing query: ${sql}`);
  });
});

describe('dialysis isolation routing', () => {
  test('no active policy leaves routing dark without resolving patient evidence', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    await expect(planIsolationTx(db, { tenantId, patientUid })).resolves.toBeNull();
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(assessIsolationTx).not.toHaveBeenCalled();
  });

  test('computeIsolationWarningsPinsEveryRoutingCondition', () => {
    const cases = [
      { decision: restricted, machine: null, groups: isolationGroups, code: 'DIALYSIS_MACHINE_UNREGISTERED', blocking: true },
      { decision: restricted, machine: { ...machine, isolation_group: null }, groups: isolationGroups, code: 'DIALYSIS_ISOLATION_MACHINE_MISMATCH', blocking: true },
      { decision: restricted, machine, groups: {}, code: 'DIALYSIS_ISOLATION_GROUP_UNMAPPED', blocking: true },
      { decision: { status: 'unknown' }, machine, groups: isolationGroups, code: 'DIALYSIS_UNKNOWN_ON_DEDICATED_GROUP', blocking: true },
      { decision: { status: 'clear' }, machine, groups: isolationGroups, code: 'DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE', blocking: false },
      { decision: { status: 'unknown' }, machine: { ...machine, isolation_group: null }, groups: isolationGroups, code: null, blocking: false },
      { decision: { status: 'clear' }, machine: null, groups: isolationGroups, code: null, blocking: false },
      { decision: restricted, machine, groups: isolationGroups, code: null, blocking: false },
    ];
    const modes = ['warn', 'block'];
    expect(cases).toHaveLength(8);
    expect(modes).toHaveLength(2);
    for (const enforcement of modes) {
      for (const entry of cases) {
        const result = computeIsolationWarnings({
          decision: entry.decision, machine: entry.machine,
          isolationGroups: entry.groups, enforcement,
        });
        expect(result).toEqual({
          codes: entry.code ? [entry.code] : [],
          required_group: entry.decision.status === 'restricted'
            ? (entry.groups.hbsag ?? null) : null,
          blocked: enforcement === 'block' && entry.blocking,
        });
        expect(JSON.stringify(result)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
      }
    }
  });

  test('planning is read-only and persists no class-shaped output', async () => {
    const result = await planIsolationTx(db, { tenantId, patientUid, machineNo: 'M-1' });
    expect(result).toMatchObject({ required_group: 'Bay One', codes: [], warn_only: true });
    expect(assessIsolationTx).toHaveBeenCalledWith({ tenantId, patientUid, db });
    expect(db.$queryRawUnsafe.mock.calls).toHaveLength(4);
    expect(db.$queryRawUnsafe.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
  });

  test('block-mode refusal occurs before any booking insert', async () => {
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM reprocessing_domain_settings')) return [{ ...settings, isolation_enforcement: 'block' }];
      if (sql.includes('FROM dialysis_machines')) return [];
      throw new Error(`Unexpected routing write/query: ${sql}`);
    });
    await expect(planIsolationTx(db, { tenantId, patientUid, machineNo: 'MISSING' }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_MACHINE_BLOCKED', statusCode: 409 });
    expect(db.$queryRawUnsafe.mock.calls).toHaveLength(3);
  });

  test('a selected inactive machine is refused independently of restriction', async () => {
    assessIsolationTx.mockResolvedValue({ status: 'clear' });
    db.$queryRawUnsafe.mockImplementation(async (sql) => (
      sql.includes('FROM reprocessing_domain_settings') ? [settings] : [{ ...machine, status: 'retired' }]
    ));
    await expect(planIsolationTx(db, { tenantId, patientUid, machineNo: 'M-1' }))
      .rejects.toMatchObject({ code: 'DIALYSIS_MACHINE_INACTIVE' });
  });

  test('an approved group label never bypasses cohort compatibility', async () => {
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('FROM reprocessing_domain_settings')) return [settings];
      if (sql.includes('FROM dialysis_machines')) return [machine];
      return [{ patient_uid: '00000000-0000-4000-8000-000000000013' }];
    });
    const verdicts = ['incompatible', 'not_established'];
    expect(verdicts).toHaveLength(2);
    for (const verdict of verdicts) {
      cohortCompatibilityTx.mockResolvedValue({ verdict });
      await expect(planIsolationTx(db, { tenantId, patientUid, machineNo: 'M-1' }))
        .rejects.toMatchObject({ code: 'DIALYSIS_COHORT_INCOMPATIBLE' });
    }
  });

  test('unknown on a general machine remains a standard-precautions planning path', async () => {
    assessIsolationTx.mockResolvedValue({ status: 'unknown' });
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM reprocessing_domain_settings')) return [settings];
      if (sql.includes('FROM dialysis_machines')) return [{ ...machine, isolation_group: null }];
      return [{ patient_uid: '00000000-0000-4000-8000-000000000013' }];
    });
    await expect(planIsolationTx(db, { tenantId, patientUid, machineNo: 'General' }))
      .resolves.toMatchObject({ codes: [], required_group: null });
    expect(cohortCompatibilityTx).not.toHaveBeenCalled();
  });

  test('start requires acknowledgement for warn-only routing findings', async () => {
    assessIsolationTx.mockResolvedValue({ status: 'clear' });
    await expect(admitIsolationTx(db, { tenantId, patientUid, machineNo: 'M-1' }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_OVERRIDE_REQUIRED' });
    const result = await admitIsolationTx(db, {
      tenantId, patientUid, machineNo: 'M-1',
      actor: { uid: patientUid, role: 'CONSULTANT' },
      body: { isolation_override_reason: 'Reviewed the available bay assignment' },
    });
    expect(result.isolation_override).toMatchObject({
      reason: 'Reviewed the available bay assignment', by: patientUid, kind: 'reason',
    });
    expect(JSON.stringify(result)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
  });
});
