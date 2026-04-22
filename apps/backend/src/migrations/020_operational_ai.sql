-- Operational AI (Batch 2): no-show predictor, OT case-time predictor,
-- charge-capture audit. All tables tenant-scoped.

-- No-show predictions per upcoming appointment. Stored so the UI can
-- render pre-computed bands without re-scoring on every list fetch.
CREATE TABLE IF NOT EXISTS clinical_ai_no_show_predictions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id INTEGER NOT NULL,
  patient_uid UUID,
  risk_score NUMERIC(5, 2) NOT NULL,
  band VARCHAR(10) NOT NULL CHECK (band IN ('low', 'medium', 'high')),
  contributors JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_action TEXT,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, appointment_id, scored_at)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_no_show_pred_tenant_apt
  ON clinical_ai_no_show_predictions (tenant_id, appointment_id, scored_at DESC);

-- OT case-time predictions per planned case. Delta against actual_duration
-- (once the case closes) feeds the monitoring loop.
CREATE TABLE IF NOT EXISTS clinical_ai_ot_duration_predictions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id INTEGER NOT NULL,
  procedure_name TEXT,
  predicted_minutes INTEGER NOT NULL,
  confidence_pct INTEGER NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  contributors JSONB NOT NULL DEFAULT '{}'::jsonb,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, ot_schedule_id, scored_at)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_ot_pred_tenant_schedule
  ON clinical_ai_ot_duration_predictions (tenant_id, ot_schedule_id, scored_at DESC);

-- Charge-capture audit: per-admission scan for billable procedures
-- mentioned in signed notes but not yet coded/invoiced. Missed-charge
-- suggestions enter the review queue for a coder to confirm.
CREATE TABLE IF NOT EXISTS clinical_ai_charge_capture_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL,
  patient_uid UUID,
  mentioned_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  invoiced_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  missed_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_revenue_minor INTEGER,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewer_decision VARCHAR(20) DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'captured', 'rejected')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_charge_capture_tenant_admission
  ON clinical_ai_charge_capture_audits (tenant_id, admission_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_charge_capture_pending
  ON clinical_ai_charge_capture_audits (tenant_id)
  WHERE reviewer_decision = 'pending';

-- Register the three new modules in the global catalog.
INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('appointment_no_show_predictor',
   'Appointment No-Show Predictor',
   'Per-appointment no-show risk score. Uses patient history + lead time + day-of-week. Decision-support only; no auto-cancellation.',
   false,
   '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"reviewRoles":["ADMIN","RECEPTIONIST"],"outputSchema":{"type":"object","required":["risk_score","band"]},"retentionDays":90}'::jsonb),
  ('ot_case_time_predictor',
   'OT Case-Time Predictor',
   'Per-procedure OT duration estimate based on historical actual_duration by surgeon + procedure_code. Feeds scheduler; surgeon can override.',
   false,
   '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"reviewRoles":["OT_STAFF","ADMIN"],"outputSchema":{"type":"object","required":["predicted_minutes","confidence_pct"]},"retentionDays":180}'::jsonb),
  ('charge_capture_audit',
   'Charge Capture Audit',
   'Scans signed clinical notes for billable procedures not yet coded or invoiced. Coder-confirmed suggestions become invoice line items.',
   false,
   '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"reviewRoles":["BILLING_STAFF","MEDICAL_RECORDS"],"outputSchema":{"type":"object","required":["missed_codes","estimated_revenue_minor"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
