-- 735: make migration checksums authoritative and keep the tracker owner-write,
-- runtime-read-only after every broad application-role grant.
--
-- The checksum-aware appliers seed legacy NULL rows before this migration runs.
-- Failing here instead of accepting a NULL prevents a name-only writer from
-- silently restoring the pre-734 integrity gap.

DO $migration_tracker_checksum_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public._migrations WHERE checksum IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'migration tracker contains NULL checksums; run the checksum-aware migration applier';
  END IF;
END
$migration_tracker_checksum_preflight$;

DO $migration_tracker_checksum_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public._migrations'::pg_catalog.regclass
       AND conname = 'migrations_checksum_sha256_format'
  ) THEN
    ALTER TABLE public._migrations
      ADD CONSTRAINT migrations_checksum_sha256_format
      CHECK (checksum ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END
$migration_tracker_checksum_constraint$;

ALTER TABLE public._migrations
  VALIDATE CONSTRAINT migrations_checksum_sha256_format;

ALTER TABLE public._migrations
  ALTER COLUMN checksum SET NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE public._migrations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public._migrations_id_seq FROM PUBLIC;

DO $migration_tracker_runtime_acl$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public._migrations FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public._migrations_id_seq FROM %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT SELECT ON TABLE public._migrations TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$migration_tracker_runtime_acl$;

COMMENT ON COLUMN public._migrations.checksum IS
  'LF-normalized SHA-256 of the immutable SQL migration file recorded by the owner applier.';
