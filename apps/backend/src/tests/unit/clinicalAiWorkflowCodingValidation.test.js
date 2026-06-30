/**
 * Task 2 unit test — coding-validation wiring in the build_safety_flags node.
 *
 * Verifies that for clinical_coding_assist the node:
 *   (a) calls annotateCodingDraft and replaces draft.suggested_codes with the
 *       annotated array returned by the service;
 *   (b) merges any UNVALIDATED_CODE safety flags into safetyFlags;
 *   (c) does NOT call annotateCodingDraft for other module keys.
 *
 * The node is accessed via getAdmissionAiDraftGraph().nodes.build_safety_flags,
 * the same isolation pattern used by clinicalAiWorkflowKbGroundingNode.test.js.
 */

import { jest } from '@jest/globals';

// ── mocks ──────────────────────────────────────────────────────────────────

const annotateCodingDraftMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: jest.fn(),
};

// prismaReadOnly must be exported because terminologyService.js (imported
// transitively via codingValidationService.js) destructures it at module load.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  prismaReadOnly: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/ai/codingValidationService.js', () => ({
  annotateCodingDraft: annotateCodingDraftMock,
  default: { annotateCodingDraft: annotateCodingDraftMock },
}));

const { getAdmissionAiDraftGraph } = await import('../../services/ai/clinicalAiWorkflowService.js');

// ── helpers ────────────────────────────────────────────────────────────────

const TENANT = '00000000-0000-4000-8000-000000000001';

function safetyFlagsNode() {
  return getAdmissionAiDraftGraph().nodes.build_safety_flags;
}

/**
 * Minimal state for build_safety_flags that does NOT trigger other
 * complex paths (requiresCitations false, no RAG corpus failure, signed note
 * present so NO_SIGNED_DOCUMENTATION won't fire for coding module).
 */
function baseState({ moduleKey, draft }) {
  return {
    moduleKey,
    tenantId: TENANT,
    module: {
      module_key: moduleKey,
      settings: { requiresCitations: false },
    },
    context: {
      notes: [{ payload: { is_signed: true } }],
      investigations: [],
      medications: [],
      allergies: [],
    },
    draft,
    packet: {
      citations: [{ source_type: 'admission', source_id: '1', label: 'Admission' }],
    },
    retrieved: { results: [{ id: 1 }], source: 'pgvector' },
    retrievedCitations: [],
    kbCitations: [],
  };
}

const UNVALIDATED_FLAG = {
  type: 'UNVALIDATED_CODE',
  severity: 'medium',
  detail: '1 suggested ICD-10 code(s) not found in the terminology master',
};

const ANNOTATED_CODES = [
  { system: 'ICD10', code: 'J18.9', display: 'Pneumonia, unspecified', validated: true, confidence: 'medium' },
  { system: 'ICD10', code: 'ZZZZ.99', display: null, validated: false, confidence: 'low' },
];

// ── tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  annotateCodingDraftMock.mockReset();
});

describe('build_safety_flags — clinical_coding_assist wiring', () => {
  it('annotates suggested_codes and merges UNVALIDATED_CODE flags', async () => {
    const draft = {
      suggested_codes: [
        { code: 'J18.9', description: 'Pneumonia' },
        { code: 'ZZZZ.99', description: 'Unknown' },
      ],
      evidence: 'Patient chart 2026-06-16.',
      coder_notes: 'Review required.',
    };

    annotateCodingDraftMock.mockResolvedValue({
      suggested_codes: ANNOTATED_CODES,
      safety_flags: [UNVALIDATED_FLAG],
    });

    const delta = await safetyFlagsNode()(baseState({ moduleKey: 'clinical_coding_assist', draft }));

    // The mock must have been called exactly once with the draft and tenantId.
    expect(annotateCodingDraftMock).toHaveBeenCalledTimes(1);
    expect(annotateCodingDraftMock).toHaveBeenCalledWith(draft, { tenantId: TENANT });

    // The draft object is mutated in-place — suggested_codes replaced.
    expect(draft.suggested_codes).toBe(ANNOTATED_CODES);

    // The UNVALIDATED_CODE flag must appear in the returned safetyFlags.
    expect(delta.safetyFlags.some((f) => f.type === 'UNVALIDATED_CODE')).toBe(true);
    const flag = delta.safetyFlags.find((f) => f.type === 'UNVALIDATED_CODE');
    expect(flag.severity).toBe('medium');
  });

  it('does not call annotateCodingDraft when suggested_codes is absent', async () => {
    const draft = { evidence: 'chart', coder_notes: 'none' }; // no suggested_codes
    const delta = await safetyFlagsNode()(baseState({ moduleKey: 'clinical_coding_assist', draft }));

    expect(annotateCodingDraftMock).not.toHaveBeenCalled();
    // No UNVALIDATED_CODE flag should appear.
    expect(delta.safetyFlags.some((f) => f.type === 'UNVALIDATED_CODE')).toBe(false);
  });

  it('does not call annotateCodingDraft for other modules', async () => {
    const draft = {
      suggested_codes: [{ code: 'J18.9' }],
      summary: 'Reconcile meds.',
    };

    await safetyFlagsNode()(baseState({ moduleKey: 'medication_reconciliation', draft }));

    expect(annotateCodingDraftMock).not.toHaveBeenCalled();
    // suggested_codes must be unchanged.
    expect(draft.suggested_codes).toHaveLength(1);
    expect(draft.suggested_codes[0].code).toBe('J18.9');
    expect(draft.suggested_codes[0].system).toBeUndefined(); // not annotated
  });

  it('merges no flags when all codes are valid', async () => {
    const draft = {
      suggested_codes: [{ code: 'J18.9', description: 'Pneumonia' }],
      evidence: 'chart',
      coder_notes: '',
    };

    annotateCodingDraftMock.mockResolvedValue({
      suggested_codes: [{ system: 'ICD10', code: 'J18.9', display: 'Pneumonia, unspecified', validated: true, confidence: 'medium' }],
      safety_flags: [],
    });

    const delta = await safetyFlagsNode()(baseState({ moduleKey: 'clinical_coding_assist', draft }));

    expect(annotateCodingDraftMock).toHaveBeenCalledTimes(1);
    expect(delta.safetyFlags.some((f) => f.type === 'UNVALIDATED_CODE')).toBe(false);
  });
});
