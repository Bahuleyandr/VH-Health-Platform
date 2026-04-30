/**
 * Framework-free workflow graph runner.
 *
 * The TauricResearch/TradingAgents analog of this file is the
 * LangGraph integration. We deliberately did NOT pull LangGraph (or
 * LangGraph.js) in because:
 *
 *   * The pattern is small enough (~ this file) to own end-to-end.
 *   * No Python sidecar in a Node monolith we've worked to keep coherent.
 *   * Persistence is already solved — Postgres + RLS — so a fresh SQLite
 *     checkpoint store is gratuitous.
 *
 * Mental model:
 *
 *   * A WorkflowGraph is a named map of nodes plus an edges map that
 *     describes how to walk from one node to the next.
 *   * Each node is `async (state, ctx) => stateUpdate | { __pause }`.
 *     stateUpdate is shallow-merged into the run's state. Returning
 *     undefined / null means "no state change".
 *   * Returning `{ __pause: '<reason>' }` parks the run. The runner
 *     persists the run as paused and returns; an external event handler
 *     calls `resumeWorkflow(runId)` to continue from the next node.
 *   * Returning `{ __halt: true, result }` ends the run early with a
 *     final result. Useful for early-exit nodes (e.g. critical safety
 *     flag detected; skip the rest).
 *   * `runWorkflow` is run-to-completion-or-pause. Crash-resume happens
 *     via `resumeWorkflow(runId)` which is idempotent — already-completed
 *     nodes are not re-run.
 *
 * Persistence is delegated to a `checkpointStore` interface. The
 * production store (workflowCheckpointStore.js) writes to the
 * clinical_ai_workflow_runs table. Tests inject a memory-backed store
 * so they don't need Postgres.
 *
 * Safety contract: same as everything else in the clinical AI services.
 * Nodes do their own work; the runner just sequences them. A node that
 * decides "this draft is unsafe to persist" is responsible for halting
 * the run with an appropriate result — the runner does not interpret
 * domain semantics.
 */

import logger from '../../logging/logger.js';

// Sentinel constants returned by node functions.
const PAUSE_KEY = '__pause';
const HALT_KEY = '__halt';

const NODE_TIMEOUT_MS = 60_000;

// ---------- Public API --------------------------------------------------

/**
 * Define a workflow graph.
 *
 *   nodes: { [name]: async (state, ctx) => stateUpdate | { __pause } | { __halt } }
 *   edges: { [name]: nextName | (state, ctx) => nextName | null }
 *           — null means "this is a terminal node, end the run"
 *   start: the first node name (defaults to 'start' if present, otherwise
 *           the first key in nodes)
 *   timeoutMs: per-node timeout (default 60s)
 */
export class WorkflowGraph {
  constructor({ key, nodes, edges = {}, start = null, timeoutMs = NODE_TIMEOUT_MS }) {
    if (!key) throw new Error('WorkflowGraph requires a key');
    if (!nodes || typeof nodes !== 'object') throw new Error('WorkflowGraph requires a nodes map');
    const nodeNames = Object.keys(nodes);
    if (!nodeNames.length) throw new Error('WorkflowGraph requires at least one node');

    this.key = key;
    this.nodes = { ...nodes };
    this.edges = { ...edges };
    this.start = start || (nodes.start ? 'start' : nodeNames[0]);
    this.timeoutMs = timeoutMs;

    if (!this.nodes[this.start]) {
      throw new Error(`WorkflowGraph start node '${this.start}' is not defined`);
    }
  }

  /** Resolve the next node from a finished node and the current state. */
  nextNodeAfter(currentNode, state, ctx) {
    const edge = this.edges[currentNode];
    if (edge === null) return null;
    if (typeof edge === 'function') return edge(state, ctx) ?? null;
    if (typeof edge === 'string') return edge;
    // No edge entry: walk through the keys list and pick the next one.
    const order = Object.keys(this.nodes);
    const idx = order.indexOf(currentNode);
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  }

  hasNode(name) {
    return Boolean(this.nodes[name]);
  }
}

/**
 * Start a fresh run of a workflow graph.
 *
 * Returns:
 *   { status: 'completed', runId, state, result }
 *   { status: 'paused', runId, state, pauseReason }
 *   { status: 'failed', runId, state, error: { node, message } }
 */
export async function runWorkflow({
  graph,
  initialState = {},
  ctx = {},
  store,
  tenantId,
  startedBy = null,
  workflowMetadata = {},
  parentRunId = null,
  parentNode = null,
} = {}) {
  if (!graph) throw new Error('runWorkflow requires a graph');
  if (!store) throw new Error('runWorkflow requires a checkpointStore');
  if (!tenantId) throw new Error('runWorkflow requires a tenantId');

  const run = await store.createRun({
    tenantId,
    workflowKey: graph.key,
    moduleKey: workflowMetadata.module_key || null,
    patientUid: workflowMetadata.patient_uid || null,
    admissionId: workflowMetadata.admission_id || null,
    state: initialState,
    metadata: workflowMetadata,
    startedBy,
    parentRunId,
    parentNode,
  });

  return walkFrom({ graph, run, store, ctx, fromNode: graph.start });
}

/**
 * Resume a paused or interrupted run. Idempotent: nodes that already
 * completed are not re-run. Returns the same shape as runWorkflow.
 */
export async function resumeWorkflow({ runId, store, graph, ctx = {} } = {}) {
  if (!runId) throw new Error('resumeWorkflow requires a runId');
  if (!store) throw new Error('resumeWorkflow requires a checkpointStore');
  if (!graph) throw new Error('resumeWorkflow requires a graph');

  const run = await store.getRun(runId);
  if (!run) throw new Error(`Workflow run ${runId} not found`);
  if (run.workflow_key !== graph.key) {
    throw new Error(`Workflow run ${runId} is for graph '${run.workflow_key}', not '${graph.key}'`);
  }
  if (run.status === 'completed') {
    return {
      status: 'completed',
      runId: run.id,
      state: run.state || {},
      result: run.result || null,
    };
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return {
      status: run.status,
      runId: run.id,
      state: run.state || {},
      error: run.error_message ? { node: run.error_node, message: run.error_message } : null,
    };
  }

  // Resume: pick up after current_node (which is the LAST node that
  // completed successfully). If current_node is null, start at graph.start.
  const next = run.current_node
    ? graph.nextNodeAfter(run.current_node, run.state || {}, ctx)
    : graph.start;
  if (!next) {
    // Edge case: paused at the terminal node. Mark complete and return.
    await store.markCompleted(run.id, run.state || {}, run.result || null);
    return {
      status: 'completed',
      runId: run.id,
      state: run.state || {},
      result: run.result || null,
    };
  }
  await store.markRunning(run.id);
  return walkFrom({ graph, run, store, ctx, fromNode: next });
}

// ---------- Internal walker ---------------------------------------------

async function walkFrom({ graph, run, store, ctx, fromNode }) {
  let state = run.state || {};
  let nodeName = fromNode;
  let result = run.result || null;

  while (nodeName) {
    if (!graph.hasNode(nodeName)) {
      const message = `Workflow ${graph.key} run ${run.id}: node '${nodeName}' is not defined`;
      logger.error(message);
      await store.markFailed(run.id, state, { node: nodeName, message });
      return { status: 'failed', runId: run.id, state, error: { node: nodeName, message } };
    }

    const node = graph.nodes[nodeName];
    const startedAt = Date.now();
    // Build the per-node ctx — adds runSubgraph plus reflective fields
    // (currentNode, runId, tenantId). The subgraph helper is rebuilt per
    // node so it always closes over the live state and the correct parent
    // node identity.
    const nodeCtx = {
      ...ctx,
      currentNode: nodeName,
      runId: run.id,
      tenantId: run.tenant_id,
      runSubgraph: makeRunSubgraph({ store, parentRun: run, currentNode: nodeName, getParentState: () => state }),
    };
    let nodeOutput;
    try {
      nodeOutput = await runNodeWithTimeout(node, state, nodeCtx, graph.timeoutMs);
    } catch (err) {
      const message = String(err?.message || err);
      logger.warn('Workflow node failed', { workflowKey: graph.key, runId: run.id, node: nodeName, error: message });
      await store.recordCheckpoint(run.id, {
        node: nodeName,
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        status: 'failed',
        error: message.slice(0, 500),
      });
      await store.markFailed(run.id, state, { node: nodeName, message });
      return { status: 'failed', runId: run.id, state, error: { node: nodeName, message } };
    }

    // Pause sentinel: persist + return without advancing current_node.
    // (current_node tracks COMPLETED nodes; a paused node has not
    // completed.) The pause sentinel can carry a state delta — used by
    // ctx.runSubgraph to capture a child run's id before parking, so a
    // later parent-resume can rediscover and continue the child.
    if (nodeOutput && nodeOutput[PAUSE_KEY] !== undefined) {
      const reason = String(nodeOutput[PAUSE_KEY] || 'paused').slice(0, 120);
      if (nodeOutput.state && typeof nodeOutput.state === 'object') {
        state = { ...state, ...nodeOutput.state };
      }
      await store.recordCheckpoint(run.id, {
        node: nodeName,
        started_at: new Date(startedAt).toISOString(),
        paused_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        status: 'paused',
        reason,
      });
      await store.markPaused(run.id, state, { reason, pausedAtNode: nodeName });
      return { status: 'paused', runId: run.id, state, pauseReason: reason, pausedAtNode: nodeName };
    }

    // Halt sentinel: end the run early with the supplied result.
    if (nodeOutput && nodeOutput[HALT_KEY]) {
      const haltResult = nodeOutput.result ?? result;
      const stateUpdate = nodeOutput.state || nodeOutput.stateUpdate || null;
      if (stateUpdate && typeof stateUpdate === 'object') {
        state = { ...state, ...stateUpdate };
      }
      await store.recordCheckpoint(run.id, {
        node: nodeName,
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        status: 'halted',
      });
      await store.markCompleted(run.id, state, haltResult, { lastNode: nodeName });
      return { status: 'completed', runId: run.id, state, result: haltResult, halted: true };
    }

    // Normal completion: shallow-merge state delta and advance.
    if (nodeOutput && typeof nodeOutput === 'object') {
      state = { ...state, ...nodeOutput };
    }
    await store.recordCheckpoint(run.id, {
      node: nodeName,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      status: 'completed',
    });
    await store.advance(run.id, state, nodeName);

    nodeName = graph.nextNodeAfter(nodeName, state, ctx);
  }

  // Terminal: pull the final result from state.result if present (most
  // workflows assemble it in a final "build_response" node), otherwise
  // hand back the state itself.
  result = state.result !== undefined ? state.result : state;
  await store.markCompleted(run.id, state, result);
  return { status: 'completed', runId: run.id, state, result };
}

// ---------- Subgraph helper --------------------------------------------

/**
 * Build a runSubgraph helper bound to a specific parent run + parent node.
 * Each node call gets a fresh helper closing over the live parent state.
 *
 * Idempotency contract: parent state has a reserved `__subgraphs` key
 * (object map of parent_node_name -> child_run_id). When a node calls
 * runSubgraph and a child for this parent_node already exists in
 * __subgraphs, the existing child is consulted rather than starting a
 * new one. This is what makes parent-resume safe: re-entering the same
 * parent node finds the same child and continues it instead of spawning
 * a duplicate.
 *
 * Behaviour by child status on idempotent re-entry:
 *   * completed → return { [resultKey]: child.result } as a state delta
 *   * paused    → resume the child; if it completes, return the result;
 *                 if it pauses again, return pauseRun (parent re-pauses)
 *   * failed    → throw (parent fails at this node; caller can catch in
 *                 the parent node if it wants graceful handling)
 *   * running   → also resume (defensive — single-process orchestration
 *                 means we shouldn't normally see this)
 *
 * Convention: one subgraph per parent node. If a node calls runSubgraph
 * twice in the same parent run, the second call returns the same child
 * result (or fails on a different graph key). Multiple parallel children
 * per parent node would relax this convention but is a future extension.
 */
function makeRunSubgraph({ store, parentRun, currentNode, getParentState }) {
  return async function runSubgraph({
    graph,
    initialState = {},
    resultKey = null,
    metadata = {},
  } = {}) {
    if (!graph) throw new Error('runSubgraph requires a graph');

    const parentState = getParentState() || {};
    const subgraphs = parentState.__subgraphs || {};
    const existingRunId = subgraphs[currentNode];

    if (existingRunId) {
      const existing = await store.getRun(existingRunId);
      if (!existing) {
        // Stale id — the row vanished. Treat as fresh start.
        logger.warn('Subgraph child runId stored on parent state was not found; restarting', {
          parentRunId: parentRun.id,
          parentNode: currentNode,
          missingRunId: existingRunId,
        });
      } else if (existing.workflow_key !== graph.key) {
        throw new Error(
          `Subgraph mismatch at parent node '${currentNode}': stored child is graph '${existing.workflow_key}' but caller passed '${graph.key}'`
        );
      } else if (existing.status === 'completed') {
        return resultKey ? { [resultKey]: existing.result } : {};
      } else if (existing.status === 'failed') {
        throw new Error(`Subgraph previously failed at '${existing.error_node}': ${existing.error_message || 'unknown'}`);
      } else if (existing.status === 'paused' || existing.status === 'running') {
        const out = await resumeWorkflow({ runId: existingRunId, store, graph });
        return reactToSubgraphOutcome({ out, resultKey, subgraphs });
      }
    }

    // Fresh start.
    const out = await runWorkflow({
      graph,
      initialState,
      store,
      tenantId: parentRun.tenant_id,
      startedBy: parentRun.started_by,
      parentRunId: parentRun.id,
      parentNode: currentNode,
      workflowMetadata: { ...metadata, parent_run_id: parentRun.id, parent_node: currentNode },
    });
    const newSubgraphs = { ...subgraphs, [currentNode]: out.runId };
    return reactToSubgraphOutcome({ out, resultKey, subgraphs: newSubgraphs });
  };
}

function reactToSubgraphOutcome({ out, resultKey, subgraphs }) {
  if (out.status === 'completed') {
    const delta = { __subgraphs: subgraphs };
    if (resultKey) delta[resultKey] = out.result;
    return delta;
  }
  if (out.status === 'paused') {
    // Persist the child id on parent state at pause time so a later
    // parent-resume rediscovers and continues this exact child.
    return pauseRun(`subgraph_paused:${out.pauseReason}`, { __subgraphs: subgraphs });
  }
  if (out.status === 'failed') {
    throw new Error(`Subgraph failed at '${out.error?.node}': ${out.error?.message}`);
  }
  throw new Error(`Subgraph returned unknown status '${out.status}'`);
}

async function runNodeWithTimeout(node, state, ctx, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return node(state, ctx);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Workflow node timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => node(state, ctx)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- Sentinel helpers (re-exported for nodes) -------------------

/**
 * Return from a node to park the run; an external trigger resumes it.
 *
 * Optionally carries a state delta. The runner merges the delta into
 * persistent state BEFORE marking the run paused — this is how
 * ctx.runSubgraph captures a child run's id on the parent state at the
 * moment it pauses, so a later parent-resume can rediscover the child.
 */
export function pauseRun(reason, stateUpdate = null) {
  const out = { [PAUSE_KEY]: String(reason || 'paused') };
  if (stateUpdate && typeof stateUpdate === 'object') {
    out.state = stateUpdate;
  }
  return out;
}

/** Return from a node to end the run early with a final result. */
export function haltRun(result, stateUpdate = null) {
  return { [HALT_KEY]: true, result, state: stateUpdate };
}

export const SENTINELS = { PAUSE_KEY, HALT_KEY };

export default {
  WorkflowGraph,
  runWorkflow,
  resumeWorkflow,
  pauseRun,
  haltRun,
};
