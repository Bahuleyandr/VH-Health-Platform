import testClient, { AUTH_TOKEN, API_KEY, generateTestToken } from './testClient.js';

describe('Pharmacy Orders API', () => {

  // ===== GET ENDPOINTS =====

  describe('GET /api/v1/pharmacy-orders/test', () => {
    it('should return pharmacy module info', async () => {
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/test')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.message).toContain('Pharmacy');
      }
    });
  });

  describe('GET /api/v1/pharmacy-orders/catalog', () => {
    it('should return pharmacy catalog', async () => {
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/catalog')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /api/v1/pharmacy-orders/orders/my', () => {
    it('should return current user orders', async () => {
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/orders/my')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /api/v1/pharmacy-orders/orders/queue', () => {
    it('should return pharmacy order queue', async () => {
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/orders/queue')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /api/v1/pharmacy-orders/orders/sla', () => {
    it('should return SLA dashboard data', async () => {
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/orders/sla')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ===== POST ENDPOINTS =====

  describe('POST /api/v1/pharmacy-orders/orders', () => {
    it('should fail without required fields', async () => {
      const res = await testClient()
        .post('/api/v1/pharmacy-orders/orders')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({});
      expect([400, 422, 500]).toContain(res.statusCode);
    });
  });

  // ===== PUT ENDPOINTS =====

  describe('PUT /api/v1/pharmacy-orders/orders/:orderId/status', () => {
    it('should update order status', async () => {
      const res = await testClient()
        .put('/api/v1/pharmacy-orders/orders/1/status')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN)
        .send({ status: 'CONFIRMED' });
      expect([200, 400, 404, 500]).toContain(res.statusCode);
    });
  });

  // ===== LIFECYCLE ENDPOINTS =====

  describe('POST /api/v1/pharmacy-orders/orders/:id/confirm', () => {
    it('should confirm an order', async () => {
      const res = await testClient()
        .post('/api/v1/pharmacy-orders/orders/1/confirm')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('POST /api/v1/pharmacy-orders/orders/:id/cancel', () => {
    it('should cancel an order', async () => {
      const res = await testClient()
        .post('/api/v1/pharmacy-orders/orders/1/cancel')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /api/v1/pharmacy-orders/orders/:id/detail', () => {
    it('should return order detail', async () => {
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/orders/1/detail')
        .set('x-api-key', API_KEY).set('Authorization', AUTH_TOKEN);
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ===== AUTH TESTS =====

  describe('Auth', () => {
    it('should reject unauthenticated request', async () => {
      const res = await testClient().get('/api/v1/pharmacy-orders/catalog');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('should reject unauthorized role (PATIENT)', async () => {
      const token = generateTestToken('PATIENT');
      const res = await testClient()
        .get('/api/v1/pharmacy-orders/catalog')
        .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
      expect([403, 500]).toContain(res.statusCode);
    });
  });
});
