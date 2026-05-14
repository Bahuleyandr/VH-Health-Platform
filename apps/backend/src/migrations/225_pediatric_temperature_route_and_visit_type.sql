-- 225_pediatric_temperature_route_and_visit_type.sql
--
-- Paediatric-OPD schema gaps surfaced by manual triage. One migration
-- number was reserved for the whole cluster, so two additive concerns
-- ship together here.
--
-- 1. temperature_route — vitals_chart + patient_vitals stored a bare
--    temperature with no record of the measurement route. In paediatrics
--    the route is clinically load-bearing: axillary runs ~0.5 C below
--    oral, so a febrile toddler at 38.5 C axillary vs oral lands in a
--    different fever band and changes antipyretic dosing. Nullable
--    VARCHAR(10), validated in the service layer against
--    oral/axillary/rectal/tympanic (same plain-text-plus-app-validation
--    pattern as the urine dipstick fields from migration 211). Additive,
--    no backfill.
--    Finding: 2026-05-09-pediatric-opd-nurse-no-temperature-route-field.
--
-- 2. appointments_visit_type_check — the constraint (baseline + migration
--    190) still only allowed NEW/FOLLOW_UP/EMERGENCY/TELE. Two values the
--    application already writes were missing and are added here:
--      - LAB_ONLY       — added to the walk-in controller's VALID_VISIT_TYPES
--                         by the lab-walk-in fix, but the matching CHECK
--                         update was never written, so a LAB_ONLY walk-in
--                         would fail the constraint at INSERT time.
--      - PAEDIATRIC_OPD — new value so paediatric visits are distinguishable
--                         from adult OPD downstream (billing, reporting,
--                         weight-based dosing prompts).
--    Finding: 2026-05-09-pediatric-opd-receptionist-no-paediatric-visit-type.

BEGIN;

ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS temperature_route VARCHAR(10);

ALTER TABLE patient_vitals
  ADD COLUMN IF NOT EXISTS temperature_route VARCHAR(10);

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_visit_type_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_visit_type_check
  CHECK (visit_type IS NULL OR visit_type IN
    ('NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE', 'LAB_ONLY', 'PAEDIATRIC_OPD'));

COMMIT;
