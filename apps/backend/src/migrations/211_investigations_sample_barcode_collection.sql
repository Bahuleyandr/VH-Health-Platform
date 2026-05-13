-- 211_investigations_sample_barcode_collection.sql
--
-- Wave-5 batch-3 — lab sample collection audit.
--
-- The `investigations` table already had `collected_at` + `collected_by`
-- columns (added in migration 088 / SELECT-drift sweep). Nothing ever
-- wrote to them — `markCollected` updated `investigation_bookings`
-- only, and one of the legacy SELECTs aliased `requested_at AS
-- sample_collected_at` to paper over the gap. Lab walk-ins (no
-- booking) had no collection event at all.
--
-- Findings:
--   2026-05-10-lab-walk-in-lab-tech-no-sample-barcode-audit
--   2026-05-10-obstetric-anc-lab-tech-collected-time-missing
--
-- This migration adds:
--   * investigations.sample_barcode — printable 1D barcode minted at
--     collection time. Format: INV-<id-base36>-<6-char-random-base36>.
--     Optional; legacy rows backfill to NULL.
--   * investigations.collected_notes — free-text notes from the
--     phlebotomist (e.g. "haemolysed — needs redraw").
--   * investigations.verified_at / verified_by — distinct from
--     collected; lab supervisor counter-signature for high-acuity
--     tests (cross-match, paeds blood gas, etc).
--
-- Indexes:
--   * partial unique on (sample_barcode) where NOT NULL — barcodes
--     must be unique once minted; legacy nulls don't collide.
--   * partial on (collected_at) where NOT NULL — the lab dashboard
--     filters "samples awaiting result upload" by collected-but-not-
--     yet-uploaded; current state.

BEGIN;

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS sample_barcode    VARCHAR(40),
  ADD COLUMN IF NOT EXISTS collected_notes   TEXT,
  ADD COLUMN IF NOT EXISTS verified_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by       UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_investigations_sample_barcode
  ON investigations(sample_barcode)
  WHERE sample_barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_investigations_collected_pending_upload
  ON investigations(collected_at)
  WHERE collected_at IS NOT NULL AND result_uploaded_at IS NULL;

COMMIT;
