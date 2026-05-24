-- 245_investigations_sample_rejection_audit.sql
--
-- D43 - lab sample collection/barcode/rejection API.
-- Keep rejection as a sample-level audit event on the current investigation
-- row so rejected specimens can be sent back to the collection queue without
-- cancelling the clinical order.

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS sample_rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sample_rejected_by UUID,
  ADD COLUMN IF NOT EXISTS sample_rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_investigations_sample_rejected_at
  ON investigations(sample_rejected_at)
  WHERE sample_rejected_at IS NOT NULL;
