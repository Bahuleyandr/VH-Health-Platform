-- Migration 592: patient-release state for structured Radiology/AP generations.
--
-- Release state belongs to one immutable diagnostic generation. A correction or
-- addendum therefore receives a fresh state row and can never silently reuse a
-- predecessor's hold or explicit-release evidence. This migration does not
-- backfill historical generations, send notifications, or change pathway mode.

BEGIN;

CREATE TABLE diagnostic_result_release_states (
  generation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  release_hold BOOLEAN NOT NULL DEFAULT FALSE,
  release_hold_by UUID,
  release_hold_reason TEXT,
  release_hold_at TIMESTAMPTZ(6),
  released_to_patient_at TIMESTAMPTZ(6),
  released_by UUID,
  state_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_diagnostic_release_state_tenant_generation
    UNIQUE (tenant_id, generation_id),
  CONSTRAINT ux_diagnostic_release_state_tenant_generation_patient
    UNIQUE (tenant_id, generation_id, patient_uid),
  CONSTRAINT fk_diagnostic_release_state_generation
    FOREIGN KEY (tenant_id, generation_id, patient_uid)
    REFERENCES diagnostic_result_generations (tenant_id, id, patient_uid),
  CONSTRAINT fk_diagnostic_release_state_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT fk_diagnostic_release_state_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_release_state_hold_actor
    FOREIGN KEY (tenant_id, release_hold_by) REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_release_state_release_actor
    FOREIGN KEY (tenant_id, released_by) REFERENCES users (tenant_id, uid),
  CONSTRAINT chk_diagnostic_release_state_hold CHECK (
    (
      release_hold = TRUE
      AND release_hold_by IS NOT NULL
      AND NULLIF(BTRIM(release_hold_reason), '') IS NOT NULL
      AND release_hold_at IS NOT NULL
    )
    OR
    (
      release_hold = FALSE
      AND release_hold_by IS NULL
      AND release_hold_reason IS NULL
      AND release_hold_at IS NULL
    )
  ),
  CONSTRAINT chk_diagnostic_release_state_explicit_release CHECK (
    (released_to_patient_at IS NULL AND released_by IS NULL)
    OR (released_to_patient_at IS NOT NULL AND released_by IS NOT NULL)
  ),
  CONSTRAINT chk_diagnostic_release_state_version CHECK (state_version >= 1)
);

CREATE INDEX idx_diagnostic_release_state_patient_time
  ON diagnostic_result_release_states
  (tenant_id, patient_uid, released_to_patient_at DESC, generation_id);

CREATE INDEX idx_diagnostic_release_state_held
  ON diagnostic_result_release_states (tenant_id, updated_at, generation_id)
  WHERE release_hold = TRUE;

CREATE OR REPLACE FUNCTION protect_diagnostic_result_release_state_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.generation_id IS DISTINCT FROM OLD.generation_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'diagnostic result release identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_protect_diagnostic_result_release_state_identity
BEFORE UPDATE ON diagnostic_result_release_states
FOR EACH ROW
EXECUTE FUNCTION protect_diagnostic_result_release_state_identity();

CREATE OR REPLACE FUNCTION validate_structured_diagnostic_release_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind_value TEXT;
BEGIN
  SELECT generation.source_kind
    INTO source_kind_value
    FROM diagnostic_result_generations generation
   WHERE generation.tenant_id = NEW.tenant_id
     AND generation.id = NEW.generation_id
     AND generation.patient_uid = NEW.patient_uid;

  IF NOT FOUND
     OR source_kind_value NOT IN ('radiology_report', 'anatomical_pathology_report') THEN
    RAISE EXCEPTION 'diagnostic release state requires a structured Radiology/AP generation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER trg_validate_structured_diagnostic_release_source
AFTER INSERT OR UPDATE ON diagnostic_result_release_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_structured_diagnostic_release_source();

ALTER TABLE diagnostic_result_release_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_result_release_states FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON diagnostic_result_release_states
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

COMMENT ON TABLE diagnostic_result_release_states IS
  'Mutable hold/explicit-release state for one immutable signed Radiology/AP diagnostic generation.';
COMMENT ON COLUMN diagnostic_result_release_states.generation_id IS
  'A correction/addendum gets a new generation and therefore a fresh release state.';

COMMIT;
