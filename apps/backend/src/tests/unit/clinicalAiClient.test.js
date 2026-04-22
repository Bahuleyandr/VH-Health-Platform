import { jest } from '@jest/globals';

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { generateClinicalText, getClinicalAiConfig } = await import('../../services/ai/localLlmClient.js');

const ORIGINAL_ENV = { ...process.env };
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
  'CLINICAL_AI_MAX_TOKENS',
  'CLINICAL_AI_MODEL',
  'CLINICAL_AI_PROVIDER',
  'CLINICAL_AI_TEMPERATURE',
  'CLINICAL_AI_TIMEOUT_MS',
  'OPENAI_API_KEY',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
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
    expect(result.reason).toMatch(/ALLOW_EXTERNAL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls OpenAI chat completions when external use is allowed', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'openai';
    process.env.CLINICAL_AI_MODEL = 'gpt-test-model';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    global.fetch.mockResolvedValue(okJson({
      choices: [{ message: { content: 'OpenAI draft' } }],
    }));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'discharge_summary',
    });

    expect(result).toMatchObject({ usedAi: true, provider: 'openai', text: 'OpenAI draft' });
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

  it('calls Anthropic Messages API when external use is allowed', async () => {
    process.env.CLINICAL_AI_PROVIDER = 'anthropic';
    process.env.CLINICAL_AI_MODEL = 'claude-test-model';
    process.env.CLINICAL_AI_ALLOW_EXTERNAL = 'true';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    global.fetch.mockResolvedValue(okJson({
      content: [{ type: 'text', text: 'Anthropic draft' }],
    }));

    const result = await generateClinicalText({
      systemPrompt: 'System safety prompt',
      userPrompt: 'Patient context',
      taskType: 'handover',
    });

    expect(result).toMatchObject({ usedAi: true, provider: 'anthropic', text: 'Anthropic draft' });
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
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.any(String) }),
      })
    );
  });
});
