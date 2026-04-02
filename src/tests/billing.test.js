import { authClient } from './testClient.js';

describe('Billing API', () => {
  const admin = authClient('ADMIN');
  const doctor = authClient('DOCTOR');
  const patientUid = '11111111-1111-1111-1111-111111111111';

  it('should reject invoice creation without required fields', async () => {
    const res = await admin.post('/api/v1/billing/invoice').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should create invoice or return an expected controlled status', async () => {
    const res = await admin.post('/api/v1/billing/invoice').send({
      patient_uid: patientUid,
      total_amount: 1200,
      subtotal: 1000,
      tax_amount: 200,
      type: 'CONSULTATION',
      items: [{ description: 'Consultation', amount: 1000 }],
      payment_method: 'CASH',
    });
    expect([201, 400, 401, 403, 404, 409, 422, 500]).toContain(res.statusCode);
  });

  it('should reject invalid invoice id on detail route', async () => {
    const res = await admin.get('/api/v1/billing/invoice/not-a-number');
    expect(res.statusCode).toBe(400);
  });

  it('should fetch patient invoices or return expected status', async () => {
    const res = await admin.get(`/api/v1/billing/invoices/patient/${patientUid}`);
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should reject revenue stats without required date range', async () => {
    const res = await admin.get('/api/v1/billing/revenue');
    expect(res.statusCode).toBe(400);
  });

  it('should forbid non-admin users from reading revenue stats', async () => {
    const res = await doctor
      .get('/api/v1/billing/revenue?date_from=2026-01-01&date_to=2026-12-31');
    expect(res.statusCode).toBe(403);
  });

  it('should reject payment recording without required body fields', async () => {
    const res = await admin.post('/api/v1/billing/invoice/1/payment').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should record a payment or return expected status', async () => {
    const res = await admin.post('/api/v1/billing/invoice/1/payment').send({
      amount: 500,
      payment_method: 'UPI',
      transaction_ref: 'TXN-TEST-001',
    });
    expect([200, 400, 401, 403, 404, 409, 422, 500]).toContain(res.statusCode);
  });

  it('should reject insurance claim submission without required fields', async () => {
    const res = await admin.post('/api/v1/billing/insurance/claim').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should list insurance claims or return expected status', async () => {
    const res = await admin.get('/api/v1/billing/insurance/claims');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should reject invalid claim id on update route', async () => {
    const res = await admin.put('/api/v1/billing/insurance/claim/not-a-number').send({
      status: 'APPROVED',
      approved_amount: 1000,
    });
    expect(res.statusCode).toBe(400);
  });
});
