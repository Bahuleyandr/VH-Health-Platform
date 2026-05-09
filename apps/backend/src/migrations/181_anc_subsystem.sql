-- 181_anc_subsystem.sql
--
-- A7 — ANC subsystem operational additions.
--
-- Background. Migration 155 created maternity_pregnancies +
-- maternity_anc_visits and the surrounding labor/delivery/newborn
-- pipeline. The in-flight ANC findings surfaced concrete gaps that
-- aren't fixable with the existing schema:
--
--   1. Visit number per pregnancy was unrequested at INSERT, so the
--      "ANC visit #4" UI label was always blank.
--   2. Supplements (iron, folic acid, calcium, vitamin-D) were tracked
--      ad-hoc in the visit notes; no structured row meant no reminder
--      schedule and no cross-visit "still missing folic acid" alert.
--   3. Fetal kick counts were captured by the patient on paper. There
--      was nowhere to record a daily count or to surface a low-count
--      flag (< 10 kicks in 12h is the standard alert threshold).
--
-- This migration adds the three structured pieces. None of them hit
-- the labor/delivery side of the pipeline.

BEGIN;

-- ── 1. visit_number on maternity_anc_visits ─────────────────────────
-- Auto-incremented per pregnancy by the recordAncVisit service.
-- NULL on historicals (backfilled from a window count).
ALTER TABLE maternity_anc_visits
  ADD COLUMN IF NOT EXISTS visit_number INTEGER;

-- Backfill: number existing visits per pregnancy chronologically.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY pregnancy_id ORDER BY visit_date, id) AS n
    FROM maternity_anc_visits
   WHERE visit_number IS NULL
)
UPDATE maternity_anc_visits v
   SET visit_number = numbered.n
  FROM numbered
 WHERE v.id = numbered.id;

CREATE INDEX IF NOT EXISTS idx_anc_visits_visit_number
  ON maternity_anc_visits(pregnancy_id, visit_number);

-- ── 2. Supplements (per pregnancy) ──────────────────────────────────
-- Prescription-style: one row per supplement course. Reminders fire
-- from the daily cron when due_today() returns true (see service).
CREATE TABLE IF NOT EXISTS maternity_supplements (
  id              SERIAL PRIMARY KEY,
  pregnancy_id    INTEGER NOT NULL REFERENCES maternity_pregnancies(id) ON DELETE CASCADE,
  supplement      VARCHAR(60) NOT NULL,
    -- iron | folic_acid | calcium | vitamin_d | b_complex | other
  dose            VARCHAR(60),
    -- e.g. "60mg elemental iron + 0.5mg folic acid"
  frequency       VARCHAR(40) NOT NULL DEFAULT 'once_daily',
    -- once_daily | twice_daily | thrice_daily | weekly | as_needed
  route           VARCHAR(20) NOT NULL DEFAULT 'oral',
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date        DATE,
  reminder_enabled BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  prescribed_by   UUID NOT NULL,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anc_supplements_pregnancy
  ON maternity_supplements(pregnancy_id);
-- Partial index for "still active" supplements. Postgres requires
-- IMMUTABLE functions in index predicates, so CURRENT_DATE can't sit
-- here. Restrict to end_date IS NULL (the common case — open-ended
-- supplements). Time-bound courses (end_date set) are still findable
-- by the broader idx_anc_supplements_pregnancy index plus the
-- per-row filter in service.listSupplements({activeOnly:true}).
CREATE INDEX IF NOT EXISTS idx_anc_supplements_active
  ON maternity_supplements(pregnancy_id, supplement)
  WHERE end_date IS NULL;

-- ── 3. Fetal kick counts (daily log) ────────────────────────────────
-- Patient self-records once per day from ~28 weeks. Standard alert is
-- < 10 kicks in 12h — surfaced via low_count_flag computed on insert.
CREATE TABLE IF NOT EXISTS maternity_fetal_kicks (
  id              SERIAL PRIMARY KEY,
  pregnancy_id    INTEGER NOT NULL REFERENCES maternity_pregnancies(id) ON DELETE CASCADE,
  log_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  kick_count      INTEGER NOT NULL CHECK (kick_count >= 0 AND kick_count <= 999),
  observation_window_minutes INTEGER NOT NULL DEFAULT 720,
    -- 720 = 12h; UI nudges patient toward this default
  low_count_flag  BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  recorded_by     UUID,    -- null when self-logged via patient app
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pregnancy_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_anc_kicks_pregnancy_date
  ON maternity_fetal_kicks(pregnancy_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_anc_kicks_low
  ON maternity_fetal_kicks(pregnancy_id, log_date)
  WHERE low_count_flag = true;

COMMIT;
