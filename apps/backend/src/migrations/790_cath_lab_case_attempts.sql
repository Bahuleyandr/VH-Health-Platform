-- Additive cath readiness expansion only. No legacy attribution, reset,
-- backfill, Start enforcement or activation is performed by this migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

ALTER TABLE cath_lab_cases
  ADD COLUMN procedure_attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN lifecycle_token UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN attempt_started_at TIMESTAMPTZ(6),
  ADD COLUMN attempt_start_recorded_at TIMESTAMPTZ(6),
  ADD COLUMN attempt_start_time_provenance TEXT,
  ADD COLUMN lab_readiness_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN lab_readiness_policy_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN lab_readiness_dirty BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE cath_lab_consent_policy_versions (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  authority_codes TEXT[] NOT NULL,
  scopes TEXT[] NOT NULL,
  modes_by_authority JSONB NOT NULL,
  ordinary_evidence_types TEXT[] NOT NULL,
  emergency_evidence_types TEXT[] NOT NULL,
  representative_evidence_types TEXT[] NOT NULL,
  evidence_owner_roles TEXT[] NOT NULL,
  allow_prior_attempt_evidence BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID,
  approved_at TIMESTAMPTZ(6),
  revoked_by UUID,
  revoked_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, version),
  CONSTRAINT cath_consent_policy_version_check CHECK (btrim(version) <> ''),
  CONSTRAINT cath_consent_policy_state_check CHECK (state IN ('draft', 'approved', 'revoked')),
  CONSTRAINT cath_consent_policy_approval_check CHECK (
    (state = 'draft' AND approved_by IS NULL AND approved_at IS NULL AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (state = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE FUNCTION cath_consent_policy_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Consent policy identities cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.version IS DISTINCT FROM OLD.version
     OR (OLD.state <> 'draft' AND
       ((to_jsonb(NEW) - ARRAY['state','revoked_by','revoked_at']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['state','revoked_by','revoked_at'])
        OR NOT (NEW.state = OLD.state OR (OLD.state = 'approved' AND NEW.state = 'revoked'))))
     OR (OLD.state = 'revoked' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Approved consent policy rules and identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cath_consent_policy_identity_guard
BEFORE UPDATE OR DELETE ON cath_lab_consent_policy_versions
FOR EACH ROW EXECUTE FUNCTION cath_consent_policy_identity_guard();

CREATE TABLE cath_lab_attempt_readiness_records (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  case_id BIGINT NOT NULL,
  procedure_attempt INTEGER NOT NULL,
  check_type TEXT NOT NULL,
  lifecycle_token UUID NOT NULL,
  attempt_started_at TIMESTAMPTZ(6),
  attempt_start_recorded_at TIMESTAMPTZ(6),
  current_status TEXT NOT NULL DEFAULT 'pending',
  current_completed_at TIMESTAMPTZ(6),
  current_completed_by UUID,
  current_metadata JSONB NOT NULL DEFAULT '{}',
  current_evidence_refs JSONB NOT NULL DEFAULT '[]',
  at_start_status TEXT,
  at_start_completed_at TIMESTAMPTZ(6),
  at_start_completed_by UUID,
  at_start_metadata JSONB,
  at_start_evidence_refs JSONB,
  at_start_recorded_at TIMESTAMPTZ(6),
  server_provenance TEXT NOT NULL,
  policy_version TEXT,
  legacy_historical_authority JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, case_id, procedure_attempt, check_type),
  CONSTRAINT cath_attempt_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES cath_lab_cases(tenant_id, id),
  CONSTRAINT cath_attempt_policy_fk FOREIGN KEY (tenant_id, policy_version)
    REFERENCES cath_lab_consent_policy_versions(tenant_id, version),
  CONSTRAINT cath_attempt_number_check CHECK (procedure_attempt > 0),
  CONSTRAINT cath_attempt_type_check CHECK (check_type IN ('consent', 'timeout')),
  CONSTRAINT cath_attempt_status_check CHECK (current_status IN ('pending','pass','fail','waived','not_applicable')),
  CONSTRAINT cath_attempt_pending_check CHECK (current_status <> 'pending' OR (current_completed_at IS NULL AND current_completed_by IS NULL)),
  CONSTRAINT cath_attempt_snapshot_status_check CHECK (at_start_status IN ('pending','pass','fail','waived','not_applicable'))
);
CREATE INDEX idx_cath_attempt_policy ON cath_lab_attempt_readiness_records(tenant_id, policy_version);

CREATE FUNCTION cath_attempt_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Attempt history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.tenant_id, NEW.case_id, NEW.procedure_attempt, NEW.check_type) IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.case_id, OLD.procedure_attempt, OLD.check_type)
     OR (OLD.at_start_recorded_at IS NOT NULL AND
       ROW(NEW.at_start_status, NEW.at_start_completed_at, NEW.at_start_completed_by,
           NEW.at_start_metadata, NEW.at_start_evidence_refs, NEW.at_start_recorded_at,
           NEW.attempt_started_at, NEW.attempt_start_recorded_at, NEW.lifecycle_token)
       IS DISTINCT FROM
       ROW(OLD.at_start_status, OLD.at_start_completed_at, OLD.at_start_completed_by,
           OLD.at_start_metadata, OLD.at_start_evidence_refs, OLD.at_start_recorded_at,
           OLD.attempt_started_at, OLD.attempt_start_recorded_at, OLD.lifecycle_token)) THEN
    RAISE EXCEPTION 'Attempt identity and at-start evidence are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cath_attempt_snapshot_guard BEFORE UPDATE OR DELETE
ON cath_lab_attempt_readiness_records FOR EACH ROW EXECUTE FUNCTION cath_attempt_snapshot_guard();

ALTER TABLE cath_procedure_logs
  ADD COLUMN procedure_attempt INTEGER,
  ADD COLUMN lifecycle_token UUID,
  ADD COLUMN log_command_id UUID,
  ADD COLUMN start_command_id UUID,
  ADD COLUMN identity_source TEXT,
  ADD COLUMN supersedes_log_id BIGINT,
  ADD CONSTRAINT cath_log_attempt_check CHECK (procedure_attempt > 0),
  ADD CONSTRAINT cath_log_revision_identity_check CHECK
    (supersedes_log_id IS NULL OR (procedure_attempt IS NOT NULL AND lifecycle_token IS NOT NULL));
CREATE UNIQUE INDEX ux_cath_log_attempt_identity ON cath_procedure_logs(tenant_id, case_id, procedure_attempt, id);
CREATE UNIQUE INDEX ux_cath_log_revision_child ON cath_procedure_logs(tenant_id, case_id, procedure_attempt, supersedes_log_id);
CREATE UNIQUE INDEX ux_cath_log_command ON cath_procedure_logs(tenant_id, case_id, log_command_id);
ALTER TABLE cath_procedure_logs ADD CONSTRAINT cath_log_revision_parent_fk
  FOREIGN KEY (tenant_id, case_id, procedure_attempt, supersedes_log_id)
  REFERENCES cath_procedure_logs(tenant_id, case_id, procedure_attempt, id);

ALTER TABLE cath_case_lab_readiness_items
  ADD COLUMN unavailability_cause TEXT,
  ADD COLUMN evidence_fingerprint TEXT,
  ADD COLUMN policy_fingerprint TEXT,
  ADD COLUMN accepted_evidence JSONB,
  ADD COLUMN classifier_initialized BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE audit_logs ADD COLUMN cath_start_recorded_at TIMESTAMPTZ(6);
CREATE INDEX idx_audit_cath_start_recording ON audit_logs(tenant_id, action, cath_start_recorded_at DESC, id DESC);

ALTER TABLE cath_lab_attempt_readiness_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_attempt_readiness_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cath_lab_attempt_readiness_records
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
CREATE POLICY tenant_context_required ON cath_lab_attempt_readiness_records
  AS RESTRICTIVE FOR ALL
  USING (app_current_tenant_id_uuid() IS NOT NULL);

ALTER TABLE cath_lab_consent_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_consent_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cath_lab_consent_policy_versions
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
CREATE POLICY tenant_context_required ON cath_lab_consent_policy_versions
  AS RESTRICTIVE FOR ALL
  USING (app_current_tenant_id_uuid() IS NOT NULL);

DO $$
BEGIN
  IF to_regrole('vhhealth_app') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON cath_lab_attempt_readiness_records, cath_lab_consent_policy_versions TO vhhealth_app;
    REVOKE DELETE, TRUNCATE ON cath_lab_attempt_readiness_records, cath_lab_consent_policy_versions FROM vhhealth_app;
  END IF;
END;
$$;
COMMIT;
