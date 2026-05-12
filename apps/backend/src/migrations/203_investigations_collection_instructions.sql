-- 203_investigations_collection_instructions.sql
-- Wave 4B-2 (finding 2026-05-10-walk-in-opd-patient-lab-order-missing-instructions).
--
-- Lab orders need patient-actionable collection instructions. Today the
-- `investigations` row records test_name + status but nothing tells a
-- walk-in patient WHERE to give the sample, BY WHEN, or whether the
-- test requires fasting. The patient app's "Investigations" tab can
-- only show pending / completed; without these fields the patient has
-- to ask staff or guess where to go and a CBC sample is realistically
-- missed.
--
-- All columns nullable / default-false so the backfill is a no-op for
-- the existing 41+ lab orders. The patient-list endpoints surface them
-- only when populated, so legacy rows render as before.

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS collection_location    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS collection_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fasting_required       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fasting_instructions   TEXT;

COMMENT ON COLUMN investigations.collection_location IS
  'Where the patient should give the sample (e.g. "Lab counter, Block A, Ground floor"). Free text — surfaced verbatim in the patient app.';
COMMENT ON COLUMN investigations.collection_deadline_at IS
  'By when the sample must be collected. Surfaces as a deadline + relative chip in the patient app.';
COMMENT ON COLUMN investigations.fasting_required IS
  'True when the test requires fasting. Surfaces as a prominent banner in the patient app.';
COMMENT ON COLUMN investigations.fasting_instructions IS
  'Free-text fasting / prep instructions shown when fasting_required = TRUE (e.g. "8h water-only fast, no tea or coffee").';
