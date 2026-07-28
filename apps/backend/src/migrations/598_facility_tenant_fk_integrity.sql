-- Migration 598: facility-belongs-to-tenant integrity (composite FKs).
--
-- @no-transaction
--
-- 2026-07-28 review finding: nothing at the database level forces a
-- facility-referencing row to point at a facility of its OWN tenant.
-- `facilities` (migration 121) has UNIQUE (tenant_id, facility_code) but
-- no (tenant_id, id) anchor, so none of the facility_id FKs could be
-- tenant-scoped and a row in tenant A could reference tenant B's
-- facility. Exactly six tables carry a single-column FK to
-- facilities(id): facility_locations, facility_rooms, service_catalog
-- (121), appointment_queues, lab_analyzers (260), and
-- queue_display_profiles (450).
--
-- What this migration does, in order:
--   1. Adds the `ux_facilities_tenant_id` (tenant_id, id) anchor that the
--      composite FKs target (the 2026-07-28 clinical-service-continuity
--      design §6.8 needs this same anchor for its new tables).
--   2. Adds composite (tenant_id, facility_id) FKs NOT VALID on the six
--      tables, preserving each original FK's delete behavior — CASCADE
--      stays CASCADE; the SET NULL cases use the PG15+ column list
--      `SET NULL (facility_id)` so a facility delete can never null
--      tenant_id. From the moment these commit, NEW cross-tenant writes
--      are rejected even though existing rows are not yet checked.
--   3. Scans for pre-existing cross-tenant rows and, if any exist,
--      RAISEs with a per-table report (counts + up to 20 sample rows).
--      Nothing is deleted or rewritten; the migration stays unrecorded
--      so it re-runs after an operator resolves the reported rows.
--   4. Validates the six constraints (SHARE UPDATE EXCLUSIVE only — no
--      write outage on live tables).
--   5. Drops the now-redundant single-column facility_id FKs, matched by
--      shape rather than name so both baseline-built and 121/260/450-
--      built databases are handled.
--
-- The @no-transaction directive makes the boot runner apply each
-- statement on the session, so each ADD CONSTRAINT ... NOT VALID commits
-- its brief ACCESS EXCLUSIVE lock immediately and VALIDATE never holds
-- one. Every statement is therefore written re-runnable (guarded /
-- IF NOT EXISTS / no-op on repeat), as runMigrations.js requires for
-- this mode. ci-setup-db.mjs ignores the directive and wraps the file in
-- one transaction — every statement here is legal in that mode too.

-- ---------------------------------------------------------------------------
-- 1. (tenant_id, id) anchor on facilities. id alone is the PK, so this
--    index cannot encounter duplicates.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ux_facilities_tenant_id
  ON facilities (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. Composite tenant-scoped FKs, NOT VALID. Guarded so re-runs skip.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'facility_locations'::regclass
       AND conname = 'fk_facility_locations_facility_tenant'
  ) THEN
    ALTER TABLE facility_locations
      ADD CONSTRAINT fk_facility_locations_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'facility_rooms'::regclass
       AND conname = 'fk_facility_rooms_facility_tenant'
  ) THEN
    ALTER TABLE facility_rooms
      ADD CONSTRAINT fk_facility_rooms_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'service_catalog'::regclass
       AND conname = 'fk_service_catalog_facility_tenant'
  ) THEN
    ALTER TABLE service_catalog
      ADD CONSTRAINT fk_service_catalog_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'appointment_queues'::regclass
       AND conname = 'fk_appointment_queues_facility_tenant'
  ) THEN
    ALTER TABLE appointment_queues
      ADD CONSTRAINT fk_appointment_queues_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE SET NULL (facility_id)
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_analyzers'::regclass
       AND conname = 'fk_lab_analyzers_facility_tenant'
  ) THEN
    ALTER TABLE lab_analyzers
      ADD CONSTRAINT fk_lab_analyzers_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE SET NULL (facility_id)
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'queue_display_profiles'::regclass
       AND conname = 'fk_queue_display_profiles_facility_tenant'
  ) THEN
    ALTER TABLE queue_display_profiles
      ADD CONSTRAINT fk_queue_display_profiles_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE SET NULL (facility_id)
      NOT VALID;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Report pre-existing cross-tenant rows; abort (loudly, deleting
--    nothing) before VALIDATE if any exist. The RAISE message is the
--    report channel — the runner surfaces it in the migration failure.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
  bad_count BIGINT;
  samples TEXT;
  report TEXT := '';
  total BIGINT := 0;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'facility_locations', 'facility_rooms', 'service_catalog',
    'appointment_queues', 'lab_analyzers', 'queue_display_profiles'
  ]
  LOOP
    EXECUTE format(
      'WITH bad AS (
         SELECT child.id AS row_id,
                child.tenant_id AS row_tenant,
                child.facility_id AS facility_id,
                f.tenant_id AS facility_tenant
           FROM %I child
           JOIN facilities f ON f.id = child.facility_id
          WHERE child.facility_id IS NOT NULL
            AND f.tenant_id IS DISTINCT FROM child.tenant_id
       )
       SELECT COUNT(*),
              (SELECT string_agg(
                        ''    '' || %L || '' id='' || b.row_id::text
                        || '' tenant='' || b.row_tenant::text
                        || '' -> facility id='' || b.facility_id::text
                        || '' owned by tenant='' || b.facility_tenant::text,
                        E''\n'')
                 FROM (SELECT * FROM bad LIMIT 20) b)
         FROM bad',
      tbl, tbl)
    INTO bad_count, samples;

    IF bad_count > 0 THEN
      total := total + bad_count;
      report := report
        || format(E'  %s: %s cross-tenant facility reference(s)\n', tbl, bad_count)
        || COALESCE(samples || E'\n', '');
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION E'migration 598: % cross-tenant facility reference(s) found — refusing to validate.\n%No rows were deleted or modified. The NOT VALID composite FKs added by this migration already reject NEW cross-tenant writes. Reassign each row above to a facility of its own tenant (operator decision — do not bulk-delete), then re-run this migration.',
      total, report;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Validate — only reached when the scan above found nothing.
--    Validating an already-valid constraint is a no-op, so re-runs pass.
-- ---------------------------------------------------------------------------

ALTER TABLE facility_locations
  VALIDATE CONSTRAINT fk_facility_locations_facility_tenant;
ALTER TABLE facility_rooms
  VALIDATE CONSTRAINT fk_facility_rooms_facility_tenant;
ALTER TABLE service_catalog
  VALIDATE CONSTRAINT fk_service_catalog_facility_tenant;
ALTER TABLE appointment_queues
  VALIDATE CONSTRAINT fk_appointment_queues_facility_tenant;
ALTER TABLE lab_analyzers
  VALIDATE CONSTRAINT fk_lab_analyzers_facility_tenant;
ALTER TABLE queue_display_profiles
  VALIDATE CONSTRAINT fk_queue_display_profiles_facility_tenant;

-- ---------------------------------------------------------------------------
-- 5. Drop the superseded single-column facility_id FKs. Matched by shape
--    (single-column FK on facility_id whose target is facilities), not by
--    name: baseline-built DBs carry pg_dump names, 121/260/450-built DBs
--    carry inline auto-names. The composite FKs above are two-column and
--    can never match. No-op on re-run.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
  con RECORD;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'facility_locations', 'facility_rooms', 'service_catalog',
    'appointment_queues', 'lab_analyzers', 'queue_display_profiles'
  ]
  LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid = tbl::regclass
         AND c.confrelid = 'facilities'::regclass
         AND array_length(c.conkey, 1) = 1
         AND c.conkey[1] = (
               SELECT a.attnum
                 FROM pg_attribute a
                WHERE a.attrelid = tbl::regclass
                  AND a.attname = 'facility_id'
             )
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con.conname);
    END LOOP;
  END LOOP;
END
$$;
