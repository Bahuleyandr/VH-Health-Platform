import { jest } from '@jest/globals';

// Patient-surface enablement guard (audit 2026-06-18 §3 / CLINICAL_AI_ENABLEMENT_PLAN.md):
// no module whose registry settings.surface === 'patient' may be toggled ENABLED
// until patient-facing AI is explicitly cleared. The enable path must reject such
// a flip with AppError.forbidden unless an explicit override flag is passed.
//
// Fully-mocked prisma (mirrors clinicalAiGovernanceHardening.test.js) so this
// suite is self-isolating — it touches no real DB and leaves no fixtures behind,
// in particular no clinical_ai_tenant_modules rows.

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// localLlmClient is dynamically imported by the enable path for the non-blocking
// deep-tier readiness probe; stub it so a non-patient enable doesn't try to reach
// a model. The patient guard fires BEFORE this, so patient-reject tests never hit it.
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  checkDeepModuleReadiness: jest.fn(async () => ({ deepTier: false, ready: true, reason: 'not_deep_tier' })),
}));

const {
  updateClinicalAiModule,
  updateClinicalAiTenantModule,
} = await import('../../services/ai/clinicalAiModuleService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

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

// A registered patient-surface module. medication_reconciliation is NOT patient;
// patient_aftercare_instructions IS (settings.surface === 'patient'). We feed the
// DB read with whatever module the test wants the registry/global row to be.
function moduleRow(overrides = {}) {
  return {
    module_key: 'patient_aftercare_instructions',
    display_name: 'Patient Aftercare Instructions',
    description: 'Patient-friendly discharge instructions',
    enabled: false,
    provider_override: null,
    model_override: null,
    external_allowed: false,
    max_tokens: null,
    temperature: null,
    settings: {
      surface: 'patient',
      risk: 'high',
      approvalPolicy: 'two_person_for_enablement',
    },
    updated_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function nonPatientModuleRow(overrides = {}) {
  return {
    module_key: 'handover_summary',
    display_name: 'Nursing Handover Drafts',
    description: 'Shift handover',
    enabled: false,
    provider_override: null,
    model_override: null,
    external_allowed: false,
    max_tokens: null,
    temperature: null,
    settings: {
      surface: 'clinical',
      risk: 'low',
    },
    updated_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Wire the shared queryUnsafeMock to answer reads with `module` and accept writes.
function installMock(module) {
  let tenantUpdated = false;
  queryUnsafeMock.mockImplementation(async (sql) => {
    const text = String(sql);
    if (/SELECT module_key, display_name, description, enabled/i.test(text)) return [module];
    if (/INSERT INTO clinical_ai_modules/i.test(text) && /RETURNING module_key/i.test(text)) {
      return [{ ...module, enabled: true, updated_by: ACTOR }];
    }
    if (/INSERT INTO clinical_ai_modules/i.test(text)) return [];
    if (/SELECT id, enabled, external_ai_enabled/i.test(text)) return [guardrailRow];
    if (/FROM clinical_ai_model_eval_runs/i.test(text)) {
      // An accepted eval run keyed to the module so the eval gate is satisfied
      // for non-patient high-risk enablement happy paths.
      return [{
        id: 7,
        model_key: module.module_key,
        version: 'llama3.1:8b',
        suite: 'golden',
        recommendation: 'no_action',
        severity: 'low',
        fallback_rate_pct: 1,
        safety_flag_rate_pct: 0.5,
        reviewer_decision: 'accepted',
        metadata: { module_key: module.module_key, provider: 'template', model: 'llama3.1:8b' },
        created_at: new Date().toISOString(),
      }];
    }
    if (/INSERT INTO clinical_ai_approvals/i.test(text)) {
      return [{
        id: 42,
        approval_type: 'module_governance_change',
        module_key: module.module_key,
        status: 'pending',
        requested_by: ACTOR,
        payload: {},
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
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
          module_key: module.module_key,
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
}

describe('Clinical AI patient-surface enablement guard', () => {
  beforeEach(() => {
    queryUnsafeMock.mockReset();
  });

  describe('updateClinicalAiTenantModule (tenant scope)', () => {
    it('rejects enabling a patient-surface module', async () => {
      installMock(moduleRow());

      await expect(updateClinicalAiTenantModule(
        'patient_aftercare_instructions',
        { enabled: true },
        ACTOR,
        { tenantId: TENANT },
      )).rejects.toMatchObject({
        statusCode: 403,
        code: 'CLINICAL_AI_PATIENT_SURFACE_FORBIDDEN',
      });

      // Nothing must be written — not the tenant module row, not an approval.
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO clinical_ai_tenant_modules/i.test(String(sql)))).toBe(false);
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO clinical_ai_approvals/i.test(String(sql)))).toBe(false);
    });

    it('allows enabling a patient-surface module with the explicit override flag', async () => {
      installMock(moduleRow());

      // With the override, the patient guard is bypassed; the module is high-risk
      // two_person_for_enablement, so the normal flow returns an approval request
      // (not a forbidden error). That proves the patient guard no longer blocks.
      const result = await updateClinicalAiTenantModule(
        'patient_aftercare_instructions',
        { enabled: true, allow_patient_surface: true },
        ACTOR,
        { tenantId: TENANT },
      );

      expect(result.approval_required).toBe(true);
    });

    it('does NOT block disabling a patient-surface module', async () => {
      installMock(moduleRow({ enabled: true }));

      // enabled:false is a disable — never gated by the patient guard.
      await expect(updateClinicalAiTenantModule(
        'patient_aftercare_instructions',
        { enabled: false },
        ACTOR,
        { tenantId: TENANT },
      )).resolves.toBeDefined();
    });

    it('still enables a non-patient module (guard does not over-block)', async () => {
      installMock(nonPatientModuleRow());

      const result = await updateClinicalAiTenantModule(
        'handover_summary',
        { enabled: true },
        ACTOR,
        { tenantId: TENANT },
      );

      // handover_summary is low-risk clinician_review → not patient-gated, not
      // two-person; it enables straight through.
      expect(result.enabled).toBe(true);
    });
  });

  describe('updateClinicalAiModule (global scope)', () => {
    it('rejects enabling a patient-surface module', async () => {
      installMock(moduleRow());

      await expect(updateClinicalAiModule(
        'patient_aftercare_instructions',
        { enabled: true },
        ACTOR,
      )).rejects.toMatchObject({
        statusCode: 403,
        code: 'CLINICAL_AI_PATIENT_SURFACE_FORBIDDEN',
      });

      expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO clinical_ai_modules/i.test(String(sql)) && /RETURNING module_key/i.test(String(sql)))).toBe(false);
    });

    it('allows enabling a non-patient module', async () => {
      installMock(nonPatientModuleRow());

      const result = await updateClinicalAiModule(
        'handover_summary',
        { enabled: true },
        ACTOR,
      );

      expect(result.enabled).toBe(true);
    });
  });
});
