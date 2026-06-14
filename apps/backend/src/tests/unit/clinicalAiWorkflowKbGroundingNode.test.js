/**
 * WS5 B5.5 — the kb_grounding node in the admission_ai_draft workflow graph
 * (the generation path used by medication_reconciliation).
 *
 * Invokes the graph node in isolation with a stubbed retrieveFromKnowledgeBases
 * to assert it is gated, additive, and graceful:
 *   - gated module → curated chunks merged into the packet + kbCitations;
 *   - non-gated module → no retrieval, packet/citations unchanged;
 *   - empty KB → no-op.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const retrieveFromKnowledgeBasesMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../services/ai/knowledgeRetrievalService.js', () => ({
  retrieveFromKnowledgeBases: retrieveFromKnowledgeBasesMock,
}));

const { getAdmissionAiDraftGraph } = await import('../../services/ai/clinicalAiWorkflowService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function kbNode() {
  return getAdmissionAiDraftGraph().nodes.kb_grounding;
}

function baseState({ knowledgeBases } = {}) {
  return {
    moduleKey: 'medication_reconciliation',
    tenantId: TENANT,
    requestedBy: 'user-uid',
    requestContext: { requested_by_role: 'PHARMACY_STAFF' },
    module: {
      module_key: 'medication_reconciliation',
      settings: knowledgeBases ? { knowledgeBases } : {},
    },
    packet: {
      admission: { chief_complaint: 'pneumonia', admitting_diagnosis: 'CAP' },
      active_diagnoses: [{ summary: 'Community-acquired pneumonia' }],
      medications: [{ summary: 'Ceftriaxone 1g IV OD' }],
      citations: [{ source_type: 'admission', source_id: '7', label: 'Admission' }],
    },
    retrievedCitations: [],
  };
}

function kbChunkRow() {
  return {
    chunk_id: 501,
    document_id: 22,
    knowledge_base_id: 5,
    kb_name: 'Formulary',
    kb_type: 'formulary',
    document_title: 'Beta-lactam formulary',
    content: 'Preferred oral step-down: amoxicillin-clavulanate.',
    similarity: 0.82,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  retrieveFromKnowledgeBasesMock.mockReset();
});

describe('admission_ai_draft kb_grounding node', () => {
  it('the node exists in the graph between rag_retrieve and memory_retrieve', () => {
    const order = Object.keys(getAdmissionAiDraftGraph().nodes);
    expect(order).toContain('kb_grounding');
    expect(order.indexOf('kb_grounding')).toBeGreaterThan(order.indexOf('rag_retrieve'));
    expect(order.indexOf('kb_grounding')).toBeLessThan(order.indexOf('memory_retrieve'));
  });

  it('grounds a gated module: merges curated chunks into packet + kbCitations', async () => {
    retrieveFromKnowledgeBasesMock.mockImplementation(async ({ kbType }) => ({
      results: kbType === 'formulary' ? [kbChunkRow()] : [],
      source: kbType === 'formulary' ? 'pgvector' : 'below_threshold',
    }));

    const delta = await kbNode()(baseState({ knowledgeBases: ['formulary', 'clinical_guideline'] }));

    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalledTimes(2);
    // role threaded from requestContext, upper-cased.
    expect(retrieveFromKnowledgeBasesMock.mock.calls[0][0].role).toBe('PHARMACY_STAFF');
    expect(delta.kbGrounding.used).toBe(true);
    expect(delta.kbCitations.some((c) => c.source_type === 'knowledge_chunk')).toBe(true);
    // packet gains curated_knowledge but keeps its original citations.
    expect(delta.packet.curated_knowledge).toHaveLength(1);
    expect(delta.packet.citations).toHaveLength(1);
  });

  it('no-ops for a non-gated module (no retrieval, packet unchanged)', async () => {
    const state = baseState(); // no knowledgeBases
    const delta = await kbNode()(state);
    expect(retrieveFromKnowledgeBasesMock).not.toHaveBeenCalled();
    expect(delta.kbCitations).toEqual([]);
    expect(delta.packet.curated_knowledge).toBeUndefined();
    expect(delta.packet).toBe(state.packet); // same ref — untouched
  });

  it('no-ops gracefully when the gated KB returns nothing', async () => {
    retrieveFromKnowledgeBasesMock.mockResolvedValue({ results: [], source: 'below_threshold' });
    const state = baseState({ knowledgeBases: ['formulary', 'clinical_guideline'] });
    const delta = await kbNode()(state);
    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalled();
    expect(delta.kbGrounding.used).toBe(false);
    expect(delta.kbCitations).toEqual([]);
    expect(delta.packet.curated_knowledge).toBeUndefined();
  });
});
