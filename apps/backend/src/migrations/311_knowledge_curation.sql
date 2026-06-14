-- 311_knowledge_curation.sql
--
-- WS5 B5.5 — clinical-AI knowledge layer: curation + import-provenance.
--
-- The RAG knowledge-base substrate (migration 113: knowledge_bases /
-- knowledge_documents / knowledge_chunks / knowledge_access_policies /
-- knowledge_retrieval_logs) lets a hospital upload SOPs and policies and have
-- AI cite them. WS5 B5.5 adds the *curation* layer so machine-imported
-- knowledge (formulary from pharmacy_catalog, antibiogram from the
-- antibiogram_90d view, protocols from clinical_protocols) is held for a
-- human sign-off BEFORE it can feed a clinical-AI prompt.
--
-- This migration does three additive things:
--
--   1. CURATION COLUMNS on knowledge_documents:
--        curation_status  VARCHAR(20) NOT NULL DEFAULT 'approved'
--                         CHECK (pending|approved|rejected)
--        reviewed_by      UUID
--        reviewed_at      TIMESTAMPTZ
--      DEFAULT 'approved' deliberately preserves the existing manual-upload
--      behaviour: every document already in the corpus, and every future
--      hand-curated inline/upload document, stays immediately retrievable.
--      The B5.5 *importer* explicitly inserts imported docs as 'pending', so
--      machine-imported knowledge is dark until pharmacy / microbiology-
--      infection-control signs it off (knowledgeRetrievalService filters to
--      curation_status='approved'; decideKnowledgeDocument flips it).
--
--   2. knowledge_import_batches — per-run provenance for the import pipeline
--      (scripts/knowledge-curation-import.mjs), mirroring the columns of
--      terminology_import_batches (migration 307) but tenant-scoped, because
--      knowledge_* are RLS tables and a formulary/antibiogram import is always
--      per-tenant. Ops can see when a tenant's corpus was last refreshed and
--      with what row counts.
--
--   3. A clearly-flagged STARTER dataset (analogous to migration 277's
--      is_starter drug-KB set and the B4.5 ICD-11 starter): a tiny sample
--      formulary KB + antibiotic-policy KB under the default tenant, each
--      with one inline sample document, so the import/curation pipeline is
--      demonstrable green in CI without the pilot hospital's live data. The
--      sample docs carry metadata is_starter=true and are seeded
--      processing_status='pending' (no embeddings — chunks/embeddings are
--      produced by reindexDocument once an Ollama embedder is reachable, which
--      CI does not require). curation_status='approved' so the sample is
--      visible end-to-end the moment it is embedded.
--
-- Decision-support only: curated knowledge augments AI prompts; it is never
-- the authority of record. Curation sign-off is owned by the clinical domain
-- (pharmacy for formulary; microbiology / infection-control for antibiogram;
-- the protocol owner for clinical guidelines) — see
-- docs/CLINICAL_AI_KNOWLEDGE_CURATION.md.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Curation columns on knowledge_documents.
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS curation_status VARCHAR(20) NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS reviewed_by     UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at     TIMESTAMPTZ;

-- CHECK constraint added separately so re-runs are safe (ADD CONSTRAINT is not
-- IF NOT EXISTS-aware; guard via the catalog).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_knowledge_documents_curation_status'
  ) THEN
    ALTER TABLE knowledge_documents
      ADD CONSTRAINT chk_knowledge_documents_curation_status
      CHECK (curation_status IN ('pending', 'approved', 'rejected'));
  END IF;
END
$$;

-- Hot-path index for the retrieval filter (curation_status='approved') and for
-- the curation queue (tenant + status).
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_curation
  ON knowledge_documents (tenant_id, curation_status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. knowledge_import_batches — import-run provenance (tenant-scoped).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_import_batches (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_base_id INTEGER REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  source            VARCHAR(40) NOT NULL,
  source_ref        TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  rows_processed    INTEGER NOT NULL DEFAULT 0,
  rows_inserted     INTEGER NOT NULL DEFAULT 0,
  rows_skipped      INTEGER NOT NULL DEFAULT 0,
  rows_failed       INTEGER NOT NULL DEFAULT 0,
  dry_run           BOOLEAN NOT NULL DEFAULT false,
  error_detail      TEXT,
  started_at        TIMESTAMPTZ(6),
  finished_at       TIMESTAMPTZ(6),
  run_by            UUID,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_kib_source
    CHECK (source IN ('formulary', 'antibiogram', 'protocols')),
  CONSTRAINT chk_kib_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_kib_tenant_source_status
  ON knowledge_import_batches (tenant_id, source, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kib_tenant_created
  ON knowledge_import_batches (tenant_id, created_at DESC);

-- RLS: knowledge_import_batches carries tenant_id and provenance about a
-- tenant's PHI-derived corpus, so it joins the tenant-isolation set (mirrors
-- migration 075/304 pattern + the GUC-reading default from migration 310).
ALTER TABLE knowledge_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_import_batches FORCE ROW LEVEL SECURITY;

ALTER TABLE knowledge_import_batches
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DROP POLICY IF EXISTS tenant_isolation ON knowledge_import_batches;
CREATE POLICY tenant_isolation ON knowledge_import_batches
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  );

-- ---------------------------------------------------------------------------
-- 3. Starter dataset — clearly-flagged sample formulary + antibiotic policy.
--    Default-tenant scoped; demonstrable in CI without live hospital data.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant   uuid := '00000000-0000-4000-8000-000000000001';
  v_kb_form  integer;
  v_kb_abx   integer;
BEGIN
  -- Only seed when the default tenant exists (it does in baseline; guard for
  -- exotic bootstraps).
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN
    RAISE NOTICE 'migration 311: default tenant % absent — skipping starter seed', v_tenant;
    RETURN;
  END IF;

  -- Sample formulary KB.
  INSERT INTO knowledge_bases (tenant_id, name, description, kb_type, metadata)
  VALUES (
    v_tenant,
    'Sample Formulary (starter)',
    'Clearly-flagged SAMPLE hospital formulary knowledge base. Replace with a real import from pharmacy_catalog via scripts/knowledge-curation-import.mjs --source formulary.',
    'formulary',
    jsonb_build_object('is_starter', true, 'sample', true, 'workstream', 'WS5 B5.5')
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  SELECT id INTO v_kb_form FROM knowledge_bases
   WHERE tenant_id = v_tenant AND name = 'Sample Formulary (starter)';

  -- Sample antibiotic-policy KB.
  INSERT INTO knowledge_bases (tenant_id, name, description, kb_type, metadata)
  VALUES (
    v_tenant,
    'Sample Antibiogram Policy (starter)',
    'Clearly-flagged SAMPLE antibiogram / antibiotic-policy knowledge base. Replace with a real import from the antibiogram_90d view via scripts/knowledge-curation-import.mjs --source antibiogram.',
    'antibiotic_policy',
    jsonb_build_object('is_starter', true, 'sample', true, 'workstream', 'WS5 B5.5')
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  SELECT id INTO v_kb_abx FROM knowledge_bases
   WHERE tenant_id = v_tenant AND name = 'Sample Antibiogram Policy (starter)';

  -- One sample inline document per KB. processing_status='pending' (no
  -- embeddings here — reindexDocument embeds when an Ollama embedder is up,
  -- which CI does not require). curation_status='approved' so the sample is
  -- retrievable end-to-end once embedded. file_hash makes the importer's
  -- dedup path observable (re-running the importer over the same rendered text
  -- skips on this hash).
  IF v_kb_form IS NOT NULL THEN
    INSERT INTO knowledge_documents
      (knowledge_base_id, tenant_id, title, source_type, mime_type,
       file_hash, file_size_bytes, raw_text, processing_status,
       curation_status, metadata)
    SELECT
      v_kb_form, v_tenant,
      'SAMPLE formulary entry — Paracetamol 500mg',
      'imported', 'text/plain',
      encode(sha256(convert_to('starter:formulary:paracetamol-500', 'UTF8')), 'hex'),
      0,
      E'Formulary entry: Paracetamol 500mg tablet\nGeneric: Paracetamol\nCategory: analgesic-antipyretic\nManufacturer: Sample Pharma\nPack size: 10 tablets\nPrescription required: No\nSOURCE: SAMPLE starter content (not the hospital formulary).',
      'pending', 'approved',
      jsonb_build_object('kind', 'formulary', 'source', 'starter_seed', 'is_starter', true, 'sample', true)
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_documents
       WHERE knowledge_base_id = v_kb_form
         AND tenant_id = v_tenant
         AND file_hash = encode(sha256(convert_to('starter:formulary:paracetamol-500', 'UTF8')), 'hex')
    );
  END IF;

  IF v_kb_abx IS NOT NULL THEN
    INSERT INTO knowledge_documents
      (knowledge_base_id, tenant_id, title, source_type, mime_type,
       file_hash, file_size_bytes, raw_text, processing_status,
       curation_status, metadata)
    SELECT
      v_kb_abx, v_tenant,
      'SAMPLE antibiogram — Escherichia coli (90-day)',
      'imported', 'text/plain',
      encode(sha256(convert_to('starter:antibiogram:e-coli', 'UTF8')), 'hex'),
      0,
      E'Antibiogram (rolling 90-day susceptibility) — Escherichia coli\nTotal isolates tested: 42\nNitrofurantoin: 95% susceptible (40/42)\nAmikacin: 90% susceptible (38/42)\nCiprofloxacin: 48% susceptible (20/42)\nSOURCE: SAMPLE starter content (not live microbiology data). Small-sample organisms (<5 isolates) are suppressed.',
      'pending', 'approved',
      jsonb_build_object('kind', 'antibiogram', 'source', 'starter_seed', 'is_starter', true, 'sample', true)
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_documents
       WHERE knowledge_base_id = v_kb_abx
         AND tenant_id = v_tenant
         AND file_hash = encode(sha256(convert_to('starter:antibiogram:e-coli', 'UTF8')), 'hex')
    );
  END IF;

  RAISE NOTICE 'migration 311: starter formulary KB=% antibiotic-policy KB=%', v_kb_form, v_kb_abx;
END
$$;

-- ---------------------------------------------------------------------------
-- Audit stamp (idempotent — repo convention; mirrors 277 / 307 / 310).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'KNOWLEDGE_CURATION_APPLIED',
  'knowledge_documents',
  'knowledge_documents',
  jsonb_build_object(
    'migration', '311_knowledge_curation.sql',
    'workstream', 'WS5 B5.5 — clinical-AI knowledge layer: formulary/antibiogram/protocol import + curation + refresh',
    'reason', 'Curation columns (curation_status/reviewed_by/reviewed_at) on knowledge_documents, knowledge_import_batches provenance table, and a clearly-flagged sample formulary + antibiotic-policy starter set.',
    'curation_default', 'approved (preserves manual-upload behaviour; importer inserts imported docs as pending)',
    'new_tables', ARRAY['knowledge_import_batches'],
    'sources', ARRAY['pharmacy_catalog', 'antibiogram_90d', 'clinical_protocols'],
    'decision_support_only', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'KNOWLEDGE_CURATION_APPLIED'
    AND resource = 'knowledge_documents'
);

COMMIT;
