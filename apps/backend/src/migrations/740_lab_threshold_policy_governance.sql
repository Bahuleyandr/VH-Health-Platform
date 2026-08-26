-- 740_lab_threshold_policy_governance.sql
--
-- SAFE-01: clinically governed laboratory reference ranges and critical limits.
--
-- The legacy lab_reference_ranges and lab_critical_thresholds tables are two
-- independently mutable halves of one clinical policy.  They are seeded only
-- for the founding tenant, have no signed lifecycle, and cannot prove facility,
-- specimen, unit, or demographic coverage.  This migration adds the immutable
-- catalogue revision, signed policy-bundle, rule, and unmatched-result evidence
-- needed to make absence explicit.  It does not copy or approve any threshold.

BEGIN;

CREATE TABLE IF NOT EXISTS lab_threshold_catalog_states (
  tenant_id          UUID NOT NULL,
  facility_id        INTEGER NOT NULL,
  current_revision   INTEGER NOT NULL DEFAULT 0,
  updated_by         UUID NOT NULL,
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, facility_id),
  CONSTRAINT chk_lab_threshold_catalog_revision_nonnegative
    CHECK (current_revision >= 0),
  CONSTRAINT fk_lab_threshold_catalog_state_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_catalog_state_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_catalog_state_actor
    FOREIGN KEY (tenant_id, updated_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS lab_threshold_catalog_entries (
  id                    UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  facility_id           INTEGER NOT NULL,
  introduced_revision   INTEGER NOT NULL,
  retired_revision      INTEGER,
  test_code             VARCHAR(50) NOT NULL,
  loinc_code            VARCHAR(20),
  test_name             VARCHAR(255) NOT NULL,
  specimen_type         VARCHAR(80) NOT NULL,
  evaluation_mode       VARCHAR(24) NOT NULL DEFAULT 'numeric_threshold',
  unit                  VARCHAR(40),
  normalized_unit       VARCHAR(40),
  sex                   VARCHAR(10),
  age_min_days          INTEGER,
  age_max_days          INTEGER,
  pregnancy_scope       VARCHAR(20) NOT NULL DEFAULT 'all',
  criticality_required  BOOLEAN NOT NULL DEFAULT TRUE,
  exemption_reason      VARCHAR(1000),
  created_by            UUID NOT NULL,
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  retired_by            UUID,
  retired_at            TIMESTAMPTZ(6),
  retirement_reason     VARCHAR(500),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_lab_threshold_catalog_entry_facility
    UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT chk_lab_threshold_catalog_entry_revision
    CHECK (
      introduced_revision > 0
      AND (retired_revision IS NULL OR retired_revision > introduced_revision)
    ),
  CONSTRAINT chk_lab_threshold_catalog_entry_identity
    CHECK (btrim(test_code) <> '' AND btrim(test_name) <> ''),
  CONSTRAINT chk_lab_threshold_catalog_entry_specimen
    CHECK (btrim(specimen_type) <> ''),
  CONSTRAINT chk_lab_threshold_catalog_entry_evaluation_mode
    CHECK (evaluation_mode IN ('numeric_threshold', 'qualitative_exempt')),
  CONSTRAINT chk_lab_threshold_catalog_entry_mode_evidence
    CHECK (
      (evaluation_mode = 'numeric_threshold'
        AND unit IS NOT NULL AND btrim(unit) <> ''
        AND normalized_unit IS NOT NULL AND btrim(normalized_unit) <> ''
        AND exemption_reason IS NULL)
      OR
      (evaluation_mode = 'qualitative_exempt'
        AND unit IS NULL AND normalized_unit IS NULL
        AND criticality_required = FALSE
        AND exemption_reason IS NOT NULL AND btrim(exemption_reason) <> '')
    ),
  CONSTRAINT chk_lab_threshold_catalog_entry_sex
    CHECK (sex IS NULL OR sex IN ('M', 'F', 'X', 'U')),
  CONSTRAINT chk_lab_threshold_catalog_entry_age
    CHECK (
      (age_min_days IS NULL OR age_min_days >= 0)
      AND (age_max_days IS NULL OR age_max_days > 0)
      AND (
        age_min_days IS NULL OR age_max_days IS NULL
        OR age_max_days > age_min_days
      )
    ),
  CONSTRAINT chk_lab_threshold_catalog_entry_pregnancy
    CHECK (pregnancy_scope IN ('all', 'pregnant', 'not_pregnant')),
  CONSTRAINT chk_lab_threshold_catalog_entry_retirement
    CHECK (
      (retired_revision IS NULL AND retired_by IS NULL AND retired_at IS NULL
        AND retirement_reason IS NULL)
      OR
      (retired_revision IS NOT NULL AND retired_by IS NOT NULL
        AND retired_at IS NOT NULL AND retirement_reason IS NOT NULL
        AND btrim(retirement_reason) <> '')
    ),
  CONSTRAINT fk_lab_threshold_catalog_entry_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_catalog_entry_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_catalog_entry_creator
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_catalog_entry_retirer
    FOREIGN KEY (tenant_id, retired_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_threshold_catalog_entry_live_scope
  ON lab_threshold_catalog_entries (
    tenant_id,
    facility_id,
    upper(test_code),
    COALESCE(loinc_code, ''),
    lower(specimen_type),
    COALESCE(normalized_unit, '*'),
    COALESCE(sex, '*'),
    COALESCE(age_min_days, -1),
    COALESCE(age_max_days, -1),
    pregnancy_scope
  )
  WHERE retired_revision IS NULL;

CREATE INDEX IF NOT EXISTS idx_lab_threshold_catalog_entry_revision
  ON lab_threshold_catalog_entries (
    tenant_id, facility_id, introduced_revision, retired_revision
  );

CREATE TABLE IF NOT EXISTS lab_threshold_policy_bundles (
  id                           UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                    UUID NOT NULL,
  facility_id                  INTEGER NOT NULL,
  bundle_version               INTEGER NOT NULL,
  catalog_revision             INTEGER NOT NULL,
  lifecycle_status             VARCHAR(24) NOT NULL DEFAULT 'draft',
  source_reference             VARCHAR(500),
  content_sha256               CHAR(64),
  effective_from               TIMESTAMPTZ(6),
  effective_until              TIMESTAMPTZ(6),
  created_by                   UUID NOT NULL,
  created_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  submitted_by                 UUID,
  submitted_at                 TIMESTAMPTZ(6),
  approved_by                  UUID,
  approved_at                  TIMESTAMPTZ(6),
  approval_reason              VARCHAR(1000),
  approval_evidence_reference  VARCHAR(500),
  approval_evidence_sha256     CHAR(64),
  activated_by                 UUID,
  activated_at                 TIMESTAMPTZ(6),
  superseded_by_bundle_id      UUID,
  superseded_at                TIMESTAMPTZ(6),
  rejected_by                  UUID,
  rejected_at                  TIMESTAMPTZ(6),
  rejection_reason             VARCHAR(1000),
  metadata                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_lab_threshold_policy_bundle_facility
    UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_lab_threshold_policy_bundle_version
    UNIQUE (tenant_id, facility_id, bundle_version),
  CONSTRAINT uq_lab_threshold_policy_bundle_successor_once
    UNIQUE (tenant_id, facility_id, superseded_by_bundle_id),
  CONSTRAINT chk_lab_threshold_policy_bundle_version
    CHECK (bundle_version > 0 AND catalog_revision >= 0),
  CONSTRAINT chk_lab_threshold_policy_bundle_status
    CHECK (lifecycle_status IN (
      'draft', 'in_review', 'approved', 'active', 'superseded', 'rejected'
    )),
  CONSTRAINT chk_lab_threshold_policy_bundle_content_sha
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_lab_threshold_policy_bundle_approval_sha
    CHECK (
      approval_evidence_sha256 IS NULL
      OR approval_evidence_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_effective_window
    CHECK (
      effective_from IS NULL OR effective_until IS NULL
      OR effective_until > effective_from
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_submission
    CHECK (
      (submitted_by IS NULL AND submitted_at IS NULL)
      OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_approval
    CHECK (
      (approved_by IS NULL AND approved_at IS NULL AND approval_reason IS NULL
        AND approval_evidence_reference IS NULL AND approval_evidence_sha256 IS NULL)
      OR
      (approved_by IS NOT NULL AND approved_at IS NOT NULL
        AND approval_reason IS NOT NULL AND btrim(approval_reason) <> ''
        AND approval_evidence_reference IS NOT NULL
        AND btrim(approval_evidence_reference) <> ''
        AND approval_evidence_sha256 IS NOT NULL
        AND submitted_by IS NOT NULL
        AND approved_by <> submitted_by
        AND approved_by <> created_by)
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_activation
    CHECK (
      (activated_by IS NULL AND activated_at IS NULL)
      OR (activated_by IS NOT NULL AND activated_at IS NOT NULL
        AND approved_by IS NOT NULL
        AND activated_by <> approved_by
        AND activated_by <> submitted_by
        AND activated_by <> created_by)
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_supersession
    CHECK (
      (superseded_by_bundle_id IS NULL AND superseded_at IS NULL)
      OR (superseded_by_bundle_id IS NOT NULL AND superseded_at IS NOT NULL)
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_rejection
    CHECK (
      (rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
      OR
      (rejected_by IS NOT NULL AND rejected_at IS NOT NULL
        AND rejection_reason IS NOT NULL AND btrim(rejection_reason) <> '')
    ),
  CONSTRAINT chk_lab_threshold_policy_bundle_lifecycle_evidence
    CHECK (
      (lifecycle_status = 'draft'
        AND source_reference IS NULL AND content_sha256 IS NULL
        AND effective_from IS NULL AND effective_until IS NULL
        AND submitted_by IS NULL AND approved_by IS NULL
        AND activated_by IS NULL AND superseded_by_bundle_id IS NULL
        AND rejected_by IS NULL)
      OR
      (lifecycle_status = 'in_review'
        AND source_reference IS NOT NULL AND btrim(source_reference) <> ''
        AND content_sha256 IS NOT NULL AND effective_from IS NOT NULL
        AND submitted_by IS NOT NULL AND approved_by IS NULL
        AND activated_by IS NULL AND superseded_by_bundle_id IS NULL
        AND rejected_by IS NULL)
      OR
      (lifecycle_status = 'approved'
        AND source_reference IS NOT NULL AND btrim(source_reference) <> ''
        AND content_sha256 IS NOT NULL AND effective_from IS NOT NULL
        AND submitted_by IS NOT NULL AND approved_by IS NOT NULL
        AND activated_by IS NULL AND superseded_by_bundle_id IS NULL
        AND rejected_by IS NULL)
      OR
      (lifecycle_status = 'active'
        AND source_reference IS NOT NULL AND btrim(source_reference) <> ''
        AND content_sha256 IS NOT NULL AND effective_from IS NOT NULL
        AND submitted_by IS NOT NULL AND approved_by IS NOT NULL
        AND activated_by IS NOT NULL AND superseded_by_bundle_id IS NULL
        AND rejected_by IS NULL)
      OR
      (lifecycle_status = 'superseded'
        AND source_reference IS NOT NULL AND btrim(source_reference) <> ''
        AND content_sha256 IS NOT NULL AND effective_from IS NOT NULL
        AND submitted_by IS NOT NULL AND approved_by IS NOT NULL
        AND activated_by IS NOT NULL AND superseded_by_bundle_id IS NOT NULL
        AND rejected_by IS NULL)
      OR
      (lifecycle_status = 'rejected'
        AND source_reference IS NOT NULL AND btrim(source_reference) <> ''
        AND content_sha256 IS NOT NULL AND effective_from IS NOT NULL
        AND submitted_by IS NOT NULL AND approved_by IS NULL
        AND activated_by IS NULL AND superseded_by_bundle_id IS NULL
        AND rejected_by IS NOT NULL)
    ),
  CONSTRAINT fk_lab_threshold_policy_bundle_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_policy_bundle_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_policy_bundle_creator
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_policy_bundle_submitter
    FOREIGN KEY (tenant_id, submitted_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_policy_bundle_approver
    FOREIGN KEY (tenant_id, approved_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_policy_bundle_activator
    FOREIGN KEY (tenant_id, activated_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_policy_bundle_rejector
    FOREIGN KEY (tenant_id, rejected_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_policy_bundle_successor
    FOREIGN KEY (tenant_id, facility_id, superseded_by_bundle_id)
    REFERENCES lab_threshold_policy_bundles(tenant_id, facility_id, id)
    ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_threshold_policy_bundle_active
  ON lab_threshold_policy_bundles (tenant_id, facility_id)
  WHERE lifecycle_status = 'active';

CREATE INDEX IF NOT EXISTS idx_lab_threshold_policy_bundle_lifecycle
  ON lab_threshold_policy_bundles (
    tenant_id, facility_id, lifecycle_status, bundle_version DESC
  );

CREATE TABLE IF NOT EXISTS lab_threshold_policy_rules (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  facility_id         INTEGER NOT NULL,
  bundle_id           UUID NOT NULL,
  catalog_entry_id    UUID NOT NULL,
  reference_low       NUMERIC(15, 4),
  reference_high      NUMERIC(15, 4),
  critical_low        NUMERIC(15, 4),
  critical_high       NUMERIC(15, 4),
  notes               VARCHAR(2000),
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_lab_threshold_policy_rule_bundle_entry
    UNIQUE (tenant_id, bundle_id, catalog_entry_id),
  CONSTRAINT uq_lab_threshold_policy_rule_facility
    UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT chk_lab_threshold_policy_rule_reference
    CHECK (reference_low IS NOT NULL OR reference_high IS NOT NULL),
  CONSTRAINT chk_lab_threshold_policy_rule_reference_order
    CHECK (
      reference_low IS NULL OR reference_high IS NULL
      OR reference_high > reference_low
    ),
  CONSTRAINT chk_lab_threshold_policy_rule_critical_order
    CHECK (
      critical_low IS NULL OR critical_high IS NULL
      OR critical_high > critical_low
    ),
  CONSTRAINT chk_lab_threshold_policy_rule_low_envelope
    CHECK (
      critical_low IS NULL OR reference_low IS NULL
      OR critical_low <= reference_low
    ),
  CONSTRAINT chk_lab_threshold_policy_rule_high_envelope
    CHECK (
      critical_high IS NULL OR reference_high IS NULL
      OR critical_high >= reference_high
    ),
  CONSTRAINT fk_lab_threshold_policy_rule_bundle
    FOREIGN KEY (tenant_id, facility_id, bundle_id)
    REFERENCES lab_threshold_policy_bundles(tenant_id, facility_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_lab_threshold_policy_rule_catalog
    FOREIGN KEY (tenant_id, facility_id, catalog_entry_id)
    REFERENCES lab_threshold_catalog_entries(tenant_id, facility_id, id)
    ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_policy_rule_creator
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_lab_threshold_policy_rule_runtime
  ON lab_threshold_policy_rules (tenant_id, facility_id, bundle_id, catalog_entry_id);

CREATE OR REPLACE FUNCTION enforce_lab_threshold_catalog_entry_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Lab threshold catalogue entries are immutable evidence and cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_catalog_entry_no_delete';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.tenant_id::text || ':' || NEW.facility_id::text, 0)
  );
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      OLD.tenant_id, OLD.facility_id, OLD.introduced_revision,
      OLD.test_code, OLD.loinc_code, OLD.test_name, OLD.specimen_type,
      OLD.evaluation_mode, OLD.unit, OLD.normalized_unit, OLD.sex,
      OLD.age_min_days, OLD.age_max_days, OLD.pregnancy_scope,
      OLD.criticality_required, OLD.exemption_reason, OLD.created_by, OLD.created_at
    ) IS DISTINCT FROM ROW(
      NEW.tenant_id, NEW.facility_id, NEW.introduced_revision,
      NEW.test_code, NEW.loinc_code, NEW.test_name, NEW.specimen_type,
      NEW.evaluation_mode, NEW.unit, NEW.normalized_unit, NEW.sex,
      NEW.age_min_days, NEW.age_max_days, NEW.pregnancy_scope,
      NEW.criticality_required, NEW.exemption_reason, NEW.created_by, NEW.created_at
    ) THEN
      RAISE EXCEPTION 'Lab threshold catalogue identity is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_lab_threshold_catalog_entry_immutable';
    END IF;
    IF OLD.retired_revision IS NOT NULL AND ROW(
      OLD.retired_revision, OLD.retired_by, OLD.retired_at, OLD.retirement_reason
    ) IS DISTINCT FROM ROW(
      NEW.retired_revision, NEW.retired_by, NEW.retired_at, NEW.retirement_reason
    ) THEN
      RAISE EXCEPTION 'A retired lab threshold catalogue entry is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_lab_threshold_catalog_entry_retirement_immutable';
    END IF;
  END IF;

  IF NEW.retired_revision IS NULL AND EXISTS (
    SELECT 1
      FROM lab_threshold_catalog_entries existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.facility_id = NEW.facility_id
       AND existing.id <> NEW.id
       AND existing.retired_revision IS NULL
       AND existing.evaluation_mode = NEW.evaluation_mode
       AND (
         (existing.loinc_code IS NOT NULL AND NEW.loinc_code IS NOT NULL
           AND existing.loinc_code = NEW.loinc_code)
         OR upper(existing.test_code) = upper(NEW.test_code)
       )
       AND COALESCE(existing.normalized_unit, '*') = COALESCE(NEW.normalized_unit, '*')
       AND (
         lower(existing.specimen_type) = lower(NEW.specimen_type)
         OR lower(existing.specimen_type) = 'any'
         OR lower(NEW.specimen_type) = 'any'
       )
       AND (existing.sex IS NULL OR NEW.sex IS NULL OR existing.sex = NEW.sex)
       AND (
         existing.pregnancy_scope = 'all'
         OR NEW.pregnancy_scope = 'all'
         OR existing.pregnancy_scope = NEW.pregnancy_scope
       )
       AND COALESCE(existing.age_min_days, 0) < COALESCE(NEW.age_max_days, 2147483647)
       AND COALESCE(NEW.age_min_days, 0) < COALESCE(existing.age_max_days, 2147483647)
  ) THEN
    RAISE EXCEPTION 'Lab threshold catalogue contains overlapping analyte scopes'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_catalog_entry_scope_overlap';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_threshold_catalog_entry_write
  ON lab_threshold_catalog_entries;
CREATE TRIGGER trg_lab_threshold_catalog_entry_write
  BEFORE INSERT OR UPDATE OR DELETE ON lab_threshold_catalog_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_lab_threshold_catalog_entry_write();

CREATE OR REPLACE FUNCTION enforce_lab_threshold_policy_rule_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  target_facility INTEGER := CASE WHEN TG_OP = 'DELETE' THEN OLD.facility_id ELSE NEW.facility_id END;
  target_bundle UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.bundle_id ELSE NEW.bundle_id END;
  bundle_status VARCHAR(24);
  entry_mode VARCHAR(24);
  entry_requires_critical BOOLEAN;
BEGIN
  SELECT lifecycle_status
    INTO bundle_status
    FROM lab_threshold_policy_bundles
   WHERE tenant_id = target_tenant
     AND facility_id = target_facility
     AND id = target_bundle
   FOR KEY SHARE;
  IF bundle_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Lab threshold rules can only be changed while the bundle is draft'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_rule_draft_only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT evaluation_mode, criticality_required
    INTO entry_mode, entry_requires_critical
    FROM lab_threshold_catalog_entries
   WHERE tenant_id = NEW.tenant_id
     AND facility_id = NEW.facility_id
     AND id = NEW.catalog_entry_id
   FOR KEY SHARE;
  IF entry_mode IS DISTINCT FROM 'numeric_threshold' THEN
    RAISE EXCEPTION 'Only numeric_threshold catalogue entries can have rules'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_rule_numeric_entry';
  END IF;
  IF entry_requires_critical
     AND NEW.critical_low IS NULL
     AND NEW.critical_high IS NULL THEN
    RAISE EXCEPTION 'This catalogue entry requires a critical bound'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_rule_critical_required';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_threshold_policy_rule_write
  ON lab_threshold_policy_rules;
CREATE TRIGGER trg_lab_threshold_policy_rule_write
  BEFORE INSERT OR UPDATE OR DELETE ON lab_threshold_policy_rules
  FOR EACH ROW EXECUTE FUNCTION enforce_lab_threshold_policy_rule_write();

CREATE OR REPLACE FUNCTION enforce_lab_threshold_policy_bundle_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Lab threshold policy bundles are immutable evidence and cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_no_delete';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    OLD.id, OLD.tenant_id, OLD.facility_id, OLD.bundle_version,
    OLD.catalog_revision, OLD.created_by, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.tenant_id, NEW.facility_id, NEW.bundle_version,
    NEW.catalog_revision, NEW.created_by, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Lab threshold policy bundle identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_identity_immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.lifecycle_status <> 'draft'
     AND ROW(
       OLD.source_reference, OLD.content_sha256, OLD.effective_from,
       OLD.effective_until, OLD.submitted_by, OLD.submitted_at
     ) IS DISTINCT FROM ROW(
       NEW.source_reference, NEW.content_sha256, NEW.effective_from,
       NEW.effective_until, NEW.submitted_by, NEW.submitted_at
     ) THEN
    RAISE EXCEPTION 'Submitted lab threshold policy content is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_content_immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.approved_by IS NOT NULL
     AND ROW(
       OLD.approved_by, OLD.approved_at, OLD.approval_reason,
       OLD.approval_evidence_reference, OLD.approval_evidence_sha256
     ) IS DISTINCT FROM ROW(
       NEW.approved_by, NEW.approved_at, NEW.approval_reason,
       NEW.approval_evidence_reference, NEW.approval_evidence_sha256
     ) THEN
    RAISE EXCEPTION 'Lab threshold policy approval evidence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_approval_immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.rejected_by IS NOT NULL
     AND ROW(OLD.rejected_by, OLD.rejected_at, OLD.rejection_reason)
         IS DISTINCT FROM ROW(NEW.rejected_by, NEW.rejected_at, NEW.rejection_reason) THEN
    RAISE EXCEPTION 'Lab threshold policy rejection evidence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_rejection_immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.activated_by IS NOT NULL
     AND NOT (OLD.lifecycle_status = 'superseded' AND NEW.lifecycle_status = 'active')
     AND ROW(OLD.activated_by, OLD.activated_at)
         IS DISTINCT FROM ROW(NEW.activated_by, NEW.activated_at) THEN
    RAISE EXCEPTION 'Lab threshold policy activation evidence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_activation_immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.lifecycle_status <> 'draft' THEN
    RAISE EXCEPTION 'Lab threshold policy bundles must start as draft'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_initial_draft';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.lifecycle_status <> NEW.lifecycle_status
     AND NOT (
       (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status = 'in_review')
       OR (OLD.lifecycle_status = 'in_review' AND NEW.lifecycle_status IN ('approved', 'rejected'))
       OR (OLD.lifecycle_status = 'approved' AND NEW.lifecycle_status = 'active')
       OR (OLD.lifecycle_status = 'active' AND NEW.lifecycle_status = 'superseded')
       OR (OLD.lifecycle_status = 'superseded' AND NEW.lifecycle_status = 'active')
     ) THEN
    RAISE EXCEPTION 'Invalid lab threshold policy lifecycle transition: % to %',
      OLD.lifecycle_status, NEW.lifecycle_status
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_lab_threshold_policy_bundle_transition';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_lab_threshold_policy_bundle_transition
  ON lab_threshold_policy_bundles;
CREATE TRIGGER trg_lab_threshold_policy_bundle_transition
  BEFORE INSERT OR UPDATE OR DELETE ON lab_threshold_policy_bundles
  FOR EACH ROW EXECUTE FUNCTION enforce_lab_threshold_policy_bundle_transition();

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS specimen_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS criticality_status VARCHAR(32) NOT NULL DEFAULT 'unassessed',
  ADD COLUMN IF NOT EXISTS threshold_policy_bundle_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_policy_rule_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_catalog_entry_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_evaluated_at TIMESTAMPTZ(6);

ALTER TABLE lab_results
  DROP CONSTRAINT IF EXISTS chk_lab_results_criticality_status;
ALTER TABLE lab_results
  ADD CONSTRAINT chk_lab_results_criticality_status
  CHECK (criticality_status IN (
    'unassessed', 'within_policy', 'critical', 'not_applicable',
    'threshold_unavailable'
  ));

ALTER TABLE lab_results
  DROP CONSTRAINT IF EXISTS chk_lab_results_threshold_policy_shape;
ALTER TABLE lab_results
  ADD CONSTRAINT chk_lab_results_threshold_policy_shape
  CHECK (
    (criticality_status = 'unassessed'
      AND threshold_policy_bundle_id IS NULL
      AND threshold_policy_rule_id IS NULL
      AND threshold_catalog_entry_id IS NULL
      AND threshold_evaluated_at IS NULL)
    OR
    (criticality_status IN ('within_policy', 'critical')
      AND facility_id IS NOT NULL
      AND threshold_policy_bundle_id IS NOT NULL
      AND threshold_policy_rule_id IS NOT NULL
      AND threshold_catalog_entry_id IS NOT NULL
      AND threshold_evaluated_at IS NOT NULL)
    OR
    (criticality_status = 'not_applicable'
      AND facility_id IS NOT NULL
      AND threshold_policy_bundle_id IS NOT NULL
      AND threshold_policy_rule_id IS NULL
      AND threshold_catalog_entry_id IS NOT NULL
      AND threshold_evaluated_at IS NOT NULL)
    OR
    (criticality_status = 'threshold_unavailable'
      AND threshold_policy_rule_id IS NULL
      AND threshold_evaluated_at IS NOT NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_facility_tenant'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_threshold_catalog_entry'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_threshold_catalog_entry
      FOREIGN KEY (tenant_id, threshold_catalog_entry_id)
      REFERENCES lab_threshold_catalog_entries(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_threshold_bundle'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_threshold_bundle
      FOREIGN KEY (tenant_id, threshold_policy_bundle_id)
      REFERENCES lab_threshold_policy_bundles(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'fk_lab_results_threshold_rule'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT fk_lab_results_threshold_rule
      FOREIGN KEY (tenant_id, threshold_policy_rule_id)
      REFERENCES lab_threshold_policy_rules(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
END
$$;

ALTER TABLE lab_results
  VALIDATE CONSTRAINT fk_lab_results_facility_tenant;
ALTER TABLE lab_results
  VALIDATE CONSTRAINT fk_lab_results_threshold_bundle;
ALTER TABLE lab_results
  VALIDATE CONSTRAINT fk_lab_results_threshold_rule;
ALTER TABLE lab_results
  VALIDATE CONSTRAINT fk_lab_results_threshold_catalog_entry;

CREATE INDEX IF NOT EXISTS idx_lab_results_threshold_policy
  ON lab_results (
    tenant_id, facility_id, criticality_status, received_at DESC, id DESC
  );

ALTER TABLE lab_critical_alerts
  ADD COLUMN IF NOT EXISTS threshold_policy_bundle_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_policy_rule_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_catalog_entry_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alerts'::regclass
       AND conname = 'fk_lab_critical_alert_threshold_policy_bundle'
  ) THEN
    ALTER TABLE lab_critical_alerts
      ADD CONSTRAINT fk_lab_critical_alert_threshold_policy_bundle
      FOREIGN KEY (tenant_id, threshold_policy_bundle_id)
      REFERENCES lab_threshold_policy_bundles(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alerts'::regclass
       AND conname = 'fk_lab_critical_alert_threshold_policy_rule'
  ) THEN
    ALTER TABLE lab_critical_alerts
      ADD CONSTRAINT fk_lab_critical_alert_threshold_policy_rule
      FOREIGN KEY (tenant_id, threshold_policy_rule_id)
      REFERENCES lab_threshold_policy_rules(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alerts'::regclass
       AND conname = 'fk_lab_critical_alert_threshold_catalog_entry'
  ) THEN
    ALTER TABLE lab_critical_alerts
      ADD CONSTRAINT fk_lab_critical_alert_threshold_catalog_entry
      FOREIGN KEY (tenant_id, threshold_catalog_entry_id)
      REFERENCES lab_threshold_catalog_entries(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
END
$$;

ALTER TABLE lab_critical_alerts
  VALIDATE CONSTRAINT fk_lab_critical_alert_threshold_policy_bundle;
ALTER TABLE lab_critical_alerts
  VALIDATE CONSTRAINT fk_lab_critical_alert_threshold_policy_rule;
ALTER TABLE lab_critical_alerts
  VALIDATE CONSTRAINT fk_lab_critical_alert_threshold_catalog_entry;

CREATE INDEX IF NOT EXISTS idx_lab_critical_alert_threshold_policy
  ON lab_critical_alerts (
    tenant_id, threshold_policy_bundle_id, threshold_policy_rule_id, fired_at DESC
  )
  WHERE threshold_policy_bundle_id IS NOT NULL;

ALTER TABLE lab_critical_alert_reconciliation_receipts
  ADD COLUMN IF NOT EXISTS threshold_policy_bundle_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_policy_rule_id UUID,
  ADD COLUMN IF NOT EXISTS threshold_catalog_entry_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alert_reconciliation_receipts'::regclass
       AND conname = 'fk_lab_alert_receipt_threshold_policy_bundle'
  ) THEN
    ALTER TABLE lab_critical_alert_reconciliation_receipts
      ADD CONSTRAINT fk_lab_alert_receipt_threshold_policy_bundle
      FOREIGN KEY (tenant_id, threshold_policy_bundle_id)
      REFERENCES lab_threshold_policy_bundles(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alert_reconciliation_receipts'::regclass
       AND conname = 'fk_lab_alert_receipt_threshold_policy_rule'
  ) THEN
    ALTER TABLE lab_critical_alert_reconciliation_receipts
      ADD CONSTRAINT fk_lab_alert_receipt_threshold_policy_rule
      FOREIGN KEY (tenant_id, threshold_policy_rule_id)
      REFERENCES lab_threshold_policy_rules(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alert_reconciliation_receipts'::regclass
       AND conname = 'fk_lab_alert_receipt_threshold_catalog_entry'
  ) THEN
    ALTER TABLE lab_critical_alert_reconciliation_receipts
      ADD CONSTRAINT fk_lab_alert_receipt_threshold_catalog_entry
      FOREIGN KEY (tenant_id, threshold_catalog_entry_id)
      REFERENCES lab_threshold_catalog_entries(tenant_id, id)
      ON DELETE NO ACTION NOT VALID;
  END IF;
END
$$;

ALTER TABLE lab_critical_alert_reconciliation_receipts
  VALIDATE CONSTRAINT fk_lab_alert_receipt_threshold_policy_bundle;
ALTER TABLE lab_critical_alert_reconciliation_receipts
  VALIDATE CONSTRAINT fk_lab_alert_receipt_threshold_policy_rule;
ALTER TABLE lab_critical_alert_reconciliation_receipts
  VALIDATE CONSTRAINT fk_lab_alert_receipt_threshold_catalog_entry;

ALTER TABLE lab_critical_alert_reconciliation_receipts
  DROP CONSTRAINT IF EXISTS chk_lab_alert_receipt_outcome,
  DROP CONSTRAINT IF EXISTS chk_lab_alert_receipt_resolution_shape;

ALTER TABLE lab_critical_alert_reconciliation_receipts
  ADD CONSTRAINT chk_lab_alert_receipt_outcome CHECK (
    outcome IN (
      'within_active_critical_thresholds',
      'no_active_critical_threshold',
      'threshold_unavailable',
      'threshold_policy_not_applicable',
      'superseded_by_later_generation'
    )
  ),
  ADD CONSTRAINT chk_lab_alert_receipt_resolution_shape CHECK (
    (
      outcome = 'within_active_critical_thresholds'
      AND evaluated_value IS NOT NULL
      AND successor_signoff_id IS NULL
      AND successor_alert_id IS NULL
      AND successor_receipt_id IS NULL
      AND (
        (threshold_id IS NOT NULL
          AND threshold_policy_bundle_id IS NULL
          AND threshold_policy_rule_id IS NULL
          AND threshold_catalog_entry_id IS NULL)
        OR
        (threshold_id IS NULL
          AND threshold_policy_bundle_id IS NOT NULL
          AND threshold_policy_rule_id IS NOT NULL
          AND threshold_catalog_entry_id IS NOT NULL)
      )
    )
    OR
    (
      outcome = 'threshold_policy_not_applicable'
      AND threshold_id IS NULL
      AND threshold_policy_bundle_id IS NOT NULL
      AND threshold_policy_rule_id IS NULL
      AND threshold_catalog_entry_id IS NOT NULL
      AND evaluated_value IS NULL
      AND successor_signoff_id IS NULL
      AND successor_alert_id IS NULL
      AND successor_receipt_id IS NULL
    )
    OR
    (
      outcome = 'no_active_critical_threshold'
      AND threshold_id IS NULL
      AND threshold_policy_bundle_id IS NULL
      AND threshold_policy_rule_id IS NULL
      AND threshold_catalog_entry_id IS NULL
      AND successor_signoff_id IS NULL
      AND successor_alert_id IS NULL
      AND successor_receipt_id IS NULL
    )
    OR
    (
      outcome = 'threshold_unavailable'
      AND threshold_id IS NULL
      AND threshold_policy_rule_id IS NULL
      AND successor_signoff_id IS NULL
      AND successor_alert_id IS NULL
      AND successor_receipt_id IS NULL
      AND (
        (threshold_policy_bundle_id IS NULL AND threshold_catalog_entry_id IS NULL)
        OR threshold_policy_bundle_id IS NOT NULL
      )
    )
    OR
    (
      outcome = 'superseded_by_later_generation'
      AND successor_signoff_id IS NOT NULL
      AND successor_signoff_id > signoff_id
      AND num_nonnulls(successor_alert_id, successor_receipt_id) = 1
      AND threshold_id IS NULL
      AND threshold_policy_bundle_id IS NULL
      AND threshold_policy_rule_id IS NULL
      AND threshold_catalog_entry_id IS NULL
      AND evaluated_value IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_lab_alert_receipt_threshold_policy
  ON lab_critical_alert_reconciliation_receipts (
    tenant_id, threshold_policy_bundle_id, threshold_policy_rule_id, created_at DESC
  )
  WHERE threshold_policy_bundle_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_reconciliation_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  signoff_row RECORD;
  result_row RECORD;
  threshold_row RECORD;
  policy_row RECORD;
  successor_count INTEGER;
BEGIN
  SELECT signoff.id, signoff.decision, signoff.signed_at, signoff.result_ids
    INTO signoff_row
    FROM lab_pathologist_signoffs AS signoff
   WHERE signoff.tenant_id = NEW.tenant_id
     AND signoff.id = NEW.signoff_id
     AND signoff.patient_uid = NEW.patient_uid;
  IF NOT FOUND
     OR NEW.result_id <> ALL(signoff_row.result_ids)
     OR signoff_row.decision IS DISTINCT FROM NEW.signoff_decision
     OR signoff_row.signed_at IS DISTINCT FROM NEW.signoff_signed_at THEN
    RAISE EXCEPTION 'invalid critical-alert reconciliation sign-off binding'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.outcome IN (
    'within_active_critical_thresholds',
    'no_active_critical_threshold',
    'threshold_unavailable',
    'threshold_policy_not_applicable'
  ) THEN
    SELECT result.value_text, result.value_numeric, result.unit
      INTO result_row
      FROM lab_results AS result
     WHERE result.tenant_id = NEW.tenant_id
       AND result.id = NEW.result_id
       AND result.patient_uid = NEW.patient_uid;
    IF NOT FOUND
       OR result_row.value_text IS DISTINCT FROM NEW.result_value_text
       OR result_row.value_numeric IS DISTINCT FROM NEW.result_value_numeric
       OR result_row.unit IS DISTINCT FROM NEW.result_unit THEN
      RAISE EXCEPTION 'invalid critical-alert reconciliation result snapshot'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.outcome = 'within_active_critical_thresholds'
     AND NEW.threshold_id IS NOT NULL THEN
    SELECT threshold.test_code, threshold.loinc_code, threshold.critical_low,
           threshold.critical_high, threshold.unit, threshold.applies_to
      INTO threshold_row
      FROM lab_critical_thresholds AS threshold
     WHERE threshold.tenant_id = NEW.tenant_id
       AND threshold.id = NEW.threshold_id;
    IF NOT FOUND
       OR threshold_row.test_code IS DISTINCT FROM NEW.threshold_test_code
       OR threshold_row.loinc_code IS DISTINCT FROM NEW.threshold_loinc_code
       OR threshold_row.critical_low IS DISTINCT FROM NEW.threshold_low
       OR threshold_row.critical_high IS DISTINCT FROM NEW.threshold_high
       OR threshold_row.unit IS DISTINCT FROM NEW.threshold_unit
       OR threshold_row.applies_to IS DISTINCT FROM NEW.threshold_applies_to THEN
      RAISE EXCEPTION 'invalid critical-alert reconciliation threshold snapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.outcome = 'within_active_critical_thresholds' THEN
    SELECT catalog.test_code, catalog.loinc_code, rule.critical_low,
           rule.critical_high, catalog.normalized_unit,
           CASE
             WHEN catalog.sex IS NULL
              AND catalog.age_min_days IS NULL
              AND catalog.age_max_days IS NULL
              AND catalog.pregnancy_scope = 'all' THEN 'all'
             ELSE 'governed'
           END AS applies_to
      INTO policy_row
      FROM lab_threshold_policy_bundles AS bundle
      JOIN lab_threshold_policy_rules AS rule
        ON rule.tenant_id = bundle.tenant_id
       AND rule.facility_id = bundle.facility_id
       AND rule.bundle_id = bundle.id
      JOIN lab_threshold_catalog_entries AS catalog
        ON catalog.tenant_id = rule.tenant_id
       AND catalog.facility_id = rule.facility_id
       AND catalog.id = rule.catalog_entry_id
     WHERE bundle.tenant_id = NEW.tenant_id
       AND bundle.id = NEW.threshold_policy_bundle_id
       AND rule.id = NEW.threshold_policy_rule_id
       AND catalog.id = NEW.threshold_catalog_entry_id;
    IF NOT FOUND
       OR policy_row.test_code IS DISTINCT FROM NEW.threshold_test_code
       OR policy_row.loinc_code IS DISTINCT FROM NEW.threshold_loinc_code
       OR policy_row.critical_low IS DISTINCT FROM NEW.threshold_low
       OR policy_row.critical_high IS DISTINCT FROM NEW.threshold_high
       OR policy_row.normalized_unit IS DISTINCT FROM NEW.threshold_unit
       OR policy_row.applies_to IS DISTINCT FROM NEW.threshold_applies_to THEN
      RAISE EXCEPTION 'invalid governed critical-alert reconciliation policy snapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.outcome = 'threshold_policy_not_applicable' THEN
    SELECT catalog.test_code, catalog.loinc_code
      INTO policy_row
      FROM lab_threshold_policy_bundles AS bundle
      JOIN lab_threshold_catalog_entries AS catalog
        ON catalog.tenant_id = bundle.tenant_id
       AND catalog.facility_id = bundle.facility_id
       AND catalog.introduced_revision <= bundle.catalog_revision
       AND (
         catalog.retired_revision IS NULL
         OR catalog.retired_revision > bundle.catalog_revision
       )
     WHERE bundle.tenant_id = NEW.tenant_id
       AND bundle.id = NEW.threshold_policy_bundle_id
       AND catalog.id = NEW.threshold_catalog_entry_id
       AND catalog.evaluation_mode = 'qualitative_exempt';
    IF NOT FOUND
       OR policy_row.test_code IS DISTINCT FROM NEW.threshold_test_code
       OR policy_row.loinc_code IS DISTINCT FROM NEW.threshold_loinc_code
       OR NEW.threshold_low IS NOT NULL
       OR NEW.threshold_high IS NOT NULL
       OR NEW.threshold_unit IS NOT NULL
       OR NEW.threshold_applies_to IS DISTINCT FROM 'exempt' THEN
      RAISE EXCEPTION 'invalid qualitative lab-policy exemption receipt'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.outcome = 'superseded_by_later_generation' THEN
    IF NEW.successor_alert_id IS NOT NULL THEN
      SELECT COUNT(*)::int
        INTO successor_count
        FROM lab_critical_alerts AS alert
       WHERE alert.tenant_id = NEW.tenant_id
         AND alert.id = NEW.successor_alert_id
         AND alert.result_id = NEW.result_id
         AND alert.patient_uid = NEW.patient_uid
         AND alert.generation_signoff_id = NEW.successor_signoff_id;
    ELSE
      SELECT COUNT(*)::int
        INTO successor_count
        FROM lab_critical_alert_reconciliation_receipts AS receipt
       WHERE receipt.tenant_id = NEW.tenant_id
         AND receipt.id = NEW.successor_receipt_id
         AND receipt.result_id = NEW.result_id
         AND receipt.patient_uid = NEW.patient_uid
         AND receipt.signoff_id = NEW.successor_signoff_id;
    END IF;
    IF successor_count <> 1 THEN
      RAISE EXCEPTION 'invalid critical-alert reconciliation successor binding'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION validate_lab_result_threshold_policy_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  bundle_row RECORD;
  catalog_row RECORD;
  rule_row RECORD;
BEGIN
  IF NEW.criticality_status = 'unassessed' THEN
    RETURN NEW;
  END IF;

  IF NEW.threshold_policy_bundle_id IS NULL THEN
    IF NEW.threshold_policy_rule_id IS NOT NULL
       OR NEW.threshold_catalog_entry_id IS NOT NULL
       OR NEW.criticality_status <> 'threshold_unavailable' THEN
      RAISE EXCEPTION 'invalid lab-result threshold policy shape'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT bundle.facility_id, bundle.catalog_revision,
         bundle.effective_from, bundle.effective_until
    INTO bundle_row
    FROM lab_threshold_policy_bundles AS bundle
   WHERE bundle.tenant_id = NEW.tenant_id
     AND bundle.id = NEW.threshold_policy_bundle_id;
  IF NOT FOUND
     OR bundle_row.facility_id IS DISTINCT FROM NEW.facility_id
     OR NEW.threshold_evaluated_at < bundle_row.effective_from
     OR (
       bundle_row.effective_until IS NOT NULL
       AND NEW.threshold_evaluated_at >= bundle_row.effective_until
     ) THEN
    RAISE EXCEPTION 'invalid lab-result threshold policy bundle binding'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.threshold_catalog_entry_id IS NOT NULL THEN
    SELECT catalog.id, catalog.evaluation_mode
      INTO catalog_row
      FROM lab_threshold_catalog_entries AS catalog
     WHERE catalog.tenant_id = NEW.tenant_id
       AND catalog.facility_id = NEW.facility_id
       AND catalog.id = NEW.threshold_catalog_entry_id
       AND catalog.introduced_revision <= bundle_row.catalog_revision
       AND (
         catalog.retired_revision IS NULL
         OR catalog.retired_revision > bundle_row.catalog_revision
       );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid lab-result threshold catalogue binding'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.threshold_policy_rule_id IS NOT NULL THEN
    SELECT rule.id
      INTO rule_row
      FROM lab_threshold_policy_rules AS rule
     WHERE rule.tenant_id = NEW.tenant_id
       AND rule.facility_id = NEW.facility_id
       AND rule.bundle_id = NEW.threshold_policy_bundle_id
       AND rule.catalog_entry_id = NEW.threshold_catalog_entry_id
       AND rule.id = NEW.threshold_policy_rule_id;
    IF NOT FOUND
       OR NEW.criticality_status NOT IN ('within_policy', 'critical')
       OR catalog_row.evaluation_mode IS DISTINCT FROM 'numeric_threshold' THEN
      RAISE EXCEPTION 'invalid lab-result threshold rule binding'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.criticality_status = 'not_applicable' THEN
    IF catalog_row.evaluation_mode IS DISTINCT FROM 'qualitative_exempt' THEN
      RAISE EXCEPTION 'invalid lab-result qualitative exemption binding'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.criticality_status IN ('within_policy', 'critical') THEN
    RAISE EXCEPTION 'classified numeric lab result is missing its governed rule'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_result_threshold_policy_insert
  ON lab_results;
CREATE CONSTRAINT TRIGGER trg_validate_lab_result_threshold_policy_insert
AFTER INSERT ON lab_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_result_threshold_policy_binding();

DROP TRIGGER IF EXISTS trg_validate_lab_result_threshold_policy_update
  ON lab_results;
CREATE CONSTRAINT TRIGGER trg_validate_lab_result_threshold_policy_update
AFTER UPDATE OF facility_id, criticality_status, threshold_policy_bundle_id,
  threshold_policy_rule_id, threshold_catalog_entry_id, threshold_evaluated_at
ON lab_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_result_threshold_policy_binding();

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_threshold_policy_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  bound_count INTEGER;
BEGIN
  SELECT COUNT(*)::int
    INTO bound_count
    FROM lab_results AS result
   WHERE result.tenant_id = NEW.tenant_id
     AND result.id = NEW.result_id
     AND result.patient_uid = NEW.patient_uid
     AND result.criticality_status IN (
       'critical', 'within_policy', 'not_applicable', 'threshold_unavailable',
       'unassessed'
     )
     AND result.threshold_policy_bundle_id
         IS NOT DISTINCT FROM NEW.threshold_policy_bundle_id
     AND result.threshold_policy_rule_id
         IS NOT DISTINCT FROM NEW.threshold_policy_rule_id
     AND result.threshold_catalog_entry_id
         IS NOT DISTINCT FROM NEW.threshold_catalog_entry_id;
  IF bound_count <> 1 THEN
    RAISE EXCEPTION 'critical alert policy binding differs from the lab result'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_threshold_policy
  ON lab_critical_alerts;
CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_threshold_policy
AFTER INSERT OR UPDATE OF threshold_policy_bundle_id,
  threshold_policy_rule_id, threshold_catalog_entry_id
ON lab_critical_alerts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_critical_alert_threshold_policy_binding();

CREATE TABLE IF NOT EXISTS lab_threshold_unmatched_exceptions (
  id                         UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL,
  facility_id                INTEGER,
  result_id                  INTEGER NOT NULL,
  patient_uid                UUID NOT NULL,
  test_code                  VARCHAR(50) NOT NULL,
  loinc_code                 VARCHAR(20),
  specimen_type              VARCHAR(80),
  unit                       VARCHAR(40),
  unmatched_reason           VARCHAR(80) NOT NULL,
  severity                   VARCHAR(20) NOT NULL DEFAULT 'high',
  lifecycle_status           VARCHAR(20) NOT NULL DEFAULT 'open',
  assigned_role              VARCHAR(50) NOT NULL DEFAULT 'LAB_INCHARGE',
  assigned_to_uid            UUID,
  task_id                    INTEGER,
  first_seen_at              TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  last_seen_at               TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  occurrence_count           INTEGER NOT NULL DEFAULT 1,
  reconciliation_attempts    INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at         TIMESTAMPTZ(6),
  resolved_by                UUID,
  resolved_at                TIMESTAMPTZ(6),
  resolution_reason          VARCHAR(1000),
  resolved_bundle_id         UUID,
  resolved_rule_id           UUID,
  resolved_catalog_entry_id  UUID,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_lab_threshold_exception_result
    UNIQUE (tenant_id, result_id),
  CONSTRAINT uq_lab_threshold_exception_result_patient
    UNIQUE (tenant_id, result_id, patient_uid),
  CONSTRAINT chk_lab_threshold_exception_reason
    CHECK (unmatched_reason IN (
      'facility_unresolved', 'no_catalog', 'no_active_bundle',
      'catalog_revision_mismatch', 'policy_not_effective',
      'no_matching_rule', 'ambiguous_policy',
      'unit_mismatch', 'specimen_mismatch', 'demographic_mismatch',
      'non_numeric_value'
    )),
  CONSTRAINT chk_lab_threshold_exception_severity
    CHECK (severity IN ('high', 'critical')),
  CONSTRAINT chk_lab_threshold_exception_status
    CHECK (lifecycle_status IN ('open', 'resolved')),
  CONSTRAINT chk_lab_threshold_exception_counts
    CHECK (occurrence_count > 0 AND reconciliation_attempts >= 0),
  CONSTRAINT chk_lab_threshold_exception_resolution
    CHECK (
      (lifecycle_status = 'open' AND resolved_at IS NULL
        AND resolution_reason IS NULL AND resolved_bundle_id IS NULL
        AND resolved_rule_id IS NULL AND resolved_catalog_entry_id IS NULL)
      OR
      (lifecycle_status = 'resolved' AND resolved_at IS NOT NULL
        AND resolution_reason IS NOT NULL AND btrim(resolution_reason) <> ''
        AND resolved_bundle_id IS NOT NULL
        AND resolved_catalog_entry_id IS NOT NULL)
    ),
  CONSTRAINT fk_lab_threshold_exception_result
    FOREIGN KEY (tenant_id, result_id, patient_uid)
    REFERENCES lab_results(tenant_id, id, patient_uid)
    ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES facilities(tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_assignee
    FOREIGN KEY (tenant_id, assigned_to_uid)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_resolver
    FOREIGN KEY (tenant_id, resolved_by)
    REFERENCES users(tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks(tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_bundle
    FOREIGN KEY (tenant_id, resolved_bundle_id)
    REFERENCES lab_threshold_policy_bundles(tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_rule
    FOREIGN KEY (tenant_id, resolved_rule_id)
    REFERENCES lab_threshold_policy_rules(tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_lab_threshold_exception_catalog_entry
    FOREIGN KEY (tenant_id, resolved_catalog_entry_id)
    REFERENCES lab_threshold_catalog_entries(tenant_id, id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_lab_threshold_exception_open
  ON lab_threshold_unmatched_exceptions (
    tenant_id, lifecycle_status, last_reconciled_at, first_seen_at, id
  )
  WHERE lifecycle_status = 'open';

CREATE INDEX IF NOT EXISTS idx_lab_threshold_exception_facility
  ON lab_threshold_unmatched_exceptions (
    tenant_id, facility_id, lifecycle_status, first_seen_at DESC
  );

CREATE OR REPLACE FUNCTION validate_lab_threshold_exception_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  exception_row RECORD;
  task_row RECORD;
  result_row RECORD;
BEGIN
  SELECT exception_record.*
    INTO exception_row
    FROM lab_threshold_unmatched_exceptions AS exception_record
   WHERE exception_record.tenant_id = NEW.tenant_id
     AND exception_record.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF exception_row.task_id IS NULL THEN
    RAISE EXCEPTION 'lab threshold exception requires an owned review task'
      USING ERRCODE = '23514';
  END IF;

  SELECT task.status, task.task_kind, task.patient_uid,
         task.related_resource_type, task.related_resource_id,
         task.priority, task.assigned_to_uid, task.assigned_to_role
    INTO task_row
    FROM tasks AS task
   WHERE task.tenant_id = exception_row.tenant_id
     AND task.id = exception_row.task_id;
  IF NOT FOUND
     OR task_row.task_kind IS DISTINCT FROM 'review'
     OR task_row.patient_uid IS DISTINCT FROM exception_row.patient_uid
     OR task_row.related_resource_type IS DISTINCT FROM 'lab_threshold_exception'
     OR task_row.related_resource_id IS DISTINCT FROM exception_row.id::text
     OR task_row.priority NOT IN ('high', 'critical')
     OR task_row.assigned_to_uid IS DISTINCT FROM exception_row.assigned_to_uid
     OR task_row.assigned_to_role IS DISTINCT FROM (
       CASE
         WHEN exception_row.assigned_to_uid IS NULL THEN exception_row.assigned_role
         ELSE NULL
       END
     )
     OR (
       exception_row.lifecycle_status = 'open'
       AND task_row.status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
     )
     OR (
       exception_row.lifecycle_status = 'resolved'
       AND task_row.status <> 'completed'
     ) THEN
    RAISE EXCEPTION 'lab threshold exception review task binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF exception_row.lifecycle_status = 'resolved' THEN
    SELECT result.criticality_status,
           result.threshold_policy_bundle_id,
           result.threshold_policy_rule_id,
           result.threshold_catalog_entry_id
      INTO result_row
      FROM lab_results AS result
     WHERE result.tenant_id = exception_row.tenant_id
       AND result.id = exception_row.result_id
       AND result.patient_uid = exception_row.patient_uid;
    IF NOT FOUND
       OR result_row.criticality_status NOT IN (
         'within_policy', 'critical', 'not_applicable'
       )
       OR result_row.threshold_policy_bundle_id
          IS DISTINCT FROM exception_row.resolved_bundle_id
       OR result_row.threshold_policy_rule_id
          IS DISTINCT FROM exception_row.resolved_rule_id
       OR result_row.threshold_catalog_entry_id
          IS DISTINCT FROM exception_row.resolved_catalog_entry_id THEN
      RAISE EXCEPTION 'resolved lab threshold exception lacks exact result policy evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_threshold_exception_binding
  ON lab_threshold_unmatched_exceptions;
CREATE CONSTRAINT TRIGGER trg_validate_lab_threshold_exception_binding
AFTER INSERT OR UPDATE ON lab_threshold_unmatched_exceptions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_threshold_exception_binding();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lab_threshold_catalog_states',
    'lab_threshold_catalog_entries',
    'lab_threshold_policy_bundles',
    'lab_threshold_policy_rules',
    'lab_threshold_unmatched_exceptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $policy$, table_name);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'LAB_THRESHOLD_POLICY_GOVERNANCE_APPLIED',
  'lab_threshold_policy_bundles',
  '740_lab_threshold_policy_governance.sql',
  jsonb_build_object(
    'migration', '740_lab_threshold_policy_governance.sql',
    'legacy_thresholds_approved', false,
    'reason', 'Add signed facility-scoped catalogue revisions, policy bundles, rules, and unmatched-result evidence without inventing clinical limits.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'LAB_THRESHOLD_POLICY_GOVERNANCE_APPLIED'
    AND resource_id = '740_lab_threshold_policy_governance.sql'
);

COMMIT;
