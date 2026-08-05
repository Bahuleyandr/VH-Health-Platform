-- 627_clinical_continuity_device_loss_orchestration.sql
-- C-D10 unified device-loss containment projection.
--
-- Section 6.8 RLS posture and reasoning: these rows contain tenant-owned
-- security incident evidence and device/identity linkage. Every table uses an
-- explicit non-default tenant, FORCE RLS, tenant-safe composite foreign keys,
-- immutable identity fields, and narrow runtime column grants. The existing
-- clinical_audit_events hash chain remains the one append-only business audit
-- trail; the tables below are constrained workflow projections only.
-- Retention reuses the countersigned 365-day operational-audit class.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_audit_events_tenant_device_loss
  ON public.clinical_audit_events (tenant_id, id);

CREATE TABLE public.clinical_continuity_device_loss_operations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  stable_device_id UUID NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  incident_reference VARCHAR(200) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  state VARCHAR(40) NOT NULL DEFAULT 'phase1_pending',
  wipe_order_id UUID NOT NULL DEFAULT gen_random_uuid(),
  wipe_issued_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  wipe_content JSONB,
  wipe_content_hash CHAR(64),
  wipe_key_id VARCHAR(128),
  wipe_signature VARCHAR(128),
  step_projection JSONB NOT NULL DEFAULT '{}'::jsonb,
  capture_audit_event_id UUID,
  edge_audit_event_id UUID,
  wipe_audit_event_id UUID,
  routing_audit_event_id UUID,
  offline_risk_audit_event_id UUID,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ(6),
  retention_until TIMESTAMPTZ(6) NOT NULL DEFAULT (clock_timestamp() + INTERVAL '365 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_cc_device_loss_operation_request UNIQUE (tenant_id, request_fingerprint),
  CONSTRAINT uq_cc_device_loss_operation_order UNIQUE (tenant_id, wipe_order_id),
  CONSTRAINT fk_cc_device_loss_operation_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_operation_capture_audit
    FOREIGN KEY (tenant_id, capture_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_operation_edge_audit
    FOREIGN KEY (tenant_id, edge_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_operation_wipe_audit
    FOREIGN KEY (tenant_id, wipe_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_operation_routing_audit
    FOREIGN KEY (tenant_id, routing_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_operation_risk_audit
    FOREIGN KEY (tenant_id, offline_risk_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_device_loss_operation_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_device_loss_operation_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_device_loss_operation_text
    CHECK (
      BTRIM(incident_reference) <> ''
      AND BTRIM(reason) <> ''
      AND incident_reference !~ '[[:cntrl:]]'
      AND reason !~ '[[:cntrl:]]'
      AND actor_role = 'SUPER_ADMIN'
    ),
  CONSTRAINT chk_cc_device_loss_operation_state
    CHECK (state IN (
      'phase1_pending', 'tokens_pending', 'wipe_pending', 'routing_pending',
      'incomplete_retryable', 'awaiting_device_contact', 'executed'
    )),
  CONSTRAINT chk_cc_device_loss_operation_wipe_shape
    CHECK (
      (
        wipe_content IS NULL
        AND wipe_content_hash IS NULL
        AND wipe_key_id IS NULL
        AND wipe_signature IS NULL
        AND wipe_audit_event_id IS NULL
      )
      OR
      (
        wipe_content IS NOT NULL
        AND wipe_content_hash ~ '^[0-9a-f]{64}$'
        AND NULLIF(BTRIM(wipe_key_id), '') IS NOT NULL
        AND wipe_signature ~ '^[A-Za-z0-9+/]{86}==$'
        AND wipe_audit_event_id IS NOT NULL
      )
    ),
  CONSTRAINT chk_cc_device_loss_operation_version CHECK (version > 0),
  CONSTRAINT chk_cc_device_loss_operation_retention
    CHECK (retention_until >= created_at + INTERVAL '365 days')
);

CREATE INDEX idx_cc_device_loss_operation_device
  ON public.clinical_continuity_device_loss_operations
    (tenant_id, stable_device_id, created_at DESC);

CREATE INDEX idx_cc_device_loss_operation_state
  ON public.clinical_continuity_device_loss_operations
    (tenant_id, state, updated_at DESC);

CREATE TABLE public.clinical_continuity_device_loss_subjects (
  tenant_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  staff_uid UUID NOT NULL,
  staff_id INTEGER,
  realm VARCHAR(16) NOT NULL,
  break_glass BOOLEAN NOT NULL,
  identity_state VARCHAR(32) NOT NULL DEFAULT 'pending',
  identity_evidence JSONB,
  identity_audit_event_id UUID,
  token_state VARCHAR(32) NOT NULL DEFAULT 'pending',
  token_evidence JSONB,
  token_audit_event_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, operation_id, staff_uid),
  CONSTRAINT fk_cc_device_loss_subject_operation
    FOREIGN KEY (tenant_id, operation_id)
    REFERENCES public.clinical_continuity_device_loss_operations(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_subject_user
    FOREIGN KEY (tenant_id, staff_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_subject_identity_audit
    FOREIGN KEY (tenant_id, identity_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_subject_token_audit
    FOREIGN KEY (tenant_id, token_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_device_loss_subject_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_device_loss_subject_realm CHECK (realm = 'staff'),
  CONSTRAINT chk_cc_device_loss_subject_identity_state
    CHECK (identity_state IN ('pending', 'completed', 'excluded_break_glass')),
  CONSTRAINT chk_cc_device_loss_subject_token_state
    CHECK (token_state IN ('pending', 'completed', 'excluded_break_glass')),
  CONSTRAINT chk_cc_device_loss_subject_break_glass
    CHECK (
      (break_glass = false)
      OR
      (
        identity_state IN ('pending', 'excluded_break_glass')
        AND token_state IN ('pending', 'excluded_break_glass')
      )
    )
);

CREATE INDEX idx_cc_device_loss_subject_uid
  ON public.clinical_continuity_device_loss_subjects
    (tenant_id, staff_uid, created_at DESC);

CREATE TABLE public.clinical_continuity_device_loss_routes (
  tenant_id UUID NOT NULL,
  stable_device_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  operation_id UUID NOT NULL,
  fallback_principal VARCHAR(120) NOT NULL,
  assigned_to_uid UUID NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  retention_until TIMESTAMPTZ(6) NOT NULL DEFAULT (clock_timestamp() + INTERVAL '365 days'),
  PRIMARY KEY (tenant_id, stable_device_id, facility_id),
  CONSTRAINT fk_cc_device_loss_route_operation
    FOREIGN KEY (tenant_id, operation_id)
    REFERENCES public.clinical_continuity_device_loss_operations(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_route_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_loss_route_assignee
    FOREIGN KEY (tenant_id, assigned_to_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_device_loss_route_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_device_loss_route_principal
    CHECK (fallback_principal = 'role:clinical_safety_lead'),
  CONSTRAINT chk_cc_device_loss_route_retention
    CHECK (retention_until >= created_at + INTERVAL '365 days')
);

CREATE INDEX idx_cc_device_loss_route_assignee
  ON public.clinical_continuity_device_loss_routes
    (tenant_id, assigned_to_uid, created_at DESC)
  WHERE active = true;

ALTER TABLE public.clinical_continuity_device_loss_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_device_loss_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_device_loss_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_device_loss_subjects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_device_loss_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_device_loss_routes FORCE ROW LEVEL SECURITY;

DO $cc_device_loss_rls$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'clinical_continuity_device_loss_operations',
    'clinical_continuity_device_loss_subjects',
    'clinical_continuity_device_loss_routes'
  ]
  LOOP
    EXECUTE FORMAT(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE '
      'USING (tenant_id = public.app_current_tenant_id_uuid()) '
      'WITH CHECK (tenant_id = public.app_current_tenant_id_uuid())',
      relation_name
    );
    EXECUTE FORMAT(
      'CREATE POLICY cc_device_loss_explicit_tenant ON public.%I AS RESTRICTIVE '
      'USING ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) NOT IN ('''', ''bypass'')'
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ') WITH CHECK ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) NOT IN ('''', ''bypass'')'
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ')',
      relation_name
    );
  END LOOP;
END
$cc_device_loss_rls$;

CREATE FUNCTION public.assert_cc_device_loss_operation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.stable_device_id IS DISTINCT FROM OLD.stable_device_id
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.incident_reference IS DISTINCT FROM OLD.incident_reference
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.actor_uid IS DISTINCT FROM OLD.actor_uid
     OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
     OR NEW.wipe_order_id IS DISTINCT FROM OLD.wipe_order_id
     OR NEW.wipe_issued_at IS DISTINCT FROM OLD.wipe_issued_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
     OR NEW.version IS DISTINCT FROM OLD.version + 1
     OR NEW.updated_at <= OLD.updated_at
     OR (OLD.wipe_content IS NOT NULL AND (
       NEW.wipe_content IS DISTINCT FROM OLD.wipe_content
       OR NEW.wipe_content_hash IS DISTINCT FROM OLD.wipe_content_hash
       OR NEW.wipe_key_id IS DISTINCT FROM OLD.wipe_key_id
       OR NEW.wipe_signature IS DISTINCT FROM OLD.wipe_signature
       OR NEW.wipe_audit_event_id IS DISTINCT FROM OLD.wipe_audit_event_id
     )) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_device_loss_operation_mutation',
      MESSAGE = 'device-loss operation identity and proved steps are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.assert_cc_device_loss_subject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
     OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
     OR NEW.realm IS DISTINCT FROM OLD.realm
     OR NEW.break_glass IS DISTINCT FROM OLD.break_glass
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.updated_at <= OLD.updated_at
     OR (OLD.identity_state <> 'pending' AND (
       NEW.identity_state IS DISTINCT FROM OLD.identity_state
       OR NEW.identity_evidence IS DISTINCT FROM OLD.identity_evidence
       OR NEW.identity_audit_event_id IS DISTINCT FROM OLD.identity_audit_event_id
     ))
     OR (OLD.token_state <> 'pending' AND (
       NEW.token_state IS DISTINCT FROM OLD.token_state
       OR NEW.token_evidence IS DISTINCT FROM OLD.token_evidence
       OR NEW.token_audit_event_id IS DISTINCT FROM OLD.token_audit_event_id
     )) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_device_loss_subject_mutation',
      MESSAGE = 'device-loss subject identity and proved steps are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.assert_cc_device_loss_route_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_cc_device_loss_route_append_only',
    MESSAGE = 'device-loss standing routes are append-only';
END;
$$;

CREATE TRIGGER cc_device_loss_operation_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_device_loss_operations
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_device_loss_operation_mutation();

CREATE TRIGGER cc_device_loss_subject_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_device_loss_subjects
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_device_loss_subject_mutation();

CREATE TRIGGER cc_device_loss_route_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_device_loss_routes
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_device_loss_route_append_only();

CREATE FUNCTION public.clinical_continuity_device_loss_subject_identity_finalize(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_staff_uid UUID,
  p_identity_state VARCHAR,
  p_identity_evidence JSONB,
  p_identity_audit_event_id UUID,
  p_token_state VARCHAR DEFAULT NULL,
  p_token_evidence JSONB DEFAULT NULL,
  p_token_audit_event_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_identity_state NOT IN ('completed', 'excluded_break_glass')
     OR (p_token_state IS NOT NULL AND p_token_state <> 'excluded_break_glass')
     OR p_identity_audit_event_id IS NULL
     OR (p_token_state IS NOT NULL AND p_token_audit_event_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss identity finalization denied';
  END IF;
  UPDATE public.clinical_continuity_device_loss_subjects AS subject
     SET identity_state = p_identity_state,
         identity_evidence = p_identity_evidence,
         identity_audit_event_id = p_identity_audit_event_id,
         token_state = COALESCE(p_token_state, subject.token_state),
         token_evidence = CASE WHEN p_token_state IS NULL THEN subject.token_evidence ELSE p_token_evidence END,
         token_audit_event_id = CASE WHEN p_token_state IS NULL THEN subject.token_audit_event_id ELSE p_token_audit_event_id END,
         updated_at = clock_timestamp()
   WHERE subject.tenant_id = p_tenant_id
     AND subject.operation_id = p_operation_id
     AND subject.staff_uid = p_staff_uid
     AND subject.identity_state = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.clinical_continuity_device_loss_operations AS operation
        WHERE operation.tenant_id = p_tenant_id
          AND operation.id = p_operation_id
          AND operation.state = 'phase1_pending'
     );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_device_loss_subject_token_record(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_staff_uid UUID,
  p_token_state VARCHAR,
  p_token_evidence JSONB,
  p_token_audit_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_token_state NOT IN ('pending', 'completed')
     OR p_token_audit_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss token evidence denied';
  END IF;
  UPDATE public.clinical_continuity_device_loss_subjects AS subject
     SET token_state = p_token_state,
         token_evidence = p_token_evidence,
         token_audit_event_id = p_token_audit_event_id,
         updated_at = clock_timestamp()
   WHERE subject.tenant_id = p_tenant_id
     AND subject.operation_id = p_operation_id
     AND subject.staff_uid = p_staff_uid
     AND subject.token_state = 'pending'
     AND subject.identity_state IN ('completed', 'excluded_break_glass')
     AND EXISTS (
       SELECT 1 FROM public.clinical_continuity_device_loss_operations AS operation
        WHERE operation.tenant_id = p_tenant_id
          AND operation.id = p_operation_id
          AND operation.capture_audit_event_id IS NOT NULL
          AND operation.edge_audit_event_id IS NOT NULL
     );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_device_loss_phase1_finalize(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_step_projection JSONB,
  p_capture_audit_event_id UUID,
  p_edge_audit_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_capture_audit_event_id IS NULL
     OR p_edge_audit_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss phase 1 finalization denied';
  END IF;
  UPDATE public.clinical_continuity_device_loss_operations AS operation
     SET state = 'tokens_pending',
         step_projection = p_step_projection,
         capture_audit_event_id = p_capture_audit_event_id,
         edge_audit_event_id = p_edge_audit_event_id,
         version = operation.version + 1,
         updated_at = clock_timestamp()
   WHERE operation.tenant_id = p_tenant_id
     AND operation.id = p_operation_id
     AND operation.state = 'phase1_pending'
     AND NOT EXISTS (
       SELECT 1 FROM public.clinical_continuity_device_loss_subjects AS subject
        WHERE subject.tenant_id = p_tenant_id
          AND subject.operation_id = p_operation_id
          AND subject.identity_state = 'pending'
     );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_device_loss_step_failed(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_step_projection JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss failure evidence denied';
  END IF;
  UPDATE public.clinical_continuity_device_loss_operations AS operation
     SET state = 'incomplete_retryable',
         step_projection = p_step_projection,
         version = operation.version + 1,
         updated_at = clock_timestamp()
   WHERE operation.tenant_id = p_tenant_id
     AND operation.id = p_operation_id
     AND operation.state <> 'executed';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_device_loss_tokens_finalize(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_step_projection JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss token finalization denied';
  END IF;
  UPDATE public.clinical_continuity_device_loss_operations AS operation
     SET state = 'wipe_pending',
         step_projection = p_step_projection,
         version = operation.version + 1,
         updated_at = clock_timestamp()
   WHERE operation.tenant_id = p_tenant_id
     AND operation.id = p_operation_id
     AND operation.state IN ('tokens_pending', 'incomplete_retryable')
     AND operation.wipe_content IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.clinical_continuity_device_loss_subjects AS subject
        WHERE subject.tenant_id = p_tenant_id
          AND subject.operation_id = p_operation_id
          AND subject.token_state = 'pending'
     );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_device_loss_wipe_finalize(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_wipe_content JSONB,
  p_wipe_content_hash CHAR(64),
  p_wipe_key_id VARCHAR,
  p_wipe_signature VARCHAR,
  p_wipe_audit_event_id UUID,
  p_step_projection JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_wipe_content_hash !~ '^[0-9a-f]{64}$'
     OR p_wipe_signature !~ '^[A-Za-z0-9+/]{86}==$'
     OR NULLIF(BTRIM(p_wipe_key_id), '') IS NULL
     OR p_wipe_audit_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss wipe finalization denied';
  END IF;
  UPDATE public.clinical_continuity_device_loss_operations AS operation
     SET state = 'routing_pending',
         wipe_content = p_wipe_content,
         wipe_content_hash = p_wipe_content_hash,
         wipe_key_id = p_wipe_key_id,
         wipe_signature = p_wipe_signature,
         wipe_audit_event_id = p_wipe_audit_event_id,
         step_projection = p_step_projection,
         version = operation.version + 1,
         updated_at = clock_timestamp()
   WHERE operation.tenant_id = p_tenant_id
     AND operation.id = p_operation_id
     AND operation.state IN ('wipe_pending', 'incomplete_retryable')
     AND operation.wipe_content IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.clinical_continuity_device_loss_subjects AS subject
        WHERE subject.tenant_id = p_tenant_id
          AND subject.operation_id = p_operation_id
          AND subject.token_state = 'pending'
     );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_device_loss_routing_finalize(
  p_tenant_id UUID,
  p_operation_id UUID,
  p_routing_audit_event_id UUID,
  p_offline_risk_audit_event_id UUID,
  p_step_projection JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed INTEGER;
  expected_routes INTEGER;
  actual_routes INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_routing_audit_event_id IS NULL
     OR p_offline_risk_audit_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'device-loss routing finalization denied';
  END IF;
  SELECT jsonb_array_length(COALESCE(operation.step_projection -> 'facility_ids', '[]'::jsonb))
    INTO expected_routes
    FROM public.clinical_continuity_device_loss_operations AS operation
   WHERE operation.tenant_id = p_tenant_id AND operation.id = p_operation_id;
  SELECT COUNT(*)::integer INTO actual_routes
    FROM public.clinical_continuity_device_loss_routes AS route
    JOIN public.clinical_continuity_device_loss_operations AS operation
      ON operation.tenant_id = route.tenant_id
     AND operation.stable_device_id = route.stable_device_id
   WHERE route.tenant_id = p_tenant_id
     AND operation.id = p_operation_id
     AND route.facility_id IN (
       SELECT jsonb_array_elements_text(operation.step_projection -> 'facility_ids')::integer
     )
     AND route.active = true;
  IF expected_routes IS NULL OR expected_routes <> actual_routes THEN
    RETURN FALSE;
  END IF;
  UPDATE public.clinical_continuity_device_loss_operations AS operation
     SET state = 'awaiting_device_contact',
         step_projection = p_step_projection,
         routing_audit_event_id = p_routing_audit_event_id,
         offline_risk_audit_event_id = p_offline_risk_audit_event_id,
         version = operation.version + 1,
         updated_at = clock_timestamp()
   WHERE operation.tenant_id = p_tenant_id
     AND operation.id = p_operation_id
     AND operation.state IN ('routing_pending', 'incomplete_retryable')
     AND operation.wipe_audit_event_id IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL PRIVILEGES ON TABLE
  public.clinical_continuity_device_loss_operations,
  public.clinical_continuity_device_loss_subjects,
  public.clinical_continuity_device_loss_routes
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_device_loss_operation_mutation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_device_loss_subject_mutation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_device_loss_route_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_subject_identity_finalize(UUID, UUID, UUID, VARCHAR, JSONB, UUID, VARCHAR, JSONB, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_subject_token_record(UUID, UUID, UUID, VARCHAR, JSONB, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_phase1_finalize(UUID, UUID, JSONB, UUID, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_step_failed(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_tokens_finalize(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_wipe_finalize(UUID, UUID, JSONB, CHAR, VARCHAR, VARCHAR, UUID, JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_device_loss_routing_finalize(UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC;

DO $cc_device_loss_runtime_privileges$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'GRANT SELECT ON TABLE '
      'public.clinical_continuity_device_loss_operations, '
      'public.clinical_continuity_device_loss_subjects, '
      'public.clinical_continuity_device_loss_routes TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, stable_device_id, request_fingerprint, '
      'incident_reference, reason, actor_uid, actor_role, step_projection) '
      'ON public.clinical_continuity_device_loss_operations TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE '
      'ON public.clinical_continuity_device_loss_operations FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, operation_id, staff_uid, staff_id, realm, break_glass) '
      'ON public.clinical_continuity_device_loss_subjects TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE '
      'ON public.clinical_continuity_device_loss_subjects FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, stable_device_id, facility_id, operation_id, '
      'fallback_principal, assigned_to_uid) '
      'ON public.clinical_continuity_device_loss_routes TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, facility_id, grant_id, access_revision, '
      'revoked_by, reason, grant_purpose, capture_revision) '
      'ON public.clinical_continuity_edge_access_revocations TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_subject_identity_finalize(UUID, UUID, UUID, VARCHAR, JSONB, UUID, VARCHAR, JSONB, UUID) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_subject_token_record(UUID, UUID, UUID, VARCHAR, JSONB, UUID) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_phase1_finalize(UUID, UUID, JSONB, UUID, UUID) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_step_failed(UUID, UUID, JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_tokens_finalize(UUID, UUID, JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_wipe_finalize(UUID, UUID, JSONB, CHAR, VARCHAR, VARCHAR, UUID, JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_device_loss_routing_finalize(UUID, UUID, UUID, UUID, JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_device_loss_operation_mutation() FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_device_loss_subject_mutation() FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_device_loss_route_append_only() FROM %I',
      role_name
    );
  END LOOP;
END
$cc_device_loss_runtime_privileges$;

COMMENT ON TABLE public.clinical_continuity_device_loss_operations IS
  '365-day mutable projection for idempotent C-D10 device-loss containment; business evidence is in clinical_audit_events.';
COMMENT ON TABLE public.clinical_continuity_device_loss_subjects IS
  'Per-subject C-D15 convergence projection with exact break-glass exclusion evidence.';
COMMENT ON TABLE public.clinical_continuity_device_loss_routes IS
  'Append-only standing route for later lost-device work to the C-D6 fallback principal.';

COMMIT;
