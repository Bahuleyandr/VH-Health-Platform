import {
  hasValidMonitoringToken,
  isProductionRuntime,
  requireProductionMonitoringAccess,
} from '../../middleware/infrastructureAccessMiddleware.js';

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

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

  describe('requireProductionMonitoringAccess gate', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it('fails closed (401) off-prod when no monitoring token is configured', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.MONITORING_TOKEN;
      delete process.env.METRICS_TOKEN;
      delete process.env.INTERNAL_MONITORING_TOKEN;

      const req = { get: () => null, headers: {}, method: 'GET', originalUrl: '/health/deep' };
      const res = mockRes();
      let nextCalled = false;

      requireProductionMonitoringAccess(req, res, () => { nextCalled = true; });

      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('MONITORING_AUTH_REQUIRED');
    });

    it('fails closed (401) off-prod when a wrong token is supplied', () => {
      process.env.NODE_ENV = 'test';
      process.env.MONITORING_TOKEN = 'correct-token';

      const req = { get: (h) => (h === 'x-monitoring-token' ? 'wrong-token' : null), method: 'GET', originalUrl: '/downtime/static' };
      const res = mockRes();
      let nextCalled = false;

      requireProductionMonitoringAccess(req, res, () => { nextCalled = true; });

      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('allows the request off-prod when the configured token is supplied', () => {
      process.env.NODE_ENV = 'development';
      process.env.MONITORING_TOKEN = 'correct-token';

      const req = { get: (h) => (h === 'x-monitoring-token' ? 'correct-token' : null), method: 'GET', originalUrl: '/health/deep' };
      const res = mockRes();
      let nextCalled = false;

      requireProductionMonitoringAccess(req, res, () => { nextCalled = true; });

      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBeNull();
    });
  });
});
