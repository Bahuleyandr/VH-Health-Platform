-- 244_postop_handover_notes.sql
-- Preserve full post-op recovery handover text instead of overloading short disposition fields.
BEGIN;

ALTER TABLE postop_notes
  ADD COLUMN IF NOT EXISTS handover_notes TEXT;

COMMIT;
