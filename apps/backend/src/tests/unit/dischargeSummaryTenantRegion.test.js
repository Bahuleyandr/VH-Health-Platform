/**
 * Unit tests for the post-#775/#804 follow-up: generateDischargeSummary must
 * thread the tenant's data-residency region into generateClinicalText so the
 * deep-tier egress guard (CLINICAL_AI_EXTERNAL_REGIONS in localLlmClient) can
 * allow-list the tenant. Before this fix the call passed no tenantRegion, so
 * under a region allowlist the governed call always failed closed (external
 * egress denied) even for explicitly allowed tenants.
 *
 * Region resolution order (mirrors codingBatchSuggestionService):
 *   1. req.tenant.region (populated by tenantContextMiddleware on the route path)
 *   2. tenants.region looked up by req.tenantId (the markForDischarge cascade
 *      passes a minimal `{ tenantId }` context — no HTTP request)
 *   3. null when neither is available or the lookup fails (fail-closed
 *      semantics inside localLlmClient are unchanged).
 */

import { jest } from '@jest/globals';

const TENANT_ID = '20000000-0000-4000-8000-000000000009';

const mockGenerateClinicalText = jest.fn(async () => ({
  text: 'AI hospital course.',
  usedAi: true,
  provider: 'anthropic',
  model: 'deep-test-model',
  tier: 'deep',
  moduleKey: 'discharge_summary',
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  estimatedCostMinor: null,
}));
const mockQueryRawUnsafe = jest.fn(async () => [{ region: 'IN' }]);
const mockGenerationCreate = jest.fn(async () => ({ id: 77, used_ai: true, provider: 'anthropic' }));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: mockQueryRawUnsafe,
    clinical_ai_generations: { create: mockGenerationCreate },
  },
  setTenantTx: async (_tenantId, fn) => fn({}),
  setTenant: async (_tenantId, fn) => fn({}),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: mockGenerateClinicalText,
  getClinicalAiConfig: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  currentCanonicalTransactionRevision: jest.fn(() => 'rev-test'),
  recordCanonicalClinicalEvent: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

// Sparse-but-valid admission clinical context: every array the builders touch
// is present and empty, so the structured-summary assembly runs end to end.
function emptyContext() {
  return {
    patient: { uid: '30000000-0000-4000-8000-000000000004', name: 'Test Patient' },
    admission: {
      id: 12,
      patient_uid: '30000000-0000-4000-8000-000000000004',
      encounter_id: 34,
      admitted_at: '2026-08-01T10:00:00Z',
    },
    timeline: [],
    notes: [],
    vitals: [],
    investigations: [],
    orders: [],
    diagnoses: [],
    allergies: [],
    citations: [],
    chronic_medications: [],
    radiology_orders: [],
    attending_doctors: [],
  };
}

const mockCollectContext = jest.fn(async () => emptyContext());
jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  collectAdmissionClinicalContext: mockCollectContext,
  getPatientTimeline: jest.fn(),
}));

const { generateDischargeSummary } = await import('../../services/emr/dischargeSummaryGenerator.js');

beforeEach(() => {
  mockGenerateClinicalText.mockClear();
  mockQueryRawUnsafe.mockClear();
  mockQueryRawUnsafe.mockImplementation(async () => [{ region: 'IN' }]);
  mockCollectContext.mockClear();
});

describe('generateDischargeSummary — tenantRegion threading into the governed model call', () => {
  it('passes req.tenant.region straight through (route path) without a DB lookup', async () => {
    await generateDischargeSummary(12, 'doctor-uid', {
      tenantId: TENANT_ID,
      tenant: { region: 'US' },
    });

    expect(mockGenerateClinicalText).toHaveBeenCalledTimes(1);
    const args = mockGenerateClinicalText.mock.calls[0][0];
    expect(args.taskType).toBe('discharge_summary');
    expect(args.tenantId).toBe(TENANT_ID);
    expect(args.tenantRegion).toBe('US');
    // Request context already carried the region — no tenants-table read.
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it('resolves the region from the tenants table when only tenantId is available (cascade path)', async () => {
    await generateDischargeSummary(12, 'doctor-uid', { tenantId: TENANT_ID });

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('SELECT region FROM tenants'),
      TENANT_ID,
    );
    const args = mockGenerateClinicalText.mock.calls[0][0];
    expect(args.tenantRegion).toBe('IN');
    expect(args.tenantId).toBe(TENANT_ID);
  });

  it('passes tenantRegion=null when there is no request context at all (fail-closed semantics preserved)', async () => {
    await generateDischargeSummary(12, 'doctor-uid', null);

    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    const args = mockGenerateClinicalText.mock.calls[0][0];
    expect(args.tenantRegion).toBeNull();
  });

  it('treats a failed tenants-table lookup as region unknown (null) instead of throwing', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('db down'));

    const summary = await generateDischargeSummary(12, 'doctor-uid', { tenantId: TENANT_ID });

    expect(summary).toBeTruthy();
    const args = mockGenerateClinicalText.mock.calls[0][0];
    expect(args.tenantRegion).toBeNull();
  });

  it('passes tenantRegion=null when the tenant row has no region (genuinely region-less tenant)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ region: null }]);

    await generateDischargeSummary(12, 'doctor-uid', { tenantId: TENANT_ID });

    const args = mockGenerateClinicalText.mock.calls[0][0];
    expect(args.tenantRegion).toBeNull();
  });
});
