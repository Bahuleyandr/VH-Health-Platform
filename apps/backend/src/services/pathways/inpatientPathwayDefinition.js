import { compileWorkflowDefinition } from '../workflow/workflowDefinitionCompiler.js';
import { workflowRuntimeRegistryV4 } from '../workflow/workflowRuntimeRegistry.js';
import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

export const INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION = Object.freeze({
  workflow_key: CARE_PATHWAY_KEYS.INPATIENT,
  version: 1,
  triggers: Object.freeze([]),
  defaults: Object.freeze({ source_episode_type: 'admission' }),
  steps: Object.freeze([
    Object.freeze({
      step_key: 'observe_accepted_admission',
      step_kind: 'wait',
      display_name: 'Observe accepted admission and named primary physician',
      condition_handler: 'inpatient.accepted_admission.v1',
    }),
    Object.freeze({
      step_key: 'observe_discharge_planning',
      step_kind: 'wait',
      display_name: 'Observe admission-to-discharge planning',
      condition_handler: 'inpatient.discharge_planning.v1',
    }),
    Object.freeze({
      step_key: 'await_existing_readiness_work',
      step_kind: 'wait',
      display_name: 'Await existing discharge readiness work',
      condition_handler: 'inpatient.readiness_work.v1',
    }),
    Object.freeze({
      step_key: 'await_discharge_evidence',
      step_kind: 'wait',
      display_name: 'Await discharge safety evidence',
      condition_handler: 'inpatient.discharge_evidence.v1',
    }),
    Object.freeze({
      step_key: 'observe_discharge',
      step_kind: 'wait',
      display_name: 'Observe discharge completion',
      condition_handler: 'inpatient.discharge_completion.v1',
    }),
    Object.freeze({
      step_key: 'await_post_discharge_contact',
      step_kind: 'wait',
      display_name: 'Await required post-discharge contact or accepted transfer',
      condition_handler: 'inpatient.post_discharge_contact.v1',
    }),
    Object.freeze({
      step_key: 'finalize_inpatient_pathway',
      step_kind: 'automation',
      display_name: 'Finalize inpatient pathway',
      action_handler: 'inpatient.finalize.v1',
    }),
  ]),
});

export function compileInpatientAdmissionToRecoveryDefinition({
  registry = workflowRuntimeRegistryV4,
} = {}) {
  return compileWorkflowDefinition(INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION, { registry });
}

export default INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION;
