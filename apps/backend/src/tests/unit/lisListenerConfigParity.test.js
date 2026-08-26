import {
  lisListenerConfigSummaryFromEnv,
  validateLisListenerProfile as validateBackendProfile,
} from '../../services/integrations/lisListenerConfig.js';
import {
  validateLisListenerProfile as validateGatewayProfile,
} from '../../../../device-gateway/src/lisTransport.js';

const valid = {
  name: 'chem-1',
  port: 4001,
  protocol: 'astm-e1394',
  tenant_slug: 'vh-main',
  analyzer_code: 'BS-240',
  token_env: 'LIS_CHEM1_TOKEN',
  allowed_source_ips: ['10.20.0.41'],
};

function accepts(validator, profile) {
  try {
    validator(profile);
    return true;
  } catch {
    return false;
  }
}

describe('LIS listener structural-validator parity', () => {
  it.each([
    ['valid profile', valid],
    ['valid optional fields', { ...valid, host: '127.0.0.1', max_message_bytes: 4096 }],
    ['not an object', null],
    ['unknown field', { ...valid, unexpected: true }],
    ['missing name', { ...valid, name: '' }],
    ['bad port', { ...valid, port: 70000 }],
    ['bad protocol', { ...valid, protocol: 'serial' }],
    ['missing tenant slug', { ...valid, tenant_slug: '' }],
    ['bad tenant slug', { ...valid, tenant_slug: 'vh main' }],
    ['missing analyzer code', { ...valid, analyzer_code: '' }],
    ['missing token env name', { ...valid, token_env: '' }],
    ['global gateway credential alias', { ...valid, token_env: 'DEVICE_GATEWAY_BACKEND_TOKEN' }],
    ['lowercase token env name', { ...valid, token_env: 'lis_chem1_token' }],
    ['digit-leading token identity', { ...valid, token_env: 'LIS_1CHEM_TOKEN' }],
  ])('%s has the same acceptance result', (_label, profile) => {
    expect(accepts(validateBackendProfile, profile))
      .toBe(accepts(validateGatewayProfile, profile));
  });

  it('rejects invalid JSON, non-arrays, invalid members, and duplicate names', () => {
    const env = value => ({ DEVICE_GATEWAY_LIS_LISTENERS: value });
    expect(lisListenerConfigSummaryFromEnv(env('not json'))).toMatchObject({
      count: 0, invalid: true,
    });
    expect(lisListenerConfigSummaryFromEnv(env('{}'))).toMatchObject({
      count: 0, invalid: true,
    });
    expect(lisListenerConfigSummaryFromEnv(env(JSON.stringify([{ name: 'anything' }]))))
      .toMatchObject({ count: 0, invalid: true });
    expect(lisListenerConfigSummaryFromEnv(env(JSON.stringify([
      { ...valid, token_env: 'DEVICE_GATEWAY_BACKEND_TOKEN' },
    ])))).toMatchObject({ count: 0, invalid: true });
    expect(lisListenerConfigSummaryFromEnv(env(JSON.stringify([valid, { ...valid, port: 4002 }]))))
      .toMatchObject({ count: 0, invalid: true });
  });

  it('returns normalized profiles internally while the public service emits only counts', () => {
    const summary = lisListenerConfigSummaryFromEnv({
      DEVICE_GATEWAY_LIS_LISTENERS: JSON.stringify([{ ...valid, tenant_slug: ' VH-MAIN ' }]),
    });
    expect(summary).toMatchObject({ count: 1, invalid: false });
    expect(summary.profiles[0]).toMatchObject({
      tenant_slug: 'vh-main', analyzer_code: 'BS-240', token_env: 'LIS_CHEM1_TOKEN',
    });
  });
});
