// AI-6 (WS5 B5.1) — bounded retries before template fallback.
//
// generateClinicalText() now retries TRANSIENT provider failures (timeout,
// 5xx, 429, empty completion) a small bounded number of times with jittered
// backoff before dropping to the template fallback. Permanent failures (4xx
// other than 429) are NOT retried. This proves both behaviours and that the
// template fallback is still reached + clearly labelled on exhaustion.
//
// Retry delays are pinned to 0ms via env so the suite stays fast/deterministic.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockModule = {
  module_key: 'discharge_summary',
  display_name: 'Discharge Summary Drafts',
  enabled: true,
  external_allowed: false,
  provider_override: null,
  model_override: null,
  max_tokens: null,
  temperature: null,
  settings: {},
};
const mockGuardrails = {
  enabled: true,
  external_ai_enabled: true,
  daily_token_limit: null,
  daily_cost_limit_minor: null,
  request_token_limit: null,
  fallback_rate_alert_pct: 50,
  max_fallbacks_per_day: null,
  latency_alert_ms: 15000,
};
const mockBudgetStatus = {
  enabled: true,
  external_ai_enabled: true,
  tripped: false,
  blocking_reasons: [],
  alerts: [],
  token_budget: { used: 0, limit: null, remaining: null, percent_used: null, tripped: false },
  cost_budget: { used: 0, limit: null, remaining: null, percent_used: null, tripped: false },
};

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiBudgetStatus: jest.fn(async () => mockBudgetStatus),
  getClinicalAiGuardrails: jest.fn(async () => mockGuardrails),
  getClinicalAiModule: jest.fn(async () => mockModule),
  getClinicalAiUsageSummary: jest.fn(async () => ({
    window_days: 7,
    overall: { generation_count: 0, ai_generation_count: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    by_module: [], by_provider: [], recent_failures: [],
  })),
  listClinicalAiModules: jest.fn(async () => [mockModule]),
}));

// Pin retry timing BEFORE importing the module under test (the retry
// constants are read at module-eval time from process.env).
process.env.CLINICAL_AI_RETRY_ATTEMPTS = '2';
process.env.CLINICAL_AI_RETRY_BASE_MS = '0';
process.env.CLINICAL_AI_RETRY_MAX_MS = '0';

const { generateClinicalText } = await import('../../services/ai/localLlmClient.js');

const ENV_KEYS = [
  'CLINICAL_AI_PROVIDER', 'CLINICAL_AI_MODEL', 'CLINICAL_AI_BASE_URL', 'CLINICAL_AI_API_KEY',
  'CLINICAL_AI_ALLOW_EXTERNAL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER',
];
let savedEnv = {};

function okOllama(text) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ response: text, prompt_eval_count: 5, eval_count: 3, done_reason: 'stop' }),
  });
}
function httpError(status) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

describe('AI-6 bounded retries in generateClinicalText', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    delete global.fetch;
  });

  it('retries a transient 503 then succeeds on the second attempt', async () => {
    global.fetch
      .mockImplementationOnce(() => httpError(503))
      .mockImplementationOnce(() => okOllama('Recovered draft'));

    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(true);
    expect(result.generation_mode).toBe('ai');
    expect(result.text).toBe('Recovered draft');
    expect(result.retry_attempts).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries an empty completion then succeeds', async () => {
    global.fetch
      .mockImplementationOnce(() => okOllama('   ')) // empty/whitespace → transient
      .mockImplementationOnce(() => okOllama('Now non-empty'));

    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(true);
    expect(result.text).toBe('Now non-empty');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to template after exhausting all attempts on persistent 5xx', async () => {
    global.fetch.mockImplementation(() => httpError(500));

    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('template_fallback');
    expect(result.provider_status).toBe('error');
    // 1 initial + 2 retries = 3 attempts.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent 400 — single attempt then template fallback', async () => {
    global.fetch.mockImplementation(() => httpError(400));

    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('template_fallback');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 rate-limit (transient) before falling back', async () => {
    global.fetch.mockImplementation(() => httpError(429));

    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('template_fallback');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
