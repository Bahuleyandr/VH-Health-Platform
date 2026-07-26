import { compileWorkflowDefinition } from '../workflow/workflowDefinitionCompiler.js';
import { workflowRuntimeRegistryV5 } from '../workflow/workflowRuntimeRegistry.js';
import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

export const EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION = Object.freeze({
  workflow_key: CARE_PATHWAY_KEYS.EMERGENCY,
  version: 1,
  triggers: Object.freeze([]),
  defaults: Object.freeze({ source_episode_type: 'emergency_visit' }),
  steps: Object.freeze([
    Object.freeze({
      step_key: 'observe_arrival_and_owner',
      step_kind: 'wait',
      display_name: 'Observe ED arrival and named clinician',
      condition_handler: 'emergency.arrival_owner.v1',
    }),
    Object.freeze({
      step_key: 'observe_disposition_readiness',
      step_kind: 'wait',
      display_name: 'Observe ED disposition readiness',
      condition_handler: 'emergency.disposition_readiness.v1',
    }),
    Object.freeze({
      step_key: 'await_destination_acceptance',
      step_kind: 'wait',
      display_name: 'Await receiving destination acceptance or explicit ED closure',
      condition_handler: 'emergency.destination_acceptance.v1',
    }),
    Object.freeze({
      step_key: 'observe_destination_or_closure',
      step_kind: 'wait',
      display_name: 'Observe destination arrival or explicit ED closure',
      condition_handler: 'emergency.destination_closure.v1',
    }),
    Object.freeze({
      step_key: 'finalize_emergency_pathway',
      step_kind: 'automation',
      display_name: 'Finalize emergency pathway',
      action_handler: 'emergency.finalize.v1',
    }),
  ]),
});

export function compileEmergencyArrivalToAftercareDefinition({
  registry = workflowRuntimeRegistryV5,
} = {}) {
  return compileWorkflowDefinition(
    EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION,
    { registry },
  );
}

export default EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION;
