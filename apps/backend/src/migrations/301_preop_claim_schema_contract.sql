-- 301_preop_claim_schema_contract.sql
--
-- Close residual live/schema drift found after the Dalekdefender archive
-- migration. The columns are used by theatre readiness code, and the
-- insurance_claims invoice index exists on live, so this migration makes the
-- committed contract explicit for clean environments while remaining no-op on
-- Dalekdefender.

BEGIN;

ALTER TABLE preop_checklists
  ADD COLUMN IF NOT EXISTS site_marked_side VARCHAR(80),
  ADD COLUMN IF NOT EXISTS vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS iv_access_secured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS eye_drops_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preop_glucose_mg_dl INTEGER,
  ADD COLUMN IF NOT EXISTS ot_ready BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS insurance_claims_invoice_id_idx
  ON insurance_claims(invoice_id);

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'SCHEMA_CONTRACT_CATCHUP',
  'database',
  'preop_claim_schema_contract',
  jsonb_build_object(
    'migration', '301_preop_claim_schema_contract.sql',
    'tables', jsonb_build_array('preop_checklists', 'insurance_claims')
  ),
  NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'SCHEMA_CONTRACT_CATCHUP'
     AND resource = 'database'
     AND resource_id = 'preop_claim_schema_contract'
);

COMMIT;
