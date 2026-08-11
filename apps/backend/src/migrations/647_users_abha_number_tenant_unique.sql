-- Migration 647: tenant-scoped canonical ABHA number uniqueness.
--
-- @no-transaction
-- @statement_timeout: 0
--
-- The linkage service stores new ABHA numbers in 2-4-4-4 hyphenated form but
-- must continue to recognize legacy digit-only rows. Its pre-write duplicate
-- probe is useful for a friendly error, but it cannot prevent two concurrent
-- requests from both observing no match and committing the same national
-- identifier to different patients. This expression index is the atomic
-- backstop for both spellings.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM users
     WHERE abha_number IS NOT NULL
       AND btrim(abha_number) <> ''
     GROUP BY tenant_id, regexp_replace(abha_number, '-', '', 'g')
    HAVING count(*) > 1
  ) THEN
    RAISE WARNING
      'Duplicate canonical ABHA rows exist; scripts/abdm-preflight.mjs must be clean before this index is deployed';
  END IF;
END
$$;

-- An interrupted concurrent build can leave an INVALID same-name index.
-- Move only that unusable remnant aside, then drop it concurrently so replay
-- cannot mistake it for an enforced uniqueness guarantee.
DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_abha_canonical_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('public.uniq_users_tenant_abha_number_canonical')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.uniq_users_tenant_abha_number_canonical
      RENAME TO uniq_users_abha_canonical_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.uniq_users_abha_canonical_invalid_rebuild;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_users_tenant_abha_number_canonical
  ON users (tenant_id, (regexp_replace(abha_number, '-', '', 'g')))
  WHERE abha_number IS NOT NULL AND btrim(abha_number) <> '';
