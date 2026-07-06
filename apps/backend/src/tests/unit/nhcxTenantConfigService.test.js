import {
  NHCX_SECRET_KINDS,
  normalizeNHCXConfig,
} from '../../services/nhcx/nhcxTenantConfigService.js';

describe('nhcxTenantConfigService', () => {
  it('normalizes tenant NHCX config without secret material', () => {
    const config = normalizeNHCXConfig({
      enabled: 'true',
      environment: 'sandbox',
      participant_code: 'VH-NHCX-001',
      counterparty_participant_code: 'PAYER-001',
      sandbox_gateway_base_url: 'http://127.0.0.1:4891/',
      production_gateway_base_url: 'https://hcx.example.test/v0.9',
      secret: 'must-not-be-carried',
    });

    expect(config).toEqual({
      enabled: true,
      environment: 'sandbox',
      participantCode: 'VH-NHCX-001',
      counterpartyParticipantCode: 'PAYER-001',
      gatewayBaseUrls: {
        sandbox: 'http://127.0.0.1:4891',
        production: 'https://hcx.example.test/v0.9',
      },
    });
    expect(JSON.stringify(config)).not.toContain('must-not-be-carried');
  });

  it('exposes the three tenant interop secret kinds NHCX uses', () => {
    expect(Object.values(NHCX_SECRET_KINDS)).toEqual([
      'nhcx_api_token',
      'nhcx_jwe_private_key',
      'nhcx_callback_secret',
    ]);
  });

  it('rejects invalid gateway URL protocols', () => {
    expect(() => normalizeNHCXConfig({
      gatewayBaseUrls: { sandbox: 'file:///tmp/key' },
    })).toThrow(/HTTP\(S\) URL/);
  });
});
