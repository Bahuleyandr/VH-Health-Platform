-- Migration 353 — reconcile duplicate Clinical AI catalog rows and restore the
-- module_key primary-key invariant. Some live crash-loop reruns predated the
-- catalog pkey and duplicated module_key rows; keep the newest-updated row per
-- module_key, delete stale duplicates, then ensure the constraint that every
-- seed/upsert path relies on exists.

BEGIN;

LOCK TABLE clinical_ai_modules IN SHARE ROW EXCLUSIVE MODE;

-- Invalid for the catalog and incompatible with the intended PRIMARY KEY.
-- The original table definition declared module_key NOT NULL via PRIMARY KEY,
-- so any NULL here is drift/corruption rather than user-owned state.
DELETE FROM clinical_ai_modules
WHERE module_key IS NULL;

WITH ranked AS (
  SELECT
    ctid AS row_ctid,
    module_key,
    ROW_NUMBER() OVER (
      PARTITION BY module_key
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, ctid DESC
    ) AS keep_rank
  FROM clinical_ai_modules
)
DELETE FROM clinical_ai_modules m
USING ranked r
WHERE m.ctid = r.row_ctid
  AND r.keep_rank > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'clinical_ai_modules'::regclass
      AND conname = 'clinical_ai_modules_pkey'
  ) THEN
    ALTER TABLE clinical_ai_modules
      ADD CONSTRAINT clinical_ai_modules_pkey PRIMARY KEY (module_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clinical_ai_modules_enabled
  ON clinical_ai_modules(enabled, module_key);

COMMIT;
