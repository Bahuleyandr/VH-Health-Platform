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
const MATERIALS_MANAGER_UID = 'c6140000-0000-4000-8000-000000000061';
const C = (over = {}) => ({ module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy',
  owner_role: 'MATERIALS_MANAGER', scope_key: 'SKU-DEEP-1', alert_category: 'stockout_risk',
  severity: 'critical', scope_label: 'Test SKU', ...over });

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE tenant_id = $1::uuid
        AND EXISTS (
          SELECT 1
            FROM clinical_ai_operational_alerts alert
           WHERE alert.tenant_id = $1::uuid
             AND alert.scope_key LIKE 'SKU-DEEP-%'
             AND notification_outbox.source_event_key LIKE
                 'operational-alert:' || alert.id::text || ':%'
        )`,
    TENANT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_operational_alerts WHERE tenant_id = $1::uuid AND scope_key LIKE 'SKU-DEEP-%'`,
    TENANT,
  ).catch(() => {});
}

d('operational alerts sweep (deep)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT,
      MATERIALS_MANAGER_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '+919900000061', 'Operational Alert Materials Manager',
               'MATERIALS_MANAGER', TRUE, $2::uuid, NOW())`,
      MATERIALS_MANAGER_UID,
      TENANT,
    );
  });
  beforeEach(async () => {
    await cleanup();
    FAKE_CANDIDATES = [];
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT,
      MATERIALS_MANAGER_UID,
    ).catch(() => {});
    await prisma.$disconnect();
  });

  it('raises an active alert and dedups on re-sweep (no duplicate, last_evaluated_at advances)', async () => {
    FAKE_CANDIDATES = [C()];
    await runSweep({ tenantId: TENANT });
    let { alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy' });
    const active = alerts.filter((a) => a.scope_key === 'SKU-DEEP-1' && a.system_status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].notified_at).not.toBeNull(); // critical → notified once
    // Advisory guarantee: every persisted alert carries the decision-support flag.
    expect(JSON.stringify(active[0].safety_flags)).toContain('OPERATIONAL_ALERT_DECISION_SUPPORT_ONLY');

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
