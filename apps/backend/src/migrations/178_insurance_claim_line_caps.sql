-- 178_insurance_claim_line_caps.sql
--
-- A11 — structured per-category caps for TPA / insurance claims.
--
-- Background: batch 9 (b49a3ae5) added a jsonb merge of partial-approval
-- caps into insurance_claims.documents so the data wasn't lost on
-- claim update. That works for record-keeping but isn't queryable
-- against invoice lines at billing time. Per-line enforcement needs
-- structured rows so:
--
--   1. The biller can fetch (claim_id, category) → max_amount with
--      a single index lookup.
--   2. Reports can aggregate caps across claims by category
--      ("total approved pharmacy across all live claims").
--   3. A revision (TPA bumped pharmacy from 15000 to 18000) can be
--      written without re-stringifying the whole jsonb.
--
-- Categories mirror the invoice-line buckets billing already uses:
--   room_rent | pharmacy | investigations | consultation |
--   procedure | implants | radiology | physiotherapy | other
--
-- One row per (claim, category). Repeat upserts replace the row and
-- bump updated_at for the audit trail.
--
-- Architectural item A11. Spans multiple findings — closes the
-- structured-data gap left after batch 9 ("caps merge").

BEGIN;

CREATE TABLE IF NOT EXISTS insurance_claim_caps (
  id          SERIAL PRIMARY KEY,
  claim_id    INTEGER NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
  category    VARCHAR(60) NOT NULL,
    -- room_rent | pharmacy | investigations | consultation |
    -- procedure | implants | radiology | physiotherapy | other
  max_amount  NUMERIC(10, 2) NOT NULL,
  currency    VARCHAR(3) NOT NULL DEFAULT 'INR',
  source      VARCHAR(40) NOT NULL DEFAULT 'tpa_preauth',
    -- tpa_preauth | tpa_revision | policy_default | manual_override
  notes       TEXT,
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (claim_id, category)
);

CREATE INDEX IF NOT EXISTS idx_insurance_claim_caps_claim
  ON insurance_claim_caps(claim_id);
CREATE INDEX IF NOT EXISTS idx_insurance_claim_caps_category
  ON insurance_claim_caps(category, claim_id);

COMMIT;
