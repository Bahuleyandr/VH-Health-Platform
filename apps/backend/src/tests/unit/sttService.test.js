import { jest } from '@jest/globals';
import { transcribe, describeSttConfig } from '../../services/ai/sttService.js';

const ORIGINAL_ENV = { ...process.env };

function resetSttEnv() {
  for (const key of [
    'AZURE_SPEECH_KEY',
    'CLINICAL_AI_EXTERNAL_REGIONS',
    'CLINICAL_AI_STT_ALLOWED_REGIONS',
    'CLINICAL_AI_STT_API_KEY',
    'CLINICAL_AI_STT_MODEL',
    'CLINICAL_AI_STT_PROVIDER',
    'CLINICAL_AI_STT_REGIONS',
    'OPENAI_API_KEY',
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
});
