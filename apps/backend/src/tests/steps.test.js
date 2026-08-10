import testClient, { AUTH_TOKEN, API_KEY, generateTestToken, authClient } from './testClient.js';

describe('Steps / Gamification API', () => {

  // ===== STEPS ROUTES (/api/v1/steps) =====

  describe('GET /api/v1/steps/leaderboard', () => {
    it('should return leaderboard data', async () => {
      const res = await testClient()
        .get('/api/v1/steps/leaderboard')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('GET /api/v1/steps/profile', () => {
    it('should return or auto-create step profile', async () => {
      const res = await testClient()
        .get('/api/v1/steps/profile')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('PUT /api/v1/steps/profile', () => {
    it('should update step profile', async () => {
      const res = await testClient()
        .put('/api/v1/steps/profile')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ displayName: 'TestUser', displayColor: '#FF5733', dailyGoal: 10000 });
      expect(res.statusCode).toBe(200);
    });

    it('should reject invalid displayColor', async () => {
      const res = await testClient()
        .put('/api/v1/steps/profile')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ displayColor: 'not-a-color' });
      expect(res.statusCode).toBe(400);
    });

    it('should reject dailyGoal out of range', async () => {
      const res = await testClient()
        .put('/api/v1/steps/profile')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ dailyGoal: 500 });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/steps/rewards', () => {
    it('should return user rewards', async () => {
      const res = await testClient()
        .get('/api/v1/steps/rewards')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/steps/history', () => {
    it('should return step history (daily/weekly/monthly)', async () => {
      const res = await testClient()
        .get('/api/v1/steps/history')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/steps/health-sync', () => {
    it('should reject missing daily summaries', async () => {
      const res = await testClient()
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ source: 'health_connect' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/steps/sync-status', () => {
    it('should return or safely fail the wearable sync status', async () => {
      const res = await testClient()
        .get('/api/v1/steps/sync-status')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/steps/session/start', () => {
    it('should start a walk session', async () => {
      const res = await testClient()
        .post('/api/v1/steps/session/start')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/steps/session/stop', () => {
    it('should fail without sessionId', async () => {
      const res = await testClient()
        .post('/api/v1/steps/session/stop')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({});
      expect(res.statusCode).toBe(400);
    });
  });

  // ===== REWARDS ROUTES (/api/v1/rewards) =====

  describe('GET /api/v1/rewards/badges', () => {
    it('should return user badges', async () => {
      const res = await testClient()
        .get('/api/v1/rewards/badges')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/rewards/badges/check', () => {
    it('should check and award eligible badges', async () => {
      const res = await testClient()
        .post('/api/v1/rewards/badges/check')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/rewards/vouchers', () => {
    it('should return user vouchers', async () => {
      const res = await testClient()
        .get('/api/v1/rewards/vouchers')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/rewards/leaderboard/monthly', () => {
    it('should return monthly leaderboard', async () => {
      const res = await testClient()
        .get('/api/v1/rewards/leaderboard/monthly')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/rewards/my-monthly-rank', () => {
    it('should return current user monthly rank', async () => {
      const res = await testClient()
        .get('/api/v1/rewards/my-monthly-rank')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/rewards/issue-monthly', () => {
    it('should reject non-admin user', async () => {
      const token = generateTestToken('PATIENT');
      const res = await testClient()
        .post('/api/v1/rewards/issue-monthly')
        .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
        .send({ month_year: '2026-03' });
      expect(res.statusCode).toBe(403);
    });

    it('should reject invalid month_year format', async () => {
      const res = await testClient()
        .post('/api/v1/rewards/issue-monthly')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ month_year: 'invalid' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ===== AUTH TESTS =====

  describe('Auth', () => {
    it('should reject unauthenticated request to steps', async () => {
      const res = await testClient().get('/api/v1/steps/leaderboard');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('should reject unauthenticated request to rewards', async () => {
      const res = await testClient().get('/api/v1/rewards/badges');
      expect([401, 403]).toContain(res.statusCode);
    });
  });
});
