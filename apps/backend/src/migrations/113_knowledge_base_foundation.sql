-- Migration 113: Phase A1 — Knowledge Base CRUD foundation.
--
-- The structural audit's #1 prioritised gap (docs/HEALTHCARE_AI_SPEC_AUDIT.md
-- Phase A1) was the lack of a first-class knowledge-base CRUD module. The
-- existing ragService.js operates only on signed discharge summaries
-- (clinical_ai_corpus); a hospital cannot upload SOPs, antibiotic policies,
-- or patient-education material and have AI cite them. This migration
-- creates the foundation tables.
--
-- Tables:
--   1. knowledge_bases            — top-level container per tenant
--   2. knowledge_documents        — uploaded source docs + processing state
--   3. knowledge_chunks           — chunked text + pgvector embeddings
--   4. knowledge_access_policies  — role-based read/write/manage grants
--   5. knowledge_retrieval_logs   — audit trail for permission-filtered RAG
--
-- This migration ships the schema only. PR2 wires the upload pipeline,
-- PR3 wires retrieval, PR4 lands the admin UI. Each is independently
-- shippable.
--
-- Tenant isolation: every table carries tenant_id directly so the hot-path
-- queries don't need to JOIN through knowledge_bases. RLS policies via
-- migration 075's setTenant pattern apply at the access layer.
--
-- Decision-support only: KB content feeds AI prompts but is never the
-- authority of record. Source citations always trace back to a chunk +
-- document so reviewers can verify.

BEGIN;

-- pgvector should already be installed by an earlier migration (used by
-- clinical_ai_corpus). Make idempotent here in case of rebuild ordering.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            VARCHAR(160) NOT NULL,
  description     TEXT,
  kb_type         VARCHAR(40) NOT NULL DEFAULT 'general'
    CHECK (kb_type IN (
      'general', 'sop', 'antibiotic_policy', 'patient_education',
      'clinical_guideline', 'formulary', 'safety_alert', 'training'
    )),
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by      UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant_status
  ON knowledge_bases (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant_type
  ON knowledge_bases (tenant_id, kb_type);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                          SERIAL PRIMARY KEY,
  knowledge_base_id           INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title                       VARCHAR(255) NOT NULL,
  source_type                 VARCHAR(60) NOT NULL DEFAULT 'upload'
    CHECK (source_type IN ('upload', 'url', 'inline_text', 'imported')),
  source_uri                  TEXT,
  mime_type                   VARCHAR(120),
  file_hash                   VARCHAR(64),
  file_size_bytes             BIGINT,
  raw_text                    TEXT,
  processing_status           VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN (
      'pending', 'extracting', 'chunking', 'embedding',
      'indexed', 'failed', 'blocked'
    )),
  processing_error            TEXT,
  chunk_count                 INTEGER NOT NULL DEFAULT 0,
  prompt_injection_verdict    VARCHAR(10)
    CHECK (prompt_injection_verdict IS NULL
           OR prompt_injection_verdict IN ('pass', 'flag', 'block')),
  prompt_injection_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by                 UUID,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kb_status
  ON knowledge_documents (knowledge_base_id, processing_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tenant_status
  ON knowledge_documents (tenant_id, processing_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tenant_hash
  ON knowledge_documents (tenant_id, file_hash) WHERE file_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                  SERIAL PRIMARY KEY,
  document_id         INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  knowledge_base_id   INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_index         INTEGER NOT NULL,
  content             TEXT NOT NULL,
  embedding           vector(768),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_kb_tenant
  ON knowledge_chunks (knowledge_base_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
  ON knowledge_chunks (document_id, chunk_index);

CREATE TABLE IF NOT EXISTS knowledge_access_policies (
  id                  SERIAL PRIMARY KEY,
  knowledge_base_id   INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role                VARCHAR(60) NOT NULL,
  permission          VARCHAR(20) NOT NULL DEFAULT 'read'
    CHECK (permission IN ('read', 'write', 'manage')),
  granted_by          UUID,
  granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (knowledge_base_id, role, permission)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_access_kb_role
  ON knowledge_access_policies (knowledge_base_id, role);
CREATE INDEX IF NOT EXISTS idx_knowledge_access_tenant_role
  ON knowledge_access_policies (tenant_id, role);

CREATE TABLE IF NOT EXISTS knowledge_retrieval_logs (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_base_id           INTEGER REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  chunk_id                    INTEGER REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
  retrieved_by                UUID,
  retrieved_by_role           VARCHAR(60),
  retrieved_for_module_key    VARCHAR(80),
  query_hash                  VARCHAR(64),
  similarity                  NUMERIC(5, 4),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  retrieved_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_tenant_time
  ON knowledge_retrieval_logs (tenant_id, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_kb_time
  ON knowledge_retrieval_logs (knowledge_base_id, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_module_time
  ON knowledge_retrieval_logs (retrieved_for_module_key, retrieved_at DESC);

COMMIT;
