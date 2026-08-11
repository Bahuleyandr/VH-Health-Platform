import { jest } from '@jest/globals';

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockModule = {
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
let mockGuardrails = {
  enabled: true,
  external_ai_enabled: true,
  daily_token_limit: null,
  daily_cost_limit_minor: null,
  request_token_limit: null,
  fallback_rate_alert_pct: 50,
  max_fallbacks_per_day: null,
  latency_alert_ms: 15000,
};
let mockBudgetStatus = {
  enabled: true,
  external_ai_enabled: true,
  tripped: false,
  blocking_reasons: [],
  alerts: [],
  token_budget: { used: 0, limit: null, remaining: null, percent_used: null, tripped: false },
  cost_budget: { used: 0, limit: null, remaining: null, percent_used: null, tripped: false },
};
const mockGetClinicalAiGuardrails = jest.fn(async () => mockGuardrails);

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiBudgetStatus: jest.fn(async () => mockBudgetStatus),
  getClinicalAiGuardrails: mockGetClinicalAiGuardrails,
  getClinicalAiModule: jest.fn(async () => mockModule),
  getClinicalAiUsageSummary: jest.fn(async () => ({
    window_days: 7,
    overall: { generation_count: 0, ai_generation_count: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    by_module: [],
    by_provider: [],
    recent_failures: [],
  })),
  listClinicalAiModules: jest.fn(async () => [mockModule]),
}));

const {
  generateClinicalText,
  getClinicalAiConfig,
  getClinicalAiRuntimeStatus,
  checkDeepModuleReadiness,
  assertDeepModuleLive,
  normalizeStructuredOutputSchema,
} = await import('../../services/ai/localLlmClient.js');
// Real (un-mocked) metrics + logger-mock handles so the deep-tier safety tests
// can assert the named counter increments and the WARN fires. logger.js is
// mocked above; prometheusMiddleware.js is NOT — localLlmClient imports the
// real recordDeepTemplateFallback, so this is the same Counter instance.
const { serializeMetrics } = await import('../../middleware/prometheusMiddleware.js');
const { default: mockLogger } = await import('../../logging/logger.js');

// Read the current value of the deep template-fallback counter for a given
// module+tier label pair from the Prometheus exposition output.
function deepFallbackCount(moduleLabel, tierLabel) {
  const needle = `clinical_ai_deep_template_fallback_total{module="${moduleLabel}",tier="${tierLabel}"}`;
  const line = serializeMetrics()
    .split('\n')
    .find((l) => l.startsWith(needle));
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).pop()) || 0;
}

function okJsonTags(modelNames) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ models: modelNames.map((name) => ({ name })) }),
  });
}

const ORIGINAL_ENV = { ...process.env };
const SECRET_NAMED_ENV_KEYS = [
  ['CLINICAL_AI_PACS_', 'USER', 'NAME'].join(''),
  ['CLINICAL_AI_PACS_', 'PASS', 'WORD'].join(''),
  ['ORTHANC_', 'USER', 'NAME'].join(''),
  ['ORTHANC_', 'PASS', 'WORD'].join(''),
];
const CLINICAL_ENV_KEYS = [
  'AI_PROVIDER',
  'AI_SUMMARIZE_MODEL',
  'AI_SUMMARIZE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_VERSION',
  'ANTHROPIC_VERSION',
  'CLINICAL_AI_ALLOW_EXTERNAL',
  'CLINICAL_AI_API_KEY',
  'CLINICAL_AI_BASE_URL',
  'CLINICAL_AI_DEEP_API_KEY',
  'CLINICAL_AI_DEEP_BASE_URL',
  'CLINICAL_AI_DEEP_MODEL',
  'CLINICAL_AI_DEEP_PROVIDER',
  'CLINICAL_AI_MAX_TOKENS',
  'CLINICAL_AI_MODEL',
  'CLINICAL_AI_DIARIZATION_ALLOWED_REGIONS',
  'CLINICAL_AI_DIARIZATION_API_KEY',
  'CLINICAL_AI_DIARIZATION_ENDPOINT',
  'CLINICAL_AI_DIARIZATION_PROVIDER',
  'CLINICAL_AI_DIARIZATION_REGIONS',
  'CLINICAL_AI_DIARIZATION_TIMEOUT_MS',
  'CLINICAL_AI_EXTERNAL_REGIONS',
  'CLINICAL_AI_PACS_ALLOWED_REGIONS',
  'CLINICAL_AI_PACS_API_MODE',
  'CLINICAL_AI_PACS_BASE_URL',
  'CLINICAL_AI_PACS_PROVIDER',
  'CLINICAL_AI_PACS_REGIONS',
  'CLINICAL_AI_PACS_TIMEOUT_MS',
  'CLINICAL_AI_PROVIDER',
  'CLINICAL_AI_PRIOR_AUTH_PAYER_ALLOWED_REGIONS',
  'CLINICAL_AI_PRIOR_AUTH_PAYER_API_KEY',
  'CLINICAL_AI_PRIOR_AUTH_PAYER_ENDPOINT',
  'CLINICAL_AI_PRIOR_AUTH_PAYER_MODE',
  'CLINICAL_AI_PRIOR_AUTH_PAYER_TIMEOUT_MS',
  'CLINICAL_AI_STT_ALLOWED_REGIONS',
  'CLINICAL_AI_STT_API_KEY',
  'CLINICAL_AI_STT_AZURE_REGION',
  'CLINICAL_AI_STT_MODEL',
  'CLINICAL_AI_STT_PROVIDER',
  'CLINICAL_AI_STT_REGIONS',
  'CLINICAL_AI_STT_URL',
  'CLINICAL_AI_TEMPERATURE',
  'CLINICAL_AI_TIMEOUT_MS',
  'DCM4CHEE_URL',
  'DIARIZATION_WEBHOOK_API_KEY',
  'DIARIZATION_WEBHOOK_URL',
  'ORTHANC_URL',
  'OPENAI_API_KEY',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'PRIOR_AUTH_PAYER_ALLOWED_REGIONS',
  'PRIOR_AUTH_PAYER_API_KEY',
  'PRIOR_AUTH_PAYER_ENDPOINT',
  'PRIOR_AUTH_PAYER_MODE',
  'PRIOR_AUTH_PAYER_TIMEOUT_MS',
  ...SECRET_NAMED_ENV_KEYS,
];

function resetClinicalEnv() {
  for (const key of CLINICAL_ENV_KEYS) {
    delete process.env[key];
  }
}

function okJson(payload) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  });
}

describe('clinical AI provider client', () => {
  beforeEach(() => {
    resetClinicalEnv();
    mockModule = {
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
    mockGuardrails = {
      enabled: true,
      external_ai_enabled: true,
      daily_token_limit: null,
      daily_cost_limit_minor: null,
      request_token_limit: null,
      fallback_rate_alert_pct: 50,
      max_fallbacks_per_day: null,
      latency_alert_ms: 15000,
    };
    mockBudgetStatus = {
      enabled: true,
      external_ai_enabled: true,
      tripped: false,
      blocking_reasons: [],
      alerts: [],
      token_budget: { used: 0, limit: null, remaining: null, percent_used: null, tripped: false },
      cost_budget: { used: 0, limit: null, remaining: null, percent_used: null, tripped: false },
    };
    mockGetClinicalAiGuardrails.mockReset().mockImplementation(async () => mockGuardrails);
    global.fetch = jest.fn();
    // logger.js is a module-scoped mock; clear call history each test so the
    // deep-fallback WARN assertions (and the "does NOT warn" negative) see a
    // clean slate rather than calls accumulated by earlier tests in this file.
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    delete global.fetch;
  });

  it('defaults to template fallback and advertises supported providers', () => {
    const config = getClinicalAiConfig();

    expect(config.enabled).toBe(false);
    expect(config.provider).toBe('template');
    expect(config.supportedProviders).toEqual(
      expect.arrayContaining(['ollama', 'openai-compatible', 'openai', 'anthropic'])
    );
  });

  it('returns explicit template fallback status when no provider is configured', async () => {
    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result).toMatchObject({
      usedAi: false,
      generation_mode: 'template_fallback',
      provider_status: 'template_fallback',
    });
    expect(result.fallback_reason).toMatch(/template fallback/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('blocks external providers until explicitly allowed', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const config = getClinicalAiConfig();
    expect(config.enabled).toBe(false);
    expect(config.externalProvider).toBe(true);
    expect(config.readiness).toMatch(/ALLOW_EXTERNAL/);

    const result = await generateClinicalText({
      systemPrompt: 'Summarize safely.',
      userPrompt: 'Patient context',
      taskType: 'test',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('blocked');
    expect(result.provider_status).toBe('blocked');
    expect(result.readiness_reason).toMatch(/ALLOW_EXTERNAL/);
    expect(result.reason).toMatch(/ALLOW_EXTERNAL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls OpenAI chat completions when external use is allowed', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai';
    process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    mockModule = { ...mockModule, external_allowed: true };
    global.fetch.mockResolvedValue(okJson({
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'OpenAI draft' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result).toMatchObject({
      usedAi: true,
      provider: 'openai',
      generation_mode: 'ai',
      provider_status: 'used',
      text: 'OpenAI draft',
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-openai-key',
          'Content-Type': 'application/json',
        }),
      })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-test-model');
    expect(body.messages[0]).toEqual({ role: 'developer', content: 'System safety prompt' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Patient context' });
  });

  it('blocks external providers when tenant region is unknown and a region allowlist is configured', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai';
    process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.CLINICAL_AI_EXTERNAL_REGIONS = 'IN';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    mockModule = { ...mockModule, external_allowed: true };

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result).toMatchObject({
      usedAi: false,
      provider: 'openai',
      generation_mode: 'blocked',
      provider_status: 'blocked',
      reason: 'external_provider_blocked_for_region:UNKNOWN',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── External-region egress defaults FAIL-CLOSED (audit §3 / §6) ──────────
  // Empty/unset CLINICAL_AI_EXTERNAL_REGIONS must NOT allow external PHI egress
  // for a region-bearing tenant. The only documented escapes are an explicit
  // `*` allowlist or a tenant that carries no region at all (single-tenant pilot).
  describe('external-region egress fails closed when allowlist is empty', () => {
    it('blocks external use for a region-bearing tenant when CLINICAL_AI_EXTERNAL_REGIONS is unset', async () => {
      process.env.CLINICAL_AI_PROVIDER = 'openai';
      process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      process.env.OPENAI_API_KEY = 'test-openai-key';
      // CLINICAL_AI_EXTERNAL_REGIONS intentionally unset (resetClinicalEnv cleared it).
      mockModule = { ...mockModule, external_allowed: true };

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        tenantRegion: 'IN',
      });

      expect(result).toMatchObject({
        usedAi: false,
        provider: 'openai',
        generation_mode: 'blocked',
        provider_status: 'blocked',
        reason: 'external_provider_blocked_for_region:IN',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('blocks external use for a region-bearing tenant when CLINICAL_AI_EXTERNAL_REGIONS is empty/whitespace', async () => {
      process.env.CLINICAL_AI_PROVIDER = 'openai';
      process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      process.env.CLINICAL_AI_EXTERNAL_REGIONS = '   ';
      process.env.OPENAI_API_KEY = 'test-openai-key';
      mockModule = { ...mockModule, external_allowed: true };

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        tenantRegion: 'US',
      });

      expect(result).toMatchObject({
        usedAi: false,
        generation_mode: 'blocked',
        provider_status: 'blocked',
        reason: 'external_provider_blocked_for_region:US',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('permits external use when the tenant region is explicitly allow-listed', async () => {
      process.env.CLINICAL_AI_PROVIDER = 'openai';
      process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      process.env.CLINICAL_AI_EXTERNAL_REGIONS = 'US,AP';
      process.env.OPENAI_API_KEY = 'test-openai-key';
      mockModule = { ...mockModule, external_allowed: true };
      global.fetch.mockResolvedValue(okJson({
        id: 'chatcmpl-region',
        choices: [{ message: { content: 'Allow-listed region draft' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        tenantRegion: 'US',
      });

      expect(result).toMatchObject({
        usedAi: true,
        provider: 'openai',
        generation_mode: 'ai',
        text: 'Allow-listed region draft',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('preserves the single-tenant-pilot escape: no tenant region + empty allowlist is allowed', async () => {
      process.env.CLINICAL_AI_PROVIDER = 'openai';
      process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      // No CLINICAL_AI_EXTERNAL_REGIONS, no tenantRegion → single-tenant pilot.
      process.env.OPENAI_API_KEY = 'test-openai-key';
      mockModule = { ...mockModule, external_allowed: true };
      global.fetch.mockResolvedValue(okJson({
        id: 'chatcmpl-pilot',
        choices: [{ message: { content: 'Pilot draft' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        // tenantRegion omitted (null)
      });

      expect(result).toMatchObject({ usedAi: true, generation_mode: 'ai', text: 'Pilot draft' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('honors an explicit wildcard allowlist (CLINICAL_AI_EXTERNAL_REGIONS=*) for a region-bearing tenant', async () => {
      process.env.CLINICAL_AI_PROVIDER = 'openai';
      process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      process.env.CLINICAL_AI_EXTERNAL_REGIONS = '*';
      process.env.OPENAI_API_KEY = 'test-openai-key';
      mockModule = { ...mockModule, external_allowed: true };
      global.fetch.mockResolvedValue(okJson({
        id: 'chatcmpl-wild',
        choices: [{ message: { content: 'Wildcard draft' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        tenantRegion: 'ZZ',
      });

      expect(result).toMatchObject({ usedAi: true, generation_mode: 'ai', text: 'Wildcard draft' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  it('calls Anthropic Messages API when external use is allowed', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'anthropic';
    process.env.CLINICAL_AI_MODEL = 'claude-test-model';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    mockModule = { ...mockModule, external_allowed: true };
    global.fetch.mockResolvedValue(okJson({
      id: 'msg-test',
      content: [{ type: 'text', text: 'Anthropic draft' }],
      usage: { input_tokens: 13, output_tokens: 5 },
    }));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'handover',
    });

    expect(result).toMatchObject({
      usedAi: true,
      provider: 'anthropic',
      text: 'Anthropic draft',
      usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-anthropic-key',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        }),
      })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-test-model');
    // Modernized provider path: cacheable system block, no sampling params
    // (current Anthropic models reject non-default temperature), and no
    // structured output unless a schema is supplied.
    expect(body.system).toEqual([
      { type: 'text', text: 'System safety prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'Patient context' }]);
  });

  it('allows local OpenAI-compatible endpoints without the external gate', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai-compatible';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:1234/v1';
    process.env.CLINICAL_AI_MODEL = 'local-model';
    global.fetch.mockResolvedValue(okJson({
      choices: [{ message: { content: [{ text: 'Local gateway draft' }] } }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    }));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result).toMatchObject({
      usedAi: true,
      provider: 'openai-compatible',
      text: 'Local gateway draft',
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.any(String) }),
      })
    );
  });

  it('routes deep-tier modules to local Ollama without requiring the external gate', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'template';
    process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
    process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
    process.env.CLINICAL_AI_DEEP_MODEL = 'llama3.1:70b-instruct-q4_K_M';
    mockModule = {
      ...mockModule,
      external_allowed: false,
      settings: { risk: 'critical', modelTier: 'deep' },
    };
    global.fetch.mockResolvedValue(okJson({
      response: 'Ollama deep draft',
      prompt_eval_count: 17,
      eval_count: 11,
      total_duration: 250000000,
      done_reason: 'stop',
    }));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'medication_reconciliation',
      tenantRegion: 'IN',
    });

    expect(result).toMatchObject({
      usedAi: true,
      provider: 'ollama',
      model: 'llama3.1:70b-instruct-q4_K_M',
      tier: 'deep',
      generation_mode: 'ai',
      provider_status: 'used',
      text: 'Ollama deep draft',
      usage: { prompt_tokens: 17, completion_tokens: 11, total_tokens: 28 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://ollama-internal:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'llama3.1:70b-instruct-q4_K_M',
      stream: false,
      system: 'System safety prompt',
      prompt: 'Patient context',
    });
  });

  it('still blocks deep-tier external providers unless governance allows external AI', async () => {
    process.env.CLINICAL_AI_DEEP_PROVIDER = 'anthropic';
    process.env.CLINICAL_AI_DEEP_MODEL = 'claude-test-model';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    // Allow-list the tenant region so the region gate (now fail-closed by
    // default) passes and this test isolates the ALLOW_EXTERNAL gate it asserts.
    process.env.CLINICAL_AI_EXTERNAL_REGIONS = 'IN';
    mockModule = {
      ...mockModule,
      external_allowed: false,
      settings: { risk: 'critical', model_tier: 'deep' },
    };

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'medication_reconciliation',
      tenantRegion: 'IN',
    });

    expect(result).toMatchObject({
      usedAi: false,
      provider: 'anthropic',
      tier: 'deep',
      generation_mode: 'blocked',
      provider_status: 'blocked',
    });
    expect(result.reason).toMatch(/ALLOW_EXTERNAL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('turns disabled modules into template fallback without calling the provider', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    mockModule = { ...mockModule, enabled: false };

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('blocked');
    expect(result.provider_status).toBe('blocked');
    expect(result.reason).toMatch(/module disabled/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns runtime status with modules and usage', async () => {
    const status = await getClinicalAiRuntimeStatus();

    expect(status.modules).toHaveLength(1);
    expect(status.usage.overall.total_tokens).toBe(0);
    expect(status.guardrails.enabled).toBe(true);
    expect(status.budget.tripped).toBe(false);
    expect(status.providerHealth.status).toBe('blocked');
    expect(status.adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'speech_to_text',
        provider: 'none',
        configured: false,
        status: 'not_configured',
        reason: 'stt_provider_not_configured',
      }),
      expect.objectContaining({
        key: 'ambient_diarization',
        provider: 'none',
        configured: false,
        status: 'not_configured',
      }),
      expect.objectContaining({
        key: 'imaging_pacs',
        provider: 'none',
        configured: false,
        status: 'not_configured',
      }),
      expect.objectContaining({
        key: 'prior_auth_payer',
        mode: 'manual',
        configured: true,
        status: 'configured',
        external_call: false,
      }),
    ]));
  });

  it('reports adapter readiness with tenant region gates', async () => {
    process.env.CLINICAL_AI_STT_PROVIDER = 'local_whisper';
    process.env.CLINICAL_AI_DIARIZATION_PROVIDER = 'webhook';
    process.env.CLINICAL_AI_DIARIZATION_ENDPOINT = 'https://diarization.example.test/jobs';
    process.env.CLINICAL_AI_DIARIZATION_ALLOWED_REGIONS = 'US';
    process.env.CLINICAL_AI_PACS_PROVIDER = 'orthanc';
    process.env.CLINICAL_AI_PACS_BASE_URL = 'https://pacs.example.test';
    process.env.CLINICAL_AI_PACS_ALLOWED_REGIONS = 'IN';
    process.env.CLINICAL_AI_PRIOR_AUTH_PAYER_MODE = 'http';
    process.env.CLINICAL_AI_PRIOR_AUTH_PAYER_ENDPOINT = 'https://payer.example.test/prior-auth';
    process.env.CLINICAL_AI_PRIOR_AUTH_PAYER_ALLOWED_REGIONS = 'IN';

    const status = await getClinicalAiRuntimeStatus({ tenantRegion: 'IN' });

    expect(status.adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'speech_to_text',
        provider: 'local_whisper',
        configured: true,
        status: 'configured',
        tenant_region: 'IN',
      }),
      expect.objectContaining({
        key: 'ambient_diarization',
        provider: 'webhook',
        configured: false,
        status: 'blocked',
        reason: 'tenant_region_not_allowed_for_diarization',
        tenant_region: 'IN',
      }),
      expect.objectContaining({
        key: 'imaging_pacs',
        provider: 'orthanc',
        configured: true,
        status: 'configured',
        endpoint_configured: true,
        tenant_region: 'IN',
      }),
      expect.objectContaining({
        key: 'prior_auth_payer',
        mode: 'http',
        configured: true,
        status: 'configured',
        external_call: true,
        endpoint_configured: true,
        tenant_region: 'IN',
      }),
    ]));
  });

  it('blocks provider health probes when tenant region is unknown and a region allowlist is configured', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai';
    process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.CLINICAL_AI_EXTERNAL_REGIONS = 'IN';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const status = await getClinicalAiRuntimeStatus({ live: true });

    expect(status.config).toMatchObject({
      enabled: false,
      externalProvider: true,
      readiness: 'external_provider_blocked_for_region:UNKNOWN',
    });
    expect(status.providerHealth).toMatchObject({
      ok: false,
      status: 'blocked',
      reason: 'external_provider_blocked_for_region:UNKNOWN',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('blocks external STT when tenant region is unknown and an STT allowlist is configured', async () => {
    process.env.CLINICAL_AI_STT_PROVIDER = 'openai';
    process.env.CLINICAL_AI_STT_ALLOWED_REGIONS = 'IN';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const status = await getClinicalAiRuntimeStatus();

    expect(status.adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'speech_to_text',
        provider: 'openai',
        configured: false,
        status: 'blocked',
        reason: 'tenant_region_not_allowed_for_stt',
        tenant_region: null,
        allowed_regions: ['IN'],
      }),
    ]));
  });

  it('blocks external providers when the admin guardrail disables external AI', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    mockModule = { ...mockModule, external_allowed: true };
    mockGuardrails = { ...mockGuardrails, external_ai_enabled: false };

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('blocked');
    expect(result.provider_status).toBe('blocked');
    expect(result.reason).toMatch(/admin guardrail/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('blocks provider calls when daily budget guardrails are tripped', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai-compatible';
    process.env.CLINICAL_AI_BASE_URL = 'http://localhost:1234/v1';
    mockBudgetStatus = {
      ...mockBudgetStatus,
      tripped: true,
      blocking_reasons: ['Daily clinical AI token budget exhausted'],
    };

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('blocked');
    expect(result.provider_status).toBe('blocked');
    expect(result.reason).toMatch(/token budget/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('marks provider failures as template fallback with error provider status', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'ollama';
    global.fetch.mockRejectedValue(new Error('connection refused'));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result.usedAi).toBe(false);
    expect(result.generation_mode).toBe('template_fallback');
    expect(result.provider_status).toBe('error');
    expect(result.fallback_reason).toMatch(/connection refused/i);
  });

  // ── Deep-tier readiness gate (silent-template-fallback safety fix) ────────
  describe('deep-tier model-pulled readiness', () => {
    function configureDeepOllama(model = 'llama3.1:70b-instruct-q4_K_M') {
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
      process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
      process.env.CLINICAL_AI_DEEP_MODEL = model;
    }

    it('reports deepModelPulled=true when the configured deep model is present in /api/tags', async () => {
      configureDeepOllama('llama3.1:70b-instruct-q4_K_M');
      global.fetch.mockReturnValue(
        okJsonTags(['llama3.1:8b', 'llama3.1:70b-instruct-q4_K_M', 'nomic-embed-text:latest'])
      );

      const status = await getClinicalAiRuntimeStatus({ live: true });

      expect(status.deepTier).toMatchObject({
        configured: true,
        provider: 'ollama',
        model: 'llama3.1:70b-instruct-q4_K_M',
        deepModelPulled: true,
        modelPulledChecked: true,
      });
      expect(status.deepTier.available_models).toEqual(
        expect.arrayContaining(['llama3.1:70b-instruct-q4_K_M'])
      );
    });

    it('reports deepModelPulled=false when the configured deep model is NOT pulled', async () => {
      configureDeepOllama('llama3.1:70b-instruct-q4_K_M');
      // Daemon is healthy and answers, but the deep model was never pulled.
      global.fetch.mockReturnValue(okJsonTags(['llama3.1:8b', 'phi3:mini']));

      const status = await getClinicalAiRuntimeStatus({ live: true });

      expect(status.deepTier).toMatchObject({
        configured: true,
        deepModelPulled: false,
        modelPulledChecked: true,
      });
      expect(status.deepTier.modelPulledReason).toMatch(/model_not_pulled/);
    });

    it('matches a deep model configured without an explicit tag against :latest', async () => {
      configureDeepOllama('meditron');
      global.fetch.mockReturnValue(okJsonTags(['meditron:latest', 'llama3.1:8b']));

      const status = await getClinicalAiRuntimeStatus({ live: true });
      expect(status.deepTier.deepModelPulled).toBe(true);
    });

    it('does not assert deepModelPulled=true on a non-live status (no network call)', async () => {
      configureDeepOllama();

      const status = await getClinicalAiRuntimeStatus(); // live:false

      expect(status.deepTier.configured).toBe(true);
      expect(status.deepTier.deepModelPulled).toBeNull();
      expect(status.deepTier.modelPulledChecked).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reports deepModelPulled=null (unknown) when /api/tags is unreachable', async () => {
      configureDeepOllama();
      global.fetch.mockRejectedValue(new Error('connection refused'));

      const status = await getClinicalAiRuntimeStatus({ live: true });

      expect(status.deepTier.configured).toBe(true);
      expect(status.deepTier.deepModelPulled).toBeNull();
      expect(status.deepTier.modelPulledChecked).toBe(false);
    });
  });

  describe('loud deep template-fallback signal', () => {
    it('increments the named counter + WARNs when a deep/critical module falls back to template', async () => {
      // Deep, critical module; deep provider is Ollama but generation fails →
      // silent template fallback. This is the exact hazard the gate guards.
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
      process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
      process.env.CLINICAL_AI_DEEP_MODEL = 'llama3.1:70b-instruct-q4_K_M';
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      global.fetch.mockRejectedValue(new Error('model runner timed out'));

      const before = deepFallbackCount('medication_reconciliation', 'deep');

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'medication_reconciliation',
        tenantRegion: 'IN',
      });

      expect(result.usedAi).toBe(false);
      expect(result.generation_mode).toBe('template_fallback');
      expect(deepFallbackCount('medication_reconciliation', 'deep')).toBe(before + 1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/fell back to template/i),
        expect.objectContaining({ module: 'medication_reconciliation', tier: 'deep' })
      );
    });

    it('increments the counter when the deep provider is template (never configured) for a critical module', async () => {
      // No deep provider configured at all → readiness resolves to the template
      // fallback. A critical module landing here is still silent degradation.
      mockModule = {
        ...mockModule,
        module_key: 'op_differential_red_flags',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };

      const before = deepFallbackCount('op_differential_red_flags', 'deep');

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'op_differential_red_flags',
      });

      expect(result.usedAi).toBe(false);
      expect(result.generation_mode).toBe('template_fallback');
      expect(deepFallbackCount('op_differential_red_flags', 'deep')).toBe(before + 1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does NOT increment or warn on a normal quick-tier template fallback', async () => {
      // Quick-tier, non-critical, no signoff module → routine degradation must
      // stay quiet (no metric noise, no targeted WARN).
      mockModule = {
        module_key: 'handover_summary',
        display_name: 'Nursing Handover Drafts',
        enabled: true,
        external_allowed: false,
        provider_override: null,
        model_override: null,
        max_tokens: null,
        temperature: null,
        settings: { risk: 'low' },
      };

      const before = deepFallbackCount('handover_summary', 'quick');

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'handover_summary',
      });

      expect(result.usedAi).toBe(false);
      expect(result.generation_mode).toBe('template_fallback');
      expect(deepFallbackCount('handover_summary', 'quick')).toBe(before);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringMatching(/fell back to template/i),
        expect.anything()
      );
    });

    it('does NOT increment when a deep-tier generation SUCCEEDS (non-breaking happy path)', async () => {
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
      process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
      process.env.CLINICAL_AI_DEEP_MODEL = 'llama3.1:70b-instruct-q4_K_M';
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ response: 'Deep AI draft', prompt_eval_count: 5, eval_count: 3 }),
      });

      const before = deepFallbackCount('medication_reconciliation', 'deep');

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'medication_reconciliation',
        tenantRegion: 'IN',
      });

      expect(result.usedAi).toBe(true);
      expect(result.generation_mode).toBe('ai');
      expect(deepFallbackCount('medication_reconciliation', 'deep')).toBe(before);
    });
  });

  describe('checkDeepModuleReadiness / assertDeepModuleLive (enablement gate)', () => {
    it('fails closed when guardrails cannot be loaded', async () => {
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      mockGetClinicalAiGuardrails.mockRejectedValueOnce(new Error('guardrails db unavailable'));

      const verdict = await checkDeepModuleReadiness('medication_reconciliation', { smoke: false });

      expect(verdict).toMatchObject({
        ready: false,
        provider: null,
        model: null,
      });
      expect(verdict.reason).toBe('guardrails_lookup_failed:guardrails db unavailable');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns ready when the deep model is pulled and a smoke gen returns used_ai=true', async () => {
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
      process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
      process.env.CLINICAL_AI_DEEP_MODEL = 'llama3.1:70b-instruct-q4_K_M';
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      // First fetch = /api/tags (model present); second = /api/generate (success).
      global.fetch
        .mockReturnValueOnce(okJsonTags(['llama3.1:70b-instruct-q4_K_M']))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ response: 'Smoke OK', prompt_eval_count: 2, eval_count: 2 }),
        });

      const verdict = await checkDeepModuleReadiness('medication_reconciliation', { tenantRegion: 'IN' });

      expect(verdict).toMatchObject({
        deepTier: true,
        provider: 'ollama',
        modelPulled: true,
        smokeRan: true,
        smokeUsedAi: true,
        ready: true,
        reason: null,
      });
    });

    it('is not ready when the deep model is not pulled (and skips the smoke gen)', async () => {
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
      process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
      process.env.CLINICAL_AI_DEEP_MODEL = 'llama3.1:70b-instruct-q4_K_M';
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      global.fetch.mockReturnValue(okJsonTags(['llama3.1:8b'])); // deep model absent

      const verdict = await checkDeepModuleReadiness('medication_reconciliation', { tenantRegion: 'IN' });

      expect(verdict.ready).toBe(false);
      expect(verdict.modelPulled).toBe(false);
      expect(verdict.smokeRan).toBe(false);
      expect(verdict.reason).toMatch(/model_not_pulled/);
      // Only the /api/tags probe ran — no wasted /api/generate call.
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('is not ready when the smoke gen silently falls back to template', async () => {
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'ollama';
      process.env.CLINICAL_AI_DEEP_BASE_URL = 'http://ollama-internal:11434';
      process.env.CLINICAL_AI_DEEP_MODEL = 'llama3.1:70b-instruct-q4_K_M';
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      // tags say pulled, but the generate call fails → template fallback.
      global.fetch
        .mockReturnValueOnce(okJsonTags(['llama3.1:70b-instruct-q4_K_M']))
        .mockRejectedValueOnce(new Error('model runner crashed'));

      const verdict = await checkDeepModuleReadiness('medication_reconciliation', { tenantRegion: 'IN' });

      expect(verdict.ready).toBe(false);
      expect(verdict.smokeRan).toBe(true);
      expect(verdict.smokeUsedAi).toBe(false);
    });

    it('treats a non-deep (quick-tier) module as ready and does not block it', async () => {
      mockModule = {
        ...mockModule,
        module_key: 'handover_summary',
        settings: { risk: 'low' },
      };

      const verdict = await checkDeepModuleReadiness('handover_summary');

      expect(verdict.deepTier).toBe(false);
      expect(verdict.ready).toBe(true);
      expect(verdict.reason).toBe('not_deep_tier');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('assertDeepModuleLive throws a coded error with the readiness payload when not live', async () => {
      mockModule = {
        ...mockModule,
        module_key: 'medication_reconciliation',
        settings: { risk: 'critical', model_tier: 'deep', requiresClinicianSignoff: true },
      };
      // No deep provider configured → provider resolves to template.
      await expect(
        assertDeepModuleLive('medication_reconciliation', { smoke: false })
      ).rejects.toMatchObject({
        code: 'CLINICAL_AI_DEEP_MODULE_NOT_LIVE',
        readiness: expect.objectContaining({ ready: false }),
      });
    });
  });

  // ── Anthropic provider modernization (governed Claude adoption, Part 2) ──
  describe('anthropic provider modernization', () => {
    function allowAnthropic() {
      process.env.CLINICAL_AI_PROVIDER = 'anthropic';
      process.env.CLINICAL_AI_MODEL = 'claude-test-model';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
      mockModule = { ...mockModule, external_allowed: true };
    }

    const WELL_FORMED_SCHEMA = {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code'],
            properties: { code: { type: 'string' } },
          },
        },
      },
    };

    it('treats stop_reason=refusal as NON-retryable and falls back with the reason recorded', async () => {
      allowAnthropic();
      global.fetch.mockResolvedValue(okJson({
        id: 'msg-refusal',
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
        content: [],
        usage: { input_tokens: 21, output_tokens: 0 },
      }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
      });

      expect(result.usedAi).toBe(false);
      expect(result.generation_mode).toBe('template_fallback');
      expect(result.provider_status).toBe('error');
      expect(result.reason).toBe('anthropic_refusal:cyber');
      expect(result.fallback_reason).toBe('anthropic_refusal:cyber');
      // NON-retryable: exactly one provider call — a refusal must never burn
      // the transient-retry budget as "empty content".
      expect(global.fetch).toHaveBeenCalledTimes(1);
      // Refusal tokens are billed — usage is carried into the fallback result.
      expect(result.usage.prompt_tokens).toBe(21);
    });

    it('sends output_config.format (structured outputs) when a well-formed jsonSchema is supplied', async () => {
      allowAnthropic();
      global.fetch.mockResolvedValue(okJson({
        id: 'msg-structured',
        content: [{ type: 'text', text: '{"summary":"ok"}' }],
        usage: { input_tokens: 8, output_tokens: 4 },
      }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        jsonSchema: WELL_FORMED_SCHEMA,
      });

      expect(result.usedAi).toBe(true);
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: expect.objectContaining({
            type: 'object',
            additionalProperties: false,
            required: ['summary'],
          }),
        },
      });
      // Nested objects are normalized too.
      expect(body.output_config.format.schema.properties.items.items.additionalProperties).toBe(false);
    });

    it('retries ONCE without output_config when the endpoint rejects the schema with HTTP 400', async () => {
      allowAnthropic();
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve(JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'output_config.format schema is not supported by this endpoint',
            },
          })),
        })
        .mockResolvedValueOnce(okJson({
          id: 'msg-plain',
          content: [{ type: 'text', text: '```json\n{"summary":"ok"}\n```' }],
          usage: { input_tokens: 8, output_tokens: 4 },
        }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        jsonSchema: WELL_FORMED_SCHEMA,
      });

      expect(result.usedAi).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(firstBody.output_config).toBeDefined();
      expect(secondBody.output_config).toBeUndefined();
    });

    it('normalizeStructuredOutputSchema rejects the loose registry stubs and enforces additionalProperties:false', () => {
      // The discharge_summary registry stub has required[] but NO properties —
      // must never activate structured output.
      expect(normalizeStructuredOutputSchema({
        type: 'object',
        required: ['hospital_course', 'discharge_diagnosis'],
      })).toBeNull();
      // required keys missing from properties → rejected.
      expect(normalizeStructuredOutputSchema({
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { type: 'string' } },
      })).toBeNull();
      expect(normalizeStructuredOutputSchema(null)).toBeNull();
      expect(normalizeStructuredOutputSchema({})).toBeNull();
      // Well-formed schema passes with every object node closed.
      const normalized = normalizeStructuredOutputSchema(WELL_FORMED_SCHEMA);
      expect(normalized.additionalProperties).toBe(false);
      expect(normalized.properties.items.items.additionalProperties).toBe(false);
      expect(normalized.properties.items.items.required).toEqual(['code']);
    });
  });

  // ── Feature A: discharge-summary deep tier on Anthropic (env-only glue) ──
  describe('discharge deep tier via CLINICAL_AI_DEEP_* (anthropic)', () => {
    const DEEP_DISCHARGE_SETTINGS = {
      risk: 'high',
      model_tier: 'deep',
      requiresClinicianSignoff: true,
    };

    it('is OFF by default: with no deep provider configured the discharge module stays on the labeled template path', async () => {
      mockModule = { ...mockModule, settings: DEEP_DISCHARGE_SETTINGS };

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
      });

      expect(result).toMatchObject({
        usedAi: false,
        provider: 'template',
        tier: 'deep',
        generation_mode: 'template_fallback',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('routes discharge_summary to Anthropic with the deep-tier key once every egress gate is explicitly opened', async () => {
      process.env.CLINICAL_AI_DEEP_PROVIDER = 'anthropic';
      process.env.CLINICAL_AI_DEEP_MODEL = 'deep-test-model';
      process.env.CLINICAL_AI_DEEP_API_KEY = 'deep-tier-key';
      process.env.CLINICAL_AI_API_KEY = 'standard-key';
      process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
      process.env.CLINICAL_AI_EXTERNAL_REGIONS = 'IN';
      mockModule = { ...mockModule, external_allowed: true, settings: DEEP_DISCHARGE_SETTINGS };
      global.fetch.mockResolvedValue(okJson({
        id: 'msg-deep',
        content: [{ type: 'text', text: 'Deep discharge draft' }],
        usage: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 5 },
      }));

      const result = await generateClinicalText({
        systemPrompt: 'System safety prompt',
        userPrompt: 'Patient context',
        taskType: 'discharge_summary',
        tenantRegion: 'IN',
      });

      expect(result).toMatchObject({
        usedAi: true,
        provider: 'anthropic',
        model: 'deep-test-model',
        tier: 'deep',
        generation_mode: 'ai',
        text: 'Deep discharge draft',
      });
      // Cache-read tokens are counted into prompt tokens.
      expect(result.usage.prompt_tokens).toBe(35);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-key': 'deep-tier-key' }),
        })
      );
    });
  });
});
