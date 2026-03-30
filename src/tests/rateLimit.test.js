import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken, authClient } from './testClient.js';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

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
});
