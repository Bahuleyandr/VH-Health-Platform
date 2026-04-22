-- Clinical safety AI (Batch 3): deterioration early warning + polypharmacy.
-- Both tables are tenant-scoped + auto-retention.

-- Deterioration early warning — NEWS2-like composite with ML-augmented
-- acceleration detection. Snapshots are immutable.
CREATE TABLE IF NOT EXISTS clinical_ai_deterioration_snapshots (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  score NUMERIC(5, 2) NOT NULL,
  band VARCHAR(10) NOT NULL CHECK (band IN ('stable', 'watch', 'concerning', 'critical')),
  news2_component NUMERIC(4, 2),
  trend_component NUMERIC(4, 2),
  lab_component NUMERIC(4, 2),
  contributors JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  vitals_sample_count INTEGER NOT NULL DEFAULT 0,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_deterioration_patient_time
  ON clinical_ai_deterioration_snapshots (tenant_id, patient_uid, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_deterioration_band
  ON clinical_ai_deterioration_snapshots (tenant_id, band, scored_at DESC);

-- Polypharmacy AI — catches LLM-detected interactions that the rule-based
-- prescriptionSafetyCheck misses (cross-class, pharmacokinetic, QT risk).
CREATE TABLE IF NOT EXISTS clinical_ai_polypharmacy_reviews (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  medications JSONB NOT NULL DEFAULT '[]'::jsonb,
  rule_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  combined_severity VARCHAR(10) NOT NULL CHECK (combined_severity IN ('low', 'medium', 'high', 'critical')),
  provider VARCHAR(40) NOT NULL DEFAULT 'rules_only',
  model VARCHAR(120),
  reviewer_decision VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'acknowledged', 'overridden', 'prescription_changed')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_polypharmacy_patient
  ON clinical_ai_polypharmacy_reviews (tenant_id, patient_uid, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_polypharmacy_pending
  ON clinical_ai_polypharmacy_reviews (tenant_id)
  WHERE reviewer_decision = 'pending';

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('deterioration_early_warning',
   'Deterioration Early Warning',
   'Composite NEWS2-like score with vital trend + recent-lab components. Alerts BEFORE rule-based thresholds fire so nurses get ahead of sepsis or respiratory decline.',
   false,
   '{"surface":"clinical","risk":"critical","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"outputSchema":{"type":"object","required":["score","band","contributors"]},"retentionDays":90}'::jsonb),
  ('polypharmacy_ai_review',
   'Polypharmacy AI Review',
   'LLM-augmented drug-interaction check on top of the existing rule-based prescriptionSafetyCheck. Rules remain authoritative; AI surfaces cross-class or QT-prolongation risks the rules miss.',
   false,
   '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF"],"outputSchema":{"type":"object","required":["combined_severity","rule_findings","ai_findings"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
