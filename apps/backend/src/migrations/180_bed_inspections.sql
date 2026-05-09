-- 180_bed_inspections.sql
--
-- D1 — bed inspection / consumer-choice flow at admit time.
--
-- Per project decision (chat 2026-05-09): when a patient is advised
-- admission (appointments.advised_for_admission_at flips), the patient
-- or attenders go physically look at the available rooms/beds before
-- the admission counter actually admits. This needs:
--
--   1. A way for the receptionist to record which beds were shown to
--      the patient (so a returning attender can pick up where they
--      left off, instead of being shown a different shortlist).
--   2. A landing place for the patient's choice.
--   3. A soft expiry so abandoned inspections don't permanently
--      reserve beds in the UI.
--
-- One row per inspection event. shown_bed_ids[] is an array of beds
-- the receptionist walked the attender through. chosen_bed_id, when
-- set, is the bed the admission counter then admits into.
--
-- Architectural item D1.

BEGIN;

CREATE TABLE IF NOT EXISTS bed_inspections (
  id                  SERIAL PRIMARY KEY,
  appointment_id      INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  patient_uid         UUID NOT NULL,
  -- Beds shown to the attender during this inspection (snapshot — the
  -- bed status at the moment the receptionist walked them through).
  -- Stored as int[] not jsonb so a GIN index works for "find
  -- inspections that included bed X".
  shown_bed_ids       INTEGER[] NOT NULL DEFAULT '{}',
  -- Which bed the patient ended up choosing. NULL until decided.
  chosen_bed_id       INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  decision            VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'chosen', 'declined', 'expired')),
  -- Free-text capture of who actually inspected (typically a relative,
  -- not the patient). UI shows this on the admission counter.
  inspected_by_attender VARCHAR(160),
  attender_phone      VARCHAR(20),
  notes               TEXT,
  initiated_by        UUID NOT NULL,
  initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at          TIMESTAMPTZ,
  -- Soft expiry — after this point a stale inspection is marked
  -- 'expired' by the periodic sweep so it stops blocking the bed
  -- shortlist. Default 24h from initiated_at; tuneable per call.
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bed_inspections_appointment
  ON bed_inspections(appointment_id);
CREATE INDEX IF NOT EXISTS idx_bed_inspections_patient
  ON bed_inspections(patient_uid, decision, initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bed_inspections_pending_expires
  ON bed_inspections(expires_at)
  WHERE decision = 'pending';
-- GIN over shown_bed_ids enables "show me every inspection that
-- included this bed" queries — useful when a bed gets reassigned and
-- we want to nudge any pending inspections that featured it.
CREATE INDEX IF NOT EXISTS idx_bed_inspections_shown_beds
  ON bed_inspections USING GIN (shown_bed_ids);

COMMIT;
