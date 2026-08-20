-- 722_drug_kb_catalog_links.sql
--
-- Terminology slate C1 / WP4 — deterministic pharmacy-formulary → drug-KB
-- linkage substrate + licensed-source license metadata.
--
-- 1. drug_kb_catalog_links: per-tenant link rows resolving a pharmacy_catalog
--    item to a drug_kb monograph drug_key. Four link tiers (link_source):
--      manual        — curator-entered link
--      vendor_import — licensed vendor mapping file (scripts/drug-kb-import.mjs
--                      --dataset catalog-links)
--      atc           — derived from a confirmed terminology_catalog_bindings
--                      ATC binding joined to drug_kb_monographs.atc_code
--      composition   — derived from drug_compositions.active_ingredients
--                      matched against monograph keys/aliases
--    The KB itself is global (migration 277 stance); pharmacy_catalog is
--    tenant-scoped, so links key by (tenant_id, pharmacy_catalog_id) and get
--    the canonical Pattern-A tenant_isolation RLS policy (migration 350 form).
--    Live-unique: at most one ACTIVE link per catalog item per tenant —
--    partial unique index with the trailing-(TRUE) idiom (migration 580/682
--    form) because pharmacy_catalog_id is an FK column.
--
-- 2. drug_kb_sources gains license_holder / license_expires_at /
--    vendor_edition — surfaced by /drug-kb/status and the admin console;
--    expiry drives a warning, never a hard stop.
--
-- Substrate only: no content rows are authored here, and nothing reads the
-- new table until env DRUG_KB_DETERMINISTIC_MATCHING AND the per-tenant
-- settings.drugKb.deterministicMatching flag are both enabled (defaults off).
-- Idempotent: IF NOT EXISTS guards throughout; re-running is a no-op.

BEGIN;

ALTER TABLE drug_kb_sources
  ADD COLUMN IF NOT EXISTS license_holder     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS license_expires_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS vendor_edition     VARCHAR(120);

CREATE TABLE IF NOT EXISTS drug_kb_catalog_links (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  pharmacy_catalog_id INTEGER NOT NULL REFERENCES pharmacy_catalog(id) ON DELETE CASCADE,
  drug_key            VARCHAR(120) NOT NULL,
  link_source         VARCHAR(20) NOT NULL DEFAULT 'manual',
  -- Optional provenance back to the licensed source whose mapping file
  -- authored this link (vendor_import tier); manual/derived links leave NULL.
  source_key          VARCHAR(60) REFERENCES drug_kb_sources(source_key) ON UPDATE CASCADE,
  confidence          NUMERIC(4,3),
  -- Migration-408 row-governance vocabulary.
  review_status       VARCHAR(24) NOT NULL DEFAULT 'legacy',
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_drug_kb_catalog_links_source
    CHECK (link_source IN ('manual', 'vendor_import', 'atc', 'composition')),
  CONSTRAINT chk_drug_kb_catalog_links_review
    CHECK (review_status IN ('legacy', 'draft', 'in_review', 'approved', 'rejected', 'retired')),
  CONSTRAINT chk_drug_kb_catalog_links_confidence
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT chk_drug_kb_catalog_links_drug_key
    CHECK (btrim(drug_key) <> '')
);

-- At most one live link per (tenant, catalog item). Trailing-(TRUE) idiom:
-- keeps prisma db pull from modelling the FK-column partial unique as a
-- @@unique it cannot faithfully express (migration 580/682 precedent).
CREATE UNIQUE INDEX IF NOT EXISTS uq_drug_kb_catalog_links_live
  ON drug_kb_catalog_links (tenant_id, pharmacy_catalog_id, (TRUE))
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_drug_kb_catalog_links_key
  ON drug_kb_catalog_links (drug_key);
CREATE INDEX IF NOT EXISTS idx_drug_kb_catalog_links_tenant_active
  ON drug_kb_catalog_links (tenant_id, is_active);

-- Canonical tenant_isolation policy (Pattern A) — same form as migration 350's
-- drug_composition_curation_queue: four-branch predicate through
-- app_current_tenant_id_uuid() (migration 075), SUPER_ADMIN via 'bypass'.
ALTER TABLE drug_kb_catalog_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE drug_kb_catalog_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON drug_kb_catalog_links;
CREATE POLICY tenant_isolation ON drug_kb_catalog_links
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'DRUG_KB_CATALOG_LINKS_APPLIED',
  'drug_kb_catalog_links',
  'drug_kb_catalog_links',
  jsonb_build_object(
    'migration', '722_drug_kb_catalog_links.sql',
    'reason', 'Deterministic formulary→drug-KB link substrate (manual|vendor_import|atc|composition tiers) + drug_kb_sources license metadata. Dark: env DRUG_KB_DETERMINISTIC_MATCHING AND tenant settings.drugKb.deterministicMatching both default off.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'DRUG_KB_CATALOG_LINKS_APPLIED'
    AND resource = 'drug_kb_catalog_links'
);

COMMIT;
