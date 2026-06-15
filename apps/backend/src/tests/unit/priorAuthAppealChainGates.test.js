// Unit tests for Task 4: resume-aware pause nodes + gate predicates
// registered with the workflow resume scheduler.
//
// Strategy:
//   * Mock prisma.$queryRawUnsafe so DB lookups return a controllable
//     appeal row (no real DB needed — mirrors workflowResumeScheduler.test.js).
//   * Import the service AFTER setting up mocks (jest.unstable_mockModule).
//   * Test gateSubmitted / gateResolved / node resume-awareness via
//     __testing__ exports added in Task 4.
//
// Scheduler-routing assertion (optional but included):
//   * After the service module loads, GRAPH_REGISTRY and HANDLERS inside
//     the scheduler hold the prior_auth_appeal_chain entries —
//     a paused run is NOT skipped as unknown-workflow / unknown-reason.

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

// Stub collaborators that the service imports (avoid side-effects in tests).
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../../services/ai/appealLetterGeneratorService.js', () => ({
  classifyDenialReason: jest.fn(() => ({ classification: 'prior_auth_missing' })),
  generateAppealLetter: jest.fn().mockResolvedValue({ appeal_id: 1 }),
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn().mockResolvedValue({ enabled: true }),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: 'default-tenant',
}));
// Stub the checkpoint store so the scheduler import doesn't fail
jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => ({})),
  createMemoryCheckpointStore: jest.fn(() => ({
    createRun: jest.fn().mockResolvedValue({ id: 1, state: {}, tenant_id: 't1', workflow_key: 'prior_auth_appeal_chain' }),
    getRun: jest.fn(),
    markPaused: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    markRunning: jest.fn().mockResolvedValue(undefined),
    recordCheckpoint: jest.fn().mockResolvedValue(undefined),
    advance: jest.fn().mockResolvedValue(undefined),
  })),
}));
// Stub dischargeComposeService so the scheduler import doesn't blow up
jest.unstable_mockModule('../../services/ai/dischargeComposeService.js', () => ({
  getComposeGraph: jest.fn(() => ({ key: 'discharge_summary_compose' })),
  DISCHARGE_COMPOSE_WORKFLOW_KEY: 'discharge_summary_compose',
}));

// ------------------------------------------------------------------ lazy imports (after mocks)
let gateSubmitted;
let gateResolved;
let isAppealSubmitted;
let isAppealResolved;
let NODES;
let schedulerTesting;

beforeAll(async () => {
  // The service registers with the scheduler at module load.
  const svc = await import('../../services/ai/priorAuthAppealChainService.js');
  ({ gateSubmitted, gateResolved, isAppealSubmitted, isAppealResolved, NODES } = svc.__testing__);

  const scheduler = await import('../../services/ai/workflowResumeScheduler.js');
  schedulerTesting = scheduler.__testing__;
});

beforeEach(() => {
  mockQueryRawUnsafe.mockReset();
});

// ================================================================== isAppealSubmitted
describe('isAppealSubmitted', () => {
  it('returns true when appeal_status is "submitted"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    expect(await isAppealSubmitted({ appealId: 7, tenantId: 't1' })).toBe(true);
  });

  it('returns false when appeal_status is "draft"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'draft' }]);
    expect(await isAppealSubmitted({ appealId: 7, tenantId: 't1' })).toBe(false);
  });

  it('returns false when no row found', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    expect(await isAppealSubmitted({ appealId: 7, tenantId: 't1' })).toBe(false);
  });

  it('returns false on DB error (safe fallback)', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('connection refused'));
    expect(await isAppealSubmitted({ appealId: 7, tenantId: 't1' })).toBe(false);
  });
});

// ================================================================== isAppealResolved
describe('isAppealResolved', () => {
  it('returns true when appeal_status is "approved"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'approved' }]);
    expect(await isAppealResolved({ appealId: 7, tenantId: 't1' })).toBe(true);
  });

  it('returns true when appeal_status is "denied"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'denied' }]);
    expect(await isAppealResolved({ appealId: 7, tenantId: 't1' })).toBe(true);
  });

  it('returns true when appeal_status is "withdrawn"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'withdrawn' }]);
    expect(await isAppealResolved({ appealId: 7, tenantId: 't1' })).toBe(true);
  });

  it('returns false when appeal_status is "submitted" (not yet resolved)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    expect(await isAppealResolved({ appealId: 7, tenantId: 't1' })).toBe(false);
  });

  it('returns false on DB error (safe fallback)', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('timeout'));
    expect(await isAppealResolved({ appealId: 7, tenantId: 't1' })).toBe(false);
  });
});

// ================================================================== gateSubmitted
describe('gateSubmitted', () => {
  it('returns true when the appeal row shows "submitted" (read from run.state)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    const run = {
      tenant_id: 't1',
      state: { pendingDisposition: { appeal_id: 7 } },
      metadata: {},
    };
    expect(await gateSubmitted(run)).toBe(true);
  });

  it('returns true when appealId comes from run.metadata fallback', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    const run = {
      tenant_id: 't1',
      state: {},
      metadata: { pendingDisposition: { appeal_id: 7 } },
    };
    expect(await gateSubmitted(run)).toBe(true);
  });

  it('returns false when appeal_status is "draft"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'draft' }]);
    const run = {
      tenant_id: 't1',
      state: { pendingDisposition: { appeal_id: 7 } },
      metadata: {},
    };
    expect(await gateSubmitted(run)).toBe(false);
  });

  it('returns false when no appeal id is present on the run', async () => {
    const run = { tenant_id: 't1', state: {}, metadata: {} };
    expect(await gateSubmitted(run)).toBe(false);
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });
});

// ================================================================== gateResolved
describe('gateResolved', () => {
  it('returns true for "approved"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'approved' }]);
    const run = {
      tenant_id: 't1',
      state: { pendingPayerResponse: { appeal_id: 7 } },
      metadata: {},
    };
    expect(await gateResolved(run)).toBe(true);
  });

  it('returns true for "denied"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'denied' }]);
    const run = {
      tenant_id: 't1',
      state: { pendingPayerResponse: { appeal_id: 7 } },
      metadata: {},
    };
    expect(await gateResolved(run)).toBe(true);
  });

  it('returns true for "withdrawn"', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'withdrawn' }]);
    const run = {
      tenant_id: 't1',
      state: { pendingPayerResponse: { appeal_id: 7 } },
      metadata: {},
    };
    expect(await gateResolved(run)).toBe(true);
  });

  it('returns false for "submitted" (not yet resolved)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    const run = {
      tenant_id: 't1',
      state: { pendingPayerResponse: { appeal_id: 7 } },
      metadata: {},
    };
    expect(await gateResolved(run)).toBe(false);
  });

  it('returns false when no appeal id is present on the run', async () => {
    const run = { tenant_id: 't1', state: {}, metadata: {} };
    expect(await gateResolved(run)).toBe(false);
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns true when appealId comes from run.metadata fallback', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'approved' }]);
    const run = {
      tenant_id: 't1',
      state: {},
      metadata: { pendingPayerResponse: { appeal_id: 7 } },
    };
    expect(await gateResolved(run)).toBe(true);
  });
});

// ================================================================== Resume-aware pause nodes
describe('await_human_disposition (resume-aware)', () => {
  it('returns {} (proceed) when appeal is already submitted', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    const state = { appealId: 7, tenantId: 't1' };
    const result = await NODES.await_human_disposition(state);
    expect(result).toEqual({});
    expect(result.__pause).toBeUndefined();
  });

  it('returns a pause sentinel when appeal is still in draft', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'draft' }]);
    const state = { appealId: 7, tenantId: 't1' };
    const result = await NODES.await_human_disposition(state);
    expect(result.__pause).toBe('await_appeal_human_disposition');
    expect(result.state?.pendingDisposition?.appeal_id).toBe(7);
  });

  it('returns a pause sentinel when DB lookup fails (first-run safety)', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('no connection'));
    const state = { appealId: 7, tenantId: 't1' };
    const result = await NODES.await_human_disposition(state);
    // isAppealSubmitted returns false on error → node pauses
    expect(result.__pause).toBe('await_appeal_human_disposition');
  });
});

describe('await_payer_response (resume-aware)', () => {
  it('returns {} (proceed) when appeal is approved', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'approved' }]);
    const state = { appealId: 7, tenantId: 't1' };
    const result = await NODES.await_payer_response(state);
    expect(result).toEqual({});
    expect(result.__pause).toBeUndefined();
  });

  it('returns a pause sentinel when appeal is still submitted (payer not yet responded)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ appeal_status: 'submitted' }]);
    const state = { appealId: 7, tenantId: 't1' };
    const result = await NODES.await_payer_response(state);
    expect(result.__pause).toBe('await_appeal_payer_response');
    expect(result.state?.pendingPayerResponse?.appeal_id).toBe(7);
  });

  it('returns a pause sentinel when DB lookup fails (first-run safety)', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('timeout'));
    const state = { appealId: 7, tenantId: 't1' };
    const result = await NODES.await_payer_response(state);
    expect(result.__pause).toBe('await_appeal_payer_response');
  });
});

// ================================================================== Scheduler registration
describe('scheduler registration', () => {
  it('registers prior_auth_appeal_chain in GRAPH_REGISTRY', () => {
    expect(schedulerTesting.GRAPH_REGISTRY.has('prior_auth_appeal_chain')).toBe(true);
  });

  it('registers await_appeal_human_disposition in HANDLERS', () => {
    expect(schedulerTesting.HANDLERS.has('await_appeal_human_disposition')).toBe(true);
  });

  it('registers await_appeal_payer_response in HANDLERS', () => {
    expect(schedulerTesting.HANDLERS.has('await_appeal_payer_response')).toBe(true);
  });

  it('a paused run with prior_auth_appeal_chain workflow is not skipped as unknown-workflow', () => {
    // This verifies the run would reach gate evaluation (not short-circuit).
    const graphFactory = schedulerTesting.GRAPH_REGISTRY.get('prior_auth_appeal_chain');
    expect(typeof graphFactory).toBe('function');
  });

  it('a paused run with await_appeal_human_disposition reason is not skipped as unknown-reason', () => {
    const handler = schedulerTesting.HANDLERS.get('await_appeal_human_disposition');
    expect(typeof handler).toBe('function');
  });

  it('a paused run with await_appeal_payer_response reason is not skipped as unknown-reason', () => {
    const handler = schedulerTesting.HANDLERS.get('await_appeal_payer_response');
    expect(typeof handler).toBe('function');
  });
});
