/**
 * WS5 B5.5 — knowledgeGroundingService unit tests.
 *
 * Exercises the per-module declarative gate, the additive/graceful contract,
 * and the chunk → grounding-context / citation mapping with a stubbed
 * retrieveFromKnowledgeBases (no embedder / pgvector needed).
 */

import { jest } from '@jest/globals';

const retrieveMock = jest.fn();

jest.unstable_mockModule('../../services/ai/knowledgeRetrievalService.js', () => ({
  retrieveFromKnowledgeBases: retrieveMock,
}));

const {
  groundWithKnowledgeBases,
  knowledgeBaseTypesForModule,
  moduleUsesKnowledgeGrounding,
  __testing__,
} = await import('../../services/ai/knowledgeGroundingService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function gatedModule(kbTypes = ['antibiotic_policy', 'formulary']) {
  return {
    module_key: 'antimicrobial_stewardship',
    display_name: 'Antimicrobial Stewardship Assistant',
    enabled: true,
    settings: { knowledgeBases: kbTypes, reviewRoles: ['DOCTOR'] },
  };
}

function nonGatedModule() {
  return {
    module_key: 'denial_risk_assist',
    display_name: 'Denial Risk Assist',
    enabled: true,
    settings: { reviewRoles: ['BILLING_STAFF'] },
  };
}

function chunkRow(overrides = {}) {
  return {
    chunk_id: 1,
    document_id: 5,
    knowledge_base_id: 7,
    kb_name: 'Antibiotic Policy',
    kb_type: 'antibiotic_policy',
    document_title: 'Empiric therapy — pneumonia',
    content: 'Prefer narrow-spectrum agents per antibiogram.',
    similarity: 0.88,
    ...overrides,
  };
}

beforeEach(() => {
  retrieveMock.mockReset();
});

describe('knowledgeBaseTypesForModule / moduleUsesKnowledgeGrounding', () => {
  it('returns the declared kb_types lower-cased + de-duplicated', () => {
    const module = gatedModule(['Antibiotic_Policy', 'FORMULARY', 'formulary', '']);
    expect(knowledgeBaseTypesForModule(module)).toEqual(['antibiotic_policy', 'formulary']);
    expect(moduleUsesKnowledgeGrounding(module)).toBe(true);
  });

  it('returns [] for a module with no knowledgeBases gate', () => {
    expect(knowledgeBaseTypesForModule(nonGatedModule())).toEqual([]);
    expect(moduleUsesKnowledgeGrounding(nonGatedModule())).toBe(false);
  });

  it('treats a missing/empty settings object as non-gated', () => {
    expect(moduleUsesKnowledgeGrounding({})).toBe(false);
    expect(moduleUsesKnowledgeGrounding({ settings: {} })).toBe(false);
    expect(moduleUsesKnowledgeGrounding({ settings: { knowledgeBases: [] } })).toBe(false);
  });
});

describe('groundWithKnowledgeBases — gate', () => {
  it('no-ops (no retrieval call) for a non-gated module', async () => {
    const result = await groundWithKnowledgeBases({
      module: nonGatedModule(),
      tenantId: TENANT,
      queryText: 'sepsis pneumonia ceftriaxone',
    });
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ used: false, gated: false, citations: [], groundingChunks: [] });
  });

  it('no-ops when the query text is empty even if gated', async () => {
    const result = await groundWithKnowledgeBases({
      module: gatedModule(),
      tenantId: TENANT,
      queryText: '   ',
    });
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(result.used).toBe(false);
    expect(result.gated).toBe(true);
  });

  it('queries retrieveFromKnowledgeBases once per declared kb_type', async () => {
    retrieveMock.mockResolvedValue({ results: [], source: 'below_threshold' });
    await groundWithKnowledgeBases({
      module: gatedModule(['antibiotic_policy', 'clinical_guideline', 'formulary']),
      tenantId: TENANT,
      queryText: 'pneumonia ceftriaxone',
      role: 'pharmacy_staff',
      moduleKey: 'antimicrobial_stewardship',
    });
    expect(retrieveMock).toHaveBeenCalledTimes(3);
    // kbType is forwarded per call; role is upper-cased; moduleKey threaded.
    const kbTypesAsked = retrieveMock.mock.calls.map((c) => c[0].kbType).sort();
    expect(kbTypesAsked).toEqual(['antibiotic_policy', 'clinical_guideline', 'formulary']);
    for (const call of retrieveMock.mock.calls) {
      expect(call[0].role).toBe('PHARMACY_STAFF');
      expect(call[0].moduleKey).toBe('antimicrobial_stewardship');
      expect(call[0].tenantId).toBe(TENANT);
    }
  });
});

describe('groundWithKnowledgeBases — chunk mapping', () => {
  it('maps approved chunks into grounding context + curated citations', async () => {
    retrieveMock
      .mockResolvedValueOnce({ results: [chunkRow({ chunk_id: 1, similarity: 0.91 })], source: 'pgvector' })
      .mockResolvedValueOnce({ results: [chunkRow({ chunk_id: 2, kb_type: 'formulary', similarity: 0.74, document_title: 'Formulary — beta-lactams' })], source: 'pgvector' });

    const result = await groundWithKnowledgeBases({
      module: gatedModule(['antibiotic_policy', 'formulary']),
      tenantId: TENANT,
      queryText: 'pneumonia ceftriaxone',
      moduleKey: 'antimicrobial_stewardship',
    });

    expect(result.used).toBe(true);
    expect(result.groundingChunks).toHaveLength(2);
    // Sorted by similarity desc — highest first.
    expect(result.groundingChunks[0].chunk_id).toBe(1);
    expect(result.groundingChunks[1].chunk_id).toBe(2);
    // Every curated citation is a knowledge_chunk with provenance.
    expect(result.citations).toHaveLength(2);
    for (const cite of result.citations) {
      expect(cite.source_type).toBe('knowledge_chunk');
      expect(cite.knowledge_base_id).toBe(7);
      expect(typeof cite.source_id).toBe('string');
    }
    expect(result.sources).toEqual({ antibiotic_policy: 'pgvector', formulary: 'pgvector' });
  });

  it('caps grounding chunks at MAX_GROUNDING_CHUNKS', async () => {
    // Distinct chunk_ids per kb_type so dedup doesn't collapse them: 2
    // kb_types × 10 unique rows = 20 candidates, capped at the max.
    retrieveMock
      .mockResolvedValueOnce({
        results: Array.from({ length: 10 }, (_, i) => chunkRow({ chunk_id: 100 + i, similarity: 0.9 - i * 0.01 })),
        source: 'pgvector',
      })
      .mockResolvedValueOnce({
        results: Array.from({ length: 10 }, (_, i) => chunkRow({ chunk_id: 200 + i, similarity: 0.89 - i * 0.01 })),
        source: 'pgvector',
      });
    const result = await groundWithKnowledgeBases({
      module: gatedModule(['antibiotic_policy', 'clinical_guideline']),
      tenantId: TENANT,
      queryText: 'pneumonia',
    });
    expect(result.groundingChunks.length).toBe(__testing__.MAX_GROUNDING_CHUNKS);
  });

  it('de-duplicates the same chunk_id across kb_types', async () => {
    retrieveMock.mockResolvedValue({ results: [chunkRow({ chunk_id: 42 })], source: 'pgvector' });
    const result = await groundWithKnowledgeBases({
      module: gatedModule(['antibiotic_policy', 'clinical_guideline']),
      tenantId: TENANT,
      queryText: 'pneumonia',
    });
    expect(result.groundingChunks).toHaveLength(1);
    expect(result.groundingChunks[0].chunk_id).toBe(42);
  });
});

describe('groundWithKnowledgeBases — graceful degradation', () => {
  it('returns used:false (no throw) when the KB returns nothing', async () => {
    retrieveMock.mockResolvedValue({ results: [], source: 'below_threshold' });
    const result = await groundWithKnowledgeBases({
      module: gatedModule(),
      tenantId: TENANT,
      queryText: 'pneumonia',
    });
    expect(result.used).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.groundingChunks).toEqual([]);
  });

  it('returns used:false when the embedder is unavailable', async () => {
    retrieveMock.mockResolvedValue({ results: [], source: 'embed_unavailable' });
    const result = await groundWithKnowledgeBases({
      module: gatedModule(),
      tenantId: TENANT,
      queryText: 'pneumonia',
    });
    expect(result.used).toBe(false);
    expect(result.sources.antibiotic_policy).toBe('embed_unavailable');
  });

  it('never throws if retrieveFromKnowledgeBases rejects — degrades to empty', async () => {
    retrieveMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ results: [chunkRow({ chunk_id: 3, kb_type: 'formulary' })], source: 'pgvector' });
    const result = await groundWithKnowledgeBases({
      module: gatedModule(['antibiotic_policy', 'formulary']),
      tenantId: TENANT,
      queryText: 'pneumonia',
    });
    // First kb_type errored but the second still contributed a chunk.
    expect(result.used).toBe(true);
    expect(result.groundingChunks).toHaveLength(1);
    expect(result.sources.antibiotic_policy).toBe('grounding_error');
    expect(result.sources.formulary).toBe('pgvector');
  });
});
