-- 229_ipd_orders_admission.sql
--
-- Stage-5 fix chip 6 — IPD orders + admission. One reserved migration
-- number (229) carries the schema deltas for the IPD-ordering findings;
-- sections are appended per-finding as the chip lands them.
--
-- ─── Section 1 — e_prescriptions: admission_id + visit_type ───────────
-- Closes finding:
--   2026-05-09-inpatient-admission-doctor-prescription-no-admission-id
--
-- POST /api/v1/prescriptions/create only ever accepted appointment_id,
-- so an IPD prescription had to be linked to an OPD appointment (a
-- misleading data relationship) and the pharmacy queue / nursing MAR
-- had no IPD-vs-OPD discriminator. Add a nullable admission_id (plain
-- INTEGER, no FK — mirrors how appointment_id is modelled, which
-- carries no Prisma relation either) plus a visit_type discriminator
-- defaulting to 'outpatient' so every existing row reads as OPD.

BEGIN;

ALTER TABLE e_prescriptions
  ADD COLUMN IF NOT EXISTS admission_id INTEGER,
  ADD COLUMN IF NOT EXISTS visit_type   VARCHAR(20) DEFAULT 'outpatient';

-- Partial index — IPD prescription lookups by admission. Partial (only
-- non-null rows) keeps it small and, like migration 223's partial
-- index, stays invisible to `prisma db pull` so schema.prisma carries
-- only the new columns, not the index.
CREATE INDEX IF NOT EXISTS idx_e_prescriptions_admission_id
  ON e_prescriptions(admission_id)
  WHERE admission_id IS NOT NULL;

COMMIT;
