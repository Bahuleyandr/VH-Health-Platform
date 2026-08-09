/**
 * Phase E1 — breachService unit tests covering the GDPR Art. 33/34
 * notification flows added in 2026-04-30.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  getBreaches,
  getBreachTimeline,
  notifyDataSubjects,
  notifyRegulator,
  reportBreach,
} = await import('../../services/compliance/breachService.js');

const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe('breach listing queries', () => {
  it('selects schema-backed notification fields when listing breaches', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([{ breach_id: 'B-001' }]);

    await getBreaches();

    const selectSql = queryUnsafeMock.mock.calls[1][0];
    expect(selectSql).not.toMatch(/notification_sent_at/);
    expect(selectSql).toMatch(/data_subjects_notified_at/);
    expect(selectSql).toMatch(/regulator_notified_at/);
    expect(selectSql).toMatch(/\btitle\b/);
    expect(selectSql).toMatch(/\bphi_involved\b/);
  });

  it('selects schema-backed notification fields for breach timelines', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ breach_id: 'B-001' }])
      .mockResolvedValueOnce([]);

    await getBreachTimeline('B-001');

    const selectSql = queryUnsafeMock.mock.calls[0][0];
    expect(selectSql).not.toMatch(/notification_sent_at/);
    expect(selectSql).toMatch(/data_subjects_notified_at/);
    expect(selectSql).toMatch(/regulator_notified_at/);
    expect(selectSql).toMatch(/\btitle\b/);
    expect(selectSql).toMatch(/\bphi_involved\b/);
  });

  it('does not write the removed notification_sent_at column for admin alerts', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        breach_id: 'B-001',
        title: 'Test breach',
        severity: 'critical',
        affected_records: 12,
      }])
      .mockResolvedValueOnce([{ uid: USER, name: 'Admin' }])
      .mockResolvedValueOnce([]);

    await reportBreach({
      title: 'Test breach',
      severity: 'critical',
      description: 'Test breach',
      affectedRecords: 12,
      affectedPatientUids: [],
      reportedBy: USER,
    });

    const sql = queryUnsafeMock.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).toMatch(/notification_outbox/);
    expect(sql).not.toMatch(/notification_sent_at/);
  });
});

describe('breach title + PHI-involved persistence (audit F3 follow-up)', () => {
  it('rejects a report with no title', async () => {
    await expect(reportBreach({ severity: 'low', description: 'x' }))
      .rejects.toThrow(/title.*required/);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('inserts and returns title + phi_involved, defaulting phi_involved to false', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      breach_id: 'B-200',
      title: 'Lost laptop',
      severity: 'low',
      phi_involved: false,
    }]);

    const row = await reportBreach({
      title: 'Lost laptop',
      severity: 'low',
      description: 'Unencrypted laptop went missing',
    });

    const insertSql = queryUnsafeMock.mock.calls[0][0];
    const insertParams = queryUnsafeMock.mock.calls[0].slice(1);
    expect(insertSql).toMatch(/INSERT INTO data_breaches\s*\n?\s*\([^)]*\btitle\b[^)]*\bphi_involved\b/);
    expect(insertSql).toMatch(/RETURNING[^;]*\btitle\b[^;]*\bphi_involved\b/);
    expect(insertParams).toContain('Lost laptop');
    expect(insertParams).toContain(false);
    expect(row.title).toBe('Lost laptop');
    expect(row.phi_involved).toBe(false);
  });

  it('inserts phi_involved true when the report flags PHI', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        breach_id: 'B-201',
        title: 'Exposed patient records',
        severity: 'critical',
        phi_involved: true,
        affected_records: 40,
      }])
      .mockResolvedValueOnce([]) // admin lookup (critical severity triggers notifyAdminsOfBreach)
      .mockResolvedValueOnce([]);

    await reportBreach({
      title: 'Exposed patient records',
      severity: 'critical',
      description: 'PHI exposed in a misdirected export',
      phiInvolved: true,
      affectedRecords: 40,
    });

    const insertParams = queryUnsafeMock.mock.calls[0].slice(1);
    expect(insertParams).toContain(true);
  });
});

describe('breach tenancy (owner decision 2026-07-13)', () => {
  const TENANT = 'bbbbbbbb-0000-4000-8000-000000000001';

  it('scopes breach listing to the caller tenant by default', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([]);
    await getBreaches({ tenantId: TENANT });

    const countSql = queryUnsafeMock.mock.calls[0][0];
    const listSql = queryUnsafeMock.mock.calls[1][0];
    expect(countSql).toMatch(/tenant_id = \$1::uuid/);
    expect(listSql).toMatch(/tenant_id = \$1::uuid/);
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(TENANT);
  });

  it('omits the tenant predicate for the SUPER_ADMIN cross-tenant view', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([]);
    await getBreaches({ crossTenant: true });

    const countSql = queryUnsafeMock.mock.calls[0][0];
    const listSql = queryUnsafeMock.mock.calls[1][0];
    expect(countSql).not.toMatch(/tenant_id = \$/);
    expect(listSql).not.toMatch(/tenant_id = \$/);
  });

  it('scopes the single-breach timeline to the caller tenant', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ breach_id: 'B-001' }])
      .mockResolvedValueOnce([]);
    await getBreachTimeline('B-001', { tenantId: TENANT });

    const breachSql = queryUnsafeMock.mock.calls[0][0];
    expect(breachSql).toMatch(/breach_id = \$1 AND tenant_id = \$2::uuid/);
    expect(queryUnsafeMock.mock.calls[0][1]).toBe('B-001');
    expect(queryUnsafeMock.mock.calls[0][2]).toBe(TENANT);
  });

  it('stamps tenant_id on breach report inserts', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ breach_id: 'B-100', title: 'x', severity: 'low', affected_records: 0 }]);
    await reportBreach({ title: 'x', severity: 'low', description: 'x', tenantId: TENANT });

    const insertSql = queryUnsafeMock.mock.calls[0][0];
    expect(insertSql).toMatch(/INSERT INTO data_breaches\s*\n?\s*\(tenant_id,/);
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(TENANT);
  });
});

describe('notifyRegulator', () => {
  it('rejects missing required fields', async () => {
    await expect(notifyRegulator({ breachId: 'B-001' }))
      .rejects.toThrow(/required/);
  });

  it('rejects when regulator already notified', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, breach_id: 'B-001', status: 'contained', regulator_notified_at: '2026-04-29' },
    ]);
    await expect(notifyRegulator({
      breachId: 'B-001', regulatorReference: 'CERT-IN/9000', jurisdiction: 'IN',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws 404 when breach not found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(notifyRegulator({
      breachId: 'B-001', regulatorReference: 'X', jurisdiction: 'IN',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records the regulator notification with risk_assessment + dpa_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, breach_id: 'B-001', status: 'contained', regulator_notified_at: null },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, breach_id: 'B-001',
      regulator_notified_at: '2026-04-30', regulator_reference: 'CERT-IN/42',
      regulator_jurisdiction: 'IN', cross_border_impact: false, dpa_id: 7,
    }]);
    const row = await notifyRegulator({
      breachId: 'B-001',
      regulatorReference: 'CERT-IN/42',
      jurisdiction: 'IN',
      riskAssessment: { likelihood: 'medium', severity: 'high' },
      dpaId: 7,
      crossBorderImpact: false,
      notifiedBy: USER,
    });
    expect(row.regulator_reference).toBe('CERT-IN/42');
    expect(row.dpa_id).toBe(7);
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE data_breaches/);
    expect(updateSql).toMatch(/regulator_notified_at = NOW\(\)/);
  });
});

describe('notifyDataSubjects', () => {
  it('rejects negative notificationCount', async () => {
    await expect(notifyDataSubjects({ breachId: 'B-001', notificationCount: -3 }))
      .rejects.toThrow(/non-negative integer/);
  });

  it('throws 404 when breach not found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(notifyDataSubjects({ breachId: 'B-001', notificationCount: 5 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('records notification timestamp + count', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, breach_id: 'B-001', status: 'contained' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, breach_id: 'B-001', data_subjects_notified_at: '2026-04-30',
      data_subject_notification_count: 142,
    }]);
    const row = await notifyDataSubjects({ breachId: 'B-001', notificationCount: 142, notifiedBy: USER });
    expect(row.data_subject_notification_count).toBe(142);
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/data_subjects_notified_at = NOW\(\)/);
  });
});
