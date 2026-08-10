/**
 * E2E Integration Flow Tests
 * registration → booking → investigation → pharmacy → billing
 *
 * These tests exercise full vertical slices of the API, chaining
 * outputs from one step as inputs to the next. Every step asserts its
 * exact expected status — the earlier "status-or-500" sets let the whole
 * journey silently no-op when step 1 failed.
 */

import { authClient } from './testClient.js';

const admin = authClient('ADMIN');

// Shared state — populated as each step runs
const flow = {
  patientPhone: `9${Date.now().toString().slice(-9)}`, // unique phone per run
  patientUid: null,
  appointmentId: null,
  investigationId: null,
  invoiceId: null,
};

// ─── Step 1: User Registration ───────────────────────────────────────────────

describe('E2E Flow — Step 1: Patient Registration', () => {
  it('should register a new patient', async () => {
    const res = await admin.post('/api/v1/users/profile').send({
      phone: flow.patientPhone,
      name: 'E2E Test Patient',
      gender: 'MALE',
      role: 'PATIENT',
    });
    expect(res.statusCode).toBe(200);
    const user = res.body?.data?.user;
    expect(user?.uid).toBeDefined();
    flow.patientUid = user.uid;
  });

  it('should look up patient by phone', async () => {
    const res = await admin.get(`/api/v1/users/${flow.patientPhone}`);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 2: Appointment Booking ─────────────────────────────────────────────

describe('E2E Flow — Step 2: Appointment Booking', () => {
  it('should book an appointment', async () => {
    const res = await admin.post('/api/v1/appointments').send({
      phone: flow.patientPhone,
      // users.id 2 is the first seeded doctor (doctors.id 1 ↔ users_id 2).
      // doctor_id 1 is rejected as AMBIGUOUS_DOCTOR_REF: it matches both the
      // fixture ADMIN user (users.id 1) and doctors.id 1.
      doctor_id: 2,
      doctor_name: 'Dr. Test',
      // Unique slot per run — a fixed slot 409s (slot conflict) on a reused DB.
      appointment_date: new Date(Date.now() + (1 + (Date.now() % 200)) * 86400000)
        .toISOString()
        .split('T')[0],
      appointment_time: `${String(9 + (Date.now() % 8)).padStart(2, '0')}:${String(Date.now() % 60).padStart(2, '0')}`,
      reason: 'E2E test consultation',
    });
    expect([200, 201]).toContain(res.statusCode);
    const data = res.body?.data ?? res.body;
    if (data?.id) flow.appointmentId = data.id;
  });

  it('should fetch appointments by phone', async () => {
    const res = await admin.get(`/api/v1/appointments/phone/${flow.patientPhone}`);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 3: Investigation Order ─────────────────────────────────────────────

describe('E2E Flow — Step 3: Investigation', () => {
  it('should reject investigation without required fields', async () => {
    const res = await admin.post('/api/v1/investigations').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should create investigation order', async () => {
    const res = await admin.post('/api/v1/investigations').send({
      phone: flow.patientPhone,
      test_name: 'Complete Blood Count',
      test_type: 'HAEMATOLOGY',
    });
    expect([200, 201]).toContain(res.statusCode);
    const data = res.body?.data ?? res.body;
    if (data?.id) flow.investigationId = data.id;
  });

  it('should fetch investigations by patient uid', async () => {
    // There is no by-phone list route — /:phone would match /:id and 404.
    const res = await admin.get(`/api/v1/investigations/uid/${flow.patientUid}`);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 4: Pharmacy Order ───────────────────────────────────────────────────

describe('E2E Flow — Step 4: Pharmacy Order', () => {
  it('should reject pharmacy order without required fields', async () => {
    const res = await admin.post('/api/v1/pharmacy-orders/orders/place').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should fetch pharmacy order queue', async () => {
    const res = await admin.get('/api/v1/pharmacy-orders/orders/queue');
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 5: Billing — Create Invoice ────────────────────────────────────────

describe('E2E Flow — Step 5: Billing', () => {
  it('should reject invoice without patient_uid', async () => {
    const res = await admin.post('/api/v1/billing/invoice').send({
      total_amount: 500,
    });
    expect(res.statusCode).toBe(400);
  });

  it('should create invoice for the registered patient', async () => {
    expect(flow.patientUid).toBeDefined();
    const res = await admin.post('/api/v1/billing/invoice').send({
      patient_uid: flow.patientUid,
      type: 'consultation',
      items: [{ description: 'Consultation fee', quantity: 1, unit_price: 500, amount: 500 }],
      subtotal: 500,
      total_amount: 500,
      payment_method: 'cash',
    });
    expect([200, 201]).toContain(res.statusCode);
    const data = res.body?.data ?? res.body;
    expect(data?.id).toBeDefined();
    flow.invoiceId = data.id;
  });

  it('should fetch invoices for the patient', async () => {
    const res = await admin.get(`/api/v1/billing/invoices/patient/${flow.patientUid}`);
    expect(res.statusCode).toBe(200);
  });

  it('should record a payment against the invoice', async () => {
    expect(flow.invoiceId).toBeDefined();
    const res = await admin
      .post(`/api/v1/billing/invoice/${flow.invoiceId}/payment`)
      .send({ amount: 500, payment_method: 'cash' });
    expect([200, 201]).toContain(res.statusCode);
  });
});

// ─── Step 6: Revenue Stats ────────────────────────────────────────────────────

describe('E2E Flow — Step 6: Revenue Check', () => {
  it('should reject revenue stats without date range', async () => {
    const res = await admin.get('/api/v1/billing/revenue');
    expect(res.statusCode).toBe(400);
  });

  it('should return revenue stats for today', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await admin.get(
      `/api/v1/billing/revenue?date_from=${today}&date_to=${today}`,
    );
    expect(res.statusCode).toBe(200);
  });
});
