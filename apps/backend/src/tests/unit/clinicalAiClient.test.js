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

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiBudgetStatus: jest.fn(async () => mockBudgetStatus),
  getClinicalAiGuardrails: jest.fn(async () => mockGuardrails),
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

const { generateClinicalText, getClinicalAiConfig, getClinicalAiRuntimeStatus } = await import('../../services/ai/localLlmClient.js');

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
    global.fetch = jest.fn();
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
    expect(body.system).toBe('System safety prompt');
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
});
