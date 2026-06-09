-- 275_terminology_service.sql
--
-- Roadmap Pillar B / item B8 (docs/EPIC_LEVEL_ROADMAP.md) — central
-- terminology service. Until now standard codes lived in scattered places:
-- icd10_codes (diagnosis catalog), a ~80-code LOINC allowlist hardcoded in
-- src/services/hl7/loincValidator.js, and SNOMED referenced in exactly one
-- microbiology migration. There was no single place to ask "is this a valid
-- code in system X", "what is its display", or "how does this local catalog
-- row map to LOINC/SNOMED" — which blocks real interop (FHIR CodeableConcept
-- population, ABDM, analyzer result mapping) and analytics.
--
-- Design notes:
--   * Terminology is GLOBAL reference data: no tenant_id, no RLS. It carries
--     no PHI (check:phi-tenant-id heuristic: no patient columns here).
--   * Concept content is imported, not hand-seeded: SNOMED CT (free Indian
--     national license via NRC), LOINC (free Regenstrief license), ICD-10/11.
--     Importer: apps/backend/scripts/terminology-import.mjs. This migration
--     only registers the code systems and federates the existing icd10_codes
--     catalog so the service is non-empty on day one.
--   * terminology_catalog_bindings maps LOCAL catalog rows
--     (investigation_test_catalog / pharmacy_catalog / medications) to
--     standard codes — the roadmap-B8 prerequisite for interop + analytics.

BEGIN;

CREATE TABLE IF NOT EXISTS terminology_code_systems (
  id            SERIAL PRIMARY KEY,
  system_key    VARCHAR(40) NOT NULL UNIQUE,
  uri           VARCHAR(200) NOT NULL,
  name          VARCHAR(200) NOT NULL,
  version       VARCHAR(80),
  source        VARCHAR(255),
  license_note  VARCHAR(255),
  concept_count INTEGER NOT NULL DEFAULT 0,
  imported_at   TIMESTAMPTZ(6),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS terminology_concepts (
  id           BIGSERIAL PRIMARY KEY,
  system_key   VARCHAR(40) NOT NULL REFERENCES terminology_code_systems(system_key) ON UPDATE CASCADE,
  code         VARCHAR(80) NOT NULL,
  display      TEXT NOT NULL,
  category     VARCHAR(255),
  semantic_tag VARCHAR(120),
  status       VARCHAR(20) NOT NULL DEFAULT 'active',
  properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT terminology_concepts_system_code_key UNIQUE (system_key, code),
  CONSTRAINT chk_terminology_concepts_status
    CHECK (status IN ('active', 'inactive', 'deprecated'))
);

CREATE INDEX IF NOT EXISTS idx_terminology_concepts_display_prefix
  ON terminology_concepts (system_key, lower(display) varchar_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_terminology_concepts_code
  ON terminology_concepts (code);

-- Trigram index for substring search when pg_trgm is available (contrib
-- module; present on dev/QA/CI/CNPG images). Degrades gracefully when not.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%) — terminology substring search will use ILIKE scans', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_terminology_concepts_display_trgm
      ON terminology_concepts USING gin (lower(display) gin_trgm_ops);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS terminology_concept_maps (
  id            BIGSERIAL PRIMARY KEY,
  source_system VARCHAR(40) NOT NULL REFERENCES terminology_code_systems(system_key) ON UPDATE CASCADE,
  source_code   VARCHAR(80) NOT NULL,
  target_system VARCHAR(40) NOT NULL REFERENCES terminology_code_systems(system_key) ON UPDATE CASCADE,
  target_code   VARCHAR(80) NOT NULL,
  relationship  VARCHAR(30) NOT NULL DEFAULT 'equivalent',
  context       VARCHAR(120),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT terminology_concept_maps_unique
    UNIQUE (source_system, source_code, target_system, target_code, relationship),
  CONSTRAINT chk_terminology_concept_maps_rel
    CHECK (relationship IN ('equivalent', 'broader', 'narrower', 'related'))
);

CREATE INDEX IF NOT EXISTS idx_terminology_concept_maps_source
  ON terminology_concept_maps (source_system, source_code);
CREATE INDEX IF NOT EXISTS idx_terminology_concept_maps_target
  ON terminology_concept_maps (target_system, target_code);

CREATE TABLE IF NOT EXISTS terminology_catalog_bindings (
  id             SERIAL PRIMARY KEY,
  catalog_type   VARCHAR(40) NOT NULL,
  catalog_id     INTEGER NOT NULL,
  system_key     VARCHAR(40) NOT NULL REFERENCES terminology_code_systems(system_key) ON UPDATE CASCADE,
  code           VARCHAR(80) NOT NULL,
  display        TEXT,
  binding_status VARCHAR(20) NOT NULL DEFAULT 'suggested',
  confidence     NUMERIC(4,3),
  bound_by       UUID,
  verified_by    UUID,
  verified_at    TIMESTAMPTZ(6),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT terminology_catalog_bindings_unique
    UNIQUE (catalog_type, catalog_id, system_key),
  CONSTRAINT chk_terminology_catalog_bindings_type
    CHECK (catalog_type IN ('investigation_test', 'pharmacy_item', 'medication')),
  CONSTRAINT chk_terminology_catalog_bindings_status
    CHECK (binding_status IN ('suggested', 'confirmed', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_terminology_catalog_bindings_code
  ON terminology_catalog_bindings (system_key, code);
CREATE INDEX IF NOT EXISTS idx_terminology_catalog_bindings_status
  ON terminology_catalog_bindings (catalog_type, binding_status);

-- ── Register the code systems ────────────────────────────────────────────
INSERT INTO terminology_code_systems (system_key, uri, name, source, license_note)
VALUES
  ('ICD10',     'http://hl7.org/fhir/sid/icd-10',  'ICD-10 (WHO)',
   'WHO ICD-10 2019 + local additions', 'WHO — free for member-state use'),
  ('ICD11',     'http://id.who.int/icd/release/11/mms', 'ICD-11 MMS',
   'WHO ICD-11 release', 'WHO — free; import via terminology-import.mjs'),
  ('SNOMED_CT', 'http://snomed.info/sct', 'SNOMED CT',
   'NRC India RF2 snapshot', 'Free Indian national license (NRC) — import RF2 via terminology-import.mjs'),
  ('LOINC',     'http://loinc.org', 'LOINC',
   'Regenstrief LOINC release', 'Free Regenstrief license — import Loinc.csv via terminology-import.mjs'),
  ('ATC',       'http://www.whocc.no/atc', 'WHO ATC/DDD',
   'WHO Collaborating Centre ATC index', 'Annual WHOCC release — import via terminology-import.mjs')
ON CONFLICT (system_key) DO NOTHING;

-- ── Federate the existing ICD-10 catalog so the service is non-empty ─────
INSERT INTO terminology_concepts (system_key, code, display, category, status)
SELECT 'ICD10', c.code, c.description, c.category,
       CASE WHEN COALESCE(c.is_active, true) THEN 'active' ELSE 'inactive' END
  FROM icd10_codes c
 WHERE c.code IS NOT NULL AND c.description IS NOT NULL
ON CONFLICT (system_key, code) DO UPDATE
  SET display  = EXCLUDED.display,
      category = COALESCE(EXCLUDED.category, terminology_concepts.category),
      status   = EXCLUDED.status,
      updated_at = NOW();

UPDATE terminology_code_systems s
   SET concept_count = (SELECT COUNT(*) FROM terminology_concepts t WHERE t.system_key = s.system_key),
       imported_at   = CASE WHEN EXISTS (SELECT 1 FROM terminology_concepts t WHERE t.system_key = s.system_key)
                            THEN NOW() ELSE s.imported_at END
 WHERE s.system_key = 'ICD10';

-- Audit stamp (idempotent, repo convention).
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TERMINOLOGY_SERVICE_APPLIED',
  'terminology_code_systems',
  'terminology_code_systems',
  jsonb_build_object(
    'migration', '275_terminology_service.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B8',
    'reason', 'Central terminology module: code systems registry, concepts, concept maps, local-catalog bindings; ICD-10 federated from icd10_codes.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TERMINOLOGY_SERVICE_APPLIED'
    AND resource = 'terminology_code_systems'
);

COMMIT;
