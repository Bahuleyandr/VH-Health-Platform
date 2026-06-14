/**
 * WS5 B5.5 — curated-KB grounding wired into the generation path.
 *
 * Exercises runExplainerPipeline (the shared chokepoint for the gated OPD
 * modules op_investigation_review + op_follow_up_plan) with a stubbed
 * retrieveFromKnowledgeBases to assert:
 *   (a) gated modules request KB retrieval + UNION curated chunk citations
 *       into the persisted citations + returned source_citations;
 *   (b) non-gated modules do NOT request KB retrieval;
 *   (c) graceful no-op: when the KB returns nothing the draft proceeds with
 *       exactly the chart-packet citations (the requiresCitations gate stays
 *       satisfiable from the chart alone).
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn(() => []);
const retrieveFromKnowledgeBasesMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getModuleMock,
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: generateClinicalTextMock,
}));
jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: runOutputDefensesMock,
}));
// knowledgeGroundingService is the real module under test; only its KB
// dependency is stubbed so we drive grounding deterministically.
jest.unstable_mockModule('../../services/ai/knowledgeRetrievalService.js', () => ({
  retrieveFromKnowledgeBases: retrieveFromKnowledgeBasesMock,
}));

const { __testing__ } = await import('../../services/ai/patientExplainersService.js');
const { runExplainerPipeline } = __testing__;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '22222222-2222-4222-8222-222222222222';

const GATED_KB_TYPES = ['clinical_guideline', 'sop'];

function moduleConfig({ moduleKey, knowledgeBases }) {
  return {
    module_key: moduleKey,
    display_name: moduleKey,
    enabled: true,
    settings: {
      reviewRoles: ['DOCTOR'],
      requiresClinicianSignoff: true,
      requiresCitations: true,
      ...(knowledgeBases ? { knowledgeBases } : {}),
    },
  };
}

function chartCitation() {
  return {
    source_type: 'op_treatment_plan',
    source_id: 'abc123',
    label: 'Type 2 diabetes follow-up',
    timestamp: null,
  };
}

function kbChunkRow(overrides = {}) {
  return {
    chunk_id: 101,
    document_id: 9,
    knowledge_base_id: 3,
    kb_name: 'Diabetes Guideline',
    kb_type: 'clinical_guideline',
    document_title: 'HbA1c monitoring cadence',
    content: 'Recheck HbA1c every 3 months until target, then 6-monthly.',
    similarity: 0.86,
    ...overrides,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);
  retrieveFromKnowledgeBasesMock.mockReset();

  // AI returns a clean draft (no embedded source_citations — the pipeline
  // injects the supplied + KB citations).
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      explanation_summary: 'Follow-up plan drafted.',
      key_points: [],
      next_steps: [],
      when_to_seek_help: [],
      safety_flags: [],
    }),
    usedAi: true,
    provider: 'ollama',
    model: 'qwen2.5:14b',
    usage: {},
  });
  // generation INSERT then review INSERT both succeed.
  queryUnsafeMock
    .mockResolvedValueOnce([{ id: 555 }])
    .mockResolvedValueOnce([{ id: 777 }]);
});

function callPipeline(module) {
  return runExplainerPipeline({
    moduleKey: module.module_key,
    tenantId: TENANT,
    patientUid: PATIENT,
    admissionId: null,
    systemPrompt: 'You are a doctor-facing OPD follow-up planning assistant.',
    userPromptPayload: {
      diagnosis: 'Type 2 diabetes mellitus',
      treatment_plan: 'Metformin 500mg BD, lifestyle advice',
    },
    contextForDefenses: { diagnosis: 'Type 2 diabetes mellitus' },
    citations: [chartCitation()],
    metadata: { source: 'op_ai_assist' },
    generatedBy: 'user-uid',
    req: { user: { uid: 'user-uid', role: 'DOCTOR' } },
  });
}

describe('runExplainerPipeline — curated KB grounding (gated modules)', () => {
  it('requests KB retrieval and UNIONs curated chunk citations for a gated module', async () => {
    getModuleMock.mockResolvedValue(moduleConfig({
      moduleKey: 'op_follow_up_plan',
      knowledgeBases: GATED_KB_TYPES,
    }));
    retrieveFromKnowledgeBasesMock.mockImplementation(async ({ kbType }) => ({
      results: kbType === 'clinical_guideline' ? [kbChunkRow()] : [],
      source: kbType === 'clinical_guideline' ? 'pgvector' : 'below_threshold',
    }));

    const result = await callPipeline(moduleConfig({
      moduleKey: 'op_follow_up_plan',
      knowledgeBases: GATED_KB_TYPES,
    }));

    // KB retrieval was requested once per declared kb_type.
    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalledTimes(GATED_KB_TYPES.length);
    const askedTypes = retrieveFromKnowledgeBasesMock.mock.calls.map((c) => c[0].kbType).sort();
    expect(askedTypes).toEqual([...GATED_KB_TYPES].sort());

    // The returned source_citations UNION the chart citation + curated chunk.
    expect(result.kb_grounded).toBe(true);
    const sourceTypes = result.source_citations.map((c) => c.source_type);
    expect(sourceTypes).toContain('op_treatment_plan'); // chart citation preserved
    expect(sourceTypes).toContain('knowledge_chunk'); // curated chunk added

    // The persisted citations column also includes the curated chunk.
    // args[0] is the SQL string, so SQL $N maps to args[N]; $11 = citations.
    const genInsert = queryUnsafeMock.mock.calls.find((c) => /INSERT INTO clinical_ai_generations/.test(c[0]));
    const persistedCitations = JSON.parse(genInsert[11]); // $11 = citations jsonb
    expect(persistedCitations.some((c) => c.source_type === 'knowledge_chunk')).toBe(true);
    expect(persistedCitations.some((c) => c.source_type === 'op_treatment_plan')).toBe(true);
  });

  it('passes the gated module curated chunks into the LLM user prompt', async () => {
    getModuleMock.mockResolvedValue(moduleConfig({
      moduleKey: 'op_investigation_review',
      knowledgeBases: GATED_KB_TYPES,
    }));
    retrieveFromKnowledgeBasesMock.mockResolvedValue({ results: [kbChunkRow()], source: 'pgvector' });

    await callPipeline(moduleConfig({
      moduleKey: 'op_investigation_review',
      knowledgeBases: GATED_KB_TYPES,
    }));

    const llmCall = generateClinicalTextMock.mock.calls[0][0];
    expect(llmCall.userPrompt).toMatch(/curated_knowledge/);
    expect(llmCall.userPrompt).toMatch(/HbA1c monitoring cadence/);
  });
});

describe('runExplainerPipeline — non-gated modules', () => {
  it('does NOT request KB retrieval for a module with no knowledgeBases gate', async () => {
    getModuleMock.mockResolvedValue(moduleConfig({ moduleKey: 'patient_report_explainer' }));

    const result = await callPipeline(moduleConfig({ moduleKey: 'patient_report_explainer' }));

    expect(retrieveFromKnowledgeBasesMock).not.toHaveBeenCalled();
    expect(result.kb_grounded).toBe(false);
    // Citations are exactly the supplied chart citation — no knowledge_chunk.
    expect(result.source_citations.every((c) => c.source_type !== 'knowledge_chunk')).toBe(true);
  });
});

describe('runExplainerPipeline — graceful no-op', () => {
  it('proceeds with chart-packet citations when the KB returns nothing', async () => {
    getModuleMock.mockResolvedValue(moduleConfig({
      moduleKey: 'op_follow_up_plan',
      knowledgeBases: GATED_KB_TYPES,
    }));
    retrieveFromKnowledgeBasesMock.mockResolvedValue({ results: [], source: 'below_threshold' });

    const result = await callPipeline(moduleConfig({
      moduleKey: 'op_follow_up_plan',
      knowledgeBases: GATED_KB_TYPES,
    }));

    // Gate fired (retrieval attempted) but nothing came back → no KB citations.
    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalled();
    expect(result.kb_grounded).toBe(false);
    expect(result.source_citations).toHaveLength(1);
    expect(result.source_citations[0].source_type).toBe('op_treatment_plan');
    // Draft still produced — requiresCitations gate satisfied by chart alone.
    expect(result.generation_id).toBe(555);
    // The LLM prompt did NOT get a curated_knowledge block.
    expect(generateClinicalTextMock.mock.calls[0][0].userPrompt).not.toMatch(/curated_knowledge/);
  });

  it('never throws when the embedder/KB layer rejects', async () => {
    getModuleMock.mockResolvedValue(moduleConfig({
      moduleKey: 'op_follow_up_plan',
      knowledgeBases: GATED_KB_TYPES,
    }));
    retrieveFromKnowledgeBasesMock.mockRejectedValue(new Error('ollama down'));

    const result = await callPipeline(moduleConfig({
      moduleKey: 'op_follow_up_plan',
      knowledgeBases: GATED_KB_TYPES,
    }));

    expect(result.kb_grounded).toBe(false);
    expect(result.generation_id).toBe(555);
    expect(result.source_citations).toHaveLength(1);
  });
});
