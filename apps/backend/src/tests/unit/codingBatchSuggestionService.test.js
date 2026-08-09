/**
 * Unit tests for the nightly coding-suggestion batch (governed Claude
 * adoption Part 2, feature B). Pins the hard guardrails:
 *   - module gate: disabled clinical_coding_assist → no-op, zero egress
 *   - de-identification runs BEFORE any model call (real deidentificationService)
 *   - provider blocked/degraded → the run stops, nothing is persisted
 *   - suggestions land as clinical_ai_generations + pending clinical_ai_reviews
 *     via the framework helpers — never any claims/billing write
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockQueryRawUnsafe = jest.fn();
const mockUsersFindUnique = jest.fn();
const mockTx = { kind: 'tenant-transaction' };
const mockSetTenantTx = jest.fn(async (_tenantId, callback) => callback(mockTx));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: mockQueryRawUnsafe,
    users: { findUnique: mockUsersFindUnique },
  },
  setTenant: jest.fn(),
  setTenantTx: mockSetTenantTx,
}));

const mockGetModule = jest.fn();
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: mockGetModule,
}));

const mockCollectContext = jest.fn();
jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  collectAdmissionClinicalContext: mockCollectContext,
}));

const mockGenerate = jest.fn();
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: mockGenerate,
}));

const mockSaveGeneration = jest.fn();
const mockRunSafetyReview = jest.fn();
const mockCreateReview = jest.fn();
jest.unstable_mockModule('../../services/ai/clinicalAiWorkflowService.js', () => ({
  saveGeneration: mockSaveGeneration,
  runSafetyReview: mockRunSafetyReview,
  createReviewPlaceholder: mockCreateReview,
}));

const mockPublishEvent = jest.fn();
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: mockPublishEvent,
}));

const mockAnnotate = jest.fn();
jest.unstable_mockModule('../../services/ai/codingValidationService.js', () => ({
  annotateCodingDraft: mockAnnotate,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || 'tenant-1',
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));

// deidentificationService + hallucinationDefenses run REAL (pure transforms;
// deid reads users via the mocked prisma above).
const { runCodingSuggestionBatch, CODING_SUGGESTION_SCHEMA, __testing__ } =
  await import('../../services/ai/codingBatchSuggestionService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

const ENABLED_MODULE = {
  module_key: 'clinical_coding_assist',
  display_name: 'Clinical Coding Assistant',
  enabled: true,
  external_allowed: true,
  settings: {
    risk: 'medium',
    requiresClinicianSignoff: false,
    reviewRoles: ['BILLING_STAFF', 'MEDICAL_RECORDS', 'ADMIN'],
  },
};

function signedNoteContext({ withSignedNote = true } = {}) {
  return {
    admission: { patient_uid: PATIENT_UID },
    notes: withSignedNote
      ? [{
        id: 9001,
        event_type: 'clinical_note',
        sub_type: 'progress_note',
        summary: 'Progress note',
        timestamp: '2026-08-01T10:00:00Z',
        payload: {
          is_signed: true,
          content: 'Asha Patient reviewed today, phone 9876543210. Community-acquired pneumonia improving on antibiotics.',
        },
      }]
      : [],
    diagnoses: [{ payload: { icd10_code: 'J18.9', description: 'Pneumonia, unspecified organism' } }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryRawUnsafe.mockReset();
  mockSetTenantTx.mockImplementation(async (_tenantId, callback) => callback(mockTx));
  mockGetModule.mockResolvedValue(ENABLED_MODULE);
  mockUsersFindUnique.mockResolvedValue({
    name: 'Asha Patient',
    phone: '9876543210',
    email: null,
    birthday: null,
    address: null,
    emergency_contact: null,
  });
  // First raw query = tenants region lookup; second = candidate admissions.
  mockQueryRawUnsafe
    .mockResolvedValueOnce([{ region: 'IN' }])
    .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_UID }]);
  mockCollectContext.mockResolvedValue(signedNoteContext());
  mockGenerate.mockResolvedValue({
    usedAi: true,
    provider: 'anthropic',
    model: 'deep-test-model',
    tier: 'quick',
    generation_mode: 'ai',
    text: JSON.stringify({
      suggested_codes: [{ system: 'ICD10', code: 'J18.9', description: 'Pneumonia', confidence: 'medium' }],
      evidence: ['signed progress note'],
      coder_notes: 'Coder approval required.',
    }),
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  mockAnnotate.mockImplementation(async (draft) => ({
    suggested_codes: (draft.suggested_codes || []).map((c) => ({ ...c, validated: true })),
    safety_flags: [],
  }));
  mockSaveGeneration.mockResolvedValue({ id: 501, status: 'draft' });
  mockRunSafetyReview.mockResolvedValue({ status: 'passed', findings: [] });
  mockCreateReview.mockResolvedValue({ id: 601, decision: 'pending' });
  mockPublishEvent.mockResolvedValue({});
});

describe('runCodingSuggestionBatch', () => {
  it('is a no-op with zero egress when the clinical_coding_assist module is disabled (off by default)', async () => {
    mockGetModule.mockResolvedValue({ ...ENABLED_MODULE, enabled: false });

    const summary = await runCodingSuggestionBatch({ tenantId: TENANT_ID });

    expect(summary.stopped_reason).toBe('module_disabled');
    expect(summary.suggested).toBe(0);
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockSaveGeneration).not.toHaveBeenCalled();
  });

  it('de-identifies documentation BEFORE the model call and lands the suggestion as a pending review item', async () => {
    const summary = await runCodingSuggestionBatch({
      tenantId: TENANT_ID,
      triggeredBy: 'admin-uid',
      source: 'admin',
    });

    // The model saw redacted text, never the raw identifiers.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const genArgs = mockGenerate.mock.calls[0][0];
    expect(genArgs.taskType).toBe('clinical_coding_assist');
    expect(genArgs.tenantRegion).toBe('IN');
    expect(genArgs.jsonSchema).toBe(CODING_SUGGESTION_SCHEMA);
    expect(genArgs.userPrompt).not.toContain('Asha Patient');
    expect(genArgs.userPrompt).not.toContain('9876543210');
    expect(genArgs.userPrompt).toContain('[REDACTED:NAME]');

    // Draft persisted through the framework write path, review item pending.
    expect(mockSaveGeneration).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      moduleKey: 'clinical_coding_assist',
      admissionId: 42,
      patientUid: PATIENT_UID,
      status: 'draft',
      metadata: expect.objectContaining({ batch: true, deidentified_egress: true }),
    }));
    expect(mockCreateReview).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 501,
      module: ENABLED_MODULE,
      tx: mockTx,
      required: true,
    }));
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'clinical_ai.draft_generated',
      tenantId: TENANT_ID,
      tx: mockTx,
    }));
    expect(mockRunSafetyReview).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 501,
      tx: mockTx,
      required: true,
    }));

    expect(summary).toMatchObject({
      candidates: 1,
      suggested: 1,
      review_items: 1,
      stopped_reason: null,
    });

    // NEVER auto-applies: the service's own SQL is read-only (all writes go
    // through the mocked framework helpers into clinical_ai_* tables only).
    for (const call of mockQueryRawUnsafe.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });

  it('skips admissions without signed documentation before any egress', async () => {
    mockCollectContext.mockResolvedValue(signedNoteContext({ withSignedNote: false }));

    const summary = await runCodingSuggestionBatch({ tenantId: TENANT_ID });

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([{ admission_id: 42, reason: 'no_signed_documentation' }]);
    expect(summary.suggested).toBe(0);
  });

  it('stops the run without persisting anything when the provider is blocked (egress/budget gates)', async () => {
    mockGenerate.mockResolvedValue({
      usedAi: false,
      generation_mode: 'blocked',
      provider_status: 'blocked',
      reason: 'external_provider_blocked_for_region:IN',
      text: '',
      usage: {},
    });

    const summary = await runCodingSuggestionBatch({ tenantId: TENANT_ID });

    expect(summary.stopped_reason).toBe('external_provider_blocked_for_region:IN');
    expect(summary.suggested).toBe(0);
    expect(mockSaveGeneration).not.toHaveBeenCalled();
    expect(mockCreateReview).not.toHaveBeenCalled();
  });

  it('fails closed before egress when no human review gate is configured', async () => {
    mockGetModule.mockResolvedValue({
      ...ENABLED_MODULE,
      settings: { ...ENABLED_MODULE.settings, reviewRoles: [], requiresClinicianSignoff: false },
    });

    const summary = await runCodingSuggestionBatch({ tenantId: TENANT_ID });

    expect(summary.stopped_reason).toBe('review_gate_not_configured');
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockSaveGeneration).not.toHaveBeenCalled();
  });

  it('records schema-invalid provider output as failed and never creates a review item', async () => {
    mockGenerate.mockResolvedValue({
      usedAi: true,
      provider: 'anthropic',
      generation_mode: 'ai',
      text: JSON.stringify({ suggested_codes: 'not-an-array' }),
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });

    const summary = await runCodingSuggestionBatch({ tenantId: TENANT_ID });

    expect(summary).toMatchObject({
      suggested: 0,
      review_items: 0,
      stopped_reason: 'invalid_provider_output',
      skipped: [{ admission_id: 42, reason: 'invalid_provider_output' }],
    });
    expect(mockSaveGeneration).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failureReason: 'INVALID_CODING_SUGGESTION_SCHEMA',
      tx: mockTx,
    }));
    expect(mockRunSafetyReview).toHaveBeenCalledWith(expect.objectContaining({
      tx: mockTx,
      required: true,
    }));
    expect(mockCreateReview).not.toHaveBeenCalled();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it('does not commit a generation when the required review placeholder fails', async () => {
    mockCreateReview.mockRejectedValueOnce(new Error('review insert failed'));

    await expect(runCodingSuggestionBatch({ tenantId: TENANT_ID }))
      .rejects.toThrow('review insert failed');

    expect(mockSetTenantTx).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(mockSaveGeneration).toHaveBeenCalledWith(expect.objectContaining({ tx: mockTx }));
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it('marks critically flagged drafts failed and keeps them OUT of the review queue', async () => {
    mockAnnotate.mockResolvedValue({
      suggested_codes: [],
      safety_flags: [{ severity: 'critical', code: 'PHI_LEAK_SUSPECTED', message: 'test critical' }],
    });

    const summary = await runCodingSuggestionBatch({ tenantId: TENANT_ID });

    expect(mockSaveGeneration).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failureReason: 'PHI_LEAK_SUSPECTED',
    }));
    expect(mockCreateReview).not.toHaveBeenCalled();
    expect(mockPublishEvent).not.toHaveBeenCalled();
    expect(summary.review_items).toBe(0);
  });

  it('deidentifyPacket fails closed when redaction throws', () => {
    const { deidentifyPacket } = __testing__;
    const throwing = {};
    Object.defineProperty(throwing, 'value', {
      get() { throw new Error('boom'); },
      enumerable: true,
    });
    const result = deidentifyPacket(
      { note: 'text with Asha Patient inside' },
      { knownIdentifiers: [throwing] }
    );
    expect(result.failed).toBe(true);
  });
});
