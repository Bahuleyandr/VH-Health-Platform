-- Unified Care Pathways S1b-c3: append-only reconciliation evidence.
--
-- This migration stores observation receipts only. It does not create a
-- pathway definition, alter tenant settings, repair clinical state, or grant
-- production activation authority.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE care_pathway_reconciliation_checks (
  id                         BIGSERIAL PRIMARY KEY,
  sweep_id                   UUID NOT NULL,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  pathway_key                VARCHAR(120) NOT NULL,
  pathway_mode               VARCHAR(16) NOT NULL,
  registry_version           INTEGER NOT NULL,
  registry_checksum          CHAR(64) NOT NULL,
  governance_checksum        CHAR(64) NOT NULL,
  governance_count           INTEGER NOT NULL,
  covered_governance_count   INTEGER NOT NULL,
  expected_check_count       INTEGER NOT NULL,
  executed_check_count       INTEGER NOT NULL,
  finding_count              INTEGER NOT NULL,
  repair_count               INTEGER NOT NULL,
  error_count                INTEGER NOT NULL,
  registry_complete          BOOLEAN NOT NULL DEFAULT FALSE,
  passed                     BOOLEAN NOT NULL DEFAULT FALSE,
  check_results              JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at                 TIMESTAMPTZ NOT NULL,
  completed_at               TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT care_pathway_reconciliation_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON UPDATE NO ACTION
    ON DELETE NO ACTION,
  CONSTRAINT care_pathway_reconciliation_pathway_key_check
    CHECK (pathway_key IN (
      'diagnostics_order_to_action',
      'referral_request_to_closure',
      'op_contact_to_recovery',
      'inpatient_admission_to_recovery',
      'emergency_arrival_to_aftercare',
      'surgery_decision_to_recovery'
    )),
  CONSTRAINT care_pathway_reconciliation_mode_check
    CHECK (pathway_mode IN ('off', 'shadow', 'active')),
  CONSTRAINT care_pathway_reconciliation_registry_version_check
    CHECK (registry_version > 0),
  CONSTRAINT care_pathway_reconciliation_registry_checksum_check
    CHECK (registry_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT care_pathway_reconciliation_governance_checksum_check
    CHECK (governance_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT care_pathway_reconciliation_counts_check
    CHECK (
      governance_count >= 0
      AND covered_governance_count >= 0
      AND covered_governance_count <= governance_count
      AND expected_check_count >= 0
      AND executed_check_count >= 0
      AND executed_check_count <= expected_check_count
      AND finding_count >= 0
      AND repair_count >= 0
      AND error_count >= 0
    ),
  CONSTRAINT care_pathway_reconciliation_results_check
    CHECK (
      jsonb_typeof(check_results) = 'array'
      AND jsonb_array_length(check_results) <= 200
    ),
  CONSTRAINT care_pathway_reconciliation_time_check
    CHECK (
      completed_at >= started_at
      AND created_at >= started_at
    ),
  CONSTRAINT care_pathway_reconciliation_pass_check
    CHECK (
      NOT passed
      OR (
        pathway_mode = 'shadow'
        AND registry_complete
        AND governance_count > 0
        AND covered_governance_count = governance_count
        AND expected_check_count > 0
        AND executed_check_count = expected_check_count
        AND finding_count = 0
        AND repair_count = 0
        AND error_count = 0
      )
    )
);

CREATE UNIQUE INDEX ux_care_pathway_reconciliation_tenant_id
  ON care_pathway_reconciliation_checks (tenant_id, id);

CREATE UNIQUE INDEX ux_care_pathway_reconciliation_sweep
  ON care_pathway_reconciliation_checks (tenant_id, pathway_key, sweep_id);

CREATE INDEX idx_care_pathway_reconciliation_latest
  ON care_pathway_reconciliation_checks (
    tenant_id, pathway_key, completed_at DESC, id DESC
  );

CREATE INDEX idx_care_pathway_reconciliation_cohort
  ON care_pathway_reconciliation_checks (
    tenant_id, pathway_key, registry_checksum, governance_checksum,
    completed_at DESC, id DESC
  );

ALTER TABLE care_pathway_reconciliation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_pathway_reconciliation_checks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON care_pathway_reconciliation_checks
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

CREATE OR REPLACE FUNCTION care_pathway_reconciliation_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'care pathway reconciliation evidence is append-only'
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_care_pathway_reconciliation_append_only
  BEFORE UPDATE OR DELETE ON care_pathway_reconciliation_checks
  FOR EACH ROW EXECUTE FUNCTION care_pathway_reconciliation_block_mutation();

DO $care_pathway_reconciliation_runtime_grants$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE care_pathway_reconciliation_checks TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE care_pathway_reconciliation_checks FROM %I',
        role_name
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE care_pathway_reconciliation_checks_id_seq TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE UPDATE ON SEQUENCE care_pathway_reconciliation_checks_id_seq FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$care_pathway_reconciliation_runtime_grants$;

COMMIT;
