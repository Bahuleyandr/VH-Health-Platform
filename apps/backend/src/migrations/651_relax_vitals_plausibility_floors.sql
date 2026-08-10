-- 651_relax_vitals_plausibility_floors.sql
--
-- 2026-08-10 independent-audit triage, finding R5: the flat plausibility
-- floors (HR min 20, SBP min 40, DBP min 20) rejected real emergencies —
-- asystole during a code is HR 0, an arrest blood pressure is
-- unobtainable/0, and preterm-neonate systolic pressures sit in the
-- 30s-40s. The floors are now physically-impossible-only (>= 0); cohort
-- judgment about what is ALARMING stays in vitalSignMonitor's
-- paediatric/adult alerting ranges. Upper bounds are unchanged (HR 900 /
-- SpO2 500 class garbage is still rejected).
--
-- App-side source of truth: utils/clinical/vitalPlausibility.js (shared
-- floors, spread into utils/clinical/icuPlausibility.js). This migration
-- re-aligns migration 648's DB backstop: the CHECK is dropped and re-added
-- under the same name with the relaxed floors, again NOT VALID so any
-- historical out-of-band row is grandfathered while every new INSERT/UPDATE
-- is enforced (same semantics 648 chose; precedent 478/480/481/594).
-- Rows accepted under the OLD floors (hr >= 20 etc.) are a strict subset of
-- the new envelope, so re-validation would succeed anyway — NOT VALID just
-- keeps the migration O(1).

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE icu_flowsheet_entries
  DROP CONSTRAINT IF EXISTS chk_icu_flowsheet_vitals_plausible;

ALTER TABLE icu_flowsheet_entries
  ADD CONSTRAINT chk_icu_flowsheet_vitals_plausible CHECK (
    (hr             IS NULL OR (hr             BETWEEN 0   AND 300)) AND
    (sbp            IS NULL OR (sbp            BETWEEN 0   AND 300)) AND
    (dbp            IS NULL OR (dbp            BETWEEN 0   AND 200)) AND
    (map            IS NULL OR (map            BETWEEN 20  AND 250)) AND
    (cvp            IS NULL OR (cvp            BETWEEN -10 AND 60))  AND
    (spo2           IS NULL OR (spo2           BETWEEN 0   AND 100)) AND
    (rr             IS NULL OR (rr             BETWEEN 0   AND 80))  AND
    (temp_c         IS NULL OR (temp_c         BETWEEN 30  AND 45))  AND
    (cap_refill_sec IS NULL OR (cap_refill_sec BETWEEN 0   AND 30))
  ) NOT VALID;

COMMIT;
