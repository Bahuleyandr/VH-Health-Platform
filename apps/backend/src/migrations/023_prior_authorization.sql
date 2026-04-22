-- Prior authorization automation (Batch 5).
-- Auto-generates a payer-specific pre-auth packet from the chart. Tenant-
-- scoped; every submission carries a citation set so downstream payer
-- audits can trace each claim to a signed clinical record.

CREATE TABLE IF NOT EXISTS clinical_ai_prior_auth_requests (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER,
  patient_uid UUID NOT NULL,
  payer_name VARCHAR(200) NOT NULL,
  policy_number VARCHAR(80),
  procedure_code VARCHAR(50) NOT NULL,
  procedure_description TEXT,
  requested_service_type VARCHAR(60),
  medical_necessity TEXT NOT NULL,
  clinical_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  packet_draft JSONB NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'denied', 'withdrawn')),
  reviewer_decision VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'submitted', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  submitted_at TIMESTAMPTZ,
  submitted_by UUID,
  payer_reference_id VARCHAR(120),
  payer_decided_at TIMESTAMPTZ,
  payer_decision_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '2555 days')
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_prior_auth_tenant_patient
  ON clinical_ai_prior_auth_requests (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_prior_auth_pending_review
  ON clinical_ai_prior_auth_requests (tenant_id)
  WHERE reviewer_decision = 'pending';
CREATE INDEX IF NOT EXISTS idx_clinical_ai_prior_auth_submitted
  ON clinical_ai_prior_auth_requests (tenant_id, submitted_at DESC)
  WHERE status = 'submitted';

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('prior_authorization_generator',
   'Prior Authorization Generator',
   'Auto-assembles a payer-specific pre-auth packet (medical necessity narrative + clinical evidence + citations) from the admission chart. Billing coordinator reviews, edits, and submits to the payer API.',
   false,
   '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","INSURANCE_COORDINATOR","ADMIN"],"outputSchema":{"type":"object","required":["medical_necessity","clinical_evidence","procedure_code"]},"retentionDays":2555}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
