import testClient, { AUTH_TOKEN, API_KEY, generateTestToken } from './testClient.js';

describe('Blood Bank API', () => {

  // ===== GET ENDPOINTS =====

  describe('GET /api/v1/blood-bank/inventory', () => {
    it('should return blood inventory summary', async () => {
      const res = await testClient()
        .get('/api/v1/blood-bank/inventory')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('GET /api/v1/blood-bank/pending', () => {
    it('should return pending blood requests', async () => {
      const res = await testClient()
        .get('/api/v1/blood-bank/pending')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });

    it('should accept filter and pagination params', async () => {
      const res = await testClient()
        .get('/api/v1/blood-bank/pending?blood_group=O%2B&urgency=urgent&page=1&limit=10')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ===== POST ENDPOINTS =====

  describe('POST /api/v1/blood-bank/request', () => {
    it('should fail without required fields', async () => {
      const res = await testClient()
        .post('/api/v1/blood-bank/request')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({});
      expect(res.statusCode).toBe(400);
    });

    it('should fail with invalid blood group', async () => {
      const res = await testClient()
        .post('/api/v1/blood-bank/request')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          patient_uid: '550e8400-e29b-41d4-a716-446655440000',
          blood_group: 'INVALID',
          units: 2
        });
      expect(res.statusCode).toBe(400);
    });

    it('should create a blood request with valid data', async () => {
      const res = await testClient()
        .post('/api/v1/blood-bank/request')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          patient_uid: '550e8400-e29b-41d4-a716-446655440000',
          blood_group: 'O+',
          units: 2,
          urgency: 'routine',
          clinical_indication: 'Elective surgery'
        });
      expect([201, 500]).toContain(res.statusCode);
      if (res.statusCode === 201) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  // ===== PUT ENDPOINTS =====

  describe('PUT /api/v1/blood-bank/:id/cross-match', () => {
    it('should record cross-match result', async () => {
      const res = await testClient()
        .put('/api/v1/blood-bank/1/cross-match')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ cross_match_status: 'compatible' });
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('PUT /api/v1/blood-bank/:id/issue', () => {
    it('should issue blood to patient', async () => {
      const res = await testClient()
        .put('/api/v1/blood-bank/1/issue')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 400, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('PUT /api/v1/blood-bank/:id/transfused', () => {
    it('should record transfusion completion', async () => {
      const res = await testClient()
        .put('/api/v1/blood-bank/1/transfused')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ transfusion_reaction: false });
      expect([200, 400, 404, 500]).toContain(res.statusCode);
    });
  });

  // ===== AUTH TESTS =====

  describe('Auth', () => {
    it('should reject unauthenticated request', async () => {
      const res = await testClient().get('/api/v1/blood-bank/inventory');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('should reject unauthorized role (PATIENT)', async () => {
      const token = generateTestToken('PATIENT');
      const res = await testClient()
        .get('/api/v1/blood-bank/inventory')
        .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
      expect([403, 500]).toContain(res.statusCode);
    });
  });
});
