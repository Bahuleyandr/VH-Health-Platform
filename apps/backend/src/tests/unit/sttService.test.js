import { jest } from '@jest/globals';
import { transcribe, describeSttConfig } from '../../services/ai/sttService.js';

const ORIGINAL_ENV = { ...process.env };

function resetSttEnv() {
  for (const key of [
    'AZURE_SPEECH_KEY',
    'CLINICAL_AI_EXTERNAL_REGIONS',
    'CLINICAL_AI_STT_BASE_URL',
    'CLINICAL_AI_STT_ALLOWED_REGIONS',
    'CLINICAL_AI_STT_API_KEY',
    'CLINICAL_AI_STT_MODEL',
    'CLINICAL_AI_STT_PROVIDER',
    'CLINICAL_AI_STT_REGIONS',
    'CLINICAL_AI_STT_TIMEOUT_MS',
    'OPENAI_API_KEY',
    'STT_API_KEY',
    'STT_BASE_URL',
    'STT_LANGUAGE',
    'STT_MODEL',
    'STT_PROMPT',
    'STT_PROVIDER',
    'STT_TIMEOUT_MS',
  ]) {
    delete process.env[key];
  }
}

describe('speech-to-text region guardrails', () => {
  beforeEach(() => {
    resetSttEnv();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    delete global.fetch;
  });

  it('blocks external STT when the tenant region is unknown and an allowlist is configured', async () => {
    process.env.CLINICAL_AI_STT_PROVIDER = 'openai';
    process.env.CLINICAL_AI_STT_ALLOWED_REGIONS = 'IN';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const config = describeSttConfig();
    expect(config).toMatchObject({
      provider: 'openai',
      configured: false,
      reason: 'tenant_region_not_allowed_for_stt',
      external_call: true,
      allowed_regions: ['IN'],
    });

    const result = await transcribe({
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/wav',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      provider: 'openai',
      reason: 'tenant_region_not_allowed_for_stt',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls an OpenAI-compatible transcription endpoint with STT env configuration', async () => {
    process.env.STT_PROVIDER = 'openai-compatible';
    process.env.STT_BASE_URL = 'http://127.0.0.1:8080/';
    process.env.STT_MODEL = 'faster-whisper-large-v3';
    process.env.STT_API_KEY = 'local-test-key';
    process.env.STT_LANGUAGE = 'en-IN';
    process.env.STT_PROMPT = 'Indian hospital medication and SOAP vocabulary';
    process.env.STT_TIMEOUT_MS = '90000';
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'patient has fever and cough', language: 'en-IN' }),
    });

    const config = describeSttConfig({ tenantRegion: 'IN' });
    expect(config).toMatchObject({
      provider: 'openai-compatible',
      model: 'faster-whisper-large-v3',
      configured: true,
      reason: null,
      endpoint_configured: true,
      api_key_configured: true,
      timeout_ms: 90000,
      default_language: 'en-IN',
      prompt_configured: true,
    });

    const result = await transcribe({
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/wav',
      tenantRegion: 'IN',
    });

    expect(result).toMatchObject({
      status: 'completed',
      provider: 'openai-compatible',
      model: 'faster-whisper-large-v3',
      language: 'en-IN',
      text: 'patient has fever and cough',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/v1/audio/transcriptions');
    expect(options.headers).toEqual({ Authorization: 'Bearer local-test-key' });
    expect(options.body.get('model')).toBe('faster-whisper-large-v3');
    expect(options.body.get('language')).toBe('en-IN');
    expect(options.body.get('prompt')).toBe('Indian hospital medication and SOAP vocabulary');
  });

  it('reports OpenAI-compatible STT as unconfigured until endpoint and model are set', async () => {
    process.env.STT_PROVIDER = 'openai-compatible';

    expect(describeSttConfig({ tenantRegion: 'IN' })).toMatchObject({
      provider: 'openai-compatible',
      configured: false,
      reason: 'stt_endpoint_not_configured',
      endpoint_configured: false,
    });

    process.env.STT_BASE_URL = 'http://127.0.0.1:8080';
    expect(describeSttConfig({ tenantRegion: 'IN' })).toMatchObject({
      provider: 'openai-compatible',
      configured: false,
      reason: 'stt_model_not_configured',
      endpoint_configured: true,
    });

    const result = await transcribe({
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/wav',
      tenantRegion: 'IN',
    });
    expect(result).toMatchObject({
      status: 'blocked',
      provider: 'openai-compatible',
      reason: 'stt_model_not_configured',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
