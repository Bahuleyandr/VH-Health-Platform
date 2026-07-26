import { compileWorkflowDefinition } from '../workflow/workflowDefinitionCompiler.js';
import { workflowRuntimeRegistryV3 } from '../workflow/workflowRuntimeRegistry.js';
import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

export const REFERRAL_REQUEST_TO_CLOSURE_DEFINITION = Object.freeze({
  workflow_key: CARE_PATHWAY_KEYS.REFERRAL,
  version: 1,
  triggers: Object.freeze([]),
  defaults: Object.freeze({ source_episode_type: 'referral' }),
  steps: Object.freeze([
    Object.freeze({
      step_key: 'await_receiver_acceptance',
      step_kind: 'wait',
      display_name: 'Await named receiver acceptance',
      condition_handler: 'referral.receiver_acceptance.v1',
      exception_transitions: Object.freeze([
        Object.freeze({ decision_code: 'receiver_accepted', target_step_key: 'await_signed_response' }),
        Object.freeze({ decision_code: 'referral_closed', target_step_key: 'finalize_referral_pathway' }),
      ]),
    }),
    Object.freeze({
      step_key: 'await_signed_response',
      step_kind: 'wait',
      display_name: 'Await signed specialist response',
      condition_handler: 'referral.signed_response.v1',
      exception_transitions: Object.freeze([
        Object.freeze({ decision_code: 'response_signed', target_step_key: 'await_originator_closure' }),
        Object.freeze({ decision_code: 'referral_closed', target_step_key: 'finalize_referral_pathway' }),
      ]),
    }),
    Object.freeze({
      step_key: 'await_originator_closure',
      step_kind: 'wait',
      display_name: 'Await originator acknowledgement and plan update',
      condition_handler: 'referral.originator_closure.v1',
      exception_transitions: Object.freeze([
        Object.freeze({ decision_code: 'referral_closed', target_step_key: 'finalize_referral_pathway' }),
      ]),
    }),
    Object.freeze({
      step_key: 'finalize_referral_pathway',
      step_kind: 'automation',
      display_name: 'Finalize referral pathway',
      action_handler: 'referral.finalize.v1',
    }),
  ]),
});

export function compileReferralRequestToClosureDefinition({
  registry = workflowRuntimeRegistryV3,
} = {}) {
  return compileWorkflowDefinition(REFERRAL_REQUEST_TO_CLOSURE_DEFINITION, { registry });
}

export default REFERRAL_REQUEST_TO_CLOSURE_DEFINITION;
