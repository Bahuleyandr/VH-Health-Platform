import { compileWorkflowDefinition } from '../workflow/workflowDefinitionCompiler.js';
import { workflowRuntimeRegistryV4 } from '../workflow/workflowRuntimeRegistry.js';
import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

export const OP_CONTACT_TO_RECOVERY_DEFINITION = Object.freeze({
  workflow_key: CARE_PATHWAY_KEYS.OP,
  version: 1,
  triggers: Object.freeze([]),
  defaults: Object.freeze({ source_episode_type: 'appointment' }),
  steps: Object.freeze([
    Object.freeze({
      step_key: 'observe_contact_and_owner',
      step_kind: 'wait',
      display_name: 'Observe outpatient contact and named clinician',
      condition_handler: 'op.contact_owner.v1',
    }),
    Object.freeze({
      step_key: 'observe_arrival_or_recovery',
      step_kind: 'wait',
      display_name: 'Observe visit arrival or recovery branch',
      condition_handler: 'op.arrival_or_recovery.v1',
      exception_transitions: Object.freeze([
        Object.freeze({
          decision_code: 'recovery_branch',
          target_step_key: 'recover_unattended_visit',
        }),
      ]),
    }),
    Object.freeze({
      step_key: 'observe_visit_completion',
      step_kind: 'wait',
      display_name: 'Observe visit completion',
      condition_handler: 'op.visit_completion.v1',
      exception_transitions: Object.freeze([
        Object.freeze({
          decision_code: 'normal_visit_completed',
          target_step_key: 'await_closure_evidence',
        }),
      ]),
    }),
    Object.freeze({
      step_key: 'recover_unattended_visit',
      step_kind: 'task',
      display_name: 'Review and close unattended visit recovery',
      assigned_role: 'DOCTOR',
      condition_handler: 'op.recovery_action.v1',
      work_semantics: Object.freeze({
        task_kind: 'follow_up',
        priority: 'normal',
        title: 'Review unattended outpatient visit',
        description: 'Review the cancelled, no-show, or rescheduled visit and record the appropriate closure evidence.',
        sla_completion_semantics: 'none',
      }),
    }),
    Object.freeze({
      step_key: 'await_closure_evidence',
      step_kind: 'wait',
      display_name: 'Await clinician disposition and patient-safe next steps',
      condition_handler: 'op.closure_evidence.v1',
    }),
    Object.freeze({
      step_key: 'await_child_work_closure',
      step_kind: 'wait',
      display_name: 'Await child work closure or accepted named ownership',
      condition_handler: 'op.child_work_closure.v1',
    }),
    Object.freeze({
      step_key: 'finalize_op_pathway',
      step_kind: 'automation',
      display_name: 'Finalize outpatient pathway',
      action_handler: 'op.finalize.v1',
    }),
  ]),
});

export function compileOpContactToRecoveryDefinition({
  registry = workflowRuntimeRegistryV4,
} = {}) {
  return compileWorkflowDefinition(OP_CONTACT_TO_RECOVERY_DEFINITION, { registry });
}

export default OP_CONTACT_TO_RECOVERY_DEFINITION;
