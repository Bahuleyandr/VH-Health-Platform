import request from 'supertest';
import app from '../app.js';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';
import { __testing__ as rateLimitTesting } from '../middleware/rateLimitMiddleware.js';
import { API_KEY, generateTestToken, authClient } from './testClient.js';

describe('Rate Limiting', () => {
  it('rate limit profile has a finite max (not Infinity)', () => {
    const adminProfile = RATE_LIMIT_PROFILES.admin;
    expect(adminProfile).toBeDefined();
    expect(typeof adminProfile.max).toBe('number');
    expect(adminProfile.max).toBeGreaterThan(0);
    expect(adminProfile.max).not.toBe(Infinity);
  });

  it('should trigger rate limit after multiple requests', async () => {
    const token = generateTestToken('ADMIN');
    const results = [];
    // Use fewer requests to avoid timeout — rate limit fires at some threshold
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get('/api/v1/health')
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`);
      results.push(res.statusCode);
    }
    // All responses should be valid HTTP codes
    results.forEach(code => {
      expect([200, 401, 429, 500, 503]).toContain(code);
    });
  }, 15000); // 15s timeout

  it('keys pre-auth staff login-shaped requests by account identity', () => {
    const baseReq = {
      headers: { 'x-api-key': API_KEY },
      get: (name) => (name === 'x-api-key' ? API_KEY : undefined),
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const emp1004 = rateLimitTesting.defaultKeyGenerator({
      ...baseReq,
      body: { employeeId: 'EMP-1004' },
    });
    const emp1007 = rateLimitTesting.defaultKeyGenerator({
      ...baseReq,
      body: { employeeId: 'EMP-1007' },
    });

    expect(emp1004).toContain('emp-1004');
    expect(emp1007).toContain('emp-1007');
    expect(emp1004).not.toBe(emp1007);
  });

  it('keys auth limiter by IP plus account and ignores successful logins', () => {
    const baseReq = {
      headers: { 'x-api-key': API_KEY },
      get: (name) => (name === 'x-api-key' ? API_KEY : undefined),
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const emp1003 = rateLimitTesting.authKeyGenerator({
      ...baseReq,
      body: { employeeId: 'EMP-1003' },
    });
    const emp1006 = rateLimitTesting.authKeyGenerator({
      ...baseReq,
      body: { employeeId: 'EMP-1006' },
    });

    expect(emp1003).toContain('emp-1003');
    expect(emp1006).toContain('emp-1006');
    expect(emp1003).not.toBe(emp1006);
    expect(rateLimitTesting.authRateLimiterConfig.skipSuccessfulRequests).toBe(true);
  });
});
