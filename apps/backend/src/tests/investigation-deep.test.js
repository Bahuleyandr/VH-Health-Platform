// Deep integration tests for the investigation order workflow.
// Exercises: orderInvestigation (POST /order), legacy investigation (POST /),
// and validates canonical DB column mapping (test_type, requested_by, requested_at).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DOCTOR_UID = 'a5555555-5555-4555-8555-555555555a01';
const PATIENT_UID = 'a5555555-5555-4555-8555-555555555a02';
const LAB_UID = 'a5555555-5555-4555-8555-555555555a03';
const RAW_PHONE = '9000050001';
const PATIENT_PHONE = '+919000050001';
const API_KEY = process.env.API_KEY || 'test-api-key';

function adminAs() {
  // Use the default test-harness uid from testClient.js (already seeded as a
  // user by migration 082). The previous override to
  // `00000000-0000-4000-8000-000000000001` was the DEFAULT_TENANT_ID, not a
  // real user uid — harmless before migration 082 but now fails the
  // investigations_requested_by_fkey on legacy-investigation creation.
  const token = generateTestToken('ADMIN');
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function doctorAs(uid = DOCTOR_UID) {
  const token = generateTestToken('DOCTOR', { uid, id: 990501 });
  // Non-ADMIN roles must include a `uid` field in the body/query for validateUID to pass.
  // We stamp `uid` on every POST body automatically.
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => ({
      send: (body) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
        .send({ ...body, uid: body?.uid || uid, phone: body?.phone || '9000050099' }),
    }),
  };
}

function labAs(uid = LAB_UID) {
  const token = generateTestToken('LAB_STAFF', { uid, id: 990502 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function patientAs(intId) {
  const token = generateTestToken('PATIENT', { uid: PATIENT_UID, id: intId, phone: PATIENT_PHONE });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Investigation order workflow — deep integration', () => {
  const admin = adminAs();
  const doctor = doctorAs();
  const lab = labAs();
  let patientIntId;
  let doctorIntId;
  let visitAppointmentId;
  let mismatchAppointmentId;
  let otherPatientIntId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM notifications WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE phone IN ($1, '9000050999')`, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE phone = '9000050999'`);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`, PATIENT_UID, DOCTOR_UID, LAB_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Investigation Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000050002', 'Investigation Test Doctor', 'DOCTOR', true, NOW())
       RETURNING id`,
      DOCTOR_UID);
    doctorIntId = d[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000050003', 'Investigation Test Lab Staff', 'LAB_STAFF', true, NOW())`,
      LAB_UID);

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, doctor_id, doctor_name, patient_name,
          appointment_date, appointment_time, status, department, reason,
          created_at, updated_at)
       VALUES
         ($1, $2::int, $3::int, 'Investigation Test Doctor',
          'Investigation Test Patient', CURRENT_DATE, '12:45',
          'CONFIRMED', 'Cardiology', 'OP investigation visit', NOW(), NOW())
       RETURNING id`,
      PATIENT_PHONE,
      patientIntId,
      doctorIntId,
    );
    visitAppointmentId = a[0].id;

    const other = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ('9000050999', 'Other Investigation Patient', 'PATIENT', true, NOW())
       RETURNING id`);
    otherPatientIntId = other[0].id;
    const mismatch = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, doctor_id, doctor_name, patient_name,
          appointment_date, appointment_time, status, department, reason,
          created_at, updated_at)
       VALUES
         ('9000050999', $1::int, $2::int, 'Investigation Test Doctor',
          'Other Investigation Patient', CURRENT_DATE, '13:15',
          'CONFIRMED', 'Cardiology', 'Mismatch appointment', NOW(), NOW())
       RETURNING id`,
      otherPatientIntId,
      doctorIntId,
    );
    mismatchAppointmentId = mismatch[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM notifications WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE phone IN ($1, '9000050999')`, PATIENT_PHONE).catch(() => {});
    if (otherPatientIntId) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::int`, otherPatientIntId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE phone = '9000050999'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`, PATIENT_UID, DOCTOR_UID, LAB_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('RBAC', () => {
    it('forbids roles outside DOCTOR/ADMIN from ordering', async () => {
      const nurse = (() => {
        const token = generateTestToken('NURSING_STAFF', { uid: DOCTOR_UID, id: 9905 });
        return request(app).post('/api/v1/investigations/order')
          .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
          .send({ patient_id: patientIntId, test_name: 'CBC', type: 'LAB' });
      })();
      const res = await nurse;
      // 403 if RBAC triggers first; 400 if identityValidator rejects before RBAC.
      // Either way, the nurse cannot place an order — and nothing is persisted.
      expect([400, 403]).toContain(res.statusCode);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM investigations WHERE test_name = 'CBC' AND phone = $1`, PATIENT_PHONE);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('orderInvestigation', () => {
    it('rejects order missing required fields', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({ test_name: 'CBC' });
      expect([400, 404, 500]).toContain(res.statusCode); // MISSING_REQUIRED_FIELDS → generic 500 in controller
      // Nothing persisted
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM investigations WHERE test_name = 'CBC' AND phone = $1`, PATIENT_PHONE);
      expect(rows[0].n).toBe(0);
    });

    it('rejects unknown investigation type', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'CBC', type: 'BOGUS_TYPE',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown patient', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: 9999999, test_name: 'CBC', type: 'LAB',
      });
      expect(res.statusCode).toBe(404);
    });

    it('creates an investigation with canonical columns populated', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Complete Blood Count', type: 'LAB', priority: 'NORMAL',
      });
      expect(res.statusCode).toBe(200);
      const inv = res.body.data.investigation;
      expect(inv.id).toBeDefined();
      expect(inv.test_name).toBe('Complete Blood Count');
      expect(inv.test_type).toBe('LAB');
      expect(inv.status).toBe('REQUESTED');
      expect(inv.priority).toBe('NORMAL');
      expect(inv.patient_id).toBe(patientIntId);
      expect(inv.requested_by).toBe(DOCTOR_UID);

      // DB verification — canonical columns (not the drifted code's `doctor_id`, `type`, etc.)
      const row = await prisma.$queryRawUnsafe(
        `SELECT test_type, status, requested_by, requested_at FROM investigations WHERE id = $1`, inv.id);
      expect(row[0].test_type).toBe('LAB');
      expect(row[0].status).toBe('REQUESTED');
      expect(row[0].requested_by).toBe(DOCTOR_UID);
      expect(row[0].requested_at).toBeTruthy();
    });

    it('binds OP investigation orders to the current appointment visit', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        appointment_id: visitAppointmentId,
        test_name: 'ECG visit scoped',
        type: 'CARDIOLOGY',
        priority: 'NORMAL',
      });
      expect(res.statusCode).toBe(200);
      const inv = res.body.data.investigation;
      expect(inv.appointment_id).toBe(visitAppointmentId);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT appointment_id FROM investigations WHERE id = $1::int`,
        inv.id,
      );
      expect(Number(rows[0].appointment_id)).toBe(visitAppointmentId);
    });

    it('rejects appointment context that belongs to a different patient', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        appointment_id: mismatchAppointmentId,
        test_name: 'ECG mismatch should fail',
        type: 'CARDIOLOGY',
        priority: 'NORMAL',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/does not belong/i);
    });

    it('shows newly requested investigations in pending worklists', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        test_name: 'ECG Pending Visibility',
        type: 'CARDIOLOGY',
        priority: 'NORMAL',
      });
      expect(res.statusCode).toBe(200);
      const invId = res.body.data.investigation.id;
      expect(res.body.data.investigation.status).toBe('REQUESTED');

      const pending = await lab.get('/api/v1/investigations/status/pending');
      expect(pending.statusCode).toBe(200);
      expect(pending.body.data.investigations.map((i) => i.id)).toContain(invId);

      const doctorQueue = await doctor.get(`/api/v1/investigations/doctor/${doctorIntId}`);
      expect(doctorQueue.statusCode).toBe(200);
      expect(doctorQueue.body.data.investigations.map((i) => i.id)).toContain(invId);
      expect(doctorQueue.body.data.filters.status).toBe('PENDING');
    });

    it('defaults actionable collection instructions for doctor-created lab orders', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        test_name: 'CBC with differential',
        type: 'LAB',
        priority: 'NORMAL',
      });
      expect(res.statusCode).toBe(200);
      const inv = res.body.data.investigation;
      expect(inv.collection_location).toBe('Main Laboratory Sample Collection');
      expect(inv.collection_deadline_at).toBeTruthy();
      expect(inv.fasting_required).toBe(false);
      expect(inv.fasting_instructions).toMatch(/No fasting required/i);
    });

    it('creates a URGENT-priority investigation and normalizes casing', async () => {
      // Validator is strict: type + priority must match exact UPPERCASE values.
      // Service also accepts lowercase but validator runs first — send UPPERCASE.
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Troponin', type: 'LAB', priority: 'URGENT',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.investigation.test_type).toBe('LAB');
      expect(res.body.data.investigation.priority).toBe('URGENT');
    });

    it('writes a patient notification for the order', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Lipid panel', type: 'LAB',
      });
      expect(res.statusCode).toBe(200);

      const notifs = await prisma.$queryRawUnsafe(
        `SELECT type, title FROM notifications
         WHERE phone = $1 AND type = 'investigation_ordered' AND title LIKE 'New Investigation%'
         ORDER BY created_at DESC LIMIT 1`, PATIENT_PHONE);
      expect(notifs.length).toBe(1);
    });

    it('stamps sample collection and result verification audit fields', async () => {
      const order = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Hemoglobin', type: 'LAB', priority: 'URGENT',
      });
      expect(order.statusCode).toBe(200);
      const invId = order.body.data.investigation.id;

      const collected = await lab.put(`/api/v1/investigations/${invId}/status`).send({
        status: 'COLLECTED',
        notes: 'Collected urgent IPD sample',
      });
      expect(collected.statusCode).toBe(200);
      const collectedInv = collected.body.data.investigation;
      expect(collectedInv.status).toBe('COLLECTED');
      expect(collectedInv.collected_at).toBeTruthy();
      expect(collectedInv.collected_by).toBe(LAB_UID);
      expect(collectedInv.collected_notes).toBe('Collected urgent IPD sample');
      expect(collectedInv.sample_barcode).toMatch(/^INV-[A-Z0-9]+-[A-Z0-9]{6}$/);

      const result = await lab.put(`/api/v1/investigations/${invId}/results`).send({
        results: {
          hemoglobin: { name: 'Hemoglobin', value: '13.2', unit: 'g/dL', normal_range: '12-16' },
        },
        interpretation: 'Normal hemoglobin',
      });
      expect(result.statusCode).toBe(200);
      const completedInv = result.body.data.investigation;
      expect(completedInv.status).toBe('COMPLETED');
      expect(completedInv.completed_at).toBeTruthy();
      expect(completedInv.verified_at).toBeTruthy();
      expect(completedInv.verified_by).toBe(LAB_UID);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT status, collected_at, collected_by, sample_barcode, verified_at, verified_by
           FROM investigations WHERE id = $1`,
        invId);
      expect(rows[0]).toMatchObject({
        status: 'COMPLETED',
        collected_by: LAB_UID,
        verified_by: LAB_UID,
      });
      expect(rows[0].collected_at).toBeTruthy();
      expect(rows[0].sample_barcode).toBeTruthy();
      expect(rows[0].verified_at).toBeTruthy();
    });

    it('accepts lowercase status updates from legacy staff clients', async () => {
      const order = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        test_name: 'Legacy lowercase status ECG',
        type: 'CARDIOLOGY',
        priority: 'NORMAL',
      });
      expect(order.statusCode).toBe(200);
      const invId = order.body.data.investigation.id;

      const started = await lab.put(`/api/v1/investigations/${invId}/status`).send({
        status: 'in_progress',
      });
      expect(started.statusCode).toBe(200);
      expect(started.body.data.investigation.status).toBe('IN_PROGRESS');
    });

    it('exposes lab sample collect, barcode lookup, and rejection APIs', async () => {
      const order = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Serum Sodium', type: 'LAB', priority: 'URGENT',
      });
      expect(order.statusCode).toBe(200);
      const invId = order.body.data.investigation.id;

      const collected = await lab.post(`/api/v1/lab/samples/${invId}/collect`).send({
        collected_notes: 'Drawn at lab counter',
      });
      expect(collected.statusCode).toBe(200);
      expect(collected.body.data.status).toBe('COLLECTED');
      expect(collected.body.data.collected_by).toBe(LAB_UID);
      expect(collected.body.data.sample_barcode).toMatch(/^INV-[A-Z0-9]+-[A-Z0-9]{6}$/);

      const barcode = collected.body.data.sample_barcode;
      const barcodeLookup = await lab.get(`/api/v1/lab/samples/barcode/${barcode}`);
      expect(barcodeLookup.statusCode).toBe(200);
      expect(barcodeLookup.body.data.id).toBe(invId);
      expect(barcodeLookup.body.data.sample_barcode).toBe(barcode);

      const rejected = await lab.post(`/api/v1/lab/samples/${invId}/reject`).send({
        rejection_reason: 'Haemolysed sample',
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.body.data.status).toBe('REQUESTED');
      expect(rejected.body.data.sample_barcode).toBeNull();
      expect(rejected.body.data.collected_at).toBeNull();
      expect(rejected.body.data.sample_rejected_at).toBeTruthy();
      expect(rejected.body.data.sample_rejected_by).toBe(LAB_UID);
      expect(rejected.body.data.sample_rejection_reason).toBe('Haemolysed sample');
    });

    it('bulk-updates investigation sample collection with audit fields', async () => {
      const first = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Serum Electrolytes', type: 'LAB',
      });
      const second = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId, test_name: 'Liver Function Test', type: 'LAB',
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const ids = [first.body.data.investigation.id, second.body.data.investigation.id];

      const res = await lab.post('/api/v1/investigations/bulk/status').send({
        investigation_ids: ids,
        status: 'COLLECTED',
        notes: 'Bulk collected at IPD bedside',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.count).toBe(2);
      expect(res.body.data.updated.map((r) => r.id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
      for (const row of res.body.data.updated) {
        expect(row.status).toBe('COLLECTED');
        expect(row.collected_at).toBeTruthy();
        expect(row.collected_by).toBe(LAB_UID);
        expect(row.collected_notes).toBe('Bulk collected at IPD bedside');
        expect(row.sample_barcode).toMatch(/^INV-[A-F0-9]+-[A-F0-9]{6}$/);
      }
    });

    it('patient investigations hide cancelled duplicate rows by default', async () => {
      const active = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        test_name: 'Actionable CBC',
        type: 'LAB',
      });
      expect(active.statusCode).toBe(200);
      await prisma.$executeRawUnsafe(
        `INSERT INTO investigations
           (phone, patient_id, patient_uid, test_name, test_type, status, priority,
            requested_by, requested_at, updated_at, notes)
         VALUES
           ($1, $2::int, $3::uuid, 'Cancelled duplicate CBC', 'LAB', 'CANCELLED',
            'NORMAL', $4::uuid, NOW() + INTERVAL '1 minute', NOW(),
            'Duplicate order cancelled by lab')`,
        PATIENT_PHONE,
        patientIntId,
        PATIENT_UID,
        DOCTOR_UID,
      );

      const patient = patientAs(patientIntId);
      const res = await patient.get(`/api/v1/investigations/patient/${patientIntId}`);
      expect(res.statusCode).toBe(200);
      const names = res.body.data.investigations.map((i) => i.test_name);
      expect(names).toContain('Actionable CBC');
      expect(names).not.toContain('Cancelled duplicate CBC');
    });

    it('dashboard bookings feed includes active doctor-created investigation orders', async () => {
      const order = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientIntId,
        test_name: 'Dashboard CBC',
        type: 'LAB',
      });
      expect(order.statusCode).toBe(200);
      const patient = patientAs(patientIntId);
      const res = await patient.get('/api/v1/investigations/bookings/my');
      expect(res.statusCode).toBe(200);
      const doctorOrder = res.body.data.find((b) => b.investigation_id === order.body.data.investigation.id);
      expect(doctorOrder).toBeTruthy();
      expect(doctorOrder.source_type).toBe('doctor_order');
      expect(doctorOrder.booking_number).toBe(`ORDER-${order.body.data.investigation.id}`);
      expect(doctorOrder.collection_location).toBe('Main Laboratory Sample Collection');
    });

    it('GET /investigations/my resolves the patient from the JWT (no id/phone in URL)', async () => {
      const patient = patientAs(patientIntId);
      const res = await patient.get('/api/v1/investigations/my');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data.investigations)).toBe(true);
    });

    it('legacy GET /investigations/:phone is removed (phone-shaped path no longer lists by phone)', async () => {
      const patient = patientAs(patientIntId);
      const res = await patient.get(`/api/v1/investigations/${RAW_PHONE}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('legacyInvestigationRequest', () => {
    it('creates a legacy phone-based investigation record', async () => {
      const res = await admin.post('/api/v1/investigations').send({
        phone: RAW_PHONE, test_name: 'X-Ray chest', file_key: null,
      });
      expect(res.statusCode).toBe(200);
      const inv = res.body.data.investigation;
      expect(inv.id).toBeDefined();
      expect(inv.test_name).toBe('X-Ray chest');
      expect(inv.status).toBe('REQUESTED');
      expect(inv.phone).toBe(PATIENT_PHONE);

      const notifs = await prisma.$queryRawUnsafe(
        `SELECT type FROM notifications
         WHERE phone = $1 AND type = 'investigation_ready'
         ORDER BY created_at DESC LIMIT 1`, PATIENT_PHONE);
      expect(notifs.length).toBe(1);
    });

    it('rejects a legacy request without phone or test_name', async () => {
      const res = await admin.post('/api/v1/investigations').send({ test_name: 'only-name' });
      expect(res.statusCode).toBe(400);
    });
  });
});
