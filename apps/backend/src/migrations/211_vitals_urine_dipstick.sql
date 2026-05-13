-- 211_vitals_urine_dipstick.sql
--
-- OB nurses need a structured slot for the urine dipstick reading taken
-- during routine ANC vitals. Migration 169 added fhr + fundal_height_cm
-- to vitals_chart but skipped the dipstick fields, so urine_albumin /
-- urine_sugar / urine_ketones still spilled into free-text notes. The
-- maternity_anc_visits table already uses urine_albumin + urine_sugar
-- at VARCHAR(10) — mirror those names so the ANC visit composer and
-- the vitals recorder agree on the column shape. urine_ketones is the
-- third standard dipstick pad and rounds out the minimal structured
-- set OB nurses need (protein / sugar / ketones).
--
-- Finding: 2026-05-08-obstetric-anc-nurse-no-ob-vitals-fields
--          (urine-dipstick portion; FHR + fundal_height_cm closed in 169).
--
-- Columns are nullable and additive. No backfill required.

BEGIN;

ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS urine_albumin  VARCHAR(10),
  ADD COLUMN IF NOT EXISTS urine_sugar    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS urine_ketones  VARCHAR(10);

COMMIT;
