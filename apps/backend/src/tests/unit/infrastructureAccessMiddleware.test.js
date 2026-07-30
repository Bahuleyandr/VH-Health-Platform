import { jest } from '@jest/globals';

import {
  hasValidMonitoringToken,
  hasValidDowntimeToken,
  isProductionRuntime,
  requireDowntimeAccess,
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

  it('accepts only a configured dedicated downtime token', () => {
    const req = { get: (header) => (header === 'x-downtime-token' ? 'ward-only' : null) };

    expect(hasValidDowntimeToken(req, { DOWNTIME_ACCESS_TOKEN: 'ward-only' })).toBe(true);
    expect(hasValidDowntimeToken(req, { MONITORING_TOKEN: 'ward-only' })).toBe(false);
    expect(hasValidDowntimeToken(req, {})).toBe(false);
  });

  // W3-H4 — a Prometheus ServiceMonitor can only send standard auth headers, so
  // the same monitoring token must be accepted via Authorization: Bearer.
  it('accepts the monitoring token via Authorization: Bearer (ServiceMonitor scrape)', () => {
    const env = { MONITORING_TOKEN: 'alpha,beta' };
    const req = { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer beta' : null) };

    expect(hasValidMonitoringToken(req, env)).toBe(true);
  });

  it('rejects a Bearer token that is not in the configured set', () => {
    const env = { MONITORING_TOKEN: 'alpha' };
    const req = { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer wrong' : null) };

    expect(hasValidMonitoringToken(req, env)).toBe(false);
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

  describe('requireDowntimeAccess gate', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it('keeps the route dark when only a monitoring token is configured', () => {
      process.env.MONITORING_TOKEN = 'monitoring-only';
      delete process.env.DOWNTIME_ACCESS_TOKEN;
      delete process.env.DOWNTIME_PACK_TOKEN;
      const req = {
        get: (header) => (header === 'x-monitoring-token' ? 'monitoring-only' : null),
        method: 'GET',
        originalUrl: '/downtime/static',
      };
      const res = mockRes();
      const next = jest.fn();

      requireDowntimeAccess(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('DOWNTIME_AUTH_REQUIRED');
    });

    it('allows the dedicated token over the existing monitoring header transport', () => {
      process.env.DOWNTIME_ACCESS_TOKEN = 'ward-only';
      const req = {
        get: (header) => (header === 'x-monitoring-token' ? 'ward-only' : null),
        method: 'GET',
        originalUrl: '/downtime/static',
      };
      const res = mockRes();
      const next = jest.fn();

      requireDowntimeAccess(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
    });
  });
});
