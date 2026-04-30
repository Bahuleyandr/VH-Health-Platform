// Unit tests for the workflow resume scheduler (Phase 5 of the
// clinical-AI rollout — docs/CLINICAL_AI_ROLLOUT_PLAN.md).
//
// The scheduler reads paused-run rows from clinical_ai_workflow_runs
// and resumes ones whose external gate has fired. The DB call + the
// resumeWorkflow call are both mocked here; the test asserts the
// scanning + routing + summary contract.
//
// What this DOESN'T cover (intentionally — DB-backed integration):
//   * Real isGovernanceApproved() against a Postgres test DB. The CI
//     integration suite covers that path.
//   * Real resumeWorkflow() over the memory store with real graph
//     traversal — already covered by workflowGraphRunner.test.js and
//     dischargeComposeService.test.js.

import { jest } from '@jest/globals';

// Mock the scheduler's collaborators BEFORE importing the scheduler
// itself, so the module sees the stubs.
const mockQueryRawUnsafe = jest.fn();
const mockResumeWorkflow = jest.fn();
const mockGetComposeGraph = jest.fn(() => ({ key: 'discharge_summary_compose' }));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: mockQueryRawUnsafe },
}));
jest.unstable_mockModule('../../services/ai/workflowGraphRunner.js', () => ({
  resumeWorkflow: mockResumeWorkflow,
}));
jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: () => ({}),
}));
jest.unstable_mockModule('../../services/ai/dischargeComposeService.js', () => ({
  getComposeGraph: mockGetComposeGraph,
  DISCHARGE_COMPOSE_WORKFLOW_KEY: 'discharge_summary_compose',
}));

let runPausedWorkflowSweep;
let registerPauseReasonHandler;

beforeAll(async () => {
  const mod = await import('../../services/ai/workflowResumeScheduler.js');
  runPausedWorkflowSweep = mod.runPausedWorkflowSweep;
  registerPauseReasonHandler = mod.registerPauseReasonHandler;
});

beforeEach(() => {
  mockQueryRawUnsafe.mockReset();
  mockResumeWorkflow.mockReset();
  mockGetComposeGraph.mockReset().mockReturnValue({ key: 'discharge_summary_compose' });
});

describe('runPausedWorkflowSweep — empty queue', () => {
  it('returns a zero summary when no paused rows exist', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const summary = await runPausedWorkflowSweep();
    expect(summary.scanned).toBe(0);
    expect(summary.resumed).toBe(0);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });
});

describe('runPausedWorkflowSweep — schema missing', () => {
  it('returns silently when clinical_ai_workflow_runs does not exist (migration not yet applied)', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(
      Object.assign(new Error('relation "clinical_ai_workflow_runs" does not exist'), {})
    );
    const summary = await runPausedWorkflowSweep();
    expect(summary.scanned).toBe(0);
    expect(summary.resumed).toBe(0);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });
});

describe('runPausedWorkflowSweep — routing', () => {
  it('skips runs whose workflow_key is not registered', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 1,
        tenant_id: 't',
        workflow_key: 'unknown_workflow',
        pause_reason: 'await_governance',
        metadata: {},
        state: {},
      },
    ]);
    const summary = await runPausedWorkflowSweep();
    expect(summary.skipped_unknown_workflow).toBe(1);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });

  it('skips runs whose pause_reason has no registered handler', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 2,
        tenant_id: 't',
        workflow_key: 'discharge_summary_compose',
        pause_reason: 'await_unknown_event',
        metadata: {},
        state: {},
      },
    ]);
    const summary = await runPausedWorkflowSweep();
    expect(summary.skipped_unknown_reason).toBe(1);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });
});

describe('runPausedWorkflowSweep — gate satisfied', () => {
  it('resumes when the registered handler returns true', async () => {
    // Register a synthetic pause reason that always satisfies the gate.
    registerPauseReasonHandler('test_always_pass', async () => true);

    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 7,
        tenant_id: 't',
        workflow_key: 'discharge_summary_compose',
        pause_reason: 'test_always_pass',
        metadata: {},
        state: {},
      },
    ]);
    mockResumeWorkflow.mockResolvedValueOnce({
      status: 'completed',
      runId: 7,
      state: {},
      result: {},
    });

    const summary = await runPausedWorkflowSweep();
    expect(summary.resumed).toBe(1);
    expect(summary.skipped_gate_not_satisfied).toBe(0);
    expect(mockResumeWorkflow).toHaveBeenCalledTimes(1);
    expect(mockResumeWorkflow.mock.calls[0][0]).toEqual(
      expect.objectContaining({ runId: 7 })
    );
  });

  it('counts resume failures distinctly from completed resumes', async () => {
    registerPauseReasonHandler('test_resume_fail', async () => true);
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 8,
        tenant_id: 't',
        workflow_key: 'discharge_summary_compose',
        pause_reason: 'test_resume_fail',
        metadata: {},
        state: {},
      },
    ]);
    mockResumeWorkflow.mockResolvedValueOnce({
      status: 'failed',
      runId: 8,
      state: {},
      error: { node: 'x', message: 'y' },
    });

    const summary = await runPausedWorkflowSweep();
    expect(summary.resumed).toBe(0);
    expect(summary.resume_failed).toBe(1);
  });

  it('skips when handler returns false (gate not yet satisfied)', async () => {
    registerPauseReasonHandler('test_always_block', async () => false);
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 9,
        tenant_id: 't',
        workflow_key: 'discharge_summary_compose',
        pause_reason: 'test_always_block',
        metadata: {},
        state: {},
      },
    ]);

    const summary = await runPausedWorkflowSweep();
    expect(summary.skipped_gate_not_satisfied).toBe(1);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });
});

describe('runPausedWorkflowSweep — bounded fan-out', () => {
  it('respects maxResumes cap', async () => {
    registerPauseReasonHandler('test_cap', async () => true);
    // Generate 10 paused runs all eligible for resume.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      tenant_id: 't',
      workflow_key: 'discharge_summary_compose',
      pause_reason: 'test_cap',
      metadata: {},
      state: {},
    }));
    mockQueryRawUnsafe.mockResolvedValueOnce(rows);
    mockResumeWorkflow.mockResolvedValue({
      status: 'completed',
      runId: 0,
      state: {},
      result: {},
    });

    const summary = await runPausedWorkflowSweep({ maxResumes: 3 });
    expect(summary.resumed).toBe(3);
    expect(mockResumeWorkflow).toHaveBeenCalledTimes(3);
  });
});

describe('runPausedWorkflowSweep — handler exceptions', () => {
  it('treats a handler that throws as gate-not-satisfied (does NOT resume)', async () => {
    registerPauseReasonHandler('test_handler_throws', async () => {
      throw new Error('lookup failed');
    });
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 50,
        tenant_id: 't',
        workflow_key: 'discharge_summary_compose',
        pause_reason: 'test_handler_throws',
        metadata: {},
        state: {},
      },
    ]);

    const summary = await runPausedWorkflowSweep();
    expect(summary.skipped_gate_not_satisfied).toBe(1);
    expect(summary.resumed).toBe(0);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });
});
