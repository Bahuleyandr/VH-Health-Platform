-- Migration 647: tenant-scoped canonical ABHA number uniqueness.
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
    RAISE EXCEPTION
      'Cannot enforce tenant-scoped ABHA uniqueness: duplicate canonical ABHA rows require reconciliation';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_tenant_abha_number_canonical
  ON users (tenant_id, (regexp_replace(abha_number, '-', '', 'g')))
  WHERE abha_number IS NOT NULL AND btrim(abha_number) <> '';
