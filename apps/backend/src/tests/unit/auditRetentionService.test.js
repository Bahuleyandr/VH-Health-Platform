import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';

const txQuery = jest.fn();
const txExecute = jest.fn();
const setTenantTx = jest.fn();
const tx = {
  $queryRawUnsafe: txQuery,
  $executeRawUnsafe: txExecute,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx,
}));

const {
  AUDIT_RETENTION_SINKS,
  decideAuditRetentionAction,
  purgeAuditEvidenceForTenant,
} = await import('../../services/compliance/auditRetentionService.js');

const TENANT = '10000000-0000-4000-8000-000000000001';

function policy(table, overrides = {}) {
  return {
    id: 1,
    tenant_id: TENANT,
    policy_code: `POLICY_${table.toUpperCase()}`,
    applies_to_table: table,
    retention_days: 30,
    action: 'erase',
    legal_hold_aware: false,
    status: 'active',
    metadata: {},
    ...overrides,
  };
}

describe('audit retention decisions', () => {
  it('fails closed without an active policy', () => {
    expect(decideAuditRetentionAction(null)).toEqual({
      decision: 'skip',
      reason: 'no_active_policy',
    });
  });

  it('never erases archive or legal-hold-aware evidence', () => {
    expect(decideAuditRetentionAction(policy('audit_log', { action: 'archive' })))
      .toMatchObject({ decision: 'skip', reason: 'archive_not_implemented' });
    expect(decideAuditRetentionAction(policy('audit_log', { legal_hold_aware: true })))
      .toMatchObject({ decision: 'skip', reason: 'legal_hold_decision_not_implemented' });
  });

  it('allows only a valid erase policy with legal-hold awareness disabled', () => {
    expect(decideAuditRetentionAction(policy('audit_log'))).toEqual({
      decision: 'erase',
      reason: 'policy_allows_erasure',
      retentionDays: 30,
    });
  });
});

describe('purgeAuditEvidenceForTenant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(tx));
  });

  it('consults active policies and deletes only an explicitly erasable sink', async () => {
    txQuery.mockResolvedValueOnce([
      policy('audit_log'),
      policy('audit_logs', { action: 'archive', legal_hold_aware: true }),
      policy('clinical_audit_events', { legal_hold_aware: true, retention_days: 3650 }),
      policy('hipaa_access_log', { action: 'anonymise' }),
    ]);
    txExecute
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(7);

    const result = await purgeAuditEvidenceForTenant({
      tenantId: TENANT,
      now: new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(txExecute).toHaveBeenCalledTimes(2);
    expect(txExecute.mock.calls[0][0]).toContain("set_config('app.audit_bypass'");
    expect(txExecute.mock.calls[1][0]).toContain('DELETE FROM audit_log');
    expect(txExecute.mock.calls[1][1]).toBe(TENANT);
    expect(txExecute.mock.calls[1][2]).toBe('2026-06-13T12:00:00.000Z');
    expect(result.deleted_total).toBe(7);
    expect(result.sinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'audit_log', decision: 'erase', deleted: 7 }),
      expect.objectContaining({ table: 'audit_logs', reason: 'archive_not_implemented', deleted: 0 }),
      expect.objectContaining({ table: 'clinical_audit_events', reason: 'legal_hold_decision_not_implemented', deleted: 0 }),
      expect.objectContaining({ table: 'hipaa_access_log', reason: 'unsupported_action_anonymise', deleted: 0 }),
      expect.objectContaining({ table: 'patient_access_audit_log', reason: 'no_active_policy', deleted: 0 }),
    ]));
  });

  it('uses a tenant predicate and the correct timestamp column for every sink', async () => {
    txQuery.mockResolvedValueOnce(AUDIT_RETENTION_SINKS.map((sink, index) =>
      policy(sink.table, { id: index + 1 })));
    txExecute.mockResolvedValueOnce(0);
    for (let index = 1; index <= AUDIT_RETENTION_SINKS.length; index += 1) {
      txExecute.mockResolvedValueOnce(index);
    }

    const result = await purgeAuditEvidenceForTenant({ tenantId: TENANT, now: '2026-07-13T00:00:00Z' });
    const deletes = txExecute.mock.calls.slice(1).map(([sql]) => sql);

    expect(deletes).toHaveLength(5);
    expect(deletes.every((sql) => sql.includes('tenant_id = $1::uuid'))).toBe(true);
    expect(deletes.join('\n')).toContain('audit_log');
    expect(deletes.join('\n')).toContain('audit_logs');
    expect(deletes.join('\n')).toContain('clinical_audit_events');
    expect(deletes.join('\n')).toContain('occurred_at');
    expect(deletes.join('\n')).toContain('hipaa_access_log');
    expect(deletes.join('\n')).toContain('accessed_at');
    expect(deletes.join('\n')).toContain('patient_access_audit_log');
    expect(result.deleted_total).toBe(15);
  });

  it('does not enable the append-only bypass when no sink can be erased', async () => {
    txQuery.mockResolvedValueOnce([]);

    const result = await purgeAuditEvidenceForTenant({ tenantId: TENANT });

    expect(txExecute).not.toHaveBeenCalled();
    expect(result.deleted_total).toBe(0);
    expect(result.sinks.every((sink) => sink.reason === 'no_active_policy')).toBe(true);
  });

  it('rejects an invalid evaluation date before opening a transaction', async () => {
    await expect(purgeAuditEvidenceForTenant({ tenantId: TENANT, now: 'not-a-date' }))
      .rejects.toThrow(/valid date/);
    expect(setTenantTx).not.toHaveBeenCalled();
  });
});

describe('audit retention migration and scheduler wiring', () => {
  it('seeds all five sinks with archive baselines and preserves longer retention', () => {
    const migration = readFileSync(
      new URL('../../migrations/576_audit_retention_policy_baseline.sql', import.meta.url),
      'utf8',
    );
    for (const sink of AUDIT_RETENTION_SINKS) {
      expect(migration).toContain(`'${sink.table}'`);
    }
    expect(migration).toContain("'clinical_audit_events'");
    expect(migration).toContain('3650');
    expect(migration).toContain("'archive'");
    expect(migration).toMatch(/GREATEST\([\s\S]*data_retention_policies\.retention_days/);
    expect(migration).toContain('CROSS JOIN retention_rows');
  });

  it('wires the scheduler to tenant fan-out with no hard-coded audit_log TTL delete', () => {
    const scheduler = readFileSync(
      new URL('../../utils/scheduler.js', import.meta.url),
      'utf8',
    );
    expect(scheduler).toContain("runForEachTenant('audit-retention'");
    expect(scheduler).toContain("{ lockKey: 'purge-audit-logs' }");
    expect(scheduler).toContain('purgeAuditEvidenceForTenant({ tenantId })');
    expect(scheduler).not.toMatch(/DELETE FROM audit_log[^;]*INTERVAL '90 days'/s);
  });
});
