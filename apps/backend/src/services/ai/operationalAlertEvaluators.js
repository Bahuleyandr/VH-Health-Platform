// src/services/ai/operationalAlertEvaluators.js
//
// Per-module evaluator adapters for the operational forecast alert stream.
// Each evaluator wraps an existing forecast service / operational data source,
// applies a DETERMINISTIC threshold, and returns normalized AlertCandidates.
// The orchestrator (operationalAlertService) owns persistence + lifecycle.

/**
 * @typedef {Object} AlertCandidate
 * @property {string} module_key
 * @property {string} domain
 * @property {string|null} owner_role
 * @property {string} scope_key             dedup identity within (tenant, module)
 * @property {string} [scope_label]
 * @property {string} [horizon]             'tonight'|'24h'|'72h'|'7d'|ISO date
 * @property {Date|null} [predicted_for]
 * @property {string} alert_category
 * @property {'low'|'moderate'|'high'|'critical'} severity
 * @property {object} [metrics]
 * @property {object[]} [signals]
 * @property {string} [summary]
 * @property {string[]} [recommended_actions]
 * @property {object[]} [source_citations]
 */

// Each evaluator: async ({ tenantId, now }) => AlertCandidate[]
// Stubs return [] until Task 7 implements them.
const stub = async () => [];

export const OPERATIONAL_ALERT_EVALUATORS = [
  { module_key: 'pharmacy_stockout_predictor',       domain: 'pharmacy',     owner_role: 'MATERIALS_MANAGER',    evaluate: stub },
  { module_key: 'blood_bank_demand_forecast',        domain: 'blood_bank',   owner_role: 'BLOOD_BANK_STAFF',     evaluate: stub },
  { module_key: 'bed_discharge_forecast',            domain: 'beds',         owner_role: 'BED_MANAGER',          evaluate: stub },
  { module_key: 'housekeeping_bed_turnover',         domain: 'housekeeping', owner_role: 'HOUSEKEEPING_STAFF',   evaluate: stub },
  { module_key: 'acuity_staffing_forecast',          domain: 'staffing',     owner_role: 'HOUSE_SUPERVISOR',     evaluate: stub },
  { module_key: 'staff_roster_optimizer',            domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'staff_burnout_workload_risk',       domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'ot_case_time_predictor',            domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: stub },
  { module_key: 'ot_block_scheduling',               domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: stub },
  { module_key: 'appointment_no_show_predictor',     domain: 'opd',          owner_role: 'RECEPTIONIST',         evaluate: stub },
  { module_key: 'biomed_device_maintenance',         domain: 'biomed',       owner_role: 'BIOMEDICAL_STAFF',     evaluate: stub },
  { module_key: 'inventory_intelligence',            domain: 'inventory',    owner_role: 'MATERIALS_MANAGER',    evaluate: stub },
  { module_key: 'procurement_negotiation_assistant', domain: 'procurement',  owner_role: 'PROCUREMENT_LEAD',     evaluate: stub },
];
