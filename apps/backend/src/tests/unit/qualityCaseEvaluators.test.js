// src/tests/unit/qualityCaseEvaluators.test.js
//
// Unit tests for the two quality domain evaluators:
//   - quality_case_review  (quality_incidents → HIGH/CRITICAL)
//   - rca_draft_generator  (admissions with prior_admission_id → readmission)
//
// Uses jest.unstable_mockModule to intercept prisma so no real DB is needed.

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockQueryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: (...args) => mockQueryRawUnsafe(...args),
  },
}));

jest.unstable_mockModule('../../services/ai/operationalAiService.js', () => ({
  scoreNoShowRisk: jest.fn(),
  predictOtCaseTime: jest.fn(),
  auditChargeCapture: jest.fn(),
  listChargeCaptureAudits: jest.fn(),
  decideChargeCaptureAudit: jest.fn(),
  default: {},
}));

jest.unstable_mockModule('../../services/ai/acuityStaffingForecastService.js', () => ({
  classifyAcuityStaffing: jest.fn(() => ({
    recommendation: 'hold_staffing', severity: 'low', signals: [],
    acuity_load: 0, peak_census: 0,
    required_staff: { nurse: 0 },
    deficit_by_role: { nurse: 0, nursing_assistant: 0, total: 0 },
    total_deficit: 0,
  })),
  buildStaffingActions: jest.fn(() => []),
  summarizeStaffingForecast: jest.fn(() => ''),
  MODULE_KEY: 'acuity_staffing_forecast',
  RECOMMENDATIONS: new Set(['call_in', 'hold_staffing', 'no_action', 'float_staff', 'reduce_staff', 'emergency_acuity', 'unknown']),
  SEVERITIES: new Set(['low', 'moderate', 'high', 'critical', 'unknown']),
  DECISIONS: new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']),
  FINAL_DECISIONS: new Set(['accepted', 'deferred', 'rejected', 'edited']),
  default: {},
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

// Lazy import after all mocks are registered.
const { OPERATIONAL_ALERT_EVALUATORS } = await import('../../services/ai/operationalAlertEvaluators.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW    = new Date('2026-06-18T08:00:00.000Z');

function getEvaluator(module_key) {
  const entry = OPERATIONAL_ALERT_EVALUATORS.find((e) => e.module_key === module_key);
  if (!entry) throw new Error(`Evaluator not found: ${module_key}`);
  return entry.evaluate;
}

// ---------------------------------------------------------------------------
// 1. quality_case_review
// ---------------------------------------------------------------------------
describe('evaluateQualityCaseReview (quality_case_review)', () => {
  const evaluate = getEvaluator('quality_case_review');

  beforeEach(() => { mockQueryRawUnsafe.mockReset(); });

  it('returns one candidate for a HIGH severity incident not yet resolved', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 42,
        severity: 'HIGH',
        status: 'investigating',
      },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].module_key).toBe('quality_case_review');
    expect(candidates[0].domain).toBe('quality');
    expect(candidates[0].owner_role).toBe('QUALITY_OFFICER');
    expect(candidates[0].scope_key).toBe('quality_incident:42');
    expect(candidates[0].alert_category).toBe('quality_case');
    expect(candidates[0].severity).toBe('high');
    // Summary must be generic — no PHI
    expect(candidates[0].summary).not.toMatch(/investigating|status/i);
    expect(candidates[0].metrics.incident_id).toBe(42);
    expect(candidates[0].metrics.severity).toBe('HIGH');
  });

  it('returns one candidate for a CRITICAL severity incident', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: 99, severity: 'CRITICAL', status: 'reported' },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].severity).toBe('critical');
  });

  it('returns [] when no HIGH/CRITICAL open incidents exist', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it('returns [] gracefully when table does not exist', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(
      new Error('relation "quality_incidents" does not exist')
    );
    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it('returns multiple candidates for multiple open incidents', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: 10, severity: 'HIGH',     status: 'reported' },
      { id: 11, severity: 'CRITICAL', status: 'investigating' },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(2);
    const scopeKeys = candidates.map((c) => c.scope_key);
    expect(scopeKeys).toContain('quality_incident:10');
    expect(scopeKeys).toContain('quality_incident:11');
  });
});

// ---------------------------------------------------------------------------
// 2. rca_draft_generator (readmissions)
// ---------------------------------------------------------------------------
describe('evaluateReadmissionRca (rca_draft_generator)', () => {
  const evaluate = getEvaluator('rca_draft_generator');

  beforeEach(() => { mockQueryRawUnsafe.mockReset(); });

  it('returns one candidate for a recent readmission with no open alert', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 500,
        prior_admission_id: 400,
      },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].module_key).toBe('rca_draft_generator');
    expect(candidates[0].domain).toBe('quality');
    expect(candidates[0].owner_role).toBe('QUALITY_OFFICER');
    expect(candidates[0].scope_key).toBe('readmission:500');
    expect(candidates[0].alert_category).toBe('readmission_review');
    expect(candidates[0].severity).toBe('moderate');
    expect(candidates[0].summary).toMatch(/readmission/i);
    expect(candidates[0].metrics.admission_id).toBe(500);
    expect(candidates[0].metrics.prior_admission_id).toBe(400);
  });

  it('returns [] when no recent readmissions exist', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it('returns [] gracefully when table does not exist', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(
      new Error('relation "admissions" does not exist')
    );
    const candidates = await evaluate({ tenantId: TENANT, now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it('returns multiple candidates for multiple readmissions', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: 600, prior_admission_id: 550 },
      { id: 601, prior_admission_id: 560 },
    ]);

    const candidates = await evaluate({ tenantId: TENANT, now: NOW });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.scope_key)).toContain('readmission:600');
    expect(candidates.map((c) => c.scope_key)).toContain('readmission:601');
  });
});
