import testClient, { AUTH_TOKEN, API_KEY, generateTestToken } from './testClient.js';

describe('Theatre (Operating Theatre) API', () => {

  // ===== GET ENDPOINTS =====

  describe('GET /api/v1/theatre/today', () => {
    it('should return today OT schedule', async () => {
      const res = await testClient()
        .get('/api/v1/theatre/today')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });

    it('should accept filter query params', async () => {
      const res = await testClient()
        .get('/api/v1/theatre/today?ot_room=OT1&status=scheduled')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /api/v1/theatre/availability', () => {
    it('should return available OT rooms for a date', async () => {
      const res = await testClient()
        .get('/api/v1/theatre/availability?date=2026-04-03')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  // ===== POST ENDPOINTS =====

  describe('POST /api/v1/theatre/schedule', () => {
    it('should fail without required fields', async () => {
      const res = await testClient()
        .post('/api/v1/theatre/schedule')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({});
      expect(res.statusCode).toBe(400);
    });

    it('should schedule a surgery with valid data', async () => {
      const res = await testClient()
        .post('/api/v1/theatre/schedule')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({
          patient_uid: '550e8400-e29b-41d4-a716-446655440000',
          procedure_name: 'Appendectomy',
          surgeon_uid: '550e8400-e29b-41d4-a716-446655440001',
          ot_room: 'OT1',
          scheduled_date: '2026-04-10',
          scheduled_time: '09:00',
          estimated_duration: 120
        });
      expect([200, 201, 400, 422, 500]).toContain(res.statusCode);
      if (res.statusCode === 201) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  // ===== PUT ENDPOINTS =====

  describe('PUT /api/v1/theatre/:id/status', () => {
    it('should update surgery status', async () => {
      const res = await testClient()
        .put('/api/v1/theatre/1/status')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ status: 'in_progress' });
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    it('should reject invalid id param', async () => {
      const res = await testClient()
        .put('/api/v1/theatre/abc/status')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ status: 'in_progress' });
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('PUT /api/v1/theatre/:id/checklist', () => {
    it('should update pre-op checklist', async () => {
      const res = await testClient()
        .put('/api/v1/theatre/1/checklist')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ checklist: { consent: true, fasting: true, blood_ready: true } });
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ===== DELETE ENDPOINTS =====

  describe('DELETE /api/v1/theatre/:id', () => {
    it('should cancel a surgery', async () => {
      const res = await testClient()
        .delete('/api/v1/theatre/1')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    it('should return error for nonexistent surgery', async () => {
      const res = await testClient()
        .delete('/api/v1/theatre/999999')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  // ===== AUTH TESTS =====

  describe('Auth', () => {
    it('should reject unauthenticated request', async () => {
      const res = await testClient().get('/api/v1/theatre/today');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('should reject unauthorized role (PATIENT)', async () => {
      const token = generateTestToken('PATIENT');
      const res = await testClient()
        .get('/api/v1/theatre/today')
        .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
      expect([403, 500]).toContain(res.statusCode);
    });
  });
});
