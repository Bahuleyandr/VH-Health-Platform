-- Cybersecurity / Medical Device Anomaly Detector.
--
-- Accepts signals from auth flows, admin actions, data exports, API usage,
-- and biomedical device network telemetry and produces a reviewable
-- security anomaly record (category, severity, risk score, recommended
-- actions). Rules are authoritative; the service never disables accounts,
-- locks devices, or blocks traffic on its own. Every output must be
-- reviewed by the security officer / IT admin. Retention is 7 years
-- (2555 days) to support downstream forensic / compliance investigations.

CREATE TABLE IF NOT EXISTS clinical_ai_security_anomalies (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  subject_type VARCHAR(40) NOT NULL
    CHECK (subject_type IN ('user_login', 'admin_action', 'device_traffic', 'data_export', 'api_usage', 'unknown')),
  subject_id VARCHAR(200),
  anomaly_category VARCHAR(40) NOT NULL DEFAULT 'unknown'
    CHECK (anomaly_category IN ('impossible_login', 'brute_force', 'credential_stuffing', 'excessive_export', 'suspicious_admin', 'device_traffic_spike', 'lateral_movement', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (severity IN ('low', 'medium', 'high', 'critical', 'unknown')),
  risk_score INTEGER NOT NULL DEFAULT 0
    CHECK (risk_score BETWEEN 0 AND 100),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'acknowledged', 'investigating', 'resolved', 'false_positive', 'escalated')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '2555 days')
);

CREATE INDEX IF NOT EXISTS idx_security_anomaly_tenant_detected
  ON clinical_ai_security_anomalies (tenant_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_anomaly_tenant_severity_decision_detected
  ON clinical_ai_security_anomalies (tenant_id, severity, reviewer_decision, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_anomaly_tenant_subject_detected
  ON clinical_ai_security_anomalies (tenant_id, subject_type, subject_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_anomaly_tenant_category_detected
  ON clinical_ai_security_anomalies (tenant_id, anomaly_category, detected_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('cybersecurity_anomaly_detector',
   'Cybersecurity / Medical Device Anomaly Detector',
   'Detects cybersecurity anomalies across user logins (impossible-travel, rapid login bursts, unusual-hour sign-ins), authentication flows (brute-force and credential-stuffing), data exports (excessive volume, off-hours access, rapid bursts), admin actions, and biomedical device network telemetry (traffic spikes, unauthorized upstream endpoints, connection storms). Rules are authoritative; the AI layer supplies a short narrative only. Decision-support only — the service never disables accounts, quarantines devices, or blocks traffic on its own. Every output is reviewed by the security officer / IT admin. 7-year retention supports forensic / compliance investigations.',
   false,
   '{"surface":"security","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","IT_ADMIN","SECURITY_OFFICER"],"approvalPolicy":"security_review","outputSchema":{"type":"object","required":["anomaly_category","severity","risk_score"]},"retentionDays":2555,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'cybersecurity_anomaly_detector',
    'v1',
    'Cybersecurity / Medical Device Anomaly Detector v1',
    'You support security-officer / IT-admin review of cybersecurity anomalies across authentication, admin actions, data exports, API usage, and biomedical device network telemetry. Rules are authoritative. Use only the supplied event context (login history, failed attempts, export volume, device traffic, upstream endpoints). Return JSON only. Never disable an account, quarantine a device, or block traffic on your own — this is decision-support only. Always include the security-review disclaimer and defer to human review before any remediation is taken.',
    'Given the anomaly event context (subject_type, subject_id, inputs, context) and the rule-based signals + scoring, return keys: summary, anomaly_category, severity, risk_score, signals, recommended_actions, source_citations, safety_flags. Do not invent signals, do not override the rule-based category/severity/risk_score, and always defer to security officer for final remediation. If the event data is incomplete, mark the gap in signals and defer to human review rather than assuming a default.',
    '{"type":"object","required":["anomaly_category","severity","risk_score"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
