/**
 * Phase A1 PR3 — knowledgeRetrievalService tests.
 *
 * Pure functions are exercised without a DB; the SQL-touching path is
 * exercised via a stubbed prisma so we can assert the access-policy
 * filter and the retrieval-log writes without an Ollama/pgvector setup.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const embedTextMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/ai/ragService.js', () => ({
  embedText: embedTextMock,
}));

const {
  retrieveFromKnowledgeBases,
  listRetrievalLogs,
  __testing__,
} = await import('../../services/ai/knowledgeRetrievalService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  embedTextMock.mockReset();
});

function vec() {
  return new Array(768).fill(0.1);
}

describe('knowledgeRetrievalService — guard rails', () => {
  it('returns empty_query when text is missing', async () => {
    const result = await retrieveFromKnowledgeBases({ tenantId: TENANT, queryText: '   ', role: 'DOCTOR' });
    expect(result).toEqual({ results: [], source: 'empty_query', query_hash: null });
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('returns no_access when role is missing', async () => {
    const result = await retrieveFromKnowledgeBases({ tenantId: TENANT, queryText: 'sepsis bundle' });
    expect(result.source).toBe('no_access');
    expect(result.results).toEqual([]);
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('returns embed_unavailable when Ollama is down', async () => {
    embedTextMock.mockResolvedValueOnce(null);
    const result = await retrieveFromKnowledgeBases({ tenantId: TENANT, queryText: 'sepsis', role: 'DOCTOR' });
    expect(result.source).toBe('embed_unavailable');
    expect(result.results).toEqual([]);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('returns corpus_unavailable on schema-missing', async () => {
    embedTextMock.mockResolvedValueOnce(vec());
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "knowledge_chunks" does not exist'));
    const result = await retrieveFromKnowledgeBases({ tenantId: TENANT, queryText: 'sepsis', role: 'DOCTOR' });
    expect(result.source).toBe('corpus_unavailable');
  });
});

describe('knowledgeRetrievalService — happy path', () => {
  it('returns chunks above the score threshold and logs each one', async () => {
    embedTextMock.mockResolvedValueOnce(vec());
    queryUnsafeMock.mockResolvedValueOnce([
      { chunk_id: 1, document_id: 5, knowledge_base_id: 7, kb_name: 'SOPs', kb_type: 'sop', document_title: 'doc-A', document_source_type: 'upload', content: 'sepsis bundle text', similarity: 0.92 },
      { chunk_id: 2, document_id: 6, knowledge_base_id: 7, kb_name: 'SOPs', kb_type: 'sop', document_title: 'doc-B', document_source_type: 'upload', content: 'lactate >2 mmol/L', similarity: 0.78 },
      { chunk_id: 3, document_id: 7, knowledge_base_id: 7, kb_name: 'SOPs', kb_type: 'sop', document_title: 'doc-C', document_source_type: 'upload', content: 'irrelevant', similarity: 0.20 },
    ]);
    // Two retrieval-log inserts (one per filtered row).
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    const result = await retrieveFromKnowledgeBases({
      tenantId: TENANT,
      queryText: 'sepsis 1-hour bundle',
      role: 'DOCTOR',
      retrievedBy: 'user-uid',
      moduleKey: 'sepsis_bundle_sentinel',
      minScore: 0.55,
    });

    expect(result.source).toBe('pgvector');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].chunk_id).toBe(1);
    expect(result.results[1].chunk_id).toBe(2);
    // 1 retrieval call + 2 audit inserts.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
  });

  it('logs zero-result attempts so the dashboard can show empty queries', async () => {
    embedTextMock.mockResolvedValueOnce(vec());
    queryUnsafeMock.mockResolvedValueOnce([]); // no rows from retrieval
    queryUnsafeMock.mockResolvedValueOnce([]); // zero-result log insert

    const result = await retrieveFromKnowledgeBases({
      tenantId: TENANT, queryText: 'unknown query', role: 'DOCTOR', moduleKey: 'discharge_summary',
    });
    expect(result.source).toBe('below_threshold');
    expect(result.results).toEqual([]);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    const logCall = queryUnsafeMock.mock.calls[1];
    expect(logCall[0]).toMatch(/INSERT INTO knowledge_retrieval_logs/);
  });

  it('filters chunks below minScore even when DB returned them', async () => {
    embedTextMock.mockResolvedValueOnce(vec());
    queryUnsafeMock.mockResolvedValueOnce([
      { chunk_id: 1, document_id: 5, knowledge_base_id: 7, kb_name: 'SOPs', kb_type: 'sop', document_title: 'doc', document_source_type: 'upload', content: 'x', similarity: 0.40 },
    ]);
    // We expect a below-threshold zero-log insert to fire.
    queryUnsafeMock.mockResolvedValueOnce([]);

    const result = await retrieveFromKnowledgeBases({
      tenantId: TENANT, queryText: 'sepsis', role: 'DOCTOR', minScore: 0.55,
    });
    expect(result.results).toEqual([]);
    expect(result.source).toBe('below_threshold');
  });

  it('passes role into the access-policy SQL filter', async () => {
    embedTextMock.mockResolvedValueOnce(vec());
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]); // zero-log

    await retrieveFromKnowledgeBases({
      tenantId: TENANT, queryText: 'sepsis', role: 'doctor',
    });
    // The first call's $5 binding is the role, and we expect uppercase.
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[5]).toBe('DOCTOR');
    // The SQL should reference knowledge_access_policies in an EXISTS clause.
    expect(args[0]).toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM knowledge_access_policies/);
    // permission filter must allow read | write | manage.
    expect(args[0]).toMatch(/IN \('read', 'write', 'manage'\)/);
  });

  it('caps topK at MAX_TOP_K', async () => {
    embedTextMock.mockResolvedValueOnce(vec());
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    await retrieveFromKnowledgeBases({
      tenantId: TENANT, queryText: 'sepsis', role: 'DOCTOR', topK: 999,
    });
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[6]).toBe(50); // MAX_TOP_K
  });

  it('clamps minScore into [0, 1]', () => {
    expect(__testing__.normalizeMinScore(2)).toBe(1);
    expect(__testing__.normalizeMinScore(-3)).toBe(0);
    expect(__testing__.normalizeMinScore('not-a-number')).toBe(__testing__.DEFAULT_MIN_SCORE);
    expect(__testing__.normalizeMinScore(0.7)).toBe(0.7);
  });
});

describe('knowledgeRetrievalService.listRetrievalLogs', () => {
  it('returns rows scoped to tenant', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, retrieved_at: new Date().toISOString() },
      { id: 2, retrieved_at: new Date().toISOString() },
    ]);
    const result = await listRetrievalLogs({ tenantId: TENANT });
    expect(result.count).toBe(2);
  });

  it('passes optional filters into WHERE clause', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listRetrievalLogs({
      tenantId: TENANT, knowledgeBaseId: 5, moduleKey: 'discharge_summary', limit: 25,
    });
    const args = queryUnsafeMock.mock.calls[0];
    expect(args.slice(1)).toEqual([TENANT, 5, 'discharge_summary', 25]);
  });

  it('returns empty when schema is missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "knowledge_retrieval_logs" does not exist'));
    const result = await listRetrievalLogs({ tenantId: TENANT });
    expect(result).toEqual({ logs: [], count: 0 });
  });
});
