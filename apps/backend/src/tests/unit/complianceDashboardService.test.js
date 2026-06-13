/**
 * Phase E1 — complianceDashboardService unit tests.
 * Verifies the aggregator pulls from each compliance source + degrades
 * cleanly when individual tables are missing.
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

const { getComplianceDashboard } = await import('../../services/compliance/complianceDashboardService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('getComplianceDashboard', () => {
  it('aggregates DPA + breach + erasure + legal-hold counts', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { lawful_basis: 'consent', count: 3 },
      { lawful_basis: 'public_task', count: 7 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 5, activity_code: 'X', display_name: 'Pending DPIA' },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { severity: 'high', status: 'open', count: 1 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { breach_id: 'B-001', severity: 'high', discovered_at: '2026-04-25', hours_since_discovery: 96 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ total: 12, last_30d: 4 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ total: 2, active: 1 }]);

    const dash = await getComplianceDashboard({ tenantId: TENANT });

    expect(dash.data_processing_activities.by_lawful_basis).toHaveLength(2);
    expect(dash.data_processing_activities.dpia_pending_count).toBe(1);
    expect(dash.breach_incidents.regulator_notifications_pending_count).toBe(1);
    expect(dash.gdpr_erasure.total).toBe(12);
    expect(dash.legal_holds.active).toBe(1);
    expect(dash.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('degrades when individual tables are missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "data_processing_activities" does not exist'));
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "data_processing_activities" does not exist'));
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "gdpr_erasure_log" does not exist'));
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "legal_holds" does not exist'));

    const dash = await getComplianceDashboard({ tenantId: TENANT });

    expect(dash.data_processing_activities.by_lawful_basis).toEqual([]);
    expect(dash.data_processing_activities.dpia_pending_count).toBe(0);
    expect(dash.breach_incidents.regulator_notifications_pending_count).toBe(0);
    expect(dash.gdpr_erasure).toEqual({ total: 0, last_30d: 0 });
    expect(dash.legal_holds).toEqual({ total: 0, active: 0 });
  });
});
