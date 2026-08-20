-- 721_lab_analyzer_code_mappings.sql
--
-- Terminology slate C1 / WP3 — LOINC closed loop for the lab interfaces.
--
-- Today LOINC lands on lab_results only when the analyzer says so itself
-- (ORU OBX-3 coding system LN/LOINC — labResultsService.normalizeOruObxRows);
-- ASTM results carry raw analyzer codes and never gain a LOINC. This table is
-- the curated analyzer/interface-code → catalog/LOINC mapping layer that
-- closes the loop: curators map each inbound (source, code) pair either
-- directly to a LOINC code or to an investigation_test_catalog row (whose
-- confirmed LOINC binding in terminology_catalog_bindings then supplies the
-- code).
--
-- INERT ON ARRIVAL. Ingest-time enrichment is dark behind
-- LAB_LOINC_MAPPING_ENABLED (env kill switch, default off) AND the tenant
-- settings.labLoincMapping.enabled flag (default off) AND requires curated
-- rows to exist. With nothing flipped and nothing curated every ingest path
-- behaves byte-identically. Enrichment is fail-open: a resolver failure can
-- never block result ingestion.

BEGIN;

CREATE TABLE IF NOT EXISTS lab_analyzer_code_mappings (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  -- Analyzer/interface identity the mapping applies to. Matches the ORU
  -- MSH-3 sending application or the ASTM analyzer_code; 'any' is the
  -- tenant-wide wildcard consulted when no source-specific row matches.
  source_key           VARCHAR(120) NOT NULL DEFAULT 'any',
  incoming_code        VARCHAR(120) NOT NULL,
  incoming_code_system VARCHAR(80),
  catalog_id           BIGINT REFERENCES investigation_test_catalog(id) ON DELETE SET NULL,
  loinc_code           VARCHAR(20),
  display              TEXT,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  verified_by          UUID,
  verified_at          TIMESTAMPTZ(6),
  created_by           UUID,
  created_at           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_lab_analyzer_code_mappings_code_nonempty
    CHECK (btrim(incoming_code) <> ''),
  CONSTRAINT chk_lab_analyzer_code_mappings_source_key_nonempty
    CHECK (btrim(source_key) <> ''),
  -- A mapping that names neither a catalog row nor a LOINC code maps to
  -- nothing and must not exist.
  CONSTRAINT chk_lab_analyzer_code_mappings_target
    CHECK (catalog_id IS NOT NULL OR loinc_code IS NOT NULL)
);

-- Live-unique: one ACTIVE mapping per (tenant, source, code), matched
-- case-insensitively the same way the ingest paths compare test codes
-- (UPPER(test_code) — labClosedLoopService.priorNumericValue precedent).
-- Deactivated rows keep history without blocking a corrected replacement.
-- NOTE on the migration-580/682 trailing-(TRUE) idiom: it is only needed for
-- partial uniques over a plain FK-subset column list; the upper(...)
-- expression column here already makes this an expression index, which
-- `prisma db pull` skips entirely, so no marker column is required and the
-- schema.prisma diff stays at the table itself.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lab_analyzer_code_mappings_live
  ON lab_analyzer_code_mappings (tenant_id, source_key, upper(incoming_code))
  WHERE active;

-- FK support (717 convention) + resolver lookup path.
CREATE INDEX IF NOT EXISTS idx_lab_analyzer_code_mappings_catalog
  ON lab_analyzer_code_mappings (catalog_id)
  WHERE catalog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_analyzer_code_mappings_lookup
  ON lab_analyzer_code_mappings (tenant_id, upper(incoming_code))
  WHERE active;

-- Tenant isolation — house RLS policy form (migration 297).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE lab_analyzer_code_mappings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE lab_analyzer_code_mappings FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON lab_analyzer_code_mappings';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON lab_analyzer_code_mappings
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
  $f$;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'LAB_ANALYZER_CODE_MAPPINGS_APPLIED',
  'lab_analyzer_code_mappings',
  'lab_analyzer_code_mappings',
  jsonb_build_object(
    'migration', '721_lab_analyzer_code_mappings.sql',
    'reason', 'Curated analyzer/interface code -> catalog/LOINC mapping layer for dark ingest-time LOINC enrichment.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'LAB_ANALYZER_CODE_MAPPINGS_APPLIED'
    AND resource = 'lab_analyzer_code_mappings'
);

COMMIT;
