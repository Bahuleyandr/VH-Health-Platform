// Unit tests for the prior_auth_appeal_chain workflow graph.
//
// Strategy:
//   * Graph-node tests drive NODES directly via the REAL WorkflowGraph /
//     runWorkflow obtained through jest.unstable_mockModule + dynamic import.
//   * Sweep tests mock prisma.$queryRawUnsafe to return PA rows and assert
//     that runWorkflow (which is the mock) receives the correct per-PA tenantId.
//
// ESM note: jest.unstable_mockModule must be called BEFORE any dynamic import
// of the module under test.  All test imports must be dynamic (await import()).

import { jest } from '@jest/globals';

// ─── Capture the REAL graph runner before mocking anything ───────────────────
// Import the real implementations under alias paths so we can use them in
// graph-node tests even after workflowGraphRunner.js is mocked.
import * as realGraphRunner from '../../services/ai/workflowGraphRunner.js';
import * as realCheckpointStore from '../../services/ai/workflowCheckpointStore.js';
const { WorkflowGraph: RealWorkflowGraph, runWorkflow: realRunWorkflow } = realGraphRunner;
const { createMemoryCheckpointStore: realCreateMemoryCheckpointStore } = realCheckpointStore;

// ─── Module-level mocks ───────────────────────────────────────────────────────

const mockRunWorkflow = jest.fn();

jest.unstable_mockModule('../../services/ai/workflowGraphRunner.js', () => ({
  WorkflowGraph: RealWorkflowGraph,   // keep real so graph-node tests work
  runWorkflow: mockRunWorkflow,        // replaced for sweep tests
  pauseRun: realGraphRunner.pauseRun, // keep real for await_* node tests
}));

const mockPrismaQueryRaw = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: mockPrismaQueryRaw },
}));

const mockGetClinicalAiModule = jest.fn();
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: mockGetClinicalAiModule,
}));

jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => ({})),
  createMemoryCheckpointStore: realCreateMemoryCheckpointStore,
}));

jest.unstable_mockModule('../../services/ai/workflowResumeScheduler.js', () => ({
  registerWorkflowGraph: jest.fn(),
  registerPauseReasonHandler: jest.fn(),
}));

jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/appealLetterGeneratorService.js', () => ({
  classifyDenialReason: jest.fn(() => ({ classification: 'prior_auth_missing' })),
  generateAppealLetter: jest.fn(),
}));

// ─── Dynamic imports (must come AFTER unstable_mockModule calls) ──────────────

const { __testing__, startPendingPriorAuthAppeals } =
  await import('../../services/ai/priorAuthAppealChainService.js');

const { NODES, WORKFLOW_KEY } = __testing__;

// ─── Reset mocks between tests ────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: sweep calls succeed with a paused outcome.
  mockRunWorkflow.mockResolvedValue({
    status: 'paused',
    runId: 1,
    pauseReason: 'await_appeal_human_disposition',
  });
});

// ─── Existing graph-node tests (use REAL WorkflowGraph + realRunWorkflow) ─────
// We call realRunWorkflow directly so the mock doesn't interfere.

test('WORKFLOW_KEY is prior_auth_appeal_chain', () => {
  expect(WORKFLOW_KEY).toBe('prior_auth_appeal_chain');
});

test('runs draft then pauses awaiting human disposition', async () => {
  const graph = new RealWorkflowGraph({
    key: WORKFLOW_KEY,
    nodes: {
      load_denied_prior_auth: async () => ({
        priorAuth: { id: 42, status: 'denied', payer_decision_reason: 'no prior auth on file' },
        module: { enabled: true },
        denialReason: 'no prior auth on file',
      }),
      classify_denial: NODES.classify_denial,
      draft_appeal: async () => ({ appeal: { appeal_id: 7 }, appealId: 7 }),
      await_human_disposition: NODES.await_human_disposition,
    },
    start: 'load_denied_prior_auth',
  });
  const store = realCreateMemoryCheckpointStore();
  const out = await realRunWorkflow({ graph, initialState: { priorAuthId: 42 }, store, tenantId: 't1' });
  expect(out.status).toBe('paused');
  expect(out.pauseReason).toBe('await_appeal_human_disposition');
  expect(out.state.pendingDisposition.appeal_id).toBe(7);
});

test('classify_denial sets classification from denialReason', async () => {
  const graph = new RealWorkflowGraph({
    key: WORKFLOW_KEY,
    nodes: {
      setup: async () => ({
        denialReason: 'prior auth required but not obtained',
      }),
      classify_denial: NODES.classify_denial,
    },
    start: 'setup',
  });
  const store = realCreateMemoryCheckpointStore();
  const out = await realRunWorkflow({ graph, initialState: {}, store, tenantId: 't1' });
  expect(out.status).toBe('completed');
  expect(out.state.classification).toBeDefined();
  expect(out.state.classification.classification).toBe('prior_auth_missing');
});

test('await_payer_response pauses with await_appeal_payer_response reason', async () => {
  const graph = new RealWorkflowGraph({
    key: WORKFLOW_KEY,
    nodes: {
      setup: async () => ({ appealId: 99 }),
      await_payer_response: NODES.await_payer_response,
    },
    start: 'setup',
  });
  const store = realCreateMemoryCheckpointStore();
  const out = await realRunWorkflow({ graph, initialState: {}, store, tenantId: 't1' });
  expect(out.status).toBe('paused');
  expect(out.pauseReason).toBe('await_appeal_payer_response');
  expect(out.state.pendingPayerResponse.appeal_id).toBe(99);
});

// ─── Sweep tests (startPendingPriorAuthAppeals) ───────────────────────────────

describe('startPendingPriorAuthAppeals', () => {
  test('calls composePriorAuthAppeal once per denied PA, passing its tenantId', async () => {
    const rows = [
      { id: 10, tenant_id: 'tenant-a' },
      { id: 11, tenant_id: 'tenant-b' },
    ];
    mockPrismaQueryRaw.mockResolvedValue(rows);
    mockGetClinicalAiModule.mockResolvedValue({ enabled: true });

    const summary = await startPendingPriorAuthAppeals({ maxStarts: 25 });

    expect(summary.scanned).toBe(2);
    expect(summary.started).toBe(2);
    expect(summary.skipped_disabled).toBe(0);
    expect(summary.failed).toBe(0);

    // mockRunWorkflow is called inside composePriorAuthAppeal.
    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);

    // First call: PA id=10, tenant-a
    expect(mockRunWorkflow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      initialState: expect.objectContaining({ priorAuthId: 10, tenantId: 'tenant-a' }),
      tenantId: 'tenant-a',
    }));

    // Second call: PA id=11, tenant-b
    expect(mockRunWorkflow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      initialState: expect.objectContaining({ priorAuthId: 11, tenantId: 'tenant-b' }),
      tenantId: 'tenant-b',
    }));
  });

  test('skips PAs whose tenant module is disabled', async () => {
    mockPrismaQueryRaw.mockResolvedValue([
      { id: 20, tenant_id: 'tenant-disabled' },
      { id: 21, tenant_id: 'tenant-enabled' },
    ]);
    mockGetClinicalAiModule
      .mockResolvedValueOnce({ enabled: false })   // PA 20 → skip
      .mockResolvedValueOnce({ enabled: true });    // PA 21 → start

    const summary = await startPendingPriorAuthAppeals({ maxStarts: 25 });

    expect(summary.scanned).toBe(2);
    expect(summary.started).toBe(1);
    expect(summary.skipped_disabled).toBe(1);
    expect(summary.failed).toBe(0);

    // composePriorAuthAppeal (→ mockRunWorkflow) must NOT have been called for the disabled tenant.
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      initialState: expect.objectContaining({ priorAuthId: 21, tenantId: 'tenant-enabled' }),
    }));
  });

  test('returns zero summary and does not throw on scan DB error', async () => {
    mockPrismaQueryRaw.mockRejectedValue(
      new Error('relation "clinical_ai_prior_auth_requests" does not exist')
    );

    const summary = await startPendingPriorAuthAppeals({ maxStarts: 25 });

    expect(summary.scanned).toBe(0);
    expect(summary.started).toBe(0);
    expect(summary.skipped_disabled).toBe(0);
    expect(summary.failed).toBe(0);

    // runWorkflow must never have been called.
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  test('counts individual PA failures without aborting the sweep', async () => {
    mockPrismaQueryRaw.mockResolvedValue([
      { id: 30, tenant_id: 'tenant-x' },
      { id: 31, tenant_id: 'tenant-y' },
    ]);
    mockGetClinicalAiModule.mockResolvedValue({ enabled: true });

    // First call fails, second succeeds.
    mockRunWorkflow
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce({
        status: 'paused',
        runId: 2,
        pauseReason: 'await_appeal_human_disposition',
      });

    const summary = await startPendingPriorAuthAppeals({ maxStarts: 25 });

    expect(summary.scanned).toBe(2);
    expect(summary.started).toBe(1);
    expect(summary.failed).toBe(1);
  });

  test('workflowMetadata carries a numeric prior_auth_id', async () => {
    // Verify requirement (A): prior_auth_id in metadata is Number, not string.
    mockPrismaQueryRaw.mockResolvedValue([{ id: '42', tenant_id: 'tenant-a' }]);
    mockGetClinicalAiModule.mockResolvedValue({ enabled: true });

    await startPendingPriorAuthAppeals({ maxStarts: 25 });

    const callArgs = mockRunWorkflow.mock.calls[0][0];
    expect(callArgs.workflowMetadata.prior_auth_id).toBe(42);
    expect(typeof callArgs.workflowMetadata.prior_auth_id).toBe('number');
  });
});
