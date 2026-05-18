-- Migration 235: allow clinically descriptive critical-result read-back methods.
--
-- Finding: 2026-05-15-dynamic-acute-abdomen-doctor-6f4e954e
-- Doctors were entering real-world phrases such as
-- "manual phone read-back to ward nurse and surgical team". The baseline
-- VARCHAR(40) silently turned that into a Postgres value-too-long error,
-- surfaced to the API as a generic 500, and left the critical alert open.
-- Keep the field bounded for UI/reporting, but make room for normal clinical
-- acknowledgement descriptions.

ALTER TABLE lab_critical_alerts
  ALTER COLUMN read_back_method TYPE VARCHAR(160);
