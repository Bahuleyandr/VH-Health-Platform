-- 729_tenant_bearing_fks_and_tenant_default_alignment.sql
--
-- Re-audit I (tenancy sweep) — schema deviations left by the 700-727 wave.
--
-- THE DEFECT CLASS. A tenant-bearing child table that references a
-- tenant-bearing parent through a SINGLE-column FK lets a row in tenant A name
-- a parent row owned by tenant B and still satisfy the constraint. The house
-- correction is to carry the tenant into the key — `FOREIGN KEY (tenant_id,
-- child_col) REFERENCES parent (tenant_id, id)` — whose direct precedent is
-- referrals.appointment_id (594:69-71), and which the same 700-727 wave
-- already applies in 704:157, 707:107, 710:101, 713:138, 715:50 and 716:189.
--
-- THE CENSUS. Every FK declared by 700-727 whose child table carries
-- tenant_id, classified. Derived from pg_constraint against a database with
-- the whole migration set applied, not from reading the files — so an FK a
-- later migration replaced is counted in its final shape. The same census is
-- re-derived from prisma/schema.prisma by
-- src/tests/unit/tenantBearingFkMigrationContract.test.js, which fails on any
-- new instance.
--
--   CONVERTED HERE (parent is tenant-bearing, single-column FK):
--     702  abdm_patient_share_intakes.linked_appointment_id → appointments
--     703  abdm_hiu_fetch_sessions.consent_artifact_id  → abdm_consent_artifacts
--     703  abdm_hiu_fetch_sessions.data_transfer_id     → abdm_data_transfers
--     705  uhi_transactions.appointment_id              → appointments
--     722  drug_kb_catalog_links.pharmacy_catalog_id    → pharmacy_catalog
--
--   NOT CONVERTED — the parent is global, so there is no tenant to carry and
--   the single-column form is correct:
--     721  lab_analyzer_code_mappings.catalog_id → investigation_test_catalog
--          (no tenant_id column; the investigation catalog is platform-wide)
--     722  drug_kb_catalog_links.source_key → drug_kb_sources
--          (no tenant_id column; the drug KB stays global, migration 277 stance)
--
--   NOT CONVERTED — outside this migration's declared 700-727 scope. The
--   payment-gateway/SMS slate immediately below the wave (693-699) ships eight
--   more instances of the same class. They are named here so the next pass has
--   the list, and each is carried with this reason on the guard test's
--   exemption list:
--     694  payment_gateway_orders.provider_config_id → payment_gateway_provider_configs
--     694  payment_gateway_orders.invoice_id         → billing_invoices
--     694  payment_gateway_orders.payment_link_id    → billing_payment_links
--     694  payment_gateway_orders.billing_payment_id → billing_payments
--     695  payment_gateway_webhook_events.gateway_order_id → payment_gateway_orders
--     697  payment_gateway_refunds.gateway_order_id  → payment_gateway_orders
--     697  payment_gateway_refunds.billing_refund_id → billing_refunds
--     699  sms_template_registrations.provider_config_id → sms_provider_configs
--          The four billing_* parents additionally have no (tenant_id, id)
--          unique, so converting them means adding a unique index to the
--          legacy money spine — a change that needs its own migration and its
--          own blast-radius review, not a rider on this one.
--
-- LIVENESS. Not everything corrected here is dark. UHI is gated off by env
-- UHI_ENABLED plus tenants.settings.uhi; the drug-KB link tier needs
-- DRUG_KB_DETERMINISTIC_MATCHING plus a per-tenant flag; the analyzer code
-- mappings need LAB_LOINC_MAPPING_ENABLED plus curated rows. But the Scan &
-- Share intake path is LIVE — abdmShareIntakeRoutes is mounted unconditionally
-- at /api/v1/front-desk/abdm/share-intakes (app.js:1227) and
-- abdmShareIntakeService.linkVisitToIntake writes linked_appointment_id today.
-- The HIU fetch path is live too: abdmHiuRoutes is mounted unconditionally at
-- /api/v1/abdm/hiu behind clinical-staff RBAC (app.js:1221-1225), and
-- POST /consents/:artifactId/fetch calls startHiuFetch, which writes both
-- consent_artifact_id and data_transfer_id. So three of the five conversions
-- tighten a live write path rather than a dark one.
--
-- In every case the service already assumes what the composite FK enforces:
--   * uhiAdapterService joins `a.id = t.appointment_id AND a.tenant_id = $1::uuid`.
--   * abdmShareIntakeService.linkVisitToIntake resolves the appointment with
--     `a.id = $1::integer AND a.tenant_id = $2::uuid` before storing it.
--   * abdmHiuService reads the artifact back with
--     `a.id = s.consent_artifact_id AND a.tenant_id = s.tenant_id`, and writes
--     data_transfer_id from a transfer it created under the same tenant id.
--   * drugKbLinkService reads `pc.tenant_id = $1::uuid AND pc.id IN (...)`.
-- The database is only being made to enforce the invariant the code relies on.
--
-- ON DELETE. Every converted FK keeps the disposition it shipped with, but a
-- SET NULL must now name its column: a bare SET NULL on a composite FK nulls
-- *every* referencing column, and tenant_id is NOT NULL, so the parent delete
-- would fail with 23502 instead. `ON DELETE SET NULL (col)` is the PG15+
-- column-list form, already used by 706:24 and 716:191 for exactly this
-- reason. drug_kb_catalog_links keeps CASCADE, which needs no column list.
-- ON UPDATE NO ACTION means re-homing a parent row to another tenant now fails
-- while children exist — the intended fail-closed behaviour.
--
-- PARENT-SIDE UNIQUES. A composite FK needs a matching unique on the parent.
-- appointments already publishes ux_appointments_tenant_id (594:13-14).
-- pharmacy_catalog, abdm_consent_artifacts and abdm_data_transfers did not, so
-- this migration adds one to each first — the same move 594:10-14 made for
-- referrals/appointments. All three parents have `id` as their primary key, so
-- (tenant_id, id) is a superset of an existing unique and the index build
-- cannot fail on duplicates.
--
-- HARDCODED TENANT DEFAULT. lab_analyzer_code_mappings.tenant_id (721) shipped
-- the legacy hardcoded DEFAULT '00000000-...-0001'. It is the only migration
-- at or above 400 that still does; the tables that declare a tenant default
-- since (648:151, 655:105, 682:56-59, and pharmacy_catalog itself) all use the
-- GUC-reading COALESCE, so an omitted
-- tenant_id inherits the request's tenant instead of silently landing on the
-- default tenant — which under the table's own RLS WITH CHECK is a 42501, not
-- a useful error. labCodeMappingService always stamps tenant_id explicitly, so
-- this is latent-trap removal, not a behaviour change. Four pre-400 tables
-- (ledger_accounts 342, ledger_balances 345, appointment_archive 346,
-- reconciliation_checks 349) still carry the bare literal and are left alone;
-- the guard test carries them as named exemptions.
--
-- Preflights fail closed (707 precedent): a cross-tenant row that the old
-- constraints permitted stops the migration instead of being silently nulled
-- or cascaded away.
--
-- Idempotent: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS throughout.

BEGIN;

-- ---------------------------------------------------------------------------
-- Preflights — no cross-tenant row may exist before the keys tighten.
-- ---------------------------------------------------------------------------

DO $uhi_appointment_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM uhi_transactions t
   WHERE t.appointment_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM appointments a
        WHERE a.id = t.appointment_id
          AND a.tenant_id = t.tenant_id
     );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '729 preflight: % uhi_transactions row(s) correlate an appointment owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$uhi_appointment_preflight$;

DO $share_intake_appointment_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM abdm_patient_share_intakes i
   WHERE i.linked_appointment_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM appointments a
        WHERE a.id = i.linked_appointment_id
          AND a.tenant_id = i.tenant_id
     );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '729 preflight: % abdm_patient_share_intakes row(s) link an appointment owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$share_intake_appointment_preflight$;

DO $hiu_consent_artifact_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM abdm_hiu_fetch_sessions s
   WHERE s.consent_artifact_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM abdm_consent_artifacts a
        WHERE a.id = s.consent_artifact_id
          AND a.tenant_id = s.tenant_id
     );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '729 preflight: % abdm_hiu_fetch_sessions row(s) name a consent artifact owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$hiu_consent_artifact_preflight$;

DO $hiu_data_transfer_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM abdm_hiu_fetch_sessions s
   WHERE s.data_transfer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM abdm_data_transfers d
        WHERE d.id = s.data_transfer_id
          AND d.tenant_id = s.tenant_id
     );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '729 preflight: % abdm_hiu_fetch_sessions row(s) name a data transfer owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$hiu_data_transfer_preflight$;

DO $drug_kb_catalog_preflight$
DECLARE
  offending BIGINT;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM drug_kb_catalog_links l
   WHERE NOT EXISTS (
     SELECT 1
       FROM pharmacy_catalog pc
      WHERE pc.id = l.pharmacy_catalog_id
        AND pc.tenant_id = l.tenant_id
   );

  IF offending > 0 THEN
    RAISE EXCEPTION
      '729 preflight: % drug_kb_catalog_links row(s) link a pharmacy_catalog item owned by a different tenant',
      offending
      USING ERRCODE = '23503';
  END IF;
END
$drug_kb_catalog_preflight$;

-- ---------------------------------------------------------------------------
-- 1. uhi_transactions.appointment_id → composite tenant-bearing FK.
-- ---------------------------------------------------------------------------

-- appointments already carries ux_appointments_tenant_id (594:13-14); no new
-- parent-side unique is required here.

ALTER TABLE uhi_transactions
  DROP CONSTRAINT IF EXISTS uhi_transactions_appointment_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_uhi_txn_appointment,
  ADD CONSTRAINT fk_uhi_txn_appointment
    FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES appointments (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE SET NULL (appointment_id);

-- 717 FK-supporting-index convention: the referencing side of the composite
-- key, so an appointment delete does not seq-scan the ledger. 705's
-- idx_uhi_txn_appointment (appointment_id alone) is left in place untouched —
-- dropping it is outside this correction and costs nothing to keep.
CREATE INDEX IF NOT EXISTS idx_uhi_txn_tenant_appointment
  ON uhi_transactions (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

COMMENT ON COLUMN uhi_transactions.appointment_id IS
  'Appointment booked by the confirm leg, keyed WITH the tenant (fk_uhi_txn_appointment → appointments (tenant_id, id)) so a ledger row can never correlate another tenant''s appointment. ON DELETE SET NULL names only this column because tenant_id is NOT NULL; booking_snapshot survives as the evidence.';

-- ---------------------------------------------------------------------------
-- 2. abdm_patient_share_intakes.linked_appointment_id → composite FK.
--
-- 702:58 shipped `INTEGER REFERENCES appointments(id) ON DELETE SET NULL`
-- while the very same CREATE TABLE gave matched_patient_uid the composite form
-- (702:70-72). 716:187-191 later rebuilt that patient FK with the column-list
-- SET NULL; this brings the appointment link to the same shape.
-- ---------------------------------------------------------------------------

ALTER TABLE abdm_patient_share_intakes
  DROP CONSTRAINT IF EXISTS abdm_patient_share_intakes_linked_appointment_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_abdm_share_intake_linked_appointment,
  ADD CONSTRAINT fk_abdm_share_intake_linked_appointment
    FOREIGN KEY (tenant_id, linked_appointment_id)
    REFERENCES appointments (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE SET NULL (linked_appointment_id);

-- 702 shipped no index on linked_appointment_id at all, so this is the only
-- support an appointment delete has for the SET NULL scan (717 convention).
CREATE INDEX IF NOT EXISTS idx_abdm_share_intake_tenant_appointment
  ON abdm_patient_share_intakes (tenant_id, linked_appointment_id)
  WHERE linked_appointment_id IS NOT NULL;

COMMENT ON COLUMN abdm_patient_share_intakes.linked_appointment_id IS
  'OP visit attached to this intake, keyed WITH the tenant (fk_abdm_share_intake_linked_appointment → appointments (tenant_id, id)). linkVisitToIntake already resolves the appointment under an explicit tenant predicate; the composite FK makes the database enforce it. ON DELETE SET NULL names only this column because tenant_id is NOT NULL, and no CHECK requires the link to survive — the intake keeps its status and resolution evidence.';

-- ---------------------------------------------------------------------------
-- 3. abdm_hiu_fetch_sessions.consent_artifact_id / .data_transfer_id →
--    composite tenant-bearing FKs.
--
-- 703:43-46 shipped both as single-column. abdm_consent_artifacts and
-- abdm_data_transfers are both tenant-bearing (124 abdmFull layer), and 707
-- had already moved the sibling child keys on this table's own descendants to
-- the composite form (707:107, 707:414) — these two were simply missed.
-- ---------------------------------------------------------------------------

-- Parent-side uniques. `id` is the primary key of both tables, so these are
-- supersets of an existing unique and cannot fail on duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS ux_abdm_consent_artifacts_tenant_id
  ON abdm_consent_artifacts (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_abdm_data_transfers_tenant_id
  ON abdm_data_transfers (tenant_id, id);

ALTER TABLE abdm_hiu_fetch_sessions
  DROP CONSTRAINT IF EXISTS abdm_hiu_fetch_sessions_consent_artifact_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_abdm_hiu_fetch_consent_artifact,
  ADD CONSTRAINT fk_abdm_hiu_fetch_consent_artifact
    FOREIGN KEY (tenant_id, consent_artifact_id)
    REFERENCES abdm_consent_artifacts (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE SET NULL (consent_artifact_id);

ALTER TABLE abdm_hiu_fetch_sessions
  DROP CONSTRAINT IF EXISTS abdm_hiu_fetch_sessions_data_transfer_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_abdm_hiu_fetch_data_transfer,
  ADD CONSTRAINT fk_abdm_hiu_fetch_data_transfer
    FOREIGN KEY (tenant_id, data_transfer_id)
    REFERENCES abdm_data_transfers (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE SET NULL (data_transfer_id);

-- 717 convention. 703's idx_abdm_hiu_fetch_artifact (consent_artifact_id
-- alone) is left in place; 703 shipped no index at all for data_transfer_id.
CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_tenant_artifact
  ON abdm_hiu_fetch_sessions (tenant_id, consent_artifact_id)
  WHERE consent_artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_tenant_transfer
  ON abdm_hiu_fetch_sessions (tenant_id, data_transfer_id)
  WHERE data_transfer_id IS NOT NULL;

COMMENT ON COLUMN abdm_hiu_fetch_sessions.consent_artifact_id IS
  'HIU consent artifact this fetch txn draws its authority from, keyed WITH the tenant (fk_abdm_hiu_fetch_consent_artifact → abdm_consent_artifacts (tenant_id, id)). abdmHiuService already joins a.tenant_id = s.tenant_id on every read-back. ON DELETE SET NULL names only this column because tenant_id is NOT NULL.';
COMMENT ON COLUMN abdm_hiu_fetch_sessions.data_transfer_id IS
  'Inbound abdm_data_transfers ledger row for this txn, keyed WITH the tenant (fk_abdm_hiu_fetch_data_transfer → abdm_data_transfers (tenant_id, id)). The transfer is created under the same tenant id in the same request, so the composite FK only enforces what the service already guarantees.';

-- ---------------------------------------------------------------------------
-- 4. drug_kb_catalog_links.pharmacy_catalog_id → composite tenant-bearing FK.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_catalog_tenant_id
  ON pharmacy_catalog (tenant_id, id);

ALTER TABLE drug_kb_catalog_links
  DROP CONSTRAINT IF EXISTS drug_kb_catalog_links_pharmacy_catalog_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_drug_kb_catalog_links_catalog,
  ADD CONSTRAINT fk_drug_kb_catalog_links_catalog
    FOREIGN KEY (tenant_id, pharmacy_catalog_id)
    REFERENCES pharmacy_catalog (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE;

-- The live-unique index is partial (WHERE is_active) and so cannot serve the
-- cascade lookup for retired links; add the plain composite (717 convention).
CREATE INDEX IF NOT EXISTS idx_drug_kb_catalog_links_tenant_catalog
  ON drug_kb_catalog_links (tenant_id, pharmacy_catalog_id);

COMMENT ON COLUMN drug_kb_catalog_links.pharmacy_catalog_id IS
  'Formulary item this link resolves, keyed WITH the tenant (fk_drug_kb_catalog_links_catalog → pharmacy_catalog (tenant_id, id)). The drug KB itself stays global (migration 277 stance); only the catalog side is tenant-scoped.';

-- ---------------------------------------------------------------------------
-- 5. lab_analyzer_code_mappings.tenant_id → GUC-reading DEFAULT.
-- ---------------------------------------------------------------------------

ALTER TABLE lab_analyzer_code_mappings
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

COMMENT ON COLUMN lab_analyzer_code_mappings.tenant_id IS
  'Owning tenant. DEFAULT reads app.current_tenant_id (house idiom since 648/655/682) so an omitted tenant_id inherits the request context instead of silently landing on the default tenant and tripping this table''s own RLS WITH CHECK with a 42501. labCodeMappingService always stamps it explicitly.';

-- ---------------------------------------------------------------------------
-- Applied marker.
-- ---------------------------------------------------------------------------

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_BEARING_FK_ALIGNMENT_APPLIED',
  'schema',
  'migration_729',
  jsonb_build_object(
    'migration', '729_tenant_bearing_fks_and_tenant_default_alignment.sql',
    'reason', 'Re-audit I tenancy sweep: every single-column FK from a tenant-bearing 700-727 table to a tenant-bearing parent converted to the composite (tenant_id, id) form (594 precedent) — abdm_patient_share_intakes.linked_appointment_id, abdm_hiu_fetch_sessions.consent_artifact_id, abdm_hiu_fetch_sessions.data_transfer_id, uhi_transactions.appointment_id, drug_kb_catalog_links.pharmacy_catalog_id; lab_analyzer_code_mappings.tenant_id moved off the legacy hardcoded default to the GUC-reading idiom.',
    'converted', jsonb_build_array(
      'abdm_patient_share_intakes.linked_appointment_id',
      'abdm_hiu_fetch_sessions.consent_artifact_id',
      'abdm_hiu_fetch_sessions.data_transfer_id',
      'uhi_transactions.appointment_id',
      'drug_kb_catalog_links.pharmacy_catalog_id'
    )
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_BEARING_FK_ALIGNMENT_APPLIED'
    AND resource_id = 'migration_729'
);

COMMIT;
