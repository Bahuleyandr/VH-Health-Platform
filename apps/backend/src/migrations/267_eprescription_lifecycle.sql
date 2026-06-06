-- Add explicit OP/IP prescription lifecycle fields.
-- Prescriptions remain editable while draft, then become signed/locked with
-- audit-traceable ownership.

ALTER TABLE e_prescriptions
  ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signed_by UUID,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by UUID;

CREATE INDEX IF NOT EXISTS idx_e_prescriptions_lifecycle
  ON e_prescriptions(lifecycle_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_e_prescriptions_signed_at
  ON e_prescriptions(signed_at DESC)
  WHERE signed_at IS NOT NULL;
