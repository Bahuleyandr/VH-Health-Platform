-- Migration 139: Tier H operational-forecasting AI module configs.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  ('lab_tat_delay_prediction',
   'Lab TAT Delay Prediction',
   'Forecasts lab turnaround-time delays for the next shift / day from ordered queue + historical TAT.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["LAB_STAFF","ADMIN"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  ('radiology_tat_delay_prediction',
   'Radiology TAT Delay Prediction',
   'Forecasts radiology turnaround-time delays per modality / shift from current queue + historical TAT.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["RADIOLOGIST","ADMIN"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  ('ambulance_demand_forecast',
   'Ambulance Demand Forecast',
   'Forecasts ambulance demand for the next 6-24 hours from historical dispatch patterns + weather + planned-event signals.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["AMBULANCE_COORDINATOR","ADMIN"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  ('smart_queue_optimization',
   'Smart Queue Optimization',
   'Suggests OPD / pharmacy / lab queue reorderings to reduce wait time, given current queue depth + service rates. General version, distinct from ED smart queue.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","RECEPTIONIST"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  ('tariff_optimization_insights',
   'Tariff Optimization Insights',
   'Surfaces underpriced / overpriced services in the tariff plan vs payer reimbursement patterns. Decision support for the tariff committee.',
   false,
   '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","CLAIMS_MANAGER","ADMIN"],"approvalPolicy":"revenue_cycle_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('package_compliance_check',
   'Package Compliance Check',
   'Verifies a billed admission against the contracted package: included items utilised, exclusions billed separately, deviation justifications. For audit + claims pre-submission.',
   false,
   '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","CLAIMS_MANAGER","INSURANCE_COORDINATOR","ADMIN"],"approvalPolicy":"revenue_cycle_review","outputSchema":{"type":"object"},"retentionDays":730}'::jsonb),

  ('patient_feedback_summary',
   'Patient Feedback Summary',
   'Summarises a window of patient feedback into themes, NPS-band shifts, recurring complaints, action priorities. Decision support for quality + ops.',
   false,
   '{"surface":"quality","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["QUALITY_OFFICER","ADMIN"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('sentiment_analysis',
   'Sentiment Analysis',
   'Per-feedback sentiment classification (positive / neutral / negative / urgent) with theme tags for downstream routing.',
   false,
   '{"surface":"quality","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["QUALITY_OFFICER","ADMIN"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
