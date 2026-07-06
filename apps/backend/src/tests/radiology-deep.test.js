// Deep integration tests for radiology module.
// Exercises order → report (completed) → cancel branches, with validation of
// canonical columns (no fictional findings/impression/images cols — they're folded
// into the `report` text blob; the reporter uuid goes into `radiologist`).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'bb000000-0000-4000-8000-00000000b001';
const DOCTOR_UID = 'bb000000-0000-4000-8000-00000000b002';
const RADIOLOGIST_UID = 'bb000000-0000-4000-8000-00000000b003';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Radiology order + report — deep integration', () => {
  let doctor, radiologist;
  let patientIntId, doctorIntId, radIntId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, DOCTOR_UID, RADIOLOGIST_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110001', 'Radiology Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID);
    patientIntId = p[0].id;

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110002', 'Dr. Referring', 'DOCTOR', true, NOW())
       RETURNING id`, DOCTOR_UID);
    doctorIntId = d[0].id;

    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110003', 'Dr. Radiologist', 'RADIOLOGIST', true, NOW())
       RETURNING id`, RADIOLOGIST_UID);
    radIntId = r[0].id;

    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId);
    radiologist = mkClient('RADIOLOGIST', RADIOLOGIST_UID, radIntId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, DOCTOR_UID, RADIOLOGIST_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects order without required fields', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid modality', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID, modality: 'xray-ish', body_part: 'chest',
        clinical_indication: 'Cough, fever',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid priority', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID, modality: 'xray', body_part: 'chest',
        clinical_indication: 'Cough, fever', priority: 'whenever',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects report submission without required fields', async () => {
      const res = await radiologist.put('/api/v1/radiology/1/report').send({});
      expect([400, 404, 500]).toContain(res.statusCode);
    });
  });

  describe('full flow: ordered → completed', () => {
    let orderId;

    it('creates an order with status=ordered', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'xray',
        body_part: 'chest',
        clinical_indication: 'Persistent cough, r/o pneumonia',
        priority: 'urgent',
        notes: 'Inpatient, ward 3',
      });
      expect(res.statusCode).toBe(201);
      const o = res.body.data;
      expect(o.id).toBeDefined();
      expect(o.status).toBe('ordered');
      expect(o.modality).toBe('xray');
      expect(o.body_part).toBe('chest');
      expect(o.priority).toBe('urgent');
      expect(o.ordered_by).toBe(DOCTOR_UID);
      orderId = o.id;

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, ordered_by FROM radiology_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe('ordered');
      expect(row[0].ordered_by).toBe(DOCTOR_UID);
    });

    it('fetches order detail by id', async () => {
      const res = await doctor.get(`/api/v1/radiology/${orderId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.id).toBe(orderId);
      expect(res.body.data.clinical_indication).toMatch(/Persistent cough/);
    });

    it('submits a report (findings + impression folded into report text)', async () => {
      const res = await radiologist.put(`/api/v1/radiology/${orderId}/report`).send({
        findings: 'Patchy opacity in right lower lobe; no pleural effusion',
        impression: 'Right lower lobe pneumonia',
        report: 'See findings + impression above. Recommend follow-up in 2 weeks.',
      });
      expect(res.statusCode).toBe(200);
      const o = res.body.data;
      expect(o.status).toBe('completed');
      expect(o.radiologist).toBe(RADIOLOGIST_UID);
      expect(o.report_completed_at).toBeTruthy();
      expect(o.report).toMatch(/Findings:/);
      expect(o.report).toMatch(/Impression:/);
      expect(o.report).toMatch(/Right lower lobe pneumonia/);

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, radiologist, report_completed_at FROM radiology_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe('completed');
      expect(row[0].radiologist).toBe(RADIOLOGIST_UID);
      expect(row[0].report_completed_at).not.toBeNull();
    });

    it('rejects report submission by a non-radiologist doctor', async () => {
      const res = await doctor.put(`/api/v1/radiology/${orderId}/report`).send({
        report: 'Referring-doctor wet read — must not be accepted as the report',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/radiologist role/i);
    });

    it('rejects report sign-off by a non-radiologist doctor', async () => {
      const res = await doctor.post(`/api/v1/radiology/${orderId}/sign-off`).send({});
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/radiologist role/i);
    });

    it('radiologist signs off the completed report (medico-legal lock)', async () => {
      const res = await radiologist.post(`/api/v1/radiology/${orderId}/sign-off`).send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.data.report_signed_off_by).toBe(RADIOLOGIST_UID);
      expect(res.body.data.report_signed_off_at).toBeTruthy();
    });

    it('rejects an addendum by a non-radiologist doctor', async () => {
      const res = await doctor.post(`/api/v1/radiology/${orderId}/addendum`).send({
        addendum: 'Treating-team note — belongs in progress notes, not the report',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/radiologist role/i);
    });

    it('radiologist appends an addendum to the signed report', async () => {
      const res = await radiologist.post(`/api/v1/radiology/${orderId}/addendum`).send({
        addendum: 'Addendum: small right pleural effusion on lateral view, missed on first read.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.report).toMatch(/small right pleural effusion/);
    });

    it('refuses to cancel a completed order', async () => {
      const res = await radiologist.put(`/api/v1/radiology/${orderId}/cancel`);
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('cancel branch', () => {
    let orderId;

    beforeAll(async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'ct',
        body_part: 'abdomen',
        clinical_indication: 'Abdominal pain, r/o appendicitis',
      });
      orderId = res.body.data.id;
    });

    it('cancels an ordered study', async () => {
      const res = await doctor.put(`/api/v1/radiology/${orderId}/cancel`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('cancelled');
    });

    it('blocks a second cancel on a cancelled order', async () => {
      const res = await doctor.put(`/api/v1/radiology/${orderId}/cancel`);
      expect([400, 500]).toContain(res.statusCode);
    });

    it('refuses to submit a report on a cancelled order', async () => {
      const res = await radiologist.put(`/api/v1/radiology/${orderId}/report`).send({
        report: 'Too late — order was cancelled',
      });
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('worklist + patient history', () => {
    it('returns the radiology worklist with priority sort (stat before urgent)', async () => {
      // Create a stat order so we have both priorities in the list
      await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID, modality: 'mri', body_part: 'brain',
        clinical_indication: 'Sudden-onset headache + neuro deficit',
        priority: 'stat',
      });

      const res = await doctor.get('/api/v1/radiology/worklist');
      expect(res.statusCode).toBe(200);
      const arr = res.body.data;
      expect(Array.isArray(arr)).toBe(true);
      const rank = { stat: 1, urgent: 2, routine: 3 };
      let last = 0;
      for (const o of arr) {
        const r = rank[o.priority] || 99;
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
    });

    it('filters the worklist by modality', async () => {
      const res = await doctor.get('/api/v1/radiology/worklist?modality=mri');
      expect(res.statusCode).toBe(200);
      for (const o of res.body.data) {
        expect(o.modality).toBe('mri');
      }
    });

    it('returns a patient history with real integer pagination total', async () => {
      const res = await doctor.get(`/api/v1/radiology/patient/${PATIENT_UID}`);
      expect(res.statusCode).toBe(200);
      expect(typeof res.body.meta?.pagination?.total).toBe('number'); // BigInt bug fixed
      expect(res.body.meta.pagination.total).toBeGreaterThanOrEqual(3);
      for (const o of res.body.data) {
        expect(o.patient_uid).toBe(PATIENT_UID);
      }
    });
  });
});
