// src/tests/unit/operationalAlertEvaluators.test.js
//
// Unit tests for the 4 wired evaluator adapters in operationalAlertEvaluators.js.
// Uses jest.unstable_mockModule to intercept prisma + producer service modules.
//
// Run:
//   DATABASE_URL='postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test' \
//   NODE_ENV=test \
//   node -r dotenv/config --experimental-vm-modules node_modules/jest/bin/jest.js \
//   --runInBand operationalAlertEvaluators

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock state — reset per-describe via beforeEach so tests are isolated.
// ---------------------------------------------------------------------------
const mockQueryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: (...args) => mockQueryRawUnsafe(...args),
  },
}));

// scoreNoShowRisk mock state
const mockScoreNoShowRisk = jest.fn();
// predictOtCaseTime mock state
const mockPredictOtCaseTime = jest.fn();

jest.unstable_mockModule('../../services/ai/operationalAiService.js', () => ({
  scoreNoShowRisk: (...args) => mockScoreNoShowRisk(...args),
  predictOtCaseTime: (...args) => mockPredictOtCaseTime(...args),
  auditChargeCapture: jest.fn(),
  listChargeCaptureAudits: jest.fn(),
  decideChargeCaptureAudit: jest.fn(),
  default: {},
}));

// acuityStaffingForecastService pure helpers — real implementations, no DB.
jest.unstable_mockModule('../../services/ai/acuityStaffingForecastService.js', () => {
  // Keep the pure functions real so evaluateAcuityStaffingBridge can call them.
  // (The evaluator only calls classifyAcuityStaffing / buildStaffingActions /
  //  summarizeStaffingForecast for the live-fallback path; the bridge path reads
  //  stored rows from DB instead.)
  function classifyAcuityStaffing({ census = {}, current = {} } = {}) {
    const nurse = Math.max(0, (census.critical || 0) - (current.nurse || 0));
    const total_deficit = nurse;
    const severity = nurse >= 5 ? 'critical' : nurse >= 2 ? 'high' : nurse >= 1 ? 'moderate' : 'low';
    return {
      recommendation: nurse >= 2 ? 'call_in' : 'hold_staffing',
      severity,
      signals: [{ code: 'TEST', detail: 'mock' }],
      acuity_load: 0,
      peak_census: 0,
      required_staff: { nurse },
      deficit_by_role: { nurse, nursing_assistant: 0, total: nurse },
      total_deficit,
    };
  }
  function buildStaffingActions() { return ['Mock action', 'Review disclaimer']; }
  function summarizeStaffingForecast({ unit, totalDeficit }) {
    return `Mock summary for ${unit}: deficit ${totalDeficit}`;
  }
  return {
    classifyAcuityStaffing,
    buildStaffingActions,
    summarizeStaffingForecast,
    MODULE_KEY: 'acuity_staffing_forecast',
    RECOMMENDATIONS: new Set(['call_in', 'hold_staffing', 'no_action', 'float_staff', 'reduce_staff', 'emergency_acuity', 'unknown']),
    SEVERITIES: new Set(['low', 'moderate', 'high', 'critical', 'unknown']),
    DECISIONS: new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']),
    FINAL_DECISIONS: new Set(['accepted', 'deferred', 'rejected', 'edited']),
    default: {},
  };
});

// Silence logger noise from any deep imports.
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Stub tenantService so DEFAULT_TENANT_ID resolves without DB.
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));

// Lazy import — must come after all jest.unstable_mockModule() calls.
const { OPERATIONAL_ALERT_EVALUATORS } = await import('../../services/ai/operationalAlertEvaluators.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW    = new Date('2026-06-18T08:00:00.000Z');
const TOMORROW_YMD = '2026-06-19';

function getEvaluator(module_key) {
  const entry = OPERATIONAL_ALERT_EVALUATORS.find((e) => e.module_key === module_key);
  if (!entry) throw new Error(`Evaluator not found: ${module_key}`);
  return entry.evaluate;
}

// ---------------------------------------------------------------------------
// 1. appointment_no_show_predictor
// ---------------------------------------------------------------------------
describe('evaluateNoShow (appointment_no_show_predictor)', () => {
  const evaluate = getEvaluator('appointment_no_show_predictor');

  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
    mockScoreNoShowRisk.mockReset();
  });

  it('returns one high-severity candidate when ≥40% of tomorrow bookings are high-risk', async () => {
    // 5 booked appointments
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 },
    ]);
    // 3 of 5 (60%) return band='high'
    mockScoreNoShowRisk
      .mockResolvedValueOnce({ band: 'high' })
      .mockResolvedValueOnce({ band: 'high' })
      .mockResolvedValueOnce({ band: 'high' })
      .mockResolvedValueOnce({ band: 'medium' })
      .mockResolvedValueOnce({ band: 'low' });

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].severity).toBe('high');
    expect(candidates[0].scope_key).toBe(`no-show:${TOMORROW_YMD}`);
    expect(candidates[0].alert_category).toBe('no_show_surge');
  });

  it('returns [] when fewer than 20% of appointments are high-risk', async () => {
    // 10 booked, only 1 high → rate = 0.10 < 0.20
    mockQueryRawUnsafe.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }))
    );
    mockScoreNoShowRisk
      .mockResolvedValueOnce({ band: 'high' })
      .mockResolvedValue({ band: 'low' });

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. inventory_intelligence
// ---------------------------------------------------------------------------
describe('evaluateInventoryBridge (inventory_intelligence)', () => {
  const evaluate = getEvaluator('inventory_intelligence');

  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
  });

  it('maps one high-severity inventory row to exactly one candidate', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        item_sku: 'PPE-GLOVE-L',
        item_name: 'Nitrile Gloves Large',
        alert_category: 'stockout_risk',
        severity: 'high',
        days_on_hand: 1.5,
        next_expiry_date: null,
        summary: 'Stock critically low.',
        recommended_actions: ['Reorder immediately.'],
        source_citations: [{ source_type: 'inventory', source_id: 'PPE-GLOVE-L', label: 'Inventory record' }],
      },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].scope_key).toBe('inv:PPE-GLOVE-L');
    expect(candidates[0].severity).toBe('high');
    expect(candidates[0].alert_category).toBe('stockout_risk');
  });

  it('returns [] when no high/critical inventory rows exist', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. ot_case_time_predictor
// ---------------------------------------------------------------------------
describe('evaluateOtOverrun (ot_case_time_predictor)', () => {
  const evaluate = getEvaluator('ot_case_time_predictor');

  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
    mockPredictOtCaseTime.mockReset();
  });

  it('returns one high-severity candidate when predicted overrun ≥ 60 min', async () => {
    // 3 cases in room OT-1, each predicted 200 min → total 600 vs 480 block → overrun 120 min
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: 10, ot_room: 'OT-1', estimated_duration: 180 },
      { id: 11, ot_room: 'OT-1', estimated_duration: 180 },
      { id: 12, ot_room: 'OT-1', estimated_duration: 180 },
    ]);
    mockPredictOtCaseTime.mockResolvedValue({ predicted_minutes: 200 });

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].severity).toBe('high');
    expect(candidates[0].alert_category).toBe('ot_overrun');
    expect(candidates[0].scope_key).toBe(`ot-overrun:${TOMORROW_YMD}:OT-1`);
  });

  it('returns [] when total predicted time is within 20 min of block', async () => {
    // 2 cases, each 230 min → total 460 vs 480 → overrun -20 (under threshold)
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: 20, ot_room: 'OT-2', estimated_duration: 220 },
      { id: 21, ot_room: 'OT-2', estimated_duration: 220 },
    ]);
    mockPredictOtCaseTime.mockResolvedValue({ predicted_minutes: 230 });

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. acuity_staffing_forecast
// ---------------------------------------------------------------------------
describe('evaluateAcuityStaffingBridge (acuity_staffing_forecast)', () => {
  const evaluate = getEvaluator('acuity_staffing_forecast');

  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
  });

  it('promotes one high/critical stored forecast row to one candidate with correct severity', async () => {
    // First query: stored high/critical rows (bridge path)
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        unit: 'ICU',
        shift_label: 'night',
        total_deficit: 3,
        severity: 'high',
        signals: [{ code: 'NURSE_DEFICIT', detail: 'deficit 3' }],
        recommended_actions: ['Call in nurses.'],
        source_citations: [],
        summary: 'ICU night shift deficit.',
        created_at: new Date(NOW.getTime() - 60 * 60 * 1000),
      },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].scope_key).toBe('staffing:ICU:night');
    expect(candidates[0].severity).toBe('high');
    expect(candidates[0].alert_category).toBe('staffing_gap');
  });

  it('returns [] when no stored forecasts with deficit ≥ 1 exist', async () => {
    // Bridge path returns empty → live fallback also returns empty.
    mockQueryRawUnsafe.mockResolvedValue([]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });
});
