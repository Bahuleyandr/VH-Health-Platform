// Unit test for the discharge-compose degrade-and-skip behaviour (C1).
//
// When a requested compose child module is DISABLED for the tenant (e.g. the
// patient-facing aftercare-instructions module, OFF by policy),
// requireEnabledModule throws AppError.forbidden (403). The compose graph must
// NOT fail the whole discharge package over a disabled child — it should skip
// it and compose what IS enabled, recording the skip. If EVERY child is
// disabled it should fail clearly.
//
// We mock clinicalAiWorkflowService so precheck_children's requireEnabledModule
// call is controllable without a DB, and run an orchestration-only graph (no
// persist/publish), mirroring dischargeComposeService.test.js.

import { jest } from '@jest/globals';

const CHILDREN = [
  'medication_reconciliation',
  'patient_aftercare_instructions',
  'discharge_readiness',
  'clinical_coding_assist',
];

const forbidden = (msg) => {
  const err = new Error(msg);
  err.statusCode = 403; // shape of AppError.forbidden
  return err;
};

const requireEnabledModule = jest.fn(async (key) => {
  if (key === 'patient_aftercare_instructions') {
    throw forbidden('Clinical AI module is disabled: Patient Aftercare Instructions');
  }
  return { module_key: key, enabled: true, settings: {} };
});

jest.unstable_mockModule('../../services/ai/clinicalAiWorkflowService.js', () => ({
  ADMISSION_MODULES: new Set(CHILDREN),
  getAdmissionAiDraftGraph: jest.fn(),
  resolveTenantId: jest.fn((t) => t),
  requireEnabledModule,
}));

const { WorkflowGraph, runWorkflow } = await import('../../services/ai/workflowGraphRunner.js');
const { createMemoryCheckpointStore } = await import('../../services/ai/workflowCheckpointStore.js');
const { __testing__ } = await import('../../services/ai/dischargeComposeService.js');

const { COMPOSE_GRAPH_NODES, DEFAULT_COMPOSE_CHILDREN } = __testing__;
const TENANT = '00000000-0000-0000-0000-000000000001';

function makeStubAdmissionGraph() {
  return new WorkflowGraph({
    key: 'admission_ai_draft',
    nodes: {
      synthesize: async (state) => ({
        result: {
          draft: { for: state.moduleKey },
          module_key: state.moduleKey,
          safety_flags: [],
          draft_generation_id: 900,
          review_id: 1,
          review_status: 'pending',
        },
      }),
    },
  });
}

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
      finalize_for_test: async (state) => ({ result: state.composeDraft }),
    },
  });
}

function runCompose(store) {
  return runWorkflow({
    graph: makeOrchestrationOnlyComposeGraph(),
    initialState: {
      admissionId: 4242,
      requestedBy: null,
      requestContext: {},
      tenantId: TENANT,
      composeChildren: DEFAULT_COMPOSE_CHILDREN,
      // NB: NO childModules injected → precheck_children calls the mocked
      // requireEnabledModule, exercising the disabled-child path.
    },
    ctx: { admissionGraph: makeStubAdmissionGraph() },
    store,
    tenantId: TENANT,
  });
}

describe('discharge compose — degrade when a child module is disabled (C1)', () => {
  beforeEach(() => {
    requireEnabledModule.mockClear();
    requireEnabledModule.mockImplementation(async (key) => {
      if (key === 'patient_aftercare_instructions') {
        throw forbidden('Clinical AI module is disabled: Patient Aftercare Instructions');
      }
      return { module_key: key, enabled: true, settings: {} };
    });
  });

  it('skips the disabled child and composes the rest', async () => {
    const out = await runCompose(createMemoryCheckpointStore());

    expect(out.status).toBe('completed');
    expect(out.result.skipped_children).toEqual(['patient_aftercare_instructions']);
    expect(out.result.compose_children).toEqual([
      'medication_reconciliation',
      'discharge_readiness',
      'clinical_coding_assist',
    ]);
    expect(Object.keys(out.result.components)).not.toContain('patient_aftercare_instructions');
    expect(Object.keys(out.result.components)).toEqual([
      'medication_reconciliation',
      'discharge_readiness',
      'clinical_coding_assist',
    ]);
  });

  it('rethrows non-403 errors (does not swallow real failures)', async () => {
    requireEnabledModule.mockImplementation(async () => {
      const err = new Error('schema exploded');
      err.statusCode = 500;
      throw err;
    });
    const out = await runCompose(createMemoryCheckpointStore());
    expect(out.status).toBe('failed');
    expect(out.error.node).toBe('precheck_children');
    expect(out.error.message).toMatch(/schema exploded/);
  });

  it('fails clearly when every requested child is disabled', async () => {
    requireEnabledModule.mockImplementation(async () => {
      throw forbidden('Clinical AI module is disabled');
    });
    const out = await runCompose(createMemoryCheckpointStore());
    expect(out.status).toBe('failed');
    expect(out.error.node).toBe('precheck_children');
    expect(out.error.message).toMatch(/No enabled compose child modules/);
  });
});
