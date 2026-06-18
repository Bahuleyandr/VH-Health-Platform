import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';

// ---------------------------------------------------------------------------
// Mock ONLY the module gate — the REAL evaluator registry runs.
// This is intentionally different from operationalAlerts.deep.test.js, which
// mocks both the registry and the gate.
// ---------------------------------------------------------------------------
jest.unstable_mockModule('../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: async () => ({ enabled: true, settings: {} }),
}));

const { runSweep, listOperationalAlerts } = await import('../services/ai/operationalAlertService.js');

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const TEST_SKU = 'OPS-BRIDGE-SKU-1';

d('operational alerts — real inventory bridge evaluator (end-to-end)', () => {
  beforeEach(async () => {
    // Clean up any leftover rows from a previous run so the test is idempotent.
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_inventory_alerts WHERE item_sku LIKE 'OPS-BRIDGE-%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_operational_alerts WHERE scope_key = $1`,
      `inv:${TEST_SKU}`,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_inventory_alerts WHERE item_sku LIKE 'OPS-BRIDGE-%'`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_operational_alerts WHERE scope_key = $1`,
      `inv:${TEST_SKU}`,
    ).catch(() => {});
    await prisma.$disconnect();
  });

  it('real inventory evaluator bridges a high-severity inventory alert into an operational alert', async () => {
    // Seed a row that satisfies the evaluator's WHERE filters:
    //   severity IN ('high','critical') AND created_at >= NOW() - INTERVAL '3 days'
    // Explicitly-required NOT NULL columns (no DB default): item_sku, item_name, alert_category.
    // Columns with defaults (current_stock=0, reorder_point=0, avg_daily_usage=0,
    // baseline_daily_usage=0, signals='[]', recommended_actions='[]',
    // source_citations='[]', safety_flags='[]', reviewer_decision='pending',
    // metadata='{}') are omitted — the DB fills them.
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ai_inventory_alerts
         (tenant_id, item_sku, item_name, alert_category, severity, days_on_hand)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      TENANT,
      TEST_SKU,
      'Bridge Test Surgical Gloves',
      'stockout_risk',
      'high',
      2.5,
    );

    // Run the sweep restricted to inventory_intelligence only — faster + isolated.
    const summary = await runSweep({
      tenantId: TENANT,
      moduleKeys: ['inventory_intelligence'],
    });

    // The evaluator must not have thrown.
    expect(summary.errors).toEqual([]);
    expect(summary.evaluated).toBe(1);

    // Confirm an operational alert was produced with the correct shape.
    const { alerts } = await listOperationalAlerts({
      tenantId: TENANT,
      domain: 'inventory',
    });

    const alert = alerts.find((a) => a.scope_key === `inv:${TEST_SKU}`);
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe('high');
    expect(alert.module_key).toBe('inventory_intelligence');
    expect(alert.system_status).toBe('active');
  });
});
