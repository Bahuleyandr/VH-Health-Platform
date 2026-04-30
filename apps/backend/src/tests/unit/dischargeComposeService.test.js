// Unit tests for the discharge compose meta-workflow.
//
// Strategy:
//   * Pure-function helpers (bandFromSafetyFlags, highestBand) are
//     tested directly.
//   * The orchestration nodes (precheck_children, spawn_*, assemble_*)
//     are tested by composing a TEST graph that includes them but stops
//     before persist_compose_generation / publish_compose_event so we
//     don't have to mock prisma + the event outbox in this suite.
//   * The admission_ai_draft graph is replaced with a synthetic stub
//     that produces deterministic child drafts. This validates that
//     compose correctly routes per-child results through resultKey,
//     skips disabled children, and rolls up safety bands.
//
// The full integration path (real children, real persistence, real
// publishEvent) is covered by the existing clinical AI integration
// suite that runs against Postgres in CI — out of scope for unit tests.

import {
  WorkflowGraph,
  runWorkflow,
  resumeWorkflow,
  pauseRun,
} from '../../services/ai/workflowGraphRunner.js';
import { createMemoryCheckpointStore } from '../../services/ai/workflowCheckpointStore.js';
import { __testing__ } from '../../services/ai/dischargeComposeService.js';

const { COMPOSE_GRAPH_NODES, RESULT_KEYS, DEFAULT_COMPOSE_CHILDREN, bandFromSafetyFlags, highestBand } = __testing__;

const TENANT = '00000000-0000-0000-0000-000000000001';
const ADMISSION_ID = 4242;

// ---------- Pure-function tests ----------------------------------------

describe('bandFromSafetyFlags', () => {
  it('returns "ok" for empty / non-array input', () => {
    expect(bandFromSafetyFlags(undefined)).toBe('ok');
    expect(bandFromSafetyFlags([])).toBe('ok');
    expect(bandFromSafetyFlags(null)).toBe('ok');
  });

  it('escalates to the highest severity present', () => {
    expect(bandFromSafetyFlags([{ severity: 'low' }, { severity: 'critical' }])).toBe('critical');
    expect(bandFromSafetyFlags([{ severity: 'medium' }, { severity: 'high' }])).toBe('high');
    expect(bandFromSafetyFlags([{ severity: 'low' }])).toBe('low');
  });

  it('is case-insensitive on severity', () => {
    expect(bandFromSafetyFlags([{ severity: 'CRITICAL' }])).toBe('critical');
    expect(bandFromSafetyFlags([{ severity: 'High' }])).toBe('high');
  });

  it('treats unknown severities as no-op', () => {
    expect(bandFromSafetyFlags([{ severity: 'whatever' }])).toBe('ok');
  });
});

describe('highestBand', () => {
  it('picks the most-restrictive band from a set', () => {
    expect(highestBand(['ok', 'low', 'high', 'medium'])).toBe('high');
    expect(highestBand(['ok'])).toBe('ok');
    expect(highestBand(['critical', 'ok'])).toBe('critical');
  });

  it('returns "ok" for empty input', () => {
    expect(highestBand([])).toBe('ok');
  });
});

// ---------- Orchestration tests ---------------------------------------

/**
 * Build a synthetic admission_ai_draft graph that produces a
 * deterministic per-module draft. Lets compose tests run end-to-end
 * without touching Postgres, the LLM, or any real downstream services.
 *
 * The shape here matches the real admission_ai_draft graph's final
 * state.result (i.e. what standardDraftResponse returns): { draft,
 * module_key, safety_flags, draft_generation_id, review_id, review_status }.
 */
function makeStubAdmissionGraph(syntheticByModule) {
  return new WorkflowGraph({
    key: 'admission_ai_draft', // must match real graph's key for parent_run linkage to look right
    nodes: {
      synthesize: async (state) => {
        const synth = syntheticByModule[state.moduleKey] || { draft: { stub: true }, safety_flags: [] };
        return {
          result: {
            draft: synth.draft,
            module_key: state.moduleKey,
            safety_flags: synth.safety_flags || [],
            draft_generation_id: synth.draft_generation_id || 999,
            review_id: synth.review_id || 1000,
            review_status: synth.review_status || 'pending',
          },
        };
      },
    },
  });
}

/**
 * Build a compose graph that stops at assemble_compose_result, returning
 * the assembled state.composeDraft as the result. Lets us inspect
 * orchestration without persist/publish DB calls.
 */
function makeOrchestrationOnlyComposeGraph() {
  return new WorkflowGraph({
    key: 'discharge_summary_compose',
    nodes: {
      precheck_children: COMPOSE_GRAPH_NODES.precheck_children,
      spawn_med_rec: COMPOSE_GRAPH_NODES.spawn_med_rec,
      spawn_aftercare: COMPOSE_GRAPH_NODES.spawn_aftercare,
      spawn_readiness: COMPOSE_GRAPH_NODES.spawn_readiness,
      spawn_coding: COMPOSE_GRAPH_NODES.spawn_coding,
      assemble_compose_result: COMPOSE_GRAPH_NODES.assemble_compose_result,
      // Terminal node — pull composeDraft into result and end.
      finalize_for_test: async (state) => ({ result: state.composeDraft }),
    },
  });
}

const childModulesStub = Object.fromEntries(
  DEFAULT_COMPOSE_CHILDREN.map((key) => [key, { module_key: key, enabled: true, settings: {} }])
);

describe('compose orchestration — happy path with all four children', () => {
  it('spawns each child and rolls up the assembled draft', async () => {
    const stubAdmissionGraph = makeStubAdmissionGraph({
      medication_reconciliation: {
        draft: { continue: ['amlodipine'], stop: [] },
        safety_flags: [{ severity: 'low', code: 'PENDING_INVESTIGATIONS', message: 'pending' }],
        draft_generation_id: 100,
      },
      patient_aftercare_instructions: {
        draft: { plain_language_summary: 'Rest, follow up in 1 week' },
        safety_flags: [],
        draft_generation_id: 101,
      },
      discharge_readiness: {
        draft: { ready: true, blockers: [] },
        safety_flags: [],
        draft_generation_id: 102,
      },
      clinical_coding_assist: {
        draft: { suggested_codes: [{ code: 'I10', description: 'Hypertension' }] },
        safety_flags: [{ severity: 'medium', code: 'NEEDS_CODER_REVIEW' }],
        draft_generation_id: 103,
      },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({
      graph: makeOrchestrationOnlyComposeGraph(),
      initialState: {
        admissionId: ADMISSION_ID,
        requestedBy: '00000000-0000-0000-0000-000000000aaa',
        requestContext: { request_id: 'req-1', tenant_region: 'IN' },
        tenantId: TENANT,
        composeChildren: DEFAULT_COMPOSE_CHILDREN,
        childModules: childModulesStub,
      },
      ctx: { admissionGraph: stubAdmissionGraph },
      store,
      tenantId: TENANT,
    });

    expect(out.status).toBe('completed');
    expect(out.result.admission_id).toBe(ADMISSION_ID);
    expect(out.result.compose_children).toEqual(DEFAULT_COMPOSE_CHILDREN);
    expect(Object.keys(out.result.components)).toEqual(DEFAULT_COMPOSE_CHILDREN);
    expect(out.result.child_generation_ids).toEqual([100, 101, 102, 103]);
    // Highest of [low, ok, ok, medium] is medium
    expect(out.result.overall_safety_band).toBe('medium');
  });

  it('records four children under the parent run via parent_run_id linkage', async () => {
    const stubAdmissionGraph = makeStubAdmissionGraph(Object.fromEntries(
      DEFAULT_COMPOSE_CHILDREN.map((k, i) => [k, { draft: {}, draft_generation_id: 200 + i }])
    ));
    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({
      graph: makeOrchestrationOnlyComposeGraph(),
      initialState: {
        admissionId: ADMISSION_ID,
        requestedBy: null,
        requestContext: {},
        tenantId: TENANT,
        composeChildren: DEFAULT_COMPOSE_CHILDREN,
        childModules: childModulesStub,
      },
      ctx: { admissionGraph: stubAdmissionGraph },
      store,
      tenantId: TENANT,
    });

    const children = await store.listChildren(out.runId);
    expect(children).toHaveLength(4);
    const childParentNodes = children.map((c) => c.parent_node);
    expect(childParentNodes).toEqual(
      expect.arrayContaining(['spawn_med_rec', 'spawn_aftercare', 'spawn_readiness', 'spawn_coding'])
    );
  });
});

describe('compose orchestration — toggling children off', () => {
  it('skips spawn nodes for modules not on activeChildren', async () => {
    const stubAdmissionGraph = makeStubAdmissionGraph({
      medication_reconciliation: { draft: { ok: true }, draft_generation_id: 300 },
      patient_aftercare_instructions: { draft: { ok: true }, draft_generation_id: 301 },
    });
    const store = createMemoryCheckpointStore();

    const out = await runWorkflow({
      graph: makeOrchestrationOnlyComposeGraph(),
      initialState: {
        admissionId: ADMISSION_ID,
        requestedBy: null,
        requestContext: {},
        tenantId: TENANT,
        composeChildren: ['medication_reconciliation', 'patient_aftercare_instructions'], // only two
        childModules: {
          medication_reconciliation: childModulesStub.medication_reconciliation,
          patient_aftercare_instructions: childModulesStub.patient_aftercare_instructions,
        },
      },
      ctx: { admissionGraph: stubAdmissionGraph },
      store,
      tenantId: TENANT,
    });

    expect(out.status).toBe('completed');
    expect(out.result.compose_children).toEqual(['medication_reconciliation', 'patient_aftercare_instructions']);
    expect(Object.keys(out.result.components)).toEqual(['medication_reconciliation', 'patient_aftercare_instructions']);
    expect(out.result.child_generation_ids).toEqual([300, 301]);

    // Only two children created.
    const children = await store.listChildren(out.runId);
    expect(children).toHaveLength(2);
  });
});

describe('compose orchestration — pause cascade from a child', () => {
  it('pauses the parent when a child pauses, and resume picks up correctly', async () => {
    let aftercareAttempts = 0;
    const stubAdmissionGraph = new WorkflowGraph({
      key: 'admission_ai_draft',
      nodes: {
        synthesize: async (state) => {
          if (state.moduleKey === 'patient_aftercare_instructions') {
            aftercareAttempts += 1;
            if (aftercareAttempts === 1) return pauseRun('await_aftercare_signoff');
          }
          return {
            result: {
              draft: { for: state.moduleKey },
              module_key: state.moduleKey,
              safety_flags: [],
              draft_generation_id: 500 + aftercareAttempts,
              review_id: 600,
              review_status: 'pending',
            },
          };
        },
      },
    });

    const store = createMemoryCheckpointStore();
    const composeGraph = makeOrchestrationOnlyComposeGraph();
    const initialState = {
      admissionId: ADMISSION_ID,
      requestedBy: null,
      requestContext: {},
      tenantId: TENANT,
      composeChildren: DEFAULT_COMPOSE_CHILDREN,
      childModules: childModulesStub,
    };
    // Pass admissionGraph via ctx (non-persisted) — class instances and
    // functions don't survive the JSONB round-trip that state takes on
    // every node transition.
    const ctx = { admissionGraph: stubAdmissionGraph };

    const first = await runWorkflow({ graph: composeGraph, initialState, ctx, store, tenantId: TENANT });
    expect(first.status).toBe('paused');
    expect(first.pauseReason).toMatch(/^subgraph_paused:await_aftercare_signoff$/);
    expect(first.pausedAtNode).toBe('spawn_aftercare');

    // Resume — child runs to completion the second time, parent
    // continues through readiness, coding, assemble. ctx must be passed
    // again because it isn't persisted with the run row.
    const resumed = await resumeWorkflow({ runId: first.runId, store, graph: composeGraph, ctx });
    expect(resumed.status).toBe('completed');
    expect(resumed.result.compose_children).toEqual(DEFAULT_COMPOSE_CHILDREN);
    // Aftercare ran twice (paused once, resumed once); the others ran once.
    expect(aftercareAttempts).toBe(2);
  });
});

describe('compose orchestration — critical safety band bubbles up', () => {
  it('overall_safety_band reflects the highest child severity', async () => {
    const stubAdmissionGraph = makeStubAdmissionGraph({
      medication_reconciliation: {
        draft: {},
        safety_flags: [{ severity: 'critical', code: 'ALLERGY_MEDICATION_MATCH' }],
        draft_generation_id: 700,
      },
      patient_aftercare_instructions: { draft: {}, draft_generation_id: 701 },
      discharge_readiness: { draft: {}, draft_generation_id: 702 },
      clinical_coding_assist: { draft: {}, draft_generation_id: 703 },
    });

    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({
      graph: makeOrchestrationOnlyComposeGraph(),
      initialState: {
        admissionId: ADMISSION_ID,
        requestedBy: null,
        requestContext: {},
        tenantId: TENANT,
        composeChildren: DEFAULT_COMPOSE_CHILDREN,
        childModules: childModulesStub,
      },
      ctx: { admissionGraph: stubAdmissionGraph },
      store,
      tenantId: TENANT,
    });

    expect(out.result.overall_safety_band).toBe('critical');
    expect(out.result.critical_safety_flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ALLERGY_MEDICATION_MATCH' })])
    );
  });
});

describe('compose orchestration — precheck rejects unsupported modules', () => {
  it('throws on unsupported child module keys', async () => {
    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({
      graph: makeOrchestrationOnlyComposeGraph(),
      initialState: {
        admissionId: ADMISSION_ID,
        requestedBy: null,
        requestContext: {},
        tenantId: TENANT,
        composeChildren: ['medication_reconciliation', 'fictitious_module'],
        childModules: {
          medication_reconciliation: childModulesStub.medication_reconciliation,
          fictitious_module: { module_key: 'fictitious_module', enabled: true, settings: {} },
        },
      },
      ctx: { admissionGraph: makeStubAdmissionGraph({}) },
      store,
      tenantId: TENANT,
    });

    expect(out.status).toBe('failed');
    expect(out.error.node).toBe('precheck_children');
    expect(out.error.message).toMatch(/Unsupported compose child module\(s\): fictitious_module/);
  });
});

describe('compose orchestration — child failure propagates', () => {
  it('parent fails when a child throws', async () => {
    const stubAdmissionGraph = new WorkflowGraph({
      key: 'admission_ai_draft',
      nodes: {
        synthesize: async (state) => {
          if (state.moduleKey === 'discharge_readiness') {
            throw new Error('readiness boom');
          }
          return {
            result: {
              draft: {},
              module_key: state.moduleKey,
              safety_flags: [],
              draft_generation_id: 800,
            },
          };
        },
      },
    });
    const store = createMemoryCheckpointStore();
    const out = await runWorkflow({
      graph: makeOrchestrationOnlyComposeGraph(),
      initialState: {
        admissionId: ADMISSION_ID,
        requestedBy: null,
        requestContext: {},
        tenantId: TENANT,
        composeChildren: DEFAULT_COMPOSE_CHILDREN,
        childModules: childModulesStub,
      },
      ctx: { admissionGraph: stubAdmissionGraph },
      store,
      tenantId: TENANT,
    });

    expect(out.status).toBe('failed');
    expect(out.error.node).toBe('spawn_readiness');
    expect(out.error.message).toMatch(/Subgraph failed.*readiness boom/);
  });
});

describe('RESULT_KEYS contract', () => {
  it('declares a stable resultKey for every supported child', () => {
    for (const childKey of DEFAULT_COMPOSE_CHILDREN) {
      expect(RESULT_KEYS[childKey]).toBeTruthy();
      expect(typeof RESULT_KEYS[childKey]).toBe('string');
    }
  });
});
