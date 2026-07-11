-- NL-14 P2: append-only resuscitation event timeline.
--
-- Ordered, immutable entries: compressions, rhythm checks, shocks (with defib
-- energy), airway, medications (MAR-linked via mig 516), labs, fluids, blood
-- products, procedures, ROSC, transfer, death declaration.
--
-- Append-only is enforced at the DATABASE level: a BEFORE UPDATE OR DELETE
-- trigger raises. Corrections are documented as NEW entries (entry_type
-- 'correction_note' referencing the corrected seq in details) — never in-place
-- edits (spec §4.3: "Rows are ordered and immutable").
--
-- The event header FK is ON DELETE RESTRICT on purpose: a documented event can
-- never be deleted out from under its timeline (misfires are status-cancelled,
-- never deleted — code-blue-misfire runbook).

BEGIN;

CREATE TABLE IF NOT EXISTS resuscitation_event_timeline (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resuscitation_event_id BIGINT NOT NULL REFERENCES resuscitation_events(id) ON DELETE RESTRICT,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  seq INTEGER NOT NULL,
  entry_type VARCHAR(40) NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  rhythm VARCHAR(60),
  energy_joules NUMERIC(6,1),
  medication_name VARCHAR(255),
  dose VARCHAR(100),
  route VARCHAR(50),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT resuscitation_timeline_entry_type_check CHECK (
    entry_type IN (
      'compressions_started',
      'compressions_stopped',
      'rhythm_check',
      'shock',
      'airway_intervention',
      'medication',
      'lab_sample',
      'fluid_bolus',
      'blood_product',
      'procedure',
      'rosc',
      'transfer',
      'death_declaration',
      'note',
      'correction_note'
    )
  ),
  CONSTRAINT resuscitation_timeline_seq_positive CHECK (seq > 0),
  CONSTRAINT resuscitation_timeline_energy_check
    CHECK (energy_joules IS NULL OR energy_joules > 0),
  CONSTRAINT fk_resuscitation_event_timeline_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_resuscitation_timeline_event_seq
  ON resuscitation_event_timeline (tenant_id, resuscitation_event_id, seq);

CREATE INDEX IF NOT EXISTS idx_resuscitation_timeline_event
  ON resuscitation_event_timeline (tenant_id, resuscitation_event_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_resuscitation_timeline_patient
  ON resuscitation_event_timeline (tenant_id, patient_uid, occurred_at DESC);

-- DB-enforced append-only: no in-place edit or delete of timeline entries.
CREATE OR REPLACE FUNCTION resuscitation_timeline_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'resuscitation_event_timeline is append-only: % is not allowed (document a correction_note entry instead)',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_resuscitation_timeline_append_only ON resuscitation_event_timeline;
CREATE TRIGGER trg_resuscitation_timeline_append_only
  BEFORE UPDATE OR DELETE ON resuscitation_event_timeline
  FOR EACH ROW EXECUTE FUNCTION resuscitation_timeline_block_mutation();

ALTER TABLE resuscitation_event_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE resuscitation_event_timeline FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resuscitation_event_timeline;
CREATE POLICY tenant_isolation ON resuscitation_event_timeline
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

COMMIT;
