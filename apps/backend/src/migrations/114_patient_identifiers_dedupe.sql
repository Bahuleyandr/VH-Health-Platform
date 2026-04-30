-- Migration 114: Phase A2 — multi-identifier patient table + duplicate
-- detection + merge-with-approval workflow.
--
-- The structural audit (HEALTHCARE_AI_SPEC_AUDIT.md §4) flagged the
-- single-UID-only patient master as the next biggest data-quality gap
-- after KB CRUD. Hospitals onboarding real data hit duplicate-MRN /
-- mismatched-mobile / overlapping-ABHA issues immediately, and have no
-- safe way to merge two records once a duplicate is confirmed.
--
-- This migration creates the foundation tables. PR2 wires duplicate
-- detection + the merge workflow. Admin UI lands as a follow-up PR.
--
-- Tables:
--   1. patient_identifiers          — many-to-one identifier rows per UID.
--                                      Type-tagged (mrn / uhid / abha /
--                                      mobile / aadhaar_token / passport /
--                                      insurance / external_emr / ...);
--                                      same value can be replayed across
--                                      retired statuses but is unique among
--                                      ACTIVE rows of the same type.
--   2. patient_duplicate_candidates — pairs of UIDs flagged as likely
--                                      duplicates with a confidence score
--                                      and which signals matched.
--                                      Workflow status: open → merged
--                                                     → rejected_not_duplicate
--                                                     → expired.
--   3. patient_merge_requests       — two-person workflow for executing a
--                                      merge. requested → approved
--                                                       → executed | rejected
--                                                       → cancelled. The
--                                      approver MUST differ from requester.
--
-- Decision-support only: the dedupe candidates surface to admin staff;
-- nothing auto-merges. Merge execution is gated by an approver and
-- records a per-table summary so an audit trail exists for every row
-- moved from secondary → primary.

BEGIN;

CREATE TABLE IF NOT EXISTS patient_identifiers (
  id                       SERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid              UUID NOT NULL,
  identifier_type          VARCHAR(40) NOT NULL
    CHECK (identifier_type IN (
      'mrn', 'uhid', 'abha', 'abha_address', 'mobile', 'aadhaar_token',
      'passport', 'insurance', 'tpa_card', 'employee_id', 'external_emr',
      'national_id', 'driving_license', 'other'
    )),
  identifier_value         VARCHAR(255) NOT NULL,
  identifier_value_hash    VARCHAR(64),
  issuer                   VARCHAR(255),
  assigned_at              TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  is_primary               BOOLEAN NOT NULL DEFAULT false,
  status                   VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'merged_into')),
  merged_into_uid          UUID,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same identifier_value can't be assigned to two ACTIVE rows of the same
-- type within a tenant. Retired / merged rows are intentionally kept for
-- audit so the partial unique index excludes them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_identifiers_active_value
  ON patient_identifiers (tenant_id, identifier_type, identifier_value)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_patient_identifiers_tenant_patient
  ON patient_identifiers (tenant_id, patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_patient_identifiers_tenant_type_hash
  ON patient_identifiers (tenant_id, identifier_type, identifier_value_hash)
  WHERE identifier_value_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patient_identifiers_merged_into
  ON patient_identifiers (merged_into_uid)
  WHERE merged_into_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS patient_duplicate_candidates (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  primary_uid         UUID NOT NULL,
  secondary_uid       UUID NOT NULL,
  confidence_score    NUMERIC(5, 2) NOT NULL DEFAULT 0,
  match_signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_by         VARCHAR(40) NOT NULL DEFAULT 'rule_engine'
    CHECK (detected_by IN ('rule_engine', 'admin_manual', 'identifier_collision', 'name_phonetic', 'imported')),
  detection_run_id    UUID,
  status              VARCHAR(30) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'merged', 'rejected_not_duplicate', 'expired')),
  decided_by          UUID,
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_dup_distinct CHECK (primary_uid <> secondary_uid)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_dup_pair
  ON patient_duplicate_candidates (tenant_id, primary_uid, secondary_uid);
CREATE INDEX IF NOT EXISTS idx_patient_dup_tenant_status
  ON patient_duplicate_candidates (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_dup_run
  ON patient_duplicate_candidates (detection_run_id);

CREATE TABLE IF NOT EXISTS patient_merge_requests (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  candidate_id        INTEGER REFERENCES patient_duplicate_candidates(id) ON DELETE SET NULL,
  primary_uid         UUID NOT NULL,
  secondary_uid       UUID NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'executed', 'rejected', 'cancelled')),
  requested_by        UUID,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requester_note      TEXT,
  approver_uid        UUID,
  approved_at         TIMESTAMPTZ,
  approver_note       TEXT,
  executor_uid        UUID,
  executed_at         TIMESTAMPTZ,
  execution_summary   JSONB,
  rejection_reason    TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_merge_distinct CHECK (primary_uid <> secondary_uid),
  -- Two-person rule: enforced in the service (requested_by != approver_uid),
  -- not in SQL — null requester for system-initiated merges should still
  -- pass approval.
  CONSTRAINT chk_merge_status_progress CHECK (
    (status = 'requested') OR (status = 'cancelled') OR (approver_uid IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_patient_merge_tenant_status
  ON patient_merge_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_merge_primary
  ON patient_merge_requests (tenant_id, primary_uid);
CREATE INDEX IF NOT EXISTS idx_patient_merge_secondary
  ON patient_merge_requests (tenant_id, secondary_uid);

COMMIT;
