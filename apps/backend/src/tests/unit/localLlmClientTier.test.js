// Unit tests for the deep/quick model-tier routing in localLlmClient.
// Adapted from TauricResearch/TradingAgents' deep_think_llm /
// quick_think_llm split, this verifies that:
//
//   * A module with no model_tier (or model_tier=quick) resolves to the
//     standard CLINICAL_AI_* env-var chain.
//   * A module with model_tier=deep prefers CLINICAL_AI_DEEP_* env vars.
//   * Deep falls back to the standard chain when DEEP_* is unset, so a
//     deployment with one set of credentials keeps working.
//
// _resolveProviderConfigForTesting is a thin pass-through over the
// internal getProviderConfig — it's intentionally exported for tests so
// the production surface (getClinicalAiConfig / generateClinicalText)
// stays unchanged.

import { _resolveProviderConfigForTesting, getClinicalAiConfig } from '../../services/ai/localLlmClient.js';

const ENV_KEYS = [
  'CLINICAL_AI_PROVIDER', 'CLINICAL_AI_MODEL', 'CLINICAL_AI_BASE_URL', 'CLINICAL_AI_API_KEY',
  'CLINICAL_AI_DEEP_PROVIDER', 'CLINICAL_AI_DEEP_MODEL', 'CLINICAL_AI_DEEP_BASE_URL', 'CLINICAL_AI_DEEP_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER', 'AI_SUMMARIZE_URL', 'AI_SUMMARIZE_MODEL',
];

let originalEnv = {};

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('default tier (no module)', () => {
  it('reports tier=quick on getClinicalAiConfig() when no module is supplied', () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';
    expect(getClinicalAiConfig().tier).toBe('quick');
  });
});

describe('module without model_tier', () => {
  it('resolves quick-tier env vars and reports tier=quick', () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';
    process.env.CLINICAL_AI_API_KEY = 'quick-key';

    const config = _resolveProviderConfigForTesting({
      module_key: 'discharge_summary',
      enabled: true,
      external_allowed: false,
      settings: { risk: 'high' },
    });

    expect(config.tier).toBe('quick');
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('llama3.1:8b');
    expect(config.apiKey).toBe('quick-key');
  });
});

describe('module with model_tier=deep and DEEP env vars set', () => {
  it('routes to CLINICAL_AI_DEEP_* values', () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';
    process.env.CLINICAL_AI_API_KEY = 'quick-key';

    process.env.CLINICAL_AI_DEEP_PROVIDER = 'anthropic';
    process.env.CLINICAL_AI_DEEP_BASE_URL = 'https://api.anthropic.com';
    process.env.CLINICAL_AI_DEEP_MODEL = 'claude-sonnet-4-5';
    process.env.CLINICAL_AI_DEEP_API_KEY = 'deep-key';

    const config = _resolveProviderConfigForTesting({
      module_key: 'discharge_summary',
      enabled: true,
      external_allowed: true,
      settings: { risk: 'high', model_tier: 'deep' },
    });

    expect(config.tier).toBe('deep');
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-5');
    expect(config.apiKey).toBe('deep-key');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
  });
});

describe('module with model_tier=deep but DEEP env vars unset', () => {
  it('falls back to the standard CLINICAL_AI_* chain so single-credential deployments keep working', () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';
    process.env.CLINICAL_AI_API_KEY = 'shared-key';

    const config = _resolveProviderConfigForTesting({
      module_key: 'medication_reconciliation',
      enabled: true,
      external_allowed: false,
      settings: { risk: 'critical', model_tier: 'deep' },
    });

    // Tier still reports 'deep' (so dashboards reflect the module's
    // declared intent); provider falls back because DEEP_* wasn't set.
    expect(config.tier).toBe('deep');
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('llama3.1:8b');
    expect(config.apiKey).toBe('shared-key');
  });
});

describe('serialised config exposes tier', () => {
  it('includes tier on the serialised config so the runtime status endpoint can show it', () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';

    const { serialized } = _resolveProviderConfigForTesting({
      module_key: 'abnormal_result_triage',
      enabled: true,
      external_allowed: false,
      settings: { risk: 'critical', model_tier: 'deep' },
    });
    expect(serialized.tier).toBe('deep');
    expect(serialized.moduleKey).toBe('abnormal_result_triage');
  });
});

describe('invalid tier values', () => {
  it('coerces unknown tier strings to quick', () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
    process.env.CLINICAL_AI_MODEL = 'llama3.1:8b';

    const config = _resolveProviderConfigForTesting({
      module_key: 'whatever',
      enabled: true,
      external_allowed: false,
      settings: { model_tier: 'medium' /* not a valid tier */ },
    });
    expect(config.tier).toBe('quick');
  });
});
