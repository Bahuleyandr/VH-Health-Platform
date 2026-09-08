-- Physical processing history does not authorize readiness. Emergency routing
-- approvals remain private, revision-bound, expiring, and single-use.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

ALTER TABLE public.device_processing_events
  ADD COLUMN over_ceiling BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_processing_events_over_ceiling_transition
  ON public.device_processing_events
    (tenant_id, device_id, device_version_before, device_version_after, cycle_before, cycle_after)
  WHERE over_ceiling AND counts_cycle;

ALTER TABLE public.reprocessable_devices
  DROP CONSTRAINT reprocessable_devices_cycle_bound_check,
  ADD CONSTRAINT reprocessable_devices_available_cycle_ceiling_check CHECK (
    max_cycles_snapshot IS NULL OR status <> 'available' OR cycle_count <= max_cycles_snapshot
  );

CREATE FUNCTION public.plan4_processing_ceiling_event_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  device_row record;
BEGIN
  SELECT cycle_count, max_cycles_snapshot, version INTO device_row
    FROM public.reprocessable_devices
   WHERE tenant_id = NEW.tenant_id AND id = NEW.device_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.over_ceiling OR (device_row.max_cycles_snapshot IS NOT NULL
      AND NEW.cycle_after > device_row.max_cycles_snapshot) THEN
    IF (NEW.over_ceiling AND NEW.counts_cycle
        AND device_row.max_cycles_snapshot IS NOT NULL
        AND NEW.cycle_after > device_row.max_cycles_snapshot
        AND NEW.cycle_before = device_row.cycle_count
        AND NEW.cycle_after = device_row.cycle_count + 1
        AND NEW.device_version_before = device_row.version
        AND NEW.device_version_after = device_row.version + 1
        AND NEW.metadata->>'recording_mode' = 'performed') IS NOT TRUE THEN
      RAISE EXCEPTION 'Above-ceiling processing requires an exact performed occurrence'
        USING ERRCODE = '23514', CONSTRAINT = 'plan4_processing_ceiling_event_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan4_processing_ceiling_event_guard
  BEFORE INSERT ON public.device_processing_events
  FOR EACH ROW EXECUTE FUNCTION public.plan4_processing_ceiling_event_guard();

CREATE FUNCTION public.plan4_processing_ceiling_device_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.max_cycles_snapshot IS DISTINCT FROM OLD.max_cycles_snapshot THEN
    RAISE EXCEPTION 'The enrolled device ceiling snapshot is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'plan4_processing_ceiling_device_check';
  END IF;
  IF NEW.max_cycles_snapshot IS NULL OR NEW.cycle_count <= NEW.max_cycles_snapshot THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Above-ceiling device import is not an occurrence'
      USING ERRCODE = '23514', CONSTRAINT = 'plan4_processing_ceiling_device_check';
  END IF;
  IF NEW.cycle_count IS NOT DISTINCT FROM OLD.cycle_count THEN RETURN NEW; END IF;
  IF NEW.cycle_count <> OLD.cycle_count + 1 OR NEW.version <> OLD.version + 1
      OR NOT EXISTS (
        SELECT 1 FROM public.device_processing_events event
         WHERE event.tenant_id = NEW.tenant_id AND event.device_id = NEW.id
           AND event.counts_cycle AND event.over_ceiling
           AND event.cycle_before = OLD.cycle_count AND event.cycle_after = NEW.cycle_count
           AND event.device_version_before = OLD.version AND event.device_version_after = NEW.version
           AND event.metadata->>'recording_mode' = 'performed'
      ) THEN
    RAISE EXCEPTION 'Above-ceiling cycle change requires its exact performed occurrence'
      USING ERRCODE = '23514', CONSTRAINT = 'plan4_processing_ceiling_device_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan4_processing_ceiling_device_guard
  BEFORE INSERT OR UPDATE ON public.reprocessable_devices
  FOR EACH ROW EXECUTE FUNCTION public.plan4_processing_ceiling_device_guard();

ALTER TABLE public.dialyser_reprocessing_attempts
  ALTER COLUMN dialyzer_reuse_register_id DROP NOT NULL;

CREATE UNIQUE INDEX ux_dialyser_reprocessing_attempts_unused_number
  ON public.dialyser_reprocessing_attempts (tenant_id, device_usage_id, attempt_no)
  WHERE dialyzer_reuse_register_id IS NULL;

CREATE FUNCTION public.dialyser_unused_cancellation_attempt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  session_id integer;
BEGIN
  IF NEW.dialyzer_reuse_register_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT dialysis_session_id INTO session_id FROM public.reprocessable_device_usages
   WHERE tenant_id = NEW.tenant_id AND id = NEW.device_usage_id AND device_id = NEW.device_id;
  PERFORM 1 FROM public.dialysis_sessions
   WHERE tenant_id = NEW.tenant_id AND id = session_id FOR SHARE;
  PERFORM 1 FROM public.reprocessable_devices
   WHERE tenant_id = NEW.tenant_id AND id = NEW.device_id FOR SHARE;
  PERFORM 1 FROM public.reprocessable_device_usages
   WHERE tenant_id = NEW.tenant_id AND id = NEW.device_usage_id FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.reprocessable_device_usages usage
    JOIN public.dialysis_sessions session
      ON session.tenant_id = usage.tenant_id AND session.id = usage.dialysis_session_id
    JOIN public.reprocessable_devices device
      ON device.tenant_id = usage.tenant_id AND device.id = usage.device_id
    WHERE usage.tenant_id = NEW.tenant_id AND usage.id = NEW.device_usage_id
      AND usage.device_id = NEW.device_id AND usage.domain = 'dialysis'
      AND usage.dialysis_session_id = session_id
      AND usage.returned_at IS NOT NULL AND usage.returned_by IS NOT NULL
      AND usage.actual_use_started_at IS NULL
      AND usage.post_use_disposition = 'cancelled_before_use'
      AND usage.unopened_confirmation = 'not_connected'
      AND session.status IN ('cancelled', 'no_show') AND session.actual_start_at IS NULL
      AND device.status <> 'available' AND device.current_usage_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.dialyzer_reuse_register statutory
         WHERE statutory.tenant_id = usage.tenant_id AND statutory.device_usage_id = usage.id
      )
  ) THEN
    RAISE EXCEPTION 'A null-statutory attempt requires an ended unused not-connected cancellation'
      USING ERRCODE = '23514', CONSTRAINT = 'dialyser_unused_cancellation_attempt_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dialyser_unused_cancellation_attempt_guard
  BEFORE INSERT ON public.dialyser_reprocessing_attempts
  FOR EACH ROW EXECUTE FUNCTION public.dialyser_unused_cancellation_attempt_guard();

ALTER TABLE public.dialysis_machines
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE public.reprocessing_domain_settings
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE public.reprocessing_domain_policies
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE FUNCTION public.plan4_binding_revision_bump()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dialysis_machines_binding_revision
  BEFORE UPDATE ON public.dialysis_machines
  FOR EACH ROW EXECUTE FUNCTION public.plan4_binding_revision_bump();
CREATE TRIGGER reprocessing_domain_settings_binding_revision
  BEFORE UPDATE ON public.reprocessing_domain_settings
  FOR EACH ROW EXECUTE FUNCTION public.plan4_binding_revision_bump();
CREATE TRIGGER reprocessing_domain_policies_binding_revision
  BEFORE UPDATE ON public.reprocessing_domain_policies
  FOR EACH ROW EXECUTE FUNCTION public.plan4_binding_revision_bump();

CREATE TABLE public.dialysis_isolation_emergency_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  patient_uid UUID NOT NULL,
  machine_id INTEGER NOT NULL,
  machine_revision BIGINT NOT NULL CHECK (machine_revision >= 1),
  scheduled_for TIMESTAMPTZ(6) NOT NULL,
  decision_fingerprint VARCHAR(64) NOT NULL CHECK (decision_fingerprint ~ '^[0-9a-f]{64}$'),
  settings_revision BIGINT NOT NULL CHECK (settings_revision >= 1),
  policy_revision BIGINT NOT NULL CHECK (policy_revision >= 1),
  isolation_revision_id BIGINT NOT NULL,
  protocol_id INTEGER NOT NULL,
  consultant_approved_by UUID NOT NULL,
  consultant_approved_role VARCHAR(50) NOT NULL CHECK (consultant_approved_role = 'CONSULTANT'),
  consultant_approved_at TIMESTAMPTZ(6) NOT NULL,
  applied_by UUID NOT NULL,
  applied_role VARCHAR(50) NOT NULL,
  purpose TEXT NOT NULL CHECK (btrim(purpose) <> ''),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  bound_session_id INTEGER,
  consumed_at TIMESTAMPTZ(6),
  consumed_by UUID,
  CONSTRAINT ux_dialysis_emergency_authorizations_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_dialysis_emergency_patient FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES public.users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_machine FOREIGN KEY (tenant_id, machine_id)
    REFERENCES public.dialysis_machines (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_isolation_revision FOREIGN KEY (tenant_id, isolation_revision_id)
    REFERENCES public.reprocessing_isolation_setting_revisions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_protocol FOREIGN KEY (tenant_id, protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_consultant FOREIGN KEY (tenant_id, consultant_approved_by)
    REFERENCES public.users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_applicator FOREIGN KEY (tenant_id, applied_by)
    REFERENCES public.users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_consumer FOREIGN KEY (tenant_id, consumed_by)
    REFERENCES public.users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_emergency_session FOREIGN KEY (tenant_id, bound_session_id)
    REFERENCES public.dialysis_sessions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT dialysis_emergency_applicator_check CHECK (
    (applied_by = consultant_approved_by AND applied_role = 'CONSULTANT')
    OR (applied_by <> consultant_approved_by AND applied_role IN ('ADMIN', 'SUPER_ADMIN'))
  ),
  CONSTRAINT dialysis_emergency_expiry_check CHECK (
    consultant_approved_at <= created_at AND expires_at > created_at
    AND expires_at <= created_at + INTERVAL '4 hours'
  ),
  CONSTRAINT dialysis_emergency_consumption_check CHECK (
    (consumed_at IS NULL) = (consumed_by IS NULL)
    AND (consumed_at IS NULL OR (bound_session_id IS NOT NULL
      AND consumed_at >= created_at AND consumed_at < expires_at))
  )
);

CREATE INDEX idx_dialysis_emergency_pending_patient
  ON public.dialysis_isolation_emergency_authorizations (tenant_id, patient_uid, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX idx_dialysis_emergency_bound_session
  ON public.dialysis_isolation_emergency_authorizations (tenant_id, bound_session_id)
  WHERE bound_session_id IS NOT NULL;

CREATE FUNCTION public.dialysis_emergency_authorization_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Emergency authorizations are retained'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
      (to_jsonb(NEW) - ARRAY['bound_session_id', 'consumed_at', 'consumed_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['bound_session_id', 'consumed_at', 'consumed_by'])
      OR OLD.consumed_at IS NOT NULL
      OR (OLD.bound_session_id IS NOT NULL AND NEW.bound_session_id IS DISTINCT FROM OLD.bound_session_id)
    ) THEN
    RAISE EXCEPTION 'Emergency approval bindings are immutable and single-use'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.bound_session_id IS NOT NULL OR NEW.consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Emergency authorization must be created unbound and unconsumed'
      USING ERRCODE = '23514', CONSTRAINT = 'dialysis_emergency_binding_check';
  END IF;
  IF NEW.bound_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dialysis_sessions session
    JOIN public.dialysis_patients patient
      ON patient.tenant_id = session.tenant_id AND patient.id = session.dialysis_patient_id
    JOIN public.dialysis_machines machine
      ON machine.tenant_id = session.tenant_id AND machine.machine_no = session.machine_no
    WHERE session.tenant_id = NEW.tenant_id AND session.id = NEW.bound_session_id
      AND patient.patient_uid = NEW.patient_uid AND machine.id = NEW.machine_id
  ) THEN
    RAISE EXCEPTION 'Emergency authorization session binding does not match'
      USING ERRCODE = '23514', CONSTRAINT = 'dialysis_emergency_binding_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dialysis_emergency_authorization_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.dialysis_isolation_emergency_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.dialysis_emergency_authorization_guard();

ALTER TABLE public.dialysis_isolation_emergency_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dialysis_isolation_emergency_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.dialysis_isolation_emergency_authorizations AS PERMISSIVE
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
CREATE POLICY tenant_context_required ON public.dialysis_isolation_emergency_authorizations
  AS RESTRICTIVE FOR ALL USING (app_current_tenant_id_uuid() IS NOT NULL);

REVOKE ALL ON FUNCTION public.plan4_processing_ceiling_event_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plan4_processing_ceiling_device_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dialyser_unused_cancellation_attempt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plan4_binding_revision_bump() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dialysis_emergency_authorization_guard() FROM PUBLIC;

DO $runtime_grants$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime'] LOOP
    IF pg_catalog.to_regrole(role_name) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE ALL ON public.dialysis_isolation_emergency_authorizations FROM %I', role_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.dialysis_isolation_emergency_authorizations TO %I', role_name);
  END LOOP;
END
$runtime_grants$;

COMMIT;
