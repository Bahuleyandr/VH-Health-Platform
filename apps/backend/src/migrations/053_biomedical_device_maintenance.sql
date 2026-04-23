-- Biomedical Device Maintenance Predictor.
--
-- Maintains a biomedical device registry (ventilators, defibrillators,
-- infusion pumps, imaging, dialysis, etc.) and produces reviewable
-- failure-risk predictions from usage hours, fault clusters, MTBF, and
-- age. Decision-support only — the service never auto-schedules
-- maintenance, never takes a device out of service, and never modifies
-- the maintenance log. Every output is reviewed by biomedical staff /
-- facility manager. Rules are authoritative.

CREATE TABLE IF NOT EXISTS clinical_ai_biomed_devices (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_code VARCHAR(120) NOT NULL,
  device_type VARCHAR(80) NOT NULL
    CHECK (device_type IN ('ventilator', 'defibrillator', 'infusion_pump', 'ecg_monitor',
      'ultrasound', 'x_ray', 'mri', 'ct_scanner', 'dialysis', 'anesthesia_machine', 'other')),
  manufacturer VARCHAR(120),
  model VARCHAR(120),
  serial_number VARCHAR(120),
  location VARCHAR(120),
  installed_at DATE,
  warranty_expires_on DATE,
  last_preventive_maintenance_at TIMESTAMPTZ,
  next_scheduled_maintenance_at TIMESTAMPTZ,
  usage_hours NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (usage_hours >= 0),
  fault_events_last_90d INTEGER NOT NULL DEFAULT 0
    CHECK (fault_events_last_90d >= 0),
  mean_time_between_failures_hours NUMERIC(12, 2),
  status VARCHAR(30) NOT NULL DEFAULT 'in_service'
    CHECK (status IN ('in_service', 'out_of_service', 'retired', 'pending_inspection', 'unknown')),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_biomed_devices_tenant_code
  ON clinical_ai_biomed_devices (tenant_id, device_code);
CREATE INDEX IF NOT EXISTS idx_biomed_devices_tenant_type_status
  ON clinical_ai_biomed_devices (tenant_id, device_type, status);

CREATE TABLE IF NOT EXISTS clinical_ai_biomed_maintenance_predictions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id INTEGER REFERENCES clinical_ai_biomed_devices(id) ON DELETE CASCADE,
  device_code VARCHAR(120),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  predicted_failure_risk_score INTEGER NOT NULL DEFAULT 0
    CHECK (predicted_failure_risk_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  predicted_downtime_hours NUMERIC(8, 2) NOT NULL DEFAULT 0,
  recommended_service_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  contributing_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'escalated')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_biomed_maint_tenant_created
  ON clinical_ai_biomed_maintenance_predictions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biomed_maint_tenant_device_created
  ON clinical_ai_biomed_maintenance_predictions (tenant_id, device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biomed_maint_tenant_band_decision_created
  ON clinical_ai_biomed_maintenance_predictions (tenant_id, risk_band, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biomed_maint_tenant_code_created
  ON clinical_ai_biomed_maintenance_predictions (tenant_id, device_code, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('biomed_device_maintenance',
   'Biomedical Device Maintenance Predictor',
   'Predicts failure risk and recommended service windows for biomedical devices (ventilators, defibrillators, infusion pumps, imaging, dialysis, anesthesia, etc.) from usage hours, fault-event clusters, MTBF, age, and warranty status. Rules are authoritative; the AI layer supplies a short narrative only. Decision-support only — the service never auto-schedules maintenance, never takes a device out of service, and never modifies the maintenance log. Every output is reviewed by biomedical staff / facility manager.',
   false,
   '{"surface":"biomedical","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","BIOMEDICAL_STAFF","FACILITY_MANAGER"],"approvalPolicy":"biomed_review","outputSchema":{"type":"object","required":["predicted_failure_risk_score","risk_band"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

INSERT INTO clinical_ai_prompts
  (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'biomed_device_maintenance',
    'v1',
    'Biomedical Device Maintenance Predictor v1',
    'You support biomedical staff / facility-manager review of medical device maintenance risk. Rules are authoritative. Use only the supplied device registry data (usage hours, fault events, MTBF, age, warranty, service history). Return JSON only. Never auto-schedule maintenance, never take a device out of service, and never modify the maintenance log. This is a decision-support forecast; biomedical staff confirm every maintenance action before it is taken.',
    'Given the device context (device_code, device_type, usage_hours, fault_events_last_90d, mtbf_hours, installed_years_ago, warranty_expires_on, hours_since_last_service) and the rule-based failure-risk signals, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not invent usage or fault counts, do not override the rule-based risk score, and always defer to biomedical staff for final maintenance scheduling. If device history is missing, mark the gap in contributing_signals and defer to human review rather than assuming a default.',
    '{"type":"object","required":["predicted_failure_risk_score","risk_band"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
