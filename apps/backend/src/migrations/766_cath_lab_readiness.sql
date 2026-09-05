-- 766_cath_lab_readiness.sql
--
-- Cath-lab pre-procedure lab readiness.
--
-- The `labs` readiness check on a cath case was a bare human tick. Nothing on
-- it said whether the bloods a cath needs existed, had never been ordered, or
-- were drawn and awaiting a result; and a value from an OUTSIDE laboratory had
-- no home at all, because manual lab entry requires an in-house order such a
-- report will never have and had no column to name the laboratory in. These
-- tables and columns are what let the checklist answer both questions from the
-- record instead of from a person's memory.
--
-- The rules the schema is shaped by, stated here in full so this file does not
-- depend on a document to be understood (design note, for history and the
-- wider rationale: docs/superpowers/specs/
-- 2026-09-04-cath-pre-procedure-lab-readiness-design.md):
--
--  1. SEVEN items, and only seven, hang off the one `labs` check: hb, platelets,
--     creatinine, potassium, hiv, hbsag, hcv. They are rows in
--     cath_case_lab_readiness_items (one per case per item_code, uniquely), not
--     eight more check_type values — cath_lab_readiness_checks keeps its eight
--     types unchanged, so every other consumer of the checklist is untouched.
--     Which of the seven are REQUIRED is per tenant
--     (cath_lab_readiness_settings.required_items, at least one enforced by a
--     named CHECK); the rest are shown and never block.
--
--  2. FRESHNESS is per item, not per case. The four analytes age out on the
--     tenant's cath_lab_readiness_settings.lab_validity_days. The three
--     blood-borne markers do NOT: their window is
--     cath_reprocessing_settings.serology_validity_days, the SAME number the
--     device-reprocessing programme uses (migration 765). A tenant that
--     shortened HIV/HBsAg/HCV validity for reuse means the same thing here, and
--     there is deliberately no second serology window in this migration's
--     settings table to drift from it.
--
--  3. AUTOMATION ALTERS ONLY ROWS IT SET. The refresh may move the `labs` check
--     from pending to pass, and may retract a pass it made, but never touches a
--     status a person set by hand: it marks its own work in the check's
--     metadata (auto_managed) and reads that mark before writing. The evidence
--     columns follow the same rule — evidence_owner / source_name /
--     attachment_ref are claimed only on a row automation is moving or already
--     owns, so a consultant's name and attached report survive every later
--     refresh.
--
--  4. A CRITICAL VALUE NEVER BLOCKS. A potassium of 6.9 makes the check WARN
--     (metadata.critical_warning with the offending items) and is surfaced to
--     whoever passes the check; it does not hold the case. Stopping a primary
--     PCI on a number a cardiologist has already seen and decided about is the
--     more dangerous failure — owner decision. is_critical on the item row is
--     that warning's evidence, which is why it is stored rather than recomputed.
--
--  5. EXTERNAL RESULTS ARE UNVERIFIED, and count only when tenant policy says
--     so. A value from another laboratory has not been through this hospital's
--     analyser, QC or pathologist sign-off, so it resolves to its own item state
--     (external_recorded) and satisfies the check ONLY where
--     cath_lab_readiness_settings.external_results_count is true. The tenant
--     that says no still SEES the value; it simply does not clear the gate on it.
--
--  6. lab_results ORIGIN COLUMNS, and who sets them. result_origin ('analyzer' |
--     'manual_in_house' | 'external_lab'), external_lab_name, external_report_ref
--     and external_reported_on are provenance, all nullable so no legacy row is
--     disturbed and no backfill is needed. They are NOT a client's choice: the
--     public manual-result route rejects them outright
--     (middleware/labResultOriginGuard.js) and its service entry point forces
--     'manual_in_house' with the three external columns null. The ONLY writer of
--     an external_lab row is the cath readiness checklist, through a separate
--     internal service entry point that no route imports. Belt and braces at the
--     schema: lab_results_external_origin_check refuses an 'external_lab'
--     row without a non-blank external_lab_name AND an external_reported_on,
--     because an outside value that cannot say where it came from and when is
--     not evidence.
--
-- Forward-only additions:
--   * cath_lab_readiness_settings      — per tenant: required items, validity window,
--                                        auto-pass, whether external results count
--   * cath_case_lab_readiness_items    — persisted snapshot of the seven items per case
--   * lab_results.result_origin / external_lab_name / external_report_ref /
--     external_reported_on             — provenance for outside-lab values; nullable so
--                                        legacy rows are untouched
-- No NOT VALID constraints. Every CHECK is named.
--
-- Every CHECK is named explicitly, for the reason migrations 764 and 765 record:
-- Postgres auto-names a single-column check <table>_<column>_check but a
-- multi-column check <table>_check, <table>_check1, … — positional suffixes that
-- renumber when a check is added or removed.
--
-- Tenant pinning. Every reference out of cath_case_lab_readiness_items is a
-- tenant-pinned COMPOSITE (tenant_id, <column>) foreign key and nothing else:
-- a readiness item can never bind to another tenant's case, result, specimen or
-- order. A second, single-column FK to the same parent would add no isolation
-- and one more lock target, so none is declared. Three of the four parents had
-- no plain (tenant_id, id) unique to point at — cath_lab_cases carries the wider
-- (tenant_id, id, patient_uid) and (tenant_id, id, patient_uid, facility_id),
-- lab_results carries (tenant_id, id, patient_uid), and lab_specimens carries
-- only (tenant_id, accession_number) and (tenant_id, specimen_uid) — so the
-- three indexes below are created first, following the ux_<table>_tenant_id
-- naming migration 765 used for cath_consumable_catalog and
-- cath_case_consumable_usage. `id` is each table's primary key, so all three are
-- trivially satisfiable. investigations already has ux_cc_investigations_tenant_id.
--
-- DEFERRABLE. The three cath_case_consumable_usage composites are DEFERRABLE
-- because they carry patient_uid and a patient merge rewrites that column inside
-- one transaction. No key on this table names a patient, so none of these needs
-- to defer.
--
-- The case FK's ON DELETE CASCADE is a declaration of intent, not a path this
-- deployment exercises: migration 753's identity guard makes cath_lab_cases
-- append-only, so no case row is ever deleted and the cascade never fires. It
-- is declared anyway so a future hard-delete path (a tenant erasure, a merge
-- tool) cannot leave a readiness snapshot orphaned behind it.
--
-- Copy-target widths. value_text VARCHAR(255), unit VARCHAR(40), abnormal_flag
-- VARCHAR(10) and value_numeric NUMERIC(15, 4) below deliberately MIRROR the
-- lab_results columns they are copied from by the refresh. They are not
-- independent choices: widening lab_results.value_text (say) without widening
-- this table would make the refresh fail on the first long value with 22001,
-- inside a cath-case read. Widen the two together.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 1. Tenant-pinned targets for the composite foreign keys declared in section 3
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX ux_cath_lab_cases_tenant_id ON cath_lab_cases (tenant_id, id);
CREATE UNIQUE INDEX ux_lab_results_tenant_id ON lab_results (tenant_id, id);
CREATE UNIQUE INDEX ux_lab_specimens_tenant_id ON lab_specimens (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. Tenant settings
--
-- The defaults ARE the safe state: all seven items required, a 30-day validity
-- window, automation allowed to pass the `labs` check on its own, and an
-- outside-laboratory result accepted as evidence. A tenant that wants a
-- narrower item set, a tighter window, or a human tick on every case edits the
-- row; a tenant that has never looked at the screen still gets the full check.
-- ---------------------------------------------------------------------------
CREATE TABLE cath_lab_readiness_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  required_items TEXT[] NOT NULL DEFAULT ARRAY['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']::text[],
  lab_validity_days INTEGER NOT NULL DEFAULT 30,
  auto_pass BOOLEAN NOT NULL DEFAULT TRUE,
  external_results_count BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- Containment, not equality: a tenant may require fewer items, never an item
  -- the readiness engine has no evaluator for — and never NONE. An empty
  -- required_items array would leave `labs` a check that passes on an empty
  -- set, which is the bare human tick this table exists to replace; a tenant
  -- that wants no lab gate marks the check not required on the case instead.
  CONSTRAINT cath_lab_readiness_settings_items_check
    CHECK (required_items <@ ARRAY['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']::text[]
           AND cardinality(required_items) >= 1),
  CONSTRAINT cath_lab_readiness_settings_validity_check
    CHECK (lab_validity_days BETWEEN 1 AND 365)
);

-- ---------------------------------------------------------------------------
-- 3. The per-case snapshot
--
-- One row per required item per case, UPSERTed by the refresh: seven fixed rows
-- that are rewritten in place, never deleted. `state` is the whole point — the
-- old boolean tick could not distinguish "never ordered" from "sample sent,
-- result pending" from "resulted three months ago", and those three are
-- different conversations with the operator standing at the table.
-- ---------------------------------------------------------------------------
CREATE TABLE cath_case_lab_readiness_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL,
  item_code VARCHAR(20) NOT NULL,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  state VARCHAR(32) NOT NULL,
  value_text VARCHAR(255),
  value_numeric NUMERIC(15, 4),
  unit VARCHAR(40),
  abnormal_flag VARCHAR(10),
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at TIMESTAMPTZ(6),
  source VARCHAR(24),
  lab_result_id INTEGER,
  investigation_id INTEGER,
  specimen_id INTEGER,
  ordered_at TIMESTAMPTZ(6),
  waived_by UUID,
  waived_at TIMESTAMPTZ(6),
  waive_reason TEXT,
  refreshed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_cath_case_lab_readiness_items_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE NO ACTION,
  -- The snapshot belongs to the case: when the case goes, so does it.
  CONSTRAINT fk_cath_case_lab_readiness_items_case
    FOREIGN KEY (tenant_id, case_id) REFERENCES cath_lab_cases (tenant_id, id)
    ON DELETE CASCADE,
  -- A bare ON DELETE SET NULL on a composite foreign key nulls EVERY member
  -- column, and tenant_id is NOT NULL — that delete would raise 23502 instead
  -- of releasing the reference. Postgres 15 added the column list that names
  -- which member columns the action nulls (prod is 17.10), so the tenant pin
  -- and the release live in ONE constraint, exactly as migration 765 did for
  -- cath_reprocessable_devices.current_usage_id. Losing the pointer is the
  -- honest outcome here: the refresh recomputes the item on its next pass and
  -- reports it as not_ordered, rather than the row carrying a dangling id.
  CONSTRAINT fk_cath_case_lab_readiness_items_lab_result
    FOREIGN KEY (tenant_id, lab_result_id) REFERENCES lab_results (tenant_id, id)
    ON DELETE SET NULL (lab_result_id),
  CONSTRAINT fk_cath_case_lab_readiness_items_specimen
    FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab_specimens (tenant_id, id)
    ON DELETE SET NULL (specimen_id),
  CONSTRAINT fk_cath_case_lab_readiness_items_investigation
    FOREIGN KEY (tenant_id, investigation_id) REFERENCES investigations (tenant_id, id)
    ON DELETE SET NULL (investigation_id),
  CONSTRAINT cath_case_lab_readiness_items_code_check
    CHECK (item_code IN ('hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv')),
  CONSTRAINT cath_case_lab_readiness_items_state_check
    CHECK (state IN ('result_final', 'result_preliminary', 'external_recorded', 'sample_sent_awaiting_result',
                     'ordered_awaiting_sample', 'not_ordered', 'stale', 'waived')),
  CONSTRAINT cath_case_lab_readiness_items_source_check
    CHECK (source IS NULL OR source IN ('lab_result', 'external', 'waiver')),
  -- A waiver with no waiver is the failure this table exists to make
  -- impossible: someone clears a missing serology before a case and no name,
  -- clock or reason survives it.
  CONSTRAINT cath_case_lab_readiness_items_waiver_check
    CHECK ((state <> 'waived') OR (waived_by IS NOT NULL AND waived_at IS NOT NULL AND waive_reason IS NOT NULL)),
  CONSTRAINT ux_cath_case_lab_readiness_items UNIQUE (tenant_id, case_id, item_code)
);

-- No separate (tenant_id, case_id) index: that is a strict leading prefix of
-- ux_cath_case_lab_readiness_items (tenant_id, case_id, item_code), which the
-- planner already uses for every per-case lookup. A second index would only
-- add write cost and one more lock target.

-- ---------------------------------------------------------------------------
-- 4. lab_results provenance for outside-laboratory values
--
-- All four columns are nullable and no default is written, so every legacy row
-- keeps result_origin NULL and satisfies both CHECKs unchanged; the migration
-- rewrites no rows.
-- ---------------------------------------------------------------------------
ALTER TABLE lab_results
  ADD COLUMN result_origin VARCHAR(20),
  ADD COLUMN external_lab_name VARCHAR(160),
  ADD COLUMN external_report_ref VARCHAR(120),
  ADD COLUMN external_reported_on DATE;

ALTER TABLE lab_results
  ADD CONSTRAINT lab_results_result_origin_check
    CHECK (result_origin IS NULL OR result_origin IN ('analyzer', 'manual_in_house', 'external_lab')),
  -- IS DISTINCT FROM, not <>: a NULL origin must not make the implication
  -- unknown (and therefore satisfied by nothing being checked at all). An
  -- outside value that cannot name the laboratory it came from or the day it
  -- was reported is not provenance — and neither is a name of spaces, which is
  -- why the test is NULLIF(btrim(...), '') rather than IS NOT NULL.
  ADD CONSTRAINT lab_results_external_origin_check
    CHECK (result_origin IS DISTINCT FROM 'external_lab'
           OR (NULLIF(btrim(external_lab_name), '') IS NOT NULL AND external_reported_on IS NOT NULL));

CREATE INDEX idx_lab_results_external_origin ON lab_results (tenant_id, patient_uid, result_origin)
  WHERE result_origin = 'external_lab';

-- ---------------------------------------------------------------------------
-- 5. RLS on the two new tables
-- ---------------------------------------------------------------------------
ALTER TABLE cath_lab_readiness_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_readiness_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_lab_readiness_settings;
CREATE POLICY tenant_isolation ON cath_lab_readiness_settings
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE cath_case_lab_readiness_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_case_lab_readiness_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_case_lab_readiness_items;
CREATE POLICY tenant_isolation ON cath_case_lab_readiness_items
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

-- ---------------------------------------------------------------------------
-- 5b. Runtime-role grants
--
-- Same to_regrole-guarded shape as migrations 764 and 765: skip a role the
-- deployment never provisioned, so this is a no-op on a single-DSN rig. Both
-- tables are maintained in place — a settings review, and a readiness refresh
-- that UPSERTs the same seven rows per case — so the contract is
-- SELECT + INSERT + UPDATE; DELETE and TRUNCATE stay revoked. The refresh never
-- deletes: an item that stops being required is rewritten with required =
-- FALSE, which keeps the waiver and the clock that produced it.
--
-- This block alone is not the whole story. A tracker-driven migration runs once
-- per database, so on a cluster where the runtime role is provisioned later
-- (CNPG reconciles spec.managed.roles after the first migration pass) the
-- to_regrole guard would skip these grants forever. The boot-time bootstrap in
-- src/lib/prisma.js (ensureTenantRlsRuntimeRoleGrants) re-narrows the runtime
-- role's privileges on EVERY boot after its broad late-provisioning fallback
-- grants, so a table that is not registered there silently keeps those broad
-- privileges. Both tables are registered in that bootstrap's
-- runtime_mutable_no_delete_relations list and
-- cath_case_lab_readiness_items_id_seq in its runtime_nextval_sequences list.
-- ---------------------------------------------------------------------------
DO $cath_lab_readiness_runtime_grants$
DECLARE
  role_name TEXT;
  table_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      FOREACH table_name IN ARRAY ARRAY[
        'cath_lab_readiness_settings',
        'cath_case_lab_readiness_items'
      ]::TEXT[] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', table_name, role_name);
        EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE %I FROM %I', table_name, role_name);
      END LOOP;
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE cath_case_lab_readiness_items_id_seq TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE UPDATE ON SEQUENCE cath_case_lab_readiness_items_id_seq FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cath_lab_readiness_runtime_grants$;

COMMIT;
