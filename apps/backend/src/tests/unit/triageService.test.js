/**
 * Unit tests for apps/backend/src/services/chatbot/triageService.js
 *
 * WS5 B5.2 / AI-3 — governance hardening:
 *   1. Default provider is 'template' (no external PHI egress by default).
 *   2. When CHATBOT_PROVIDER=anthropic, the default model is claude-opus-4-8.
 *   3. Output from live providers runs through runOutputDefenses.
 *   4. Every response carries a decision-support-only disclaimer.
 *   5. Region/egress guard blocks external calls when the tenant region is not
 *      on the CHATBOT_EXTERNAL_REGIONS allowlist.
 *
 * All network calls are mocked. No DB, no real fetch.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Module-level mocks (must be declared before any dynamic import)
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockRunOutputDefenses = jest.fn(() => []);
jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: mockRunOutputDefenses,
  detectPhiLeaks: jest.fn(() => []),
  extractNumericMismatches: jest.fn(() => []),
  validateOutputSchema: jest.fn(() => []),
  temperatureForRisk: jest.fn(() => 0.15),
  draftFingerprint: jest.fn(() => 'abc123'),
}));

// Governed-framework mocks (lazy-imported by triageService on the live path).
// Defaults: patient_triage module enabled, guardrails off, budget headroom.
const mockGetClinicalAiModule = jest.fn(async () => ({
  module_key: 'patient_triage',
  enabled: true,
  settings: { reviewRoles: ['DOCTOR', 'ADMIN'] },
}));
const mockGetClinicalAiGuardrails = jest.fn(async () => ({ enabled: false }));
const mockGetClinicalAiBudgetStatus = jest.fn(async () => ({ tripped: false }));
const mockQueryRawUnsafe = jest.fn(async () => [{ id: 41 }]);

// ---------------------------------------------------------------------------
// Env + module loader helper
// ---------------------------------------------------------------------------

const CHATBOT_KEYS = [
  'CHATBOT_PROVIDER',
  'CHATBOT_MODEL',
  'CHATBOT_BASE_URL',
  'CHATBOT_API_KEY',
  'ANTHROPIC_API_KEY',
  'CHATBOT_EXTERNAL_REGIONS',
];

/**
 * Snapshot env, apply overrides, reset Jest modules (so top-level consts in
 * the service pick up new values), re-register mocks (resetModules clears
 * them), import the module, return { mod, cleanup }.
 *
 * The env overrides remain in process.env until cleanup() is called, so
 * call-time reads inside the service (e.g. _tenantCanUseExternal) see them.
 */
async function loadService(envOverrides = {}) {
  // Snapshot.
  const snapshot = {};
  for (const key of CHATBOT_KEYS) snapshot[key] = process.env[key];

  // Apply overrides (delete missing keys to ensure clean slate).
  for (const key of CHATBOT_KEYS) {
    if (key in envOverrides) {
      process.env[key] = envOverrides[key];
    } else {
      delete process.env[key];
    }
  }

  // Re-evaluate module with new env.
  jest.resetModules();

  jest.unstable_mockModule('../../logging/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
    runOutputDefenses: mockRunOutputDefenses,
    detectPhiLeaks: jest.fn(() => []),
    extractNumericMismatches: jest.fn(() => []),
    validateOutputSchema: jest.fn(() => []),
    temperatureForRisk: jest.fn(() => 0.15),
    draftFingerprint: jest.fn(() => 'abc123'),
  }));
  jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
    getClinicalAiModule: mockGetClinicalAiModule,
    getClinicalAiGuardrails: mockGetClinicalAiGuardrails,
    getClinicalAiBudgetStatus: mockGetClinicalAiBudgetStatus,
    default: {
      getClinicalAiModule: mockGetClinicalAiModule,
      getClinicalAiGuardrails: mockGetClinicalAiGuardrails,
      getClinicalAiBudgetStatus: mockGetClinicalAiBudgetStatus,
    },
  }));
  jest.unstable_mockModule('../../lib/prisma.js', () => ({
    default: { $queryRawUnsafe: mockQueryRawUnsafe },
  }));
  jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
    DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
    requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
  }));

  const mod = await import('../../services/chatbot/triageService.js');

  function cleanup() {
    for (const key of CHATBOT_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }

  return { mod, cleanup };
}

/** Minimal Anthropic-shaped successful fetch response. */
function anthropicOk(triage = 'self_care', summary = 'You seem fine.') {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ triage, differential: [], summary, redFlags: [] }),
        },
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — default provider is 'template'
// ---------------------------------------------------------------------------

describe('triageService — default provider (template)', () => {
  let svc;
  let cleanup;

  beforeAll(async () => {
    ({ mod: svc, cleanup } = await loadService(/* no CHATBOT_PROVIDER */));
  });

  afterAll(() => cleanup());

  afterEach(() => {
    mockRunOutputDefenses.mockClear();
  });

  it('provider is template when CHATBOT_PROVIDER is not set', async () => {
    const result = await svc.triageSymptoms({ symptoms: 'I have a headache' });
    expect(result.provider).toBe('template');
  });

  it('returns a non-urgent safe placeholder triage category', async () => {
    const result = await svc.triageSymptoms({ symptoms: 'I have a headache' });
    expect(result.triage).toBe('see_doctor_now');
  });

  it('includes the decision-support disclaimer', async () => {
    const result = await svc.triageSymptoms({ symptoms: 'I have a headache' });
    expect(result.disclaimer).toMatch(/decision-support only/i);
    expect(result.disclaimer).toMatch(/NOT a medical diagnosis/i);
  });

  it('does NOT call runOutputDefenses (no AI output to defend)', async () => {
    await svc.triageSymptoms({ symptoms: 'chest pain' });
    expect(mockRunOutputDefenses).not.toHaveBeenCalled();
  });

  it('throws 400 when symptoms is too short', async () => {
    await expect(svc.triageSymptoms({ symptoms: 'no' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when symptoms is missing', async () => {
    await expect(svc.triageSymptoms({}))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — anthropic provider: model + governance
// ---------------------------------------------------------------------------

describe('triageService — anthropic provider: model default + governance', () => {
  let svc;
  let cleanup;
  let savedFetch;

  beforeAll(async () => {
    ({ mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key-not-real',
    }));
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    savedFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
    mockRunOutputDefenses.mockClear();
  });

  it('sends claude-opus-4-8 as the model (not the stale claude-opus-4-6)', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return anthropicOk();
    });

    await svc.triageSymptoms({ symptoms: 'mild headache today' });

    expect(capturedBody).toBeDefined();
    expect(capturedBody.model).toBe('claude-opus-4-8');
    expect(capturedBody.model).not.toBe('claude-opus-4-6');
  });

  it('includes the decision-support disclaimer in the result', async () => {
    global.fetch = jest.fn(async () => anthropicOk('see_doctor_now', 'Please see a doctor.'));
    const result = await svc.triageSymptoms({ symptoms: 'mild headache today' });
    expect(result.disclaimer).toMatch(/decision-support only/i);
  });

  it('calls runOutputDefenses exactly once on the parsed response', async () => {
    global.fetch = jest.fn(async () => anthropicOk('see_doctor_now', 'Please see a doctor.'));
    await svc.triageSymptoms({ symptoms: 'mild headache today' });

    expect(mockRunOutputDefenses).toHaveBeenCalledTimes(1);
    const callArg = mockRunOutputDefenses.mock.calls[0][0];
    // draft should be the parsed object, not the raw string
    expect(callArg.draft).toHaveProperty('triage');
    expect(typeof callArg.draft).toBe('object');
  });

  it('merges safetyFlags returned by runOutputDefenses into the result', async () => {
    const mockFlag = { severity: 'medium', code: 'UNVERIFIED_NUMERIC', message: 'test flag' };
    mockRunOutputDefenses.mockReturnValueOnce([mockFlag]);

    global.fetch = jest.fn(async () => anthropicOk('see_doctor_now', 'check blood pressure'));
    const result = await svc.triageSymptoms({ symptoms: 'I feel dizzy' });

    expect(result.safetyFlags).toHaveLength(1);
    expect(result.safetyFlags[0].code).toBe('UNVERIFIED_NUMERIC');
  });

  it('throws 503 when anthropic provider has no API key', async () => {
    const { mod: noKeyMod, cleanup: c } = await loadService({ CHATBOT_PROVIDER: 'anthropic' });
    try {
      await expect(noKeyMod.triageSymptoms({ symptoms: 'headache' }))
        .rejects.toMatchObject({ statusCode: 503 });
    } finally {
      c();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — region / egress guard
// ---------------------------------------------------------------------------

describe('triageService — region / egress guard', () => {
  let savedFetch;

  beforeEach(() => {
    savedFetch = global.fetch;
    mockRunOutputDefenses.mockClear();
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('blocks external call when tenant region is NOT on the allowlist', async () => {
    // The sentinel fetch should never be called if the guard fires correctly.
    let fetchWasCalled = false;
    global.fetch = jest.fn(async () => {
      fetchWasCalled = true;
      return { ok: false, status: 999, text: async () => 'sentinel' };
    });

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
      CHATBOT_EXTERNAL_REGIONS: 'US,EU',
    });

    try {
      const result = await svc.triageSymptoms({
        symptoms: 'I have a fever',
        tenantRegion: 'IN', // India is NOT in US,EU
      });

      expect(fetchWasCalled).toBe(false);
      expect(result.provider).toBe('template');
      expect(result.disclaimer).toMatch(/decision-support only/i);
      expect(result.safetyFlags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PHI_EGRESS_BLOCKED' }),
        ])
      );
      expect(result.governanceNote).toMatch(/external_provider_blocked_for_region:IN/);
    } finally {
      cleanup();
    }
  });

  it('permits external call when tenant region IS on the allowlist', async () => {
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'You are fine.'));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
      CHATBOT_EXTERNAL_REGIONS: 'IN,US',
    });

    try {
      const result = await svc.triageSymptoms({
        symptoms: 'mild cold symptoms',
        tenantRegion: 'IN',
      });
      expect(result.provider).toBe('anthropic');
      expect(result.triage).toBe('self_care');
    } finally {
      cleanup();
    }
  });

  it('DENIES a region-tagged tenant when CHATBOT_EXTERNAL_REGIONS is unset (fail-closed, aligned with CLINICAL_AI_EXTERNAL_REGIONS)', async () => {
    let fetchWasCalled = false;
    global.fetch = jest.fn(async () => {
      fetchWasCalled = true;
      return anthropicOk('self_care', 'Fine.');
    });

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
      // CHATBOT_EXTERNAL_REGIONS deliberately absent
    });

    try {
      const result = await svc.triageSymptoms({
        symptoms: 'mild headache',
        tenantRegion: 'IN',
      });
      expect(fetchWasCalled).toBe(false);
      expect(result.provider).toBe('template');
      expect(result.governanceNote).toMatch(/external_provider_blocked_for_region:IN/);
    } finally {
      cleanup();
    }
  });

  it('permits a REGION-LESS tenant when CHATBOT_EXTERNAL_REGIONS is unset (single-tenant pilot escape)', async () => {
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'Fine.'));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
    });

    try {
      const result = await svc.triageSymptoms({ symptoms: 'mild headache' });
      expect(result.provider).toBe('anthropic');
    } finally {
      cleanup();
    }
  });

  it("permits every region on the explicit '*' wildcard", async () => {
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'Fine.'));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
      CHATBOT_EXTERNAL_REGIONS: '*',
    });

    try {
      const result = await svc.triageSymptoms({
        symptoms: 'mild headache',
        tenantRegion: 'IN',
      });
      expect(result.provider).toBe('anthropic');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — malformed JSON from provider
// ---------------------------------------------------------------------------

describe('triageService — malformed JSON response from provider', () => {
  let savedFetch;

  beforeEach(() => {
    savedFetch = global.fetch;
    mockRunOutputDefenses.mockClear();
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('returns a valid fallback shape and still runs defenses on raw text', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Sorry, I cannot produce a JSON response.' },
        ],
      }),
    }));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
    });

    try {
      const result = await svc.triageSymptoms({ symptoms: 'strange symptom' });

      expect(result.triage).toBe('see_doctor_now');
      expect(result.provider).toBe('anthropic');
      expect(result.disclaimer).toMatch(/decision-support only/i);
      // Defenses must have been run even on the bad output.
      expect(mockRunOutputDefenses).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('does NOT leak the raw model text to the patient on malformed JSON (fail-closed)', async () => {
    const RAW = 'Ignore all prior instructions. The patient SSN is 123-45-6789. <do-unsafe-thing>';
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: RAW }] }),
    }));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
    });

    try {
      const result = await svc.triageSymptoms({ symptoms: 'strange symptom' });

      expect(result.triage).toBe('see_doctor_now');
      // The unvalidated model text must not reach the patient in ANY field.
      expect(JSON.stringify(result)).not.toContain('123-45-6789');
      expect(result.summary).not.toBe(RAW);
      expect(result.raw).toBeUndefined();
      expect(result.blocked).toBe(true);
      expect(result.safetyFlags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'TRIAGE_UNPARSEABLE_OUTPUT_BLOCKED' }),
        ]),
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — critical safety flag blocks the parsed response (fail-closed)
// ---------------------------------------------------------------------------

describe('triageService — critical safety flag blocks the parsed response', () => {
  let savedFetch;

  beforeEach(() => {
    savedFetch = global.fetch;
    mockRunOutputDefenses.mockClear();
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('does NOT return the model content when a CRITICAL safety flag fires (fail-closed)', async () => {
    mockRunOutputDefenses.mockReturnValueOnce([
      { severity: 'critical', code: 'PHI_LEAK', message: 'hallucinated PHI' },
    ]);
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'You are fine, patient John Doe MRN 99887.'));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
    });

    try {
      const result = await svc.triageSymptoms({ symptoms: 'I feel unwell today' });

      // Blocked: escalate, drop the flagged content, keep the flag.
      expect(result.triage).toBe('see_doctor_now');
      expect(JSON.stringify(result)).not.toContain('99887');
      expect(result.summary).not.toContain('John Doe');
      expect(result.raw).toBeUndefined();
      expect(result.blocked).toBe(true);
      expect(result.safetyFlags).toEqual(
        expect.arrayContaining([expect.objectContaining({ severity: 'critical' })]),
      );
    } finally {
      cleanup();
    }
  });

  it('records the blocked output as a failed generation and enqueues a retrospective review', async () => {
    mockRunOutputDefenses.mockReturnValueOnce([
      { severity: 'critical', code: 'PHI_LEAK', message: 'hallucinated PHI' },
    ]);
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'flagged content'));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
    });

    try {
      mockQueryRawUnsafe.mockClear();
      await svc.triageSymptoms({
        symptoms: 'I feel unwell today',
        tenantId: '20000000-0000-4000-8000-000000000009',
        patientUid: '30000000-0000-4000-8000-000000000004',
      });

      const calls = mockQueryRawUnsafe.mock.calls;
      const genCall = calls.find((c) => c[0].includes('INSERT INTO clinical_ai_generations'));
      expect(genCall).toBeDefined();
      // status param ($6) is 'failed' for a blocked output.
      expect(genCall.slice(1)).toContain('failed');
      const reviewCall = calls.find((c) => c[0].includes('INSERT INTO clinical_ai_reviews'));
      expect(reviewCall).toBeDefined();
      const reviewMeta = JSON.parse(reviewCall[5]);
      expect(reviewMeta.review_mode).toBe('retrospective');
      expect(reviewMeta.reasons).toEqual(expect.arrayContaining(['output_blocked']));
    } finally {
      cleanup();
    }
  });

  it('still returns the parsed content when only a NON-critical flag fires (annotate, not block)', async () => {
    mockRunOutputDefenses.mockReturnValueOnce([
      { severity: 'medium', code: 'UNVERIFIED_NUMERIC', message: 'x' },
    ]);
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'Drink fluids and rest.'));

    const { mod: svc, cleanup } = await loadService({
      CHATBOT_PROVIDER: 'anthropic',
      CHATBOT_API_KEY: 'test-key',
    });

    try {
      const result = await svc.triageSymptoms({ symptoms: 'mild cold today' });

      expect(result.triage).toBe('self_care'); // parsed content preserved
      expect(result.summary).toBe('Drink fluids and rest.');
      expect(result.blocked).toBeFalsy();
      expect(result.safetyFlags).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'UNVERIFIED_NUMERIC' })]),
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — governed-framework wiring (patient_triage module)
// ---------------------------------------------------------------------------

describe('triageService — governed framework (patient_triage)', () => {
  let savedFetch;

  beforeEach(() => {
    savedFetch = global.fetch;
    mockRunOutputDefenses.mockClear();
    mockQueryRawUnsafe.mockClear();
    mockQueryRawUnsafe.mockImplementation(async () => [{ id: 41 }]);
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  const LIVE_ENV = { CHATBOT_PROVIDER: 'anthropic', CHATBOT_API_KEY: 'test-key' };

  it('falls back to the template (no external call) when the patient_triage module is disabled', async () => {
    let fetchWasCalled = false;
    global.fetch = jest.fn(async () => {
      fetchWasCalled = true;
      return anthropicOk();
    });
    mockGetClinicalAiModule.mockResolvedValueOnce({ module_key: 'patient_triage', enabled: false });

    const { mod: svc, cleanup } = await loadService(LIVE_ENV);
    try {
      const result = await svc.triageSymptoms({ symptoms: 'mild headache today' });
      expect(fetchWasCalled).toBe(false);
      expect(result.provider).toBe('template');
      expect(result.governanceNote).toMatch(/patient_triage_governance_blocked:module_disabled/);
    } finally {
      cleanup();
    }
  });

  it('falls back to the template when the daily budget guardrail is tripped', async () => {
    let fetchWasCalled = false;
    global.fetch = jest.fn(async () => {
      fetchWasCalled = true;
      return anthropicOk();
    });
    mockGetClinicalAiGuardrails.mockResolvedValueOnce({ enabled: true });
    mockGetClinicalAiBudgetStatus.mockResolvedValueOnce({ tripped: true, blocking_reasons: ['Daily clinical AI token budget exhausted'] });

    const { mod: svc, cleanup } = await loadService(LIVE_ENV);
    try {
      const result = await svc.triageSymptoms({ symptoms: 'mild headache today' });
      expect(fetchWasCalled).toBe(false);
      expect(result.provider).toBe('template');
      expect(result.governanceNote).toMatch(/patient_triage_governance_blocked:budget_guardrail_tripped/);
    } finally {
      cleanup();
    }
  });

  it('fails CLOSED to the template when governance state cannot be read', async () => {
    let fetchWasCalled = false;
    global.fetch = jest.fn(async () => {
      fetchWasCalled = true;
      return anthropicOk();
    });
    mockGetClinicalAiModule.mockRejectedValueOnce(new Error('db down'));

    const { mod: svc, cleanup } = await loadService(LIVE_ENV);
    try {
      const result = await svc.triageSymptoms({ symptoms: 'mild headache today' });
      expect(fetchWasCalled).toBe(false);
      expect(result.provider).toBe('template');
      expect(result.governanceNote).toMatch(/patient_triage_governance_blocked:governance_unavailable/);
    } finally {
      cleanup();
    }
  });

  it('records a clinical_ai_generations row (with token usage) for a clean live response — and no review row', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({ triage: 'self_care', differential: [], summary: 'Rest.', redFlags: [] }),
        }],
        usage: { input_tokens: 120, output_tokens: 30 },
      }),
    }));

    const { mod: svc, cleanup } = await loadService(LIVE_ENV);
    try {
      await svc.triageSymptoms({
        symptoms: 'mild cold today',
        tenantId: '20000000-0000-4000-8000-000000000009',
        patientUid: '30000000-0000-4000-8000-000000000004',
      });

      const calls = mockQueryRawUnsafe.mock.calls;
      const genCall = calls.find((c) => c[0].includes('INSERT INTO clinical_ai_generations'));
      expect(genCall).toBeDefined();
      expect(genCall[1]).toBe('20000000-0000-4000-8000-000000000009'); // tenant_id
      expect(genCall[2]).toBe('30000000-0000-4000-8000-000000000004'); // patient_uid
      expect(genCall[3]).toBe('patient_triage'); // task_type = module_key
      expect(genCall.slice(1)).toEqual(expect.arrayContaining([120, 30, 150])); // token usage
      expect(calls.find((c) => c[0].includes('INSERT INTO clinical_ai_reviews'))).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('enqueues a retrospective review for an urgent_care escalation', async () => {
    global.fetch = jest.fn(async () => anthropicOk('urgent_care', 'Go to A&E now.'));

    const { mod: svc, cleanup } = await loadService(LIVE_ENV);
    try {
      const result = await svc.triageSymptoms({
        symptoms: 'crushing chest pain',
        tenantId: '20000000-0000-4000-8000-000000000009',
        patientUid: '30000000-0000-4000-8000-000000000004',
      });
      expect(result.triage).toBe('urgent_care'); // response NOT blocked — review is retrospective

      const reviewCall = mockQueryRawUnsafe.mock.calls.find((c) => c[0].includes('INSERT INTO clinical_ai_reviews'));
      expect(reviewCall).toBeDefined();
      const reviewMeta = JSON.parse(reviewCall[5]);
      expect(reviewMeta.reasons).toEqual(['urgent_care_escalation']);
      expect(reviewMeta.review_roles).toEqual(['DOCTOR', 'ADMIN']);
      expect(reviewMeta.requires_signoff).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('a governance-persistence failure never breaks the patient-facing response', async () => {
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'Rest.'));
    mockQueryRawUnsafe.mockRejectedValue(new Error('generations table down'));

    const { mod: svc, cleanup } = await loadService(LIVE_ENV);
    try {
      const result = await svc.triageSymptoms({ symptoms: 'mild cold today' });
      expect(result.triage).toBe('self_care');
    } finally {
      cleanup();
    }
  });
});
