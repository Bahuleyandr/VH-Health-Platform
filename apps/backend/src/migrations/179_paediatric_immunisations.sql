-- 179_paediatric_immunisations.sql
--
-- A10 — paediatric immunisation tracking for the general patient roll,
-- not just the newborn cohort.
--
-- Migration 160 created `vaccine_catalogue` (Indian NIS + IAP seed)
-- and `newborn_immunisations` keyed to `maternity_newborns.id`. That
-- handles babies born at this hospital. Walk-in paediatric patients
-- (3-year-old brought in for a booster, transferred infants, etc.)
-- have a `users` row but no `maternity_newborns` row, so their
-- immunisations had nowhere to land.
--
-- This migration adds a parallel `patient_immunisations` table keyed
-- by `patient_uid UUID`. Same per-dose row structure as the newborn
-- variant; same vaccine_catalogue lookup. The two tables coexist
-- because:
--   - newborn_immunisations is mass-seeded at birth from the
--     maternity record + carries birth-specific fields (site of
--     injection, adverse event tied to maternity_newborns).
--   - patient_immunisations is on-demand: created when a paeds OPD
--     receptionist registers / re-encounters a child, or when a doc
--     records a catch-up dose during a visit.
--
-- Paediatric OPD retains its own RBAC; this table inherits the same
-- staff-role gate as the maternity routes.

BEGIN;

CREATE TABLE IF NOT EXISTS patient_immunisations (
  id                   SERIAL PRIMARY KEY,
  patient_uid          UUID NOT NULL,
  vaccine_catalogue_id INTEGER NOT NULL REFERENCES vaccine_catalogue(id) ON DELETE RESTRICT,
  due_date             DATE NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'given', 'missed', 'refused', 'contraindicated')),
  given_at             TIMESTAMPTZ,
  given_by             UUID,
  given_by_name        VARCHAR(160),
  batch_number         VARCHAR(80),
  manufacturer         VARCHAR(120),
  site_of_injection    VARCHAR(40),
    -- left_thigh | right_thigh | left_deltoid | right_deltoid | oral | sc
  adverse_event        TEXT,
  notes                TEXT,
  -- Optional back-link when the same child also has a newborn cohort
  -- row (was born here AND came back for a paeds visit). Populated by
  -- the seed service when a maternity_newborn matching this patient
  -- is found; null otherwise.
  newborn_immunisation_id INTEGER REFERENCES newborn_immunisations(id) ON DELETE SET NULL,
  tenant_id            UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_uid, vaccine_catalogue_id)
);

CREATE INDEX IF NOT EXISTS idx_patient_immun_patient
  ON patient_immunisations(patient_uid, due_date);
CREATE INDEX IF NOT EXISTS idx_patient_immun_due
  ON patient_immunisations(tenant_id, due_date)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_patient_immun_status
  ON patient_immunisations(patient_uid, status);

COMMIT;
