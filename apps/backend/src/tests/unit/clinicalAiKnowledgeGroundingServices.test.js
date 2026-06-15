/**
 * WS5 B5.5 — curated-KB grounding in the antimicrobial + pathway generation
 * paths (the two gated modules that bypass runExplainerPipeline and call
 * generateClinicalText directly).
 *
 * Asserts, for each path:
 *   (a) a gated module requests KB retrieval (once per declared kb_type),
 *       feeds curated chunks into the LLM prompt, and UNIONs curated chunk
 *       citations into the persisted citations;
 *   (b) a disabled gate (no chunks) leaves the rule-derived citations intact
 *       so the citations fail-close stays satisfiable from the chart/rules;
 *   (c) a KB-layer failure never breaks generation.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn(() => []);
const publishEventMock = jest.fn(async () => ({}));
const collectAdmissionContextMock = jest.fn();
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
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));
jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  collectAdmissionClinicalContext: collectAdmissionContextMock,
}));
jest.unstable_mockModule('../../services/ai/knowledgeRetrievalService.js', () => ({
  retrieveFromKnowledgeBases: retrieveFromKnowledgeBasesMock,
}));

const { generateAntimicrobialStewardshipReview } = await import('../../services/ai/antimicrobialStewardshipService.js');
const { evaluatePathwayBundle } = await import('../../services/ai/pathwayBundleComplianceService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '22222222-2222-4222-8222-222222222222';

function moduleConfig(moduleKey, knowledgeBases) {
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

function kbChunkRow(overrides = {}) {
  return {
    chunk_id: 301,
    document_id: 12,
    knowledge_base_id: 4,
    kb_name: 'Antibiotic Policy',
    kb_type: 'antibiotic_policy',
    document_title: 'Empiric pneumonia therapy',
    content: 'De-escalate to oral amoxicillin once afebrile 48h.',
    similarity: 0.84,
    ...overrides,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);
  publishEventMock.mockReset().mockResolvedValue({});
  collectAdmissionContextMock.mockReset();
  retrieveFromKnowledgeBasesMock.mockReset();

  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({ summary: 'AI narrative.', source_citations: [], safety_flags: [] }),
    usedAi: true,
    provider: 'ollama',
    model: 'qwen2.5:14b',
    usage: {},
  });
});

// ---------------------------------------------------------------------------
// Antimicrobial stewardship path
// ---------------------------------------------------------------------------

describe('generateAntimicrobialStewardshipReview — curated KB grounding', () => {
  beforeEach(() => {
    // Minimal admission context with an active antibiotic so the rule engine
    // emits citations + a non-empty antibiotic_summary.
    collectAdmissionContextMock.mockResolvedValue({
      patient: { uid: PATIENT, name: 'Test Patient' },
      admission: { id: 7, patient_uid: PATIENT, status: 'admitted', chief_complaint: 'pneumonia' },
      medications: [{ id: 1, event_type: 'medication', summary: 'Ceftriaxone IV', payload: { medication_name: 'Ceftriaxone', route: 'iv' }, timestamp: '2026-06-10T00:00:00Z' }],
      orders: [],
      notes: [],
      investigations: [],
      vitals: [],
      allergies: [],
      citations: [],
    });
    // antimicrobial_reviews INSERT returns a row; generation + clinical
    // review + any other inserts return a generic row.
    queryUnsafeMock.mockResolvedValue([{ id: 99, reviewer_decision: 'pending' }]);
  });

  it('requests KB retrieval and UNIONs curated citations for the gated module', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('antimicrobial_stewardship', ['antibiotic_policy', 'clinical_guideline', 'formulary']));
    retrieveFromKnowledgeBasesMock.mockImplementation(async ({ kbType }) => ({
      results: kbType === 'antibiotic_policy' ? [kbChunkRow()] : [],
      source: kbType === 'antibiotic_policy' ? 'pgvector' : 'below_threshold',
    }));

    const result = await generateAntimicrobialStewardshipReview({
      req: { tenantId: TENANT, user: { uid: 'user-uid', role: 'PHARMACY_STAFF' } },
      admissionId: 7,
    });

    // Retrieval requested once per declared kb_type.
    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalledTimes(3);
    expect(retrieveFromKnowledgeBasesMock.mock.calls.map((c) => c[0].kbType).sort())
      .toEqual(['antibiotic_policy', 'clinical_guideline', 'formulary']);

    // Curated chunk fed into the LLM prompt.
    expect(generateClinicalTextMock.mock.calls[0][0].userPrompt).toMatch(/curated_knowledge/);

    // Curated chunk citation present in the returned citation set, UNIONed
    // with the rule-derived chart citations.
    const citeTypes = result.source_citations.map((c) => c.source_type);
    expect(citeTypes).toContain('knowledge_chunk');
  });

  it('leaves rule-derived citations intact when the KB returns nothing (gate graceful)', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('antimicrobial_stewardship', ['antibiotic_policy', 'clinical_guideline', 'formulary']));
    retrieveFromKnowledgeBasesMock.mockResolvedValue({ results: [], source: 'below_threshold' });

    const result = await generateAntimicrobialStewardshipReview({
      req: { tenantId: TENANT, user: { uid: 'user-uid', role: 'PHARMACY_STAFF' } },
      admissionId: 7,
    });

    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalled();
    // No curated citations; generation still produced.
    expect(result.source_citations.every((c) => c.source_type !== 'knowledge_chunk')).toBe(true);
    expect(result.generation_id).toBeDefined();
    expect(generateClinicalTextMock.mock.calls[0][0].userPrompt).not.toMatch(/curated_knowledge/);
  });

  it('never throws when the KB layer rejects', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('antimicrobial_stewardship', ['antibiotic_policy']));
    retrieveFromKnowledgeBasesMock.mockRejectedValue(new Error('ollama down'));

    await expect(generateAntimicrobialStewardshipReview({
      req: { tenantId: TENANT, user: { uid: 'user-uid', role: 'PHARMACY_STAFF' } },
      admissionId: 7,
    })).resolves.toMatchObject({ module_key: 'antimicrobial_stewardship' });
  });

  // FIX 1 (security review of f8cd10a7): a curated-KB citation must NEVER
  // satisfy the NO_STEWARDSHIP_CITATIONS fail-close. With an empty chart
  // packet (zero rule-derived citations) but a KB chunk returned, the
  // gate must STILL fire because it is evaluated on base citations only.
  it('STILL raises NO_STEWARDSHIP_CITATIONS when the ONLY citation is a curated-KB chunk', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('antimicrobial_stewardship', ['antibiotic_policy']));
    // Empty chart packet → rule engine yields no base citations.
    collectAdmissionContextMock.mockResolvedValue({
      patient: { uid: PATIENT, name: 'Test Patient' },
      admission: { id: 7, patient_uid: PATIENT, status: 'admitted', chief_complaint: 'pneumonia' },
      medications: [],
      orders: [],
      notes: [],
      investigations: [],
      vitals: [],
      allergies: [],
      citations: [],
    });
    // AI returns no citations of its own.
    generateClinicalTextMock.mockResolvedValue({
      text: JSON.stringify({ summary: 'AI narrative.', source_citations: [], safety_flags: [] }),
      usedAi: true,
      provider: 'ollama',
      model: 'qwen2.5:14b',
      usage: {},
    });
    // But the KB DOES return an approved chunk.
    retrieveFromKnowledgeBasesMock.mockResolvedValue({ results: [kbChunkRow()], source: 'pgvector' });

    const result = await generateAntimicrobialStewardshipReview({
      req: { tenantId: TENANT, user: { uid: 'user-uid', role: 'PHARMACY_STAFF' } },
      admissionId: 7,
    });

    // The KB citation is present (traceability) ...
    expect(result.source_citations.some((c) => c.source_type === 'knowledge_chunk')).toBe(true);
    // ... but it did NOT satisfy the fail-close: the gate still fired.
    expect(result.safety_flags.some((f) => f.code === 'NO_STEWARDSHIP_CITATIONS')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pathway bundle compliance path
// ---------------------------------------------------------------------------

describe('evaluatePathwayBundle — curated KB grounding', () => {
  beforeEach(() => {
    // audit INSERT returns a row; generation + clinical review return rows.
    queryUnsafeMock.mockResolvedValue([{ id: 88, reviewer_decision: 'pending' }]);
  });

  function callPathway() {
    return evaluatePathwayBundle({
      req: { tenantId: TENANT, user: { uid: 'user-uid', role: 'DOCTOR' } },
      patientUid: PATIENT,
      pathwayKey: 'acs_mona',
      t0Reference: '2026-06-10T10:00:00Z',
      actions: [{ item_key: 'aspirin', occurred_at: '2026-06-10T10:05:00Z' }],
      context: { pci_candidate: false, beta_blocker_contraindicated: false },
    });
  }

  it('requests KB retrieval and UNIONs curated citations for the gated module', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('pathway_bundle_compliance', ['clinical_guideline', 'sop']));
    retrieveFromKnowledgeBasesMock.mockImplementation(async ({ kbType }) => ({
      results: kbType === 'clinical_guideline' ? [kbChunkRow({ chunk_id: 401, kb_type: 'clinical_guideline', document_title: 'ACS pathway' })] : [],
      source: kbType === 'clinical_guideline' ? 'pgvector' : 'below_threshold',
    }));

    const result = await callPathway();

    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalledTimes(2);
    expect(retrieveFromKnowledgeBasesMock.mock.calls.map((c) => c[0].kbType).sort())
      .toEqual(['clinical_guideline', 'sop']);
    expect(generateClinicalTextMock.mock.calls[0][0].userPrompt).toMatch(/curated_knowledge/);
    const citeTypes = result.source_citations.map((c) => c.source_type);
    expect(citeTypes).toContain('knowledge_chunk');
    // Rule-derived pathway citations still present (gate is additive).
    expect(citeTypes).toContain('pathway_bundle_rules');
  });

  it('leaves rule-derived citations intact when the KB returns nothing', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('pathway_bundle_compliance', ['clinical_guideline', 'sop']));
    retrieveFromKnowledgeBasesMock.mockResolvedValue({ results: [], source: 'below_threshold' });

    const result = await callPathway();

    expect(retrieveFromKnowledgeBasesMock).toHaveBeenCalled();
    expect(result.source_citations.every((c) => c.source_type !== 'knowledge_chunk')).toBe(true);
    expect(result.source_citations.some((c) => c.source_type === 'pathway_bundle_rules')).toBe(true);
    expect(generateClinicalTextMock.mock.calls[0][0].userPrompt).not.toMatch(/curated_knowledge/);
  });

  it('does NOT request KB retrieval when the module declares no knowledgeBases gate', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('pathway_bundle_compliance')); // no gate
    await callPathway();
    expect(retrieveFromKnowledgeBasesMock).not.toHaveBeenCalled();
  });

  // FIX 1 (security review of f8cd10a7): the NO_CITATIONS fail-close is
  // evaluated on the rule-derived (base) citations ONLY. The pathway path
  // always produces base citations (patient / pathway_preset / rules), so
  // NO_CITATIONS must NOT appear, and unioning a curated-KB chunk in must
  // not perturb that — KB is additive traceability, never a gate input.
  it('does NOT raise NO_CITATIONS and keeps KB citations additive (gate sees base only)', async () => {
    getModuleMock.mockResolvedValue(moduleConfig('pathway_bundle_compliance', ['clinical_guideline']));
    retrieveFromKnowledgeBasesMock.mockResolvedValue({
      results: [kbChunkRow({ chunk_id: 402, kb_type: 'clinical_guideline', document_title: 'ACS pathway' })],
      source: 'pgvector',
    });

    const result = await callPathway();

    // KB citation present for traceability ...
    expect(result.source_citations.some((c) => c.source_type === 'knowledge_chunk')).toBe(true);
    // ... base rule citations present ...
    expect(result.source_citations.some((c) => c.source_type === 'pathway_bundle_rules')).toBe(true);
    // ... and the citation fail-close did not fire (base citations exist).
    expect(result.safety_flags.some((f) => f.code === 'NO_CITATIONS')).toBe(false);
  });
});
