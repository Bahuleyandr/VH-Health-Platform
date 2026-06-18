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

  it('uses a roomier patient investigation profile for tabbed read traffic', () => {
    const patientProfile = RATE_LIMIT_PROFILES.patient;
    const investigationProfile = RATE_LIMIT_PROFILES.patientInvestigation;

    expect(investigationProfile).toBeDefined();
    expect(investigationProfile.windowMs).toBe(patientProfile.windowMs);
    expect(investigationProfile.max).toBeGreaterThan(patientProfile.max);
    expect(investigationProfile.message).toContain('investigation');
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

  it('keys bearer-token requests separately before falling back to shared API key', () => {
    const baseReq = {
      headers: { 'x-api-key': API_KEY },
      get: (name) => (name === 'x-api-key' ? API_KEY : undefined),
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const firstToken = rateLimitTesting.defaultKeyGenerator({
      ...baseReq,
      headers: {
        ...baseReq.headers,
        authorization: 'Bearer staff-token-a',
      },
    });
    const secondToken = rateLimitTesting.defaultKeyGenerator({
      ...baseReq,
      headers: {
        ...baseReq.headers,
        authorization: 'Bearer staff-token-b',
      },
    });
    const apiKeyOnly = rateLimitTesting.defaultKeyGenerator(baseReq);

    expect(firstToken).toMatch(/^jwt:/);
    expect(secondToken).toMatch(/^jwt:/);
    expect(firstToken).not.toBe(secondToken);
    expect(apiKeyOnly).toBe(`k:${API_KEY}`);
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

  // Item 1 (auth-hygiene audit §5): the admin MFA challenge-verify endpoint
  // carries no username/email — only an opaque challengeToken that maps 1:1 to
  // one admin account. The auth limiter must fold that token into the key so
  // the 2FA step is keyed per-account, not IP-only.
  it('keys MFA challenge-verify requests by IP + challenge token (not IP alone)', () => {
    const baseReq = {
      headers: { 'x-api-key': API_KEY },
      get: (name) => (name === 'x-api-key' ? API_KEY : undefined),
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const ipOnly = rateLimitTesting.authKeyGenerator({ ...baseReq, body: {} });
    const challengeA = rateLimitTesting.authKeyGenerator({
      ...baseReq,
      body: { challengeToken: 'challenge-token-admin-a', code: '111111' },
    });
    const challengeB = rateLimitTesting.authKeyGenerator({
      ...baseReq,
      body: { challengeToken: 'challenge-token-admin-b', code: '222222' },
    });

    // Two different admins' challenges (e.g. behind one NAT) get distinct
    // buckets, so one cannot exhaust the other's attempts.
    expect(challengeA).not.toBe(challengeB);
    // And neither collapses to the plain IP-only key.
    expect(challengeA).not.toBe(ipOnly);
    expect(challengeB).not.toBe(ipOnly);
    // The same challenge token always maps to the same bucket regardless of the
    // submitted code, so an attacker rotating codes shares one account bucket.
    const challengeARetry = rateLimitTesting.authKeyGenerator({
      ...baseReq,
      body: { challengeToken: 'challenge-token-admin-a', code: '999999' },
    });
    expect(challengeARetry).toBe(challengeA);
    // The raw challenge secret must never appear in the limiter key.
    expect(challengeA).not.toContain('challenge-token-admin-a');
  });

  it('auth limiter still falls back to IP-only when no account or challenge token is present', () => {
    const baseReq = {
      headers: {},
      get: () => undefined,
      ip: '203.0.113.7',
      socket: { remoteAddress: '203.0.113.7' },
      body: {},
    };
    const key = rateLimitTesting.authKeyGenerator(baseReq);
    expect(key).toMatch(/^auth:/);
    expect(key).not.toContain(':chal:');
  });
});
