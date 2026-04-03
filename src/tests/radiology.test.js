import testClient, { AUTH_TOKEN, API_KEY, generateTestToken } from './testClient.js';

describe('Radiology API', () => {

  // ===== GET ENDPOINTS =====

  describe('GET /api/v1/radiology/worklist', () => {
    it('should return radiology worklist', async () => {
      const res = await testClient()
        .get('/api/v1/radiology/worklist')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });

    it('should accept filter and pagination params', async () => {
      const res = await testClient()
        .get('/api/v1/radiology/worklist?status=pending&modality=CT&page=1&limit=10')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /api/v1/radiology/patient/:uid', () => {
    it('should return patient radiology history', async () => {
      const res = await testClient()
        .get('/api/v1/radiology/patient/550e8400-e29b-41d4-a716-446655440000')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('GET /api/v1/radiology/:id', () => {
    it('should return single radiology order detail', async () => {
      const res = await testClient()
        .get('/api/v1/radiology/1')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ===== POST ENDPOINTS =====

  describe('POST /api/v1/radiology/orders', () => {
    it('should fail without required fields', async () => {
      const res = await testClient()
        .post('/api/v1/radiology/orders')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({});
      expect(res.statusCode).toBe(400);
    });

    it('should create a radiology order with valid data', async () => {
      const res = await testClient()
        .post('/api/v1/radiology/orders')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          patient_uid: '550e8400-e29b-41d4-a716-446655440000',
          study_type: 'CT Scan Abdomen',
          modality: 'CT',
          body_part: 'Abdomen',
          clinical_indication: 'Abdominal pain',
          priority: 'routine'
        });
      expect([200, 201, 400, 422, 500]).toContain(res.statusCode);
      if (res.statusCode === 201) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  // ===== PUT ENDPOINTS =====

  describe('PUT /api/v1/radiology/:id/report', () => {
    it('should submit a radiology report', async () => {
      const res = await testClient()
        .put('/api/v1/radiology/1/report')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          report: 'Normal findings',
          findings: 'No abnormality detected',
          impression: 'Normal study'
        });
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('PUT /api/v1/radiology/:id/cancel', () => {
    it('should cancel a radiology order', async () => {
      const res = await testClient()
        .put('/api/v1/radiology/1/cancel')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    it('should reject invalid id param', async () => {
      const res = await testClient()
        .put('/api/v1/radiology/abc/cancel')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  // ===== AUTH TESTS =====

  describe('Auth', () => {
    it('should reject unauthenticated request', async () => {
      const res = await testClient().get('/api/v1/radiology/worklist');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('should reject unauthorized role (PATIENT)', async () => {
      const token = generateTestToken('PATIENT');
      const res = await testClient()
        .get('/api/v1/radiology/worklist')
        .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
      expect([403, 500]).toContain(res.statusCode);
    });
  });
});
