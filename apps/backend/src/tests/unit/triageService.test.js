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

  it('permits external call when CHATBOT_EXTERNAL_REGIONS is unset (all allowed)', async () => {
    global.fetch = jest.fn(async () => anthropicOk('self_care', 'Fine.'));

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
});
