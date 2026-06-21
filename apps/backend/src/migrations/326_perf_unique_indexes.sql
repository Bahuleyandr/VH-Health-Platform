-- Migration 326: data-layer perf + uniqueness backstops.
--
-- Audit 2026-06-18 §3 (Data layer — perf + uniqueness, MEDIUM). Two findings:
--
-- (1) HOT PHI TABLES HAVE ONLY A SINGLETON (tenant_id) INDEX.
--     admissions / prescriptions / investigations / patient_vitals each carry
--     both tenant_id and patient_uid and are queried on the RLS hot path
--     "this tenant's rows for this patient" (tenant_id = current_tenant AND
--     patient_uid = :uid). Each had only idx_<t>_tenant_id (tenant_id alone) plus,
--     in some cases, a patient_uid-leading index — but no single index keyed
--     (tenant_id, patient_uid). With only the singleton, Postgres scans every
--     row of the tenant and filters patient_uid in the heap; a patient_uid-first
--     index does not serve the tenant predicate well under RLS. A composite
--     (tenant_id, patient_uid) btree serves both the RLS tenant filter and the
--     per-patient lookup from one index. This is a pure additive perf index — it
--     changes no semantics and can only help the planner.
--
--     medical_records is DELIBERATELY EXCLUDED: it keys patients by patient_id
--     (integer), NOT patient_uid (it has no patient_uid column — verified against
--     the live QA schema), so a (tenant_id, patient_uid) index does not apply.
--     pharmacy_orders is likewise NOT given a (tenant_id, patient_uid) index here
--     for the same reason (it keys by patient_id, not patient_uid).
--
-- (2) GENERATED HUMAN IDENTIFIERS HAVE NO UNIQUENESS CONTRACT.
--     e_prescriptions.prescription_number defaults to 'RX-'||uuid and
--     pharmacy_orders.order_number defaults to 'PO-'||uuid, but NEITHER had a
--     UNIQUE index. The generated default is collision-resistant, but nothing
--     stopped a duplicate: a caller can pass an explicit number, an import can
--     replay one, or a future generator change could collide. In a system where
--     these numbers are printed on prescriptions / pharmacy slips and used as
--     business keys, a silent duplicate is a data-integrity hazard. Both tables
--     carry NOT NULL tenant_id, so the uniqueness contract is tenant-scoped:
--       UNIQUE (tenant_id, <number>) WHERE <number> IS NOT NULL
--     (Two tenants may legitimately mint the same string; a NULL number is
--     "unassigned" and many are allowed — the partial predicate exempts NULLs.)
--
-- DESIGN NOTES (verified against the live QA schema before writing this DDL):
--
--  * COLUMN PRESENCE. `\d` on each table confirmed: admissions, prescriptions,
--    investigations, patient_vitals all have (tenant_id uuid, patient_uid uuid);
--    medical_records + pharmacy_orders have tenant_id but key patients by
--    patient_id (int), so they are excluded from finding (1). e_prescriptions +
--    pharmacy_orders both have a nullable varchar number column with a generated
--    default and a NOT NULL tenant_id, so both get the tenant-scoped partial
--    unique of finding (2).
--
--  * NO CONCURRENTLY. The migration runner wraps every file in one transaction;
--    CREATE INDEX CONCURRENTLY cannot run inside a transaction block. A plain
--    CREATE INDEX / CREATE UNIQUE INDEX validates against existing rows
--    synchronously. All CREATEs are IF NOT EXISTS so re-runs are no-ops.
--
--  * SAFE-ON-EXISTING-DATA. The composite indexes are non-unique and cannot fail
--    on existing data. The two UNIQUE indexes CAN fail if a duplicate already
--    exists, and a plain build would fail with an opaque "could not create unique
--    index" that does not name the colliding rows. The DO-blocks below pre-check
--    for any existing duplicate under the exact predicate the unique index uses
--    and RAISE an actionable error first (naming the tenant + number), so an
--    operator can dedupe before applying. Both were verified collision-free on
--    the QA cluster before writing this migration.

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Composite (tenant_id, patient_uid) indexes on hot PHI tables.
--     Additive, non-unique — cannot fail on existing data.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_admissions_tenant_patient
  ON admissions (tenant_id, patient_uid);

CREATE INDEX IF NOT EXISTS idx_prescriptions_tenant_patient
  ON prescriptions (tenant_id, patient_uid);

CREATE INDEX IF NOT EXISTS idx_investigations_tenant_patient
  ON investigations (tenant_id, patient_uid);

CREATE INDEX IF NOT EXISTS idx_patient_vitals_tenant_patient
  ON patient_vitals (tenant_id, patient_uid);

-- ---------------------------------------------------------------------------
-- (2a) e_prescriptions.prescription_number — tenant-scoped partial unique.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  clash RECORD;
BEGIN
  SELECT tenant_id, prescription_number, count(*) AS n
    INTO clash
    FROM e_prescriptions
   WHERE prescription_number IS NOT NULL
   GROUP BY tenant_id, prescription_number
  HAVING count(*) > 1
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'e_prescriptions already has % rows with prescription_number % in tenant %; dedupe before applying migration 326',
      clash.n, clash.prescription_number, clash.tenant_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_e_prescriptions_tenant_number
  ON e_prescriptions (tenant_id, prescription_number)
  WHERE prescription_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (2b) pharmacy_orders.order_number — tenant-scoped partial unique.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  clash RECORD;
BEGIN
  SELECT tenant_id, order_number, count(*) AS n
    INTO clash
    FROM pharmacy_orders
   WHERE order_number IS NOT NULL
   GROUP BY tenant_id, order_number
  HAVING count(*) > 1
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'pharmacy_orders already has % rows with order_number % in tenant %; dedupe before applying migration 326',
      clash.n, clash.order_number, clash.tenant_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pharmacy_orders_tenant_number
  ON pharmacy_orders (tenant_id, order_number)
  WHERE order_number IS NOT NULL;

COMMIT;
