-- 299_live_schema_drift_archive.sql
--
-- Dalekdefender live-drift closure, 2026-06-12.
--
-- The live database had a handful of historical tables/columns that were not
-- present in the committed Prisma schema. This migration deliberately archives
-- row/value payloads before removing those unmanaged objects, and it refuses to
-- narrow intubation_grade if that would truncate data.
--
-- Required operator precondition before applying to production:
--   1. Take a logical backup (custom dump + schema dump).
--   2. Run check-db-contracts, ci-schema-drift, and check-schema-drift.
--   3. Review non-null counts for each target column.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_drift_archives (
  id                    BIGSERIAL PRIMARY KEY,
  archived_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by_migration VARCHAR(120) NOT NULL,
  source_table          VARCHAR(160) NOT NULL,
  source_column         VARCHAR(160),
  source_pk             VARCHAR(200),
  tenant_id             UUID,
  archive_reason        TEXT NOT NULL,
  row_data              JSONB NOT NULL,
  row_fingerprint       VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schema_drift_archives_source
  ON schema_drift_archives (source_table, source_column);

CREATE INDEX IF NOT EXISTS idx_schema_drift_archives_tenant
  ON schema_drift_archives (tenant_id, archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_schema_drift_archives_archived_at
  ON schema_drift_archives (archived_at DESC);

ALTER TABLE schema_drift_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_drift_archives FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON schema_drift_archives;
CREATE POLICY tenant_isolation ON schema_drift_archives
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE OR REPLACE FUNCTION public._vh_archive_schema_drift_relation(
  p_table text,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted integer := 0;
  v_sql text;
BEGIN
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN
    RAISE NOTICE 'schema drift archive: %.% not present, skipping', 'public', p_table;
    RETURN 0;
  END IF;

  v_sql := format($fmt$
    WITH source_rows AS (
      SELECT
        row_data,
        CASE
          WHEN row_data ? 'id' THEN row_data->>'id'
          WHEN row_data ? 'uid' THEN row_data->>'uid'
          WHEN row_data ? 'uuid' THEN row_data->>'uuid'
          ELSE md5(row_data::text)
        END AS source_pk,
        CASE
          WHEN row_data ? 'tenant_id'
            AND NULLIF(row_data->>'tenant_id', '') IS NOT NULL
            AND (row_data->>'tenant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (row_data->>'tenant_id')::uuid
          ELSE NULL::uuid
        END AS tenant_uuid
      FROM %I t
      CROSS JOIN LATERAL (SELECT to_jsonb(t) AS row_data) j
    ), archived AS (
      INSERT INTO schema_drift_archives (
        archived_by_migration, source_table, source_column, source_pk,
        tenant_id, archive_reason, row_data, row_fingerprint
      )
      SELECT
        '299_live_schema_drift_archive.sql',
        %L,
        NULL::varchar,
        source_pk,
        tenant_uuid,
        %L,
        row_data,
        md5(row_data::text)
      FROM source_rows
      RETURNING 1
    )
    SELECT COUNT(*)::int FROM archived
  $fmt$, p_table, p_table, p_reason);

  EXECUTE v_sql INTO v_inserted;
  RAISE NOTICE 'schema drift archive: archived % row(s) from %', v_inserted, p_table;
  RETURN v_inserted;
END
$$;

CREATE OR REPLACE FUNCTION public._vh_archive_schema_drift_column(
  p_table text,
  p_column text,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted integer := 0;
  v_sql text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = p_table
       AND column_name = p_column
  ) THEN
    RAISE NOTICE 'schema drift archive: %.% not present, skipping', p_table, p_column;
    RETURN 0;
  END IF;

  v_sql := format($fmt$
    WITH source_rows AS (
      SELECT
        row_data,
        CASE
          WHEN row_data ? 'id' THEN row_data->>'id'
          WHEN row_data ? 'uid' THEN row_data->>'uid'
          WHEN row_data ? 'uuid' THEN row_data->>'uuid'
          ELSE md5(row_data::text)
        END AS source_pk,
        CASE
          WHEN row_data ? 'tenant_id'
            AND NULLIF(row_data->>'tenant_id', '') IS NOT NULL
            AND (row_data->>'tenant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (row_data->>'tenant_id')::uuid
          ELSE NULL::uuid
        END AS tenant_uuid
      FROM %I t
      CROSS JOIN LATERAL (SELECT to_jsonb(t) AS row_data) j
      WHERE jsonb_typeof(row_data -> %L) <> 'null'
    ), archived AS (
      INSERT INTO schema_drift_archives (
        archived_by_migration, source_table, source_column, source_pk,
        tenant_id, archive_reason, row_data, row_fingerprint
      )
      SELECT
        '299_live_schema_drift_archive.sql',
        %L,
        %L,
        source_pk,
        tenant_uuid,
        %L,
        jsonb_build_object(
          'source_pk', source_pk,
          'column', %L,
          'value', row_data -> %L,
          'row_context', row_data - %L
        ),
        md5(jsonb_build_object(
          'source_pk', source_pk,
          'column', %L,
          'value', row_data -> %L,
          'row_context', row_data - %L
        )::text)
      FROM source_rows
      RETURNING 1
    )
    SELECT COUNT(*)::int FROM archived
  $fmt$, p_table, p_column, p_table, p_column, p_reason,
       p_column, p_column, p_column, p_column, p_column, p_column);

  EXECUTE v_sql INTO v_inserted;
  RAISE NOTICE 'schema drift archive: archived % non-null value(s) from %.%', v_inserted, p_table, p_column;
  RETURN v_inserted;
END
$$;

CREATE OR REPLACE FUNCTION public._vh_drop_schema_drift_relation(
  p_table text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_regclass(format('public.%I', p_table)) IS NOT NULL THEN
    EXECUTE format('DROP TABLE public.%I', p_table);
    RAISE NOTICE 'schema drift archive: dropped unmanaged table %', p_table;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public._vh_drop_schema_drift_column(
  p_table text,
  p_column text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = p_table
       AND column_name = p_column
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN %I', p_table, p_column);
    RAISE NOTICE 'schema drift archive: dropped unmanaged column %.%', p_table, p_column;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public._vh_drop_empty_schema_drift_column(
  p_table text,
  p_column text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = p_table
       AND column_name = p_column
  ) THEN
    RETURN;
  END IF;

  EXECUTE format('SELECT COUNT(*)::int FROM public.%I WHERE %I IS NOT NULL', p_table, p_column)
    INTO v_count;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop %.%: % non-null value(s) found. Archive/migrate the data first.',
      p_table, p_column, v_count;
  END IF;

  PERFORM public._vh_drop_schema_drift_column(p_table, p_column);
END
$$;

CREATE OR REPLACE FUNCTION public._vh_narrow_intubation_grade_if_safe()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_max_length integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'anesthesia_records'
       AND column_name = 'intubation_grade'
  ) THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX(length(intubation_grade)), 0)::int
    INTO v_max_length
    FROM anesthesia_records
   WHERE intubation_grade IS NOT NULL;

  IF v_max_length > 8 THEN
    RAISE EXCEPTION
      'Refusing to narrow anesthesia_records.intubation_grade to varchar(8): max length is %',
      v_max_length;
  END IF;

  ALTER TABLE anesthesia_records
    ALTER COLUMN intubation_grade TYPE VARCHAR(8);
END
$$;

SELECT public._vh_archive_schema_drift_relation(
  'admission_advice',
  'Live-only historical admission advice table. Canonical admission advice lives on the advised appointment/admission flow.'
);
SELECT public._vh_drop_schema_drift_relation('admission_advice');

SELECT public._vh_archive_schema_drift_relation(
  'admission_advices',
  'Live-only historical admission advices table. Canonical admission advice lives on the advised appointment/admission flow.'
);
SELECT public._vh_drop_empty_schema_drift_column('admissions', 'admission_advice_id');
SELECT public._vh_drop_schema_drift_relation('admission_advices');

SELECT public._vh_archive_schema_drift_relation(
  'admission_room_days',
  'Live-only historical room-day table. Canonical ward occupancy and billing links live on admissions, beds, bed_transfers, and billing tables.'
);
SELECT public._vh_drop_schema_drift_relation('admission_room_days');

SELECT public._vh_drop_empty_schema_drift_column('insurance_claims', 'admission_id');
SELECT public._vh_drop_empty_schema_drift_column('invoices', 'admission_id');

SELECT public._vh_archive_schema_drift_column(
  'preop_checklists',
  'admission_id',
  'Live-only historical admission link. Canonical preop checklist identity is tenant_id + ot_schedule_id.'
);
SELECT public._vh_drop_schema_drift_column('preop_checklists', 'admission_id');

SELECT public._vh_archive_schema_drift_column(
  'radiology_orders',
  'imaging_study_id',
  'Live-only historical integer imaging-study link. Canonical PACS linkage uses pacs_study_instance_uid and acquisition_evidence.'
);
SELECT public._vh_drop_schema_drift_column('radiology_orders', 'imaging_study_id');

SELECT public._vh_narrow_intubation_grade_if_safe();

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'LIVE_SCHEMA_DRIFT_ARCHIVED',
  'database',
  'dalekdefender',
  jsonb_build_object(
    'migration', '299_live_schema_drift_archive.sql',
    'backup_required', true,
    'archive_table', 'schema_drift_archives',
    'removed_tables', jsonb_build_array(
      'admission_advice',
      'admission_advices',
      'admission_room_days'
    ),
    'removed_columns', jsonb_build_array(
      'admissions.admission_advice_id',
      'insurance_claims.admission_id',
      'invoices.admission_id',
      'preop_checklists.admission_id',
      'radiology_orders.imaging_study_id'
    ),
    'narrowed_columns', jsonb_build_array('anesthesia_records.intubation_grade')
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
   WHERE action = 'LIVE_SCHEMA_DRIFT_ARCHIVED'
     AND resource = 'database'
     AND resource_id = 'dalekdefender'
);

DROP FUNCTION IF EXISTS public._vh_narrow_intubation_grade_if_safe();
DROP FUNCTION IF EXISTS public._vh_drop_empty_schema_drift_column(text, text);
DROP FUNCTION IF EXISTS public._vh_drop_schema_drift_column(text, text);
DROP FUNCTION IF EXISTS public._vh_drop_schema_drift_relation(text);
DROP FUNCTION IF EXISTS public._vh_archive_schema_drift_column(text, text, text);
DROP FUNCTION IF EXISTS public._vh_archive_schema_drift_relation(text, text);

COMMIT;
