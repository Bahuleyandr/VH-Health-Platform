-- RAG institutional memory corpus.
--
-- Graceful-degradation pattern: if the `vector` extension is not installed
-- on this Postgres cluster, we skip creating the corpus table. The runtime
-- service detects the missing table and returns empty retrievals + a
-- RAG_UNAVAILABLE safety flag — never crashes a clinical AI draft.
--
-- Production deployments MUST install pgvector before this migration runs:
--     apt-get install postgresql-17-pgvector  (Debian/Ubuntu)
--     brew install pgvector                   (macOS)
-- Windows/Docker: pull pgvector/pgvector:pg17 image.

DO $$
DECLARE
  vector_available BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
  ) INTO vector_available;

  IF NOT vector_available THEN
    RAISE NOTICE 'pgvector not available — skipping clinical_ai_corpus creation. Install pgvector + re-run.';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS clinical_ai_corpus (
    id SERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(120) NOT NULL,
    patient_uid UUID,
    chunk_index INT NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    embedding vector(768),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    signed_at TIMESTAMPTZ,
    retention_until DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, source_type, source_id, chunk_index)
  );

  CREATE INDEX IF NOT EXISTS idx_clinical_ai_corpus_tenant_source
    ON clinical_ai_corpus (tenant_id, source_type);
  CREATE INDEX IF NOT EXISTS idx_clinical_ai_corpus_tenant_patient
    ON clinical_ai_corpus (tenant_id, patient_uid);
  CREATE INDEX IF NOT EXISTS idx_clinical_ai_corpus_retention
    ON clinical_ai_corpus (retention_until)
    WHERE retention_until IS NOT NULL;

  -- Cosine-similarity index. ivfflat needs analyze-time rows; we'll set
  -- lists=100 as a reasonable floor and let ops tune later.
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_clinical_ai_corpus_embedding '
         || 'ON clinical_ai_corpus USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ivfflat index not created (likely empty table). Will be created on first retrieval batch.';
  END;
END $$;
