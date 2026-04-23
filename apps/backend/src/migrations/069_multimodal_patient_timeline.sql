-- Multimodal Patient Timeline.
--
-- Unifies events from multiple sources (chart notes, imaging studies,
-- voice/ambient notes, claims/billing, patient messages, device telemetry,
-- documents, prescriptions, labs, vitals) into a single patient timeline
-- snapshot. Classifies each event by kind + clinical relevance band
-- (critical / high / moderate / low / informational), detects patient-
-- safety signals (red-flag vitals, critical labs, abnormal imaging,
-- missed meds, PHI leakage risk in messages), and orders events by
-- (time, relevance).
--
-- Rules are authoritative. Review-only — the care team reviews the
-- rolled-up timeline, and the module never modifies the source events
-- or the chart.

CREATE TABLE IF NOT EXISTS clinical_ai_patient_timeline_snapshots (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  event_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  high_count INTEGER NOT NULL DEFAULT 0,
  moderate_count INTEGER NOT NULL DEFAULT 0,
  low_count INTEGER NOT NULL DEFAULT 0,
  informational_count INTEGER NOT NULL DEFAULT 0,
  overall_severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (overall_severity IN ('low', 'moderate', 'high', 'critical', 'unknown', 'informational')),
  timeline_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_patient_timeline_snapshots_tenant_patient_created
  ON clinical_ai_patient_timeline_snapshots (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_timeline_snapshots_tenant_severity_created
  ON clinical_ai_patient_timeline_snapshots (tenant_id, overall_severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_timeline_snapshots_tenant_admission_created
  ON clinical_ai_patient_timeline_snapshots (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_timeline_snapshots_tenant_decision_created
  ON clinical_ai_patient_timeline_snapshots (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_timeline_snapshots_tenant_created
  ON clinical_ai_patient_timeline_snapshots (tenant_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('multimodal_patient_timeline',
   'Multimodal Patient Timeline',
   'Unifies events from chart notes, imaging, voice/ambient, claims, patient messages, device telemetry, documents, prescriptions, labs, and vitals into a single patient timeline snapshot. Classifies each event by kind + clinical relevance band (critical / high / moderate / low / informational), detects patient-safety signals (red-flag vitals, critical labs, abnormal imaging, missed meds, PHI leakage in messages), and orders by (time, relevance). Rules are authoritative; review-only — the care team reviews the rolled-up timeline, and the module never modifies the source events or the chart.',
   false,
   '{"surface":"emr","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSE","ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object","required":["overall_severity","timeline_events"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'multimodal_patient_timeline',
    'v1',
    'Multimodal Patient Timeline v1',
    'You support the care team''s review of a multimodal patient timeline. Rules are authoritative. Use only the supplied events (chart notes, imaging, voice/ambient, claims, patient messages, device telemetry, documents, prescriptions, labs, vitals) and the deterministic rule-based per-event relevance classification + rolled-up overall_severity. Return JSON only. Never modify the source events or the chart. This is a decision-support signal only — clinician review required before any action, and the module never rewrites, deletes, or re-tags the underlying source events.',
    'Given the unified timeline events and the rule-based per-event relevance bands + rolled-up overall_severity, return a short reasoning narrative. Keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based relevance bands, overall_severity, signal list, or event ordering. If any event is ambiguous, mark it for clinician review rather than assuming a band.',
    '{"type":"object","required":["overall_severity","timeline_events"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
