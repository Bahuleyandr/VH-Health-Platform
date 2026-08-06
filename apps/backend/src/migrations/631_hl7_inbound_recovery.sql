-- C6.1 / I03 inbound ADT/ORM recovery.
-- Late inbound HL7v2 is retained as encrypted, append-only reconciliation
-- evidence. It never mutates admissions or investigations directly.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The recovery receipt must bind the stable tenant credential row, not an
-- untrusted MSH sender string or the environment-secret fallback.
ALTER TABLE public.tenant_interop_secrets
  ADD CONSTRAINT ux_tenant_interop_secrets_tenant_id
    UNIQUE (tenant_id, id);

-- Migration 628 is the one canonical registration surface. Extend its applied
-- shape rather than adding an I03-specific registration ledger or command.
ALTER TABLE public.external_recovery_operability_actions
  DROP CONSTRAINT chk_external_recovery_action_applied_shape,
  ADD CONSTRAINT chk_external_recovery_action_applied_shape
    CHECK (
      (
        outcome = 'applied'
        AND facility_scope IS NOT NULL
        AND interface_family IN (
          'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I09', 'I10',
          'I13', 'I15', 'I16', 'I17', 'I18', 'I19', 'I23', 'I25'
        )
        AND direction IN ('inbound', 'outbound')
        AND NULLIF(BTRIM(source_partition), '') IS NOT NULL
        AND generation > 0
        AND offset_id IS NOT NULL
        AND command_class IS NOT NULL
        AND effect_identity IS NOT NULL
        AND command_fingerprint IS NOT NULL
        AND idempotency_key_sha256 IS NOT NULL
        AND http_method = 'POST'
        AND NULLIF(BTRIM(http_path), '') IS NOT NULL
        AND action_version = 1
        AND binding_version = 1
        AND schema_id = 'external-recovery-operability'
        AND schema_version = 1
        AND schema_checksum IS NOT NULL
        AND actor_role IN ('ADMIN', 'SUPER_ADMIN')
        AND reason_code IS NOT NULL
        AND reason_detail IS NOT NULL
        AND owner_evidence_reference IS NOT NULL
        AND owner_evidence_signature_sha256 IS NOT NULL
        AND policy_version IS NOT NULL
        AND policy_signature_sha256 IS NOT NULL
        AND retention_policy IS NOT NULL
        AND retention_until IS NOT NULL
        AND clinical_audit_event_id IS NOT NULL
        AND claim_txid IS NOT NULL
        AND next_state IS NOT NULL
        AND next_state_hash IS NOT NULL
      )
      OR
      (
        outcome <> 'applied'
        AND clinical_audit_event_id IS NULL
        AND actor_role IN ('ADMIN', 'SUPER_ADMIN')
      )
    );

CREATE OR REPLACE FUNCTION public.external_recovery_operability_register_offset(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  action_id UUID := (p_command ->> 'action_id')::uuid;
  offset_id UUID := (p_command ->> 'offset_id')::uuid;
  family TEXT := UPPER(BTRIM(p_command ->> 'interface_family'));
  derived_scope TEXT;
  derived_direction TEXT;
  derived_cursor_kind TEXT;
  current_actor_role TEXT;
  initial_position BIGINT := NULLIF(p_command ->> 'initial_position', '')::bigint;
  retained_position BIGINT := NULLIF(p_command ->> 'retained_from_position', '')::bigint;
  generation_value INTEGER := (p_command ->> 'generation')::integer;
  next_recovery_state TEXT;
  next_state JSONB;
  next_hash TEXT;
  expected_effect_hash TEXT;
  expected_command_hash TEXT;
  stored_receipt JSONB;
  i03_credential_id INTEGER;
  existing public.external_recovery_operability_actions%ROWTYPE;
  audit_record public.clinical_audit_events%ROWTYPE;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM tenant
     OR tenant = '00000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit non-default tenant context required';
  END IF;

  SELECT UPPER(BTRIM(role)) INTO current_actor_role
    FROM public.users
   WHERE tenant_id = tenant AND uid = actor
     AND is_active AND NOT is_deleted AND status = 'active'
   FOR SHARE;
  IF current_actor_role NOT IN ('ADMIN', 'SUPER_ADMIN')
     OR current_actor_role IS DISTINCT FROM UPPER(BTRIM(p_command ->> 'actor_role')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'current administrator authority required';
  END IF;

  IF p_command ->> 'action' <> 'register_offset'
     OR family NOT IN (
       'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I09', 'I10',
       'I13', 'I15', 'I16', 'I17', 'I18', 'I19', 'I23', 'I25'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unsupported recovery family';
  END IF;
  derived_scope := CASE WHEN family = 'I10' THEN 'facility' ELSE 'tenant' END;
  derived_direction := CASE
    WHEN family = 'I05' THEN LOWER(BTRIM(p_command ->> 'direction'))
    WHEN family IN ('I04', 'I17', 'I18', 'I19', 'I25') THEN 'outbound'
    ELSE 'inbound'
  END;
  derived_cursor_kind := CASE
    WHEN family = 'I13' THEN 'owner_reconciled_list_diff'
    WHEN family = 'I16' THEN 'owner_reconciled_provider_transaction'
    WHEN family = 'I18' THEN 'event_outbox_id_positive_ack'
    WHEN family = 'I19' THEN 'local_nhcx_message_id'
    WHEN family = 'I23' THEN 'opaque_page_token_revision'
    WHEN family = 'I25'
      AND p_command ->> 'source_partition' = 'siem:audit_log:security:capture'
      THEN 'capture_into_event_ledger'
    WHEN family = 'I25' THEN 'per_target_positive_ack'
    ELSE 'monotonic_position_and_predecessor'
  END;
  IF p_command ->> 'facility_scope' IS DISTINCT FROM derived_scope
     OR p_command ->> 'direction' IS DISTINCT FROM derived_direction
     OR derived_direction NOT IN ('inbound', 'outbound')
     OR (derived_scope = 'tenant' AND p_command ->> 'facility_id' IS NOT NULL)
     OR (derived_scope = 'facility' AND NULLIF(p_command ->> 'facility_id', '') IS NULL)
     OR (family = 'I05' AND LOWER(BTRIM(p_command ->> 'protocol')) NOT IN (
       'hl7v2', 'csv', 'json', 'fhir_json', 'other'
     ))
     OR (family <> 'I05' AND p_command ->> 'protocol' IS NOT NULL)
     OR (family = 'I06' AND p_command ->> 'subpath' <> 'study_link')
     OR (family = 'I15' AND p_command ->> 'subpath' <> 'fhir_write')
     OR (family NOT IN ('I06', 'I15') AND p_command ->> 'subpath' IS NOT NULL)
     OR (
       family = 'I25'
       AND p_command ->> 'source_partition' <> 'siem:audit_log:security:capture'
       AND p_command ->> 'source_partition' !~ '^siem:audit_log:security:target:[1-9][0-9]*$'
     )
     OR generation_value <= 0
     OR NULLIF(BTRIM(p_command ->> 'source_partition'), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'server-derived recovery class mismatch';
  END IF;
  IF derived_scope = 'facility' AND NOT EXISTS (
    SELECT 1 FROM public.facilities
     WHERE tenant_id = tenant AND id = (p_command ->> 'facility_id')::integer
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'recovery facility is outside the tenant';
  END IF;

  IF family = 'I03' THEN
    IF p_command ->> 'source_partition'
         !~ '^i03/credential/[1-9][0-9]*/family/(adt|orm)$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'I03 source partition is not server-derived from a signing credential';
    END IF;
    BEGIN
      i03_credential_id := split_part(p_command ->> 'source_partition', '/', 3)::integer;
    EXCEPTION
      WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'I03 signing credential identity is outside the supported range';
    END;
    IF NOT EXISTS (
      SELECT 1
        FROM public.tenant_interop_secrets AS credential
       WHERE credential.tenant_id = tenant
         AND credential.id = i03_credential_id
         AND credential.kind = 'hl7_inbound'
         AND credential.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'I03 registration requires an active tenant HL7 signing credential';
    END IF;
  END IF;

  IF (initial_position IS NULL) IS DISTINCT FROM (p_command ->> 'initial_token' IS NULL)
     OR (retained_position IS NULL) IS DISTINCT FROM (p_command ->> 'retained_from_token' IS NULL)
     OR COALESCE(initial_position, 0) < 0
     OR COALESCE(retained_position, 0) < 0
     OR p_command ->> 'command_class' IS DISTINCT FROM (CASE
       WHEN initial_position IS NULL THEN 'register_marker_absent_offset'
       ELSE 'register_paused_offset'
     END)
     OR p_command ->> 'reason_code' NOT IN (
       'initial_marker_reconciled', 'retained_range_verified', 'marker_absence_recorded'
     )
     OR (initial_position IS NULL) IS DISTINCT FROM (
       p_command ->> 'reason_code' = 'marker_absence_recorded'
     )
     OR CHAR_LENGTH(BTRIM(p_command ->> 'reason_detail')) NOT BETWEEN 10 AND 500
     OR p_command ->> 'reason_detail' ~ '[[:cntrl:]]'
     OR p_command ->> 'effect_identity' !~ '^[0-9a-f]{64}$'
     OR p_command ->> 'command_fingerprint' !~ '^[0-9a-f]{64}$'
     OR p_command ->> 'idempotency_key_sha256' !~ '^[0-9a-f]{64}$'
     OR p_command ->> 'schema_checksum' <>
        '24a67d423bc118a6aaf1f46e47d86cd6e8e36a2c0ec1bca0378685824e649dc5'
     OR p_command ->> 'schema_id' <> 'external-recovery-operability'
     OR (p_command ->> 'schema_version')::integer <> 1
     OR (p_command ->> 'action_version')::integer <> 1
     OR (p_command ->> 'binding_version')::integer <> 1
     OR encode(public.digest(convert_to(p_command ->> 'owner_evidence_signature', 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM p_command ->> 'owner_evidence_signature_sha256'
     OR encode(public.digest(convert_to(p_command ->> 'policy_signature', 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM p_command ->> 'policy_signature_sha256'
     OR NULLIF(BTRIM(p_command ->> 'owner_evidence_reference'), '') IS NULL
     OR NULLIF(BTRIM(p_command ->> 'policy_version'), '') IS NULL
     OR NULLIF(BTRIM(p_command ->> 'retention_policy'), '') IS NULL
     OR NULLIF(p_command ->> 'retention_until', '')::timestamptz IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'registration command evidence is invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      tenant::text || ':' || family || ':' || derived_direction || ':'
      || (p_command ->> 'source_partition') || ':' || generation_value::text,
      628
    )
  );

  SELECT * INTO existing
    FROM public.external_recovery_operability_actions AS action
   WHERE action.tenant_id = tenant
     AND (
       action.id = action_id
       OR action.effect_identity = p_command ->> 'effect_identity'
       OR action.idempotency_key_sha256 = p_command ->> 'idempotency_key_sha256'
     )
   ORDER BY action.recorded_at
   LIMIT 1
   FOR SHARE;
  IF FOUND THEN
    IF existing.id = action_id
       AND existing.action = 'register_offset'
       AND existing.outcome = 'applied'
       AND existing.effect_identity = p_command ->> 'effect_identity'
       AND existing.command_fingerprint = p_command ->> 'command_fingerprint'
       AND existing.actor_uid = actor
       AND existing.actor_role = current_actor_role
       AND existing.offset_id = offset_id THEN
      RETURN jsonb_set(existing.receipt, '{disposition}', '"exact_duplicate"'::jsonb);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'external-recovery registration identity drift';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event_consumer_offsets AS offsets
     WHERE offsets.scope_kind = 'external_interface'
       AND offsets.tenant_id = tenant
       AND offsets.interface_family = family
       AND offsets.direction = derived_direction
       AND offsets.source_partition = p_command ->> 'source_partition'
       AND (
         offsets.generation = generation_value
         OR offsets.intake_retired_at IS NULL
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'external-recovery offset already exists';
  END IF;

  next_recovery_state := CASE
    WHEN initial_position IS NULL THEN 'reconciliation_required_missing_marker'
    ELSE 'paused'
  END;
  next_state := jsonb_build_object(
    'recovery_state', next_recovery_state,
    'reconciliation_reason', CASE WHEN initial_position IS NULL THEN 'marker_absent' ELSE NULL END
  );
  next_hash := encode(public.digest(convert_to(next_state::text, 'UTF8'), 'sha256'), 'hex');
  expected_effect_hash := public.external_recovery_operability_bound_hash(ARRAY[
    'register_offset',
    '1',
    '1',
    'external-recovery-operability',
    '1',
    tenant::text,
    derived_scope,
    NULLIF(p_command ->> 'facility_id', ''),
    family,
    NULLIF(p_command ->> 'subpath', ''),
    NULLIF(p_command ->> 'protocol', ''),
    derived_direction,
    p_command ->> 'source_partition',
    generation_value::text,
    NULLIF(p_command ->> 'initial_position', ''),
    NULLIF(p_command ->> 'initial_token', ''),
    NULLIF(p_command ->> 'retained_from_position', ''),
    NULLIF(p_command ->> 'retained_from_token', ''),
    p_command ->> 'policy_version',
    p_command ->> 'policy_signature_sha256',
    p_command ->> 'retention_policy',
    p_command ->> 'retention_until',
    p_command ->> 'owner_evidence_reference',
    p_command ->> 'owner_evidence_signature_sha256'
  ]);
  expected_command_hash := public.external_recovery_operability_bound_hash(ARRAY[
    expected_effect_hash,
    actor::text,
    current_actor_role,
    p_command ->> 'reason_code',
    p_command ->> 'reason_detail',
    'POST',
    '/api/v1/admin/continuity/external-recovery/offsets',
    NULL,
    next_recovery_state,
    next_state ->> 'reconciliation_reason'
  ]);
  IF p_command ->> 'effect_identity' IS DISTINCT FROM expected_effect_hash
     OR p_command ->> 'command_fingerprint' IS DISTINCT FROM expected_command_hash THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'registration command hashes are not bound to typed evidence';
  END IF;

  SELECT * INTO audit_record
    FROM public.clinical_audit_events AS audit
   WHERE audit.tenant_id = tenant
     AND audit.id = (p_command ->> 'audit_event_id')::uuid
     AND audit.action = 'external_recovery.offset.register'
     AND audit.action_status = 'success'
     AND audit.actor_uid = actor
     AND UPPER(BTRIM(audit.actor_role)) = current_actor_role
     AND audit.resource_type = 'external_recovery_operability_action'
     AND audit.resource_table = 'external_recovery_operability_actions'
     AND audit.resource_id = action_id::text
     AND audit.after_state ->> 'action_id' = action_id::text
     AND audit.after_state ->> 'effect_identity' = p_command ->> 'effect_identity'
     AND audit.after_state ->> 'command_fingerprint' = p_command ->> 'command_fingerprint'
     AND audit.after_state ->> 'offset_id' = offset_id::text
     AND (audit.after_state ->> 'network_or_worker_effect')::boolean IS FALSE
     AND audit.idempotency_key = 'external-recovery-register:' || (p_command ->> 'effect_identity')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'registration clinical audit evidence is invalid';
  END IF;

  stored_receipt := jsonb_build_object(
    'disposition', 'applied',
    'action_id', action_id,
    'offset_id', offset_id,
    'tenant_id', tenant,
    'facility_scope', derived_scope,
    'facility_id', NULLIF(p_command ->> 'facility_id', '')::integer,
    'interface_family', family,
    'direction', derived_direction,
    'source_partition', p_command ->> 'source_partition',
    'generation', generation_value,
    'high_water_position', initial_position,
    'high_water_token', p_command ->> 'initial_token',
    'retained_from_position', retained_position,
    'retained_from_token', p_command ->> 'retained_from_token',
    'recovery_state', next_recovery_state,
    'reconciliation_reason', next_state ->> 'reconciliation_reason',
    'network_or_worker_effect', FALSE
  );

  INSERT INTO public.external_recovery_operability_actions (
    id, tenant_id, facility_scope, facility_id, interface_family, subpath,
    protocol, direction, source_partition, generation, offset_id, action,
    command_class, outcome, effect_identity, command_fingerprint,
    idempotency_key_sha256, request_id, http_method, http_path, action_version,
    binding_version, schema_id, schema_version, schema_checksum, actor_uid,
    actor_role, reason_code, reason_detail, owner_evidence_reference,
    owner_evidence_signature_sha256, policy_version, policy_signature_sha256,
    retention_policy, retention_until, initial_position, initial_token,
    retained_from_position, retained_from_token, next_recovery_state,
    next_state, next_state_hash, clinical_audit_event_id, claim_txid, receipt
  ) VALUES (
    action_id, tenant, derived_scope, NULLIF(p_command ->> 'facility_id', '')::integer,
    family, NULLIF(p_command ->> 'subpath', ''), NULLIF(p_command ->> 'protocol', ''),
    derived_direction, p_command ->> 'source_partition', generation_value,
    offset_id, 'register_offset', p_command ->> 'command_class', 'applied',
    p_command ->> 'effect_identity', p_command ->> 'command_fingerprint',
    p_command ->> 'idempotency_key_sha256', NULLIF(p_command ->> 'request_id', ''),
    'POST', '/api/v1/admin/continuity/external-recovery/offsets', 1, 1,
    'external-recovery-operability', 1, p_command ->> 'schema_checksum', actor,
    current_actor_role, p_command ->> 'reason_code', p_command ->> 'reason_detail',
    p_command ->> 'owner_evidence_reference',
    p_command ->> 'owner_evidence_signature_sha256', p_command ->> 'policy_version',
    p_command ->> 'policy_signature_sha256', p_command ->> 'retention_policy',
    (p_command ->> 'retention_until')::timestamptz, initial_position,
    NULLIF(p_command ->> 'initial_token', ''), retained_position,
    NULLIF(p_command ->> 'retained_from_token', ''), next_recovery_state,
    next_state, next_hash, audit_record.id, txid_current(), stored_receipt
  );

  PERFORM set_config('app.external_recovery_operability_action_id', action_id::text, true);
  INSERT INTO public.event_consumer_offsets (
    offset_id, scope_kind, tenant_id, facility_scope, facility_id,
    interface_family, direction, source_partition, consumer_key, generation,
    cursor_kind, high_water_position, high_water_token, retained_from_position,
    retained_from_token, recovery_state, reconciliation_reason, policy_version,
    policy_signature, retention_policy, retention_until,
    historical_cutoff_event_id, backfill_cursor_event_id,
    registration_operability_action_id
  ) VALUES (
    offset_id, 'external_interface', tenant, derived_scope,
    NULLIF(p_command ->> 'facility_id', '')::integer, family, derived_direction,
    p_command ->> 'source_partition', 'external:' || family, generation_value,
    derived_cursor_kind, initial_position, NULLIF(p_command ->> 'initial_token', ''),
    retained_position, NULLIF(p_command ->> 'retained_from_token', ''),
    next_recovery_state, CASE WHEN initial_position IS NULL THEN 'marker_absent' END,
    p_command ->> 'policy_version', p_command ->> 'policy_signature',
    p_command ->> 'retention_policy', (p_command ->> 'retention_until')::timestamptz,
    NULL, NULL, action_id
  );

  RETURN stored_receipt;
END;
$$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.external_recovery_operability_register_offset(JSONB)
  FROM PUBLIC;

DO $external_recovery_runtime_register_privileges$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE FORMAT(
        'GRANT EXECUTE ON FUNCTION public.external_recovery_operability_register_offset(JSONB) TO %I',
        role_name
      );
    END IF;
  END LOOP;
END
$external_recovery_runtime_register_privileges$;

CREATE TABLE public.hl7_inbound_recovery_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  recovery_inbox_id UUID NOT NULL,
  interface_family VARCHAR(8) NOT NULL,
  signing_credential_id INTEGER NOT NULL,
  source_partition VARCHAR(160) NOT NULL,
  generation INTEGER NOT NULL,
  source_position BIGINT NOT NULL,
  source_token CHAR(64) NOT NULL,
  predecessor_token CHAR(64) NOT NULL,
  duplicate_key CHAR(64) NOT NULL,
  message_family VARCHAR(8) NOT NULL,
  message_type VARCHAR(8) NOT NULL,
  trigger_event VARCHAR(8) NOT NULL,
  message_control_id_sha256 CHAR(64) NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_bytes INTEGER NOT NULL,
  source_observed_at TIMESTAMPTZ(6) NOT NULL,
  source_received_at TIMESTAMPTZ(6) NOT NULL,
  clock_evidence JSONB NOT NULL,
  patient_uid UUID,
  visit_identity_sha256 CHAR(64),
  order_identity_sha256 CHAR(64),
  pending_task_id INTEGER NOT NULL,
  review_role VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  outcome_code VARCHAR(80) NOT NULL,
  ack_ciphertext TEXT NOT NULL,
  ack_sha256 CHAR(64) NOT NULL,
  ack_bytes INTEGER NOT NULL,
  ack_code VARCHAR(8) NOT NULL,
  http_status SMALLINT NOT NULL,
  policy_version VARCHAR(80) NOT NULL,
  policy_signature VARCHAR(128) NOT NULL,
  retention_policy VARCHAR(80) NOT NULL,
  retention_until TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT ux_hl7_inbound_recovery_receipts_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_hl7_inbound_recovery_receipts_inbox
    UNIQUE (tenant_id, recovery_inbox_id),
  CONSTRAINT ux_hl7_inbound_recovery_receipts_inbox_family
    UNIQUE (tenant_id, recovery_inbox_id, interface_family),
  CONSTRAINT ux_hl7_inbound_recovery_receipts_source_occurrence
    UNIQUE (tenant_id, source_partition, generation, source_position),
  CONSTRAINT ux_hl7_inbound_recovery_receipts_duplicate_key
    UNIQUE (tenant_id, duplicate_key),
  CONSTRAINT ux_hl7_inbound_recovery_receipts_duplicate_identity
    UNIQUE (
      tenant_id, signing_credential_id, message_family, message_type,
      trigger_event, message_control_id_sha256
    ),
  CONSTRAINT ux_hl7_inbound_recovery_receipts_task
    UNIQUE (tenant_id, pending_task_id),
  CONSTRAINT fk_hl7_inbound_recovery_receipts_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_recovery_receipts_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, interface_family)
    REFERENCES public.pathway_projector_inbox(tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_recovery_receipts_credential
    FOREIGN KEY (tenant_id, signing_credential_id)
    REFERENCES public.tenant_interop_secrets(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_recovery_receipts_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_recovery_receipts_task
    FOREIGN KEY (tenant_id, pending_task_id)
    REFERENCES public.tasks(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_hl7_inbound_recovery_receipts_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_hl7_inbound_recovery_receipts_hashes
    CHECK (
      source_token ~ '^[0-9a-f]{64}$'
      AND predecessor_token ~ '^[0-9a-f]{64}$'
      AND duplicate_key ~ '^[0-9a-f]{64}$'
      AND message_control_id_sha256 ~ '^[0-9a-f]{64}$'
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
      AND ack_sha256 ~ '^[0-9a-f]{64}$'
      AND (visit_identity_sha256 IS NULL
        OR visit_identity_sha256 ~ '^[0-9a-f]{64}$')
      AND (order_identity_sha256 IS NULL
        OR order_identity_sha256 ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT chk_hl7_inbound_recovery_receipts_shape
    CHECK (
      interface_family = 'I03'
      AND generation > 0
      AND source_position >= 0
      AND source_partition = 'i03/credential/' || signing_credential_id::text
        || '/family/' || message_family
      AND (
        (
          message_family = 'adt'
          AND message_type = 'ADT'
          AND trigger_event IN ('A01', 'A02', 'A03')
          AND review_role = 'MEDICAL_RECORDS'
          AND outcome_code = 'i03_adt_pending_admission_reconciliation'
        )
        OR (
          message_family = 'orm'
          AND message_type = 'ORM'
          AND trigger_event = 'O01'
          AND review_role = 'DUTY_DOCTOR'
          AND outcome_code = 'i03_orm_pending_order_reconciliation'
        )
      )
      AND status = 'pending_review'
      AND payload_bytes BETWEEN 1 AND 2000000
      AND OCTET_LENGTH(payload_ciphertext) > 7
      AND payload_ciphertext LIKE 'enc:v2:%'
      AND ack_bytes BETWEEN 1 AND 2000000
      AND OCTET_LENGTH(ack_ciphertext) > 7
      AND ack_ciphertext LIKE 'enc:v2:%'
      AND ack_code = 'AA'
      AND http_status = 200
      AND NULLIF(BTRIM(policy_version), '') IS NOT NULL
      AND NULLIF(BTRIM(policy_signature), '') IS NOT NULL
      AND NULLIF(BTRIM(retention_policy), '') IS NOT NULL
      AND retention_until > recorded_at
    ),
  CONSTRAINT chk_hl7_inbound_recovery_receipts_clock_evidence
    CHECK (
      jsonb_typeof(clock_evidence) = 'object'
      AND clock_evidence ?& ARRAY[
        'source_clock_id', 'synchronized_at', 'maximum_error_ms'
      ]
      AND (clock_evidence - 'source_clock_id' - 'synchronized_at'
        - 'maximum_error_ms') = '{}'::jsonb
      AND jsonb_typeof(clock_evidence -> 'source_clock_id') = 'string'
      AND CHAR_LENGTH(BTRIM(clock_evidence ->> 'source_clock_id')) BETWEEN 1 AND 120
      AND clock_evidence ->> 'source_clock_id'
        = BTRIM(clock_evidence ->> 'source_clock_id')
      AND clock_evidence ->> 'source_clock_id' !~ '[[:cntrl:]]'
      AND jsonb_typeof(clock_evidence -> 'synchronized_at') = 'string'
      AND (clock_evidence ->> 'synchronized_at') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      AND CASE
        WHEN jsonb_typeof(clock_evidence -> 'maximum_error_ms') = 'number'
          AND (clock_evidence ->> 'maximum_error_ms') ~ '^[0-9]+$'
        THEN
          (clock_evidence ->> 'maximum_error_ms')::integer BETWEEN 0 AND 300000
          AND (clock_evidence ->> 'synchronized_at')::timestamptz
            <= source_received_at
          AND source_received_at
            + ((clock_evidence ->> 'maximum_error_ms')::double precision
              * INTERVAL '1 millisecond')
            >= source_observed_at
        ELSE FALSE
      END
    )
);

CREATE INDEX idx_hl7_inbound_recovery_receipts_review
  ON public.hl7_inbound_recovery_receipts
    (tenant_id, review_role, status, recorded_at, id);

CREATE FUNCTION public.hl7_i03_length_prefixed_sha256(values_to_bind TEXT[])
RETURNS CHAR(64)
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  value TEXT;
  value_bytes BYTEA;
  bound BYTEA := ''::bytea;
BEGIN
  FOREACH value IN ARRAY values_to_bind LOOP
    value_bytes := convert_to(value, 'UTF8');
    bound := bound || int8send(octet_length(value_bytes)::bigint) || value_bytes;
  END LOOP;
  RETURN encode(public.digest(bound, 'sha256'), 'hex')::char(64);
END;
$$;

CREATE FUNCTION public.assert_hl7_inbound_recovery_task(
  target_tenant_id UUID,
  target_task_id INTEGER,
  target_receipt_id BIGINT,
  target_patient_uid UUID,
  target_recovery_inbox_id UUID,
  target_review_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tasks AS task
     WHERE task.tenant_id = target_tenant_id
       AND task.id = target_task_id
       AND task.task_kind = 'review'
       AND task.patient_uid IS NOT DISTINCT FROM target_patient_uid
       AND task.related_resource_type = 'hl7_inbound_recovery_receipt'
       AND task.related_resource_id = target_receipt_id::text
       AND task.priority = 'high'
       AND task.status = 'open'
       AND task.assigned_to_uid IS NULL
       AND task.assigned_to_role = target_review_role
       AND task.due_at IS NULL
       AND task.completed_at IS NULL
       AND task.cancelled_at IS NULL
       AND task.sla_definition_id IS NULL
       AND task.workflow_sla_instance_id IS NULL
       AND task.sla_completion_semantics = 'none'
       AND task.metadata ->> 'contract' = 'late_pending_only'
       AND task.metadata ->> 'interface_family' = 'I03'
       AND task.metadata ->> 'recovery_inbox_id' = target_recovery_inbox_id::text
       AND task.metadata ->> 'owner_reconciliation_required' = 'true'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_pending_task',
      MESSAGE = 'I03 receipt requires one exact open no-SLA reconciliation task';
  END IF;
END;
$$;

CREATE FUNCTION public.validate_hl7_inbound_recovery_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inbox public.pathway_projector_inbox%ROWTYPE;
  offset_record public.event_consumer_offsets%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_interop_secrets AS credential
     WHERE credential.tenant_id = NEW.tenant_id
       AND credential.id = NEW.signing_credential_id
       AND credential.kind = 'hl7_inbound'
       AND credential.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_credential',
      MESSAGE = 'I03 receipt requires its active same-tenant HL7 signing credential';
  END IF;

  IF NEW.patient_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.users AS patient
     WHERE patient.tenant_id = NEW.tenant_id
       AND patient.uid = NEW.patient_uid
       AND UPPER(BTRIM(patient.role)) = 'PATIENT'
       AND patient.is_active
       AND NOT patient.is_deleted
       AND patient.deleted_at IS NULL
       AND patient.status = 'active'
       AND NOT EXISTS (
         SELECT 1
           FROM public.patient_merge_requests AS merge
          WHERE merge.tenant_id = patient.tenant_id
            AND merge.secondary_uid = patient.uid
            AND merge.status = 'executed'
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_patient',
      MESSAGE = 'I03 receipt patient link is not one active same-tenant patient';
  END IF;

  SELECT item.* INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id
   FOR SHARE;
  IF NOT FOUND
     OR inbox.scope_kind <> 'external_interface'
     OR inbox.consumer_key <> 'external:I03'
     OR inbox.interface_family <> 'I03'
     OR inbox.direction <> 'inbound'
     OR inbox.facility_id IS NOT NULL
     OR inbox.source_partition IS DISTINCT FROM NEW.source_partition
     OR inbox.generation IS DISTINCT FROM NEW.generation
     OR inbox.source_position IS DISTINCT FROM NEW.source_position
     OR inbox.source_token IS DISTINCT FROM NEW.source_token
     OR inbox.predecessor_token IS DISTINCT FROM NEW.predecessor_token
     OR inbox.duplicate_key IS DISTINCT FROM NEW.duplicate_key
     OR inbox.command_fingerprint IS DISTINCT FROM NEW.payload_sha256
     OR inbox.occurred_at IS DISTINCT FROM NEW.source_observed_at
     OR inbox.arrival_class <> 'recovery_backlog'
     OR inbox.effect_disposition <> 'late_pending_only'
     OR inbox.status <> 'pending'
     OR inbox.outcome_code IS NOT NULL
     OR inbox.pending_task_id IS NOT NULL
     OR inbox.policy_version IS DISTINCT FROM NEW.policy_version
     OR inbox.policy_signature IS DISTINCT FROM NEW.policy_signature
     OR inbox.retention_policy IS DISTINCT FROM NEW.retention_policy
     OR inbox.retention_until IS DISTINCT FROM NEW.retention_until THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_provenance',
      MESSAGE = 'I03 receipt lacks exact pending canonical inbox provenance';
  END IF;

  SELECT recovery_offset.* INTO offset_record
    FROM public.event_consumer_offsets AS recovery_offset
   WHERE recovery_offset.tenant_id = NEW.tenant_id
     AND recovery_offset.offset_id = inbox.offset_id
   FOR SHARE;
  IF NOT FOUND
     OR offset_record.scope_kind <> 'external_interface'
     OR offset_record.facility_scope <> 'tenant'
     OR offset_record.facility_id IS NOT NULL
     OR offset_record.interface_family <> 'I03'
     OR offset_record.direction <> 'inbound'
     OR offset_record.source_partition IS DISTINCT FROM NEW.source_partition
     OR offset_record.consumer_key <> 'external:I03'
     OR offset_record.generation IS DISTINCT FROM NEW.generation
     OR offset_record.cursor_kind <> 'monotonic_position_and_predecessor'
     OR offset_record.recovery_state <> 'replaying'
     OR offset_record.high_water_position IS NULL
     OR offset_record.high_water_token IS NULL
     OR offset_record.high_water_position + 1 IS DISTINCT FROM NEW.source_position
     OR offset_record.high_water_token IS DISTINCT FROM NEW.predecessor_token
     OR offset_record.resume_cutoff_position IS NULL
     OR offset_record.resume_cutoff_token IS NULL
     OR offset_record.resume_cutoff_position < NEW.source_position
     OR offset_record.policy_version IS DISTINCT FROM NEW.policy_version
     OR offset_record.policy_signature IS DISTINCT FROM NEW.policy_signature
     OR offset_record.retention_policy IS DISTINCT FROM NEW.retention_policy
     OR offset_record.retention_until IS DISTINCT FROM NEW.retention_until THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_offset',
      MESSAGE = 'I03 receipt lacks the exact owner-resumed monotonic offset';
  END IF;

  IF NEW.source_token IS DISTINCT FROM public.hl7_i03_length_prefixed_sha256(ARRAY[
    'vh-i03-source-token-v1',
    NEW.tenant_id::text,
    NEW.source_partition,
    NEW.generation::text,
    NEW.source_position::text,
    NEW.predecessor_token,
    NEW.duplicate_key,
    NEW.payload_sha256
  ]) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_source_token',
      MESSAGE = 'I03 source token is not bound to its exact source occurrence';
  END IF;

  PERFORM public.assert_hl7_inbound_recovery_task(
    NEW.tenant_id,
    NEW.pending_task_id,
    NEW.id,
    NEW.patient_uid,
    NEW.recovery_inbox_id,
    NEW.review_role
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_hl7_inbound_recovery_receipt
BEFORE INSERT ON public.hl7_inbound_recovery_receipts
FOR EACH ROW EXECUTE FUNCTION public.validate_hl7_inbound_recovery_receipt();

CREATE FUNCTION public.validate_hl7_inbound_recovery_convergence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inbox public.pathway_projector_inbox%ROWTYPE;
  offset_record public.event_consumer_offsets%ROWTYPE;
BEGIN
  PERFORM public.assert_hl7_inbound_recovery_task(
    NEW.tenant_id,
    NEW.pending_task_id,
    NEW.id,
    NEW.patient_uid,
    NEW.recovery_inbox_id,
    NEW.review_role
  );

  SELECT item.* INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;
  IF NOT FOUND
     OR inbox.status <> 'handled'
     OR inbox.lease_owner IS NOT NULL
     OR inbox.lease_expires_at IS NOT NULL
     OR inbox.outcome_at IS NULL
     OR inbox.pending_task_id IS DISTINCT FROM NEW.pending_task_id
     OR inbox.outcome_code IS DISTINCT FROM NEW.outcome_code
     OR inbox.arrival_class <> 'recovery_backlog'
     OR inbox.effect_disposition <> 'late_pending_only'
     OR inbox.source_partition IS DISTINCT FROM NEW.source_partition
     OR inbox.generation IS DISTINCT FROM NEW.generation
     OR inbox.source_position IS DISTINCT FROM NEW.source_position
     OR inbox.source_token IS DISTINCT FROM NEW.source_token
     OR inbox.predecessor_token IS DISTINCT FROM NEW.predecessor_token
     OR inbox.duplicate_key IS DISTINCT FROM NEW.duplicate_key
     OR inbox.command_fingerprint IS DISTINCT FROM NEW.payload_sha256
     OR inbox.occurred_at IS DISTINCT FROM NEW.source_observed_at
     OR inbox.policy_version IS DISTINCT FROM NEW.policy_version
     OR inbox.policy_signature IS DISTINCT FROM NEW.policy_signature
     OR inbox.retention_policy IS DISTINCT FROM NEW.retention_policy
     OR inbox.retention_until IS DISTINCT FROM NEW.retention_until THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_convergence',
      MESSAGE = 'I03 receipt did not converge with its handled canonical inbox';
  END IF;

  SELECT recovery_offset.* INTO offset_record
    FROM public.event_consumer_offsets AS recovery_offset
   WHERE recovery_offset.tenant_id = NEW.tenant_id
     AND recovery_offset.offset_id = inbox.offset_id;
  IF NOT FOUND
     OR offset_record.high_water_position IS DISTINCT FROM NEW.source_position
     OR offset_record.high_water_token IS DISTINCT FROM NEW.source_token
     OR offset_record.recovery_state NOT IN ('replaying', 'ready')
     OR (
       offset_record.recovery_state = 'ready'
       AND (
         offset_record.resume_cutoff_position IS DISTINCT FROM NEW.source_position
         OR offset_record.resume_cutoff_token IS DISTINCT FROM NEW.source_token
       )
     )
     OR (
       offset_record.recovery_state = 'replaying'
       AND offset_record.resume_cutoff_position <= NEW.source_position
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_convergence',
      MESSAGE = 'I03 receipt did not converge with its exact cursor advancement';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER hl7_inbound_recovery_receipt_convergence
AFTER INSERT ON public.hl7_inbound_recovery_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_hl7_inbound_recovery_convergence();

CREATE FUNCTION public.hl7_inbound_recovery_receipt_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_hl7_inbound_recovery_receipt_append_only',
    MESSAGE = 'I03 inbound recovery receipts are append-only';
END;
$$;

CREATE TRIGGER hl7_inbound_recovery_receipt_append_only
BEFORE UPDATE OR DELETE ON public.hl7_inbound_recovery_receipts
FOR EACH ROW EXECUTE FUNCTION public.hl7_inbound_recovery_receipt_append_only();

-- The existing late-effect capability fence did not yet cover the two legacy
-- I03 destination tables. Under late_pending_only, both are hard failures.
CREATE TRIGGER external_recovery_effect_guard_admission
BEFORE INSERT OR UPDATE ON public.admissions
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_investigation
BEFORE INSERT OR UPDATE ON public.investigations
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

-- Section 6.8 RLS posture: one permissive tenant policy is narrowed by an
-- explicit-context restrictive policy. Invalid and default contexts fail shut.
ALTER TABLE public.hl7_inbound_recovery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hl7_inbound_recovery_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.hl7_inbound_recovery_receipts
  AS PERMISSIVE
  USING (
    CASE
      WHEN current_setting('app.current_tenant_id', true) ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND LOWER(current_setting('app.current_tenant_id', true)) <>
          '00000000-0000-4000-8000-000000000001'
      THEN tenant_id = current_setting('app.current_tenant_id', true)::uuid
      ELSE FALSE
    END
  )
  WITH CHECK (
    CASE
      WHEN current_setting('app.current_tenant_id', true) ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND LOWER(current_setting('app.current_tenant_id', true)) <>
          '00000000-0000-4000-8000-000000000001'
      THEN tenant_id = current_setting('app.current_tenant_id', true)::uuid
      ELSE FALSE
    END
  );

CREATE POLICY hl7_inbound_recovery_receipts_explicit_context
  ON public.hl7_inbound_recovery_receipts
  AS RESTRICTIVE
  USING (
    CASE
      WHEN current_setting('app.current_tenant_id', true) ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND LOWER(current_setting('app.current_tenant_id', true)) <>
          '00000000-0000-4000-8000-000000000001'
      THEN tenant_id = current_setting('app.current_tenant_id', true)::uuid
      ELSE FALSE
    END
  )
  WITH CHECK (
    CASE
      WHEN current_setting('app.current_tenant_id', true) ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND LOWER(current_setting('app.current_tenant_id', true)) <>
          '00000000-0000-4000-8000-000000000001'
      THEN tenant_id = current_setting('app.current_tenant_id', true)::uuid
      ELSE FALSE
    END
  );

REVOKE ALL PRIVILEGES
  ON TABLE public.hl7_inbound_recovery_receipts
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.hl7_i03_length_prefixed_sha256(TEXT[])
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.assert_hl7_inbound_recovery_task(
    UUID, INTEGER, BIGINT, UUID, UUID, TEXT
  )
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.validate_hl7_inbound_recovery_receipt()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.validate_hl7_inbound_recovery_convergence()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.hl7_inbound_recovery_receipt_append_only()
  FROM PUBLIC;

DO $hl7_inbound_recovery_bi_privileges$
DECLARE
  readonly_role TEXT;
BEGIN
  FOREACH readonly_role IN ARRAY ARRAY['metabase_readonly', 'vhhealth_readonly']::TEXT[] LOOP
    IF pg_catalog.to_regrole(readonly_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE
      FORMAT(
        'REVOKE ALL PRIVILEGES ON TABLE '
        'public.hl7_inbound_recovery_receipts FROM %I',
        readonly_role
      );
  END LOOP;
END
$hl7_inbound_recovery_bi_privileges$;

DO $hl7_inbound_recovery_runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE FORMAT('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES '
      'ON TABLE public.hl7_inbound_recovery_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON SEQUENCE '
      'public.hl7_inbound_recovery_receipts_id_seq FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'public.hl7_i03_length_prefixed_sha256(TEXT[]) FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'public.assert_hl7_inbound_recovery_task(UUID, INTEGER, BIGINT, UUID, UUID, TEXT) '
      'FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'public.validate_hl7_inbound_recovery_receipt() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'public.validate_hl7_inbound_recovery_convergence() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'public.hl7_inbound_recovery_receipt_append_only() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT ON TABLE public.hl7_inbound_recovery_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT INSERT (
        id, tenant_id, recovery_inbox_id, interface_family,
        signing_credential_id, source_partition, generation, source_position,
        source_token, predecessor_token, duplicate_key, message_family,
        message_type, trigger_event, message_control_id_sha256,
        payload_ciphertext, payload_sha256, payload_bytes, source_observed_at,
        source_received_at, clock_evidence, patient_uid,
        visit_identity_sha256, order_identity_sha256, pending_task_id,
        review_role, status, outcome_code, ack_ciphertext, ack_sha256,
        ack_bytes, ack_code, http_status, policy_version, policy_signature,
        retention_policy, retention_until
      ) ON public.hl7_inbound_recovery_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq TO %I',
      runtime_role
    );
  END LOOP;
END
$hl7_inbound_recovery_runtime_privileges$;

COMMENT ON TABLE public.hl7_inbound_recovery_receipts IS
  'Append-only encrypted terminal I03 ADT/ORM recovery evidence; never a queue or cursor.';

COMMIT;
