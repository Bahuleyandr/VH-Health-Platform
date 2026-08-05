-- 628_external_recovery_operability.sql
-- C6.1 external-recovery activation surface, reliability evidence, and the
-- C-D8 late-critical continuity-awareness acknowledgement channel.
--
-- Section 6.8 posture: all new evidence is non-default-tenant, append-only,
-- protected by FORCE RLS plus an explicit-context restrictive policy, and
-- reachable by runtime roles only through narrow SECURITY DEFINER commands.
-- Same-tenant offset, inbox, task, user, facility, and audit links are
-- relational. Retention identity and cutoff are copied from the exact signed
-- offset/inbox evidence; this migration introduces no retention duration.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_audit_events_tenant_external_recovery
  ON public.clinical_audit_events (tenant_id, id);

CREATE TABLE public.external_recovery_operability_actions (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  facility_scope VARCHAR(16),
  facility_id INTEGER,
  interface_family VARCHAR(8),
  subpath VARCHAR(80),
  protocol VARCHAR(40),
  direction VARCHAR(16),
  source_partition VARCHAR(160),
  generation INTEGER,
  offset_id UUID,
  action VARCHAR(32) NOT NULL,
  command_class VARCHAR(64),
  outcome VARCHAR(32) NOT NULL,
  effect_identity CHAR(64),
  command_fingerprint CHAR(64),
  idempotency_key_sha256 CHAR(64),
  request_id VARCHAR(120),
  http_method VARCHAR(8),
  http_path VARCHAR(255),
  action_version SMALLINT,
  binding_version SMALLINT,
  schema_id VARCHAR(80),
  schema_version SMALLINT,
  schema_checksum CHAR(64),
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  reason_code VARCHAR(80),
  reason_detail VARCHAR(500),
  owner_evidence_reference VARCHAR(255),
  owner_evidence_signature_sha256 CHAR(64),
  policy_version VARCHAR(80),
  policy_signature_sha256 CHAR(64),
  retention_policy VARCHAR(80),
  retention_until TIMESTAMPTZ(6),
  initial_position BIGINT,
  initial_token VARCHAR(255),
  retained_from_position BIGINT,
  retained_from_token VARCHAR(255),
  resume_cutoff_position BIGINT,
  resume_cutoff_token VARCHAR(255),
  expected_state_fingerprint CHAR(64),
  prior_recovery_state VARCHAR(80),
  next_recovery_state VARCHAR(80),
  prior_state JSONB,
  prior_state_hash CHAR(64),
  next_state JSONB,
  next_state_hash CHAR(64),
  clinical_audit_event_id UUID,
  claim_txid BIGINT,
  receipt JSONB NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_external_recovery_action_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_action_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_action_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_action_offset
    FOREIGN KEY (tenant_id, offset_id)
    REFERENCES public.event_consumer_offsets(tenant_id, offset_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_external_recovery_action_audit
    FOREIGN KEY (tenant_id, clinical_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_external_recovery_action_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_external_recovery_action_name
    CHECK (action IN ('register_offset', 'authorize_resume')),
  CONSTRAINT chk_external_recovery_action_outcome
    CHECK (outcome IN (
      'applied', 'refused_stale', 'refused_drift', 'refused_policy',
      'refused_scope', 'infrastructure_failure'
    )),
  CONSTRAINT chk_external_recovery_action_hashes
    CHECK (
      (effect_identity IS NULL OR effect_identity ~ '^[0-9a-f]{64}$')
      AND (command_fingerprint IS NULL OR command_fingerprint ~ '^[0-9a-f]{64}$')
      AND (idempotency_key_sha256 IS NULL OR idempotency_key_sha256 ~ '^[0-9a-f]{64}$')
      AND (schema_checksum IS NULL OR schema_checksum ~ '^[0-9a-f]{64}$')
      AND (owner_evidence_signature_sha256 IS NULL
        OR owner_evidence_signature_sha256 ~ '^[0-9a-f]{64}$')
      AND (policy_signature_sha256 IS NULL
        OR policy_signature_sha256 ~ '^[0-9a-f]{64}$')
      AND (expected_state_fingerprint IS NULL
        OR expected_state_fingerprint ~ '^[0-9a-f]{64}$')
      AND (prior_state_hash IS NULL OR prior_state_hash ~ '^[0-9a-f]{64}$')
      AND (next_state_hash IS NULL OR next_state_hash ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT chk_external_recovery_action_scope
    CHECK (
      (facility_scope IS NULL AND facility_id IS NULL)
      OR (facility_scope = 'tenant' AND facility_id IS NULL)
      OR (facility_scope = 'facility' AND facility_id IS NOT NULL)
    ),
  CONSTRAINT chk_external_recovery_action_markers
    CHECK (
      (initial_position IS NULL) = (initial_token IS NULL)
      AND (retained_from_position IS NULL) = (retained_from_token IS NULL)
      AND (resume_cutoff_position IS NULL) = (resume_cutoff_token IS NULL)
      AND COALESCE(initial_position, 0) >= 0
      AND COALESCE(retained_from_position, 0) >= 0
      AND COALESCE(resume_cutoff_position, 0) >= 0
    ),
  CONSTRAINT chk_external_recovery_action_reason
    CHECK (
      reason_detail IS NULL
      OR (
        CHAR_LENGTH(BTRIM(reason_detail)) BETWEEN 10 AND 500
        AND reason_detail !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT chk_external_recovery_action_applied_shape
    CHECK (
      (
        outcome = 'applied'
        AND facility_scope IS NOT NULL
        AND interface_family IN (
          'I01', 'I02', 'I04', 'I05', 'I06', 'I09', 'I10', 'I13',
          'I15', 'I16', 'I17', 'I18', 'I19', 'I23', 'I25'
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
    ),
  CONSTRAINT chk_external_recovery_action_class
    CHECK (
      outcome <> 'applied'
      OR (
        action = 'register_offset'
        AND command_class IN ('register_paused_offset', 'register_marker_absent_offset')
        AND prior_recovery_state IS NULL
        AND next_recovery_state IN ('paused', 'reconciliation_required_missing_marker')
        AND prior_state IS NULL
        AND prior_state_hash IS NULL
        AND resume_cutoff_position IS NULL
        AND expected_state_fingerprint IS NULL
      )
      OR (
        action = 'authorize_resume'
        AND command_class = 'authorize_partition_resume'
        AND prior_recovery_state = 'paused'
        AND next_recovery_state = 'replaying'
        AND prior_state IS NOT NULL
        AND prior_state_hash IS NOT NULL
        AND resume_cutoff_position IS NOT NULL
        AND expected_state_fingerprint IS NOT NULL
        AND expected_state_fingerprint = prior_state_hash
      )
    )
);

CREATE UNIQUE INDEX uq_external_recovery_action_applied_effect
  ON public.external_recovery_operability_actions (tenant_id, effect_identity)
  WHERE outcome = 'applied';

CREATE UNIQUE INDEX uq_external_recovery_action_applied_idempotency
  ON public.external_recovery_operability_actions (tenant_id, idempotency_key_sha256)
  WHERE outcome = 'applied';

CREATE UNIQUE INDEX uq_external_recovery_action_registration_offset
  ON public.external_recovery_operability_actions (tenant_id, offset_id)
  WHERE outcome = 'applied' AND action = 'register_offset';

CREATE INDEX idx_external_recovery_action_workbench
  ON public.external_recovery_operability_actions
    (tenant_id, interface_family, direction, source_partition, recorded_at DESC);

ALTER TABLE public.event_consumer_offsets
  ADD COLUMN registration_operability_action_id UUID,
  ADD COLUMN resume_operability_action_id UUID,
  ADD CONSTRAINT fk_event_consumer_offset_registration_action
    FOREIGN KEY (tenant_id, registration_operability_action_id)
    REFERENCES public.external_recovery_operability_actions(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_event_consumer_offset_resume_action
    FOREIGN KEY (tenant_id, resume_operability_action_id)
    REFERENCES public.external_recovery_operability_actions(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.external_recovery_critical_review_obligations (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  facility_scope VARCHAR(16) NOT NULL,
  facility_id INTEGER,
  interface_family VARCHAR(8) NOT NULL,
  recovery_inbox_id UUID NOT NULL,
  offset_id UUID NOT NULL,
  task_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  critical_result_ids INTEGER[] NOT NULL,
  result_set_hash CHAR(64) NOT NULL,
  source_occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  recipient_class VARCHAR(64) NOT NULL,
  effect_disposition VARCHAR(32) NOT NULL,
  contract VARCHAR(80) NOT NULL,
  contract_version SMALLINT NOT NULL,
  policy_version VARCHAR(80) NOT NULL,
  policy_signature VARCHAR(128) NOT NULL,
  retention_policy VARCHAR(80) NOT NULL,
  retention_until TIMESTAMPTZ(6) NOT NULL,
  receipt JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_external_recovery_critical_obligation_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_obligation_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_obligation_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, interface_family)
    REFERENCES public.pathway_projector_inbox(tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_obligation_offset
    FOREIGN KEY (tenant_id, offset_id)
    REFERENCES public.event_consumer_offsets(tenant_id, offset_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_obligation_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES public.tasks(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_external_recovery_critical_obligation_inbox
    UNIQUE (tenant_id, recovery_inbox_id, interface_family),
  CONSTRAINT chk_external_recovery_critical_obligation_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_external_recovery_critical_obligation_scope
    CHECK (
      (facility_scope = 'tenant' AND facility_id IS NULL)
      OR (facility_scope = 'facility' AND facility_id IS NOT NULL)
    ),
  CONSTRAINT chk_external_recovery_critical_obligation_shape
    CHECK (
      interface_family IN ('I01', 'I02')
      AND cardinality(critical_result_ids) > 0
      AND result_set_hash ~ '^[0-9a-f]{64}$'
      AND source_occurred_at <= recorded_at
      AND recipient_class = 'DUTY_DOCTOR'
      AND effect_disposition = 'late_pending_only'
      AND contract = 'late_pending_only'
      AND contract_version = 1
      AND NULLIF(BTRIM(policy_version), '') IS NOT NULL
      AND NULLIF(BTRIM(policy_signature), '') IS NOT NULL
      AND NULLIF(BTRIM(retention_policy), '') IS NOT NULL
      AND retention_until >= recorded_at
    )
);

CREATE UNIQUE INDEX uq_external_recovery_critical_obligation_task
  ON public.external_recovery_critical_review_obligations (tenant_id, task_id);

CREATE INDEX idx_external_recovery_critical_obligation_open
  ON public.external_recovery_critical_review_obligations
    (tenant_id, offset_id, recorded_at);

CREATE TABLE public.external_recovery_critical_review_acknowledgements (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  obligation_id UUID NOT NULL,
  task_id INTEGER NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  authorization_mode VARCHAR(32) NOT NULL,
  task_acknowledged_at TIMESTAMPTZ(6) NOT NULL,
  request_id VARCHAR(120),
  receipt_hash CHAR(64) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  policy_version VARCHAR(80) NOT NULL,
  policy_signature VARCHAR(128) NOT NULL,
  retention_policy VARCHAR(80) NOT NULL,
  retention_until TIMESTAMPTZ(6) NOT NULL,
  receipt JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_external_recovery_critical_ack_obligation
    UNIQUE (tenant_id, obligation_id),
  CONSTRAINT fk_external_recovery_critical_ack_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_ack_obligation
    FOREIGN KEY (tenant_id, obligation_id)
    REFERENCES public.external_recovery_critical_review_obligations(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_ack_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES public.tasks(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_external_recovery_critical_ack_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_external_recovery_critical_ack_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_external_recovery_critical_ack_shape
    CHECK (
      actor_role = UPPER(BTRIM(actor_role))
      AND authorization_mode IN ('assignee', 'role', 'admin', 'override')
      AND receipt_hash ~ '^[0-9a-f]{64}$'
      AND task_acknowledged_at <= recorded_at
      AND NULLIF(BTRIM(policy_version), '') IS NOT NULL
      AND NULLIF(BTRIM(policy_signature), '') IS NOT NULL
      AND NULLIF(BTRIM(retention_policy), '') IS NOT NULL
      AND retention_until >= recorded_at
    )
);

CREATE UNIQUE INDEX uq_external_recovery_critical_ack_task
  ON public.external_recovery_critical_review_acknowledgements (tenant_id, task_id);

CREATE INDEX idx_external_recovery_critical_ack_actor
  ON public.external_recovery_critical_review_acknowledgements
    (tenant_id, actor_uid, recorded_at DESC);

ALTER TABLE public.external_recovery_operability_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_recovery_operability_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.external_recovery_critical_review_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_recovery_critical_review_obligations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.external_recovery_critical_review_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_recovery_critical_review_acknowledgements FORCE ROW LEVEL SECURITY;

DO $external_recovery_rls$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'external_recovery_operability_actions',
    'external_recovery_critical_review_obligations',
    'external_recovery_critical_review_acknowledgements'
  ]
  LOOP
    EXECUTE FORMAT(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE '
      'USING (tenant_id = public.app_current_tenant_id_uuid()) '
      'WITH CHECK (tenant_id = public.app_current_tenant_id_uuid())',
      relation_name
    );
    EXECUTE FORMAT(
      'CREATE POLICY external_recovery_explicit_tenant ON public.%I AS RESTRICTIVE '
      'USING ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) <> '''''
      ' AND current_setting(''app.current_tenant_id'', true) <> ''bypass'''
      ' AND current_setting(''app.current_tenant_id'', true) '
      '     ~ ''^[0-9a-fA-F-]{36}$'''
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ') WITH CHECK ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) <> '''''
      ' AND current_setting(''app.current_tenant_id'', true) <> ''bypass'''
      ' AND current_setting(''app.current_tenant_id'', true) '
      '     ~ ''^[0-9a-fA-F-]{36}$'''
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ')',
      relation_name
    );
  END LOOP;
END
$external_recovery_rls$;

CREATE FUNCTION public.external_recovery_evidence_owner_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  relation_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;
  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'external-recovery evidence requires its dedicated command';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.external_recovery_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_external_recovery_evidence_append_only',
    MESSAGE = 'external-recovery evidence is append-only';
END;
$$;

CREATE FUNCTION public.external_recovery_operability_bound_hash(values_to_bind TEXT[])
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(
    public.digest(
      convert_to(
        string_agg(
          CASE
            WHEN value IS NULL THEN 'N;'
            ELSE 'V' || octet_length(value)::text || ':' || value || ';'
          END,
          '' ORDER BY ordinal
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )::char(64)
    FROM unnest(values_to_bind) WITH ORDINALITY AS bound(value, ordinal)
$$;

CREATE TRIGGER external_recovery_action_insert_guard
BEFORE INSERT ON public.external_recovery_operability_actions
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_evidence_owner_only();

CREATE TRIGGER external_recovery_obligation_insert_guard
BEFORE INSERT ON public.external_recovery_critical_review_obligations
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_evidence_owner_only();

CREATE TRIGGER external_recovery_ack_insert_guard
BEFORE INSERT ON public.external_recovery_critical_review_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_evidence_owner_only();

CREATE TRIGGER external_recovery_action_append_only
BEFORE UPDATE OR DELETE ON public.external_recovery_operability_actions
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_evidence_append_only();

CREATE TRIGGER external_recovery_obligation_append_only
BEFORE UPDATE OR DELETE ON public.external_recovery_critical_review_obligations
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_evidence_append_only();

CREATE TRIGGER external_recovery_ack_append_only
BEFORE UPDATE OR DELETE ON public.external_recovery_critical_review_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_evidence_append_only();

CREATE FUNCTION public.external_recovery_operability_offset_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  action_id UUID := NULLIF(
    current_setting('app.external_recovery_operability_action_id', true), ''
  )::uuid;
  active_role_name NAME := NULLIF(current_setting('role', true), 'none')::name;
  invoker_name NAME;
  relation_owner NAME;
  owner_invocation BOOLEAN;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;
  invoker_name := COALESCE(active_role_name, session_user::name);
  owner_invocation := invoker_name = relation_owner;

  IF TG_OP = 'INSERT' THEN
    IF NEW.scope_kind <> 'external_interface' THEN
      RETURN NEW;
    END IF;
    -- A relation owner can already alter/disable a trigger and remains the
    -- migration/fixture authority. Runtime roles, including SET LOCAL ROLE
    -- from an owner connection, must present the exact immutable command.
    IF owner_invocation THEN
      RETURN NEW;
    END IF;
    IF action_id IS NULL OR NEW.registration_operability_action_id IS DISTINCT FROM action_id
       OR NOT EXISTS (
         SELECT 1
           FROM public.external_recovery_operability_actions AS action
          WHERE action.tenant_id = NEW.tenant_id
            AND action.id = action_id
            AND action.offset_id = NEW.offset_id
            AND action.action = 'register_offset'
            AND action.outcome = 'applied'
            AND action.claim_txid = txid_current()
            AND action.facility_scope = NEW.facility_scope
            AND action.facility_id IS NOT DISTINCT FROM NEW.facility_id
            AND action.interface_family = NEW.interface_family
            AND action.direction = NEW.direction
            AND action.source_partition = NEW.source_partition
            AND action.generation = NEW.generation
            AND action.initial_position IS NOT DISTINCT FROM NEW.high_water_position
            AND action.initial_token IS NOT DISTINCT FROM NEW.high_water_token
            AND action.retained_from_position IS NOT DISTINCT FROM NEW.retained_from_position
            AND action.retained_from_token IS NOT DISTINCT FROM NEW.retained_from_token
            AND action.next_recovery_state = NEW.recovery_state
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'initial external-recovery offset requires an applied exact-item command';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.registration_operability_action_id IS NOT NULL
       OR OLD.resume_operability_action_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_external_recovery_offset_action_binding_immutable',
        MESSAGE = 'external-recovery operator binding is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.registration_operability_action_id IS DISTINCT FROM OLD.registration_operability_action_id
     OR (
       OLD.resume_operability_action_id IS NOT NULL
       AND NEW.resume_operability_action_id IS DISTINCT FROM OLD.resume_operability_action_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_external_recovery_offset_action_binding_immutable',
      MESSAGE = 'external-recovery operator binding is immutable';
  END IF;

  IF OLD.scope_kind = 'external_interface'
     AND OLD.recovery_state = 'paused'
     AND (
       NEW.recovery_state = 'replaying'
       OR NEW.resume_cutoff_position IS DISTINCT FROM OLD.resume_cutoff_position
       OR NEW.resume_cutoff_token IS DISTINCT FROM OLD.resume_cutoff_token
     ) THEN
    IF owner_invocation THEN
      RETURN NEW;
    END IF;
    IF action_id IS NULL OR NEW.resume_operability_action_id IS DISTINCT FROM action_id
       OR NOT EXISTS (
         SELECT 1
           FROM public.external_recovery_operability_actions AS action
          WHERE action.tenant_id = NEW.tenant_id
            AND action.id = action_id
            AND action.offset_id = NEW.offset_id
            AND action.action = 'authorize_resume'
            AND action.outcome = 'applied'
            AND action.claim_txid = txid_current()
            AND action.interface_family = NEW.interface_family
            AND action.direction = NEW.direction
            AND action.source_partition = NEW.source_partition
            AND action.generation = NEW.generation
            AND action.prior_recovery_state = OLD.recovery_state
            AND action.next_recovery_state = NEW.recovery_state
            AND action.resume_cutoff_position = NEW.resume_cutoff_position
            AND action.resume_cutoff_token = NEW.resume_cutoff_token
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'paused external-recovery offset requires an applied exact resume command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_recovery_operability_offset_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.event_consumer_offsets
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_operability_offset_guard();

CREATE FUNCTION public.external_recovery_operability_register_offset(p_command JSONB)
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
       'I01', 'I02', 'I04', 'I05', 'I06', 'I09', 'I10', 'I13',
       'I15', 'I16', 'I17', 'I18', 'I19', 'I23', 'I25'
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

CREATE FUNCTION public.external_recovery_operability_authorize_resume(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  action_id UUID := (p_command ->> 'action_id')::uuid;
  target_offset UUID := (p_command ->> 'offset_id')::uuid;
  current_actor_role TEXT;
  cutoff_position BIGINT := (p_command ->> 'resume_cutoff_position')::bigint;
  offset_row public.event_consumer_offsets%ROWTYPE;
  existing public.external_recovery_operability_actions%ROWTYPE;
  registration public.external_recovery_operability_actions%ROWTYPE;
  audit_record public.clinical_audit_events%ROWTYPE;
  prior_hash TEXT := p_command ->> 'expected_state_fingerprint';
  prior_state JSONB := p_command -> 'prior_state';
  next_state JSONB := p_command -> 'next_state';
  expected_prior_state JSONB;
  expected_next_state JSONB;
  expected_prior_hash TEXT;
  expected_effect_hash TEXT;
  expected_command_hash TEXT;
  next_hash TEXT;
  stored_receipt JSONB;
  changed INTEGER;
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

  IF p_command ->> 'action' <> 'authorize_resume'
     OR p_command ->> 'command_class' <> 'authorize_partition_resume'
     OR p_command ->> 'effect_identity' !~ '^[0-9a-f]{64}$'
     OR p_command ->> 'command_fingerprint' !~ '^[0-9a-f]{64}$'
     OR p_command ->> 'idempotency_key_sha256' !~ '^[0-9a-f]{64}$'
     OR prior_hash !~ '^[0-9a-f]{64}$'
     OR p_command ->> 'schema_checksum' <>
        '24a67d423bc118a6aaf1f46e47d86cd6e8e36a2c0ec1bca0378685824e649dc5'
     OR p_command ->> 'schema_id' <> 'external-recovery-operability'
     OR (p_command ->> 'schema_version')::integer <> 1
     OR (p_command ->> 'action_version')::integer <> 1
     OR (p_command ->> 'binding_version')::integer <> 1
     OR cutoff_position < 0
     OR NULLIF(BTRIM(p_command ->> 'resume_cutoff_token'), '') IS NULL
     OR p_command ->> 'reason_code' NOT IN (
       'resume_cutoff_reconciled', 'source_count_reconciled',
       'owner_recovery_evidence_reconciled'
     )
     OR CHAR_LENGTH(BTRIM(p_command ->> 'reason_detail')) NOT BETWEEN 10 AND 500
     OR p_command ->> 'reason_detail' ~ '[[:cntrl:]]'
     OR encode(public.digest(convert_to(p_command ->> 'owner_evidence_signature', 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM p_command ->> 'owner_evidence_signature_sha256'
     OR prior_state IS NULL OR jsonb_typeof(prior_state) <> 'object'
     OR next_state IS NULL OR jsonb_typeof(next_state) <> 'object'
     OR next_state ->> 'recovery_state' <> 'replaying'
     OR next_state ->> 'reconciliation_reason' IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resume command evidence is invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant::text || ':' || target_offset::text, 628)
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
       AND existing.action = 'authorize_resume'
       AND existing.outcome = 'applied'
       AND existing.effect_identity = p_command ->> 'effect_identity'
       AND existing.command_fingerprint = p_command ->> 'command_fingerprint'
       AND existing.actor_uid = actor
       AND existing.actor_role = current_actor_role
       AND existing.offset_id = target_offset THEN
      RETURN jsonb_set(existing.receipt, '{disposition}', '"exact_duplicate"'::jsonb);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'external-recovery resume identity drift';
  END IF;

  SELECT * INTO offset_row
    FROM public.event_consumer_offsets
   WHERE tenant_id = tenant AND offset_id = target_offset
     AND scope_kind = 'external_interface'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'external-recovery offset was not found';
  END IF;
  SELECT * INTO registration
    FROM public.external_recovery_operability_actions
   WHERE tenant_id = tenant
     AND id = offset_row.registration_operability_action_id
     AND offset_id = target_offset
     AND action = 'register_offset'
     AND outcome = 'applied'
   FOR SHARE;

  expected_prior_state := jsonb_build_object(
    'tenant_id', offset_row.tenant_id::text,
    'offset_id', offset_row.offset_id::text,
    'facility_scope', offset_row.facility_scope,
    'facility_id', offset_row.facility_id,
    'interface_family', offset_row.interface_family,
    'direction', offset_row.direction,
    'source_partition', offset_row.source_partition,
    'generation', offset_row.generation,
    'high_water_position', offset_row.high_water_position::text,
    'high_water_token', offset_row.high_water_token,
    'retained_from_position', offset_row.retained_from_position::text,
    'retained_from_token', offset_row.retained_from_token,
    'resume_cutoff_position', offset_row.resume_cutoff_position::text,
    'resume_cutoff_token', offset_row.resume_cutoff_token,
    'recovery_state', offset_row.recovery_state,
    'reconciliation_reason', offset_row.reconciliation_reason,
    'policy_version', offset_row.policy_version,
    'retention_policy', offset_row.retention_policy,
    'retention_until', offset_row.retention_until::text,
    'intake_retired_at', offset_row.intake_retired_at::text
  );
  expected_prior_hash := public.external_recovery_operability_bound_hash(ARRAY[
    offset_row.tenant_id::text,
    offset_row.offset_id::text,
    offset_row.facility_scope,
    offset_row.facility_id::text,
    offset_row.interface_family,
    offset_row.direction,
    offset_row.source_partition,
    offset_row.generation::text,
    offset_row.high_water_position::text,
    offset_row.high_water_token,
    offset_row.retained_from_position::text,
    offset_row.retained_from_token,
    offset_row.resume_cutoff_position::text,
    offset_row.resume_cutoff_token,
    offset_row.recovery_state,
    offset_row.reconciliation_reason,
    offset_row.policy_version,
    offset_row.retention_policy,
    offset_row.retention_until::text,
    offset_row.intake_retired_at::text
  ]);
  expected_next_state := expected_prior_state || jsonb_build_object(
    'recovery_state', 'replaying',
    'reconciliation_reason', NULL,
    'resume_cutoff_position', cutoff_position::text,
    'resume_cutoff_token', p_command ->> 'resume_cutoff_token'
  );
  next_hash := public.external_recovery_operability_bound_hash(ARRAY[
    offset_row.tenant_id::text,
    offset_row.offset_id::text,
    offset_row.facility_scope,
    offset_row.facility_id::text,
    offset_row.interface_family,
    offset_row.direction,
    offset_row.source_partition,
    offset_row.generation::text,
    offset_row.high_water_position::text,
    offset_row.high_water_token,
    offset_row.retained_from_position::text,
    offset_row.retained_from_token,
    cutoff_position::text,
    p_command ->> 'resume_cutoff_token',
    'replaying',
    NULL,
    offset_row.policy_version,
    offset_row.retention_policy,
    offset_row.retention_until::text,
    offset_row.intake_retired_at::text
  ]);
  expected_effect_hash := public.external_recovery_operability_bound_hash(ARRAY[
    'authorize_resume',
    '1',
    '1',
    'external-recovery-operability',
    '1',
    tenant::text,
    target_offset::text,
    offset_row.facility_scope,
    offset_row.facility_id::text,
    offset_row.interface_family,
    offset_row.direction,
    offset_row.source_partition,
    offset_row.generation::text,
    expected_prior_hash,
    cutoff_position::text,
    p_command ->> 'resume_cutoff_token',
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
    '/api/v1/admin/continuity/external-recovery/offsets/'
      || target_offset::text || '/resume-authorizations',
    expected_prior_hash,
    next_hash
  ]);
  IF NOT FOUND
     OR offset_row.recovery_state <> 'paused'
     OR offset_row.high_water_position IS NULL
     OR offset_row.high_water_token IS NULL
     OR offset_row.intake_retired_at IS NOT NULL
     OR cutoff_position < offset_row.high_water_position
     OR p_command ->> 'interface_family' IS DISTINCT FROM offset_row.interface_family
     OR p_command ->> 'direction' IS DISTINCT FROM offset_row.direction
     OR p_command ->> 'source_partition' IS DISTINCT FROM offset_row.source_partition
     OR (p_command ->> 'generation')::integer IS DISTINCT FROM offset_row.generation
     OR p_command ->> 'facility_scope' IS DISTINCT FROM offset_row.facility_scope
     OR NULLIF(p_command ->> 'facility_id', '')::integer
        IS DISTINCT FROM offset_row.facility_id
     OR prior_state IS DISTINCT FROM expected_prior_state
     OR prior_hash IS DISTINCT FROM expected_prior_hash
     OR next_state IS DISTINCT FROM expected_next_state
     OR p_command ->> 'effect_identity' IS DISTINCT FROM expected_effect_hash
     OR p_command ->> 'command_fingerprint' IS DISTINCT FROM expected_command_hash THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'external-recovery resume state drifted';
  END IF;
  SELECT * INTO audit_record
    FROM public.clinical_audit_events AS audit
   WHERE audit.tenant_id = tenant
     AND audit.id = (p_command ->> 'audit_event_id')::uuid
     AND audit.action = 'external_recovery.offset.resume_authorized'
     AND audit.action_status = 'success'
     AND audit.actor_uid = actor
     AND UPPER(BTRIM(audit.actor_role)) = current_actor_role
     AND audit.resource_type = 'external_recovery_operability_action'
     AND audit.resource_table = 'external_recovery_operability_actions'
     AND audit.resource_id = action_id::text
     AND audit.before_state = prior_state
     AND audit.after_state ->> 'action_id' = action_id::text
     AND audit.after_state ->> 'effect_identity' = p_command ->> 'effect_identity'
     AND audit.after_state ->> 'command_fingerprint' = p_command ->> 'command_fingerprint'
     AND audit.after_state ->> 'recovery_state' = 'replaying'
     AND (audit.after_state ->> 'worker_started')::boolean IS FALSE
     AND (audit.after_state ->> 'cursor_advanced')::boolean IS FALSE
     AND audit.idempotency_key = 'external-recovery-resume:' || (p_command ->> 'effect_identity')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resume clinical audit evidence is invalid';
  END IF;

  stored_receipt := jsonb_build_object(
    'disposition', 'applied',
    'action_id', action_id,
    'offset_id', target_offset,
    'tenant_id', tenant,
    'interface_family', offset_row.interface_family,
    'direction', offset_row.direction,
    'source_partition', offset_row.source_partition,
    'generation', offset_row.generation,
    'recovery_state', 'replaying',
    'resume_cutoff_position', cutoff_position,
    'resume_cutoff_token', p_command ->> 'resume_cutoff_token',
    'worker_started', FALSE,
    'cursor_advanced', FALSE
  );

  INSERT INTO public.external_recovery_operability_actions (
    id, tenant_id, facility_scope, facility_id, interface_family, subpath,
    protocol, direction, source_partition, generation, offset_id, action,
    command_class, outcome, effect_identity, command_fingerprint,
    idempotency_key_sha256, request_id, http_method, http_path, action_version,
    binding_version, schema_id, schema_version, schema_checksum, actor_uid,
    actor_role, reason_code, reason_detail, owner_evidence_reference,
    owner_evidence_signature_sha256, policy_version, policy_signature_sha256,
    retention_policy, retention_until, resume_cutoff_position,
    resume_cutoff_token, expected_state_fingerprint, prior_recovery_state,
    next_recovery_state, prior_state, prior_state_hash, next_state,
    next_state_hash, clinical_audit_event_id, claim_txid, receipt
  ) VALUES (
    action_id, tenant, offset_row.facility_scope, offset_row.facility_id,
    offset_row.interface_family, registration.subpath, registration.protocol,
    offset_row.direction, offset_row.source_partition, offset_row.generation,
    target_offset, 'authorize_resume', 'authorize_partition_resume', 'applied',
    p_command ->> 'effect_identity', p_command ->> 'command_fingerprint',
    p_command ->> 'idempotency_key_sha256', NULLIF(p_command ->> 'request_id', ''),
    'POST', '/api/v1/admin/continuity/external-recovery/offsets/'
      || target_offset::text || '/resume-authorizations', 1, 1,
    'external-recovery-operability', 1, p_command ->> 'schema_checksum', actor,
    current_actor_role, p_command ->> 'reason_code', p_command ->> 'reason_detail',
    p_command ->> 'owner_evidence_reference',
    p_command ->> 'owner_evidence_signature_sha256', offset_row.policy_version,
    encode(public.digest(convert_to(offset_row.policy_signature, 'UTF8'), 'sha256'), 'hex'),
    offset_row.retention_policy, offset_row.retention_until, cutoff_position,
    p_command ->> 'resume_cutoff_token', prior_hash, 'paused', 'replaying',
    prior_state, prior_hash, next_state, next_hash, audit_record.id,
    txid_current(), stored_receipt
  );

  PERFORM set_config('app.external_recovery_operability_action_id', action_id::text, true);
  UPDATE public.event_consumer_offsets
     SET resume_cutoff_position = cutoff_position,
         resume_cutoff_token = p_command ->> 'resume_cutoff_token',
         recovery_state = 'replaying',
         reconciliation_reason = NULL,
         resume_operability_action_id = action_id,
         updated_at = clock_timestamp()
   WHERE tenant_id = tenant AND offset_id = target_offset
     AND scope_kind = 'external_interface'
     AND recovery_state = 'paused'
     AND high_water_position IS NOT NULL
     AND high_water_token IS NOT NULL
     AND cutoff_position >= high_water_position;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'external-recovery resume compare-and-swap failed';
  END IF;

  RETURN stored_receipt;
END;
$$;

CREATE FUNCTION public.external_recovery_operability_record_refusal(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := public.app_current_tenant_id_uuid();
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  current_actor_role TEXT;
  refusal_id UUID;
  refusal_receipt JSONB;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR tenant = '00000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit non-default tenant context required';
  END IF;
  SELECT UPPER(BTRIM(role)) INTO current_actor_role
    FROM public.users
   WHERE tenant_id = tenant AND uid = actor
     AND is_active AND NOT is_deleted AND status = 'active'
   FOR SHARE;
  IF current_actor_role NOT IN ('ADMIN', 'SUPER_ADMIN')
     OR current_actor_role IS DISTINCT FROM UPPER(BTRIM(p_command ->> 'actor_role'))
     OR p_command ->> 'action' NOT IN ('register_offset', 'authorize_resume')
     OR p_command ->> 'outcome' NOT IN (
       'refused_stale', 'refused_drift', 'refused_policy',
       'refused_scope', 'infrastructure_failure'
     )
     OR NULLIF(BTRIM(p_command ->> 'refusal_code'), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authenticated refusal evidence denied';
  END IF;
  refusal_id := gen_random_uuid();
  refusal_receipt := jsonb_build_object(
    'id', refusal_id,
    'disposition', p_command ->> 'outcome',
    'action', p_command ->> 'action',
    'refusal_code', LEFT(p_command ->> 'refusal_code', 120),
    'actor_uid', actor,
    'actor_role', current_actor_role,
    'recorded_at', clock_timestamp()
  );
  INSERT INTO public.external_recovery_operability_actions (
    id, tenant_id, action, outcome, request_id, actor_uid, actor_role, receipt
  ) VALUES (
    refusal_id, tenant, p_command ->> 'action', p_command ->> 'outcome',
    NULLIF(p_command ->> 'request_id', ''), actor, current_actor_role, refusal_receipt
  );
  RETURN refusal_receipt;
END;
$$;

CREATE FUNCTION public.external_recovery_critical_review_obligation_append(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  target_obligation_id UUID := (p_command ->> 'id')::uuid;
  target_inbox_id UUID := (p_command ->> 'recovery_inbox_id')::uuid;
  target_task INTEGER := (p_command ->> 'task_id')::integer;
  patient UUID := (p_command ->> 'patient_uid')::uuid;
  family TEXT := p_command ->> 'interface_family';
  ordered_result_ids INTEGER[];
  inbox public.pathway_projector_inbox%ROWTYPE;
  offset_row public.event_consumer_offsets%ROWTYPE;
  task_row public.tasks%ROWTYPE;
  existing public.external_recovery_critical_review_obligations%ROWTYPE;
  result_hash TEXT;
  obligation_receipt JSONB;
  linked_ids INTEGER[];
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM tenant
     OR tenant = '00000000-0000-4000-8000-000000000001'::uuid
     OR family NOT IN ('I01', 'I02')
     OR p_command ->> 'contract' <> 'late_pending_only'
     OR (p_command ->> 'contract_version')::integer <> 1
     OR p_command ->> 'recipient_class' <> 'DUTY_DOCTOR' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'late-critical obligation context denied';
  END IF;
  SELECT COALESCE(array_agg(value::integer ORDER BY value::integer), '{}'::integer[])
    INTO ordered_result_ids
    FROM jsonb_array_elements_text(p_command -> 'critical_result_ids') AS result(value);
  IF cardinality(ordered_result_ids) = 0
     OR cardinality(ordered_result_ids) <>
        cardinality(ARRAY(SELECT DISTINCT unnest(ordered_result_ids))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'critical result identity is invalid';
  END IF;

  SELECT * INTO existing
    FROM public.external_recovery_critical_review_obligations
   WHERE tenant_id = tenant
     AND (id = target_obligation_id OR recovery_inbox_id = target_inbox_id OR task_id = target_task)
   ORDER BY recorded_at
   LIMIT 1
   FOR SHARE;
  IF FOUND THEN
    IF existing.id = target_obligation_id
       AND existing.recovery_inbox_id = target_inbox_id
       AND existing.task_id = target_task
       AND existing.patient_uid = patient
       AND existing.interface_family = family
       AND existing.critical_result_ids = ordered_result_ids THEN
      RETURN existing.receipt;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'late-critical obligation identity drift';
  END IF;

  SELECT * INTO inbox
    FROM public.pathway_projector_inbox
   WHERE tenant_id = tenant AND pathway_projector_inbox.inbox_id = target_inbox_id
     AND scope_kind = 'external_interface'
     AND interface_family = family
     AND arrival_class = 'recovery_backlog'
     AND effect_disposition = 'late_pending_only'
     AND status IN ('pending', 'processing')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'late-critical recovery inbox binding is invalid';
  END IF;
  SELECT * INTO offset_row
    FROM public.event_consumer_offsets
   WHERE tenant_id = tenant AND offset_id = inbox.offset_id
     AND scope_kind = 'external_interface'
     AND interface_family = family
     AND recovery_state = 'replaying'
   FOR SHARE;
  SELECT * INTO task_row
    FROM public.tasks
   WHERE tenant_id = tenant AND id = target_task
     AND patient_uid = patient
     AND priority = 'critical'
     AND assigned_to_uid IS NULL
     AND assigned_to_role = 'DUTY_DOCTOR'
     AND due_at IS NULL
     AND workflow_sla_instance_id IS NULL
     AND sla_completion_semantics = 'none'
     AND metadata ->> 'contract' = 'late_pending_only'
     AND metadata ->> 'interface_family' = family
     AND metadata ->> 'recovery_inbox_id' = target_inbox_id::text
     AND metadata -> 'critical_result_ids' = to_jsonb(ordered_result_ids)
   FOR SHARE;
  IF offset_row.offset_id IS NULL OR task_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'late-critical human channel binding is invalid';
  END IF;

  IF family = 'I01' THEN
    SELECT array_agg(result.id ORDER BY result.id) INTO linked_ids
      FROM public.lab_results AS result
      JOIN public.lab_oru_ingest_messages AS message
        ON message.tenant_id = result.tenant_id
       AND message.id = result.oru_ingest_message_id
     WHERE result.tenant_id = tenant
       AND result.id = ANY(ordered_result_ids)
       AND result.patient_uid = patient
       AND result.is_critical
       AND message.recovery_inbox_id = target_inbox_id
       AND message.recovery_interface_family = 'I01';
  ELSE
    SELECT array_agg(result.id ORDER BY result.id) INTO linked_ids
      FROM public.lab_results AS result
      JOIN public.lab_interface_messages AS message
        ON message.tenant_id = result.tenant_id
       AND message.id = result.interface_message_id
     WHERE result.tenant_id = tenant
       AND result.id = ANY(ordered_result_ids)
       AND result.patient_uid = patient
       AND result.is_critical
       AND message.recovery_inbox_id = target_inbox_id
       AND message.recovery_interface_family = 'I02';
  END IF;
  IF linked_ids IS DISTINCT FROM ordered_result_ids THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'critical result set is not source-bound';
  END IF;

  result_hash := encode(
    public.digest(convert_to(to_jsonb(ordered_result_ids)::text, 'UTF8'), 'sha256'),
    'hex'
  );
  obligation_receipt := jsonb_build_object(
    'id', target_obligation_id,
    'tenant_id', tenant,
    'facility_scope', offset_row.facility_scope,
    'facility_id', offset_row.facility_id,
    'interface_family', family,
    'recovery_inbox_id', target_inbox_id,
    'offset_id', offset_row.offset_id,
    'task_id', target_task,
    'patient_uid', patient,
    'critical_result_ids', to_jsonb(ordered_result_ids),
    'source_occurred_at', (p_command ->> 'source_occurred_at')::timestamptz,
    'recipient_class', 'DUTY_DOCTOR',
    'acknowledgement_required', TRUE
  );
  INSERT INTO public.external_recovery_critical_review_obligations (
    id, tenant_id, facility_scope, facility_id, interface_family,
    recovery_inbox_id, offset_id, task_id, patient_uid, critical_result_ids,
    result_set_hash, source_occurred_at, recipient_class, effect_disposition,
    contract, contract_version, policy_version, policy_signature,
    retention_policy, retention_until, receipt
  ) VALUES (
    target_obligation_id, tenant, offset_row.facility_scope, offset_row.facility_id,
    family, target_inbox_id, offset_row.offset_id, target_task, patient,
    ordered_result_ids,
    result_hash, (p_command ->> 'source_occurred_at')::timestamptz,
    'DUTY_DOCTOR', 'late_pending_only', 'late_pending_only', 1,
    offset_row.policy_version, offset_row.policy_signature,
    offset_row.retention_policy, offset_row.retention_until, obligation_receipt
  );
  RETURN obligation_receipt;
END;
$$;

CREATE FUNCTION public.external_recovery_critical_review_acknowledge(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  target_acknowledgement_id UUID := (p_command ->> 'id')::uuid;
  target_obligation_id UUID := (p_command ->> 'obligation_id')::uuid;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  target_task INTEGER := (p_command ->> 'task_id')::integer;
  current_actor_role TEXT;
  obligation public.external_recovery_critical_review_obligations%ROWTYPE;
  task_row public.tasks%ROWTYPE;
  existing public.external_recovery_critical_review_acknowledgements%ROWTYPE;
  acknowledgement_receipt JSONB;
  recorded TIMESTAMPTZ(6) := clock_timestamp();
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM tenant
     OR tenant = '00000000-0000-4000-8000-000000000001'::uuid
     OR p_command ->> 'contract' <> 'late-critical-continuity-awareness'
     OR (p_command ->> 'contract_version')::integer <> 1
     OR p_command ->> 'authorization_mode' NOT IN ('assignee', 'role', 'admin', 'override')
     OR p_command ->> 'receipt_hash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'continuity-awareness acknowledgement denied';
  END IF;
  SELECT UPPER(BTRIM(role)) INTO current_actor_role
    FROM public.users
   WHERE tenant_id = tenant AND uid = actor
     AND is_active AND NOT is_deleted AND status = 'active'
   FOR SHARE;
  IF current_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'current human actor required';
  END IF;
  SELECT * INTO obligation
    FROM public.external_recovery_critical_review_obligations
   WHERE tenant_id = tenant AND id = target_obligation_id AND task_id = target_task
   FOR SHARE;
  SELECT * INTO task_row
    FROM public.tasks
   WHERE tenant_id = tenant AND id = target_task
     AND status = 'in_progress'
     AND workflow_sla_instance_id IS NULL
     AND sla_completion_semantics = 'none'
     AND due_at IS NULL
     AND metadata ->> 'acknowledged_by' = actor::text
     AND metadata ->> 'acknowledged_via' = p_command ->> 'authorization_mode'
     AND metadata ->> 'acknowledged_at' = p_command ->> 'task_acknowledged_at'
   FOR SHARE;
  IF obligation.id IS NULL OR task_row.id IS NULL
     OR obligation.patient_uid IS DISTINCT FROM task_row.patient_uid THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'task acknowledgement evidence is invalid';
  END IF;

  SELECT * INTO existing
    FROM public.external_recovery_critical_review_acknowledgements
   WHERE tenant_id = tenant
     AND (id = target_acknowledgement_id OR obligation_id = obligation.id OR task_id = target_task)
   ORDER BY recorded_at
   LIMIT 1
   FOR SHARE;
  IF FOUND THEN
    IF existing.id = target_acknowledgement_id
       AND existing.obligation_id = obligation.id
       AND existing.task_id = target_task
       AND existing.actor_uid = actor
       AND existing.actor_role = current_actor_role
       AND existing.authorization_mode = p_command ->> 'authorization_mode'
       AND existing.task_acknowledged_at = (p_command ->> 'task_acknowledged_at')::timestamptz
       AND existing.receipt_hash = p_command ->> 'receipt_hash' THEN
      RETURN jsonb_set(existing.receipt, '{disposition}', '"exact_duplicate"'::jsonb);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'continuity-awareness acknowledgement drift';
  END IF;

  acknowledgement_receipt := jsonb_build_object(
    'id', target_acknowledgement_id,
    'disposition', 'applied',
    'tenant_id', tenant,
    'obligation_id', obligation.id,
    'task_id', target_task,
    'actor_uid', actor,
    'actor_role', current_actor_role,
    'authorization_mode', p_command ->> 'authorization_mode',
    'task_acknowledged_at', (p_command ->> 'task_acknowledged_at')::timestamptz,
    'recorded_at', recorded
  );
  INSERT INTO public.external_recovery_critical_review_acknowledgements (
    id, tenant_id, obligation_id, task_id, actor_uid, actor_role,
    authorization_mode, task_acknowledged_at, request_id, receipt_hash,
    recorded_at, policy_version, policy_signature, retention_policy,
    retention_until, receipt
  ) VALUES (
    target_acknowledgement_id, tenant, obligation.id, target_task, actor, current_actor_role,
    p_command ->> 'authorization_mode',
    (p_command ->> 'task_acknowledged_at')::timestamptz,
    NULLIF(p_command ->> 'request_id', ''), p_command ->> 'receipt_hash',
    recorded, obligation.policy_version, obligation.policy_signature,
    obligation.retention_policy, obligation.retention_until,
    acknowledgement_receipt
  );
  RETURN acknowledgement_receipt;
END;
$$;

CREATE FUNCTION public.external_recovery_critical_review_completion_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  critical_ids INTEGER[];
  pending_task INTEGER;
  recovery_inbox UUID;
  family TEXT;
BEGIN
  IF TG_TABLE_NAME = 'lab_oru_ingest_messages' THEN
    IF NEW.recovery_interface_family IS DISTINCT FROM 'I01'
       OR NEW.status <> 'completed' THEN
      RETURN NEW;
    END IF;
    critical_ids := NEW.critical_result_ids;
    pending_task := NEW.recovery_pending_task_id;
    recovery_inbox := NEW.recovery_inbox_id;
    family := 'I01';
  ELSE
    IF NEW.recovery_interface_family IS DISTINCT FROM 'I02'
       OR NEW.status <> 'pending_review' THEN
      RETURN NEW;
    END IF;
    critical_ids := NEW.recovery_critical_result_ids;
    pending_task := NEW.recovery_pending_task_id;
    recovery_inbox := NEW.recovery_inbox_id;
    family := 'I02';
  END IF;
  IF cardinality(critical_ids) > 0 AND NOT EXISTS (
    SELECT 1
      FROM public.external_recovery_critical_review_obligations AS obligation
     WHERE obligation.tenant_id = NEW.tenant_id
       AND obligation.interface_family = family
       AND obligation.recovery_inbox_id = recovery_inbox
       AND obligation.task_id = pending_task
       AND obligation.critical_result_ids = critical_ids
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_external_recovery_critical_review_required',
      MESSAGE = 'late-critical recovery cannot complete without human awareness evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_recovery_i01_critical_review_guard
BEFORE UPDATE OF status, critical_result_ids, recovery_pending_task_id
ON public.lab_oru_ingest_messages
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_critical_review_completion_guard();

CREATE TRIGGER external_recovery_i02_critical_review_guard
BEFORE UPDATE OF status, recovery_critical_result_ids, recovery_pending_task_id
ON public.lab_interface_messages
FOR EACH ROW EXECUTE FUNCTION public.external_recovery_critical_review_completion_guard();

REVOKE ALL PRIVILEGES ON TABLE
  public.external_recovery_operability_actions,
  public.external_recovery_critical_review_obligations,
  public.external_recovery_critical_review_acknowledgements
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_evidence_owner_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_evidence_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_bound_hash(TEXT[]) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_offset_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_critical_review_completion_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_register_offset(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_authorize_resume(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_record_refusal(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_critical_review_obligation_append(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_critical_review_acknowledge(JSONB) FROM PUBLIC;

DO $external_recovery_runtime_privileges$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE FORMAT('GRANT USAGE ON SCHEMA public TO %I', role_name);
    EXECUTE FORMAT(
      'GRANT SELECT ON TABLE public.external_recovery_operability_actions, '
      'public.external_recovery_critical_review_obligations, '
      'public.external_recovery_critical_review_acknowledgements TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE '
      'public.external_recovery_operability_actions, '
      'public.external_recovery_critical_review_obligations, '
      'public.external_recovery_critical_review_acknowledgements FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.external_recovery_operability_register_offset(JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.external_recovery_operability_authorize_resume(JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.external_recovery_operability_record_refusal(JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.external_recovery_critical_review_obligation_append(JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.external_recovery_critical_review_acknowledge(JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_evidence_owner_only() FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_evidence_append_only() FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_bound_hash(TEXT[]) FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_operability_offset_guard() FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.external_recovery_critical_review_completion_guard() FROM %I',
      role_name
    );
  END LOOP;
END
$external_recovery_runtime_privileges$;

COMMENT ON TABLE public.external_recovery_operability_actions IS
  'Append-only exact-item external-recovery registration/resume and authenticated-refusal evidence.';
COMMENT ON TABLE public.external_recovery_critical_review_obligations IS
  'Immutable C-D8 late-critical continuity-awareness obligation in the existing Clinical Inbox.';
COMMENT ON TABLE public.external_recovery_critical_review_acknowledgements IS
  'Immutable human acknowledgement receipt for a late-critical continuity-awareness obligation.';

COMMIT;
