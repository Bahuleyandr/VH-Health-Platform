/**
 * Phase A1 PR1 — verifies migration 113 declares the foundation tables
 * + indexes the knowledge-base service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/113_knowledge_base_foundation.sql',
);

describe('migration 113 — knowledge base foundation', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(800);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it('ensures pgvector extension is available before chunk table', () => {
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i);
  });

  it.each([
    ['knowledge_bases'],
    ['knowledge_documents'],
    ['knowledge_chunks'],
    ['knowledge_access_policies'],
    ['knowledge_retrieval_logs'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
    expect(sql).toMatch(re);
  });

  it('every table is tenant-scoped via a tenant_id UUID column', () => {
    const tableMatches = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tableMatches.length).toBe(5);
    // Every table body should contain a tenant_id column referencing tenants(id).
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(5);
  });

  it('knowledge_bases enforces the kb_type allow-list', () => {
    expect(sql).toMatch(/CHECK \(kb_type IN \([\s\S]*'sop'[\s\S]*'antibiotic_policy'[\s\S]*\)/i);
  });

  it('knowledge_bases enforces the (tenant_id, name) uniqueness constraint', () => {
    expect(sql).toMatch(/UNIQUE \(tenant_id, name\)/i);
  });

  it('knowledge_documents tracks the prompt-injection verdict from S1', () => {
    expect(sql).toMatch(/prompt_injection_verdict\s+VARCHAR\(10\)/i);
    expect(sql).toMatch(/prompt_injection_verdict IN \('pass', 'flag', 'block'\)/i);
    expect(sql).toMatch(/prompt_injection_metadata\s+JSONB/i);
  });

  it('knowledge_chunks declares a 768-dim pgvector embedding column', () => {
    expect(sql).toMatch(/embedding\s+vector\(768\)/i);
  });

  it('knowledge_access_policies enforces the permission allow-list', () => {
    expect(sql).toMatch(/permission IN \('read', 'write', 'manage'\)/i);
    expect(sql).toMatch(/UNIQUE \(knowledge_base_id, role, permission\)/i);
  });

  it('knowledge_retrieval_logs captures retrieved_for_module_key for telemetry', () => {
    expect(sql).toMatch(/retrieved_for_module_key\s+VARCHAR\(80\)/i);
  });

  it('declares indexes for tenant-scoped hot paths', () => {
    const expected = [
      /idx_knowledge_bases_tenant_status/i,
      /idx_knowledge_documents_kb_status/i,
      /idx_knowledge_documents_tenant_status/i,
      /idx_knowledge_chunks_kb_tenant/i,
      /idx_knowledge_chunks_document/i,
      /idx_knowledge_access_kb_role/i,
      /idx_knowledge_retrieval_tenant_time/i,
    ];
    for (const re of expected) {
      expect(sql).toMatch(re);
    }
  });
});
