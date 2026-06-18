import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';

// Controllable fake registry — one module, candidates driven per-test.
let FAKE_CANDIDATES = [];
jest.unstable_mockModule('../services/ai/operationalAlertEvaluators.js', () => ({
  OPERATIONAL_ALERT_EVALUATORS: [{
    module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy', owner_role: 'MATERIALS_MANAGER',
    evaluate: async () => FAKE_CANDIDATES,
  }],
}));
// Force the module enabled regardless of catalog state.
jest.unstable_mockModule('../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: async () => ({ enabled: true, settings: {} }),
}));

const { runSweep, listOperationalAlerts } = await import('../services/ai/operationalAlertService.js');

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';
const C = (over = {}) => ({ module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy',
  owner_role: 'MATERIALS_MANAGER', scope_key: 'SKU-DEEP-1', alert_category: 'stockout_risk',
  severity: 'critical', scope_label: 'Test SKU', ...over });

d('operational alerts sweep (deep)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_operational_alerts WHERE scope_key LIKE 'SKU-DEEP-%'`);
    FAKE_CANDIDATES = [];
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_operational_alerts WHERE scope_key LIKE 'SKU-DEEP-%'`).catch(() => {});
    await prisma.$disconnect();
  });

  it('raises an active alert and dedups on re-sweep (no duplicate, last_evaluated_at advances)', async () => {
    FAKE_CANDIDATES = [C()];
    await runSweep({ tenantId: TENANT });
    let { alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy' });
    const active = alerts.filter((a) => a.scope_key === 'SKU-DEEP-1' && a.system_status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].notified_at).not.toBeNull(); // critical → notified once

    const firstEval = active[0].last_evaluated_at;
    await new Promise((r) => setTimeout(r, 25));
    await runSweep({ tenantId: TENANT });
    ({ alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy' }));
    const active2 = alerts.filter((a) => a.scope_key === 'SKU-DEEP-1' && a.system_status === 'active');
    expect(active2).toHaveLength(1); // still one — upsert, not duplicate
    expect(new Date(active2[0].last_evaluated_at).getTime()).toBeGreaterThan(new Date(firstEval).getTime());
  });

  it('auto-resolves when the risk clears on the next sweep', async () => {
    FAKE_CANDIDATES = [C()];
    await runSweep({ tenantId: TENANT });
    FAKE_CANDIDATES = []; // risk cleared
    await runSweep({ tenantId: TENANT });
    const { alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy', systemStatus: 'resolved' });
    const resolved = alerts.find((a) => a.scope_key === 'SKU-DEEP-1');
    expect(resolved).toBeTruthy();
    expect(resolved.resolved_reason).toBe('forecast_cleared');
  });
});
