-- 289_research_registry_capture.sql
--
-- Roadmap Pillar D / item D6 (docs/EPIC_LEVEL_ROADMAP.md) — research /
-- registry capture (RDC-lite). The AI trial matcher shipped catalog +
-- match results (clinical_trials_catalog, clinical_trial_match_results);
-- what was missing is the capture workflow:
--
--   * research_registries     — studies/registries/audits a site runs;
--                               optionally pinned to a catalog trial.
--   * research_crf_forms      — versioned case-report-form definitions.
--                               field_schema is a JSONB array of field
--                               defs; fields may declare a `binding` that
--                               auto-pulls from clinical data at capture
--                               (vitals_latest / lab_latest / demographics).
--                               Published forms are immutable (service).
--   * research_enrollments    — patient ↔ registry membership with a
--                               pseudonymous subject_code (exports are
--                               de-identified by default), optional link
--                               back to the AI match that suggested it.
--   * research_crf_responses  — structured responses per enrollment ×
--                               form × visit; `autofilled` records
--                               clinical-data provenance per field.
--
-- Enrollment/withdrawal and CRF submission are clinical-adjacent writes →
-- canonical timeline + audit events (service layer, same tx).

BEGIN;

CREATE TABLE IF NOT EXISTS research_registries (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  code          VARCHAR(40) NOT NULL,
  title         VARCHAR(300) NOT NULL,
  kind          VARCHAR(12) NOT NULL DEFAULT 'registry',
  trial_id      INTEGER REFERENCES clinical_trials_catalog(id) ON DELETE SET NULL,
  description   TEXT,
  principal_investigator_uid UUID,
  status        VARCHAR(12) NOT NULL DEFAULT 'active',
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_research_registries_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_research_registries_code UNIQUE (tenant_id, code),
  CONSTRAINT chk_research_registries_kind CHECK (kind IN ('trial', 'registry', 'audit')),
  CONSTRAINT chk_research_registries_status CHECK (status IN ('active', 'paused', 'closed'))
);

CREATE TABLE IF NOT EXISTS research_crf_forms (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  registry_id   INTEGER NOT NULL REFERENCES research_registries(id) ON DELETE CASCADE,
  name          VARCHAR(160) NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  status        VARCHAR(12) NOT NULL DEFAULT 'draft',
  field_schema  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by    UUID,
  published_at  TIMESTAMPTZ(6),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_research_crf_forms_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_research_crf_forms_version UNIQUE (registry_id, name, version),
  CONSTRAINT chk_research_crf_forms_status CHECK (status IN ('draft', 'published', 'retired'))
);

CREATE TABLE IF NOT EXISTS research_enrollments (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  registry_id       INTEGER NOT NULL REFERENCES research_registries(id) ON DELETE CASCADE,
  patient_uid       UUID NOT NULL,
  subject_code      VARCHAR(60) NOT NULL,
  status            VARCHAR(12) NOT NULL DEFAULT 'enrolled',
  match_id          INTEGER REFERENCES clinical_trial_match_results(id) ON DELETE SET NULL,
  consent_ref       VARCHAR(200),
  enrolled_by       UUID,
  enrolled_at       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at      TIMESTAMPTZ(6),
  withdrawal_reason TEXT,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_research_enrollments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_research_enrollments_subject UNIQUE (registry_id, subject_code),
  CONSTRAINT chk_research_enrollments_status
    CHECK (status IN ('screening', 'enrolled', 'withdrawn', 'completed'))
);

-- One live membership per registry × patient (re-enrollment after
-- withdrawal stays possible).
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_enrollments_live
  ON research_enrollments (registry_id, patient_uid)
  WHERE status IN ('screening', 'enrolled');

CREATE INDEX IF NOT EXISTS idx_research_enrollments_patient
  ON research_enrollments (patient_uid, status);

CREATE TABLE IF NOT EXISTS research_crf_responses (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  form_id       INTEGER NOT NULL REFERENCES research_crf_forms(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES research_enrollments(id) ON DELETE CASCADE,
  visit_label   VARCHAR(80) NOT NULL DEFAULT 'baseline',
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  autofilled    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        VARCHAR(12) NOT NULL DEFAULT 'draft',
  recorded_by   UUID,
  submitted_at  TIMESTAMPTZ(6),
  verified_by   UUID,
  verified_at   TIMESTAMPTZ(6),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_research_crf_responses_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_research_crf_responses_visit UNIQUE (enrollment_id, form_id, visit_label),
  CONSTRAINT chk_research_crf_responses_status
    CHECK (status IN ('draft', 'submitted', 'verified', 'locked'))
);

CREATE INDEX IF NOT EXISTS idx_research_crf_responses_enrollment
  ON research_crf_responses (enrollment_id, status);
CREATE INDEX IF NOT EXISTS idx_research_crf_forms_registry
  ON research_crf_forms (registry_id, status);

-- Tenant isolation (262/272 pattern) — enrollments + responses carry PHI;
-- registries/forms are tenant-scoped configuration.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['research_registries', 'research_crf_forms', 'research_enrollments', 'research_crf_responses'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
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
    $f$, t);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'RESEARCH_REGISTRY_CAPTURE_APPLIED',
  'research_registries',
  'research_registries',
  jsonb_build_object(
    'migration', '289_research_registry_capture.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D6',
    'reason', 'RDC-lite: registries, versioned CRF forms with clinical-data bindings, pseudonymous enrollments, structured responses with autofill provenance, de-identified export.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'RESEARCH_REGISTRY_CAPTURE_APPLIED'
    AND resource = 'research_registries'
);

COMMIT;
