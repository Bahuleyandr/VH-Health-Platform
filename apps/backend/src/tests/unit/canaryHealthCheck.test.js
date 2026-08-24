// src/tests/unit/canaryHealthCheck.test.js
//
// F7/F11 (audit 2026-08-10) — the canary must count the notification_outbox
// dead-letter states (FAILED at the retry ceiling + RECONCILIATION_REQUIRED,
// which is never auto-retried), not just stuck PENDING rows; and a 'warn'
// result must participate in the canary's failure handling (it used to be
// silently excluded from the FAILED log).
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runWithSuperAdmin: async fn => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: loggerInfoMock,
    warn: jest.fn(),
    error: loggerErrorMock,
    debug: jest.fn(),
  },
}));

const { runCanaryChecks } = await import('../../utils/canaryHealthCheck.js');

function mockQueries({
  stuck = 0, failedDead = 0, reconciliationRequired = 0, terminalDead = 0, criticalAlerts = 0,
  thresholdUnconfiguredTenants = [], escalationUnconfiguredTenants = [],
} = {}) {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (/SELECT 1 AS ok/i.test(sql)) return [{ ok: 1 }];
    if (/canary_checks/i.test(sql)) return [];
    if (/FROM notification_outbox/i.test(sql)) {
      return [{
        stuck_pending: String(stuck),
        failed_dead_letters: String(failedDead),
        reconciliation_required: String(reconciliationRequired),
        terminal_dead_letters: String(terminalDead),
      }];
    }
    if (/FROM escalation_rules/i.test(sql)) {
      return escalationUnconfiguredTenants.map((t) => (
        typeof t === 'string' ? { tenant_id: t, tenant_name: t } : t
      ));
    }
    if (/FROM lab_critical_thresholds/i.test(sql)) {
      return thresholdUnconfiguredTenants.map((t) => (
        typeof t === 'string' ? { tenant_id: t, tenant_name: t } : t
      ));
    }
    if (/FROM clinical_alerts/i.test(sql)) return [{ count: String(criticalAlerts) }];
    throw new Error(`unexpected canary SQL: ${sql}`);
  });
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  loggerErrorMock.mockReset();
  loggerInfoMock.mockReset();
});

describe('runCanaryChecks — notification outbox dead letters (F7/F11)', () => {
  it('counts FAILED-at-ceiling and RECONCILIATION_REQUIRED rows as dead letters and warns', async () => {
    mockQueries({ failedDead: 2, reconciliationRequired: 1 });

    const results = await runCanaryChecks();

    expect(results.notification_dead_letters).toMatchObject({
      status: 'warn',
      count: 3,
      failed: 2,
      reconciliation_required: 1,
    });
    // 'warn' participates in failure handling: the canary logs FAILED.
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Canary health check FAILED:',
      expect.objectContaining({
        notification_dead_letters: expect.objectContaining({ status: 'warn' }),
      }),
    );
    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      'Canary health check passed:',
      expect.anything(),
    );
  });

  it('reports ok (and logs passed) when there are no dead letters and nothing is stuck', async () => {
    mockQueries();

    const results = await runCanaryChecks();

    expect(results.stuck_notifications).toMatchObject({ status: 'ok', count: 0 });
    expect(results.notification_dead_letters).toMatchObject({ status: 'ok', count: 0 });
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('Canary health check passed:', expect.anything());
  });

  it('stuck-PENDING warn (over 50) also fails the canary now', async () => {
    mockQueries({ stuck: 51 });

    const results = await runCanaryChecks();

    expect(results.stuck_notifications).toMatchObject({ status: 'warn', count: 51 });
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  // Auto-replay split (mig-690): rows the bounded sweep can still requeue stay
  // in the aggregate 'warn' bucket; rows with no automatic path left are
  // CRITICAL — only the operator endpoints can resolve them. The key is
  // additive so the existing notification_dead_letters contract is unchanged.
  it('terminal dead letters (auto-replay exhausted / aged out / terminal rejection) go critical', async () => {
    mockQueries({ failedDead: 1, reconciliationRequired: 2, terminalDead: 1 });

    const results = await runCanaryChecks();

    expect(results.notification_dead_letters).toMatchObject({ status: 'warn', count: 3 });
    expect(results.notification_dead_letters_terminal).toMatchObject({
      status: 'critical',
      count: 1,
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Canary health check FAILED:',
      expect.objectContaining({
        notification_dead_letters_terminal: expect.objectContaining({ status: 'critical' }),
      }),
    );
  });

  it('auto-replay-pending dead letters alone stay warn, terminal stays ok', async () => {
    mockQueries({ reconciliationRequired: 2 });

    const results = await runCanaryChecks();

    expect(results.notification_dead_letters).toMatchObject({ status: 'warn', count: 2 });
    expect(results.notification_dead_letters_terminal).toMatchObject({ status: 'ok', count: 0 });
  });
});

describe('canary: critical-lab-threshold coverage', () => {
  // The tenancy defect the re-audit found: a tenant with no active thresholds
  // can never raise a critical lab alert, and the result path cannot say so
  // without adding a statement to the caller's transaction. The canary owns
  // the question because it runs on its own connection.
  test('reports ok when every active tenant holds thresholds', async () => {
    mockQueries({ thresholdUnconfiguredTenants: [] });
    const res = await runCanaryChecks();
    expect(res.lab_critical_threshold_coverage).toEqual({
      status: 'ok', unconfigured_tenants: 0,
    });
  });

  test('warns and names the tenants that hold none', async () => {
    mockQueries({
      thresholdUnconfiguredTenants: [
        { tenant_id: 'tenant-b', tenant_name: 'Hospital B' },
      ],
    });
    const res = await runCanaryChecks();
    expect(res.lab_critical_threshold_coverage).toMatchObject({
      status: 'warn', unconfigured_tenants: 1, tenants: ['tenant-b'],
    });
  });
});

describe('canary: escalation-rule coverage', () => {
  test('reports ok when every active tenant holds task-scope rules', async () => {
    mockQueries({ escalationUnconfiguredTenants: [] });
    const res = await runCanaryChecks();
    expect(res.escalation_rule_coverage).toEqual({ status: 'ok', unconfigured_tenants: 0 });
  });

  test('warns and names tenants whose escalation tiers can never fire', async () => {
    mockQueries({
      escalationUnconfiguredTenants: [{ tenant_id: 'tenant-c', tenant_name: 'Hospital C' }],
    });
    const res = await runCanaryChecks();
    expect(res.escalation_rule_coverage).toMatchObject({
      status: 'warn', unconfigured_tenants: 1, tenants: ['tenant-c'],
    });
  });
});
