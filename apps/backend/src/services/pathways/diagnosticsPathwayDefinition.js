import { compileWorkflowDefinition } from '../workflow/workflowDefinitionCompiler.js';
import { workflowRuntimeRegistry } from '../workflow/workflowRuntimeRegistry.js';
import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

export const DIAGNOSTIC_ACTION_SLA_RULE_CODE = 'diagnostic_result_action_review';

export const DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION = Object.freeze({
  workflow_key: CARE_PATHWAY_KEYS.DIAGNOSTICS,
  version: 1,
  triggers: Object.freeze([]),
  defaults: Object.freeze({ source_episode_type: 'diagnostic_result_generation' }),
  steps: Object.freeze([
    Object.freeze({
      step_key: 'route_signed_generation',
      step_kind: 'wait',
      display_name: 'Route signed diagnostic generation',
      condition_handler: 'diagnostics.route_generation.v1',
      exception_transitions: Object.freeze([Object.freeze({
        decision_code: 'doctor_action_required',
        target_step_key: 'record_doctor_action',
      }), Object.freeze({
        decision_code: 'generation_superseded',
        target_step_key: 'finalize_diagnostic_pathway',
      })]),
    }),
    Object.freeze({
      step_key: 'await_normal_release_closure',
      step_kind: 'wait',
      display_name: 'Await normal result release closure',
      condition_handler: 'diagnostics.normal_closure.v1',
      exception_transitions: Object.freeze([Object.freeze({
        decision_code: 'normal_closed',
        target_step_key: 'finalize_diagnostic_pathway',
      }), Object.freeze({
        decision_code: 'generation_superseded',
        target_step_key: 'finalize_diagnostic_pathway',
      })]),
    }),
    Object.freeze({
      step_key: 'record_doctor_action',
      step_kind: 'task',
      display_name: 'Review and record diagnostic result action',
      assigned_role: 'DOCTOR',
      condition_handler: 'diagnostics.doctor_action.v1',
      work_semantics: Object.freeze({
        task_kind: 'review',
        priority: 'high',
        title: 'Review and record diagnostic result action',
        description: 'Review the current signed diagnostic generation and record a signed clinical disposition.',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: DIAGNOSTIC_ACTION_SLA_RULE_CODE,
      }),
    }),
    Object.freeze({
      step_key: 'finalize_diagnostic_pathway',
      step_kind: 'automation',
      display_name: 'Finalize diagnostic pathway',
      action_handler: 'diagnostics.finalize.v1',
    }),
  ]),
});

export function compileDiagnosticsOrderToActionDefinition({
  registry = workflowRuntimeRegistry,
} = {}) {
  return compileWorkflowDefinition(DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION, { registry });
}

export default DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION;
