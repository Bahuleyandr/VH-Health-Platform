-- Migration 582: durable, sender-scoped HL7 ORU message identity.
--
-- A row-level OBX unique index cannot distinguish an exact replay from a later
-- subset/superset carrying the same MSH-10. The message claim below owns the
-- canonical full-message fingerprint and cardinality; the OBX index remains a
-- second line of defence. Existing clinical data is never rewritten or deleted
-- by this migration: every incompatible legacy shape fails closed with samples.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  invalid_row_count BIGINT;
  invalid_row_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_row_count
    FROM lab_results
   WHERE (hl7_message_id IS NULL) <> (hl7_segment_index IS NULL)
      OR (
           hl7_message_id IS NOT NULL
           AND (
             NULLIF(BTRIM(performed_by_lab), '') IS NULL
             OR NULLIF(BTRIM(hl7_message_id), '') IS NULL
             OR performed_by_lab IS DISTINCT FROM BTRIM(performed_by_lab)
             OR hl7_message_id IS DISTINCT FROM BTRIM(hl7_message_id)
             OR hl7_segment_index <= 0
           )
         );

  IF invalid_row_count > 0 THEN
    SELECT string_agg(
             format(
               'id=%s tenant=%s sender=%s message=%s segment=%s',
               id,
               tenant_id,
               COALESCE(performed_by_lab, '<null>'),
               COALESCE(hl7_message_id, '<null>'),
               COALESCE(hl7_segment_index::text, '<null>')
             ),
             '; '
             ORDER BY id
           )
      INTO invalid_row_samples
      FROM (
        SELECT id, tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index
          FROM lab_results
         WHERE (hl7_message_id IS NULL) <> (hl7_segment_index IS NULL)
            OR (
                 hl7_message_id IS NOT NULL
                 AND (
                    NULLIF(BTRIM(performed_by_lab), '') IS NULL
                    OR NULLIF(BTRIM(hl7_message_id), '') IS NULL
                    OR performed_by_lab IS DISTINCT FROM BTRIM(performed_by_lab)
                    OR hl7_message_id IS DISTINCT FROM BTRIM(hl7_message_id)
                    OR hl7_segment_index <= 0
                 )
               )
         ORDER BY id
         LIMIT 5
      ) AS sampled_invalid_rows;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot install ORU replay identity: %s lab result row(s) have an incomplete replay key',
        invalid_row_count
      ),
      DETAIL = format('Sample invalid rows: %s', COALESCE(invalid_row_samples, 'none')),
      HINT = 'Review and reconcile the sender/message/segment identity; this migration never rewrites clinical data.';
  END IF;
END
$$;

DO $$
DECLARE
  duplicate_group_count BIGINT;
  duplicate_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO duplicate_group_count
    FROM (
      SELECT tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index
        FROM lab_results
       WHERE performed_by_lab IS NOT NULL
         AND hl7_message_id IS NOT NULL
         AND hl7_segment_index IS NOT NULL
       GROUP BY tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index
      HAVING COUNT(*) > 1
    ) AS duplicate_groups;

  IF duplicate_group_count > 0 THEN
    SELECT string_agg(
             format(
               'tenant=%s sender=%s message=%s segment=%s rows=%s',
               tenant_id,
               performed_by_lab,
               hl7_message_id,
               hl7_segment_index,
               row_count
             ),
             '; '
             ORDER BY tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index
           )
      INTO duplicate_samples
      FROM (
        SELECT tenant_id,
               performed_by_lab,
               hl7_message_id,
               hl7_segment_index,
               COUNT(*) AS row_count
          FROM lab_results
         WHERE performed_by_lab IS NOT NULL
           AND hl7_message_id IS NOT NULL
           AND hl7_segment_index IS NOT NULL
         GROUP BY tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index
        HAVING COUNT(*) > 1
         ORDER BY tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index
         LIMIT 5
      ) AS sampled_duplicate_groups;

    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'Cannot install ORU replay identity: %s duplicate lab-result group(s) exist',
        duplicate_group_count
      ),
      DETAIL = format('Sample duplicate groups: %s', COALESCE(duplicate_samples, 'none')),
      HINT = 'Review and reconcile the duplicate clinical results; this migration never deletes clinical data.';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'ck_lab_results_hl7_replay_identity_complete'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT ck_lab_results_hl7_replay_identity_complete
      CHECK (
        (hl7_message_id IS NULL AND hl7_segment_index IS NULL)
        OR (
          NULLIF(BTRIM(performed_by_lab), '') IS NOT NULL
          AND NULLIF(BTRIM(hl7_message_id), '') IS NOT NULL
          AND performed_by_lab = BTRIM(performed_by_lab)
          AND hl7_message_id = BTRIM(hl7_message_id)
          AND hl7_segment_index > 0
        )
      );
  END IF;
END
$$;

DO $$
DECLARE
  migration_schema TEXT := current_schema();
  replay_index REGCLASS;
  replay_index_row pg_index%ROWTYPE;
BEGIN
  replay_index := to_regclass(format('%I.%I', migration_schema, 'uq_lab_results_hl7_message_segment'));
  IF replay_index IS NULL THEN
    EXECUTE $index$
      CREATE UNIQUE INDEX uq_lab_results_hl7_message_segment
        ON lab_results (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index)
        WHERE performed_by_lab IS NOT NULL
          AND hl7_message_id IS NOT NULL
          AND hl7_segment_index IS NOT NULL
    $index$;
    replay_index := to_regclass(format('%I.%I', migration_schema, 'uq_lab_results_hl7_message_segment'));
  END IF;

  SELECT *
    INTO replay_index_row
    FROM pg_index
   WHERE indexrelid = replay_index;

  IF replay_index_row.indrelid IS DISTINCT FROM 'lab_results'::regclass
     OR replay_index_row.indisunique IS DISTINCT FROM TRUE
     OR replay_index_row.indisvalid IS DISTINCT FROM TRUE
     OR replay_index_row.indisready IS DISTINCT FROM TRUE
     OR replay_index_row.indnkeyatts IS DISTINCT FROM 4
     OR pg_get_indexdef(replay_index, 1, TRUE) IS DISTINCT FROM 'tenant_id'
     OR pg_get_indexdef(replay_index, 2, TRUE) IS DISTINCT FROM 'performed_by_lab'
     OR pg_get_indexdef(replay_index, 3, TRUE) IS DISTINCT FROM 'hl7_message_id'
     OR pg_get_indexdef(replay_index, 4, TRUE) IS DISTINCT FROM 'hl7_segment_index'
     OR pg_get_expr(replay_index_row.indpred, replay_index_row.indrelid)
          IS DISTINCT FROM
            '((performed_by_lab IS NOT NULL) AND (hl7_message_id IS NOT NULL) AND (hl7_segment_index IS NOT NULL))'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'uq_lab_results_hl7_message_segment has an incompatible definition';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS lab_oru_ingest_messages (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id                UUID NOT NULL,
  trusted_sender_identity  VARCHAR(120) NOT NULL,
  message_control_id       VARCHAR(100) NOT NULL,
  raw_message              TEXT NOT NULL,
  message_sha256           TEXT GENERATED ALWAYS AS (
    encode(digest(raw_message, 'sha256'), 'hex')
  ) STORED NOT NULL,
  obx_count                INTEGER NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'processing',
  result_ids               INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  critical_result_ids      INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  active_critical_result_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  closed_critical_result_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  alert_ids                INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  task_ids                 INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  sla_instance_ids         UUID[] NOT NULL DEFAULT '{}'::uuid[],
  closed_alert_ids         INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  closed_task_ids          INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  closed_sla_instance_ids  UUID[] NOT NULL DEFAULT '{}'::uuid[],
  legacy_adoption          BOOLEAN NOT NULL DEFAULT false,
  authenticated_actor_uid  UUID NOT NULL,
  authenticated_actor_roles TEXT[] NOT NULL DEFAULT '{}'::text[],
  sender_binding_mode      VARCHAR(20) NOT NULL,
  sender_binding_identity  VARCHAR(255) NOT NULL,
  completed_at             TIMESTAMPTZ(6),
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_lab_oru_ingest_messages_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_lab_oru_ingest_messages_sender
    FOREIGN KEY (tenant_id, trusted_sender_identity)
    REFERENCES lab_analyzers(tenant_id, analyzer_code)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_lab_oru_ingest_messages_actor
    FOREIGN KEY (tenant_id, authenticated_actor_uid)
    REFERENCES users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_lab_oru_ingest_messages_sender_control
    UNIQUE (tenant_id, trusted_sender_identity, message_control_id),
  CONSTRAINT ux_lab_oru_ingest_messages_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ck_lab_oru_ingest_messages_sender
    CHECK (
      NULLIF(BTRIM(trusted_sender_identity), '') IS NOT NULL
      AND trusted_sender_identity = BTRIM(trusted_sender_identity)
    ),
  CONSTRAINT ck_lab_oru_ingest_messages_control
    CHECK (
      NULLIF(BTRIM(message_control_id), '') IS NOT NULL
      AND message_control_id = BTRIM(message_control_id)
    ),
  CONSTRAINT ck_lab_oru_ingest_messages_obx_count
    CHECK (obx_count > 0),
  CONSTRAINT ck_lab_oru_ingest_messages_actor_roles
    CHECK (cardinality(authenticated_actor_roles) > 0),
  CONSTRAINT ck_lab_oru_ingest_messages_sender_binding
    CHECK (
      sender_binding_mode IN ('api_client', 'actor_uid')
      AND NULLIF(BTRIM(sender_binding_identity), '') IS NOT NULL
    ),
  CONSTRAINT ck_lab_oru_ingest_messages_artifact_cardinality
    CHECK (
      cardinality(active_critical_result_ids) = cardinality(alert_ids)
      AND cardinality(alert_ids) = cardinality(task_ids)
      AND cardinality(alert_ids) = cardinality(sla_instance_ids)
      AND cardinality(closed_critical_result_ids) = cardinality(closed_alert_ids)
      AND cardinality(closed_alert_ids) = cardinality(closed_task_ids)
      AND cardinality(closed_alert_ids) = cardinality(closed_sla_instance_ids)
      AND cardinality(critical_result_ids) =
            cardinality(active_critical_result_ids) + cardinality(closed_critical_result_ids)
      AND (legacy_adoption OR cardinality(closed_critical_result_ids) = 0)
    ),
  CONSTRAINT ck_lab_oru_ingest_messages_lifecycle
    CHECK (
      (
        status = 'processing'
        AND completed_at IS NULL
        AND cardinality(result_ids) = 0
        AND cardinality(critical_result_ids) = 0
        AND cardinality(active_critical_result_ids) = 0
        AND cardinality(closed_critical_result_ids) = 0
        AND cardinality(alert_ids) = 0
        AND cardinality(closed_alert_ids) = 0
      )
      OR (
        status = 'completed'
        AND completed_at IS NOT NULL
        AND cardinality(result_ids) = obx_count
      )
    )
);

DO $$
DECLARE
  migration_schema TEXT := current_schema();
  target_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_oru_ingest_messages'));
  mismatch TEXT;
BEGIN
  IF target_table IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid = target_table
       AND relkind = 'r'
       AND relpersistence = 'p'
       AND pg_get_userbyid(relowner) = current_user
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_oru_ingest_messages is not an owned permanent table in the migration schema';
  END IF;

  WITH expected(attname, formatted_type, not_null, identity_kind, generated_kind, default_expr) AS (
    VALUES
      ('id', 'bigint', true, 'a', '', NULL),
      ('tenant_id', 'uuid', true, '', '', NULL),
      ('trusted_sender_identity', 'character varying(120)', true, '', '', NULL),
      ('message_control_id', 'character varying(100)', true, '', '', NULL),
      ('raw_message', 'text', true, '', '', NULL),
      ('message_sha256', 'text', true, '', 's', 'encode(digest(raw_message,''sha256''::text),''hex''::text)'),
      ('obx_count', 'integer', true, '', '', NULL),
      ('status', 'character varying(20)', true, '', '', '''processing''::charactervarying'),
      ('result_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('critical_result_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('active_critical_result_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('closed_critical_result_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('alert_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('task_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('sla_instance_ids', 'uuid[]', true, '', '', '''{}''::uuid[]'),
      ('closed_alert_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('closed_task_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('closed_sla_instance_ids', 'uuid[]', true, '', '', '''{}''::uuid[]'),
      ('legacy_adoption', 'boolean', true, '', '', 'false'),
      ('authenticated_actor_uid', 'uuid', true, '', '', NULL),
      ('authenticated_actor_roles', 'text[]', true, '', '', '''{}''::text[]'),
      ('sender_binding_mode', 'character varying(20)', true, '', '', NULL),
      ('sender_binding_identity', 'character varying(255)', true, '', '', NULL),
      ('completed_at', 'timestamp(6) with time zone', false, '', '', NULL),
      ('created_at', 'timestamp(6) with time zone', true, '', '', 'now()'),
      ('updated_at', 'timestamp(6) with time zone', true, '', '', 'now()')
  ), actual AS (
    SELECT attribute.attname,
           format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
           attribute.attnotnull AS not_null,
           attribute.attidentity::text AS identity_kind,
           attribute.attgenerated::text AS generated_kind,
           regexp_replace(pg_get_expr(definition.adbin, definition.adrelid), '\s+', '', 'g') AS default_expr
      FROM pg_attribute AS attribute
      LEFT JOIN pg_attrdef AS definition
        ON definition.adrelid = attribute.attrelid
       AND definition.adnum = attribute.attnum
     WHERE attribute.attrelid = target_table
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  )
  SELECT string_agg(expected.attname, ', ' ORDER BY expected.attname)
    INTO mismatch
    FROM expected
    LEFT JOIN actual USING (attname)
   WHERE actual.attname IS NULL
      OR actual.formatted_type IS DISTINCT FROM expected.formatted_type
      OR actual.not_null IS DISTINCT FROM expected.not_null
      OR actual.identity_kind IS DISTINCT FROM expected.identity_kind
      OR actual.generated_kind IS DISTINCT FROM expected.generated_kind
      OR actual.default_expr IS DISTINCT FROM expected.default_expr;

  IF mismatch IS NOT NULL OR (
    SELECT COUNT(*) FROM pg_attribute
     WHERE attrelid = target_table AND attnum > 0 AND NOT attisdropped
  ) <> 26 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_oru_ingest_messages has an incompatible column shape',
      DETAIL = format('Mismatched columns: %s', COALESCE(mismatch, 'unexpected extra columns'));
  END IF;

  WITH expected(conname, contype, definition) AS (
    VALUES
      ('lab_oru_ingest_messages_pkey', 'p', 'PRIMARY KEY (id)'),
      ('uq_lab_oru_ingest_messages_sender_control', 'u', 'UNIQUE (tenant_id, trusted_sender_identity, message_control_id)'),
      ('ux_lab_oru_ingest_messages_tenant_id', 'u', 'UNIQUE (tenant_id, id)'),
      ('ck_lab_oru_ingest_messages_sender', 'c', 'CHECK (NULLIF(btrim(trusted_sender_identity::text), ''''::text) IS NOT NULL AND trusted_sender_identity::text = btrim(trusted_sender_identity::text))'),
      ('ck_lab_oru_ingest_messages_control', 'c', 'CHECK (NULLIF(btrim(message_control_id::text), ''''::text) IS NOT NULL AND message_control_id::text = btrim(message_control_id::text))'),
      ('ck_lab_oru_ingest_messages_obx_count', 'c', 'CHECK (obx_count > 0)'),
      ('ck_lab_oru_ingest_messages_actor_roles', 'c', 'CHECK (cardinality(authenticated_actor_roles) > 0)'),
      ('ck_lab_oru_ingest_messages_sender_binding', 'c', 'CHECK ((sender_binding_mode::text = ANY (ARRAY[''api_client''::character varying, ''actor_uid''::character varying]::text[])) AND NULLIF(btrim(sender_binding_identity::text), ''''::text) IS NOT NULL)'),
      ('ck_lab_oru_ingest_messages_artifact_cardinality', 'c', 'CHECK (cardinality(active_critical_result_ids) = cardinality(alert_ids) AND cardinality(alert_ids) = cardinality(task_ids) AND cardinality(alert_ids) = cardinality(sla_instance_ids) AND cardinality(closed_critical_result_ids) = cardinality(closed_alert_ids) AND cardinality(closed_alert_ids) = cardinality(closed_task_ids) AND cardinality(closed_alert_ids) = cardinality(closed_sla_instance_ids) AND cardinality(critical_result_ids) = (cardinality(active_critical_result_ids) + cardinality(closed_critical_result_ids)) AND (legacy_adoption OR cardinality(closed_critical_result_ids) = 0))'),
      ('ck_lab_oru_ingest_messages_lifecycle', 'c', 'CHECK (status::text = ''processing''::text AND completed_at IS NULL AND cardinality(result_ids) = 0 AND cardinality(critical_result_ids) = 0 AND cardinality(active_critical_result_ids) = 0 AND cardinality(closed_critical_result_ids) = 0 AND cardinality(alert_ids) = 0 AND cardinality(closed_alert_ids) = 0 OR status::text = ''completed''::text AND completed_at IS NOT NULL AND cardinality(result_ids) = obx_count)')
  )
  SELECT string_agg(expected.conname, ', ' ORDER BY expected.conname)
    INTO mismatch
    FROM expected
    LEFT JOIN pg_constraint AS constraint_row
      ON constraint_row.conrelid = target_table
     AND constraint_row.conname = expected.conname
   WHERE constraint_row.oid IS NULL
      OR constraint_row.contype::text IS DISTINCT FROM expected.contype
      OR constraint_row.convalidated IS DISTINCT FROM true
      OR regexp_replace(pg_get_constraintdef(constraint_row.oid, true), '\s+', ' ', 'g')
           IS DISTINCT FROM expected.definition;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_oru_ingest_messages has incompatible primary, unique, or check constraints',
      DETAIL = format('Mismatched constraints: %s', mismatch);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = target_table
       AND constraint_row.conname = 'fk_lab_oru_ingest_messages_tenant'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = to_regclass(format('%I.%I', migration_schema, 'tenants'))
       AND constraint_row.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'tenant_id')]::smallint[]
       AND constraint_row.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'id')]::smallint[]
       AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = target_table
       AND constraint_row.conname = 'fk_lab_oru_ingest_messages_sender'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = to_regclass(format('%I.%I', migration_schema, 'lab_analyzers'))
       AND constraint_row.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'trusted_sender_identity')
       ]::smallint[]
       AND constraint_row.confkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'analyzer_code')
       ]::smallint[]
       AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = target_table
       AND constraint_row.conname = 'fk_lab_oru_ingest_messages_actor'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = to_regclass(format('%I.%I', migration_schema, 'users'))
       AND constraint_row.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'authenticated_actor_uid')
       ]::smallint[]
       AND constraint_row.confkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'uid')
       ]::smallint[]
       AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_oru_ingest_messages has incompatible tenant, sender, or actor foreign keys';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_lab_oru_ingest_messages_created
  ON lab_oru_ingest_messages (tenant_id, created_at DESC);

ALTER TABLE lab_oru_ingest_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_oru_ingest_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lab_oru_ingest_messages;
CREATE POLICY tenant_isolation ON lab_oru_ingest_messages
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

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS oru_ingest_message_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_oru_ingest_message'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_oru_ingest_message
      FOREIGN KEY (tenant_id, oru_ingest_message_id)
      REFERENCES lab_oru_ingest_messages(tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_lab_results_oru_ingest_message
  ON lab_results (tenant_id, oru_ingest_message_id, hl7_segment_index)
  WHERE oru_ingest_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION lab_oru_ingest_message_write_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed HL7 ORU message claims cannot be deleted';
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.trusted_sender_identity IS DISTINCT FROM NEW.trusted_sender_identity
     OR OLD.message_control_id IS DISTINCT FROM NEW.message_control_id
     OR OLD.raw_message IS DISTINCT FROM NEW.raw_message
     OR OLD.obx_count IS DISTINCT FROM NEW.obx_count
     OR OLD.authenticated_actor_uid IS DISTINCT FROM NEW.authenticated_actor_uid
     OR OLD.authenticated_actor_roles IS DISTINCT FROM NEW.authenticated_actor_roles
     OR OLD.sender_binding_mode IS DISTINCT FROM NEW.sender_binding_mode
     OR OLD.sender_binding_identity IS DISTINCT FROM NEW.sender_binding_identity THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'HL7 ORU message identity and provenance are immutable once claimed';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed HL7 ORU message claims are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_oru_ingest_message_write_guard ON lab_oru_ingest_messages;
CREATE TRIGGER trg_lab_oru_ingest_message_write_guard
BEFORE UPDATE OR DELETE ON lab_oru_ingest_messages
FOR EACH ROW
EXECUTE FUNCTION lab_oru_ingest_message_write_guard();

CREATE OR REPLACE FUNCTION lab_results_assert_oru_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  claim_status TEXT;
  valid_legacy_adoption BOOLEAN := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.oru_ingest_message_id IS NOT NULL THEN
      SELECT status
        INTO claim_status
        FROM lab_oru_ingest_messages
       WHERE tenant_id = OLD.tenant_id
         AND id = OLD.oru_ingest_message_id;
      IF claim_status = 'completed' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Results belonging to a completed HL7 ORU message cannot be deleted';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.analyzer_id IS DISTINCT FROM NEW.analyzer_id
       OR OLD.performed_by_lab IS DISTINCT FROM NEW.performed_by_lab
       OR OLD.hl7_message_id IS DISTINCT FROM NEW.hl7_message_id
       OR OLD.hl7_segment_index IS DISTINCT FROM NEW.hl7_segment_index
       OR OLD.oru_ingest_message_id IS DISTINCT FROM NEW.oru_ingest_message_id
     )
     AND (
       OLD.hl7_message_id IS NOT NULL
       OR OLD.hl7_segment_index IS NOT NULL
       OR OLD.oru_ingest_message_id IS NOT NULL
       OR NEW.hl7_message_id IS NOT NULL
       OR NEW.hl7_segment_index IS NOT NULL
       OR NEW.oru_ingest_message_id IS NOT NULL
     ) THEN
    valid_legacy_adoption :=
      OLD.oru_ingest_message_id IS NULL
      AND NEW.oru_ingest_message_id IS NOT NULL
      AND NEW.analyzer_id IS NOT NULL
      AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      AND OLD.performed_by_lab IS NOT DISTINCT FROM NEW.performed_by_lab
      AND OLD.hl7_message_id IS NOT DISTINCT FROM NEW.hl7_message_id
      AND OLD.hl7_segment_index IS NOT DISTINCT FROM NEW.hl7_segment_index
      AND (OLD.analyzer_id IS NULL OR OLD.analyzer_id = NEW.analyzer_id)
      AND EXISTS (
        SELECT 1
          FROM lab_oru_ingest_messages AS claim
          JOIN lab_analyzers AS analyzer
            ON analyzer.tenant_id = claim.tenant_id
           AND analyzer.analyzer_code = claim.trusted_sender_identity
         WHERE claim.tenant_id = NEW.tenant_id
           AND claim.id = NEW.oru_ingest_message_id
           AND claim.trusted_sender_identity = NEW.performed_by_lab
           AND claim.message_control_id = NEW.hl7_message_id
           AND analyzer.id = NEW.analyzer_id
           AND claim.status = 'processing'
      );

    IF NOT valid_legacy_adoption THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'HL7 ORU result identity is immutable once assigned';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.oru_ingest_message_id IS NOT NULL
     AND (
       OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR OLD.booking_id IS DISTINCT FROM NEW.booking_id
       OR OLD.investigation_id IS DISTINCT FROM NEW.investigation_id
       OR OLD.raw_obx IS DISTINCT FROM NEW.raw_obx
       OR OLD.loinc_code IS DISTINCT FROM NEW.loinc_code
       OR OLD.test_code IS DISTINCT FROM NEW.test_code
       OR OLD.test_name IS DISTINCT FROM NEW.test_name
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Claimed HL7 ORU patient, order, and observation identity are immutable';
  END IF;

  IF (
       TG_OP = 'INSERT'
       AND (
         NEW.hl7_message_id IS NOT NULL
         OR NEW.hl7_segment_index IS NOT NULL
         OR NEW.oru_ingest_message_id IS NOT NULL
       )
     ) OR valid_legacy_adoption THEN
    IF NEW.oru_ingest_message_id IS NULL OR NEW.analyzer_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM lab_oru_ingest_messages AS claim
        JOIN lab_analyzers AS analyzer
          ON analyzer.tenant_id = claim.tenant_id
         AND analyzer.analyzer_code = claim.trusted_sender_identity
       WHERE claim.tenant_id = NEW.tenant_id
         AND claim.id = NEW.oru_ingest_message_id
         AND claim.trusted_sender_identity = NEW.performed_by_lab
         AND claim.message_control_id = NEW.hl7_message_id
         AND analyzer.id = NEW.analyzer_id
         AND claim.status = 'processing'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'HL7 ORU result must belong to its exact active message claim and configured analyzer';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_results_oru_identity ON lab_results;
CREATE TRIGGER trg_lab_results_oru_identity
BEFORE INSERT OR UPDATE OF tenant_id, analyzer_id, performed_by_lab,
  hl7_message_id, hl7_segment_index, oru_ingest_message_id, patient_uid,
  booking_id, investigation_id, raw_obx, loinc_code, test_code, test_name OR DELETE
ON lab_results
FOR EACH ROW
EXECUTE FUNCTION lab_results_assert_oru_identity();

CREATE OR REPLACE FUNCTION lab_oru_assert_completed_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  linked_result_ids INTEGER[];
  declared_result_ids INTEGER[];
  linked_critical_result_ids INTEGER[];
  declared_critical_result_ids INTEGER[];
  declared_partitioned_critical_result_ids INTEGER[];
  artifact_count INTEGER;
  distinct_alert_count INTEGER;
  distinct_critical_result_count INTEGER;
  distinct_task_count INTEGER;
  distinct_sla_count INTEGER;
  closed_artifact_count INTEGER;
  distinct_closed_alert_count INTEGER;
  distinct_closed_critical_result_count INTEGER;
  distinct_closed_task_count INTEGER;
  distinct_closed_sla_count INTEGER;
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(result.id ORDER BY result.id), '{}'::integer[])
    INTO linked_result_ids
    FROM lab_results AS result
   WHERE result.tenant_id = NEW.tenant_id
     AND result.oru_ingest_message_id = NEW.id;

  SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
    INTO declared_result_ids
    FROM unnest(NEW.result_ids) AS result_id;

  IF linked_result_ids IS DISTINCT FROM declared_result_ids THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed HL7 ORU claim result set does not match its linked OBX rows';
  END IF;

  SELECT COALESCE(array_agg(result.id ORDER BY result.id), '{}'::integer[])
    INTO linked_critical_result_ids
    FROM lab_results AS result
   WHERE result.tenant_id = NEW.tenant_id
     AND result.oru_ingest_message_id = NEW.id
     AND result.is_critical = true;

  SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
    INTO declared_critical_result_ids
    FROM unnest(NEW.critical_result_ids) AS result_id;

  IF linked_critical_result_ids IS DISTINCT FROM declared_critical_result_ids THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed HL7 ORU claim critical-result set does not match its linked results';
  END IF;

  SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
    INTO declared_partitioned_critical_result_ids
    FROM unnest(
           NEW.active_critical_result_ids || NEW.closed_critical_result_ids
         ) AS result_id;

  IF declared_partitioned_critical_result_ids IS DISTINCT FROM declared_critical_result_ids THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed HL7 ORU claim active/closed critical partitions are not exact';
  END IF;

  IF cardinality(NEW.alert_ids) > 0 THEN
    SELECT COUNT(*)::integer,
           COUNT(DISTINCT artifact.critical_result_id)::integer,
           COUNT(DISTINCT artifact.alert_id)::integer,
           COUNT(DISTINCT artifact.task_id)::integer,
           COUNT(DISTINCT artifact.sla_id)::integer
      INTO artifact_count, distinct_critical_result_count,
           distinct_alert_count, distinct_task_count, distinct_sla_count
      FROM unnest(
             NEW.active_critical_result_ids,
             NEW.alert_ids,
             NEW.task_ids,
             NEW.sla_instance_ids
           ) AS artifact(critical_result_id, alert_id, task_id, sla_id)
      JOIN lab_critical_alerts AS alert
        ON alert.tenant_id = NEW.tenant_id
       AND alert.id = artifact.alert_id
       AND alert.result_id = artifact.critical_result_id
       AND alert.result_id = ANY(NEW.result_ids)
       AND alert.acknowledgement_task_id = artifact.task_id
       AND alert.superseded_at IS NULL
       AND alert.acknowledged_at IS NULL
      JOIN tasks AS task
        ON task.tenant_id = NEW.tenant_id
       AND task.id = artifact.task_id
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = alert.result_id::text
       AND task.workflow_sla_instance_id = artifact.sla_id
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
       AND task.completed_at IS NULL
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = NEW.tenant_id
       AND sla.id = artifact.sla_id
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = alert.result_id::text
       AND sla.status IN ('active', 'breached', 'escalated')
       AND sla.completed_at IS NULL;

    IF artifact_count <> cardinality(NEW.alert_ids)
       OR distinct_critical_result_count <> artifact_count
       OR distinct_alert_count <> artifact_count
       OR distinct_task_count <> artifact_count
       OR distinct_sla_count <> artifact_count THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Completed HL7 ORU claim has an incomplete alert/task/SLA binding';
    END IF;
  END IF;

  IF cardinality(NEW.closed_alert_ids) > 0 THEN
    IF NOT NEW.legacy_adoption THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Closed HL7 ORU obligations are allowed only for an explicit legacy adoption';
    END IF;

    SELECT COUNT(*)::integer,
           COUNT(DISTINCT artifact.critical_result_id)::integer,
           COUNT(DISTINCT artifact.alert_id)::integer,
           COUNT(DISTINCT artifact.task_id)::integer,
           COUNT(DISTINCT artifact.sla_id)::integer
      INTO closed_artifact_count, distinct_closed_critical_result_count,
           distinct_closed_alert_count, distinct_closed_task_count, distinct_closed_sla_count
      FROM unnest(
             NEW.closed_critical_result_ids,
             NEW.closed_alert_ids,
             NEW.closed_task_ids,
             NEW.closed_sla_instance_ids
           ) AS artifact(critical_result_id, alert_id, task_id, sla_id)
      JOIN lab_critical_alerts AS alert
        ON alert.tenant_id = NEW.tenant_id
       AND alert.id = artifact.alert_id
       AND alert.result_id = artifact.critical_result_id
       AND alert.result_id = ANY(NEW.result_ids)
       AND alert.acknowledgement_task_id = artifact.task_id
       AND alert.superseded_at IS NULL
       AND alert.acknowledged_at IS NOT NULL
       AND alert.acknowledged_by IS NOT NULL
      JOIN tasks AS task
        ON task.tenant_id = NEW.tenant_id
       AND task.id = artifact.task_id
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = alert.result_id::text
       AND task.workflow_sla_instance_id = artifact.sla_id
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status = 'in_progress'
       AND task.completed_at IS NULL
       AND NULLIF(task.metadata->>'acknowledged_at', '') IS NOT NULL
       AND NULLIF(task.metadata->>'acknowledged_by', '') IS NOT NULL
       AND LOWER(task.metadata->>'acknowledged_by') = LOWER(alert.acknowledged_by::text)
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = NEW.tenant_id
       AND sla.id = artifact.sla_id
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = alert.result_id::text
       AND sla.status IN ('completed', 'breached', 'escalated')
       AND sla.completed_at IS NOT NULL
       AND sla.completed_at = (task.metadata->>'acknowledged_at')::timestamptz
       AND sla.metadata->>'completed_via' = 'task_ack'
       AND sla.metadata->>'completed_by_task' = task.id::text
       AND LOWER(sla.metadata->>'completed_by') = LOWER(alert.acknowledged_by::text)
       AND alert.acknowledged_at = sla.completed_at;

    IF closed_artifact_count <> cardinality(NEW.closed_alert_ids)
       OR distinct_closed_critical_result_count <> closed_artifact_count
       OR distinct_closed_alert_count <> closed_artifact_count
       OR distinct_closed_task_count <> closed_artifact_count
       OR distinct_closed_sla_count <> closed_artifact_count THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Completed HL7 ORU legacy adoption has incomplete acknowledged alert/task/SLA evidence';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_oru_assert_completed_message ON lab_oru_ingest_messages;
CREATE CONSTRAINT TRIGGER trg_lab_oru_assert_completed_message
AFTER INSERT OR UPDATE ON lab_oru_ingest_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION lab_oru_assert_completed_message();

-- Transaction-coupled command identity for staff-entered manual and panel
-- results. The generic HTTP idempotency cache is useful for replaying a normal
-- response, but it is finalized after the clinical transaction. This ledger is
-- claimed and completed inside the same transaction as the result rows, so a
-- lost response or process crash cannot create a second clinical submission.
CREATE TABLE IF NOT EXISTS lab_result_ingest_commands (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  actor_uid           UUID NOT NULL,
  command_scope       VARCHAR(30) NOT NULL,
  command_key         VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'processing',
  result_ids          INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  panel_id            UUID,
  response_data       JSONB,
  completed_at        TIMESTAMPTZ(6),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_lab_result_ingest_commands_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_lab_result_ingest_commands_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_lab_result_ingest_commands_identity
    UNIQUE (tenant_id, actor_uid, command_scope, command_key),
  CONSTRAINT ux_lab_result_ingest_commands_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ck_lab_result_ingest_commands_identity
    CHECK (
      command_scope IN ('manual_result', 'panel_result')
      AND NULLIF(BTRIM(command_key), '') IS NOT NULL
      AND command_key = BTRIM(command_key)
      AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ck_lab_result_ingest_commands_lifecycle
    CHECK (
      (
        status = 'processing'
        AND cardinality(result_ids) = 0
        AND panel_id IS NULL
        AND response_data IS NULL
        AND completed_at IS NULL
      )
      OR (
        status = 'completed'
        AND cardinality(result_ids) > 0
        AND response_data IS NOT NULL
        AND completed_at IS NOT NULL
        AND (
          (command_scope = 'manual_result' AND cardinality(result_ids) = 1 AND panel_id IS NULL)
          OR (command_scope = 'panel_result' AND panel_id IS NOT NULL)
        )
      )
    )
);

DO $$
DECLARE
  migration_schema TEXT := current_schema();
  target_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_result_ingest_commands'));
  mismatch TEXT;
BEGIN
  IF target_table IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid = target_table
       AND relkind = 'r'
       AND relpersistence = 'p'
       AND pg_get_userbyid(relowner) = current_user
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_result_ingest_commands is not an owned permanent table in the migration schema';
  END IF;

  WITH expected(attname, formatted_type, not_null, identity_kind, generated_kind, default_expr) AS (
    VALUES
      ('id', 'bigint', true, 'a', '', NULL),
      ('tenant_id', 'uuid', true, '', '', NULL),
      ('actor_uid', 'uuid', true, '', '', NULL),
      ('command_scope', 'character varying(30)', true, '', '', NULL),
      ('command_key', 'character varying(200)', true, '', '', NULL),
      ('request_body_sha256', 'character(64)', true, '', '', NULL),
      ('status', 'character varying(20)', true, '', '', '''processing''::charactervarying'),
      ('result_ids', 'integer[]', true, '', '', '''{}''::integer[]'),
      ('panel_id', 'uuid', false, '', '', NULL),
      ('response_data', 'jsonb', false, '', '', NULL),
      ('completed_at', 'timestamp(6) with time zone', false, '', '', NULL),
      ('created_at', 'timestamp(6) with time zone', true, '', '', 'now()'),
      ('updated_at', 'timestamp(6) with time zone', true, '', '', 'now()')
  ), actual AS (
    SELECT attribute.attname,
           format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
           attribute.attnotnull AS not_null,
           attribute.attidentity::text AS identity_kind,
           attribute.attgenerated::text AS generated_kind,
           regexp_replace(pg_get_expr(definition.adbin, definition.adrelid), '\s+', '', 'g') AS default_expr
      FROM pg_attribute AS attribute
      LEFT JOIN pg_attrdef AS definition
        ON definition.adrelid = attribute.attrelid
       AND definition.adnum = attribute.attnum
     WHERE attribute.attrelid = target_table
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  )
  SELECT string_agg(expected.attname, ', ' ORDER BY expected.attname)
    INTO mismatch
    FROM expected
    LEFT JOIN actual USING (attname)
   WHERE actual.attname IS NULL
      OR actual.formatted_type IS DISTINCT FROM expected.formatted_type
      OR actual.not_null IS DISTINCT FROM expected.not_null
      OR actual.identity_kind IS DISTINCT FROM expected.identity_kind
      OR actual.generated_kind IS DISTINCT FROM expected.generated_kind
      OR actual.default_expr IS DISTINCT FROM expected.default_expr;

  IF mismatch IS NOT NULL OR (
    SELECT COUNT(*) FROM pg_attribute
     WHERE attrelid = target_table AND attnum > 0 AND NOT attisdropped
  ) <> 13 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_result_ingest_commands has an incompatible column shape',
      DETAIL = format('Mismatched columns: %s', COALESCE(mismatch, 'unexpected extra columns'));
  END IF;

  WITH expected(conname, contype, definition) AS (
    VALUES
      ('lab_result_ingest_commands_pkey', 'p', 'PRIMARY KEY (id)'),
      ('uq_lab_result_ingest_commands_identity', 'u', 'UNIQUE (tenant_id, actor_uid, command_scope, command_key)'),
      ('ux_lab_result_ingest_commands_tenant_id', 'u', 'UNIQUE (tenant_id, id)'),
      ('ck_lab_result_ingest_commands_identity', 'c', 'CHECK ((command_scope::text = ANY (ARRAY[''manual_result''::character varying, ''panel_result''::character varying]::text[])) AND NULLIF(btrim(command_key::text), ''''::text) IS NOT NULL AND command_key::text = btrim(command_key::text) AND request_body_sha256 ~ ''^[0-9a-f]{64}$''::text)'),
      ('ck_lab_result_ingest_commands_lifecycle', 'c', 'CHECK (status::text = ''processing''::text AND cardinality(result_ids) = 0 AND panel_id IS NULL AND response_data IS NULL AND completed_at IS NULL OR status::text = ''completed''::text AND cardinality(result_ids) > 0 AND response_data IS NOT NULL AND completed_at IS NOT NULL AND (command_scope::text = ''manual_result''::text AND cardinality(result_ids) = 1 AND panel_id IS NULL OR command_scope::text = ''panel_result''::text AND panel_id IS NOT NULL))')
  )
  SELECT string_agg(expected.conname, ', ' ORDER BY expected.conname)
    INTO mismatch
    FROM expected
    LEFT JOIN pg_constraint AS constraint_row
      ON constraint_row.conrelid = target_table
     AND constraint_row.conname = expected.conname
   WHERE constraint_row.oid IS NULL
      OR constraint_row.contype::text IS DISTINCT FROM expected.contype
      OR constraint_row.convalidated IS DISTINCT FROM true
      OR regexp_replace(pg_get_constraintdef(constraint_row.oid, true), '\s+', ' ', 'g')
           IS DISTINCT FROM expected.definition;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_result_ingest_commands has incompatible primary, unique, or check constraints',
      DETAIL = format('Mismatched constraints: %s', mismatch);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = target_table
       AND constraint_row.conname = 'fk_lab_result_ingest_commands_tenant'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = to_regclass(format('%I.%I', migration_schema, 'tenants'))
       AND constraint_row.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'tenant_id')]::smallint[]
       AND constraint_row.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'id')]::smallint[]
       AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = target_table
       AND constraint_row.conname = 'fk_lab_result_ingest_commands_actor'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = to_regclass(format('%I.%I', migration_schema, 'users'))
       AND constraint_row.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = target_table AND attname = 'actor_uid')
       ]::smallint[]
       AND constraint_row.confkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'uid')
       ]::smallint[]
       AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_result_ingest_commands has incompatible tenant or actor foreign keys';
  END IF;
END
$$;

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS ingest_command_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_ingest_command'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_ingest_command
      FOREIGN KEY (tenant_id, ingest_command_id)
      REFERENCES lab_result_ingest_commands(tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
DECLARE
  migration_schema TEXT := current_schema();
  result_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_results'));
  oru_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_oru_ingest_messages'));
  command_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_result_ingest_commands'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = result_table
       AND attname = 'oru_ingest_message_id'
       AND format_type(atttypid, atttypmod) = 'bigint'
       AND NOT attnotnull
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = result_table
       AND attname = 'ingest_command_id'
       AND format_type(atttypid, atttypmod) = 'bigint'
       AND NOT attnotnull
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_results has incompatible ORU or command identity columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = result_table
       AND conname = 'ck_lab_results_hl7_replay_identity_complete'
       AND contype = 'c'
       AND convalidated
       AND regexp_replace(pg_get_constraintdef(oid, true), '\s+', ' ', 'g') =
         'CHECK (hl7_message_id IS NULL AND hl7_segment_index IS NULL OR NULLIF(btrim(performed_by_lab::text), ''''::text) IS NOT NULL AND NULLIF(btrim(hl7_message_id::text), ''''::text) IS NOT NULL AND performed_by_lab::text = btrim(performed_by_lab::text) AND hl7_message_id::text = btrim(hl7_message_id::text) AND hl7_segment_index > 0)'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ck_lab_results_hl7_replay_identity_complete has an incompatible definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = result_table
       AND constraint_row.conname = 'fk_lab_results_oru_ingest_message'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = oru_table
       AND constraint_row.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = result_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = result_table AND attname = 'oru_ingest_message_id')
       ]::smallint[]
       AND constraint_row.confkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = oru_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = oru_table AND attname = 'id')
       ]::smallint[]
       AND constraint_row.confupdtype = 'a'
       AND constraint_row.confdeltype = 'r'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = result_table
       AND constraint_row.conname = 'fk_lab_results_ingest_command'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.confrelid = command_table
       AND constraint_row.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = result_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = result_table AND attname = 'ingest_command_id')
       ]::smallint[]
       AND constraint_row.confkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = command_table AND attname = 'tenant_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = command_table AND attname = 'id')
       ]::smallint[]
       AND constraint_row.confupdtype = 'a'
       AND constraint_row.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_results has incompatible ORU or command foreign keys';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_lab_results_ingest_command
  ON lab_results (tenant_id, ingest_command_id, id)
  WHERE ingest_command_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lab_result_ingest_commands_created
  ON lab_result_ingest_commands (tenant_id, created_at DESC);

ALTER TABLE lab_result_ingest_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_result_ingest_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lab_result_ingest_commands;
CREATE POLICY tenant_isolation ON lab_result_ingest_commands
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

CREATE OR REPLACE FUNCTION lab_result_ingest_command_write_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lab result ingest commands cannot be deleted';
  END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.actor_uid IS DISTINCT FROM NEW.actor_uid
     OR OLD.command_scope IS DISTINCT FROM NEW.command_scope
     OR OLD.command_key IS DISTINCT FROM NEW.command_key
     OR OLD.request_body_sha256 IS DISTINCT FROM NEW.request_body_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lab result ingest command identity is immutable';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed lab result ingest commands are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_result_ingest_command_write_guard
  ON lab_result_ingest_commands;
CREATE TRIGGER trg_lab_result_ingest_command_write_guard
BEFORE UPDATE OR DELETE ON lab_result_ingest_commands
FOR EACH ROW
EXECUTE FUNCTION lab_result_ingest_command_write_guard();

CREATE OR REPLACE FUNCTION lab_results_assert_ingest_command_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  command_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ingest_command_id IS NOT NULL THEN
      SELECT status
        INTO command_status
        FROM lab_result_ingest_commands
       WHERE tenant_id = OLD.tenant_id
         AND id = OLD.ingest_command_id;
      IF command_status = 'completed' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Results belonging to a completed lab ingest command cannot be deleted';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.ingest_command_id IS NOT NULL
     AND OLD.ingest_command_id IS DISTINCT FROM NEW.ingest_command_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lab result ingest command identity is immutable once assigned';
  END IF;

  IF NEW.ingest_command_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR OLD.ingest_command_id IS DISTINCT FROM NEW.ingest_command_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM lab_result_ingest_commands AS command
        WHERE command.tenant_id = NEW.tenant_id
          AND command.id = NEW.ingest_command_id
          AND command.status = 'processing'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lab result must belong to its exact active ingest command';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_results_ingest_command_identity ON lab_results;
CREATE TRIGGER trg_lab_results_ingest_command_identity
BEFORE INSERT OR UPDATE OF tenant_id, ingest_command_id OR DELETE ON lab_results
FOR EACH ROW
EXECUTE FUNCTION lab_results_assert_ingest_command_identity();

CREATE OR REPLACE FUNCTION lab_result_ingest_command_assert_completed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  linked_result_ids INTEGER[];
  declared_result_ids INTEGER[];
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(result.id ORDER BY result.id), '{}'::integer[])
    INTO linked_result_ids
    FROM lab_results AS result
   WHERE result.tenant_id = NEW.tenant_id
     AND result.ingest_command_id = NEW.id;

  SELECT COALESCE(array_agg(result_id ORDER BY result_id), '{}'::integer[])
    INTO declared_result_ids
    FROM unnest(NEW.result_ids) AS result_id;

  IF linked_result_ids IS DISTINCT FROM declared_result_ids THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed lab result ingest command does not bind its exact result set';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM lab_results AS result
     WHERE result.tenant_id = NEW.tenant_id
       AND result.ingest_command_id = NEW.id
       AND (
         (NEW.command_scope = 'panel_result' AND result.panel_id IS DISTINCT FROM NEW.panel_id)
         OR (NEW.command_scope = 'manual_result' AND result.panel_id IS NOT NULL)
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed lab result ingest command has inconsistent panel identity';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_result_ingest_command_assert_completed
  ON lab_result_ingest_commands;
CREATE CONSTRAINT TRIGGER trg_lab_result_ingest_command_assert_completed
AFTER INSERT OR UPDATE ON lab_result_ingest_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION lab_result_ingest_command_assert_completed();

DO $$
DECLARE
  migration_schema TEXT := current_schema();
  oru_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_oru_ingest_messages'));
  command_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_result_ingest_commands'));
  result_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'lab_results'));
  target_index REGCLASS;
  expected_policy_expr TEXT := regexp_replace(
    '((current_setting(''app.current_tenant_id''::text, true) IS NULL) OR (current_setting(''app.current_tenant_id''::text, true) = ''''::text) OR (current_setting(''app.current_tenant_id''::text, true) = ''bypass''::text) OR (tenant_id = app_current_tenant_id_uuid()))',
    '\s+', '', 'g'
  );
BEGIN
  target_index := to_regclass(format('%I.%I', migration_schema, 'idx_lab_oru_ingest_messages_created'));
  IF target_index IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = target_index
       AND indrelid = oru_table
       AND NOT indisunique AND indisvalid AND indisready
       AND indnkeyatts = 2
       AND pg_get_indexdef(indexrelid, 1, true) = 'tenant_id'
       AND pg_get_indexdef(indexrelid, 2, true) = 'created_at'
       AND indoption[0] = 0
       AND indoption[1] = 3
       AND indpred IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'idx_lab_oru_ingest_messages_created has an incompatible definition';
  END IF;

  target_index := to_regclass(format('%I.%I', migration_schema, 'idx_lab_results_oru_ingest_message'));
  IF target_index IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = target_index
       AND indrelid = result_table
       AND NOT indisunique AND indisvalid AND indisready
       AND indnkeyatts = 3
       AND pg_get_indexdef(indexrelid, 1, true) = 'tenant_id'
       AND pg_get_indexdef(indexrelid, 2, true) = 'oru_ingest_message_id'
       AND pg_get_indexdef(indexrelid, 3, true) = 'hl7_segment_index'
       AND pg_get_expr(indpred, indrelid) = '(oru_ingest_message_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'idx_lab_results_oru_ingest_message has an incompatible definition';
  END IF;

  target_index := to_regclass(format('%I.%I', migration_schema, 'idx_lab_result_ingest_commands_created'));
  IF target_index IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = target_index
       AND indrelid = command_table
       AND NOT indisunique AND indisvalid AND indisready
       AND indnkeyatts = 2
       AND pg_get_indexdef(indexrelid, 1, true) = 'tenant_id'
       AND pg_get_indexdef(indexrelid, 2, true) = 'created_at'
       AND indoption[0] = 0
       AND indoption[1] = 3
       AND indpred IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'idx_lab_result_ingest_commands_created has an incompatible definition';
  END IF;

  target_index := to_regclass(format('%I.%I', migration_schema, 'idx_lab_results_ingest_command'));
  IF target_index IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = target_index
       AND indrelid = result_table
       AND NOT indisunique AND indisvalid AND indisready
       AND indnkeyatts = 3
       AND pg_get_indexdef(indexrelid, 1, true) = 'tenant_id'
       AND pg_get_indexdef(indexrelid, 2, true) = 'ingest_command_id'
       AND pg_get_indexdef(indexrelid, 3, true) = 'id'
       AND pg_get_expr(indpred, indrelid) = '(ingest_command_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'idx_lab_results_ingest_command has an incompatible definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = oru_table AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = oru_table
       AND polname = 'tenant_isolation'
       AND polcmd = '*'
       AND polroles = ARRAY[0]::oid[]
       AND regexp_replace(pg_get_expr(polqual, polrelid), '\s+', '', 'g') = expected_policy_expr
       AND regexp_replace(pg_get_expr(polwithcheck, polrelid), '\s+', '', 'g') = expected_policy_expr
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = command_table AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = command_table
       AND polname = 'tenant_isolation'
       AND polcmd = '*'
       AND polroles = ARRAY[0]::oid[]
       AND regexp_replace(pg_get_expr(polqual, polrelid), '\s+', '', 'g') = expected_policy_expr
       AND regexp_replace(pg_get_expr(polwithcheck, polrelid), '\s+', '', 'g') = expected_policy_expr
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Lab ingest claim tables have incompatible RLS or tenant policies';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = oru_table
       AND tgname = 'trg_lab_oru_ingest_message_write_guard'
       AND NOT tgisinternal AND tgenabled = 'O'
       AND tgfoid = to_regprocedure(format('%I.lab_oru_ingest_message_write_guard()', migration_schema))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = oru_table
       AND tgname = 'trg_lab_oru_assert_completed_message'
       AND NOT tgisinternal AND tgenabled = 'O' AND tgdeferrable AND tginitdeferred
       AND tgfoid = to_regprocedure(format('%I.lab_oru_assert_completed_message()', migration_schema))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = command_table
       AND tgname = 'trg_lab_result_ingest_command_write_guard'
       AND NOT tgisinternal AND tgenabled = 'O'
       AND tgfoid = to_regprocedure(format('%I.lab_result_ingest_command_write_guard()', migration_schema))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = command_table
       AND tgname = 'trg_lab_result_ingest_command_assert_completed'
       AND NOT tgisinternal AND tgenabled = 'O' AND tgdeferrable AND tginitdeferred
       AND tgfoid = to_regprocedure(format('%I.lab_result_ingest_command_assert_completed()', migration_schema))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = result_table
       AND tgname = 'trg_lab_results_oru_identity'
       AND NOT tgisinternal AND tgenabled = 'O'
       AND tgfoid = to_regprocedure(format('%I.lab_results_assert_oru_identity()', migration_schema))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = result_table
       AND tgname = 'trg_lab_results_ingest_command_identity'
       AND NOT tgisinternal AND tgenabled = 'O'
       AND tgfoid = to_regprocedure(format('%I.lab_results_assert_ingest_command_identity()', migration_schema))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Lab ingest claim or result identity triggers are missing or incompatible';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_constraint
     WHERE conrelid = oru_table
       AND contype <> 'n'
  ) <> 14 OR (
    SELECT COUNT(*) FROM pg_constraint
     WHERE conrelid = command_table
       AND contype <> 'n'
  ) <> 8 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Lab ingest claim tables have an unexpected constraint set';
  END IF;
END
$$;
