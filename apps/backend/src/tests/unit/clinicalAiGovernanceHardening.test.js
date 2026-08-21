import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const recordDecisionMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenant: (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/ai/decisionMemoryService.js', () => ({
  extractContextSignature: jest.fn(() => null),
  recordDecision: recordDecisionMock,
  retrieveRelevantDecisions: jest.fn(async () => []),
}));

const {
  getClinicalAiGuardrails,
  listClinicalAiModules,
  updateClinicalAiTenantModule,
} = await import('../../services/ai/clinicalAiModuleService.js');
const {
  listReviews,
  updateReview,
} = await import('../../services/ai/clinicalAiWorkflowService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

const moduleRow = {
  module_key: 'medication_reconciliation',
  display_name: 'Medication Reconciliation',
  description: 'Medication reconciliation',
  enabled: false,
  provider_override: null,
  model_override: null,
  external_allowed: false,
  max_tokens: null,
  temperature: null,
  settings: {
    risk: 'critical',
    approvalPolicy: 'two_person_for_enablement',
    reviewRoles: ['DOCTOR', 'PHARMACY_STAFF'],
  },
  updated_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const guardrailRow = {
  id: 1,
  enabled: true,
  external_ai_enabled: true,
  daily_token_limit: null,
  daily_cost_limit_minor: null,
  request_token_limit: null,
  fallback_rate_alert_pct: 50,
  max_fallbacks_per_day: null,
  latency_alert_ms: 15000,
};

function acceptedEvalRow(overrides = {}) {
  return [{
    id: 7,
    model_key: 'medication_reconciliation',
    version: 'llama3.1:8b',
    suite: 'governance-golden',
    recommendation: 'no_action',
    severity: 'low',
    fallback_rate_pct: 1,
    safety_flag_rate_pct: 0.5,
    reviewer_decision: 'accepted',
    metadata: {
      module_key: 'medication_reconciliation',
      provider: 'template',
      model: 'llama3.1:8b',
    },
    created_at: new Date().toISOString(),
    ...overrides,
  }];
}

function installModuleGovernanceMock({ evalRows = acceptedEvalRow(), approval = null, schemaMissing = false, module = moduleRow } = {}) {
  let pendingApprovalPayload = null;
  let tenantUpdated = false;
  queryUnsafeMock.mockImplementation(async (sql, ...params) => {
    const text = String(sql);
    if (schemaMissing && /FROM clinical_ai_modules/i.test(text)) {
      throw new Error('relation "clinical_ai_modules" does not exist');
    }
    if (/INSERT INTO clinical_ai_modules/i.test(text) && !/RETURNING module_key/i.test(text)) return [];
    if (/SELECT module_key, display_name, description, enabled/i.test(text)) return [module];
    if (/INSERT INTO clinical_ai_guardrails/i.test(text)) return [];
    if (/SELECT id, enabled, external_ai_enabled/i.test(text)) return [guardrailRow];
    if (/FROM clinical_ai_model_eval_runs/i.test(text)) return evalRows;
    if (/SELECT id, approval_type, module_key, status/i.test(text)) {
      if (!approval) return [];
      return [{
        id: approval.id || params[0],
        approval_type: 'module_governance_change',
        module_key: 'medication_reconciliation',
        status: approval.status || 'approved',
        requested_by: approval.requested_by ?? ACTOR,
        approved_by: approval.approved_by ?? APPROVER,
        payload: approval.payload || pendingApprovalPayload,
        expires_at: approval.expires_at || new Date(Date.now() + 86_400_000).toISOString(),
        expires_at_epoch_ms: BigInt(new Date(approval.expires_at || Date.now() + 86_400_000).getTime()),
        created_at: new Date().toISOString(),
      }];
    }
    if (/INSERT INTO clinical_ai_approvals/i.test(text)) {
      pendingApprovalPayload = JSON.parse(params[5]);
      return [{
        id: 42,
        approval_type: 'module_governance_change',
        module_key: 'medication_reconciliation',
        status: 'pending',
        requested_by: ACTOR,
        reason: params[4],
        payload: pendingApprovalPayload,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        expires_at_epoch_ms: BigInt(Date.now() + 86_400_000),
        created_at: new Date().toISOString(),
      }];
    }
    if (/INSERT INTO clinical_ai_tenant_modules/i.test(text)) {
      tenantUpdated = true;
      return [];
    }
    if (/FROM clinical_ai_tenant_modules/i.test(text)) {
      return tenantUpdated
        ? [{
          id: 5,
          tenant_id: TENANT,
          module_key: 'medication_reconciliation',
          enabled: true,
          provider_override: null,
          model_override: null,
          external_allowed: null,
          max_tokens: null,
          temperature: null,
          settings: {},
          updated_by: ACTOR,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }]
        : [];
    }
    return [];
  });
  return {
    getPendingApprovalPayload: () => pendingApprovalPayload,
  };
}

describe('Clinical AI module governance hardening', () => {
  beforeEach(() => {
    queryUnsafeMock.mockReset();
    recordDecisionMock.mockReset();
  });

  it('blocks high-risk enablement when no accepted eval run exists', async () => {
    installModuleGovernanceMock({ evalRows: [] });

    await expect(updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true },
      ACTOR,
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: 'CLINICAL_AI_EVAL_GATE_REQUIRED' });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO clinical_ai_approvals/i.test(String(sql)))).toBe(false);
  });

  it('creates a pending approval without mutating when eval passes but approval is absent', async () => {
    const mock = installModuleGovernanceMock();

    const result = await updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true },
      ACTOR,
      { tenantId: TENANT },
    );

    expect(result.approval_required).toBe(true);
    expect(result.approval.payload.requested_change_hash).toBe(mock.getPendingApprovalPayload().requested_change_hash);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO clinical_ai_tenant_modules/i.test(String(sql)))).toBe(false);
  });

  it('allows the exact approved two-person change', async () => {
    const firstMock = installModuleGovernanceMock();
    const pending = await updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true },
      ACTOR,
      { tenantId: TENANT },
    );

    queryUnsafeMock.mockReset();
    installModuleGovernanceMock({
      approval: { id: pending.approval.id, payload: firstMock.getPendingApprovalPayload() },
    });

    const result = await updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true, approval_id: pending.approval.id },
      ACTOR,
      { tenantId: TENANT },
    );

    expect(result.approval_required).toBeUndefined();
    expect(result.enabled).toBe(true);
  });

  it('attaches a non-blocking deep_tier_warning when a deep module is enabled without a live model (C3)', async () => {
    // A deep-tagged module under the default `template` provider will silently
    // template-fall-back at generation. Enabling it must SUCCEED (non-blocking)
    // but surface a deep_tier_warning so the operator sees the degradation.
    const deepModule = {
      ...moduleRow,
      settings: { ...moduleRow.settings, model_tier: 'deep' },
    };
    const firstMock = installModuleGovernanceMock({ module: deepModule });
    const pending = await updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true },
      ACTOR,
      { tenantId: TENANT },
    );

    queryUnsafeMock.mockReset();
    installModuleGovernanceMock({
      module: deepModule,
      approval: { id: pending.approval.id, payload: firstMock.getPendingApprovalPayload() },
    });

    const result = await updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true, approval_id: pending.approval.id },
      ACTOR,
      { tenantId: TENANT },
    );

    expect(result.enabled).toBe(true);
    expect(result.deep_tier_warning).toBeDefined();
    expect(result.deep_tier_warning.reason).toMatch(/template/i);
  });

  it('rejects mismatched or stale approval payloads', async () => {
    installModuleGovernanceMock({
      approval: {
        id: 99,
        payload: { requested_change_hash: 'wrong-hash' },
      },
    });

    await expect(updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true, approval_id: 99 },
      ACTOR,
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: 'CLINICAL_AI_APPROVAL_MISMATCH' });
  });

  it('fails closed when governance schema is unavailable', async () => {
    installModuleGovernanceMock({ schemaMissing: true });

    await expect(updateClinicalAiTenantModule(
      'medication_reconciliation',
      { enabled: true },
      ACTOR,
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: 'CLINICAL_AI_SCHEMA_UNAVAILABLE' });
  });

  it('does not silently fall back to default modules or guardrails when schema is unavailable', async () => {
    queryUnsafeMock.mockRejectedValue(new Error('relation "clinical_ai_modules" does not exist'));

    await expect(listClinicalAiModules({ refresh: true }))
      .rejects.toMatchObject({ code: 'CLINICAL_AI_SCHEMA_UNAVAILABLE' });

    queryUnsafeMock.mockRejectedValue(new Error('relation "clinical_ai_guardrails" does not exist'));

    await expect(getClinicalAiGuardrails({ refresh: true }))
      .rejects.toMatchObject({ code: 'CLINICAL_AI_SCHEMA_UNAVAILABLE' });
  });
});

describe('Clinical AI review authorization hardening', () => {
  beforeEach(() => {
    queryUnsafeMock.mockReset();
    recordDecisionMock.mockReset();
  });

  it('rejects review PATCH when caller role is not in module reviewRoles', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 11,
      generation_id: 21,
      module_key: 'medication_reconciliation',
      patient_uid: null,
      admission_id: null,
      metadata: { review_roles: ['DOCTOR'] },
      module_review_roles: ['DOCTOR'],
    }]);

    await expect(updateReview(
      11,
      { decision: 'accepted' },
      ACTOR,
      'NURSING_STAFF',
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: 'CLINICAL_AI_REVIEW_ROLE_FORBIDDEN' });
  });

  it('exposes generation mode labels in the tenant-scoped review list', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 11,
      generation_id: 21,
      module_key: 'medication_reconciliation',
      patient_uid: null,
      patient_name: null,
      admission_id: 31,
      reviewer_uid: null,
      reviewer_role: 'DOCTOR',
      decision: 'pending',
      edited_draft: null,
      rejection_reason: null,
      reviewer_note: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider: 'ollama',
      model: 'llama3.1:70b-instruct-q4_K_M',
      total_tokens: 42,
      used_ai: true,
      draft: { reconciliation: [] },
      citations: [{ source: 'medication_orders' }],
      generation_status: 'draft',
      tier: 'deep',
      model_tier: 'deep',
      generation_mode: 'ai',
      fallback_reason: null,
      readiness_reason: null,
      provider_status: 'used',
      safety_flags: [],
      module_review_roles: ['DOCTOR'],
    }]);

    const result = await listReviews({
      decision: 'pending',
      reviewerRole: 'DOCTOR',
      tenantId: TENANT,
    });

    expect(result.count).toBe(1);
    expect(result.reviews[0]).toMatchObject({
      used_ai: true,
      tier: 'deep',
      model_tier: 'deep',
      generation_mode: 'ai',
      provider_status: 'used',
      draft: { reconciliation: [] },
      citations: [{ source: 'medication_orders' }],
    });
    const [sql, tenant, decision, moduleKey, role] =
      queryUnsafeMock.mock.calls[0];
    expect(String(sql)).toContain('g.used_ai');
    expect(String(sql)).toContain('g.draft');
    expect(String(sql)).toContain("metadata->>'generation_mode'");
    expect(String(sql)).toContain("metadata->>'provider_status'");
    expect(tenant).toBe(TENANT);
    expect(decision).toBe('pending');
    expect(moduleKey).toBeNull();
    expect(role).toBe('DOCTOR');
  });

  it('allows listed reviewer roles to update reviews', async () => {
    const reviewerNote = 'Reviewed chart context and accepted safely.';
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 11,
        generation_id: 21,
        module_key: 'medication_reconciliation',
        patient_uid: null,
        admission_id: null,
        metadata: { review_roles: ['DOCTOR'] },
        module_review_roles: ['DOCTOR'],
      }])
      .mockResolvedValueOnce([{
        id: 11,
        generation_id: 21,
        module_key: 'medication_reconciliation',
        patient_uid: null,
        admission_id: null,
        reviewer_uid: ACTOR,
        reviewer_role: 'DOCTOR',
        decision: 'accepted',
        edited_draft: null,
        rejection_reason: null,
        reviewer_note: reviewerNote,
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ draft: {}, metadata: {} }]);

    const review = await updateReview(
      11,
      { decision: 'accepted', reviewer_note: reviewerNote },
      ACTOR,
      'DOCTOR',
      { tenantId: TENANT },
    );

    expect(review.decision).toBe('accepted');
    expect(review.reviewer_note).toBe(reviewerNote);
    expect(recordDecisionMock).toHaveBeenCalled();
  });

  it('requires a substantive reviewer note before accepted reviews can be signed off', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 11,
      generation_id: 21,
      module_key: 'medication_reconciliation',
      patient_uid: null,
      admission_id: null,
      metadata: { review_roles: ['DOCTOR'] },
      module_review_roles: ['DOCTOR'],
    }]);

    await expect(updateReview(
      11,
      { decision: 'accepted', reviewer_note: 'ok' },
      ACTOR,
      'DOCTOR',
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: 'CLINICAL_AI_REVIEW_NOTE_REQUIRED' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it('allows explicit control-plane override for admins only', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 11,
        generation_id: null,
        module_key: 'medication_reconciliation',
        patient_uid: null,
        admission_id: null,
        metadata: { review_roles: ['DOCTOR'] },
        module_review_roles: ['DOCTOR'],
      }])
      .mockResolvedValueOnce([{
        id: 11,
        generation_id: null,
        module_key: 'medication_reconciliation',
        patient_uid: null,
        admission_id: null,
        reviewer_uid: ACTOR,
        reviewer_role: 'ADMIN',
        decision: 'rejected',
        edited_draft: null,
        rejection_reason: 'unsafe',
        reviewer_note: null,
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }])
      .mockResolvedValueOnce([]);

    const review = await updateReview(
      11,
      { decision: 'rejected', rejection_reason: 'unsafe' },
      ACTOR,
      'ADMIN',
      { tenantId: TENANT, allowReviewRoleOverride: true },
    );

    expect(review.decision).toBe('rejected');
  });
});
