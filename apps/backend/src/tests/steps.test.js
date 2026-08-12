import testClient, { AUTH_TOKEN, API_KEY, generateTestToken, authClient } from './testClient.js';
import prisma from '../lib/prisma.js';

const HEALTH_SYNC_TEST_UID = '550e8400-e29b-41d4-a716-446655440000';
const HEALTH_SYNC_TEST_DAY = '2001-03-04';
const HEALTH_SYNC_FUTURE_SAMPLE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const HEALTH_SYNC_FUTURE_DAY = HEALTH_SYNC_FUTURE_SAMPLE.toISOString().split('T')[0];

async function clearHealthSyncFreshnessFixture() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM step_sessions
      WHERE user_uid = $1::uuid
        AND source = 'oura'`,
    HEALTH_SYNC_TEST_UID,
  );
}

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
    afterEach(clearHealthSyncFreshnessFixture);

    it('should reject missing daily summaries', async () => {
      const res = await testClient()
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ source: 'health_connect' });
      expect(res.statusCode).toBe(400);
    });

    it('does not let an older concurrent summary overwrite a fresher day', async () => {
      await clearHealthSyncFreshnessFixture();
      const client = testClient();
      const newer = await client
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          source: 'oura',
          days: [{
            date: HEALTH_SYNC_TEST_DAY,
            steps: 1200,
            lastSampleAt: '2001-03-04T23:00:00.000Z',
          }],
        });
      expect(newer.statusCode).toBe(200);

      const stale = await client
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          source: 'oura',
          days: [{
            date: HEALTH_SYNC_TEST_DAY,
            steps: 100,
            lastSampleAt: '2001-03-04T12:00:00.000Z',
          }],
        });
      expect(stale.statusCode).toBe(200);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT steps, recorded_at_source
           FROM step_sessions
          WHERE user_uid = $1::uuid
            AND source = 'oura'
            AND source_day = $2::date`,
        HEALTH_SYNC_TEST_UID,
        HEALTH_SYNC_TEST_DAY,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ steps: 1200 });
      expect(rows[0].recorded_at_source.toISOString()).toBe(
        '2001-03-04T23:00:00.000Z',
      );
    });

    it('accepts an exact equal-timestamp retry', async () => {
      await clearHealthSyncFreshnessFixture();
      const payload = {
        source: 'oura',
        sourceApp: 'Oura',
        sourceDevice: 'ring-1',
        days: [{
          date: HEALTH_SYNC_TEST_DAY,
          steps: 1200,
          distanceMeters: 900,
          sleepMinutes: 480,
          activeEnergyKcal: 300,
          lastSampleAt: '2001-03-04T23:00:00.000Z',
        }],
      };
      const client = testClient();
      const initial = await client
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send(payload);
      const replay = await client
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send(payload);

      expect(initial.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(replay.body.data.syncedDays).toBe(1);
    });

    it('does not let a conflicting equal-timestamp payload replace the stored summary', async () => {
      await clearHealthSyncFreshnessFixture();
      const client = testClient();
      const initial = await client
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          source: 'oura',
          sourceApp: 'Oura',
          sourceDevice: 'ring-1',
          days: [{
            date: HEALTH_SYNC_TEST_DAY,
            steps: 1200,
            distanceMeters: 900,
            sleepMinutes: 480,
            activeEnergyKcal: 300,
            lastSampleAt: '2001-03-04T23:00:00.000Z',
          }],
        });
      const conflict = await client
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          source: 'oura',
          sourceApp: 'Oura',
          sourceDevice: 'ring-1',
          days: [{
            date: HEALTH_SYNC_TEST_DAY,
            steps: 100,
            distanceMeters: 75,
            sleepMinutes: 60,
            activeEnergyKcal: 30,
            lastSampleAt: '2001-03-04T23:00:00.000Z',
          }],
        });

      expect(initial.statusCode).toBe(200);
      expect(conflict.statusCode).toBe(200);
      expect(conflict.body.data.syncedDays).toBe(0);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT steps, distance_meters, sleep_minutes,
                active_energy_kcal::float AS active_energy_kcal,
                source_device, source_app, recorded_at_source
           FROM step_sessions
          WHERE user_uid = $1::uuid
            AND source = 'oura'
            AND source_day = $2::date`,
        HEALTH_SYNC_TEST_UID,
        HEALTH_SYNC_TEST_DAY,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        steps: 1200,
        distance_meters: 900,
        sleep_minutes: 480,
        active_energy_kcal: 300,
        source_device: 'ring-1',
        source_app: 'Oura',
      });
      expect(rows[0].recorded_at_source.toISOString()).toBe(
        '2001-03-04T23:00:00.000Z',
      );
    });

    it.each([
      ['missing', '2001-03-05', undefined],
      ['invalid', '2001-03-05', 'not-a-timestamp'],
      ['timezone-less', '2001-03-05', '2001-03-04T20:00:00.000'],
      ['next-day afternoon', '2001-03-05', '2001-03-06T14:00:00.000Z'],
      ['outside the source day window', '2001-03-05', '2001-03-08T20:00:00.000Z'],
      ['future', HEALTH_SYNC_FUTURE_DAY, HEALTH_SYNC_FUTURE_SAMPLE.toISOString()],
    ])('rejects %s lastSampleAt before writing any activity day', async (_label, date, lastSampleAt) => {
      await clearHealthSyncFreshnessFixture();
      const days = [
        {
          date: HEALTH_SYNC_TEST_DAY,
          steps: 1200,
          lastSampleAt: '2001-03-04T23:00:00.000Z',
        },
        {
          date,
          steps: 100,
          ...(lastSampleAt === undefined ? {} : { lastSampleAt }),
        },
      ];
      const res = await testClient()
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ source: 'oura', days });

      expect(res.statusCode).toBe(400);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT source_day
           FROM step_sessions
          WHERE user_uid = $1::uuid
            AND source = 'oura'`,
        HEALTH_SYNC_TEST_UID,
      );
      expect(rows).toHaveLength(0);
    });

    it.each(['not-a-date', '2001-02-30'])(
      'rejects invalid source day %s before writing any activity day',
      async invalidDate => {
        await clearHealthSyncFreshnessFixture();
        const res = await testClient()
          .post('/api/v1/steps/health-sync')
          .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
          .send({
            source: 'oura',
            days: [
              {
                date: HEALTH_SYNC_TEST_DAY,
                steps: 1200,
                lastSampleAt: '2001-03-04T23:00:00.000Z',
              },
              {
                date: invalidDate,
                steps: 100,
                lastSampleAt: '2001-03-02T01:00:00.000Z',
              },
            ],
          });

        expect(res.statusCode).toBe(400);
        const rows = await prisma.$queryRawUnsafe(
          `SELECT source_day
             FROM step_sessions
            WHERE user_uid = $1::uuid
              AND source = 'oura'`,
          HEALTH_SYNC_TEST_UID,
        );
        expect(rows).toHaveLength(0);
      },
    );

    it('accepts a next-day sample timestamp for activity intervals that cross midnight', async () => {
      await clearHealthSyncFreshnessFixture();
      const res = await testClient()
        .post('/api/v1/steps/health-sync')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          source: 'oura',
          days: [{
            date: HEALTH_SYNC_TEST_DAY,
            sleepMinutes: 480,
            lastSampleAt: '2001-03-05T05:59:00.000Z',
          }],
        });

      expect(res.statusCode).toBe(200);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT source_day, sleep_minutes, recorded_at_source
           FROM step_sessions
          WHERE user_uid = $1::uuid
            AND source = 'oura'`,
        HEALTH_SYNC_TEST_UID,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].source_day.toISOString().split('T')[0]).toBe(HEALTH_SYNC_TEST_DAY);
      expect(rows[0].sleep_minutes).toBe(480);
      expect(rows[0].recorded_at_source.toISOString()).toBe('2001-03-05T05:59:00.000Z');
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
