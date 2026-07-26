import { jest } from '@jest/globals';

const completeRegisteredCondition = jest.fn();
const executePathwayCommand = jest.fn();
const startCarePathwayInstance = jest.fn();

jest.unstable_mockModule('../../services/pathways/pathwayExecutorService.js', () => ({
  completePathwayTaskAndExecuteFromRegisteredCondition: completeRegisteredCondition,
  executePathwayCommand,
  startCarePathwayInstance,
}));

const {
  OP_CONTACT_TO_RECOVERY_DEFINITION,
} = await import('../../services/pathways/opPathwayDefinition.js');
const {
  OP_PATHWAY_RUNTIME_HANDLERS,
} = await import('../../services/pathways/opPathwayHandlers.js');
const {
  completeOpRecoveryTaskFromClosureEvidence,
  __testing__,
} = await import('../../services/pathways/opPathwayProjector.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '20000000-0000-4000-8000-000000000001';
const CLOSURE_ID = '30000000-0000-4000-8000-000000000001';
const TIMELINE_ID = '40000000-0000-4000-8000-000000000001';
const AUDIT_ID = '50000000-0000-4000-8000-000000000001';
const APPOINTMENT_ID = 41;

function recoveryExecution(overrides = {}) {
  return {
    instance: {
      id: PATHWAY_ID,
      run: {
        id: 19,
        current_step_key: 'recover_unattended_visit',
      },
      steps: [{
        id: 71,
        workflow_run_id: 19,
        step_key: 'recover_unattended_visit',
        step_kind: 'task',
      }],
      tasks: [{
        id: 94,
        workflow_run_id: 19,
        workflow_step_id: 71,
        status: 'open',
        sla_completion_semantics: 'none',
        workflow_sla_instance_id: null,
        related_resource_type: 'care_pathway_instance',
        related_resource_id: PATHWAY_ID,
      }],
      ...overrides,
    },
    events: [],
    replayed: false,
    mode: 'active',
  };
}

function closureAppointment(overrides = {}) {
  return {
    id: APPOINTMENT_ID,
    status: 'NO_SHOW',
    closure_evidence_id: CLOSURE_ID,
    closure_evidence_revision: 2,
    source_status_history_id: 91,
    closure_timeline_event_id: TIMELINE_ID,
    closure_audit_event_id: AUDIT_ID,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('keeps recovery human work SLA-none and requires the registered OP condition', () => {
  const step = OP_CONTACT_TO_RECOVERY_DEFINITION.steps.find(
    candidate => candidate.step_key === 'recover_unattended_visit',
  );
  expect(step).toMatchObject({
    step_kind: 'task',
    condition_handler: 'op.recovery_action.v1',
    work_semantics: {
      sla_completion_semantics: 'none',
    },
  });
  expect(step.work_semantics).not.toHaveProperty('sla_rule_code');
});

test.each(['CANCELLED', 'NO_SHOW', 'RESCHEDULED'])(
  'requires canonical closure evidence before satisfying %s recovery',
  async (appointmentStatus) => {
    await expect(OP_PATHWAY_RUNTIME_HANDLERS.recoveryAction.evaluate({
      loadedEvidence: {
        appointment_status: appointmentStatus,
        closure_evidence_valid: false,
      },
    })).resolves.toMatchObject({ decision: 'blocked' });
    await expect(OP_PATHWAY_RUNTIME_HANDLERS.recoveryAction.evaluate({
      loadedEvidence: {
        appointment_status: appointmentStatus,
        closure_evidence_valid: true,
      },
    })).resolves.toMatchObject({ decision: 'satisfied' });
  },
);

test('completes the exact current no-SLA recovery task from canonical closure evidence', async () => {
  const observed = recoveryExecution();
  const completed = {
    ...observed,
    instance: {
      ...observed.instance,
      clinical_status: 'completed',
    },
  };
  completeRegisteredCondition.mockResolvedValue(completed);
  const actor = Object.freeze({ kind: 'system', systemKey: 'op.pathway_projector.v1' });
  const registry = Object.freeze({ version: 4 });
  const activationEvidenceCapability = Object.freeze({ kind: 'activation' });
  const tx = Object.freeze({ kind: 'tenant_tx' });
  const signal = Object.freeze({
    kind: 'appointment_closure_evidence_recorded',
    payload: Object.freeze({ appointment_id: APPOINTMENT_ID }),
  });

  await expect(completeOpRecoveryTaskFromClosureEvidence({
    tenantId: TENANT_ID,
    appointment: closureAppointment(),
    event: {
      id: '301',
      event_type: 'appointment.closure_evidence_recorded',
    },
    execution: observed,
    actor,
    registry,
    signal,
    activationEvidenceCapability,
    tx,
  })).resolves.toBe(completed);

  expect(completeRegisteredCondition).toHaveBeenCalledWith({
    tenantId: TENANT_ID,
    pathwayInstanceId: PATHWAY_ID,
    taskId: 94,
    workflowRunId: 19,
    workflowStepId: 71,
    conditionHandler: 'op.recovery_action.v1',
    evidenceResourceType: 'op_visit_closure_evidence',
    evidenceResourceId: CLOSURE_ID,
    evidence: {
      appointment_id: APPOINTMENT_ID,
      appointment_status: 'NO_SHOW',
      closure_evidence_id: CLOSURE_ID,
      closure_evidence_revision: 2,
      source_status_history_id: '91',
      canonical_timeline_event_id: TIMELINE_ID,
      canonical_audit_event_id: AUDIT_ID,
      source_outbox_event_id: '301',
    },
    idempotencyKey: `op:${APPOINTMENT_ID}:event:301:recovery-completion`,
    signal,
    actor,
    registry,
    activationEvidenceCapability,
    tx,
  });
});

test('does not invoke recovery authority outside the current recovery step', async () => {
  const observed = recoveryExecution({
    run: { id: 19, current_step_key: 'await_closure_evidence' },
  });
  await expect(completeOpRecoveryTaskFromClosureEvidence({
    tenantId: TENANT_ID,
    appointment: closureAppointment(),
    event: {
      id: '302',
      event_type: 'appointment.closure_evidence_recorded',
    },
    execution: observed,
  })).resolves.toBe(observed);
  expect(completeRegisteredCondition).not.toHaveBeenCalled();
});

test('rejects an SLA-linked task before invoking the no-SLA recovery authority', () => {
  const observed = recoveryExecution();
  observed.instance.tasks[0].workflow_sla_instance_id =
    '60000000-0000-4000-8000-000000000001';
  expect(() => __testing__.currentRecoveryTask(observed)).toThrow(
    expect.objectContaining({ code: 'OP_RECOVERY_TASK_CONTRACT_INVALID' }),
  );
});
