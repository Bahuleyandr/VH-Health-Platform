-- Migration 153: Insurance / TPA pre-auth + cashless claim + reimbursement
-- workflow (Sprint 5).
--
-- Indian hospital insurance is dominated by TPAs (Third-Party
-- Administrators) — Medi Assist, FHPL, Vidal, Heritage, Star Health,
-- Paramount, etc. The cashless flow is:
--
--   1. Pre-auth — hospital sends admission details + diagnosis +
--      proposed procedure + cost estimate. TPA replies APPROVED /
--      PARTIALLY_APPROVED / QUERY / DENIED with a sanctioned amount
--      and validity window.
--   2. Enhancements — mid-stay, hospital can request more if treatment
--      runs longer or new procedures are added. TPA approves another
--      delta or denies.
--   3. Discharge claim — final bill + documents (discharge summary,
--      OT notes, ID) submitted. TPA approves a final settlement
--      amount and pays the hospital directly. Co-pay (if any) is
--      collected from the patient.
--   4. Reimbursement — patient paid out of pocket and files claim
--      after discharge. Hospital still issues docs but doesn't get
--      paid by TPA; tracked here so the front desk knows the
--      paperwork was given.
--
-- payers + tpas master tables from migration 119 are reused. This
-- migration adds the per-encounter workflow tables.

BEGIN;

-- ── 1. Patient policy details ────────────────────────────────────────
-- Captured at registration / admission. Linked into pre-auth and
-- claim rows so the policy doesn't need to be re-typed each time.
CREATE TABLE IF NOT EXISTS insurance_policies (
  id                  SERIAL PRIMARY KEY,
  patient_uid         UUID NOT NULL,
  payer_id            INTEGER REFERENCES payers(id) ON DELETE SET NULL,
  tpa_id              INTEGER REFERENCES tpas(id) ON DELETE SET NULL,
  policy_number       VARCHAR(80) NOT NULL,
  member_id           VARCHAR(80),
  policyholder_name   VARCHAR(120),
  relation_to_patient VARCHAR(40),                   -- self / spouse / parent / child / dependent
  policy_type         VARCHAR(40),                   -- individual / family / corporate / govt_scheme
  corporate_employer  VARCHAR(160),                  -- if corporate group cover
  sum_insured         NUMERIC(14, 2),
  cumulative_used     NUMERIC(14, 2) DEFAULT 0,      -- amount used this policy year
  valid_from          DATE,
  valid_to            DATE,
  card_url            TEXT,                          -- scanned insurance card
  status              VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'cancelled')),
  notes               TEXT,
  created_by          UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_policies_patient
  ON insurance_policies(patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_policy_number
  ON insurance_policies(policy_number);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_payer
  ON insurance_policies(payer_id) WHERE payer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insurance_policies_tpa
  ON insurance_policies(tpa_id) WHERE tpa_id IS NOT NULL;

-- ── 2. Pre-authorization requests ────────────────────────────────────
-- One per admission usually; for OPD high-value procedures (chemo,
-- dialysis, CT/MRI under cover) also possible.
CREATE TABLE IF NOT EXISTS insurance_preauth (
  id                  SERIAL PRIMARY KEY,
  policy_id           INTEGER NOT NULL REFERENCES insurance_policies(id) ON DELETE RESTRICT,
  patient_uid         UUID NOT NULL,
  admission_id        INTEGER,                       -- ip_admissions(id), nullable for OPD pre-auth
  preauth_number      VARCHAR(80) UNIQUE NOT NULL,   -- our internal sequence; e.g. PA-2526-00042
  tpa_reference_id    VARCHAR(120),                  -- TPA's claim id once submitted
  request_type        VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (request_type IN ('planned', 'emergency', 'enhancement')),
  parent_preauth_id   INTEGER REFERENCES insurance_preauth(id) ON DELETE SET NULL,
                                                     -- non-null when this is an enhancement
  -- Clinical
  primary_diagnosis   TEXT NOT NULL,
  icd10_codes         TEXT[],                        -- multi-select; helps audit later
  proposed_procedure  TEXT,
  procedure_codes     TEXT[],                        -- CPT or local procedure codes
  treating_doctor_uid UUID,
  treating_doctor_name VARCHAR(160),
  expected_admission_date DATE,
  expected_los_days   INTEGER,
  -- Financial
  expected_cost       NUMERIC(14, 2) NOT NULL,
  cost_breakdown      JSONB DEFAULT '{}'::jsonb,     -- room/medicines/investigations/surgery split
  -- Workflow
  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'queried', 'approved',
                      'partially_approved', 'denied', 'cancelled', 'lapsed')),
  sanctioned_amount   NUMERIC(14, 2),                -- whatever TPA finally approved
  sanctioned_at       TIMESTAMPTZ,
  validity_until      TIMESTAMPTZ,                   -- usually +5d after admission
  query_text          TEXT,                          -- TPA's "we need more info" note
  denial_reason       TEXT,
  -- Audit
  submitted_at        TIMESTAMPTZ,
  submitted_by        UUID,
  submission_channel  VARCHAR(20),                   -- portal / email / fax
  notes               TEXT,
  created_by          UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_preauth_patient
  ON insurance_preauth(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insurance_preauth_admission
  ON insurance_preauth(admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insurance_preauth_status
  ON insurance_preauth(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insurance_preauth_pending
  ON insurance_preauth(tenant_id, status)
  WHERE status IN ('submitted', 'queried');

-- Insurance pre-auth number sequence (per tenant, per fiscal year).
CREATE TABLE IF NOT EXISTS insurance_preauth_counter (
  tenant_id    UUID NOT NULL,
  fiscal_year  VARCHAR(10) NOT NULL,
  next_value   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, fiscal_year)
);

-- ── 3. Pre-auth responses (history + audit) ──────────────────────────
-- Each TPA reply on a pre-auth (initial decision, query, enhancement)
-- gets its own row so the timeline is reconstructible.
CREATE TABLE IF NOT EXISTS insurance_preauth_responses (
  id                  SERIAL PRIMARY KEY,
  preauth_id          INTEGER NOT NULL REFERENCES insurance_preauth(id) ON DELETE CASCADE,
  response_type       VARCHAR(20) NOT NULL
    CHECK (response_type IN ('approved', 'partially_approved',
                             'denied', 'queried', 'enhancement_request')),
  sanctioned_amount   NUMERIC(14, 2),
  validity_until      TIMESTAMPTZ,
  conditions          TEXT,                          -- "co-pay 10%", "single AC room only"
  query_text          TEXT,
  denial_reason       TEXT,
  raw_response        JSONB DEFAULT '{}'::jsonb,     -- full TPA payload if portal API
  decided_by_tpa_user VARCHAR(160),                  -- TPA-side reviewer name
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by         UUID,                          -- our user who logged the response
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_preauth_resp_preauth
  ON insurance_preauth_responses(preauth_id, decided_at DESC);

-- ── 4. Final claims (cashless + reimbursement) ───────────────────────
CREATE TABLE IF NOT EXISTS insurance_claims (
  id                  SERIAL PRIMARY KEY,
  claim_number        VARCHAR(80) UNIQUE NOT NULL,   -- our internal; e.g. CL-2526-00042
  policy_id           INTEGER NOT NULL REFERENCES insurance_policies(id) ON DELETE RESTRICT,
  preauth_id          INTEGER REFERENCES insurance_preauth(id) ON DELETE SET NULL,
                                                     -- null only for pure reimbursement
  invoice_id          INTEGER REFERENCES billing_invoices(id) ON DELETE SET NULL,
  patient_uid         UUID NOT NULL,
  admission_id        INTEGER,
  claim_type          VARCHAR(20) NOT NULL DEFAULT 'cashless'
    CHECK (claim_type IN ('cashless', 'reimbursement')),
  -- Bill data captured at submission time (so claim is reproducible)
  total_billed        NUMERIC(14, 2) NOT NULL,
  patient_copay       NUMERIC(14, 2) DEFAULT 0,
  non_payable_amount  NUMERIC(14, 2) DEFAULT 0,      -- food, attendant, etc. exclusions
  claimed_amount      NUMERIC(14, 2) NOT NULL,       -- what we ask the TPA for
  -- TPA decision
  tpa_reference_id    VARCHAR(120),
  status              VARCHAR(20) NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'submitted', 'queried',
                      'approved', 'partially_approved', 'denied',
                      'paid', 'closed', 'cancelled')),
  approved_amount     NUMERIC(14, 2),
  paid_amount         NUMERIC(14, 2),
  paid_at             TIMESTAMPTZ,
  payment_reference   VARCHAR(160),                  -- TPA's UTR / cheque no / NEFT ref
  denial_reason       TEXT,
  -- Audit
  submitted_at        TIMESTAMPTZ,
  submitted_by        UUID,
  submission_channel  VARCHAR(20),
  notes               TEXT,
  created_by          UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_patient
  ON insurance_claims(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_admission
  ON insurance_claims(admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insurance_claims_status
  ON insurance_claims(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_outstanding
  ON insurance_claims(tenant_id, status)
  WHERE status IN ('submitted', 'queried', 'approved', 'partially_approved');

CREATE TABLE IF NOT EXISTS insurance_claim_counter (
  tenant_id    UUID NOT NULL,
  fiscal_year  VARCHAR(10) NOT NULL,
  next_value   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, fiscal_year)
);

-- ── 5. Claim documents ───────────────────────────────────────────────
-- Discharge summary, OT notes, investigations, ID proof, signed form,
-- final bill, etc. Stored in R2 / S3; we keep the URL + metadata.
CREATE TABLE IF NOT EXISTS insurance_claim_documents (
  id                  SERIAL PRIMARY KEY,
  claim_id            INTEGER REFERENCES insurance_claims(id) ON DELETE CASCADE,
  preauth_id          INTEGER REFERENCES insurance_preauth(id) ON DELETE CASCADE,
  doc_type            VARCHAR(40) NOT NULL,          -- discharge_summary / ot_notes / final_bill / id_proof / lab_report / radiology / signed_form / other
  file_name           VARCHAR(255) NOT NULL,
  file_url            TEXT NOT NULL,
  file_size_bytes     BIGINT,
  mime_type           VARCHAR(120),
  uploaded_by         UUID,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes               TEXT,
  CONSTRAINT chk_claim_doc_attaches_one CHECK (
    (claim_id IS NOT NULL) OR (preauth_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_claim_docs_claim
  ON insurance_claim_documents(claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_docs_preauth
  ON insurance_claim_documents(preauth_id) WHERE preauth_id IS NOT NULL;

-- ── 6. Correspondence log (inbound + outbound) ───────────────────────
-- Every email / portal note / phone call / letter logged so the
-- coordinator has a paper trail when TPAs play games.
CREATE TABLE IF NOT EXISTS insurance_claim_correspondence (
  id                  SERIAL PRIMARY KEY,
  claim_id            INTEGER REFERENCES insurance_claims(id) ON DELETE CASCADE,
  preauth_id          INTEGER REFERENCES insurance_preauth(id) ON DELETE CASCADE,
  direction           VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel             VARCHAR(20) NOT NULL,          -- email / portal / phone / letter / fax
  subject             VARCHAR(255),
  body                TEXT,
  attachments         JSONB DEFAULT '[]'::jsonb,
  recorded_by         UUID,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_claim_corr_attaches_one CHECK (
    (claim_id IS NOT NULL) OR (preauth_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_claim_corr_claim
  ON insurance_claim_correspondence(claim_id, recorded_at DESC) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_corr_preauth
  ON insurance_claim_correspondence(preauth_id, recorded_at DESC) WHERE preauth_id IS NOT NULL;

-- ── 7. Claim aging view — for the coordinator dashboard ─────────────
CREATE OR REPLACE VIEW insurance_claims_aging AS
SELECT
  c.id, c.claim_number, c.patient_uid, c.claim_type,
  c.status, c.claimed_amount, c.approved_amount, c.paid_amount,
  c.submitted_at,
  EXTRACT(EPOCH FROM (NOW() - COALESCE(c.submitted_at, c.created_at))) / 86400 AS days_since_submit,
  CASE
    WHEN c.status = 'paid' THEN 'paid'
    WHEN c.status = 'denied' THEN 'denied'
    WHEN COALESCE(c.submitted_at, c.created_at) < NOW() - INTERVAL '30 days' THEN '30+_days_aging'
    WHEN COALESCE(c.submitted_at, c.created_at) < NOW() - INTERVAL '15 days' THEN '15-30_days_aging'
    ELSE 'fresh'
  END AS aging_bucket,
  p.policy_number, p.payer_id, p.tpa_id,
  c.tenant_id
FROM insurance_claims c
JOIN insurance_policies p ON p.id = c.policy_id;

COMMIT;
