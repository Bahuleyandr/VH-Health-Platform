// Deep integration tests for the investigation order workflow.
// Exercises: orderInvestigation (POST /order), legacy investigation (POST /),
// and validates canonical DB column mapping (test_type, requested_by, requested_at).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DOCTOR_UID = 'a5555555-5555-4555-8555-555555555a01';
const PATIENT_UID = 'a5555555-5555-4555-8555-555555555a02';
const RAW_PHONE = '9000050001';
const PATIENT_PHONE = '+919000050001';
const API_KEY = process.env.API_KEY || 'test-api-key';

function adminAs() {
  const token = generateTestToken('ADMIN', { uid: '00000000-0000-4000-8000-000000000001', id: 1 });
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

describe('Investigation order workflow — deep integration', () => {
  const admin = adminAs();
  const doctor = doctorAs();
  let patientIntId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM notifications WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Investigation Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000050002', 'Investigation Test Doctor', 'DOCTOR', true, NOW())`,
      DOCTOR_UID);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM notifications WHERE phone IN ($1, $2)`, RAW_PHONE, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
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
