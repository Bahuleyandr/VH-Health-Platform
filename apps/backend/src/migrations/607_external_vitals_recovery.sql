-- C6.1-B: tenant-scoped I09/I15 recovery evidence and absolute late-vitals
-- effect fence. No worker, offset, or adapter is activated by this migration.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE UNIQUE INDEX ux_pathway_projector_inbox_tenant_family_identity
  ON public.pathway_projector_inbox (tenant_id, inbox_id, interface_family);

ALTER TABLE public.vitals_chart
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD CONSTRAINT chk_vitals_chart_recovery_pair
    CHECK ((recovery_inbox_id IS NULL) = (recovery_interface_family IS NULL)),
  ADD CONSTRAINT chk_vitals_chart_recovery_late_boundary
    CHECK (
      recovery_inbox_id IS NULL
      OR (
        recovery_interface_family IN ('I09', 'I15')
        AND triage_acuity IS NULL
        AND (
          (recovery_interface_family = 'I09' AND source = 'device' AND device_verified = FALSE)
          OR (recovery_interface_family = 'I15' AND source = 'fhir' AND device_verified IS NULL)
        )
      )
    ),
  ADD CONSTRAINT fk_vitals_chart_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox(tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE UNIQUE INDEX uq_vitals_chart_recovery_inbox
  ON public.vitals_chart (tenant_id, recovery_inbox_id)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE UNIQUE INDEX ux_vitals_chart_recovery_contract
  ON public.vitals_chart
    (tenant_id, recovery_inbox_id, recovery_interface_family);

CREATE INDEX idx_vitals_chart_recovery_pending
  ON public.vitals_chart (tenant_id, recovery_interface_family, recorded_at DESC)
  WHERE recovery_inbox_id IS NOT NULL;

ALTER TABLE public.lab_interface_messages
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD CONSTRAINT chk_lab_interface_messages_recovery_pair
    CHECK ((recovery_inbox_id IS NULL) = (recovery_interface_family IS NULL)),
  ADD CONSTRAINT chk_lab_interface_messages_i09_recovery_shape
    CHECK (
      recovery_inbox_id IS NULL
      OR (
        recovery_interface_family = 'I09'
        AND direction = 'inbound'
        AND protocol = 'hl7v2'
        AND message_type = 'ORU^VITALS'
      )
    ),
  ADD CONSTRAINT fk_lab_interface_messages_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox(tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE UNIQUE INDEX uq_lab_interface_messages_recovery_inbox
  ON public.lab_interface_messages (tenant_id, recovery_inbox_id)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE UNIQUE INDEX ux_lab_interface_messages_recovery_contract
  ON public.lab_interface_messages
    (tenant_id, recovery_inbox_id, recovery_interface_family);

-- The I10 fence already blocks SLA, pathway, and notification effects. Late
-- I09/I15 processing additionally forbids every vitals-derived NEWS2, alert,
-- and triage mutation at the database boundary.
CREATE TRIGGER external_recovery_effect_guard_news2
BEFORE INSERT OR UPDATE ON public.news2_scores
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_clinical_alert
BEFORE INSERT OR UPDATE ON public.clinical_alerts
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_emergency_triage
BEFORE UPDATE OF triage_priority, triage_started_at, status
ON public.emergency_visits
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_emergency_triage_insert
BEFORE INSERT ON public.emergency_visits
FOR EACH ROW
WHEN (NEW.triage_priority IS NOT NULL OR NEW.triage_started_at IS NOT NULL)
EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_appointment_triage
BEFORE UPDATE OF triage_acuity ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_appointment_triage_insert
BEFORE INSERT ON public.appointments
FOR EACH ROW WHEN (NEW.triage_acuity IS NOT NULL)
EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_vitals_triage
BEFORE UPDATE OF triage_acuity ON public.vitals_chart
FOR EACH ROW EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

CREATE TRIGGER external_recovery_effect_guard_vitals_triage_insert
BEFORE INSERT ON public.vitals_chart
FOR EACH ROW WHEN (NEW.triage_acuity IS NOT NULL)
EXECUTE FUNCTION public.assert_external_recovery_effect_allowed();

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, patient_uid, encounter_id, heart_rate,
        systolic_bp, diastolic_bp, temperature, spo2, respiratory_rate,
        blood_glucose, pain_score, weight_kg, height_cm, gcs_score,
        supplemental_o2, notes, recorded_by, recorded_at, source,
        source_device, device_verified, triage_acuity, recovery_inbox_id,
        recovery_interface_family) ON public.vitals_chart TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT INSERT (tenant_id, analyzer_code, direction, protocol,
        message_type, raw_message, status, result_count, verdicts,
        authenticated_actor_uid, recovery_inbox_id,
        recovery_interface_family) ON public.lab_interface_messages TO %I',
      runtime_role
    );
  END LOOP;
END;
$runtime_privileges$;

COMMIT;
