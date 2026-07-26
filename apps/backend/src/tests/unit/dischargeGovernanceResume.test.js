// Unit tests for the resume-aware governance pause node in
// dischargeComposeService.js (fixes the infinite re-pause loop bug).
//
// Strategy:
//   * Mock prisma.$queryRawUnsafe so the clinical_ai_approvals lookup
//     returns an approved row, no row, or throws — no real DB needed.
//   * Import the service AFTER mocks (jest.unstable_mockModule).
//   * Test the await_governance_approval node for all three cases:
//     - requireGovernanceApproval unset  → returns {} immediately (no DB hit)
//     - requireGovernanceApproval set, approved row exists → returns {} (proceed)
//     - requireGovernanceApproval set, no approved row → returns pause sentinel
//     - requireGovernanceApproval set, DB error → returns pause sentinel (safe)
//   * Also tests isComposeGovernanceApproved predicate exported via __testing__.
//
// Mirrors priorAuthAppealChainGates.test.js in structure and naming.

import { jest } from '@jest/globals';

// ------------------------------------------------------------------ mocks
// Must be declared BEFORE any dynamic import() of the service.

const mockQueryRawUnsafe = jest.fn();
const __prismaDefaultMock = { $queryRawUnsafe: mockQueryRawUnsafe };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

// Stub collaborators that dischargeComposeService imports.
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../../services/discharge/dischargeService.js', () => ({
  materializeDischargeComposeSections: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn().mockResolvedValue({ enabled: true, settings: {} }),
}));
jest.unstable_mockModule('../../services/ai/clinicalAiWorkflowService.js', () => ({
  ADMISSION_MODULES: new Set(['medication_reconciliation', 'patient_aftercare_instructions', 'discharge_readiness', 'clinical_coding_assist']),
  getAdmissionAiDraftGraph: jest.fn(() => ({ key: 'admission_ai_draft' })),
  requireEnabledModule: jest.fn().mockResolvedValue({ enabled: true }),
  resolveTenantId: jest.fn(({ tenantId }) => tenantId || 'default-tenant'),
}));
jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => ({})),
  createMemoryCheckpointStore: jest.fn(() => ({
    createRun: jest.fn().mockResolvedValue({ id: 1, state: {}, tenant_id: 't1', workflow_key: 'discharge_summary_compose' }),
    getRun: jest.fn(),
    markPaused: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    markRunning: jest.fn().mockResolvedValue(undefined),
    recordCheckpoint: jest.fn().mockResolvedValue(undefined),
    advance: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: 'default-tenant',
  resolveTenantOrThrow: (req) => req?.tenantId || 'default-tenant',
  requireTenantId: (tenantId) => tenantId || 'default-tenant',
}));

// ------------------------------------------------------------------ lazy imports (after mocks)
let COMPOSE_GRAPH_NODES;
let isComposeGovernanceApproved;

beforeAll(async () => {
  const svc = await import('../../services/ai/dischargeComposeService.js');
  ({ COMPOSE_GRAPH_NODES, isComposeGovernanceApproved } = svc.__testing__);
});

beforeEach(() => {
  mockQueryRawUnsafe.mockReset();
});

// ================================================================== isComposeGovernanceApproved
describe('isComposeGovernanceApproved', () => {
  it('returns true when an approved row exists for the compose_generation_id', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: 10, status: 'approved', decided_at: new Date() }]);
    const result = await isComposeGovernanceApproved({ tenantId: 't1', composeGenerationId: 42 });
    expect(result).toBe(true);
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('returns false when no approved row exists (empty result)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const result = await isComposeGovernanceApproved({ tenantId: 't1', composeGenerationId: 42 });
    expect(result).toBe(false);
  });

  it('returns false when composeGenerationId is null (no anchor to query)', async () => {
    const result = await isComposeGovernanceApproved({ tenantId: 't1', composeGenerationId: null });
    expect(result).toBe(false);
    // No DB hit — there is no id to query by.
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns false on DB error (safe fallback, never throws)', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('connection refused'));
    const result = await isComposeGovernanceApproved({ tenantId: 't1', composeGenerationId: 42 });
    expect(result).toBe(false);
  });
});

// ================================================================== await_governance_approval node
describe('await_governance_approval (resume-aware)', () => {
  it('returns {} immediately when requireGovernanceApproval is not set (no pause, no DB hit)', async () => {
    // Module has no governance requirement — should pass through fast.
    const state = {
      tenantId: 't1',
      admissionId: 100,
      composeModule: { settings: {} },
      composeGeneration: { id: 42 },
    };
    const result = await COMPOSE_GRAPH_NODES.await_governance_approval(state);
    expect(result).toEqual({});
    expect(result.__pause).toBeUndefined();
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns {} immediately when composeModule is absent (defensive — no pause)', async () => {
    const state = { tenantId: 't1', admissionId: 100 };
    const result = await COMPOSE_GRAPH_NODES.await_governance_approval(state);
    expect(result).toEqual({});
    expect(result.__pause).toBeUndefined();
  });

  it('returns {} (proceed) when requireGovernanceApproval is true AND an approved row exists', async () => {
    // This is the resume scenario: the run was previously paused, an admin
    // approved it, the scheduler resumed it, and the node re-runs. It should
    // detect the approval and return {} (not re-pause).
    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: 10, status: 'approved', decided_at: new Date() }]);
    const state = {
      tenantId: 't1',
      admissionId: 100,
      composeModule: { settings: { requireGovernanceApproval: true } },
      composeGeneration: { id: 42 },
    };
    const result = await COMPOSE_GRAPH_NODES.await_governance_approval(state);
    expect(result).toEqual({});
    expect(result.__pause).toBeUndefined();
  });

  it('returns a pause sentinel when requireGovernanceApproval is true and no approved row exists', async () => {
    // First-run scenario: governance is required but no approval yet. Should park.
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const state = {
      tenantId: 't1',
      admissionId: 100,
      composeModule: { settings: { requireGovernanceApproval: true } },
      composeGeneration: { id: 42 },
    };
    const result = await COMPOSE_GRAPH_NODES.await_governance_approval(state);
    expect(result.__pause).toBe('await_governance');
    expect(result.state?.pendingApproval?.compose_generation_id).toBe(42);
    expect(result.state?.pendingApproval?.admission_id).toBe(100);
  });

  it('returns a pause sentinel when DB lookup fails (first-run safety)', async () => {
    // On error, isComposeGovernanceApproved returns false → node re-pauses.
    // This is the safe direction: better to stay paused than to proceed without approval.
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('timeout'));
    const state = {
      tenantId: 't1',
      admissionId: 100,
      composeModule: { settings: { requireGovernanceApproval: true } },
      composeGeneration: { id: 42 },
    };
    const result = await COMPOSE_GRAPH_NODES.await_governance_approval(state);
    expect(result.__pause).toBe('await_governance');
  });

  it('pauses with null compose_generation_id when composeGeneration is absent', async () => {
    // Guard: if state.composeGeneration is missing (e.g. persist node hasn't run),
    // we still pause (with null id) rather than throwing. isComposeGovernanceApproved
    // returns false for null id without hitting the DB.
    const state = {
      tenantId: 't1',
      admissionId: 100,
      composeModule: { settings: { requireGovernanceApproval: true } },
      // no composeGeneration
    };
    const result = await COMPOSE_GRAPH_NODES.await_governance_approval(state);
    expect(result.__pause).toBe('await_governance');
    expect(result.state?.pendingApproval?.compose_generation_id).toBeNull();
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });
});
