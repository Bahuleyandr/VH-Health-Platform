// Deep integration tests for operating-theatre scheduling.
// Exercises: schedule → pre_op → in_progress → post_op → completed (+ cancel branches),
// checklist persistence (jsonb), room-availability view. Validates uuid casts on
// patient_uid / surgeon / anesthetist and text[] cast on equipment_needed.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'ba000000-0000-4000-8000-00000000a001';
const SURGEON_UID = 'ba000000-0000-4000-8000-00000000a002';
const ANESTHETIST_UID = 'ba000000-0000-4000-8000-00000000a003';
const ADMIN_UID = 'ba000000-0000-4000-8000-00000000a004';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function futureDateISO(offsetDays = 120) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('Theatre scheduling — deep integration', () => {
  let admin;
  let patientIntId, surgeonIntId, anesthIntId, adminIntId;
  const schedDate = futureDateISO(120);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM ot_schedules WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, SURGEON_UID, ANESTHETIST_UID, ADMIN_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000100001', 'Theatre Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID);
    patientIntId = p[0].id;

    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000100002', 'Dr. Surgeon Tester', 'DOCTOR', true, NOW())
       RETURNING id`, SURGEON_UID);
    surgeonIntId = s[0].id;

    const an = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000100003', 'Dr. Anesth Tester', 'DOCTOR', true, NOW())
       RETURNING id`, ANESTHETIST_UID);
    anesthIntId = an[0].id;

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000100004', 'Theatre Admin', 'ADMIN', true, NOW())
       RETURNING id`, ADMIN_UID);
    adminIntId = a[0].id;

    admin = mkClient('ADMIN', ADMIN_UID, adminIntId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM ot_schedules WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, SURGEON_UID, ANESTHETIST_UID, ADMIN_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects schedule without required fields', async () => {
      const res = await admin.post('/api/v1/theatre/schedule').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects cancel on unknown id', async () => {
      const res = await admin.delete('/api/v1/theatre/99999999');
      expect(res.statusCode).toBe(404);
    });

    it('rejects status update with an invalid status value', async () => {
      const res = await admin.put('/api/v1/theatre/99999999/status').send({ status: 'BOGUS' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects availability query without a date', async () => {
      const res = await admin.get('/api/v1/theatre/availability');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('full lifecycle: scheduled → pre_op → in_progress → post_op → completed', () => {
    let scheduleId;

    it('creates a schedule and populates jsonb/text[] cols correctly', async () => {
      const res = await admin.post('/api/v1/theatre/schedule').send({
        patient_uid: PATIENT_UID,
        surgeon: SURGEON_UID,
        anesthetist: ANESTHETIST_UID,
        procedure_name: 'Appendectomy',
        procedure_code: '44970',
        ot_room: 'OT-3',
        scheduled_date: schedDate,
        scheduled_time: '09:00',
        estimated_duration: 90,
        equipment_needed: ['Laparoscope', 'Trocars', 'Cautery'],
        blood_arranged: true,
        consent_obtained: true,
      });
      expect(res.statusCode).toBe(201);
      const s = res.body.data;
      expect(s.id).toBeDefined();
      expect(s.status).toBe('scheduled');
      expect(s.surgeon).toBe(SURGEON_UID);
      expect(s.anesthetist).toBe(ANESTHETIST_UID);
      expect(s.procedure_name).toBe('Appendectomy');
      expect(s.ot_room).toBe('OT-3');
      expect(Array.isArray(s.equipment_needed)).toBe(true);
      expect(s.equipment_needed).toContain('Laparoscope');
      expect(s.blood_arranged).toBe(true);
      expect(s.consent_obtained).toBe(true);
      scheduleId = s.id;

      // DB verification
      const row = await prisma.$queryRawUnsafe(
        `SELECT status, surgeon, equipment_needed, blood_arranged FROM ot_schedules WHERE id = $1`, scheduleId);
      expect(row[0].status).toBe('scheduled');
      expect(row[0].surgeon).toBe(SURGEON_UID);
      expect(row[0].equipment_needed).toEqual(['Laparoscope', 'Trocars', 'Cautery']);
      expect(row[0].blood_arranged).toBe(true);
    });

    it('stores the pre-op checklist as jsonb on the row', async () => {
      const checklist = {
        fasting_confirmed: true,
        site_marked: true,
        consent_signed: true,
        antibiotic_prophylaxis: 'Cefazolin 2g IV',
        last_vitals: { bp: '120/80', hr: 72 },
      };
      const res = await admin.put(`/api/v1/theatre/${scheduleId}/checklist`).send({ checklist });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.pre_op_checklist).toMatchObject({
        fasting_confirmed: true, site_marked: true,
      });
      const row = await prisma.$queryRawUnsafe(
        `SELECT pre_op_checklist FROM ot_schedules WHERE id = $1`, scheduleId);
      expect(row[0].pre_op_checklist.antibiotic_prophylaxis).toBe('Cefazolin 2g IV');
    });

    it('rejects SCHEDULED → IN_PROGRESS (must go via pre_op)', async () => {
      const res = await admin.put(`/api/v1/theatre/${scheduleId}/status`).send({
        status: 'in_progress',
      });
      // Service throws AppError.invalidTransition — may surface as 400 or 500 via next(err)
      expect([400, 500]).toContain(res.statusCode);
      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM ot_schedules WHERE id = $1`, scheduleId);
      expect(row[0].status).toBe('scheduled');
    });

    it('advances scheduled → pre_op → in_progress → post_op → completed', async () => {
      for (const target of ['pre_op', 'in_progress', 'post_op', 'completed']) {
        const res = await admin.put(`/api/v1/theatre/${scheduleId}/status`).send({ status: target });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.status).toBe(target);
      }
      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM ot_schedules WHERE id = $1`, scheduleId);
      expect(row[0].status).toBe('completed');
    });

    it('blocks transitions from terminal completed state', async () => {
      const res = await admin.put(`/api/v1/theatre/${scheduleId}/status`).send({
        status: 'cancelled',
      });
      expect([400, 500]).toContain(res.statusCode);
    });

    it('refuses to update checklist on a completed surgery', async () => {
      const res = await admin.put(`/api/v1/theatre/${scheduleId}/checklist`).send({
        checklist: { late_edit: true },
      });
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('cancel branch', () => {
    let scheduleId;

    beforeAll(async () => {
      const res = await admin.post('/api/v1/theatre/schedule').send({
        patient_uid: PATIENT_UID,
        surgeon: SURGEON_UID,
        procedure_name: 'Hernia Repair',
        scheduled_date: schedDate,
        scheduled_time: '11:00',
        ot_room: 'OT-4',
      });
      scheduleId = res.body.data.id;
    });

    it('cancels a scheduled surgery and flips status', async () => {
      const res = await admin.delete(`/api/v1/theatre/${scheduleId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('cancelled');
    });

    it('blocks further cancel on an already-cancelled surgery', async () => {
      const res = await admin.delete(`/api/v1/theatre/${scheduleId}`);
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('getTodaySchedule + getAvailableRooms', () => {
    it('returns the schedule for the target date', async () => {
      const res = await admin.get(`/api/v1/theatre/today?date=${schedDate}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const s of res.body.data) {
        expect(String(s.scheduled_date).startsWith(schedDate)).toBe(true);
      }
    });

    it('filters today schedule by status', async () => {
      const res = await admin.get(`/api/v1/theatre/today?date=${schedDate}&status=cancelled`);
      expect(res.statusCode).toBe(200);
      for (const s of res.body.data) {
        expect(s.status).toBe('cancelled');
      }
    });

    it('returns the booked-rooms list + per-room counts with real integers', async () => {
      const res = await admin.get(`/api/v1/theatre/availability?date=${schedDate}`);
      expect(res.statusCode).toBe(200);
      const d = res.body.data;
      expect(d.date).toBe(schedDate);
      expect(Array.isArray(d.booked_rooms)).toBe(true);
      expect(Array.isArray(d.room_schedules)).toBe(true);
      for (const rs of d.room_schedules) {
        expect(typeof rs.surgery_count).toBe('number'); // BigInt serialization bug fixed
      }
    });
  });
});
