import request from 'supertest';
import app from '../app.js';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';
import { __testing__ as rateLimitTesting } from '../middleware/rateLimitMiddleware.js';
import { API_KEY, generateTestToken } from './testClient.js';

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

  it('gives authenticated client readiness a dedicated enforced health profile', () => {
    const profile = RATE_LIMIT_PROFILES.clientReadiness;
    expect(profile).toMatchObject({
      windowMs: 60 * 1000,
      max: 30,
      enforceOnHealthRoutes: true,
      enforceInTest: true,
    });
    expect(profile.message).toContain('readiness');
  });

  it('keeps the liveness endpoint healthy across a short request burst', async () => {
    const token = generateTestToken('ADMIN');
    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get('/api/v1/health')
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`);
      results.push(res.statusCode);
    }
    expect(results).toEqual([200, 200, 200, 200, 200]);
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

    // The account identifier is now HASHED into the key. A rate-limit key is
    // persisted in Redis and shows up in ops tooling, so it must not carry a
    // raw employee id / email / phone. Assert the properties that actually
    // matter rather than the hash function itself, so this stays true if the
    // digest is ever changed: structure, no plaintext, one bucket per account,
    // and the case-folding that keeps 'emp-1004' and 'EMP-1004' in one bucket.
    const empMixedCase = rateLimitTesting.defaultKeyGenerator({
      ...baseReq,
      body: { employeeId: 'emp-1004' },
    });

    expect(emp1004).toMatch(/^acct:127\.0\.0\.1:[0-9a-f]{64}$/);
    expect(emp1007).toMatch(/^acct:127\.0\.0\.1:[0-9a-f]{64}$/);
    expect(emp1004.toLowerCase()).not.toContain('emp-1004');
    expect(emp1007.toLowerCase()).not.toContain('emp-1007');
    expect(emp1004).not.toBe(emp1007);
    expect(empMixedCase).toBe(emp1004);
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
    // Same hardening as above: the shared API key is hashed into the bucket, so
    // a Redis key dump never leaks a live credential. One key still means one
    // bucket, which is what the fallback is for.
    expect(apiKeyOnly).toMatch(/^k:[0-9a-f]{64}$/);
    expect(apiKeyOnly).not.toContain(API_KEY);
    expect(rateLimitTesting.defaultKeyGenerator(baseReq)).toBe(apiKeyOnly);
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

    // Same hardening; the auth limiter additionally tags the hashed segment
    // `acct:` so an account bucket can never collide with the `challenge:`
    // bucket the MFA test below covers.
    expect(emp1003).toMatch(/^auth:127\.0\.0\.1:acct:[0-9a-f]{64}$/);
    expect(emp1006).toMatch(/^auth:127\.0\.0\.1:acct:[0-9a-f]{64}$/);
    expect(emp1003.toLowerCase()).not.toContain('emp-1003');
    expect(emp1006.toLowerCase()).not.toContain('emp-1006');
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
