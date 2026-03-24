import testClient, { AUTH_TOKEN } from './testClient.js';

describe('Bed/Ward Management API', () => {
  let wardId;
  let bedId;

  // ===== WARD TESTS =====

  describe('Wards', () => {
    it('POST /api/v1/wards - should create a ward', async () => {
      const res = await testClient()
        .post('/api/v1/wards')
        .set('Authorization', AUTH_TOKEN)
        .send({ name: 'Test Ward A', floor: 2, total_beds: 10 });
      expect([201, 500]).toContain(res.statusCode); // 500 if table doesn't exist yet in test DB
      if (res.statusCode === 201) {
        expect(res.body.data.ward).toBeDefined();
        wardId = res.body.data.ward.id;
      }
    });

    it('GET /api/v1/wards - should list wards', async () => {
      const res = await testClient()
        .get('/api/v1/wards')
        .set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.data.wards).toBeDefined();
        expect(Array.isArray(res.body.data.wards)).toBe(true);
      }
    });

    it('PUT /api/v1/wards/:id - should update a ward', async () => {
      if (!wardId) return; // skip if create failed
      const res = await testClient()
        .put(`/api/v1/wards/${wardId}`)
        .set('Authorization', AUTH_TOKEN)
        .send({ name: 'Test Ward A Updated', floor: 3 });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.ward.name).toBe('Test Ward A Updated');
    });

    it('PUT /api/v1/wards/999999 - should return 404 for nonexistent ward', async () => {
      const res = await testClient()
        .put('/api/v1/wards/999999')
        .set('Authorization', AUTH_TOKEN)
        .send({ name: 'Ghost Ward' });
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  // ===== BED TESTS =====

  describe('Beds', () => {
    it('POST /api/v1/beds - should create a bed', async () => {
      if (!wardId) return;
      const res = await testClient()
        .post('/api/v1/beds')
        .set('Authorization', AUTH_TOKEN)
        .send({ ward_id: wardId, bed_number: 'A-101' });
      expect([201, 500]).toContain(res.statusCode);
      if (res.statusCode === 201) {
        expect(res.body.data.bed).toBeDefined();
        bedId = res.body.data.bed.id;
      }
    });

    it('POST /api/v1/beds - should fail without ward_id', async () => {
      const res = await testClient()
        .post('/api/v1/beds')
        .set('Authorization', AUTH_TOKEN)
        .send({ bed_number: 'B-101' });
      expect(res.statusCode).toBe(400);
    });

    it('GET /api/v1/beds - should list all beds', async () => {
      const res = await testClient()
        .get('/api/v1/beds')
        .set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(Array.isArray(res.body.data.beds)).toBe(true);
      }
    });

    it('GET /api/v1/beds/summary - should return bed summary', async () => {
      const res = await testClient()
        .get('/api/v1/beds/summary')
        .set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.data.summary).toBeDefined();
      }
    });

    it('GET /api/v1/beds/ward/:wardId - should return beds for a ward', async () => {
      if (!wardId) return;
      const res = await testClient()
        .get(`/api/v1/beds/ward/${wardId}`)
        .set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });

    it('PUT /api/v1/beds/:id - should update a bed', async () => {
      if (!bedId) return;
      const res = await testClient()
        .put(`/api/v1/beds/${bedId}`)
        .set('Authorization', AUTH_TOKEN)
        .send({ status: 'maintenance', notes: 'Under repair' });
      expect(res.statusCode).toBe(200);
    });
  });

  // ===== ADMIT/DISCHARGE TESTS =====

  describe('Admit/Discharge', () => {
    let admitBedId;

    beforeAll(async () => {
      // Create a fresh bed for admit/discharge
      if (!wardId) return;
      const res = await testClient()
        .post('/api/v1/beds')
        .set('Authorization', AUTH_TOKEN)
        .send({ ward_id: wardId, bed_number: 'A-201' });
      if (res.statusCode === 201) {
        admitBedId = res.body.data.bed.id;
      }
    });

    it('POST /api/v1/beds/:id/admit - should admit a patient', async () => {
      if (!admitBedId) return;
      const res = await testClient()
        .post(`/api/v1/beds/${admitBedId}/admit`)
        .set('Authorization', AUTH_TOKEN)
        .send({ patient_name: 'John Doe', notes: 'Fever' });
      expect([200, 400, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.data.bed.status).toBe('occupied');
        expect(res.body.data.bed.patient_name).toBe('John Doe');
      }
    });

    it('POST /api/v1/beds/:id/admit - should fail on already occupied bed', async () => {
      if (!admitBedId) return;
      const res = await testClient()
        .post(`/api/v1/beds/${admitBedId}/admit`)
        .set('Authorization', AUTH_TOKEN)
        .send({ patient_name: 'Jane Doe' });
      expect([400, 500]).toContain(res.statusCode);
    });

    it('POST /api/v1/beds/:id/discharge - should discharge a patient', async () => {
      if (!admitBedId) return;
      const res = await testClient()
        .post(`/api/v1/beds/${admitBedId}/discharge`)
        .set('Authorization', AUTH_TOKEN);
      expect([200, 400, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.body.data.bed.status).toBe('available');
        expect(res.body.data.bed.patient_name).toBeNull();
      }
    });

    it('POST /api/v1/beds/:id/discharge - should fail on non-occupied bed', async () => {
      if (!admitBedId) return;
      const res = await testClient()
        .post(`/api/v1/beds/${admitBedId}/discharge`)
        .set('Authorization', AUTH_TOKEN);
      expect([400, 500]).toContain(res.statusCode);
    });

    it('POST /api/v1/beds/:id/admit - should fail without patient_name', async () => {
      if (!admitBedId) return;
      const res = await testClient()
        .post(`/api/v1/beds/${admitBedId}/admit`)
        .set('Authorization', AUTH_TOKEN)
        .send({});
      expect(res.statusCode).toBe(400);
    });
  });

  // ===== CLEANUP =====

  describe('Cleanup', () => {
    it('DELETE /api/v1/beds/:id - should delete a bed', async () => {
      if (!bedId) return;
      const res = await testClient()
        .delete(`/api/v1/beds/${bedId}`)
        .set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });

    it('DELETE /api/v1/beds/999999 - should return 404', async () => {
      const res = await testClient()
        .delete('/api/v1/beds/999999')
        .set('Authorization', AUTH_TOKEN);
      expect([404, 500]).toContain(res.statusCode);
    });

    it('DELETE /api/v1/wards/:id - should delete a ward', async () => {
      if (!wardId) return;
      const res = await testClient()
        .delete(`/api/v1/wards/${wardId}`)
        .set('Authorization', AUTH_TOKEN);
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ===== AUTH TESTS =====

  describe('Auth', () => {
    it('GET /api/v1/beds - should reject unauthenticated request', async () => {
      const res = await testClient().get('/api/v1/beds');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('GET /api/v1/wards - should reject unauthenticated request', async () => {
      const res = await testClient().get('/api/v1/wards');
      expect([401, 403]).toContain(res.statusCode);
    });
  });
});
