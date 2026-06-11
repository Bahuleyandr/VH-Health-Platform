import {
  hasValidMonitoringToken,
  isProductionRuntime,
} from '../../middleware/infrastructureAccessMiddleware.js';

describe('infrastructure access middleware', () => {
  it('detects production mode only from NODE_ENV=production', () => {
    expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'Production' })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'test' })).toBe(false);
  });

  it('accepts only configured monitoring tokens from explicit headers', () => {
    const env = { MONITORING_TOKEN: 'alpha,beta' };
    const req = { get: (header) => (header === 'x-monitoring-token' ? 'beta' : null) };

    expect(hasValidMonitoringToken(req, env)).toBe(true);
  });

  it('fails closed when production monitoring tokens are not configured', () => {
    const req = { get: () => 'supplied-token' };

    expect(hasValidMonitoringToken(req, {})).toBe(false);
  });
});
