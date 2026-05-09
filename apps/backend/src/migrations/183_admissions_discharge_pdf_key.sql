-- 183_admissions_discharge_pdf_key.sql
--
-- B-6 — discharge summary PDF persistence.
--
-- Background. clinicalPdfGenerator.generateDischargeSummaryPDF +
-- the route at /api/v1/documents/discharge-summary/:id/pdf already
-- generate and stream a PDF on demand. Fine for live preview, wrong
-- for the patient-app + audit story:
--
--   1. Every download regenerates from current chart state — if a
--      medication is added after the first export the second export
--      diverges from the first. The legal record is whatever the
--      patient walked out with, and that should be immutable post-
--      signoff.
--   2. The patient app needs a stable URL it can show + save. The
--      stream-on-request path doesn't expose a URL.
--   3. Compliance review wants to inspect the snapshot a year later
--      and we can't currently reproduce it byte-for-byte.
--
-- This migration adds `discharge_pdf_key` on admissions. Populated by
-- the persisted-PDF path the first time it's hit post-signoff:
-- generate -> upload to R2 -> stamp key -> return signed URL on every
-- subsequent request.
--
-- Architectural item B-6.

BEGIN;

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS discharge_pdf_key VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_admissions_discharge_pdf_key
  ON admissions(discharge_pdf_key)
  WHERE discharge_pdf_key IS NOT NULL;

COMMIT;
