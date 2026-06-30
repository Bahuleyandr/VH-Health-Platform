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
// prismaReadOnly must be exported because terminologyService.js (transitively
// required by codingValidationService.js, which clinicalAiWorkflowService.js
// now imports) destructures it at module load.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  prismaReadOnly: __prismaDefaultMock,
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

function safetyFlagsNode() {
  return getAdmissionAiDraftGraph().nodes.build_safety_flags;
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

// ---------------------------------------------------------------------------
// FIX 1 (security review of f8cd10a7): build_safety_flags must evaluate the
// requiresCitations fail-close on chart-packet + RAG citations ONLY. A
// curated-KB citation must NEVER satisfy the gate, even though it is still
// UNIONed into the returned citation set for traceability.
// ---------------------------------------------------------------------------

function kbCitation() {
  return {
    source_type: 'knowledge_chunk',
    source_id: '501',
    label: 'Beta-lactam formulary (sim 0.82)',
  };
}

function safetyState({ packetCitations = [], retrievedCitations = [], kbCitations = [], requiresCitations = true }) {
  return {
    moduleKey: 'medication_reconciliation',
    module: {
      module_key: 'medication_reconciliation',
      settings: requiresCitations ? { requiresCitations: true } : {},
    },
    context: { notes: [], investigations: [], medications: [], allergies: [] },
    draft: { summary: 'Reconciliation complete; continue current plan.' },
    packet: { citations: packetCitations },
    retrieved: { results: retrievedCitations, source: retrievedCitations.length ? 'pgvector' : 'corpus_unavailable' },
    retrievedCitations,
    kbCitations,
  };
}

describe('admission_ai_draft build_safety_flags node — citation fail-close', () => {
  it('raises MISSING_CITATIONS when the ONLY citation is a curated-KB chunk', async () => {
    const delta = await safetyFlagsNode()(safetyState({
      packetCitations: [],
      retrievedCitations: [],
      kbCitations: [kbCitation()],
      requiresCitations: true,
    }));

    // KB citation kept for traceability in the returned set ...
    expect(delta.citations.some((c) => c.source_type === 'knowledge_chunk')).toBe(true);
    // ... but it did NOT satisfy the requiresCitations fail-close.
    expect(delta.safetyFlags.some((f) => f.code === 'MISSING_CITATIONS' && f.severity === 'critical')).toBe(true);
  });

  it('does NOT raise MISSING_CITATIONS when a chart-packet citation is present (KB additive)', async () => {
    const delta = await safetyFlagsNode()(safetyState({
      packetCitations: [{ source_type: 'admission', source_id: '7', label: 'Admission' }],
      retrievedCitations: [],
      kbCitations: [kbCitation()],
      requiresCitations: true,
    }));

    // Base citation satisfies the gate; both base + KB citations are returned.
    expect(delta.safetyFlags.some((f) => f.code === 'MISSING_CITATIONS')).toBe(false);
    expect(delta.citations.some((c) => c.source_type === 'admission')).toBe(true);
    expect(delta.citations.some((c) => c.source_type === 'knowledge_chunk')).toBe(true);
  });

  it('a RAG citation alone satisfies the gate (KB still additive, no flag)', async () => {
    const delta = await safetyFlagsNode()(safetyState({
      packetCitations: [],
      retrievedCitations: [{ source_type: 'discharge_summary', source_id: '3', label: 'Similar prior case' }],
      kbCitations: [kbCitation()],
      requiresCitations: true,
    }));
    expect(delta.safetyFlags.some((f) => f.code === 'MISSING_CITATIONS')).toBe(false);
  });
});
