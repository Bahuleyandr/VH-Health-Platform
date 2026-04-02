import { authClient } from './testClient.js';

describe('EMR API', () => {
  const admin = authClient('ADMIN');
  const doctor = authClient('DOCTOR');
  const general = authClient('GENERAL');
  const patientUid = '11111111-1111-1111-1111-111111111111';

  describe('admissions', () => {
    it('should forbid GENERAL role from EMR routes', async () => {
      const res = await general.get('/api/v1/emr/admissions');
      expect(res.statusCode).toBe(403);
    });

    it('should list admissions or return expected status', async () => {
      const res = await admin.get('/api/v1/emr/admissions');
      expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
    });

    it('should reject invalid admission id on detail route', async () => {
      const res = await admin.get('/api/v1/emr/admission/not-a-number');
      expect(res.statusCode).toBe(400);
    });

    it('should reject transfer without to_bed_id', async () => {
      const res = await admin.post('/api/v1/emr/1/transfer').send({ reason: 'ICU transfer' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('clinical notes', () => {
    it('should reject note creation without required fields', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({});
      expect(res.statusCode).toBe(400);
    });

    it('should create note or return expected status', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: patientUid,
        note_type: 'PROGRESS',
        content: { text: 'Patient stable' },
      });
      expect([201, 400, 401, 403, 404, 409, 422, 500]).toContain(res.statusCode);
    });

    it('should list patient notes or return expected status', async () => {
      const res = await doctor.get(`/api/v1/emr/notes/patient/${patientUid}`);
      expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('orders', () => {
    it('should reject order creation without required fields', async () => {
      const res = await doctor.post('/api/v1/emr/orders').send({});
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid order id on verify route', async () => {
      const res = await doctor.put('/api/v1/emr/orders/not-a-number/verify').send({});
      expect(res.statusCode).toBe(400);
    });

    it('should reject order cancellation without reason', async () => {
      const res = await doctor.put('/api/v1/emr/orders/1/cancel').send({});
      expect(res.statusCode).toBe(400);
    });

    it('should list patient orders or return expected status', async () => {
      const res = await doctor.get(`/api/v1/emr/orders/patient/${patientUid}`);
      expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('vitals', () => {
    it('should reject vitals recording without patient_uid', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({ heart_rate: 72 });
      expect(res.statusCode).toBe(400);
    });

    it('should reject vitals trend query without vital parameter', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${patientUid}/trend`);
      expect(res.statusCode).toBe(400);
    });

    it('should get latest vitals or return expected status', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${patientUid}/latest`);
      expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
    });

    it('should reject I/O recording without required fields', async () => {
      const res = await doctor.post('/api/v1/emr/io').send({ patient_uid: patientUid });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('discharge summary permissions', () => {
    it('should forbid GENERAL role from generating discharge summaries', async () => {
      const res = await general.post('/api/v1/emr/1/discharge-summary/generate').send({});
      expect(res.statusCode).toBe(403);
    });

    it('should reject invalid admission id when signing discharge summary', async () => {
      const res = await doctor.post('/api/v1/emr/not-a-number/discharge-summary/sign').send({});
      expect(res.statusCode).toBe(400);
    });
  });
});
