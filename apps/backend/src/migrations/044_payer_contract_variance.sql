-- Payer Contract Variance / Underpayment AI.
--
-- Stores contracted rates per payer + procedure, and flags insurance claims
-- where the payer paid less than contracted (underpayment), more than
-- contracted (overpayment), or where no contract is on file for the
-- billed procedure. Review-only: billing/insurance coordinator reviews
-- and escalates; the service never auto-appeals or writes off a claim.

CREATE TABLE IF NOT EXISTS clinical_ai_payer_contracts (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payer_name VARCHAR(200) NOT NULL,
  payer_code VARCHAR(80),
  procedure_code VARCHAR(50) NOT NULL,
  procedure_description TEXT,
  expected_rate_minor INTEGER NOT NULL CHECK (expected_rate_minor >= 0),
  currency_code VARCHAR(8) NOT NULL DEFAULT 'INR',
  tolerance_pct NUMERIC(5, 2) NOT NULL DEFAULT 2.00
    CHECK (tolerance_pct BETWEEN 0 AND 100),
  effective_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_end_date DATE,
  contract_reference VARCHAR(200),
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payer_contracts_tenant_payer_proc_start
  ON clinical_ai_payer_contracts (tenant_id, LOWER(payer_name), procedure_code, effective_start_date);
CREATE INDEX IF NOT EXISTS idx_payer_contracts_tenant_payer
  ON clinical_ai_payer_contracts (tenant_id, LOWER(payer_name), procedure_code, active);

CREATE TABLE IF NOT EXISTS clinical_ai_payer_variance_reviews (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_id INTEGER NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
  contract_id INTEGER REFERENCES clinical_ai_payer_contracts(id) ON DELETE SET NULL,
  patient_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  payer_name VARCHAR(200) NOT NULL,
  procedure_code VARCHAR(50),
  expected_amount_minor INTEGER NOT NULL DEFAULT 0,
  paid_amount_minor INTEGER NOT NULL DEFAULT 0,
  claim_amount_minor INTEGER NOT NULL DEFAULT 0,
  variance_minor INTEGER NOT NULL DEFAULT 0,
  variance_pct NUMERIC(7, 2) NOT NULL DEFAULT 0,
  variance_category VARCHAR(40) NOT NULL DEFAULT 'match'
    CHECK (variance_category IN ('match', 'underpayment', 'overpayment', 'missing_contract', 'missing_payment', 'unknown')),
  variance_band VARCHAR(30) NOT NULL DEFAULT 'within_tolerance'
    CHECK (variance_band IN ('within_tolerance', 'review', 'investigate', 'escalate', 'unknown')),
  reason TEXT,
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'escalated')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '2555 days')
);

CREATE INDEX IF NOT EXISTS idx_payer_variance_tenant_created
  ON clinical_ai_payer_variance_reviews (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payer_variance_claim
  ON clinical_ai_payer_variance_reviews (tenant_id, claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payer_variance_decision
  ON clinical_ai_payer_variance_reviews (tenant_id, reviewer_decision, variance_band, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payer_variance_category_band
  ON clinical_ai_payer_variance_reviews (tenant_id, variance_category, variance_band, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('payer_contract_variance',
   'Payer Contract Variance / Underpayment AI',
   'Ingests contracted rates per payer + procedure and flags insurance claims where expected vs. paid amounts diverge — underpayment, overpayment, missing contract, or missing payment. Review-only: billing/insurance coordinator reviews and escalates; the service never auto-appeals or writes off a claim.',
   false,
   '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","INSURANCE_COORDINATOR","ADMIN","SUPER_ADMIN"],"approvalPolicy":"revenue_cycle_review","outputSchema":{"type":"object","required":["variance_category","variance_band","expected_amount_minor","paid_amount_minor"]},"retentionDays":2555,"default_tolerance_pct":2,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
