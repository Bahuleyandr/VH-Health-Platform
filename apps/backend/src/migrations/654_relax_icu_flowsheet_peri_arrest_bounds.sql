-- 654_relax_icu_flowsheet_peri_arrest_bounds.sql
--
-- Audit #3 P3: keep the ICU database backstop aligned with the canonical
-- reject-only-the-impossible envelope in vitalPlausibility.js and
-- icuPlausibility.js. This admits peri-arrest MAP 0, post-arrest temperature
-- management, and respiratory rates up to 120 while preserving every upper
-- bound against sensor/data-entry garbage.
--
-- @no-transaction
-- @statement_timeout: 0
--
-- DROP + ADD are one ALTER TABLE statement so there is no crash window in
-- which new rows can bypass the constraint. NOT VALID preserves migration
-- 648/651 semantics: historical rows are not scanned, but every subsequent
-- INSERT/UPDATE is checked immediately.

SET lock_timeout = '10s';
SET statement_timeout = '0';

ALTER TABLE icu_flowsheet_entries
  DROP CONSTRAINT IF EXISTS chk_icu_flowsheet_vitals_plausible,
  ADD CONSTRAINT chk_icu_flowsheet_vitals_plausible CHECK (
    (hr             IS NULL OR (hr             BETWEEN 0   AND 300)) AND
    (sbp            IS NULL OR (sbp            BETWEEN 0   AND 300)) AND
    (dbp            IS NULL OR (dbp            BETWEEN 0   AND 200)) AND
    (map            IS NULL OR (map            BETWEEN 0   AND 250)) AND
    (cvp            IS NULL OR (cvp            BETWEEN -10 AND 60))  AND
    (spo2           IS NULL OR (spo2           BETWEEN 0   AND 100)) AND
    (rr             IS NULL OR (rr             BETWEEN 0   AND 120)) AND
    (temp_c         IS NULL OR (temp_c         BETWEEN 12  AND 45))  AND
    (cap_refill_sec IS NULL OR (cap_refill_sec BETWEEN 0   AND 30))
  ) NOT VALID;
