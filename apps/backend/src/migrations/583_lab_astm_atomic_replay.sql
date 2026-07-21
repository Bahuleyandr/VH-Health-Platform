-- Migration 583: make ASTM analyzer ingestion atomic and exactly replayable.
--
-- ASTM E1394 payloads expose no repository-supported durable message-control
-- identifier. Replay identity is therefore a SHA-256 of the parser-equivalent
-- record stream, scoped to the tenant and resolved analyzer channel. The raw
-- bytes remain immutable evidence while CR/LF style and record-edge whitespace
-- cannot create a second clinical result set.
-- Direct HL7 ORU replay remains owned by migration 582 and is intentionally
-- outside this index.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION lab_astm_canonical_message(message_text TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
           string_agg(BTRIM(record), CHR(13) ORDER BY record_ordinal),
           ''
         )
    FROM regexp_split_to_table(message_text, E'\r\n|\r|\n')
         WITH ORDINALITY AS parsed(record, record_ordinal)
   WHERE BTRIM(record) <> ''
$$;

ALTER TABLE lab_interface_messages
  ADD COLUMN IF NOT EXISTS raw_message_sha256 TEXT
    GENERATED ALWAYS AS (
      encode(digest(raw_message, 'sha256'), 'hex')
    ) STORED;

ALTER TABLE lab_interface_messages
  ADD COLUMN IF NOT EXISTS ingest_contract_version INTEGER;

ALTER TABLE lab_interface_messages
  ADD COLUMN IF NOT EXISTS astm_message_sha256 TEXT
    GENERATED ALWAYS AS (
      encode(digest(lab_astm_canonical_message(raw_message), 'sha256'), 'hex')
    ) STORED,
  ADD COLUMN IF NOT EXISTS authenticated_actor_uid UUID,
  ADD COLUMN IF NOT EXISTS authenticated_actor_roles TEXT[],
  ADD COLUMN IF NOT EXISTS analyzer_binding_mode VARCHAR(40),
  ADD COLUMN IF NOT EXISTS analyzer_binding_identity VARCHAR(120),
  ADD COLUMN IF NOT EXISTS analyzer_sender_identity VARCHAR(120);

DO $$
DECLARE
  column_type TEXT;
  generated_kind "char";
  generation_expression TEXT;
BEGIN
  SELECT format_type(attribute.atttypid, attribute.atttypmod),
         attribute.attgenerated,
         pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
    INTO column_type, generated_kind, generation_expression
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
   WHERE attribute.attrelid = 'lab_interface_messages'::regclass
     AND attribute.attname = 'raw_message_sha256'
     AND NOT attribute.attisdropped;

  IF column_type IS DISTINCT FROM 'text'
     OR generated_kind IS DISTINCT FROM 's'
     OR generation_expression IS DISTINCT FROM
          'encode(digest(raw_message, ''sha256''::text), ''hex''::text)'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_interface_messages.raw_message_sha256 has an incompatible definition';
  END IF;
END
$$;

DO $$
DECLARE
  column_type TEXT;
  generated_kind "char";
  generation_expression TEXT;
BEGIN
  SELECT format_type(attribute.atttypid, attribute.atttypmod),
         attribute.attgenerated,
         pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
    INTO column_type, generated_kind, generation_expression
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
   WHERE attribute.attrelid = 'lab_interface_messages'::regclass
     AND attribute.attname = 'astm_message_sha256'
     AND NOT attribute.attisdropped;

  IF column_type IS DISTINCT FROM 'text'
     OR generated_kind IS DISTINCT FROM 's'
     OR generation_expression IS DISTINCT FROM
          'encode(digest(lab_astm_canonical_message(raw_message), ''sha256''::text), ''hex''::text)'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_interface_messages.astm_message_sha256 has an incompatible definition';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'lab_interface_messages'
       AND column_name = 'ingest_contract_version'
       AND data_type <> 'integer'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_interface_messages.ingest_contract_version has an incompatible type';
  END IF;
END
$$;

DO $$
DECLARE
  incompatible_column TEXT;
BEGIN
  SELECT column_name
    INTO incompatible_column
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'lab_interface_messages'
     AND (
       (column_name = 'authenticated_actor_uid' AND data_type <> 'uuid')
       OR (column_name = 'authenticated_actor_roles' AND data_type <> 'ARRAY')
       OR (column_name = 'analyzer_binding_mode'
           AND (data_type <> 'character varying' OR character_maximum_length <> 40))
       OR (column_name = 'analyzer_binding_identity'
           AND (data_type <> 'character varying' OR character_maximum_length <> 120))
       OR (column_name = 'analyzer_sender_identity'
           AND (data_type <> 'character varying' OR character_maximum_length <> 120))
     )
   LIMIT 1;
  IF incompatible_column IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'lab_interface_messages.%s has an incompatible type',
        incompatible_column
      );
  END IF;
END
$$;

ALTER TABLE lab_interface_messages
  ALTER COLUMN raw_message_sha256 SET NOT NULL,
  ALTER COLUMN astm_message_sha256 SET NOT NULL;

DO $$
DECLARE
  duplicate_group_count BIGINT;
  duplicate_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO duplicate_group_count
    FROM (
      SELECT tenant_id,
             COALESCE(
               analyzer_id::text,
               'legacy:' || LOWER(NULLIF(BTRIM(analyzer_code), '')),
               '<legacy-unresolved>'
             ) AS analyzer_channel,
             protocol,
             astm_message_sha256
        FROM lab_interface_messages
       WHERE direction = 'inbound'
         AND protocol = 'astm_e1394'
       GROUP BY tenant_id,
                COALESCE(
                  analyzer_id::text,
                  'legacy:' || LOWER(NULLIF(BTRIM(analyzer_code), '')),
                  '<legacy-unresolved>'
                ),
                protocol,
                astm_message_sha256
      HAVING COUNT(*) > 1
    ) AS duplicate_groups;

  IF duplicate_group_count > 0 THEN
    SELECT string_agg(
             format(
               'tenant=%s analyzer=%s protocol=%s fingerprint=%s rows=%s',
               tenant_id,
               analyzer_channel,
               protocol,
               astm_message_sha256,
               row_count
             ),
             '; '
             ORDER BY tenant_id, analyzer_channel, protocol, astm_message_sha256
           )
      INTO duplicate_samples
      FROM (
        SELECT tenant_id,
               COALESCE(
                 analyzer_id::text,
                 'legacy:' || LOWER(NULLIF(BTRIM(analyzer_code), '')),
                 '<legacy-unresolved>'
               ) AS analyzer_channel,
               protocol,
               astm_message_sha256,
               COUNT(*) AS row_count
          FROM lab_interface_messages
         WHERE direction = 'inbound'
           AND protocol = 'astm_e1394'
         GROUP BY tenant_id,
                  COALESCE(
                    analyzer_id::text,
                    'legacy:' || LOWER(NULLIF(BTRIM(analyzer_code), '')),
                    '<legacy-unresolved>'
                  ),
                  protocol,
                  astm_message_sha256
        HAVING COUNT(*) > 1
         ORDER BY tenant_id, analyzer_channel, protocol, astm_message_sha256
         LIMIT 5
      ) AS sampled_duplicate_groups;

    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'Cannot install ASTM replay identity: %s duplicate raw-message group(s) exist',
        duplicate_group_count
      ),
      DETAIL = format('Sample duplicate groups: %s', COALESCE(duplicate_samples, 'none')),
      HINT = 'Reconcile duplicate ASTM inbox receipts before retrying; this migration never deletes clinical data.';
  END IF;
END
$$;

DO $$
DECLARE
  replay_index REGCLASS;
  replay_index_row pg_index%ROWTYPE;
  replay_predicate TEXT;
BEGIN
  replay_index := to_regclass('public.uq_lab_interface_astm_inbound_fingerprint');
  IF replay_index IS NULL THEN
    EXECUTE $index$
      CREATE UNIQUE INDEX uq_lab_interface_astm_inbound_fingerprint
        ON lab_interface_messages (
          tenant_id,
          (COALESCE(
            analyzer_id::text,
            'legacy:' || LOWER(NULLIF(BTRIM(analyzer_code), '')),
            '<legacy-unresolved>'
          )),
          protocol,
          astm_message_sha256
        )
        WHERE direction = 'inbound'
          AND protocol = 'astm_e1394'
    $index$;
    replay_index := 'uq_lab_interface_astm_inbound_fingerprint'::regclass;
  END IF;

  SELECT *
    INTO replay_index_row
    FROM pg_index
   WHERE indexrelid = replay_index;
  replay_predicate := pg_get_expr(
    replay_index_row.indpred,
    replay_index_row.indrelid
  );

  IF replay_index_row.indrelid IS DISTINCT FROM 'lab_interface_messages'::regclass
     OR replay_index_row.indisunique IS DISTINCT FROM TRUE
     OR replay_index_row.indisvalid IS DISTINCT FROM TRUE
     OR replay_index_row.indisready IS DISTINCT FROM TRUE
     OR replay_index_row.indnkeyatts IS DISTINCT FROM 4
     OR pg_get_indexdef(replay_index, 1, TRUE) IS DISTINCT FROM 'tenant_id'
     OR pg_get_indexdef(replay_index, 2, TRUE) IS DISTINCT FROM
          'COALESCE(analyzer_id::text, ''legacy:''::text || lower(NULLIF(btrim(analyzer_code::text), ''''::text)), ''<legacy-unresolved>''::text)'
     OR pg_get_indexdef(replay_index, 3, TRUE) IS DISTINCT FROM 'protocol'
     OR pg_get_indexdef(replay_index, 4, TRUE) IS DISTINCT FROM 'astm_message_sha256'
     OR replay_predicate IS DISTINCT FROM
          '(((direction)::text = ''inbound''::text) AND ((protocol)::text = ''astm_e1394''::text))'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'uq_lab_interface_astm_inbound_fingerprint has an incompatible definition';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_interface_messages'::regclass
       AND conname = 'ux_lab_interface_messages_tenant_id'
  ) THEN
    ALTER TABLE lab_interface_messages
      ADD CONSTRAINT ux_lab_interface_messages_tenant_id
      UNIQUE (tenant_id, id);
  ELSIF (
    SELECT pg_get_constraintdef(oid, TRUE)
      FROM pg_constraint
     WHERE conrelid = 'lab_interface_messages'::regclass
       AND conname = 'ux_lab_interface_messages_tenant_id'
  ) IS DISTINCT FROM 'UNIQUE (tenant_id, id)' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ux_lab_interface_messages_tenant_id has an incompatible definition';
  END IF;
END
$$;

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS interface_message_id INTEGER,
  ADD COLUMN IF NOT EXISTS interface_result_index INTEGER;

CREATE OR REPLACE FUNCTION lab_astm_migration_try_result_json(raw_result TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN raw_result::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION lab_astm_migration_threshold_assessment(
  target_tenant_id UUID,
  target_loinc_code TEXT,
  target_test_code TEXT,
  target_value NUMERIC,
  target_unit TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  threshold_record lab_critical_thresholds%ROWTYPE;
  best_match_count INTEGER;
  normalized_result_unit TEXT;
  normalized_threshold_unit TEXT;
  evaluated_value NUMERIC;
  breached_side TEXT;
  breached_value NUMERIC;
BEGIN
  WITH matches AS (
    SELECT threshold.*,
           CASE
             WHEN target_loinc_code IS NOT NULL
                  AND threshold.loinc_code = target_loinc_code THEN 0
             WHEN target_test_code IS NOT NULL
                  AND UPPER(threshold.test_code) = UPPER(target_test_code) THEN 1
             WHEN threshold.loinc_code IS NOT NULL
                  AND (
                    target_loinc_code IN ('6598-7', '10839-9')
                    OR UPPER(target_test_code) IN ('TROP', 'TROPI')
                  )
                  AND threshold.loinc_code IN ('6598-7', '10839-9') THEN 2
             ELSE 3
           END AS match_rank
      FROM lab_critical_thresholds AS threshold
     WHERE threshold.tenant_id = target_tenant_id
       AND threshold.is_active = TRUE
       AND (
         (target_loinc_code IS NOT NULL
            AND threshold.loinc_code = target_loinc_code)
         OR (target_test_code IS NOT NULL
            AND UPPER(threshold.test_code) = UPPER(target_test_code))
         OR (
           (
             target_loinc_code IN ('6598-7', '10839-9')
             OR UPPER(target_test_code) IN ('TROP', 'TROPI')
           )
           AND (
             threshold.loinc_code IN ('6598-7', '10839-9')
             OR UPPER(threshold.test_code) IN ('TROP', 'TROPI')
           )
         )
       )
  ), best AS (
    SELECT *
      FROM matches
     WHERE match_rank = (SELECT MIN(match_rank) FROM matches)
  )
  SELECT COUNT(*)::integer,
         MAX(id) AS id,
         MAX(loinc_code) AS loinc_code,
         MAX(test_code) AS test_code,
         MAX(unit) AS unit,
         MAX(applies_to) AS applies_to,
         MAX(critical_low) AS critical_low,
         MAX(critical_high) AS critical_high
    INTO best_match_count,
         threshold_record.id,
         threshold_record.loinc_code,
         threshold_record.test_code,
         threshold_record.unit,
         threshold_record.applies_to,
         threshold_record.critical_low,
         threshold_record.critical_high
    FROM best;

  IF best_match_count = 0 THEN
    RETURN jsonb_build_object(
      'safe', TRUE,
      'matched', FALSE,
      'breached', FALSE,
      'evaluated_value', target_value
    );
  END IF;
  IF best_match_count <> 1 THEN
    RETURN jsonb_build_object(
      'safe', FALSE,
      'matched', TRUE,
      'reason', 'threshold_ambiguous',
      'best_match_count', best_match_count
    );
  END IF;
  IF LOWER(COALESCE(NULLIF(BTRIM(threshold_record.applies_to), ''), 'all')) <> 'all' THEN
    RETURN jsonb_build_object(
      'safe', FALSE,
      'matched', TRUE,
      'reason', 'population_scope',
      'threshold_id', threshold_record.id,
      'threshold_applies_to', threshold_record.applies_to
    );
  END IF;
  IF target_value IS NULL THEN
    RETURN jsonb_build_object(
      'safe', FALSE,
      'matched', TRUE,
      'reason', 'numeric_value_required',
      'threshold_id', threshold_record.id
    );
  END IF;

  normalized_result_unit := LOWER(REPLACE(REPLACE(
    REGEXP_REPLACE(COALESCE(target_unit, ''), '\s+', '', 'g'),
    'μ', 'u'), 'µ', 'u'));
  normalized_threshold_unit := LOWER(REPLACE(REPLACE(
    REGEXP_REPLACE(COALESCE(threshold_record.unit, ''), '\s+', '', 'g'),
    'μ', 'u'), 'µ', 'u'));
  IF normalized_threshold_unit = ''
     OR normalized_result_unit = normalized_threshold_unit
  THEN
    evaluated_value := target_value;
  ELSIF normalized_threshold_unit IN ('10^3/ul', 'x10^3/ul', '10^9/l')
        AND normalized_result_unit IN ('/ul', 'cells/ul', 'count/ul')
  THEN
    evaluated_value := target_value / 1000;
  ELSIF normalized_result_unit IN ('10^3/ul', 'x10^3/ul', '10^9/l')
        AND normalized_threshold_unit IN ('/ul', 'cells/ul', 'count/ul')
  THEN
    evaluated_value := target_value * 1000;
  ELSE
    RETURN jsonb_build_object(
      'safe', FALSE,
      'matched', TRUE,
      'reason', 'threshold_unit',
      'threshold_id', threshold_record.id,
      'result_unit', target_unit,
      'threshold_unit', threshold_record.unit
    );
  END IF;

  IF threshold_record.critical_low IS NOT NULL
     AND evaluated_value < threshold_record.critical_low
  THEN
    breached_side := 'low';
    breached_value := threshold_record.critical_low;
  ELSIF threshold_record.critical_high IS NOT NULL
        AND evaluated_value > threshold_record.critical_high
  THEN
    breached_side := 'high';
    breached_value := threshold_record.critical_high;
  END IF;

  RETURN jsonb_build_object(
    'safe', TRUE,
    'matched', TRUE,
    'breached', breached_side IS NOT NULL,
    'threshold_id', threshold_record.id,
    'threshold_test_code', threshold_record.test_code,
    'threshold_loinc_code', threshold_record.loinc_code,
    'threshold_unit', threshold_record.unit,
    'threshold_applies_to', COALESCE(threshold_record.applies_to, 'all'),
    'critical_low', threshold_record.critical_low,
    'critical_high', threshold_record.critical_high,
    'breached_side', breached_side,
    'breached_value', breached_value,
    'evaluated_value', evaluated_value,
    'conversion', CASE
      WHEN normalized_result_unit = normalized_threshold_unit
        OR normalized_threshold_unit = '' THEN NULL
      WHEN evaluated_value = target_value / 1000
        THEN 'per_microliter_to_thousands_per_microliter'
      ELSE 'thousands_per_microliter_to_per_microliter'
    END
  );
END
$$;

CREATE OR REPLACE FUNCTION lab_astm_closed_acknowledgement_proof(
  target_tenant_id UUID,
  target_alert_id INTEGER,
  evidence_not_before TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
           'kind', 'migration_583_closed_critical_acknowledgement',
           'alert_id', alert.id,
           'task_id', task.id,
           'sla_instance_id', sla.id,
           'comment_id', receipt.comment_id,
           'timeline_event_id', acknowledgement_timeline.timeline_event_id,
           'audit_event_id', acknowledgement_audit.audit_event_id,
           'acknowledged_at', alert.acknowledged_at,
           'acknowledged_by', alert.acknowledged_by,
           'read_back_method', alert.read_back_method,
           'acknowledgement_authorization', task_receipt.authorization_mode,
           'task_acknowledged_at', task_receipt.acknowledged_at,
           'sla_completed_at', sla.completed_at,
           'comment_from_status', receipt.from_status,
           'comment_created_at', receipt.created_at,
           'timeline_occurred_at', acknowledgement_timeline.occurred_at,
           'audit_occurred_at', acknowledgement_audit.occurred_at,
           'ack_contract_version', 2,
           'canonical_timestamp_policy', 'acknowledgement_exact'
         )
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN task.metadata->>'acknowledged_at' ~
                      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                    AND pg_input_is_valid(
                          task.metadata->>'acknowledged_at',
                          'timestamp with time zone'
                        )
                 THEN (task.metadata->>'acknowledged_at')::timestamptz
               ELSE NULL
             END AS acknowledged_at,
             task.metadata->>'acknowledged_via' AS authorization_mode
    ) AS task_receipt
    JOIN LATERAL (
      SELECT COUNT(*)::integer AS candidate_count,
             MIN(comment.id) AS comment_id,
             MIN(comment.created_at) AS created_at,
             MIN(comment.metadata->>'from') AS from_status
        FROM task_comments AS comment
       WHERE comment.tenant_id = task.tenant_id
         AND comment.task_id = task.id
         AND comment.author_uid = alert.acknowledged_by
         AND comment.body_kind = 'state_change'
         AND comment.metadata->>'from' IN ('open', 'overdue', 'blocked')
         AND comment.metadata->>'to' = 'in_progress'
         AND comment.metadata->>'acknowledged_at' =
               task.metadata->>'acknowledged_at'
         AND comment.metadata->>'via' = task_receipt.authorization_mode
         AND comment.metadata->'ack_contract_version' = to_jsonb(2)
         AND comment.metadata->>'override_source' IS NOT DISTINCT FROM
               task.metadata->>'acknowledge_override_source'
         AND comment.metadata->>'override_id' IS NOT DISTINCT FROM
               task.metadata->>'acknowledge_override_id'
         AND comment.metadata->>'override_reason' IS NOT DISTINCT FROM
               task.metadata->>'acknowledge_override_reason'
         AND comment.created_at >= evidence_not_before
         AND ABS(EXTRACT(EPOCH FROM (
               comment.created_at - alert.acknowledged_at
             ))) <= 60
    ) AS receipt ON receipt.candidate_count = 1
    JOIN LATERAL (
      SELECT COUNT(*)::integer AS candidate_count,
             MIN(timeline.id::text)::uuid AS timeline_event_id,
             MIN(timeline.occurred_at) AS occurred_at
        FROM clinical_timeline_events AS timeline
       WHERE timeline.tenant_id = alert.tenant_id
         AND timeline.patient_uid = alert.patient_uid
         AND timeline.event_type = 'critical_result.acknowledged'
         AND timeline.event_status = 'acknowledged'
         AND timeline.source_table = 'lab_critical_alerts'
         AND timeline.source_id = alert.id::text
         AND timeline.resource_type = 'critical_lab_alert'
         AND timeline.resource_id = alert.id::text
         AND timeline.actor_uid = alert.acknowledged_by
         AND timeline.payload->'alert_id' = to_jsonb(alert.id)
         AND timeline.payload->'result_id' = to_jsonb(alert.result_id)
         AND timeline.payload->>'acknowledgement_authorization' =
               task_receipt.authorization_mode
         AND timeline.payload->'ack_contract_version' = to_jsonb(2)
         AND timeline.payload ? 'read_back_method'
         AND timeline.payload->>'read_back_method' IS NOT DISTINCT FROM
               alert.read_back_method
         AND timeline.payload->>'acknowledge_override_source'
               IS NOT DISTINCT FROM
                 task.metadata->>'acknowledge_override_source'
         AND timeline.payload->>'acknowledge_override_id'
               IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_id'
         AND timeline.payload->>'acknowledge_override_reason'
               IS NOT DISTINCT FROM
                 task.metadata->>'acknowledge_override_reason'
         AND timeline.idempotency_key =
               'lab_critical_alerts:' || alert.id || ':acknowledged'
         AND timeline.occurred_at = alert.acknowledged_at
    ) AS acknowledgement_timeline
      ON acknowledgement_timeline.candidate_count = 1
    JOIN LATERAL (
      SELECT COUNT(*)::integer AS candidate_count,
             MIN(audit.id::text)::uuid AS audit_event_id,
             MIN(audit.occurred_at) AS occurred_at
        FROM clinical_audit_events AS audit
       WHERE audit.tenant_id = alert.tenant_id
         AND audit.patient_uid = alert.patient_uid
         AND audit.action = 'critical_result.acknowledged'
         AND audit.action_status = 'success'
         AND audit.resource_table = 'lab_critical_alerts'
         AND audit.resource_id = alert.id::text
         AND audit.resource_type = 'critical_lab_alert'
         AND audit.actor_uid = alert.acknowledged_by
         AND audit.metadata->'ack_contract_version' = to_jsonb(2)
         AND audit.after_state->'ack_contract_version' = to_jsonb(2)
         AND audit.after_state ? 'acknowledged_at'
         AND CASE
               WHEN pg_input_is_valid(
                      audit.after_state->>'acknowledged_at',
                      'timestamp with time zone'
                    )
                 THEN (audit.after_state->>'acknowledged_at')::timestamptz =
                        alert.acknowledged_at
               ELSE FALSE
             END
         AND audit.after_state->>'acknowledged_by' =
               alert.acknowledged_by::text
         AND audit.after_state ? 'read_back_method'
         AND audit.after_state->>'read_back_method' IS NOT DISTINCT FROM
               alert.read_back_method
         AND audit.idempotency_key =
               'lab_critical_alerts:' || alert.id || ':audit:acknowledged'
         AND audit.occurred_at = alert.acknowledged_at
    ) AS acknowledgement_audit ON acknowledgement_audit.candidate_count = 1
   WHERE alert.tenant_id = target_tenant_id
     AND alert.id = target_alert_id
     AND alert.acknowledged_at IS NOT NULL
     AND alert.acknowledged_by IS NOT NULL
     AND alert.acknowledged_at >= alert.fired_at
     AND task.patient_uid = alert.patient_uid
     AND task.related_resource_type = 'lab_result'
     AND task.related_resource_id = alert.result_id::text
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('in_progress', 'completed')
     AND task.metadata->>'lab_critical_alert_id' = alert.id::text
     AND task.metadata->>'lab_alert_generation_state' =
           alert.generation_metadata->>'corrected_state'
     AND task.metadata->'ack_contract_version' = to_jsonb(2)
     AND (
       (
         alert.generation_signoff_id IS NULL
         AND NOT task.metadata ? 'lab_alert_generation_signoff_id'
       )
       OR task.metadata->>'lab_alert_generation_signoff_id' =
            alert.generation_signoff_id::text
     )
     AND LOWER(task.metadata->>'acknowledged_by') =
           LOWER(alert.acknowledged_by::text)
     AND task_receipt.authorization_mode IN (
           'assignee', 'role', 'admin', 'override'
         )
     AND task_receipt.acknowledged_at = alert.acknowledged_at
     AND (
       task_receipt.authorization_mode <> 'override'
       OR (
         NULLIF(BTRIM(task.metadata->>'acknowledge_override_source'), '')
           IS NOT NULL
         AND NULLIF(BTRIM(task.metadata->>'acknowledge_override_id'), '')
           IS NOT NULL
         AND NULLIF(BTRIM(task.metadata->>'acknowledge_override_reason'), '')
           IS NOT NULL
       )
     )
     AND sla.rule_code = 'critical_result_ack'
     AND sla.source_table = 'lab_result'
     AND sla.source_id = alert.result_id::text
     AND sla.patient_uid = alert.patient_uid
     AND sla.status IN ('completed', 'breached', 'escalated')
     AND sla.completed_at = alert.acknowledged_at
     AND sla.metadata->>'completed_via' = 'task_ack'
     AND sla.metadata->>'completed_by_task' = task.id::text
     AND LOWER(sla.metadata->>'completed_by') =
           LOWER(alert.acknowledged_by::text)
     AND sla.metadata->'ack_contract_version' = to_jsonb(2)
   LIMIT 1
$$;

-- A corrected generation reuses the resource SLA, so the predecessor's
-- closed clock is no longer present on the mutable SLA row. Migration 581
-- seals that exact v2 closure before re-arm. Revalidate the seal against the
-- immutable alert/task receipt/comment/canonical rows; never infer a prior
-- acknowledgement from the SLA's current state or reopen_history metadata.
CREATE OR REPLACE FUNCTION lab_astm_superseded_acknowledgement_proof(
  target_tenant_id UUID,
  target_alert_id INTEGER,
  evidence_not_before TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
           'kind', 'migration_583_superseded_critical_acknowledgement_receipt',
           'alert_id', sealed.alert_id,
           'task_id', sealed.acknowledgement_task_id,
           'sla_instance_id', sealed.workflow_sla_instance_id,
           'comment_id', sealed.task_comment_id,
           'timeline_event_id', sealed.timeline_event_id,
           'audit_event_id', sealed.audit_event_id,
           'acknowledged_at', sealed.acknowledged_at,
           'acknowledged_by', sealed.acknowledged_by,
           'read_back_method', sealed.read_back_method,
           'acknowledgement_authorization',
             sealed.acknowledgement_authorization,
           'sla_status_at_ack', sealed.sla_status_at_ack,
           'ack_contract_version', sealed.ack_contract_version,
           'receipt_created_at', sealed.created_at,
           'canonical_timestamp_policy', 'acknowledgement_exact'
         )
    FROM lab_critical_alert_acknowledgement_receipts AS sealed
    JOIN lab_critical_alerts AS alert
      ON alert.tenant_id = sealed.tenant_id
     AND alert.id = sealed.alert_id
    JOIN tasks AS task
      ON task.tenant_id = sealed.tenant_id
     AND task.id = sealed.acknowledgement_task_id
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = sealed.tenant_id
     AND sla.id = sealed.workflow_sla_instance_id
    JOIN task_comments AS receipt
      ON receipt.tenant_id = sealed.tenant_id
     AND receipt.id = sealed.task_comment_id
    JOIN clinical_timeline_events AS acknowledgement_timeline
      ON acknowledgement_timeline.tenant_id = sealed.tenant_id
     AND acknowledgement_timeline.id = sealed.timeline_event_id
    JOIN clinical_audit_events AS acknowledgement_audit
      ON acknowledgement_audit.tenant_id = sealed.tenant_id
     AND acknowledgement_audit.id = sealed.audit_event_id
   WHERE sealed.tenant_id = target_tenant_id
     AND sealed.alert_id = target_alert_id
     AND sealed.ack_contract_version = 2
     AND sealed.result_id = alert.result_id
     AND sealed.patient_uid = alert.patient_uid
     AND sealed.generation_signoff_id IS NOT DISTINCT FROM
           alert.generation_signoff_id
     AND sealed.generation_state =
           alert.generation_metadata->>'corrected_state'
     AND sealed.acknowledged_at = alert.acknowledged_at
     AND sealed.acknowledged_by = alert.acknowledged_by
     AND sealed.read_back_method IS NOT DISTINCT FROM alert.read_back_method
     AND sealed.acknowledged_at >= evidence_not_before
     AND sealed.created_at >= evidence_not_before
     AND sealed.created_at <= alert.superseded_at
     AND ABS(EXTRACT(EPOCH FROM (
           sealed.created_at - alert.acknowledged_at
         ))) <= 60
     AND alert.acknowledged_at IS NOT NULL
     AND alert.acknowledged_by IS NOT NULL
     AND alert.acknowledged_at >= alert.fired_at
     AND alert.superseded_at IS NOT NULL
     AND alert.superseded_at >= alert.acknowledged_at
     AND alert.superseded_by_alert_id IS NOT NULL
     AND alert.superseded_by_signoff_id IS NOT NULL
     AND alert.acknowledgement_task_id = sealed.acknowledgement_task_id
     AND task.patient_uid = alert.patient_uid
     AND task.related_resource_type = 'lab_result'
     AND task.related_resource_id = alert.result_id::text
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status = 'completed'
     AND task.metadata->'ack_contract_version' = to_jsonb(2)
     AND task.metadata->>'lab_critical_alert_id' = alert.id::text
     AND task.metadata->>'lab_alert_generation_state' =
           alert.generation_metadata->>'corrected_state'
     AND (
       (
         alert.generation_signoff_id IS NULL
         AND NOT task.metadata ? 'lab_alert_generation_signoff_id'
       )
       OR task.metadata->>'lab_alert_generation_signoff_id' =
            alert.generation_signoff_id::text
     )
     AND task.metadata->>'acknowledged_by' = alert.acknowledged_by::text
     AND task.metadata->>'acknowledged_via' =
           sealed.acknowledgement_authorization
     AND CASE
           WHEN pg_input_is_valid(
                  task.metadata->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (task.metadata->>'acknowledged_at')::timestamptz =
                    alert.acknowledged_at
           ELSE FALSE
         END
     AND (
       (sealed.acknowledgement_authorization = 'assignee'
         AND task.assigned_to_uid = alert.acknowledged_by)
       OR (sealed.acknowledgement_authorization = 'role'
         AND NULLIF(BTRIM(task.assigned_to_role), '') IS NOT NULL)
       OR sealed.acknowledgement_authorization = 'admin'
       OR (
         sealed.acknowledgement_authorization = 'override'
         AND sealed.override_source = 'patient_access_break_glass'
         AND task.metadata->>'acknowledge_override_source' =
               sealed.override_source
         AND task.metadata->>'acknowledge_override_id' = sealed.override_id
         AND sealed.override_reason_sha256 = encode(public.digest(
               task.metadata->>'acknowledge_override_reason', 'sha256'
             ), 'hex')
         AND pg_input_is_valid(sealed.override_id, 'integer')
         AND EXISTS (
           SELECT 1
             FROM patient_access_break_glass AS break_glass
            WHERE break_glass.id = sealed.override_id::integer
              AND break_glass.tenant_id = alert.tenant_id
              AND break_glass.patient_uid = alert.patient_uid
              AND break_glass.actor_uid = alert.acknowledged_by
              AND break_glass.reason =
                    task.metadata->>'acknowledge_override_reason'
              AND break_glass.started_at <= alert.acknowledged_at
              AND break_glass.expires_at > alert.acknowledged_at
              AND (
                break_glass.ended_at IS NULL
                OR break_glass.ended_at >= alert.acknowledged_at
              )
         )
       )
     )
     AND (
       sealed.acknowledgement_authorization = 'override'
       OR (
         num_nonnulls(
           sealed.override_source,
           sealed.override_id,
           sealed.override_reason_sha256
         ) = 0
         AND num_nonnulls(
           task.metadata->>'acknowledge_override_source',
           task.metadata->>'acknowledge_override_id',
           task.metadata->>'acknowledge_override_reason'
         ) = 0
       )
     )
     AND sla.rule_code = 'critical_result_ack'
     AND sla.source_table = 'lab_result'
     AND sla.source_id = alert.result_id::text
     AND sla.patient_uid = alert.patient_uid
     AND sealed.task_status_at_ack IN ('in_progress', 'completed')
     AND sealed.sla_status_at_ack IN ('completed', 'breached', 'escalated')
     AND sealed.sla_completed_at = alert.acknowledged_at
     AND sealed.sla_completed_via = 'task_ack'
     AND sealed.sla_completed_by_task = task.id
     AND sealed.sla_completed_by = alert.acknowledged_by
     AND receipt.task_id = task.id
     AND receipt.author_uid = alert.acknowledged_by
     AND receipt.body_kind = 'state_change'
     AND receipt.metadata->'ack_contract_version' = to_jsonb(2)
     AND receipt.metadata->>'from' = sealed.comment_from_status
     AND sealed.comment_from_status IN ('open', 'overdue', 'blocked')
     AND receipt.metadata->>'to' = 'in_progress'
     AND receipt.metadata->>'via' = sealed.acknowledgement_authorization
     AND CASE
           WHEN pg_input_is_valid(
                  receipt.metadata->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (receipt.metadata->>'acknowledged_at')::timestamptz =
                    alert.acknowledged_at
           ELSE FALSE
         END
     AND ABS(EXTRACT(EPOCH FROM (
           receipt.created_at - alert.acknowledged_at
         ))) <= 60
     AND receipt.metadata->>'override_source' IS NOT DISTINCT FROM
           task.metadata->>'acknowledge_override_source'
     AND receipt.metadata->>'override_id' IS NOT DISTINCT FROM
           task.metadata->>'acknowledge_override_id'
     AND receipt.metadata->>'override_reason' IS NOT DISTINCT FROM
           task.metadata->>'acknowledge_override_reason'
     AND acknowledgement_timeline.patient_uid = alert.patient_uid
     AND acknowledgement_timeline.event_type = 'critical_result.acknowledged'
     AND acknowledgement_timeline.event_status = 'acknowledged'
     AND acknowledgement_timeline.source_table = 'lab_critical_alerts'
     AND acknowledgement_timeline.source_id = alert.id::text
     AND acknowledgement_timeline.resource_type = 'critical_lab_alert'
     AND acknowledgement_timeline.resource_id = alert.id::text
     AND acknowledgement_timeline.actor_uid = alert.acknowledged_by
     AND acknowledgement_timeline.occurred_at = alert.acknowledged_at
     AND acknowledgement_timeline.idempotency_key =
           'lab_critical_alerts:' || alert.id || ':acknowledged'
     AND acknowledgement_timeline.payload->'ack_contract_version' =
           to_jsonb(2)
     AND acknowledgement_timeline.payload->'alert_id' = to_jsonb(alert.id)
     AND acknowledgement_timeline.payload->'result_id' =
           to_jsonb(alert.result_id)
     AND acknowledgement_timeline.payload->>'acknowledgement_authorization' =
           sealed.acknowledgement_authorization
     AND acknowledgement_timeline.payload ? 'read_back_method'
     AND acknowledgement_timeline.payload->>'read_back_method'
           IS NOT DISTINCT FROM alert.read_back_method
     AND acknowledgement_timeline.payload->>'acknowledge_override_source'
           IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_source'
     AND acknowledgement_timeline.payload->>'acknowledge_override_id'
           IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_id'
     AND acknowledgement_timeline.payload->>'acknowledge_override_reason'
           IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_reason'
     AND acknowledgement_audit.patient_uid = alert.patient_uid
     AND acknowledgement_audit.action = 'critical_result.acknowledged'
     AND acknowledgement_audit.action_status = 'success'
     AND acknowledgement_audit.resource_table = 'lab_critical_alerts'
     AND acknowledgement_audit.resource_id = alert.id::text
     AND acknowledgement_audit.resource_type = 'critical_lab_alert'
     AND acknowledgement_audit.actor_uid = alert.acknowledged_by
     AND acknowledgement_audit.occurred_at = alert.acknowledged_at
     AND acknowledgement_audit.idempotency_key =
           'lab_critical_alerts:' || alert.id || ':audit:acknowledged'
     AND acknowledgement_audit.metadata->'ack_contract_version' = to_jsonb(2)
     AND acknowledgement_audit.after_state->'ack_contract_version' =
           to_jsonb(2)
     AND acknowledgement_audit.after_state ? 'acknowledged_at'
     AND CASE
           WHEN pg_input_is_valid(
                  acknowledgement_audit.after_state->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (
                    acknowledgement_audit.after_state->>'acknowledged_at'
                  )::timestamptz = alert.acknowledged_at
           ELSE FALSE
         END
     AND acknowledgement_audit.after_state->>'acknowledged_by' =
           alert.acknowledged_by::text
     AND acknowledgement_audit.after_state ? 'read_back_method'
     AND acknowledgement_audit.after_state->>'read_back_method'
           IS NOT DISTINCT FROM alert.read_back_method
   LIMIT 1
$$;

-- Adopt a legacy ingested receipt only when the old rows themselves prove one
-- exact ordered result set. The window must not overlap another receipt on the
-- same analyzer/specimen, every raw result must match the corresponding ASTM R
-- record, source identities must agree, and the old aggregate timeline/audit
-- pair must exist. Potentially missed critical values are never adopted.
DO $astm_legacy_adoption$
DECLARE
  message_record RECORD;
  source_record RECORD;
  header_count INTEGER;
  order_count INTEGER;
  parsed_result_count INTEGER;
  terminator_count INTEGER;
  nonblank_record_count INTEGER;
  invalid_record_count INTEGER;
  invalid_record_order_count INTEGER;
  invalid_result_status_count INTEGER;
  invalid_result_sequence_count INTEGER;
  header_position BIGINT;
  order_position BIGINT;
  first_result_position BIGINT;
  last_result_position BIGINT;
  terminator_position BIGINT;
  parsed_accession TEXT;
  parsed_sender_identity TEXT;
  parsed_order_test_code TEXT;
  configured_sender_match_count INTEGER;
  configured_actor_match_count INTEGER;
  overlapping_receipt_count INTEGER;
  timeline_count INTEGER;
  audit_count INTEGER;
  candidate_ids INTEGER[];
  candidate_count INTEGER;
  mismatch_count INTEGER;
  missed_critical_count INTEGER;
  adopted_result RECORD;
  aggregate_timeline RECORD;
  legacy_acknowledgement_proof JSONB;
  legacy_acknowledgement_proof_count INTEGER;
BEGIN
  FOR message_record IN
    SELECT message.*
      FROM lab_interface_messages AS message
     WHERE message.direction = 'inbound'
       AND message.protocol = 'astm_e1394'
       AND message.status = 'ingested'
       AND message.ingest_contract_version IS NULL
     ORDER BY message.tenant_id, message.id
  LOOP
    IF message_record.analyzer_id IS NULL
       OR message_record.result_count IS NULL
       OR message_record.result_count <= 0
       OR message_record.specimen_id IS NULL
       OR message_record.processed_at IS NULL
       OR message_record.error IS NOT NULL
       OR message_record.verdicts IS NULL
       OR jsonb_typeof(message_record.verdicts) IS DISTINCT FROM 'array'
       OR jsonb_array_length(message_record.verdicts) <> message_record.result_count
    THEN
      CONTINUE;
    END IF;

    SELECT specimen.id AS specimen_id,
           specimen.patient_uid AS specimen_patient_uid,
           specimen.booking_id AS specimen_booking_id,
           specimen.status AS specimen_status,
           specimen.accession_number,
           specimen.barcode,
           booking.id AS booking_id,
           booking.patient_id AS booking_patient_id,
           booking.investigation_id AS booking_investigation_id,
           booking.status AS booking_status,
           booking_patient.uid AS booking_patient_uid,
           investigation.id AS investigation_id,
           investigation.patient_uid AS investigation_patient_uid,
           investigation.status AS investigation_status,
           analyzer.id AS analyzer_id,
           analyzer.analyzer_code,
           analyzer.metadata AS analyzer_metadata
      INTO source_record
       FROM lab_specimens AS specimen
       JOIN users AS specimen_patient
         ON specimen_patient.tenant_id = specimen.tenant_id
        AND specimen_patient.uid = specimen.patient_uid
        AND UPPER(specimen_patient.role) = 'PATIENT'
        AND specimen_patient.is_active = TRUE
        AND specimen_patient.status = 'active'
        AND specimen_patient.is_deleted = FALSE
       JOIN lab_analyzers AS analyzer
        ON analyzer.tenant_id = specimen.tenant_id
       AND analyzer.id = message_record.analyzer_id
       AND analyzer.interface_kind = 'astm'
       AND analyzer.status = 'active'
      LEFT JOIN investigation_bookings AS booking
        ON booking.tenant_id = specimen.tenant_id
       AND booking.id = specimen.booking_id
       LEFT JOIN users AS booking_patient
         ON booking_patient.tenant_id = booking.tenant_id
        AND booking_patient.id = booking.patient_id
        AND UPPER(booking_patient.role) = 'PATIENT'
        AND booking_patient.is_active = TRUE
        AND booking_patient.status = 'active'
        AND booking_patient.is_deleted = FALSE
      LEFT JOIN investigations AS investigation
        ON investigation.tenant_id = booking.tenant_id
       AND investigation.id = booking.investigation_id
     WHERE specimen.tenant_id = message_record.tenant_id
       AND specimen.id = message_record.specimen_id;
    IF NOT FOUND
       OR LOWER(source_record.specimen_status) NOT IN ('received', 'processing')
       OR (source_record.specimen_booking_id IS NULL) IS DISTINCT FROM
            (source_record.booking_id IS NULL)
       OR (
         source_record.booking_id IS NOT NULL
         AND source_record.booking_patient_uid IS DISTINCT FROM
               source_record.specimen_patient_uid
       )
       OR (
         source_record.booking_id IS NOT NULL
         AND UPPER(source_record.booking_status) NOT IN (
               'BOOKED', 'CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING'
             )
       )
       OR (
         source_record.booking_investigation_id IS NOT NULL
         AND (
           source_record.investigation_id IS NULL
           OR source_record.investigation_patient_uid IS DISTINCT FROM
                source_record.specimen_patient_uid
           OR UPPER(source_record.investigation_status) NOT IN (
                'REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED', 'IN_PROGRESS'
              )
         )
       )
       OR message_record.analyzer_code IS DISTINCT FROM
            source_record.analyzer_code
    THEN
      CONTINUE;
    END IF;

    WITH records AS (
      SELECT BTRIM(record) AS record,
             record_ordinal,
             ROW_NUMBER() OVER (ORDER BY record_ordinal) AS record_position,
             COUNT(*) FILTER (
               WHERE SPLIT_PART(BTRIM(record), '|', 1) = 'R'
             )
               OVER (ORDER BY record_ordinal) AS result_sequence
        FROM regexp_split_to_table(
               message_record.raw_message,
               E'\\r\\n|\\r|\\n'
             ) WITH ORDINALITY AS parsed(record, record_ordinal)
       WHERE BTRIM(record) <> ''
    )
    SELECT COUNT(*) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'H')::integer,
           COUNT(*) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'O')::integer,
           COUNT(*) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'R')::integer,
           COUNT(*) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'L')::integer,
           COUNT(*)::integer,
           COUNT(*) FILTER (
              WHERE SPLIT_PART(record, '|', 1)
                    NOT IN ('H', 'P', 'O', 'R', 'C', 'L')
            )::integer,
           MIN(record_position) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'H'),
           MIN(record_position) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'O'),
           MIN(record_position) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'R'),
           MAX(record_position) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'R'),
           MIN(record_position) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'L'),
           MAX(NULLIF(BTRIM(SPLIT_PART(record, '|', 3)), ''))
              FILTER (WHERE SPLIT_PART(record, '|', 1) = 'O'),
           MAX(NULLIF(BTRIM(SPLIT_PART(record, '|', 5)), ''))
              FILTER (WHERE SPLIT_PART(record, '|', 1) = 'H'),
           MAX(NULLIF(
             BTRIM(REGEXP_REPLACE(SPLIT_PART(record, '|', 5), '^.*\^', '')),
             ''
            )) FILTER (WHERE SPLIT_PART(record, '|', 1) = 'O'),
           COUNT(*) FILTER (
              WHERE SPLIT_PART(record, '|', 1) = 'R'
               AND UPPER(NULLIF(BTRIM(SPLIT_PART(record, '|', 9)), ''))
                     IS DISTINCT FROM 'F'
           )::integer,
           COUNT(*) FILTER (
              WHERE SPLIT_PART(record, '|', 1) = 'R'
               AND NULLIF(BTRIM(SPLIT_PART(record, '|', 4)), '') IS NULL
           )::integer,
           COUNT(*) FILTER (
              WHERE SPLIT_PART(record, '|', 1) = 'O'
               AND NULLIF(BTRIM(SPLIT_PART(record, '|', 2)), '')
                     IS DISTINCT FROM '1'
           )::integer
           + COUNT(*) FILTER (
              WHERE SPLIT_PART(record, '|', 1) = 'L'
               AND NULLIF(BTRIM(SPLIT_PART(record, '|', 2)), '')
                     IS DISTINCT FROM '1'
           )::integer
           + COUNT(*) FILTER (
              WHERE SPLIT_PART(record, '|', 1) = 'R'
               AND NULLIF(BTRIM(SPLIT_PART(record, '|', 2)), '')
                     IS DISTINCT FROM result_sequence::text
           )::integer
      INTO header_count,
           order_count,
           parsed_result_count,
           terminator_count,
           nonblank_record_count,
           invalid_record_count,
           header_position,
           order_position,
           first_result_position,
           last_result_position,
           terminator_position,
           parsed_accession,
           parsed_sender_identity,
           parsed_order_test_code,
           invalid_result_status_count,
           mismatch_count,
           invalid_result_sequence_count
      FROM records;

    WITH records AS (
      SELECT BTRIM(record) AS record,
             ROW_NUMBER() OVER (ORDER BY record_ordinal) AS record_position
        FROM regexp_split_to_table(
               message_record.raw_message,
               E'\\r\\n|\\r|\\n'
             ) WITH ORDINALITY AS parsed(record, record_ordinal)
       WHERE BTRIM(record) <> ''
    )
    SELECT COUNT(*)::integer
      INTO invalid_record_order_count
      FROM records
     WHERE (SPLIT_PART(record, '|', 1) = 'P'
              AND NOT (record_position > header_position
                       AND record_position < order_position))
        OR (SPLIT_PART(record, '|', 1) IN ('R', 'C')
              AND NOT (record_position > order_position
                       AND record_position < terminator_position));

    IF header_count <> 1
       OR order_count <> 1
       OR parsed_result_count <> message_record.result_count
       OR message_record.result_count <> 1
       OR terminator_count <> 1
       OR invalid_record_count <> 0
       OR invalid_record_order_count <> 0
       OR invalid_result_status_count <> 0
       OR mismatch_count <> 0
       OR invalid_result_sequence_count <> 0
       OR header_position IS DISTINCT FROM 1
       OR NOT (header_position < order_position)
       OR NOT (order_position < first_result_position)
       OR NOT (last_result_position < terminator_position)
       OR terminator_position IS DISTINCT FROM nonblank_record_count
       OR parsed_accession IS NULL
       OR parsed_sender_identity IS NULL
       OR parsed_order_test_code IS NULL
       OR (
         message_record.result_count = 1
         AND UPPER(parsed_order_test_code) IS DISTINCT FROM (
            SELECT UPPER(NULLIF(BTRIM(
                     REGEXP_REPLACE(SPLIT_PART(BTRIM(record), '|', 3), '^.*\^', '')
                   ), ''))
             FROM regexp_split_to_table(
                    message_record.raw_message,
                    E'\\r\\n|\\r|\\n'
                  ) AS record
            WHERE SPLIT_PART(BTRIM(record), '|', 1) = 'R'
            LIMIT 1
         )
       )
       OR NOT (
         UPPER(parsed_accession) = UPPER(source_record.accession_number)
         OR UPPER(parsed_accession) = UPPER(source_record.barcode)
       )
    THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*)::integer
      INTO configured_sender_match_count
      FROM lab_analyzers AS candidate_analyzer
     WHERE candidate_analyzer.tenant_id = message_record.tenant_id
       AND candidate_analyzer.status = 'active'
       AND candidate_analyzer.interface_kind = 'astm'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                      CASE
                        WHEN jsonb_typeof(
                               candidate_analyzer.metadata->'astm_sender_aliases'
                             ) = 'array'
                          THEN candidate_analyzer.metadata->'astm_sender_aliases'
                        ELSE '[]'::jsonb
                      END
                    ) AS alias(value)
              WHERE LOWER(BTRIM(alias.value)) = LOWER(parsed_sender_identity)
           );
    IF configured_sender_match_count <> 1
       OR NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                     CASE
                       WHEN jsonb_typeof(
                              source_record.analyzer_metadata->'astm_sender_aliases'
                            ) = 'array'
                         THEN source_record.analyzer_metadata->'astm_sender_aliases'
                       ELSE '[]'::jsonb
                     END
                   ) AS alias(value)
             WHERE LOWER(BTRIM(alias.value)) = LOWER(parsed_sender_identity)
          )
    THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*)::integer
      INTO overlapping_receipt_count
      FROM lab_interface_messages AS other
     WHERE other.tenant_id = message_record.tenant_id
       AND other.id <> message_record.id
       AND other.direction = 'inbound'
       AND other.protocol = 'astm_e1394'
       AND other.status = 'ingested'
       AND other.analyzer_id = message_record.analyzer_id
       AND other.specimen_id = message_record.specimen_id
       AND other.processed_at IS NOT NULL
       AND tstzrange(other.created_at, other.processed_at, '[]')
             && tstzrange(message_record.created_at, message_record.processed_at, '[]');
    IF overlapping_receipt_count <> 0 THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*)::integer
      INTO timeline_count
      FROM clinical_timeline_events AS timeline
     WHERE timeline.tenant_id = message_record.tenant_id
       AND timeline.event_type = 'lab.analyzer_results_ingested'
       AND timeline.source_table = 'lab_interface_messages'
       AND timeline.source_id = message_record.id::text
       AND timeline.patient_uid = source_record.specimen_patient_uid;
    SELECT COUNT(*)::integer
      INTO audit_count
      FROM clinical_audit_events AS audit
     WHERE audit.tenant_id = message_record.tenant_id
       AND audit.action = 'lab.analyzer_results_ingested'
       AND audit.resource_table = 'lab_interface_messages'
       AND audit.resource_id = message_record.id::text
       AND audit.patient_uid = source_record.specimen_patient_uid;
    IF timeline_count <> 1 OR audit_count <> 1 THEN
      CONTINUE;
    END IF;

    SELECT timeline.actor_uid, UPPER(BTRIM(timeline.actor_role)) AS actor_role
      INTO aggregate_timeline
      FROM clinical_timeline_events AS timeline
     WHERE timeline.tenant_id = message_record.tenant_id
       AND timeline.event_type = 'lab.analyzer_results_ingested'
       AND timeline.source_table = 'lab_interface_messages'
       AND timeline.source_id = message_record.id::text
       AND timeline.patient_uid = source_record.specimen_patient_uid;
    IF aggregate_timeline.actor_uid IS NULL
       OR aggregate_timeline.actor_role NOT IN (
            'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST', 'ADMIN',
            'SUPER_ADMIN', 'WEBHOOK_CLIENT', 'DEVICE_GATEWAY'
          )
       OR NOT EXISTS (
            SELECT 1
              FROM users AS actor
             WHERE actor.tenant_id = message_record.tenant_id
               AND actor.uid = aggregate_timeline.actor_uid
               AND actor.is_active = TRUE
               AND actor.status = 'active'
               AND UPPER(BTRIM(actor.role)) = aggregate_timeline.actor_role
          )
    THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*)::integer
      INTO configured_actor_match_count
      FROM lab_analyzers AS candidate_analyzer
     WHERE candidate_analyzer.tenant_id = message_record.tenant_id
       AND candidate_analyzer.status = 'active'
       AND candidate_analyzer.interface_kind = 'astm'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                      CASE
                        WHEN jsonb_typeof(
                               candidate_analyzer.metadata
                                 ->'astm_manual_import_actor_uids'
                             ) = 'array'
                          THEN candidate_analyzer.metadata
                                 ->'astm_manual_import_actor_uids'
                        ELSE '[]'::jsonb
                      END
                    ) AS allowed_actor(value)
              WHERE LOWER(BTRIM(allowed_actor.value)) =
                    LOWER(aggregate_timeline.actor_uid::text)
           );
    IF configured_actor_match_count <> 1
       OR NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                     CASE
                       WHEN jsonb_typeof(
                              source_record.analyzer_metadata
                                ->'astm_manual_import_actor_uids'
                            ) = 'array'
                         THEN source_record.analyzer_metadata
                                ->'astm_manual_import_actor_uids'
                       ELSE '[]'::jsonb
                     END
                   ) AS allowed_actor(value)
             WHERE LOWER(BTRIM(allowed_actor.value)) =
                   LOWER(aggregate_timeline.actor_uid::text)
          )
    THEN
      CONTINUE;
    END IF;

    WITH records AS (
      SELECT BTRIM(record) AS record, record_ordinal
        FROM regexp_split_to_table(
               message_record.raw_message,
               E'\\r\\n|\\r|\\n'
             ) WITH ORDINALITY AS parsed(record, record_ordinal)
       WHERE SPLIT_PART(BTRIM(record), '|', 1) = 'R'
    ),
    expected AS (
      SELECT ROW_NUMBER() OVER (ORDER BY record_ordinal)::integer AS result_index,
             NULLIF(BTRIM(
               REGEXP_REPLACE(SPLIT_PART(record, '|', 3), '^.*\^', '')
             ), '') AS test_code,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 4)), '') AS value_text,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 5)), '') AS unit,
             NULLIF(REPLACE(BTRIM(SPLIT_PART(record, '|', 6)), '^', '-'), '')
               AS reference_range,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 7)), '') AS abnormal_flag,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 9)), '') AS result_status
        FROM records
    ),
    candidates AS (
      SELECT result.id
        FROM lab_results AS result
       WHERE result.tenant_id = message_record.tenant_id
         AND result.specimen_id = message_record.specimen_id
         AND result.analyzer_id = message_record.analyzer_id
         AND result.patient_uid = source_record.specimen_patient_uid
         AND result.booking_id IS NOT DISTINCT FROM source_record.specimen_booking_id
         AND result.interface_message_id IS NULL
         AND result.interface_result_index IS NULL
         AND result.received_at >= message_record.created_at
         AND result.received_at <= message_record.processed_at
         AND EXISTS (
           SELECT 1
             FROM expected
            WHERE result.test_code IS NOT DISTINCT FROM expected.test_code
              AND result.value_text IS NOT DISTINCT FROM expected.value_text
              AND result.unit IS NOT DISTINCT FROM expected.unit
              AND result.reference_range IS NOT DISTINCT FROM expected.reference_range
              AND result.abnormal_flag IS NOT DISTINCT FROM expected.abnormal_flag
              AND lab_astm_migration_try_result_json(result.raw_obx)->>'test_code'
                    IS NOT DISTINCT FROM expected.test_code
              AND lab_astm_migration_try_result_json(result.raw_obx)->>'value_text'
                    IS NOT DISTINCT FROM expected.value_text
              AND lab_astm_migration_try_result_json(result.raw_obx)->>'unit'
                    IS NOT DISTINCT FROM expected.unit
              AND lab_astm_migration_try_result_json(result.raw_obx)->>'reference_range'
                    IS NOT DISTINCT FROM expected.reference_range
              AND lab_astm_migration_try_result_json(result.raw_obx)->>'abnormal_flag'
                    IS NOT DISTINCT FROM expected.abnormal_flag
              AND lab_astm_migration_try_result_json(result.raw_obx)->>'result_status'
                    IS NOT DISTINCT FROM expected.result_status
         )
    )
    SELECT COALESCE(ARRAY_AGG(id ORDER BY id), ARRAY[]::integer[]),
           COUNT(*)::integer
      INTO candidate_ids, candidate_count
      FROM candidates;
    IF candidate_count <> message_record.result_count THEN
      CONTINUE;
    END IF;

    WITH records AS (
      SELECT BTRIM(record) AS record, record_ordinal
        FROM regexp_split_to_table(
               message_record.raw_message,
               E'\\r\\n|\\r|\\n'
             ) WITH ORDINALITY AS parsed(record, record_ordinal)
       WHERE SPLIT_PART(BTRIM(record), '|', 1) = 'R'
    ),
    expected AS (
      SELECT ROW_NUMBER() OVER (ORDER BY record_ordinal)::integer AS result_index,
             NULLIF(BTRIM(
               REGEXP_REPLACE(SPLIT_PART(record, '|', 3), '^.*\^', '')
             ), '') AS test_code,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 4)), '') AS value_text,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 5)), '') AS unit,
             NULLIF(REPLACE(BTRIM(SPLIT_PART(record, '|', 6)), '^', '-'), '')
               AS reference_range,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 7)), '') AS abnormal_flag,
             NULLIF(BTRIM(SPLIT_PART(record, '|', 9)), '') AS result_status
        FROM records
    ),
    adopted AS (
      SELECT result.*, result_position::integer AS result_index,
             lab_astm_migration_try_result_json(result.raw_obx) AS raw_result
        FROM unnest(candidate_ids) WITH ORDINALITY
             AS candidate(result_id, result_position)
        JOIN lab_results AS result ON result.id = candidate.result_id
    )
    SELECT COUNT(*)::integer
      INTO mismatch_count
      FROM expected
      FULL JOIN adopted USING (result_index)
     WHERE expected.result_index IS NULL
        OR adopted.result_index IS NULL
        OR adopted.test_code IS DISTINCT FROM expected.test_code
        OR adopted.value_text IS DISTINCT FROM expected.value_text
        OR adopted.unit IS DISTINCT FROM expected.unit
        OR adopted.reference_range IS DISTINCT FROM expected.reference_range
        OR adopted.abnormal_flag IS DISTINCT FROM expected.abnormal_flag
        OR adopted.raw_result->>'test_code' IS DISTINCT FROM expected.test_code
        OR adopted.raw_result->>'value_text' IS DISTINCT FROM expected.value_text
        OR adopted.raw_result->>'unit' IS DISTINCT FROM expected.unit
        OR adopted.raw_result->>'reference_range' IS DISTINCT FROM expected.reference_range
        OR adopted.raw_result->>'abnormal_flag' IS DISTINCT FROM expected.abnormal_flag
        OR adopted.raw_result->>'result_status' IS DISTINCT FROM expected.result_status
        OR 1 <> (
          SELECT COUNT(*)
            FROM jsonb_array_elements(message_record.verdicts)
                 WITH ORDINALITY AS verdict(value, verdict_index)
           WHERE verdict.verdict_index = expected.result_index
             AND jsonb_typeof(verdict.value) = 'object'
             AND verdict.value->>'test_code' IS NOT DISTINCT FROM expected.test_code
             AND verdict.value->>'decision' IN (
                   'critical', 'hold_for_review', 'auto_verify'
                 )
             AND NULLIF(BTRIM(verdict.value->>'critical_band'), '') IS NOT NULL
        );
    IF mismatch_count <> 0 THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*)::integer
      INTO missed_critical_count
      FROM lab_results AS result
     WHERE result.id = ANY(candidate_ids)
       AND (
         lab_astm_migration_threshold_assessment(
           result.tenant_id,
           result.loinc_code,
           result.test_code,
           result.value_numeric,
           result.unit
         )->>'safe' IS DISTINCT FROM 'true'
         OR (
           lab_astm_migration_threshold_assessment(
             result.tenant_id,
             result.loinc_code,
             result.test_code,
             result.value_numeric,
             result.unit
           )->>'breached' = 'true'
           AND result.is_critical = FALSE
         )
       );
    IF missed_critical_count <> 0 THEN
      CONTINUE;
    END IF;

    UPDATE lab_results AS result
       SET interface_message_id = message_record.id,
           interface_result_index = candidate.result_position::integer,
           investigation_id = source_record.investigation_id,
           updated_at = NOW()
      FROM unnest(candidate_ids) WITH ORDINALITY
           AS candidate(result_id, result_position)
     WHERE result.id = candidate.result_id
       AND result.tenant_id = message_record.tenant_id
       AND result.interface_message_id IS NULL
       AND result.interface_result_index IS NULL;
    GET DIAGNOSTICS candidate_count = ROW_COUNT;
    IF candidate_count <> message_record.result_count THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Legacy ASTM result adoption changed concurrently';
    END IF;

    SELECT timeline.actor_uid, timeline.actor_role
      INTO aggregate_timeline
      FROM clinical_timeline_events AS timeline
     WHERE timeline.tenant_id = message_record.tenant_id
       AND timeline.event_type = 'lab.analyzer_results_ingested'
       AND timeline.source_table = 'lab_interface_messages'
       AND timeline.source_id = message_record.id::text
       AND timeline.patient_uid = source_record.specimen_patient_uid;

    FOR adopted_result IN
      SELECT result.*
        FROM lab_results AS result
       WHERE result.tenant_id = message_record.tenant_id
         AND result.interface_message_id = message_record.id
       ORDER BY result.interface_result_index
    LOOP
      legacy_acknowledgement_proof := NULL;
      legacy_acknowledgement_proof_count := 0;
      IF adopted_result.is_critical = TRUE THEN
        SELECT COUNT(*)::integer,
               (jsonb_agg(candidate.proof ORDER BY candidate.alert_id)->0)
          INTO legacy_acknowledgement_proof_count,
               legacy_acknowledgement_proof
          FROM (
            SELECT alert.id AS alert_id,
                   lab_astm_closed_acknowledgement_proof(
                     alert.tenant_id,
                     alert.id,
                     message_record.created_at
                   ) AS proof
              FROM lab_critical_alerts AS alert
             WHERE alert.tenant_id = adopted_result.tenant_id
               AND alert.result_id = adopted_result.id
               AND alert.patient_uid = adopted_result.patient_uid
               AND alert.generation_signoff_id IS NULL
               AND alert.generation_metadata->>'kind' = 'initial_result_generation'
               AND alert.generation_metadata->>'acknowledgement_task_id' =
                     alert.acknowledgement_task_id::text
               AND alert.generation_metadata->>'corrected_state' = 'critical'
               AND alert.superseded_at IS NULL
               AND alert.value_numeric IS NOT DISTINCT FROM adopted_result.value_numeric
               AND alert.unit IS NOT DISTINCT FROM adopted_result.unit
               AND alert.threshold_breached =
                     lab_astm_migration_threshold_assessment(
                       adopted_result.tenant_id,
                       adopted_result.loinc_code,
                       adopted_result.test_code,
                       adopted_result.value_numeric,
                       adopted_result.unit
                     )->>'breached_side'
               AND to_jsonb(alert.threshold_value) =
                     lab_astm_migration_threshold_assessment(
                       adopted_result.tenant_id,
                       adopted_result.loinc_code,
                       adopted_result.test_code,
                       adopted_result.value_numeric,
                       adopted_result.unit
                      )->'breached_value'
               AND alert.fired_at >= adopted_result.received_at
               AND alert.acknowledged_at >= message_record.created_at
          ) AS candidate
          WHERE candidate.proof IS NOT NULL;
        IF legacy_acknowledgement_proof_count <> 1 THEN
          legacy_acknowledgement_proof := NULL;
        END IF;
      END IF;

      INSERT INTO clinical_timeline_events
        (tenant_id, patient_uid, event_type, event_subtype, event_status,
         source_table, source_id, resource_type, resource_id, actor_uid,
         actor_role, occurred_at, visible_to_patient, clinical_summary,
         payload, tags, idempotency_key)
      VALUES
        (message_record.tenant_id, adopted_result.patient_uid,
         'lab.result_recorded', 'lab', adopted_result.status,
         'lab_results', adopted_result.id::text, 'lab_result',
         adopted_result.id::text, aggregate_timeline.actor_uid,
         aggregate_timeline.actor_role, adopted_result.received_at, FALSE,
         'Legacy ASTM result adopted into the atomic replay contract: '
           || adopted_result.test_name,
         jsonb_build_object(
           'interface_message_id', message_record.id,
           'interface_result_index', adopted_result.interface_result_index,
           'specimen_id', adopted_result.specimen_id,
           'legacy_contract_adoption', TRUE,
           'authenticated_actor_uid', aggregate_timeline.actor_uid,
           'authenticated_actor_roles',
             ARRAY[aggregate_timeline.actor_role]::text[],
           'analyzer_binding_mode', 'manual_import_actor',
           'analyzer_binding_identity', aggregate_timeline.actor_uid,
           'analyzer_sender_identity', parsed_sender_identity,
           'threshold_assessment',
             lab_astm_migration_threshold_assessment(
               adopted_result.tenant_id,
               adopted_result.loinc_code,
               adopted_result.test_code,
               adopted_result.value_numeric,
               adopted_result.unit
             ) - 'safe',
           'autoverification_verdict',
             (message_record.verdicts
               -> (adopted_result.interface_result_index - 1))
             || jsonb_build_object(
                  'interface_result_index',
                  adopted_result.interface_result_index,
                  'critical_threshold_matched',
                  (
                    lab_astm_migration_threshold_assessment(
                      adopted_result.tenant_id,
                      adopted_result.loinc_code,
                      adopted_result.test_code,
                      adopted_result.value_numeric,
                      adopted_result.unit
                    )->>'matched'
                  )::boolean,
                  'threshold_assessment',
                  lab_astm_migration_threshold_assessment(
                    adopted_result.tenant_id,
                    adopted_result.loinc_code,
                    adopted_result.test_code,
                    adopted_result.value_numeric,
                    adopted_result.unit
                  ) - 'safe'
                )
         ) || CASE
           WHEN legacy_acknowledgement_proof IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object(
             'legacy_acknowledgement_proof', legacy_acknowledgement_proof
           )
         END,
         ARRAY['lab', 'lab_result', 'astm', 'legacy_adoption']::text[],
         'lab_results:' || adopted_result.id
           || ':lab.result_recorded:astm:' || message_record.id)
      ON CONFLICT (idempotency_key) DO NOTHING;

      INSERT INTO clinical_audit_events
        (tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
         resource_type, resource_table, resource_id, after_state, metadata,
         idempotency_key, occurred_at)
      VALUES
        (message_record.tenant_id, adopted_result.patient_uid,
         'lab.result_recorded', 'success', aggregate_timeline.actor_uid,
         aggregate_timeline.actor_role, 'lab_result', 'lab_results',
         adopted_result.id::text, jsonb_build_object('status', adopted_result.status),
         jsonb_build_object(
           'interface_message_id', message_record.id,
           'interface_result_index', adopted_result.interface_result_index,
           'legacy_contract_adoption', TRUE,
           'authenticated_actor_uid', aggregate_timeline.actor_uid,
           'authenticated_actor_roles',
             ARRAY[aggregate_timeline.actor_role]::text[],
           'analyzer_binding_mode', 'manual_import_actor',
           'analyzer_binding_identity', aggregate_timeline.actor_uid,
           'analyzer_sender_identity', parsed_sender_identity,
           'threshold_assessment',
             lab_astm_migration_threshold_assessment(
               adopted_result.tenant_id,
               adopted_result.loinc_code,
               adopted_result.test_code,
               adopted_result.value_numeric,
               adopted_result.unit
             ) - 'safe',
           'autoverification_verdict',
             (message_record.verdicts
               -> (adopted_result.interface_result_index - 1))
             || jsonb_build_object(
                  'interface_result_index',
                  adopted_result.interface_result_index,
                  'critical_threshold_matched',
                  (
                    lab_astm_migration_threshold_assessment(
                      adopted_result.tenant_id,
                      adopted_result.loinc_code,
                      adopted_result.test_code,
                      adopted_result.value_numeric,
                      adopted_result.unit
                    )->>'matched'
                  )::boolean,
                  'threshold_assessment',
                  lab_astm_migration_threshold_assessment(
                    adopted_result.tenant_id,
                    adopted_result.loinc_code,
                    adopted_result.test_code,
                    adopted_result.value_numeric,
                    adopted_result.unit
                  ) - 'safe'
                )
         ) || CASE
           WHEN legacy_acknowledgement_proof IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object(
             'legacy_acknowledgement_proof', legacy_acknowledgement_proof
           )
         END,
         'lab_results:' || adopted_result.id
           || ':audit:lab.result_recorded:astm:' || message_record.id,
         adopted_result.received_at)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    END LOOP;

    UPDATE lab_interface_messages AS message
       SET verdicts = (
             SELECT jsonb_agg(
                      verdict.value
                        || jsonb_build_object(
                             'interface_result_index', verdict.verdict_index,
                             'critical_threshold_matched',
                               (
                                 lab_astm_migration_threshold_assessment(
                                   result.tenant_id,
                                   result.loinc_code,
                                   result.test_code,
                                   result.value_numeric,
                                   result.unit
                                 )->>'matched'
                               )::boolean,
                             'threshold_assessment',
                               lab_astm_migration_threshold_assessment(
                                 result.tenant_id,
                                 result.loinc_code,
                                 result.test_code,
                                 result.value_numeric,
                                 result.unit
                               ) - 'safe'
                           )
                      ORDER BY verdict.verdict_index
                    )
               FROM jsonb_array_elements(message_record.verdicts)
                    WITH ORDINALITY AS verdict(value, verdict_index)
               JOIN lab_results AS result
                 ON result.tenant_id = message_record.tenant_id
                AND result.interface_message_id = message_record.id
                AND result.interface_result_index = verdict.verdict_index
           ),
           authenticated_actor_uid = aggregate_timeline.actor_uid,
           authenticated_actor_roles = ARRAY[aggregate_timeline.actor_role]::text[],
           analyzer_binding_mode = 'manual_import_actor',
           analyzer_binding_identity = aggregate_timeline.actor_uid::text,
           analyzer_sender_identity = parsed_sender_identity,
           ingest_contract_version = 1
     WHERE tenant_id = message_record.tenant_id
       AND id = message_record.id
       AND ingest_contract_version IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Legacy ASTM receipt adoption changed concurrently';
    END IF;
  END LOOP;
END
$astm_legacy_adoption$;

DROP FUNCTION lab_astm_migration_try_result_json(TEXT);
DROP FUNCTION lab_astm_migration_threshold_assessment(UUID, TEXT, TEXT, NUMERIC, TEXT);

-- Pre-583 ASTM receipts never carried a durable result link, so the migration
-- cannot safely infer which specimen results belong to which raw message from
-- timestamps alone. Fail closed with bounded evidence. An owner-run adoption
-- must establish the exact message/result positions and all critical
-- obligations before this migration is retried; an empty result set is not
-- silently accepted for an already-ingested receipt.
DO $$
DECLARE
  unreconciled_count BIGINT;
  unreconciled_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO unreconciled_count
    FROM lab_interface_messages AS message
   WHERE message.direction = 'inbound'
     AND message.protocol = 'astm_e1394'
     AND message.status = 'ingested'
     AND (
       message.result_count IS NULL
       OR message.result_count <= 0
       OR message.specimen_id IS NULL
       OR message.processed_at IS NULL
       OR message.error IS NOT NULL
       OR message.verdicts IS NULL
       OR jsonb_typeof(message.verdicts) IS DISTINCT FROM 'array'
       OR jsonb_array_length(message.verdicts) <> message.result_count
       OR (
         SELECT COUNT(*)
           FROM lab_results AS result
          WHERE result.tenant_id = message.tenant_id
            AND result.interface_message_id = message.id
       ) <> message.result_count
     );

  IF unreconciled_count > 0 THEN
    SELECT string_agg(
             format(
               'tenant=%s message=%s specimen=%s declared_results=%s linked_results=%s',
               tenant_id,
               message_id,
               COALESCE(specimen_id::text, '<null>'),
               COALESCE(result_count::text, '<null>'),
               linked_result_count
             ),
             '; '
             ORDER BY tenant_id, message_id
           )
      INTO unreconciled_samples
      FROM (
        SELECT message.tenant_id,
               message.id AS message_id,
               message.specimen_id,
               message.result_count,
               (
                 SELECT COUNT(*)
                   FROM lab_results AS result
                  WHERE result.tenant_id = message.tenant_id
                    AND result.interface_message_id = message.id
               ) AS linked_result_count
          FROM lab_interface_messages AS message
         WHERE message.direction = 'inbound'
           AND message.protocol = 'astm_e1394'
           AND message.status = 'ingested'
           AND (
             message.result_count IS NULL
             OR message.result_count <= 0
             OR message.specimen_id IS NULL
             OR message.processed_at IS NULL
             OR message.error IS NOT NULL
             OR message.verdicts IS NULL
             OR jsonb_typeof(message.verdicts) IS DISTINCT FROM 'array'
             OR jsonb_array_length(message.verdicts) <> message.result_count
             OR (
               SELECT COUNT(*)
                 FROM lab_results AS result
                WHERE result.tenant_id = message.tenant_id
                  AND result.interface_message_id = message.id
             ) <> message.result_count
           )
         ORDER BY message.tenant_id, message.id
         LIMIT 5
      ) AS sampled_unreconciled;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot install ASTM atomic replay: %s ingested receipt(s) lack exact durable result evidence',
        unreconciled_count
      ),
      DETAIL = format('Sample unreconciled receipts: %s', COALESCE(unreconciled_samples, 'none')),
      HINT = 'Run the predeployment zero-count check and reconcile each legacy receipt from authoritative analyzer evidence before retrying; this migration never guesses result ownership or deletes clinical data.';
  END IF;
END
$$;

DO $$
DECLARE
  unreconciled_count BIGINT;
  unreconciled_samples TEXT;
BEGIN
  SELECT COUNT(*)
    INTO unreconciled_count
    FROM lab_interface_messages AS message
   WHERE message.direction = 'inbound'
     AND message.protocol = 'astm_e1394'
     AND (
       message.analyzer_id IS NULL
       OR message.ingest_contract_version IS DISTINCT FROM 1
       OR message.status IN ('received', 'parsed')
     );
  IF unreconciled_count > 0 THEN
    SELECT string_agg(
             format(
               'tenant=%s message=%s status=%s analyzer=%s contract=%s',
               tenant_id,
               id,
               status,
               COALESCE(analyzer_id::text, '<null>'),
               COALESCE(ingest_contract_version::text, '<legacy>')
             ),
             '; '
             ORDER BY tenant_id, id
           )
      INTO unreconciled_samples
      FROM (
        SELECT tenant_id, id, status, analyzer_id, ingest_contract_version
          FROM lab_interface_messages
         WHERE direction = 'inbound'
           AND protocol = 'astm_e1394'
           AND (
             analyzer_id IS NULL
             OR ingest_contract_version IS DISTINCT FROM 1
             OR status IN ('received', 'parsed')
           )
         ORDER BY tenant_id, id
         LIMIT 5
      ) AS samples;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot install ASTM atomic replay: %s legacy/non-terminal receipt(s) require reconciliation',
        unreconciled_count
      ),
      DETAIL = format('Sample receipts: %s', COALESCE(unreconciled_samples, 'none')),
      HINT = 'Reconcile legacy failed/received/parsed receipts and analyzer-null namespaces before retrying; only contract-version 1 failed receipts are auto-retryable.';
  END IF;
END
$$;

ALTER TABLE lab_interface_messages
  DROP CONSTRAINT IF EXISTS ck_lab_interface_astm_atomic_contract,
  ADD CONSTRAINT ck_lab_interface_astm_atomic_contract CHECK (
    direction <> 'inbound'
    OR protocol <> 'astm_e1394'
    OR (
      analyzer_id IS NOT NULL
      AND NULLIF(BTRIM(analyzer_code), '') IS NOT NULL
      AND ingest_contract_version = 1
      AND authenticated_actor_uid IS NOT NULL
      AND CARDINALITY(authenticated_actor_roles) = 1
      AND authenticated_actor_roles <@ ARRAY[
            'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST', 'ADMIN',
            'SUPER_ADMIN', 'WEBHOOK_CLIENT', 'DEVICE_GATEWAY'
          ]::text[]
      AND analyzer_binding_mode IN ('api_client', 'manual_import_actor')
      AND NULLIF(BTRIM(analyzer_binding_identity), '') IS NOT NULL
      AND NULLIF(BTRIM(analyzer_sender_identity), '') IS NOT NULL
      AND status NOT IN ('parsed')
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_interface_messages'::regclass
       AND conname = 'fk_lab_interface_astm_authenticated_actor'
  ) THEN
    ALTER TABLE lab_interface_messages
      ADD CONSTRAINT fk_lab_interface_astm_authenticated_actor
      FOREIGN KEY (tenant_id, authenticated_actor_uid)
      REFERENCES users (tenant_id, uid)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'lab_results'
       AND column_name IN ('interface_message_id', 'interface_result_index')
       AND data_type <> 'integer'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lab_results ASTM replay columns have incompatible types';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'ck_lab_results_interface_replay_identity_complete'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT ck_lab_results_interface_replay_identity_complete
      CHECK (
        (interface_message_id IS NULL AND interface_result_index IS NULL)
        OR (
          interface_message_id IS NOT NULL
          AND interface_result_index IS NOT NULL
          AND interface_result_index > 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_interface_message_tenant'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_interface_message_tenant
      FOREIGN KEY (tenant_id, interface_message_id)
      REFERENCES lab_interface_messages (tenant_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

DO $$
DECLARE
  interface_table REGCLASS := 'lab_interface_messages'::regclass;
  result_table REGCLASS := 'lab_results'::regclass;
  user_table REGCLASS := 'users'::regclass;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = interface_table
       AND constraint_row.conname = 'fk_lab_interface_astm_authenticated_actor'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.condeferrable
       AND constraint_row.condeferred
       AND constraint_row.confrelid = user_table
       AND constraint_row.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = interface_table AND attname = 'tenant_id'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = interface_table
                 AND attname = 'authenticated_actor_uid')
           ]::smallint[]
       AND constraint_row.confkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = user_table AND attname = 'tenant_id'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = user_table AND attname = 'uid')
           ]::smallint[]
       AND constraint_row.confupdtype = 'a'
       AND constraint_row.confdeltype = 'a'
       AND constraint_row.confmatchtype = 's'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fk_lab_interface_astm_authenticated_actor has an incompatible definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = result_table
       AND constraint_row.conname =
             'ck_lab_results_interface_replay_identity_complete'
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
       AND NOT constraint_row.condeferrable
       AND NOT constraint_row.condeferred
       AND constraint_row.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = result_table
                 AND attname = 'interface_message_id'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = result_table
                 AND attname = 'interface_result_index')
           ]::smallint[]
       AND regexp_replace(
             pg_get_constraintdef(constraint_row.oid, TRUE),
             '\s+',
             ' ',
             'g'
           ) =
             'CHECK (interface_message_id IS NULL AND interface_result_index IS NULL OR interface_message_id IS NOT NULL AND interface_result_index IS NOT NULL AND interface_result_index > 0)'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ck_lab_results_interface_replay_identity_complete has an incompatible definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = result_table
       AND constraint_row.conname = 'fk_lab_results_interface_message_tenant'
       AND constraint_row.contype = 'f'
       AND constraint_row.convalidated
       AND constraint_row.condeferrable
       AND constraint_row.condeferred
       AND constraint_row.confrelid = interface_table
       AND constraint_row.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = result_table AND attname = 'tenant_id'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = result_table
                 AND attname = 'interface_message_id')
           ]::smallint[]
       AND constraint_row.confkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = interface_table AND attname = 'tenant_id'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = interface_table AND attname = 'id')
           ]::smallint[]
       AND constraint_row.confupdtype = 'a'
       AND constraint_row.confdeltype = 'a'
       AND constraint_row.confmatchtype = 's'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fk_lab_results_interface_message_tenant has an incompatible definition';
  END IF;
END
$$;

DO $$
DECLARE
  result_index REGCLASS;
  result_index_row pg_index%ROWTYPE;
BEGIN
  result_index := to_regclass('public.uq_lab_results_interface_message_position');
  IF result_index IS NULL THEN
    EXECUTE $index$
      CREATE UNIQUE INDEX uq_lab_results_interface_message_position
        ON lab_results (tenant_id, interface_message_id, interface_result_index)
        WHERE interface_message_id IS NOT NULL
          AND interface_result_index IS NOT NULL
    $index$;
    result_index := 'uq_lab_results_interface_message_position'::regclass;
  END IF;

  SELECT *
    INTO result_index_row
    FROM pg_index
   WHERE indexrelid = result_index;

  IF result_index_row.indrelid IS DISTINCT FROM 'lab_results'::regclass
     OR result_index_row.indisunique IS DISTINCT FROM TRUE
     OR result_index_row.indisvalid IS DISTINCT FROM TRUE
     OR result_index_row.indisready IS DISTINCT FROM TRUE
     OR result_index_row.indnkeyatts IS DISTINCT FROM 3
     OR pg_get_indexdef(result_index, 1, TRUE) IS DISTINCT FROM 'tenant_id'
     OR pg_get_indexdef(result_index, 2, TRUE) IS DISTINCT FROM 'interface_message_id'
     OR pg_get_indexdef(result_index, 3, TRUE) IS DISTINCT FROM 'interface_result_index'
     OR pg_get_expr(result_index_row.indpred, result_index_row.indrelid)
          IS DISTINCT FROM
            '((interface_message_id IS NOT NULL) AND (interface_result_index IS NOT NULL))'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'uq_lab_results_interface_message_position has an incompatible definition';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION lab_interface_assert_astm_replay_identity_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
       (OLD.direction = 'inbound' AND OLD.protocol = 'astm_e1394')
       OR (NEW.direction = 'inbound' AND NEW.protocol = 'astm_e1394')
     )
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.analyzer_id IS DISTINCT FROM NEW.analyzer_id
       OR OLD.analyzer_code IS DISTINCT FROM NEW.analyzer_code
       OR OLD.direction IS DISTINCT FROM NEW.direction
       OR OLD.protocol IS DISTINCT FROM NEW.protocol
       OR OLD.raw_message IS DISTINCT FROM NEW.raw_message
       OR OLD.authenticated_actor_uid IS DISTINCT FROM NEW.authenticated_actor_uid
       OR OLD.authenticated_actor_roles IS DISTINCT FROM NEW.authenticated_actor_roles
       OR OLD.analyzer_binding_mode IS DISTINCT FROM NEW.analyzer_binding_mode
       OR OLD.analyzer_binding_identity IS DISTINCT FROM NEW.analyzer_binding_identity
       OR OLD.analyzer_sender_identity IS DISTINCT FROM NEW.analyzer_sender_identity
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ASTM interface replay identity is immutable once assigned';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_interface_astm_replay_identity_immutable
  ON lab_interface_messages;
CREATE TRIGGER trg_lab_interface_astm_replay_identity_immutable
BEFORE UPDATE OF tenant_id, analyzer_id, analyzer_code, direction, protocol,
  raw_message, authenticated_actor_uid, authenticated_actor_roles,
  analyzer_binding_mode, analyzer_binding_identity, analyzer_sender_identity
ON lab_interface_messages
FOR EACH ROW
EXECUTE FUNCTION lab_interface_assert_astm_replay_identity_immutable();

CREATE OR REPLACE FUNCTION lab_interface_assert_astm_current_authorization(
  target_tenant_id UUID,
  target_message_id INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  message_record lab_interface_messages%ROWTYPE;
  analyzer_metadata JSONB;
  provenance_match_count INTEGER;
  authenticated_api_client_id INTEGER;
  source_record RECORD;
  booking_record RECORD;
  investigation_record RECORD;
BEGIN
  SELECT message.*
    INTO message_record
    FROM lab_interface_messages AS message
   WHERE message.tenant_id = target_tenant_id
     AND message.id = target_message_id
     AND message.direction = 'inbound'
     AND message.protocol = 'astm_e1394'
   FOR KEY SHARE OF message;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF message_record.ingest_contract_version IS DISTINCT FROM 1
     OR message_record.analyzer_id IS NULL
     OR NULLIF(BTRIM(message_record.analyzer_code), '') IS NULL
     OR message_record.authenticated_actor_uid IS NULL
     OR CARDINALITY(message_record.authenticated_actor_roles) <> 1
     OR message_record.analyzer_binding_mode NOT IN (
          'api_client', 'manual_import_actor'
        )
     OR NULLIF(BTRIM(message_record.analyzer_binding_identity), '') IS NULL
     OR NULLIF(BTRIM(message_record.analyzer_sender_identity), '') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM receipt %s/%s lacks its atomic contract/analyzer identity',
        target_tenant_id,
        target_message_id
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM users AS actor
     WHERE actor.tenant_id = target_tenant_id
       AND actor.uid = message_record.authenticated_actor_uid
       AND actor.is_active = TRUE
       AND actor.status = 'active'
       AND UPPER(BTRIM(actor.role)) =
             UPPER(BTRIM(message_record.authenticated_actor_roles[1]))
       AND UPPER(BTRIM(actor.role)) IN (
             'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST', 'ADMIN',
             'SUPER_ADMIN', 'WEBHOOK_CLIENT', 'DEVICE_GATEWAY'
           )
     FOR KEY SHARE OF actor
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM receipt %s/%s lacks a grounded authenticated actor',
        target_tenant_id,
        target_message_id
      );
  END IF;

  SELECT analyzer.metadata
    INTO analyzer_metadata
    FROM lab_analyzers AS analyzer
   WHERE analyzer.tenant_id = target_tenant_id
     AND analyzer.id = message_record.analyzer_id
     AND analyzer.analyzer_code = message_record.analyzer_code
     AND analyzer.interface_kind = 'astm'
     AND analyzer.status = 'active'
   FOR KEY SHARE OF analyzer;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM receipt %s/%s lacks its active analyzer channel',
        target_tenant_id,
        target_message_id
      );
  END IF;

  SELECT COUNT(*)::integer
    INTO provenance_match_count
    FROM lab_analyzers AS analyzer
   WHERE analyzer.tenant_id = target_tenant_id
     AND analyzer.interface_kind = 'astm'
     AND analyzer.status = 'active'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(
                    CASE
                      WHEN jsonb_typeof(analyzer.metadata->'astm_sender_aliases') =
                           'array'
                        THEN analyzer.metadata->'astm_sender_aliases'
                      ELSE '[]'::jsonb
                    END
                  ) AS sender(value)
            WHERE LOWER(BTRIM(sender.value)) =
                  LOWER(BTRIM(message_record.analyzer_sender_identity))
         );
  IF provenance_match_count <> 1
     OR NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(
                   CASE
                     WHEN jsonb_typeof(analyzer_metadata->'astm_sender_aliases') =
                          'array'
                       THEN analyzer_metadata->'astm_sender_aliases'
                     ELSE '[]'::jsonb
                   END
                 ) AS sender(value)
           WHERE LOWER(BTRIM(sender.value)) =
                 LOWER(BTRIM(message_record.analyzer_sender_identity))
        )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM receipt %s/%s lacks one exact sender/analyzer binding',
        target_tenant_id,
        target_message_id
      );
  END IF;

  IF message_record.analyzer_binding_mode = 'manual_import_actor' THEN
    SELECT COUNT(*)::integer
      INTO provenance_match_count
      FROM lab_analyzers AS analyzer
     WHERE analyzer.tenant_id = target_tenant_id
       AND analyzer.interface_kind = 'astm'
       AND analyzer.status = 'active'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                      CASE
                        WHEN jsonb_typeof(
                               analyzer.metadata->'astm_manual_import_actor_uids'
                             ) = 'array'
                          THEN analyzer.metadata->'astm_manual_import_actor_uids'
                        ELSE '[]'::jsonb
                      END
                    ) AS allowed_actor(value)
              WHERE LOWER(BTRIM(allowed_actor.value)) =
                    LOWER(message_record.authenticated_actor_uid::text)
           );
    IF LOWER(message_record.analyzer_binding_identity) <>
         LOWER(message_record.authenticated_actor_uid::text)
       OR provenance_match_count <> 1
       OR NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                     CASE
                       WHEN jsonb_typeof(
                              analyzer_metadata->'astm_manual_import_actor_uids'
                            ) = 'array'
                         THEN analyzer_metadata->'astm_manual_import_actor_uids'
                       ELSE '[]'::jsonb
                     END
                   ) AS allowed_actor(value)
             WHERE LOWER(BTRIM(allowed_actor.value)) =
                   LOWER(message_record.authenticated_actor_uid::text)
          )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ASTM receipt %s/%s lacks one exact manual-import actor binding',
          target_tenant_id,
          target_message_id
        );
    END IF;
  ELSE
    IF message_record.analyzer_binding_identity !~ '^[1-9][0-9]*$'
       OR NOT pg_input_is_valid(
            message_record.analyzer_binding_identity,
            'integer'
          )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ASTM receipt %s/%s lacks its tenant-bound API client',
          target_tenant_id,
          target_message_id
        );
    END IF;
    authenticated_api_client_id :=
      message_record.analyzer_binding_identity::integer;
    IF NOT EXISTS (
      SELECT 1
        FROM api_clients AS client
       WHERE client.tenant_id = target_tenant_id
         AND client.id = authenticated_api_client_id
         AND client.status = 'active'
       FOR KEY SHARE OF client
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ASTM receipt %s/%s lacks its tenant-bound API client',
          target_tenant_id,
          target_message_id
        );
    END IF;
    SELECT COUNT(*)::integer
      INTO provenance_match_count
      FROM lab_analyzers AS analyzer
     WHERE analyzer.tenant_id = target_tenant_id
       AND analyzer.interface_kind = 'astm'
       AND analyzer.status = 'active'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                      CASE
                        WHEN jsonb_typeof(analyzer.metadata->'astm_api_client_ids') =
                             'array'
                          THEN analyzer.metadata->'astm_api_client_ids'
                        ELSE '[]'::jsonb
                      END
                    ) AS allowed_client(value)
              WHERE BTRIM(allowed_client.value) =
                    message_record.analyzer_binding_identity
           );
    IF provenance_match_count <> 1
       OR NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                     CASE
                       WHEN jsonb_typeof(analyzer_metadata->'astm_api_client_ids') =
                            'array'
                         THEN analyzer_metadata->'astm_api_client_ids'
                       ELSE '[]'::jsonb
                     END
                   ) AS allowed_client(value)
             WHERE BTRIM(allowed_client.value) =
                   message_record.analyzer_binding_identity
          )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ASTM receipt %s/%s lacks one exact API-client/analyzer binding',
          target_tenant_id,
          target_message_id
        );
    END IF;
  END IF;

  IF message_record.status = 'ingested' THEN
    SELECT specimen.patient_uid AS specimen_patient_uid,
           specimen.booking_id AS specimen_booking_id,
           specimen.status AS specimen_status
      INTO source_record
      FROM lab_specimens AS specimen
      JOIN users AS specimen_patient
        ON specimen_patient.tenant_id = specimen.tenant_id
       AND specimen_patient.uid = specimen.patient_uid
       AND UPPER(specimen_patient.role) = 'PATIENT'
       AND specimen_patient.is_active = TRUE
       AND specimen_patient.status = 'active'
       AND specimen_patient.is_deleted = FALSE
     WHERE specimen.tenant_id = target_tenant_id
       AND specimen.id = message_record.specimen_id
     FOR KEY SHARE OF specimen, specimen_patient;
    IF NOT FOUND
       OR LOWER(source_record.specimen_status) NOT IN ('received', 'processing')
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ASTM ingested receipt %s/%s lacks an eligible current source chain',
          target_tenant_id,
          target_message_id
        );
    END IF;

    IF source_record.specimen_booking_id IS NOT NULL THEN
      SELECT booking.investigation_id,
             booking.status,
             booking_patient.uid AS booking_patient_uid
        INTO booking_record
        FROM investigation_bookings AS booking
        JOIN users AS booking_patient
          ON booking_patient.tenant_id = booking.tenant_id
         AND booking_patient.id = booking.patient_id
         AND UPPER(booking_patient.role) = 'PATIENT'
         AND booking_patient.is_active = TRUE
         AND booking_patient.status = 'active'
         AND booking_patient.is_deleted = FALSE
       WHERE booking.tenant_id = target_tenant_id
         AND booking.id = source_record.specimen_booking_id
       FOR KEY SHARE OF booking, booking_patient;
      IF NOT FOUND
         OR booking_record.booking_patient_uid IS DISTINCT FROM
              source_record.specimen_patient_uid
         OR UPPER(booking_record.status) NOT IN (
              'BOOKED', 'CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING'
            )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'ASTM ingested receipt %s/%s lacks an eligible current source chain',
            target_tenant_id,
            target_message_id
          );
      END IF;

      IF booking_record.investigation_id IS NOT NULL THEN
        SELECT investigation.patient_uid,
               investigation.status
          INTO investigation_record
          FROM investigations AS investigation
         WHERE investigation.tenant_id = target_tenant_id
           AND investigation.id = booking_record.investigation_id
         FOR KEY SHARE OF investigation;
        IF NOT FOUND
           OR investigation_record.patient_uid IS DISTINCT FROM
                source_record.specimen_patient_uid
           OR UPPER(investigation_record.status) NOT IN (
                'REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED', 'IN_PROGRESS'
              )
        THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'ASTM ingested receipt %s/%s lacks an eligible current source chain',
              target_tenant_id,
              target_message_id
            );
        END IF;
      END IF;
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION lab_interface_assert_astm_ingested_complete(
  target_tenant_id UUID,
  target_message_id INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  message_record lab_interface_messages%ROWTYPE;
  linked_result_count INTEGER;
  distinct_position_count INTEGER;
  first_position INTEGER;
  last_position INTEGER;
  source_mismatch_result_id INTEGER;
  invalid_critical_result_id INTEGER;
  canonical_mismatch_result_id INTEGER;
  linked_result_artifact_count INTEGER;
  verdict_mismatch_result_id INTEGER;
  source_patient_uid UUID;
  source_booking_id BIGINT;
  source_investigation_id INTEGER;
BEGIN
  SELECT message.*
    INTO message_record
    FROM lab_interface_messages AS message
   WHERE message.tenant_id = target_tenant_id
     AND message.id = target_message_id
     AND message.direction = 'inbound'
     AND message.protocol = 'astm_e1394'
   FOR KEY SHARE OF message;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF message_record.ingest_contract_version IS DISTINCT FROM 1
     OR message_record.analyzer_id IS NULL
     OR NULLIF(BTRIM(message_record.analyzer_code), '') IS NULL
     OR message_record.authenticated_actor_uid IS NULL
     OR CARDINALITY(message_record.authenticated_actor_roles) <> 1
     OR message_record.analyzer_binding_mode NOT IN (
          'api_client', 'manual_import_actor'
        )
     OR NULLIF(BTRIM(message_record.analyzer_binding_identity), '') IS NULL
     OR NULLIF(BTRIM(message_record.analyzer_sender_identity), '') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM receipt %s/%s lacks its atomic contract/analyzer identity',
        target_tenant_id,
        target_message_id
      );
  END IF;

  SELECT COUNT(*)::integer
    INTO linked_result_artifact_count
    FROM lab_results AS result
   WHERE result.tenant_id = target_tenant_id
     AND result.interface_message_id = target_message_id;

  IF message_record.status = 'failed' THEN
    IF message_record.error IS NULL
       OR message_record.processed_at IS NULL
       OR message_record.result_count IS NOT NULL
       OR message_record.specimen_id IS NOT NULL
       OR message_record.verdicts IS NOT NULL
       OR linked_result_artifact_count <> 0
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Failed ASTM receipt %s/%s carries partial clinical artifacts',
          target_tenant_id,
          target_message_id
        );
    END IF;
    RETURN;
  END IF;

  IF message_record.status IS DISTINCT FROM 'ingested' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM receipt %s/%s cannot commit in non-terminal status %s',
        target_tenant_id,
        target_message_id,
        message_record.status
      );
  END IF;

  IF message_record.result_count IS NULL
     OR message_record.result_count <= 0
     OR message_record.specimen_id IS NULL
     OR message_record.processed_at IS NULL
     OR message_record.error IS NOT NULL
     OR message_record.verdicts IS NULL
     OR jsonb_typeof(message_record.verdicts) IS DISTINCT FROM 'array'
     OR jsonb_array_length(message_record.verdicts) <> message_record.result_count
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s has incomplete terminal evidence',
        target_tenant_id,
        target_message_id
      );
  END IF;

  SELECT specimen.patient_uid,
         specimen.booking_id
    INTO source_patient_uid,
         source_booking_id
    FROM lab_specimens AS specimen
   WHERE specimen.tenant_id = target_tenant_id
     AND specimen.id = message_record.specimen_id
   FOR KEY SHARE OF specimen;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s lacks its immutable specimen source',
        target_tenant_id,
        target_message_id
      );
  END IF;

  IF source_booking_id IS NOT NULL THEN
    SELECT booking.investigation_id
      INTO source_investigation_id
      FROM investigation_bookings AS booking
      JOIN users AS booking_patient
        ON booking_patient.tenant_id = booking.tenant_id
       AND booking_patient.id = booking.patient_id
       AND booking_patient.uid = source_patient_uid
     WHERE booking.tenant_id = target_tenant_id
       AND booking.id = source_booking_id
      FOR KEY SHARE OF booking, booking_patient;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ASTM ingested receipt %s/%s lacks its immutable patient-bound booking source',
          target_tenant_id,
          target_message_id
        );
    END IF;

    IF source_investigation_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
          FROM investigations AS investigation
         WHERE investigation.tenant_id = target_tenant_id
           AND investigation.id = source_investigation_id
           AND investigation.patient_uid = source_patient_uid
         FOR KEY SHARE OF investigation
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'ASTM ingested receipt %s/%s lacks its immutable patient-bound investigation source',
            target_tenant_id,
            target_message_id
          );
      END IF;
    END IF;
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(DISTINCT result.interface_result_index)::integer,
         MIN(result.interface_result_index),
         MAX(result.interface_result_index)
    INTO linked_result_count,
         distinct_position_count,
         first_position,
         last_position
    FROM lab_results AS result
   WHERE result.tenant_id = target_tenant_id
     AND result.interface_message_id = target_message_id;

  IF linked_result_count <> message_record.result_count
     OR distinct_position_count <> message_record.result_count
     OR first_position <> 1
     OR last_position <> message_record.result_count
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s result count/position proof is incomplete',
        target_tenant_id,
        target_message_id
      ),
      DETAIL = format(
        'declared=%s linked=%s distinct_positions=%s first=%s last=%s',
        message_record.result_count,
        linked_result_count,
        distinct_position_count,
        COALESCE(first_position::text, '<null>'),
        COALESCE(last_position::text, '<null>')
      );
  END IF;

  SELECT result.id
    INTO source_mismatch_result_id
    FROM lab_results AS result
   WHERE result.tenant_id = target_tenant_id
     AND result.interface_message_id = target_message_id
     AND (
       result.specimen_id IS DISTINCT FROM message_record.specimen_id
       OR result.patient_uid IS DISTINCT FROM source_patient_uid
       OR result.booking_id IS DISTINCT FROM source_booking_id
       OR result.investigation_id IS DISTINCT FROM source_investigation_id
       OR result.analyzer_id IS DISTINCT FROM message_record.analyzer_id
     )
   ORDER BY result.interface_result_index
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s has a result detached from its exact source chain for specimen %s',
        target_tenant_id,
        target_message_id,
        message_record.specimen_id
      ),
      DETAIL = format('result_id=%s', source_mismatch_result_id);
  END IF;

  SELECT result.id
    INTO verdict_mismatch_result_id
    FROM lab_results AS result
   WHERE result.tenant_id = target_tenant_id
     AND result.interface_message_id = target_message_id
     AND 1 <> (
       SELECT COUNT(*)
         FROM jsonb_array_elements(message_record.verdicts)
              WITH ORDINALITY AS verdict(value, verdict_index)
        WHERE verdict.verdict_index = result.interface_result_index
          AND jsonb_typeof(verdict.value) = 'object'
          AND verdict.value->>'interface_result_index' =
                result.interface_result_index::text
          AND verdict.value->>'test_code' = result.test_code
          AND verdict.value->>'decision' IN (
                'critical', 'hold_for_review', 'auto_verify'
              )
          AND NULLIF(BTRIM(verdict.value->>'critical_band'), '') IS NOT NULL
          AND jsonb_typeof(verdict.value->'critical_threshold_matched') =
                'boolean'
          AND jsonb_typeof(verdict.value->'threshold_assessment') = 'object'
          AND jsonb_typeof(
                verdict.value->'threshold_assessment'->'matched'
              ) = 'boolean'
          AND jsonb_typeof(
                verdict.value->'threshold_assessment'->'breached'
              ) = 'boolean'
          AND verdict.value->'threshold_assessment'->'matched' =
                verdict.value->'critical_threshold_matched'
          AND (
            (
              (verdict.value->'threshold_assessment'->>'breached')::boolean = FALSE
              AND verdict.value->>'decision' IN ('hold_for_review', 'auto_verify')
            )
            OR (
              (verdict.value->'threshold_assessment'->>'breached')::boolean = TRUE
              AND verdict.value->>'decision' = 'critical'
              AND verdict.value->'threshold_assessment'->>'breached_side' IN (
                    'low', 'high'
                  )
              AND verdict.value->'threshold_assessment'->'breached_value'
                    IS NOT NULL
            )
          )
     )
   ORDER BY result.interface_result_index
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s has verdict evidence detached from its result ordinal',
        target_tenant_id,
        target_message_id
      ),
      DETAIL = format('result_id=%s', verdict_mismatch_result_id);
  END IF;

  SELECT result.id
    INTO canonical_mismatch_result_id
    FROM lab_results AS result
   WHERE result.tenant_id = target_tenant_id
     AND result.interface_message_id = target_message_id
     AND (
       1 <> (
         SELECT COUNT(*)
           FROM clinical_timeline_events AS timeline
          WHERE timeline.tenant_id = result.tenant_id
            AND timeline.patient_uid = result.patient_uid
            AND timeline.event_type = 'lab.result_recorded'
            AND timeline.source_table = 'lab_results'
            AND timeline.source_id = result.id::text
            AND timeline.resource_type = 'lab_result'
            AND timeline.resource_id = result.id::text
            AND timeline.idempotency_key = 'lab_results:' || result.id
              || ':lab.result_recorded:astm:' || target_message_id
            AND timeline.actor_uid = message_record.authenticated_actor_uid
            AND UPPER(BTRIM(timeline.actor_role)) =
                  UPPER(BTRIM(message_record.authenticated_actor_roles[1]))
            AND timeline.payload->>'interface_result_index' =
                  result.interface_result_index::text
            AND timeline.payload->'threshold_assessment' =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
            AND timeline.payload->'autoverification_verdict' =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
            AND timeline.payload->>'authenticated_actor_uid' =
                  message_record.authenticated_actor_uid::text
            AND timeline.payload->'authenticated_actor_roles' =
                  to_jsonb(message_record.authenticated_actor_roles)
            AND timeline.payload->>'analyzer_binding_mode' =
                  message_record.analyzer_binding_mode
            AND timeline.payload->>'analyzer_binding_identity' =
                  message_record.analyzer_binding_identity
            AND timeline.payload->>'analyzer_sender_identity' =
                  message_record.analyzer_sender_identity
       )
       OR 1 <> (
         SELECT COUNT(*)
           FROM clinical_audit_events AS audit
          WHERE audit.tenant_id = result.tenant_id
            AND audit.patient_uid = result.patient_uid
            AND audit.action = 'lab.result_recorded'
            AND audit.resource_table = 'lab_results'
            AND audit.resource_id = result.id::text
            AND audit.resource_type = 'lab_result'
            AND audit.idempotency_key = 'lab_results:' || result.id
              || ':audit:lab.result_recorded:astm:' || target_message_id
            AND audit.actor_uid = message_record.authenticated_actor_uid
            AND UPPER(BTRIM(audit.actor_role)) =
                  UPPER(BTRIM(message_record.authenticated_actor_roles[1]))
            AND audit.metadata->>'interface_result_index' =
                  result.interface_result_index::text
            AND audit.metadata->'threshold_assessment' =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
            AND audit.metadata->'autoverification_verdict' =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
            AND audit.metadata->>'authenticated_actor_uid' =
                  message_record.authenticated_actor_uid::text
            AND audit.metadata->'authenticated_actor_roles' =
                  to_jsonb(message_record.authenticated_actor_roles)
            AND audit.metadata->>'analyzer_binding_mode' =
                  message_record.analyzer_binding_mode
            AND audit.metadata->>'analyzer_binding_identity' =
                  message_record.analyzer_binding_identity
            AND audit.metadata->>'analyzer_sender_identity' =
                  message_record.analyzer_sender_identity
       )
     )
   ORDER BY result.interface_result_index
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s has a result without exact canonical timeline/audit evidence',
        target_tenant_id,
        target_message_id
      ),
      DETAIL = format('result_id=%s', canonical_mismatch_result_id);
  END IF;

  IF 1 <> (
       SELECT COUNT(*)
         FROM clinical_timeline_events AS timeline
        WHERE timeline.tenant_id = target_tenant_id
          AND timeline.patient_uid = source_patient_uid
          AND timeline.event_type = 'lab.analyzer_results_ingested'
          AND timeline.source_table = 'lab_interface_messages'
          AND timeline.source_id = target_message_id::text
          AND timeline.resource_type = 'lab_interface_message'
          AND timeline.resource_id = target_message_id::text
          AND timeline.idempotency_key = 'lab_interface_messages:'
            || target_message_id || ':ingested'
          AND timeline.actor_uid = message_record.authenticated_actor_uid
          AND UPPER(BTRIM(timeline.actor_role)) =
                UPPER(BTRIM(message_record.authenticated_actor_roles[1]))
          AND (
            (
              timeline.payload->>'analyzer_binding_mode' =
                message_record.analyzer_binding_mode
              AND timeline.payload->>'analyzer_binding_identity' =
                    message_record.analyzer_binding_identity
              AND timeline.payload->>'analyzer_sender_identity' =
                    message_record.analyzer_sender_identity
              AND timeline.payload->>'authenticated_actor_uid' =
                    message_record.authenticated_actor_uid::text
              AND timeline.payload->'authenticated_actor_roles' =
                    to_jsonb(message_record.authenticated_actor_roles)
            )
            OR EXISTS (
              SELECT 1
                FROM lab_results AS legacy_result
                JOIN clinical_timeline_events AS legacy_event
                  ON legacy_event.tenant_id = legacy_result.tenant_id
                 AND legacy_event.source_table = 'lab_results'
                 AND legacy_event.source_id = legacy_result.id::text
                 AND legacy_event.event_type = 'lab.result_recorded'
               WHERE legacy_result.tenant_id = target_tenant_id
                 AND legacy_result.interface_message_id = target_message_id
                 AND legacy_event.payload->>'legacy_contract_adoption' = 'true'
            )
          )
     )
     OR 1 <> (
       SELECT COUNT(*)
         FROM clinical_audit_events AS audit
        WHERE audit.tenant_id = target_tenant_id
          AND audit.patient_uid = source_patient_uid
          AND audit.action = 'lab.analyzer_results_ingested'
          AND audit.resource_table = 'lab_interface_messages'
          AND audit.resource_id = target_message_id::text
          AND audit.resource_type = 'lab_interface_message'
          AND audit.idempotency_key = 'lab_interface_messages:'
            || target_message_id || ':audit:ingested'
          AND audit.actor_uid = message_record.authenticated_actor_uid
          AND UPPER(BTRIM(audit.actor_role)) =
                UPPER(BTRIM(message_record.authenticated_actor_roles[1]))
          AND (
            (
              audit.metadata->>'analyzer_binding_mode' =
                message_record.analyzer_binding_mode
              AND audit.metadata->>'analyzer_binding_identity' =
                    message_record.analyzer_binding_identity
              AND audit.metadata->>'analyzer_sender_identity' =
                    message_record.analyzer_sender_identity
              AND audit.metadata->>'authenticated_actor_uid' =
                    message_record.authenticated_actor_uid::text
              AND audit.metadata->'authenticated_actor_roles' =
                    to_jsonb(message_record.authenticated_actor_roles)
            )
            OR EXISTS (
              SELECT 1
                FROM lab_results AS legacy_result
                JOIN clinical_audit_events AS legacy_audit
                  ON legacy_audit.tenant_id = legacy_result.tenant_id
                 AND legacy_audit.resource_table = 'lab_results'
                 AND legacy_audit.resource_id = legacy_result.id::text
                 AND legacy_audit.action = 'lab.result_recorded'
               WHERE legacy_result.tenant_id = target_tenant_id
                 AND legacy_result.interface_message_id = target_message_id
                 AND legacy_audit.metadata->>'legacy_contract_adoption' = 'true'
            )
          )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s lacks exact aggregate canonical timeline/audit evidence',
        target_tenant_id,
        target_message_id
      );
  END IF;

  SELECT result.id
    INTO invalid_critical_result_id
    FROM lab_results AS result
   WHERE result.tenant_id = target_tenant_id
     AND result.interface_message_id = target_message_id
     AND (
       message_record.verdicts
         -> (result.interface_result_index - 1)
         -> 'threshold_assessment'
         ->> 'breached'
     )::boolean = TRUE
     AND 1 <> (
       (
         SELECT COUNT(*)
           FROM lab_critical_alerts AS alert
           JOIN tasks AS task
             ON task.tenant_id = alert.tenant_id
            AND task.id = alert.acknowledgement_task_id
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
          WHERE alert.tenant_id = result.tenant_id
            AND alert.result_id = result.id
            AND alert.patient_uid = result.patient_uid
            AND alert.superseded_at IS NULL
            AND alert.acknowledged_at IS NULL
            AND alert.generation_signoff_id IS NULL
            AND alert.generation_metadata->>'kind' = 'initial_result_generation'
            AND alert.generation_metadata->>'acknowledgement_task_id' = task.id::text
            AND alert.generation_metadata->>'corrected_state' = 'critical'
            AND alert.value_numeric IS NOT DISTINCT FROM result.value_numeric
            AND alert.unit IS NOT DISTINCT FROM result.unit
            AND alert.threshold_breached =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    ->> 'breached_side'
            AND to_jsonb(alert.threshold_value) =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    -> 'breached_value'
            AND alert.generation_metadata->'active_threshold_id'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'threshold_id'
            AND alert.generation_metadata->'active_threshold_low'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'critical_low'
            AND alert.generation_metadata->'active_threshold_high'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'critical_high'
            AND alert.generation_metadata->'threshold_evaluated_value'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'evaluated_value'
            AND alert.generation_metadata->'threshold_value_conversion'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'conversion'
            AND task.patient_uid = result.patient_uid
            AND task.related_resource_type = 'lab_result'
            AND task.related_resource_id = result.id::text
            AND task.sla_completion_semantics = 'acknowledgement'
            AND task.status IN ('open', 'blocked', 'overdue')
            AND task.metadata->>'lab_critical_alert_id' = alert.id::text
            AND task.metadata->>'lab_alert_generation_state' = 'critical'
            AND sla.rule_code = 'critical_result_ack'
            AND sla.source_table = 'lab_result'
            AND sla.source_id = result.id::text
             AND sla.patient_uid = result.patient_uid
             AND sla.status IN ('active', 'breached', 'escalated')
             AND sla.completed_at IS NULL
       ) + (
         SELECT COUNT(*)
           FROM lab_critical_alerts AS alert
           JOIN tasks AS task
             ON task.tenant_id = alert.tenant_id
            AND task.id = alert.acknowledgement_task_id
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
          WHERE alert.tenant_id = result.tenant_id
            AND alert.result_id = result.id
            AND alert.patient_uid = result.patient_uid
            AND alert.superseded_at IS NULL
            AND alert.acknowledged_at IS NOT NULL
            AND alert.acknowledged_by IS NOT NULL
            AND alert.generation_signoff_id IS NULL
            AND alert.generation_metadata->>'kind' = 'initial_result_generation'
            AND alert.generation_metadata->>'acknowledgement_task_id' = task.id::text
            AND alert.generation_metadata->>'corrected_state' = 'critical'
            AND alert.value_numeric IS NOT DISTINCT FROM result.value_numeric
            AND alert.unit IS NOT DISTINCT FROM result.unit
            AND alert.threshold_breached =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    ->> 'breached_side'
            AND to_jsonb(alert.threshold_value) =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    -> 'breached_value'
            AND alert.generation_metadata->'active_threshold_id'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'threshold_id'
            AND alert.generation_metadata->'active_threshold_low'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'critical_low'
            AND alert.generation_metadata->'active_threshold_high'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'critical_high'
            AND alert.generation_metadata->'threshold_evaluated_value'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'evaluated_value'
            AND alert.generation_metadata->'threshold_value_conversion'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'conversion'
            AND alert.fired_at >= result.received_at
            AND alert.acknowledged_at >= message_record.created_at
            AND lab_astm_closed_acknowledgement_proof(
                  alert.tenant_id,
                  alert.id,
                  message_record.created_at
                ) IS NOT NULL
            AND task.patient_uid = result.patient_uid
            AND task.related_resource_type = 'lab_result'
            AND task.related_resource_id = result.id::text
            AND task.sla_completion_semantics = 'acknowledgement'
            AND task.status IN ('in_progress', 'completed')
            AND task.metadata->>'lab_critical_alert_id' = alert.id::text
            AND task.metadata->>'lab_alert_generation_state' = 'critical'
            AND LOWER(task.metadata->>'acknowledged_by') =
                  LOWER(alert.acknowledged_by::text)
            AND task.metadata->>'acknowledged_via' IN (
                  'assignee', 'role', 'admin', 'override'
                )
            AND task.metadata->>'acknowledged_at' ~
                  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
            AND pg_input_is_valid(
                  task.metadata->>'acknowledged_at',
                  'timestamp with time zone'
                )
            AND (task.metadata->>'acknowledged_at')::timestamptz =
                  alert.acknowledged_at
            AND sla.rule_code = 'critical_result_ack'
            AND sla.source_table = 'lab_result'
            AND sla.source_id = result.id::text
            AND sla.patient_uid = result.patient_uid
            AND sla.status IN ('completed', 'breached', 'escalated')
            AND sla.completed_at = alert.acknowledged_at
            AND sla.metadata->>'completed_via' = 'task_ack'
            AND sla.metadata->>'completed_by_task' = task.id::text
            AND LOWER(sla.metadata->>'completed_by') =
                  LOWER(alert.acknowledged_by::text)
            AND 1 = (
              SELECT COUNT(*)
                FROM task_comments AS receipt
               WHERE receipt.tenant_id = task.tenant_id
                 AND receipt.task_id = task.id
                 AND receipt.author_uid = alert.acknowledged_by
                 AND receipt.body_kind = 'state_change'
                 AND receipt.metadata->>'to' = 'in_progress'
                 AND receipt.metadata->>'acknowledged_at' =
                       task.metadata->>'acknowledged_at'
                 AND receipt.metadata->>'via' =
                       task.metadata->>'acknowledged_via'
                 AND receipt.created_at >= message_record.created_at
            )
            AND 1 = (
              SELECT COUNT(*)
                FROM clinical_timeline_events AS acknowledgement_timeline
               WHERE acknowledgement_timeline.tenant_id = alert.tenant_id
                 AND acknowledgement_timeline.patient_uid = alert.patient_uid
                 AND acknowledgement_timeline.event_type =
                       'critical_result.acknowledged'
                 AND acknowledgement_timeline.event_status = 'acknowledged'
                 AND acknowledgement_timeline.source_table =
                       'lab_critical_alerts'
                 AND acknowledgement_timeline.source_id = alert.id::text
                 AND acknowledgement_timeline.resource_type =
                       'critical_lab_alert'
                 AND acknowledgement_timeline.resource_id = alert.id::text
                 AND acknowledgement_timeline.actor_uid = alert.acknowledged_by
                 AND acknowledgement_timeline.payload->'alert_id' =
                       to_jsonb(alert.id)
                 AND acknowledgement_timeline.payload->'result_id' =
                       to_jsonb(result.id)
                 AND acknowledgement_timeline.payload
                       ->> 'acknowledgement_authorization' =
                       task.metadata->>'acknowledged_via'
                 AND acknowledgement_timeline.payload ? 'read_back_method'
                 AND acknowledgement_timeline.payload->>'read_back_method'
                       IS NOT DISTINCT FROM alert.read_back_method
                 AND acknowledgement_timeline.idempotency_key =
                       'lab_critical_alerts:' || alert.id || ':acknowledged'
                 AND acknowledgement_timeline.occurred_at >=
                       message_record.created_at
            )
            AND 1 = (
              SELECT COUNT(*)
                FROM clinical_audit_events AS acknowledgement_audit
               WHERE acknowledgement_audit.tenant_id = alert.tenant_id
                 AND acknowledgement_audit.patient_uid = alert.patient_uid
                 AND acknowledgement_audit.action =
                       'critical_result.acknowledged'
                 AND acknowledgement_audit.action_status = 'success'
                 AND acknowledgement_audit.resource_table =
                       'lab_critical_alerts'
                 AND acknowledgement_audit.resource_id = alert.id::text
                 AND acknowledgement_audit.resource_type =
                       'critical_lab_alert'
                 AND acknowledgement_audit.actor_uid = alert.acknowledged_by
                 AND acknowledgement_audit.idempotency_key =
                       'lab_critical_alerts:' || alert.id
                         || ':audit:acknowledged'
                 AND acknowledgement_audit.occurred_at >=
                       message_record.created_at
            )
            AND NOT EXISTS (
              SELECT 1
                FROM clinical_timeline_events AS legacy_event
               WHERE legacy_event.tenant_id = result.tenant_id
                 AND legacy_event.source_table = 'lab_results'
                 AND legacy_event.source_id = result.id::text
                 AND legacy_event.payload->>'legacy_contract_adoption' = 'true'
                 AND legacy_event.payload
                       -> 'legacy_acknowledgement_proof'
                       -> 'alert_id' = to_jsonb(alert.id)
            )
       ) + (
         SELECT COUNT(*)
           FROM clinical_timeline_events AS legacy_event
           JOIN lab_critical_alerts AS alert
             ON alert.tenant_id = result.tenant_id
            AND alert.result_id = result.id
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  -> 'alert_id' = to_jsonb(alert.id)
           JOIN tasks AS task
             ON task.tenant_id = alert.tenant_id
            AND task.id = alert.acknowledgement_task_id
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  -> 'task_id' = to_jsonb(task.id)
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  -> 'sla_instance_id' = to_jsonb(sla.id)
          WHERE legacy_event.tenant_id = result.tenant_id
            AND legacy_event.patient_uid = result.patient_uid
            AND legacy_event.event_type = 'lab.result_recorded'
            AND legacy_event.source_table = 'lab_results'
            AND legacy_event.source_id = result.id::text
            AND legacy_event.idempotency_key = 'lab_results:' || result.id
              || ':lab.result_recorded:astm:' || target_message_id
            AND legacy_event.payload->>'legacy_contract_adoption' = 'true'
            AND legacy_event.payload->>'interface_message_id' =
                  target_message_id::text
            AND legacy_event.payload->>'interface_result_index' =
                  result.interface_result_index::text
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  ->> 'kind' = 'migration_583_closed_critical_acknowledgement'
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  -> 'acknowledged_at' = to_jsonb(alert.acknowledged_at)
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  -> 'acknowledged_by' = to_jsonb(alert.acknowledged_by)
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  ? 'read_back_method'
            AND legacy_event.payload
                  -> 'legacy_acknowledgement_proof'
                  ->> 'read_back_method'
                  IS NOT DISTINCT FROM alert.read_back_method
            AND legacy_event.payload->'legacy_acknowledgement_proof' =
                  lab_astm_closed_acknowledgement_proof(
                    alert.tenant_id,
                    alert.id,
                    message_record.created_at
                  )
            AND alert.patient_uid = result.patient_uid
            AND alert.superseded_at IS NULL
            AND alert.generation_signoff_id IS NULL
            AND alert.generation_metadata->>'kind' = 'initial_result_generation'
            AND alert.generation_metadata->>'acknowledgement_task_id' = task.id::text
            AND alert.generation_metadata->>'corrected_state' = 'critical'
            AND alert.acknowledged_at IS NOT NULL
            AND alert.acknowledged_by IS NOT NULL
            AND alert.value_numeric IS NOT DISTINCT FROM result.value_numeric
            AND alert.unit IS NOT DISTINCT FROM result.unit
            AND alert.threshold_breached =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    ->> 'breached_side'
            AND to_jsonb(alert.threshold_value) =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    -> 'breached_value'
            AND alert.fired_at >= result.received_at
            AND alert.acknowledged_at >= message_record.created_at
            AND task.patient_uid = result.patient_uid
            AND task.related_resource_type = 'lab_result'
            AND task.related_resource_id = result.id::text
            AND task.sla_completion_semantics = 'acknowledgement'
            AND task.status IN ('in_progress', 'completed')
            AND task.metadata->>'lab_critical_alert_id' = alert.id::text
            AND task.metadata->>'lab_alert_generation_state' = 'critical'
            AND task.metadata->>'acknowledged_by' = alert.acknowledged_by::text
            AND task.metadata->>'acknowledged_via' IN (
                  'assignee', 'role', 'admin', 'override'
                )
            AND sla.rule_code = 'critical_result_ack'
            AND sla.source_table = 'lab_result'
            AND sla.source_id = result.id::text
            AND sla.patient_uid = result.patient_uid
            AND sla.status IN ('completed', 'breached', 'escalated')
            AND sla.completed_at IS NOT NULL
            AND sla.completed_at >= message_record.created_at
            AND sla.metadata->>'completed_via' = 'task_ack'
            AND sla.metadata->>'completed_by_task' = task.id::text
            AND sla.metadata->>'completed_by' = alert.acknowledged_by::text
            AND 1 = (
              SELECT COUNT(*)
                FROM task_comments AS receipt
               WHERE receipt.tenant_id = task.tenant_id
                 AND receipt.task_id = task.id
                 AND receipt.author_uid = alert.acknowledged_by
                 AND receipt.body_kind = 'state_change'
                 AND receipt.metadata->>'to' = 'in_progress'
                 AND receipt.metadata->>'acknowledged_at' =
                       task.metadata->>'acknowledged_at'
                 AND receipt.created_at >= message_record.created_at
            )
            AND 1 = (
              SELECT COUNT(*)
                FROM clinical_timeline_events AS acknowledgement_timeline
               WHERE acknowledgement_timeline.tenant_id = alert.tenant_id
                 AND acknowledgement_timeline.patient_uid = alert.patient_uid
                 AND acknowledgement_timeline.event_type =
                       'critical_result.acknowledged'
                 AND acknowledgement_timeline.source_table =
                       'lab_critical_alerts'
                 AND acknowledgement_timeline.source_id = alert.id::text
                 AND acknowledgement_timeline.payload ? 'read_back_method'
                 AND acknowledgement_timeline.payload->>'read_back_method'
                       IS NOT DISTINCT FROM alert.read_back_method
                 AND acknowledgement_timeline.idempotency_key =
                       'lab_critical_alerts:' || alert.id || ':acknowledged'
                 AND acknowledgement_timeline.occurred_at >=
                       message_record.created_at
            )
            AND 1 = (
              SELECT COUNT(*)
                FROM clinical_audit_events AS acknowledgement_audit
               WHERE acknowledgement_audit.tenant_id = alert.tenant_id
                 AND acknowledgement_audit.patient_uid = alert.patient_uid
                 AND acknowledgement_audit.action =
                       'critical_result.acknowledged'
                 AND acknowledgement_audit.resource_table =
                       'lab_critical_alerts'
                 AND acknowledgement_audit.resource_id = alert.id::text
                 AND acknowledgement_audit.idempotency_key =
                       'lab_critical_alerts:' || alert.id
                         || ':audit:acknowledged'
                 AND acknowledgement_audit.occurred_at >=
                       message_record.created_at
             )
       ) + (
         SELECT COUNT(*)
           FROM lab_critical_alerts AS alert
          WHERE alert.tenant_id = result.tenant_id
            AND alert.result_id = result.id
            AND alert.patient_uid = result.patient_uid
            AND alert.generation_signoff_id IS NULL
            AND alert.generation_metadata->>'kind' = 'initial_result_generation'
            AND alert.acknowledgement_task_id IS NOT NULL
            AND alert.generation_metadata->>'acknowledgement_task_id' =
                  alert.acknowledgement_task_id::text
            AND alert.generation_metadata->>'corrected_state' = 'critical'
            AND 1 = (
              SELECT COUNT(*)
                FROM regexp_split_to_table(
                       message_record.raw_message,
                       E'\r\n|\r|\n'
                     ) AS original_record(record)
               WHERE SPLIT_PART(BTRIM(original_record.record), '|', 1) = 'R'
                 AND NULLIF(BTRIM(SPLIT_PART(
                       BTRIM(original_record.record), '|', 2
                     )), '') = result.interface_result_index::text
                 AND alert.value_text IS NOT DISTINCT FROM NULLIF(BTRIM(
                       SPLIT_PART(BTRIM(original_record.record), '|', 4)
                     ), '')
                 AND alert.value_numeric IS NOT DISTINCT FROM CASE
                       WHEN pg_input_is_valid(
                              NULLIF(BTRIM(SPLIT_PART(
                                BTRIM(original_record.record), '|', 4
                              )), ''),
                              'numeric'
                            )
                         THEN NULLIF(BTRIM(SPLIT_PART(
                                BTRIM(original_record.record), '|', 4
                              )), '')::numeric
                       ELSE NULL
                     END
                 AND alert.unit IS NOT DISTINCT FROM NULLIF(BTRIM(
                       SPLIT_PART(BTRIM(original_record.record), '|', 5)
                     ), '')
            )
            AND alert.threshold_breached =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    ->> 'breached_side'
            AND to_jsonb(alert.threshold_value) =
                  message_record.verdicts
                    -> (result.interface_result_index - 1)
                    -> 'threshold_assessment'
                    -> 'breached_value'
            AND alert.generation_metadata->'active_threshold_id'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'threshold_id'
            AND alert.generation_metadata->'active_threshold_low'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'critical_low'
            AND alert.generation_metadata->'active_threshold_high'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'critical_high'
            AND alert.generation_metadata->'threshold_evaluated_value'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'evaluated_value'
            AND alert.generation_metadata->'threshold_value_conversion'
                  IS NOT DISTINCT FROM
                    message_record.verdicts
                      -> (result.interface_result_index - 1)
                      -> 'threshold_assessment'
                      -> 'conversion'
            AND alert.fired_at >= result.received_at
            AND alert.superseded_at IS NOT NULL
            AND alert.superseded_by_alert_id IS NOT NULL
            AND alert.superseded_by_signoff_id IS NOT NULL
            AND (
              (
                alert.acknowledged_at IS NULL
                AND alert.acknowledged_by IS NULL
              )
              OR lab_astm_superseded_acknowledgement_proof(
                   alert.tenant_id,
                   alert.id,
                   message_record.created_at
                 ) IS NOT NULL
            )
            AND EXISTS (
              WITH RECURSIVE successor_chain AS (
                SELECT successor.*,
                       ARRAY[alert.id, successor.id]::integer[] AS traversal_path
                  FROM lab_critical_alerts AS successor
                  JOIN lab_pathologist_signoffs AS signoff
                    ON signoff.tenant_id = successor.tenant_id
                   AND signoff.id = successor.generation_signoff_id
                 WHERE successor.tenant_id = alert.tenant_id
                   AND successor.id = alert.superseded_by_alert_id
                   AND successor.result_id = alert.result_id
                   AND successor.patient_uid = alert.patient_uid
                   AND successor.generation_signoff_id =
                         alert.superseded_by_signoff_id
                   AND successor.fired_at > alert.fired_at
                   AND successor.fired_at <= alert.superseded_at
                   AND successor.generation_metadata->>'kind' =
                         'corrected_result_generation'
                   AND successor.generation_metadata->>'signoff_id' =
                         signoff.id::text
                   AND successor.generation_metadata->>'supersedes_alert_id' =
                         alert.id::text
                   AND successor.generation_metadata->>'acknowledgement_task_id' =
                         successor.acknowledgement_task_id::text
                   AND successor.generation_metadata->>'corrected_state' IN (
                         'critical', 'within_active_critical_thresholds',
                         'threshold_unavailable', 'legacy_unclassified'
                       )
                   AND signoff.patient_uid = alert.patient_uid
                   AND alert.result_id = ANY(signoff.result_ids)
                   AND signoff.decision IN ('corrected', 'amended')
                   AND signoff.signed_at >= alert.fired_at
                   AND signoff.signed_at <= successor.fired_at

                UNION ALL

                SELECT next_successor.*,
                       successor_chain.traversal_path || next_successor.id
                  FROM successor_chain
                  JOIN lab_critical_alerts AS next_successor
                    ON next_successor.tenant_id = successor_chain.tenant_id
                   AND next_successor.id = successor_chain.superseded_by_alert_id
                   AND next_successor.result_id = successor_chain.result_id
                   AND next_successor.patient_uid = successor_chain.patient_uid
                   AND next_successor.generation_signoff_id =
                         successor_chain.superseded_by_signoff_id
                  JOIN lab_pathologist_signoffs AS next_signoff
                    ON next_signoff.tenant_id = next_successor.tenant_id
                   AND next_signoff.id = next_successor.generation_signoff_id
                 WHERE successor_chain.superseded_at IS NOT NULL
                   AND successor_chain.superseded_by_alert_id IS NOT NULL
                   AND successor_chain.superseded_by_signoff_id IS NOT NULL
                   AND next_successor.fired_at > successor_chain.fired_at
                   AND next_successor.fired_at <= successor_chain.superseded_at
                   AND next_successor.generation_metadata->>'kind' =
                         'corrected_result_generation'
                   AND next_successor.generation_metadata->>'signoff_id' =
                         next_signoff.id::text
                   AND next_successor.generation_metadata->>'supersedes_alert_id' =
                         successor_chain.id::text
                   AND next_successor.generation_metadata
                         ->> 'acknowledgement_task_id' =
                         next_successor.acknowledgement_task_id::text
                   AND next_successor.generation_metadata->>'corrected_state' IN (
                         'critical', 'within_active_critical_thresholds',
                         'threshold_unavailable', 'legacy_unclassified'
                       )
                   AND next_signoff.patient_uid = successor_chain.patient_uid
                   AND successor_chain.result_id = ANY(next_signoff.result_ids)
                   AND next_signoff.decision IN ('corrected', 'amended')
                   AND next_signoff.signed_at >= successor_chain.fired_at
                   AND next_signoff.signed_at <= next_successor.fired_at
                   AND NOT next_successor.id = ANY(successor_chain.traversal_path)
              )
              SELECT 1
                FROM successor_chain AS current_alert
               WHERE current_alert.superseded_at IS NULL
                 AND current_alert.superseded_by_alert_id IS NULL
                 AND current_alert.superseded_by_signoff_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                     FROM successor_chain AS historical_alert
                    WHERE historical_alert.superseded_at IS NOT NULL
                      AND NOT (
                        (
                          historical_alert.acknowledged_at IS NULL
                          AND historical_alert.acknowledged_by IS NULL
                        )
                        OR lab_astm_superseded_acknowledgement_proof(
                             historical_alert.tenant_id,
                             historical_alert.id,
                             message_record.created_at
                           ) IS NOT NULL
                      )
                 )
                 AND current_alert.value_text IS NOT DISTINCT FROM result.value_text
                 AND current_alert.value_numeric IS NOT DISTINCT FROM
                       result.value_numeric
                 AND current_alert.unit IS NOT DISTINCT FROM result.unit
                 AND (
                   current_alert.generation_metadata->>'corrected_state' =
                     'legacy_unclassified'
                   OR result.is_critical IS NOT DISTINCT FROM (
                        current_alert.generation_metadata->>'corrected_state' =
                          'critical'
                      )
                 )
                 AND 1 = (
                   (
                     SELECT COUNT(*)
                       FROM tasks AS current_task
                       JOIN workflow_sla_instances AS current_sla
                         ON current_sla.tenant_id = current_task.tenant_id
                        AND current_sla.id = current_task.workflow_sla_instance_id
                      WHERE current_alert.acknowledged_at IS NULL
                        AND current_alert.acknowledged_by IS NULL
                        AND current_task.tenant_id = current_alert.tenant_id
                        AND current_task.id = current_alert.acknowledgement_task_id
                        AND current_task.patient_uid = current_alert.patient_uid
                        AND current_task.related_resource_type = 'lab_result'
                        AND current_task.related_resource_id =
                              current_alert.result_id::text
                        AND current_task.sla_completion_semantics =
                              'acknowledgement'
                        AND current_task.status IN ('open', 'blocked', 'overdue')
                        AND current_task.metadata->>'lab_critical_alert_id' =
                              current_alert.id::text
                        AND current_task.metadata
                              ->> 'lab_alert_generation_signoff_id' =
                              current_alert.generation_signoff_id::text
                        AND current_task.metadata
                              ->> 'lab_alert_generation_state' =
                              current_alert.generation_metadata->>'corrected_state'
                        AND current_sla.rule_code = 'critical_result_ack'
                        AND current_sla.source_table = 'lab_result'
                        AND current_sla.source_id = current_alert.result_id::text
                        AND current_sla.patient_uid = current_alert.patient_uid
                        AND current_sla.status IN (
                              'active', 'breached', 'escalated'
                            )
                        AND current_sla.completed_at IS NULL
                   ) + (
                     SELECT COUNT(*)
                       FROM tasks AS current_task
                       JOIN workflow_sla_instances AS current_sla
                         ON current_sla.tenant_id = current_task.tenant_id
                        AND current_sla.id = current_task.workflow_sla_instance_id
                       WHERE current_alert.acknowledged_at IS NOT NULL
                         AND current_alert.acknowledged_by IS NOT NULL
                         AND current_alert.acknowledged_at >= current_alert.fired_at
                         AND lab_astm_closed_acknowledgement_proof(
                               current_alert.tenant_id,
                               current_alert.id,
                               message_record.created_at
                             ) IS NOT NULL
                         AND current_task.tenant_id = current_alert.tenant_id
                        AND current_task.id = current_alert.acknowledgement_task_id
                        AND current_task.patient_uid = current_alert.patient_uid
                        AND current_task.related_resource_type = 'lab_result'
                        AND current_task.related_resource_id =
                              current_alert.result_id::text
                        AND current_task.sla_completion_semantics =
                              'acknowledgement'
                        AND current_task.status IN ('in_progress', 'completed')
                        AND current_task.metadata->>'lab_critical_alert_id' =
                              current_alert.id::text
                        AND current_task.metadata
                              ->> 'lab_alert_generation_signoff_id' =
                              current_alert.generation_signoff_id::text
                        AND current_task.metadata
                              ->> 'lab_alert_generation_state' =
                              current_alert.generation_metadata->>'corrected_state'
                        AND LOWER(current_task.metadata->>'acknowledged_by') =
                              LOWER(current_alert.acknowledged_by::text)
                        AND current_task.metadata->>'acknowledged_via' IN (
                              'assignee', 'role', 'admin', 'override'
                            )
                        AND current_task.metadata->>'acknowledged_at' ~
                              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                        AND pg_input_is_valid(
                              current_task.metadata->>'acknowledged_at',
                              'timestamp with time zone'
                            )
                        AND (
                              current_task.metadata->>'acknowledged_at'
                            )::timestamptz = current_alert.acknowledged_at
                        AND current_sla.rule_code = 'critical_result_ack'
                        AND current_sla.source_table = 'lab_result'
                        AND current_sla.source_id = current_alert.result_id::text
                        AND current_sla.patient_uid = current_alert.patient_uid
                        AND current_sla.status IN (
                              'completed', 'breached', 'escalated'
                            )
                        AND current_sla.completed_at =
                              current_alert.acknowledged_at
                        AND current_sla.metadata->>'completed_via' = 'task_ack'
                        AND current_sla.metadata->>'completed_by_task' =
                              current_task.id::text
                        AND LOWER(current_sla.metadata->>'completed_by') =
                              LOWER(current_alert.acknowledged_by::text)
                        AND 1 = (
                          SELECT COUNT(*)
                            FROM task_comments AS current_receipt
                           WHERE current_receipt.tenant_id = current_task.tenant_id
                             AND current_receipt.task_id = current_task.id
                             AND current_receipt.author_uid =
                                   current_alert.acknowledged_by
                             AND current_receipt.body_kind = 'state_change'
                             AND current_receipt.metadata->>'to' = 'in_progress'
                             AND current_receipt.metadata->>'acknowledged_at' =
                                   current_task.metadata->>'acknowledged_at'
                             AND current_receipt.metadata->>'via' =
                                   current_task.metadata->>'acknowledged_via'
                             AND current_receipt.created_at >=
                                   message_record.created_at
                        )
                        AND 1 = (
                          SELECT COUNT(*)
                            FROM clinical_timeline_events AS current_timeline
                           WHERE current_timeline.tenant_id =
                                   current_alert.tenant_id
                             AND current_timeline.patient_uid =
                                   current_alert.patient_uid
                             AND current_timeline.event_type =
                                   'critical_result.acknowledged'
                             AND current_timeline.event_status = 'acknowledged'
                             AND current_timeline.source_table =
                                   'lab_critical_alerts'
                             AND current_timeline.source_id =
                                   current_alert.id::text
                             AND current_timeline.resource_type =
                                   'critical_lab_alert'
                             AND current_timeline.resource_id =
                                   current_alert.id::text
                             AND current_timeline.actor_uid =
                                   current_alert.acknowledged_by
                             AND current_timeline.payload->'alert_id' =
                                   to_jsonb(current_alert.id)
                             AND current_timeline.payload->'result_id' =
                                   to_jsonb(current_alert.result_id)
                             AND current_timeline.payload
                                   ->> 'acknowledgement_authorization' =
                                   current_task.metadata->>'acknowledged_via'
                             AND current_timeline.payload ? 'read_back_method'
                             AND current_timeline.payload->>'read_back_method'
                                   IS NOT DISTINCT FROM
                                   current_alert.read_back_method
                             AND current_timeline.idempotency_key =
                                   'lab_critical_alerts:' || current_alert.id
                                     || ':acknowledged'
                             AND current_timeline.occurred_at >=
                                   message_record.created_at
                        )
                        AND 1 = (
                          SELECT COUNT(*)
                            FROM clinical_audit_events AS current_audit
                           WHERE current_audit.tenant_id = current_alert.tenant_id
                             AND current_audit.patient_uid =
                                   current_alert.patient_uid
                             AND current_audit.action =
                                   'critical_result.acknowledged'
                             AND current_audit.action_status = 'success'
                             AND current_audit.resource_table =
                                   'lab_critical_alerts'
                             AND current_audit.resource_id =
                                   current_alert.id::text
                             AND current_audit.resource_type =
                                   'critical_lab_alert'
                             AND current_audit.actor_uid =
                                   current_alert.acknowledged_by
                             AND current_audit.idempotency_key =
                                   'lab_critical_alerts:' || current_alert.id
                                     || ':audit:acknowledged'
                             AND current_audit.occurred_at >=
                                   message_record.created_at
                        )
                   )
                 )
            )
       )
     )
   ORDER BY result.interface_result_index
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ASTM ingested receipt %s/%s has a critical result without one exact actionable task/SLA obligation',
        target_tenant_id,
        target_message_id
      ),
      DETAIL = format('result_id=%s', invalid_critical_result_id);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION lab_interface_validate_astm_ingested_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lab_interface_assert_astm_current_authorization(NEW.tenant_id, NEW.id);
  ELSIF OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status IN ('failed', 'ingested') THEN
    PERFORM lab_interface_assert_astm_current_authorization(NEW.tenant_id, NEW.id);
  END IF;
  PERFORM lab_interface_assert_astm_ingested_complete(NEW.tenant_id, NEW.id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_interface_validate_astm_ingested_complete
  ON lab_interface_messages;
CREATE CONSTRAINT TRIGGER trg_lab_interface_validate_astm_ingested_complete
AFTER INSERT OR UPDATE OF status, result_count, specimen_id, verdicts,
  processed_at, error, analyzer_id, ingest_contract_version
ON lab_interface_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NEW.direction = 'inbound'
  AND NEW.protocol = 'astm_e1394'
)
EXECUTE FUNCTION lab_interface_validate_astm_ingested_complete();

CREATE OR REPLACE FUNCTION lab_interface_protect_astm_ingested_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.direction = 'inbound'
     AND OLD.protocol = 'astm_e1394'
     AND (
       OLD.status IN ('failed', 'ingested')
       OR (OLD.status = 'received' AND OLD.ingest_contract_version = 1)
     )
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Terminal ASTM interface receipt is immutable';
    END IF;

    IF OLD.status = 'failed' THEN
      IF OLD.ingest_contract_version IS DISTINCT FROM 1
         OR OLD.error IS NULL
         OR OLD.processed_at IS NULL
         OR OLD.result_count IS NOT NULL
         OR OLD.specimen_id IS NOT NULL
         OR OLD.verdicts IS NOT NULL
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.analyzer_id IS DISTINCT FROM OLD.analyzer_id
         OR NEW.analyzer_code IS DISTINCT FROM OLD.analyzer_code
         OR NEW.direction IS DISTINCT FROM OLD.direction
         OR NEW.protocol IS DISTINCT FROM OLD.protocol
         OR NEW.message_type IS DISTINCT FROM OLD.message_type
         OR NEW.raw_message IS DISTINCT FROM OLD.raw_message
         OR NEW.ingest_contract_version IS DISTINCT FROM OLD.ingest_contract_version
         OR NEW.authenticated_actor_uid IS DISTINCT FROM OLD.authenticated_actor_uid
         OR NEW.authenticated_actor_roles IS DISTINCT FROM OLD.authenticated_actor_roles
         OR NEW.analyzer_binding_mode IS DISTINCT FROM OLD.analyzer_binding_mode
         OR NEW.analyzer_binding_identity IS DISTINCT FROM OLD.analyzer_binding_identity
         OR NEW.analyzer_sender_identity IS DISTINCT FROM OLD.analyzer_sender_identity
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.status IS DISTINCT FROM 'received'
         OR NEW.error IS NOT NULL
         OR NEW.result_count IS NOT NULL
         OR NEW.specimen_id IS NOT NULL
         OR NEW.verdicts IS NOT NULL
         OR NEW.processed_at IS NOT NULL
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Failed ASTM receipt only permits an exact structural retry';
      END IF;
    ELSIF OLD.status = 'received' THEN
      IF OLD.error IS NOT NULL
         OR OLD.result_count IS NOT NULL
         OR OLD.specimen_id IS NOT NULL
         OR OLD.verdicts IS NOT NULL
         OR OLD.processed_at IS NOT NULL
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.analyzer_id IS DISTINCT FROM OLD.analyzer_id
         OR NEW.analyzer_code IS DISTINCT FROM OLD.analyzer_code
         OR NEW.direction IS DISTINCT FROM OLD.direction
         OR NEW.protocol IS DISTINCT FROM OLD.protocol
         OR NEW.message_type IS DISTINCT FROM OLD.message_type
         OR NEW.raw_message IS DISTINCT FROM OLD.raw_message
         OR NEW.ingest_contract_version IS DISTINCT FROM OLD.ingest_contract_version
         OR NEW.authenticated_actor_uid IS DISTINCT FROM OLD.authenticated_actor_uid
         OR NEW.authenticated_actor_roles IS DISTINCT FROM OLD.authenticated_actor_roles
         OR NEW.analyzer_binding_mode IS DISTINCT FROM OLD.analyzer_binding_mode
         OR NEW.analyzer_binding_identity IS DISTINCT FROM OLD.analyzer_binding_identity
         OR NEW.analyzer_sender_identity IS DISTINCT FROM OLD.analyzer_sender_identity
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.status IS DISTINCT FROM 'ingested'
         OR NEW.error IS NOT NULL
         OR NEW.result_count IS NULL
         OR NEW.result_count <= 0
         OR NEW.specimen_id IS NULL
         OR NEW.verdicts IS NULL
         OR NEW.processed_at IS NULL
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Received ASTM receipt only permits atomic completion';
      END IF;
    ELSIF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.analyzer_id IS DISTINCT FROM NEW.analyzer_id
       OR OLD.analyzer_code IS DISTINCT FROM NEW.analyzer_code
       OR OLD.direction IS DISTINCT FROM NEW.direction
       OR OLD.protocol IS DISTINCT FROM NEW.protocol
       OR OLD.message_type IS DISTINCT FROM NEW.message_type
       OR OLD.raw_message IS DISTINCT FROM NEW.raw_message
       OR OLD.ingest_contract_version IS DISTINCT FROM NEW.ingest_contract_version
       OR OLD.authenticated_actor_uid IS DISTINCT FROM NEW.authenticated_actor_uid
       OR OLD.authenticated_actor_roles IS DISTINCT FROM NEW.authenticated_actor_roles
       OR OLD.analyzer_binding_mode IS DISTINCT FROM NEW.analyzer_binding_mode
       OR OLD.analyzer_binding_identity IS DISTINCT FROM NEW.analyzer_binding_identity
       OR OLD.analyzer_sender_identity IS DISTINCT FROM NEW.analyzer_sender_identity
       OR OLD.status IS DISTINCT FROM NEW.status
       OR OLD.error IS DISTINCT FROM NEW.error
       OR OLD.result_count IS DISTINCT FROM NEW.result_count
       OR OLD.specimen_id IS DISTINCT FROM NEW.specimen_id
       OR OLD.verdicts IS DISTINCT FROM NEW.verdicts
       OR OLD.processed_at IS DISTINCT FROM NEW.processed_at
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Ingested ASTM interface receipt is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_interface_protect_astm_ingested_terminal
  ON lab_interface_messages;
CREATE TRIGGER trg_lab_interface_protect_astm_ingested_terminal
BEFORE UPDATE OR DELETE
ON lab_interface_messages
FOR EACH ROW
EXECUTE FUNCTION lab_interface_protect_astm_ingested_terminal();

CREATE OR REPLACE FUNCTION lab_results_assert_interface_replay_identity_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  linked_message_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.interface_message_id IS NOT NULL THEN
      SELECT message.status
        INTO linked_message_status
        FROM lab_interface_messages AS message
       WHERE message.tenant_id = NEW.tenant_id
         AND message.id = NEW.interface_message_id
         AND message.direction = 'inbound'
         AND message.protocol = 'astm_e1394';
      IF linked_message_status = 'ingested' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Cannot attach a new result to an ingested ASTM receipt';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.interface_message_id IS NOT NULL THEN
      SELECT message.status
        INTO linked_message_status
        FROM lab_interface_messages AS message
       WHERE message.tenant_id = OLD.tenant_id
         AND message.id = OLD.interface_message_id
         AND message.direction = 'inbound'
         AND message.protocol = 'astm_e1394';
      IF linked_message_status = 'ingested' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Result linked to an ingested ASTM receipt cannot be deleted';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF (
       OLD.interface_message_id IS NOT NULL
       OR OLD.interface_result_index IS NOT NULL
       OR NEW.interface_message_id IS NOT NULL
       OR NEW.interface_result_index IS NOT NULL
     )
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.interface_message_id IS DISTINCT FROM NEW.interface_message_id
       OR OLD.interface_result_index IS DISTINCT FROM NEW.interface_result_index
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lab result interface replay identity is immutable once assigned';
  END IF;

  IF OLD.interface_message_id IS NOT NULL THEN
    SELECT message.status
      INTO linked_message_status
      FROM lab_interface_messages AS message
     WHERE message.tenant_id = OLD.tenant_id
       AND message.id = OLD.interface_message_id
       AND message.direction = 'inbound'
       AND message.protocol = 'astm_e1394';
    IF linked_message_status = 'ingested'
       AND (
         OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
         OR OLD.booking_id IS DISTINCT FROM NEW.booking_id
         OR OLD.investigation_id IS DISTINCT FROM NEW.investigation_id
         OR OLD.specimen_id IS DISTINCT FROM NEW.specimen_id
         OR OLD.analyzer_id IS DISTINCT FROM NEW.analyzer_id
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Result source binding for an ingested ASTM receipt is immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_results_interface_replay_identity_immutable
  ON lab_results;
CREATE TRIGGER trg_lab_results_interface_replay_identity_immutable
BEFORE INSERT OR UPDATE OR DELETE
ON lab_results
FOR EACH ROW
EXECUTE FUNCTION lab_results_assert_interface_replay_identity_immutable();

CREATE OR REPLACE FUNCTION lab_critical_alert_protect_astm_ingested_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM lab_results AS result
      JOIN lab_interface_messages AS message
        ON message.tenant_id = result.tenant_id
       AND message.id = result.interface_message_id
     WHERE result.tenant_id = OLD.tenant_id
       AND result.id = OLD.result_id
       AND message.direction = 'inbound'
       AND message.protocol = 'astm_e1394'
       AND message.status = 'ingested'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Critical-alert evidence for an ingested ASTM result cannot be deleted';
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_critical_alert_protect_astm_ingested_evidence
  ON lab_critical_alerts;
CREATE TRIGGER trg_lab_critical_alert_protect_astm_ingested_evidence
BEFORE DELETE
ON lab_critical_alerts
FOR EACH ROW
EXECUTE FUNCTION lab_critical_alert_protect_astm_ingested_evidence();

DO $$
DECLARE
  existing_message RECORD;
BEGIN
  FOR existing_message IN
    SELECT tenant_id, id
      FROM lab_interface_messages
     WHERE direction = 'inbound'
       AND protocol = 'astm_e1394'
       AND status = 'ingested'
     ORDER BY tenant_id, id
  LOOP
    PERFORM lab_interface_assert_astm_ingested_complete(
      existing_message.tenant_id,
      existing_message.id
    );
  END LOOP;
END
$$;

COMMIT;
