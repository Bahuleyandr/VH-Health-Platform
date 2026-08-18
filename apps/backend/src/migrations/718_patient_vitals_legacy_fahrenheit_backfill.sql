-- 718_patient_vitals_legacy_fahrenheit_backfill.sql
--
-- One-time backfill: convert legacy raw-Fahrenheit patient_vitals.temperature
-- rows to the canonical Celsius the column now holds.
--
-- WHY (finding R1/P2, 2026-08-18 hunt)
-- ------------------------------------
-- Before the 2026-08-18 canonical-unit fix wave, the patient app's manual
-- vitals form submitted temperature UNITLESS in Fahrenheit (98.6) and the
-- backend stored it raw (pre-fix recordPatientVitals had no conversion). The
-- write path now converts manual entries to canonical °C
-- (patientHealthController.toCelsius, temperature_unit:'F') and every read
-- path converts °C → °F for display — so an unconverted legacy 98.6 row
-- renders as ~209.5 °F in the patient history tab and corrupts trend deltas.
-- No unit column exists on patient_vitals to disambiguate per row, so the
-- backfill uses a plausibility heuristic.
--
-- THE HEURISTIC
-- -------------
-- Convert exactly the rows whose value is
--   * impossible as °C  (temperature > 45, the VITAL_PLAUSIBILITY_BOUNDS /
--     migration-648-family ceiling: nothing a live human body produces), AND
--   * plausible as °F   (53.6 <= temperature <= 113, which is the canonical
--     12-45 °C plausibility band expressed in °F — the same projection
--     vhhealth_core's vitalPlausibilityBoundFor(fahrenheit: true) uses, i.e.
--     the exact range the legacy °F form accepted).
-- Since 53.6 > 45, the predicate reduces to BETWEEN 53.6 AND 113. Converted
-- values are rounded to one decimal, matching the display precision.
--
-- Rows outside both plausible ranges — (45, 53.6) or above 113 — are data
-- garbage in either unit and are deliberately left untouched: converting them
-- would still yield an implausible °C value, and the patient history tab now
-- carries a display-side guard that renders any residual > 45 value flagged
-- and raw instead of as a fake converted °F number.
--
-- WHY THIS CANNOT DOUBLE-CONVERT (verified against the code at authoring)
-- -----------------------------------------------------------------------
--   * Post-fix manual writes are converted to °C and then clamped by
--     assertVitalPlausibility to 12-45 °C (patientHealthController.js) —
--     always <= 45, so they can never match the > 45 predicate.
--   * Wearable rows (source healthkit/health_connect/google_fit) carry the
--     Flutter health plugin's canonical-°C BODY_TEMPERATURE and the wearable
--     ingest path (normalizeWearableVitalPayload) asserts the same 12-45 °C
--     band before insert — also always <= 45. Even a hypothetical legacy
--     wearable °F row would be CORRECTLY converted, not doubled, because a
--     genuine °C value can never exceed 45.
--   * Staff quick-vitals no longer writes patient_vitals (it records to
--     vitals_chart via vitalsChartService with an explicit unit); any
--     historical staff-written raw-°F rows in patient_vitals fall under the
--     same heuristic and are converted correctly.
--   * IDEMPOTENT / RE-RUN SAFE: every value this statement writes lands in
--     [12.0, 45.0] (ROUND((113-32)*5/9, 1) = 45.0 at the top of the band), so
--     a converted row can never satisfy temperature >= 53.6 again. Re-running
--     the file, or racing a concurrent post-fix write, matches nothing new.
--
-- LOCK DISCIPLINE (the 674-F4 lesson)
-- -----------------------------------
-- Single UPDATE, no DDL — ROW EXCLUSIVE only; concurrent reads unblocked
-- (MVCC), concurrent writers block only on the touched rows. patient_vitals
-- is a single-hospital self-reported-vitals table and the predicate is served
-- by a plain scan; the runner's default statement timeout is ample headroom.

BEGIN;

UPDATE patient_vitals
   SET temperature = ROUND((temperature - 32) * 5.0 / 9.0, 1)
 WHERE temperature IS NOT NULL
   AND temperature >= 53.6
   AND temperature <= 113;

COMMIT;
