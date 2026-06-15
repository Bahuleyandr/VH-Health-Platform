// Unit tests for the prior_auth_appeal_chain workflow graph.
//
// Strategy:
//   * Tests use a partial/custom graph that stubs DB-touching nodes
//     (load_denied_prior_auth, draft_appeal) and exercises the real
//     NODES.classify_denial and NODES.await_human_disposition nodes.
//   * No DB connection required — memory checkpoint store only.
//   * The full integration path (real PA lookup, real appeal draft,
//     real event publish) is covered by the integration suite (Task 8).

import { __testing__ } from '../../services/ai/priorAuthAppealChainService.js';
import { WorkflowGraph, runWorkflow } from '../../services/ai/workflowGraphRunner.js';
import { createMemoryCheckpointStore } from '../../services/ai/workflowCheckpointStore.js';

const { NODES, WORKFLOW_KEY } = __testing__;

test('WORKFLOW_KEY is prior_auth_appeal_chain', () => {
  expect(WORKFLOW_KEY).toBe('prior_auth_appeal_chain');
});

test('runs draft then pauses awaiting human disposition', async () => {
  const graph = new WorkflowGraph({
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
  const store = createMemoryCheckpointStore();
  const out = await runWorkflow({ graph, initialState: { priorAuthId: 42 }, store, tenantId: 't1' });
  expect(out.status).toBe('paused');
  expect(out.pauseReason).toBe('await_appeal_human_disposition');
  expect(out.state.pendingDisposition.appeal_id).toBe(7);
});

test('classify_denial sets classification from denialReason', async () => {
  // Run classify_denial in isolation via a minimal graph.
  const graph = new WorkflowGraph({
    key: WORKFLOW_KEY,
    nodes: {
      setup: async () => ({
        denialReason: 'prior auth required but not obtained',
      }),
      classify_denial: NODES.classify_denial,
    },
    start: 'setup',
  });
  const store = createMemoryCheckpointStore();
  const out = await runWorkflow({ graph, initialState: {}, store, tenantId: 't1' });
  expect(out.status).toBe('completed');
  expect(out.state.classification).toBeDefined();
  expect(out.state.classification.classification).toBe('prior_auth_missing');
});

test('await_payer_response pauses with await_appeal_payer_response reason', async () => {
  const graph = new WorkflowGraph({
    key: WORKFLOW_KEY,
    nodes: {
      setup: async () => ({ appealId: 99 }),
      await_payer_response: NODES.await_payer_response,
    },
    start: 'setup',
  });
  const store = createMemoryCheckpointStore();
  const out = await runWorkflow({ graph, initialState: {}, store, tenantId: 't1' });
  expect(out.status).toBe('paused');
  expect(out.pauseReason).toBe('await_appeal_payer_response');
  expect(out.state.pendingPayerResponse.appeal_id).toBe(99);
});
