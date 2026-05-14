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

-- ─── Section 2 — clinical_orders: structured medication route ─────────
-- Closes finding:
--   2026-05-08-inpatient-admission-doctor-no-route-or-imaging-typing
--
-- The CPOE order schema stuffed the IV/PO/IM route into the free-text
-- `details` JSON with no structure — two doctors writing "IV" vs
-- "i.v." vs "Intravenous" left the MAR / pharmacy unable to group
-- medication orders by route. Add a structured `route` column;
-- orderEntryService normalises the value to a canonical form on write
-- (case- and spelling-insensitive) and mirrors it back into
-- details.route for the existing MAR scheduler.
--
-- Imaging note: the same finding also flagged imaging being conflated
-- with `investigation`. Verified sufficient as-is — the platform has a
-- dedicated radiology subsystem (`radiology_orders`, /api/v1/radiology
-- worklist + modality typing), and Stage-4's ORDER_TYPE_ALIASES already
-- maps radiology/imaging → investigation so a quick CPOE order doesn't
-- 400. A separate CPOE `imaging` order_type would just duplicate the
-- radiology module, so no order_type change is made here.

BEGIN;

ALTER TABLE clinical_orders
  ADD COLUMN IF NOT EXISTS route VARCHAR(20);

COMMIT;

-- ─── Section 3 — admissions: next_review_at (rounding cadence) ────────
-- Closes finding:
--   2026-05-08-inpatient-admission-doctor-no-review-after
--
-- The inpatient-admission journey explicitly asks the consultant to
-- "set review-after: 12 hours" after orders, but no field, endpoint or
-- task could persist it — on-call cross-cover at shift change had
-- nothing to anchor on. Add a nullable next_review_at on the admission;
-- admitPatient accepts it, PUT /emr/admission/:id/next-review sets it
-- post-rounds, and GET /emr/admissions?review_due=true filters the
-- ward-round queue. Partial index — only admissions with a pending
-- review are queried — and, like the indexes above, invisible to
-- `prisma db pull`.

BEGIN;

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS next_review_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_admissions_next_review_at
  ON admissions(next_review_at)
  WHERE next_review_at IS NOT NULL;

COMMIT;
