// Unit tests for subgraph composition in the workflow graph runner.
//
// These exercise the ctx.runSubgraph helper and the parent_run_id linkage
// added in migration 110. All against the in-memory checkpoint store
// (DB-backed has the same interface).
//
// Coverage:
//   * Subgraph completion → state delta merged at resultKey
//   * Subgraph linkage → child rows carry parent_run_id + parent_node;
//     listChildren() reflects the tree
//   * Idempotency → re-entering the same parent node (e.g. on resume)
//     finds the existing child and returns its result without spawning
//     a duplicate
//   * Subgraph pause → parent pauses with __subgraphs map persisted
//   * Resume cascade → resuming the parent re-enters the node; the
//     subgraph helper resumes the child; on child completion the
//     parent advances
//   * Subgraph failure → throws in the parent node, parent fails
//   * Two-level nesting (grandchild) — works recursively
//   * Workflow-key mismatch on idempotent re-entry → throws (catches a
//     class of bug where a parent node accidentally calls a different
//     subgraph after a code change)

import {
  WorkflowGraph,
  pauseRun,
  resumeWorkflow,
  runWorkflow,
} from '../../services/ai/workflowGraphRunner.js';
import { createMemoryCheckpointStore } from '../../services/ai/workflowCheckpointStore.js';

const TENANT = '00000000-0000-0000-0000-000000000001';

function leafGraph(behaviour) {
  return new WorkflowGraph({
    key: behaviour.key || 'leaf',
    nodes: {
      only: behaviour.node,
    },
  });
}

describe('runSubgraph — completion path', () => {
  it('merges the subgraph result into parent state at resultKey', async () => {
    const child = leafGraph({
      key: 'child_complete',
      node: async (state) => ({ result: { computed: state.input * 2 } }),
    });
    const parent = new WorkflowGraph({
      key: 'parent_complete',
      nodes: {
        a: async () => ({ a_done: true }),
        run_child: async (_state, ctx) => ctx.runSubgraph({
          graph: child,
          initialState: { input: 21 },
          resultKey: 'child_output',
        }),
        finish: async (state) => ({ result: { wrapped: state.child_output } }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('completed');
    expect(out.result).toEqual({ wrapped: { computed: 42 } });
  });

  it('writes parent_run_id and parent_node on the child run row', async () => {
    const child = leafGraph({
      key: 'child_link',
      node: async () => ({ result: 'ok' }),
    });
    const parent = new WorkflowGraph({
      key: 'parent_link',
      nodes: {
        run_child: async (_s, ctx) => ctx.runSubgraph({ graph: child, resultKey: 'cr' }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('completed');

    const children = await store.listChildren(out.runId);
    expect(children).toHaveLength(1);
    expect(children[0].parent_run_id).toBe(out.runId);
    expect(children[0].parent_node).toBe('run_child');
    expect(children[0].workflow_key).toBe('child_link');
    expect(children[0].status).toBe('completed');
  });

  it('records the child runId on parent.state.__subgraphs', async () => {
    const child = leafGraph({ key: 'c', node: async () => ({ result: 'r' }) });
    const parent = new WorkflowGraph({
      key: 'p',
      nodes: { run_child: async (_s, ctx) => ctx.runSubgraph({ graph: child, resultKey: 'cr' }) },
    });
    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });

    const run = await store.getRun(out.runId);
    expect(run.state.__subgraphs).toBeDefined();
    expect(run.state.__subgraphs.run_child).toBeGreaterThan(0);
  });
});

describe('runSubgraph — pause cascade', () => {
  it('parent pauses when subgraph pauses; __subgraphs is persisted', async () => {
    const child = leafGraph({
      key: 'paused_child',
      node: async () => pauseRun('await_governance'),
    });
    const parent = new WorkflowGraph({
      key: 'parent_pauses',
      nodes: {
        run_child: async (_s, ctx) => ctx.runSubgraph({ graph: child, resultKey: 'cr' }),
        finish: async () => ({ result: 'never' }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('paused');
    expect(out.pauseReason).toMatch(/^subgraph_paused:await_governance$/);
    expect(out.state.__subgraphs.run_child).toBeGreaterThan(0);

    // Child should be paused too, with parent linkage intact.
    const children = await store.listChildren(out.runId);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('paused');
  });

  it('resuming the parent re-enters the same node; the helper resumes the child; both complete', async () => {
    let childAttempts = 0;
    const childNode = async () => {
      childAttempts += 1;
      if (childAttempts === 1) return pauseRun('hold');
      return { result: { resolved: true } };
    };
    const child = new WorkflowGraph({
      key: 'cascade_child',
      nodes: { only: childNode },
    });
    const parent = new WorkflowGraph({
      key: 'cascade_parent',
      nodes: {
        run_child: async (_s, ctx) => ctx.runSubgraph({ graph: child, resultKey: 'cr' }),
        finish: async (state) => ({ result: state.cr }),
      },
    });

    const store = createMemoryCheckpointStore();
    const first = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(first.status).toBe('paused');

    // Resume the parent. The helper finds the existing child runId on
    // state.__subgraphs and resumes it; child returns the second time;
    // parent advances to finish.
    const resumed = await resumeWorkflow({ runId: first.runId, store, graph: parent });
    expect(resumed.status).toBe('completed');
    expect(resumed.result).toEqual({ resolved: true });
    expect(childAttempts).toBe(2);
  });
});

describe('runSubgraph — idempotent re-entry', () => {
  it('a completed child is not re-run if its parent_node is re-entered', async () => {
    let childRuns = 0;
    const child = leafGraph({
      key: 'idempotent_child',
      node: async () => { childRuns += 1; return { result: 'first' }; },
    });
    const parent = new WorkflowGraph({
      key: 'idempotent_parent',
      nodes: {
        run_child: async (_s, ctx) => ctx.runSubgraph({ graph: child, resultKey: 'cr' }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('completed');
    expect(childRuns).toBe(1);

    // Resume on a completed run is a no-op overall, but verifies we don't
    // re-spawn the child.
    const resumed = await resumeWorkflow({ runId: out.runId, store, graph: parent });
    expect(resumed.status).toBe('completed');
    expect(childRuns).toBe(1);
  });

  it('throws if the parent_node calls a DIFFERENT subgraph than the one stored', async () => {
    const childA = leafGraph({ key: 'child_a', node: async () => pauseRun('hold') });
    const childB = leafGraph({ key: 'child_b', node: async () => ({ result: 'b' }) });

    const parentA = new WorkflowGraph({
      key: 'mismatch_parent',
      nodes: { run_child: async (_s, ctx) => ctx.runSubgraph({ graph: childA, resultKey: 'cr' }) },
    });
    const parentB = new WorkflowGraph({
      key: 'mismatch_parent',
      nodes: { run_child: async (_s, ctx) => ctx.runSubgraph({ graph: childB, resultKey: 'cr' }) },
    });

    const store = createMemoryCheckpointStore();
    const first = await runWorkflow({ graph: parentA, initialState: {}, store, tenantId: TENANT });
    expect(first.status).toBe('paused');

    // Resume the same logical parent run, but the parent definition has
    // changed under us — childA is gone, childB is now wired in. The
    // helper detects the workflow_key mismatch and fails the run rather
    // than silently swapping.
    const resumed = await resumeWorkflow({ runId: first.runId, store, graph: parentB });
    expect(resumed.status).toBe('failed');
    expect(resumed.error.message).toMatch(/Subgraph mismatch at parent node 'run_child'/);
  });
});

describe('runSubgraph — failure', () => {
  it('a child failure throws in the parent node and the parent run fails', async () => {
    const child = leafGraph({
      key: 'failing_child',
      node: async () => { throw new Error('child boom'); },
    });
    const parent = new WorkflowGraph({
      key: 'parent_with_failing_child',
      nodes: {
        run_child: async (_s, ctx) => ctx.runSubgraph({ graph: child, resultKey: 'cr' }),
        finish: async () => ({ result: 'never' }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('failed');
    expect(out.error.node).toBe('run_child');
    expect(out.error.message).toMatch(/Subgraph failed at 'only': child boom/);

    const children = await store.listChildren(out.runId);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('failed');
  });

  it('a parent node CAN catch a subgraph failure and route around it', async () => {
    const child = leafGraph({
      key: 'flaky_child',
      node: async () => { throw new Error('try again'); },
    });
    const parent = new WorkflowGraph({
      key: 'parent_with_recovery',
      nodes: {
        try_child: async (_s, ctx) => {
          try {
            return await ctx.runSubgraph({ graph: child, resultKey: 'cr' });
          } catch {
            return { recovered: true };
          }
        },
        finish: async (state) => ({ result: { recovered: state.recovered === true } }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('completed');
    expect(out.result).toEqual({ recovered: true });
  });
});

describe('runSubgraph — two-level nesting', () => {
  it('grandchild completes; child completes; parent completes', async () => {
    const grandchild = leafGraph({
      key: 'grandchild',
      node: async (state) => ({ result: state.depth + 1 }),
    });
    const child = new WorkflowGraph({
      key: 'middle',
      nodes: {
        spawn_grandchild: async (_s, ctx) => ctx.runSubgraph({
          graph: grandchild,
          initialState: { depth: 1 },
          resultKey: 'gc',
        }),
        wrap: async (state) => ({ result: { from_grandchild: state.gc } }),
      },
    });
    const parent = new WorkflowGraph({
      key: 'top',
      nodes: {
        spawn_child: async (_s, ctx) => ctx.runSubgraph({
          graph: child,
          resultKey: 'c',
        }),
        wrap: async (state) => ({ result: { from_child: state.c } }),
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({ graph: parent, initialState: {}, store, tenantId: TENANT });
    expect(out.status).toBe('completed');
    expect(out.result).toEqual({ from_child: { from_grandchild: 2 } });

    // Tree shape: parent has 1 child; child has 1 grandchild.
    const children = await store.listChildren(out.runId);
    expect(children).toHaveLength(1);
    const grandchildren = await store.listChildren(children[0].id);
    expect(grandchildren).toHaveLength(1);
    expect(grandchildren[0].workflow_key).toBe('grandchild');
  });
});
