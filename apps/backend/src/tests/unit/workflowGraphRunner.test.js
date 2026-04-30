// Unit tests for the framework-free workflow graph runner.
//
// All exercises run against the in-memory checkpoint store so the suite
// stays DB-free. The DB-backed store has the same interface and is
// covered transitively by the existing clinical AI integration tests
// once migration 109 lands.
//
// Coverage:
//   * Linear graph traversal completes; final state is the merged delta
//     of every node.
//   * Checkpoints are recorded after every successful node.
//   * Pause sentinel parks the run; resume picks up at the NEXT node
//     (paused node is not a "completed" checkpoint).
//   * Halt sentinel ends the run early with a final result.
//   * Failure marks the run failed and propagates the node identity.
//   * Resume on a completed run is a no-op (idempotent).
//   * Edges can be a function for conditional routing.
//   * Node timeout aborts a runaway node.

import {
  WorkflowGraph,
  haltRun,
  pauseRun,
  resumeWorkflow,
  runWorkflow,
} from '../../services/ai/workflowGraphRunner.js';
import { createMemoryCheckpointStore } from '../../services/ai/workflowCheckpointStore.js';

const TENANT = '00000000-0000-0000-0000-000000000001';

function linearGraph() {
  return new WorkflowGraph({
    key: 'linear',
    nodes: {
      one: async (state) => ({ counter: (state.counter || 0) + 1 }),
      two: async (state) => ({ counter: state.counter + 10, two_ran: true }),
      three: async (state) => ({ result: state.counter * 2 }),
    },
  });
}

describe('runWorkflow — linear graph', () => {
  it('walks every node in declaration order and returns state.result', async () => {
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({
      graph: linearGraph(),
      initialState: { counter: 0 },
      store,
      tenantId: TENANT,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toBe(22); // (0+1+10) * 2
    expect(outcome.state.two_ran).toBe(true);
  });

  it('records a checkpoint per node with status="completed"', async () => {
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({
      graph: linearGraph(),
      initialState: { counter: 0 },
      store,
      tenantId: TENANT,
    });
    const run = await store.getRun(outcome.runId);
    expect(run.checkpoints).toHaveLength(3);
    expect(run.checkpoints.map((c) => c.node)).toEqual(['one', 'two', 'three']);
    for (const cp of run.checkpoints) {
      expect(cp.status).toBe('completed');
      expect(cp.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(run.current_node).toBe('three');
    expect(run.status).toBe('completed');
  });
});

describe('runWorkflow — pause / resume', () => {
  it('parks the run at the paused node and returns pause reason', async () => {
    const graph = new WorkflowGraph({
      key: 'pausing',
      nodes: {
        a: async () => ({ a_done: true }),
        b: async () => pauseRun('await_governance'),
        c: async () => ({ c_done: true, result: 'final' }),
      },
    });
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({
      graph,
      initialState: {},
      store,
      tenantId: TENANT,
    });
    expect(outcome.status).toBe('paused');
    expect(outcome.pauseReason).toBe('await_governance');
    expect(outcome.pausedAtNode).toBe('b');
    expect(outcome.state.a_done).toBe(true);
    expect(outcome.state.c_done).toBeUndefined();
  });

  it('resume continues from the next node after the LAST COMPLETED node', async () => {
    const graph = new WorkflowGraph({
      key: 'pausing_resume',
      nodes: {
        a: async () => ({ a_done: true }),
        b: async () => pauseRun('hold'),
        c: async () => ({ c_done: true, result: 'final' }),
      },
    });
    const store = createMemoryCheckpointStore();
    const first = await runWorkflow({ graph, initialState: {}, store, tenantId: TENANT });
    expect(first.status).toBe('paused');

    // Swap node b for one that completes, simulating "the external event
    // happened and the same graph re-runs from the pause point".
    const resumeGraph = new WorkflowGraph({
      key: 'pausing_resume',
      nodes: {
        a: graph.nodes.a,
        b: async () => ({ b_done: true }),
        c: graph.nodes.c,
      },
    });
    const resumed = await resumeWorkflow({ runId: first.runId, store, graph: resumeGraph });
    expect(resumed.status).toBe('completed');
    // 'b' was the paused node; resume picks up AT 'b' (paused node isn't a
    // completed checkpoint). The replacement b runs, then c.
    expect(resumed.state.b_done).toBe(true);
    expect(resumed.state.c_done).toBe(true);
  });
});

describe('runWorkflow — halt sentinel', () => {
  it('ends the run early with the supplied result', async () => {
    const graph = new WorkflowGraph({
      key: 'halting',
      nodes: {
        a: async () => ({ a_done: true }),
        b: async () => haltRun({ reason: 'critical_safety' }),
        // never reached
        c: async () => { throw new Error('should not run'); },
      },
    });
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({ graph, initialState: {}, store, tenantId: TENANT });
    expect(outcome.status).toBe('completed');
    expect(outcome.halted).toBe(true);
    expect(outcome.result).toEqual({ reason: 'critical_safety' });
    expect(outcome.state.a_done).toBe(true);
  });
});

describe('runWorkflow — failures', () => {
  it('marks the run failed and reports the node identity', async () => {
    const graph = new WorkflowGraph({
      key: 'failing',
      nodes: {
        ok: async () => ({ ok: true }),
        boom: async () => { throw new Error('synthetic failure'); },
        unreachable: async () => ({ unreachable: true }),
      },
    });
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({ graph, initialState: {}, store, tenantId: TENANT });
    expect(outcome.status).toBe('failed');
    expect(outcome.error.node).toBe('boom');
    expect(outcome.error.message).toMatch(/synthetic failure/);
    expect(outcome.state.unreachable).toBeUndefined();

    const run = await store.getRun(outcome.runId);
    expect(run.status).toBe('failed');
    expect(run.error_node).toBe('boom');
    // Failure checkpoint is recorded with status="failed".
    const failureCp = run.checkpoints.find((c) => c.node === 'boom');
    expect(failureCp.status).toBe('failed');
    expect(failureCp.error).toMatch(/synthetic failure/);
  });

  it('errors at the start node still produce a run row for inspection', async () => {
    const graph = new WorkflowGraph({
      key: 'fail_first',
      nodes: { boom: async () => { throw new Error('first node fails'); } },
    });
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({ graph, initialState: {}, store, tenantId: TENANT });
    expect(outcome.status).toBe('failed');
    const run = await store.getRun(outcome.runId);
    expect(run.error_node).toBe('boom');
  });
});

describe('runWorkflow — resume idempotency', () => {
  it('resume on a completed run is a no-op and returns the original result', async () => {
    const graph = linearGraph();
    const store = createMemoryCheckpointStore();
    const first = await runWorkflow({ graph, initialState: { counter: 5 }, store, tenantId: TENANT });
    expect(first.status).toBe('completed');
    const initialResult = first.result;

    const resumed = await resumeWorkflow({ runId: first.runId, store, graph });
    expect(resumed.status).toBe('completed');
    expect(resumed.result).toBe(initialResult);

    // No additional checkpoints from the resume.
    const run = await store.getRun(first.runId);
    expect(run.checkpoints).toHaveLength(3);
  });

  it('resume on a failed run returns the failure without re-running nodes', async () => {
    const graph = new WorkflowGraph({
      key: 'fail_then_resume',
      nodes: {
        boom: async () => { throw new Error('fail'); },
      },
    });
    const store = createMemoryCheckpointStore();
    const first = await runWorkflow({ graph, initialState: {}, store, tenantId: TENANT });
    expect(first.status).toBe('failed');

    const resumed = await resumeWorkflow({ runId: first.runId, store, graph });
    expect(resumed.status).toBe('failed');
    expect(resumed.error.message).toMatch(/fail/);
  });
});

describe('runWorkflow — conditional edges', () => {
  it('a function edge picks the next node based on state', async () => {
    const graph = new WorkflowGraph({
      key: 'branching',
      nodes: {
        decide: async (state) => ({ score: state.input * 2 }),
        high_path: async () => ({ result: 'high' }),
        low_path: async () => ({ result: 'low' }),
      },
      edges: {
        decide: (state) => (state.score > 10 ? 'high_path' : 'low_path'),
        high_path: null, // terminal
        low_path: null,
      },
    });
    const store = createMemoryCheckpointStore();
    const high = await runWorkflow({ graph, initialState: { input: 7 }, store, tenantId: TENANT });
    expect(high.result).toBe('high');

    const low = await runWorkflow({ graph, initialState: { input: 2 }, store, tenantId: TENANT });
    expect(low.result).toBe('low');
  });
});

describe('runWorkflow — listPaused', () => {
  it('lists paused runs filtered by pause_reason', async () => {
    const store = createMemoryCheckpointStore();
    const graphA = new WorkflowGraph({
      key: 'a',
      nodes: { only: async () => pauseRun('await_governance') },
    });
    const graphB = new WorkflowGraph({
      key: 'b',
      nodes: { only: async () => pauseRun('await_payer') },
    });
    await runWorkflow({ graph: graphA, initialState: {}, store, tenantId: TENANT });
    await runWorkflow({ graph: graphB, initialState: {}, store, tenantId: TENANT });

    const allPaused = await store.listPaused({ tenantId: TENANT });
    expect(allPaused).toHaveLength(2);

    const governance = await store.listPaused({ tenantId: TENANT, pauseReason: 'await_governance' });
    expect(governance).toHaveLength(1);
    expect(governance[0].pause_reason).toBe('await_governance');
  });
});

describe('runWorkflow — node timeout', () => {
  it('aborts a runaway node with a clear error', async () => {
    const graph = new WorkflowGraph({
      key: 'timeout',
      nodes: {
        slow: async () => new Promise((resolve) => setTimeout(() => resolve({ never: true }), 200)),
      },
      timeoutMs: 50,
    });
    const store = createMemoryCheckpointStore();
    const outcome = await runWorkflow({ graph, initialState: {}, store, tenantId: TENANT });
    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/timed out/);
  });
});

describe('WorkflowGraph constructor validation', () => {
  it('rejects a graph without a key', () => {
    expect(() => new WorkflowGraph({ nodes: { a: async () => ({}) } })).toThrow(/requires a key/);
  });

  it('rejects a graph without nodes', () => {
    expect(() => new WorkflowGraph({ key: 'k' })).toThrow(/requires a nodes map/);
  });

  it('rejects a start node that is not defined', () => {
    expect(() => new WorkflowGraph({
      key: 'k',
      nodes: { a: async () => ({}) },
      start: 'missing',
    })).toThrow(/start node 'missing'/);
  });
});
