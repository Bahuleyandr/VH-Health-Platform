// Deep integration tests for vitals recording + anomaly alert generation.
// Exercises vitals_chart persistence, trend/latest/chart queries, and verifies that
// out-of-range vitals create clinical_alerts rows via vitalSignMonitor.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'a2222222-2222-4222-8222-222222222a01';
const RECORDER_UID = 'a2222222-2222-4222-8222-222222222a02';
const PATIENT_PHONE = '9000020001';
const API_KEY = process.env.API_KEY || 'test-api-key';

function doctorAs(uid = RECORDER_UID) {
  const token = generateTestToken('DOCTOR', { uid, id: 990201 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('EMR vitals + anomaly alerts — deep integration', () => {
  const doctor = doctorAs();
  let patientIntId;

  beforeAll(async () => {
    // Cleanup — delete alerts + vitals tied to our fixtures
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM intake_output WHERE patient_uid = $1::uuid`, PATIENT_UID);
    // clinical_alerts keyed by int patient_id — look it up first, then delete
    const existing = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT_UID);
    if (existing.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, existing[0].id);
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Vitals Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000020002', 'Vitals Test Doctor', 'DOCTOR', true, NOW())`,
      RECORDER_UID);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM intake_output WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    if (patientIntId) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, patientIntId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects vitals without patient_uid', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({ heart_rate: 80 });
      expect(res.statusCode).toBe(400);
    });

    it('rejects vitals with no measurements', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(400);
    });

    it('rejects out-of-range pain_score', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID, pain_score: 15,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects out-of-range gcs_score', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID, gcs_score: 20,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid consciousness value', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID, heart_rate: 80, consciousness: 'Z',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects trend query without vital parameter', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/trend`);
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid vital type on trend', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/trend?vital=bogus_col`);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('recordVitals + persistence', () => {
    let normalVitalsId;

    it('records normal vitals with 201 and persists row', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 78, systolic_bp: 118, diastolic_bp: 76, temperature: 36.8,
        spo2: 98, respiratory_rate: 16,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data?.vitals?.id).toBeDefined();
      normalVitalsId = res.body.data.vitals.id;
      expect(res.body.data.alerts).toEqual([]);

      const row = await prisma.$queryRawUnsafe(
        `SELECT heart_rate, spo2 FROM vitals_chart WHERE id = $1`, normalVitalsId);
      expect(parseFloat(row[0].heart_rate)).toBe(78);
      expect(parseFloat(row[0].spo2)).toBe(98);
    });
  });

  describe('OB urine dipstick fields (migration 211)', () => {
    it('persists urine_albumin / urine_sugar / urine_ketones when set', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        systolic_bp: 124, diastolic_bp: 78,
        urine_albumin: '1+',
        urine_sugar: 'negative',
        urine_ketones: 'trace',
      });
      expect(res.statusCode).toBe(201);
      const row = await prisma.$queryRawUnsafe(
        `SELECT urine_albumin, urine_sugar, urine_ketones
           FROM vitals_chart WHERE id = $1`, res.body.data.vitals.id);
      expect(row[0].urine_albumin).toBe('1+');
      expect(row[0].urine_sugar).toBe('negative');
      expect(row[0].urine_ketones).toBe('trace');
    });

    it('rejects unknown dipstick values', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        systolic_bp: 118,
        urine_albumin: '5+', // not in the 5-step scale
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts dipstick-only vitals when at least one pad is recorded', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        urine_albumin: '2+',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.urine_albumin).toBe('2+');
    });
  });

  describe('anomaly detection', () => {
    it('flags a CRITICAL low SpO2 and persists a clinical_alert', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 82, systolic_bp: 118, spo2: 80, // below critical_min 85
      });
      expect(res.statusCode).toBe(201);
      const alerts = res.body.data?.alerts || [];
      const spo2Alert = alerts.find((a) => a.vital_name === 'oxygen_saturation');
      expect(spo2Alert).toBeDefined();
      expect(spo2Alert.severity).toBe('CRITICAL');

      const persisted = await prisma.$queryRawUnsafe(
        `SELECT vital_name, severity FROM clinical_alerts
         WHERE patient_id = $1 AND vital_name = 'oxygen_saturation'
         ORDER BY created_at DESC LIMIT 1`,
        patientIntId);
      expect(persisted.length).toBe(1);
      expect(persisted[0].severity).toBe('CRITICAL');
    });

    it('flags a WARNING for elevated BP (above normal but not critical)', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 82, systolic_bp: 170, // above max 160, below critical_max 200
      });
      expect(res.statusCode).toBe(201);
      const bpAlert = (res.body.data?.alerts || []).find((a) => a.vital_name === 'systolic_bp');
      expect(bpAlert).toBeDefined();
      expect(bpAlert.severity).toBe('WARNING');
    });
  });

  describe('getLatestVitals + trend + chart', () => {
    it('returns the most recent vitals row', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/latest`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).not.toBeNull();
      expect(res.body.data.patient_uid).toBe(PATIENT_UID);
    });

    it('returns heart_rate trend in ascending time order', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/trend?vital=heart_rate`);
      expect(res.statusCode).toBe(200);
      const points = res.body.data;
      expect(Array.isArray(points)).toBe(true);
      expect(points.length).toBeGreaterThanOrEqual(3); // 3 recordings so far
      for (let i = 1; i < points.length; i++) {
        expect(new Date(points[i].timestamp) >= new Date(points[i - 1].timestamp)).toBe(true);
      }
    });

    it('returns full chart with pagination metadata', async () => {
      const res = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/chart?limit=2`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      expect(res.body.meta?.total).toBeGreaterThanOrEqual(3);
    });
  });

  describe('I/O tracking', () => {
    it('rejects I/O without required fields', async () => {
      const res = await doctor.post('/api/v1/emr/io').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid io_type', async () => {
      const res = await doctor.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID, io_type: 'bogus', category: 'oral', amount_ml: 100,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative amount_ml', async () => {
      const res = await doctor.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID, io_type: 'intake', category: 'oral', amount_ml: -50,
      });
      expect(res.statusCode).toBe(400);
    });

    it('records intake and computes fluid balance for the day', async () => {
      // Use Postgres's `current_date` (server timezone) instead of JS UTC.
      // recorded_at is stored via NOW() with the server's timezone, and the
      // route filters with `recorded_at::date = $1::date` — so we have to
      // align with whatever date Postgres considers "today".
      const dateRows = await prisma.$queryRawUnsafe(
        `SELECT current_date::text AS today`);
      const today = dateRows[0].today;
      const intake = await doctor.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID, io_type: 'intake', category: 'oral', amount_ml: 500,
      });
      expect(intake.statusCode).toBe(201);
      const output = await doctor.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID, io_type: 'output', category: 'urine', amount_ml: 300,
      });
      expect(output.statusCode).toBe(201);

      const bal = await doctor.get(`/api/v1/emr/io/${PATIENT_UID}/balance?date=${today}`);
      expect(bal.statusCode).toBe(200);
      expect(bal.body.data.total_intake).toBe(500);
      expect(bal.body.data.total_output).toBe(300);
      expect(bal.body.data.balance).toBe(200);
      expect(bal.body.data.entries.length).toBe(2);
    });
  });
});
