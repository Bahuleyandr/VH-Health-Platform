-- 350_drug_compositions.sql
-- Composition layer for same-composition drug search (Phase 1, inert).
-- drug_compositions is GLOBAL (no tenant_id; a molecule set is a universal fact).
-- pharmacy_catalog gains structured composition/strength/form columns (additive).
-- drug_composition_curation_queue is tenant-scoped (review worklist).

CREATE TABLE IF NOT EXISTS drug_compositions (
  id                 SERIAL PRIMARY KEY,
  composition_key    VARCHAR(255) NOT NULL UNIQUE,
  display_label      VARCHAR(255) NOT NULL,
  active_ingredients TEXT[]       NOT NULL DEFAULT '{}',
  source             VARCHAR(20)  NOT NULL DEFAULT 'parsed'
                       CHECK (source IN ('parsed','curated','imported')),
  atc_code           VARCHAR(20),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE pharmacy_catalog
  ADD COLUMN IF NOT EXISTS composition_id         INTEGER REFERENCES drug_compositions(id),
  ADD COLUMN IF NOT EXISTS strength               VARCHAR(80),
  ADD COLUMN IF NOT EXISTS strength_key           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS strength_components    JSONB,
  ADD COLUMN IF NOT EXISTS form                   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS form_key               VARCHAR(40),
  ADD COLUMN IF NOT EXISTS release_key            VARCHAR(10),
  ADD COLUMN IF NOT EXISTS route                  VARCHAR(40),
  ADD COLUMN IF NOT EXISTS composition_source     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS composition_confidence VARCHAR(10),
  ADD COLUMN IF NOT EXISTS parsed_notes           TEXT;

CREATE INDEX IF NOT EXISTS idx_pharmacy_catalog_composition
  ON pharmacy_catalog (tenant_id, composition_id, strength_key, form_key, release_key)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS drug_composition_curation_queue (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  catalog_id     INTEGER NOT NULL REFERENCES pharmacy_catalog(id) ON DELETE CASCADE,
  reason         VARCHAR(40) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','resolved','skip')),
  parser_output  JSONB,
  reviewer       VARCHAR(120),
  notes          TEXT,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_composition_curation_queue_unique UNIQUE (tenant_id, catalog_id)
);

ALTER TABLE drug_composition_curation_queue ENABLE ROW LEVEL SECURITY;

-- Canonical tenant_isolation policy (Pattern A) — copied verbatim from the
-- post-migration-310 platform standard (see migrations 328/335/336): full
-- USING + WITH CHECK, four-branch predicate resolving through the shared
-- app_current_tenant_id_uuid() helper (migration 075). SUPER_ADMIN
-- cross-tenant reads keep working via the `bypass` branch.
ALTER TABLE drug_composition_curation_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON drug_composition_curation_queue;
CREATE POLICY tenant_isolation ON drug_composition_curation_queue
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
