// Deep integration tests for the bloodbank module.
// Exercises the full lifecycle: request → cross-match → issue → transfused
// with status-machine enforcement and incompatible-match blocking. Validates
// canonical DB columns (no fictional `issued` / `transfused` / `transfusion_reaction`
// columns — they don't exist on blood_requests; the service folds reactions into notes).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DOCTOR_UID = 'a9999999-9999-4999-8999-999999999a01';
const BLOOD_BANK_UID = 'a9999999-9999-4999-8999-999999999a02';
const PATIENT_UID = 'a9999999-9999-4999-8999-999999999a03';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Bloodbank lifecycle — deep integration', () => {
  let doctor;
  let bloodStaff;
  let doctorIntId, staffIntId, patientIntId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM blood_requests WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      DOCTOR_UID, BLOOD_BANK_UID, PATIENT_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000090001', 'Blood Test Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID);
    patientIntId = p[0].id;

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000090002', 'Dr. Blood Tester', 'DOCTOR', true, NOW())
       RETURNING id`, DOCTOR_UID);
    doctorIntId = d[0].id;

    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000090003', 'Blood Bank Tech', 'ADMIN', true, NOW())
       RETURNING id`, BLOOD_BANK_UID);
    staffIntId = s[0].id;

    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId);
    bloodStaff = mkClient('ADMIN', BLOOD_BANK_UID, staffIntId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM blood_requests WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      DOCTOR_UID, BLOOD_BANK_UID, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects request without required fields', async () => {
      const res = await doctor.post('/api/v1/blood-bank/request').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid blood_group', async () => {
      const res = await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID, blood_group: 'Z+', units: 2,
        component: 'prbc', clinical_indication: 'x',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid component', async () => {
      const res = await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID, blood_group: 'O+', units: 2,
        component: 'bogus', clinical_indication: 'Elective surgery',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative units', async () => {
      const res = await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID, blood_group: 'O+', units: -1,
        component: 'prbc', clinical_indication: 'x',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('full lifecycle: requested → cross_matched → issued → transfused', () => {
    let requestId;

    it('creates a request with status=requested and cross_match=pending', async () => {
      const res = await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID,
        blood_group: 'O+', component: 'prbc', units: 2,
        urgency: 'routine',
        clinical_indication: 'Elective surgery, Hb=7.1',
      });
      expect(res.statusCode).toBe(201);
      const r = res.body.data;
      expect(r.id).toBeDefined();
      expect(r.status).toBe('requested');
      expect(r.cross_match_status).toBe('pending');
      expect(r.blood_group).toBe('O+');
      expect(r.component).toBe('prbc');
      expect(r.units).toBe(2);
      expect(r.ordered_by).toBe(DOCTOR_UID);
      requestId = r.id;

      // DB-level verification
      const row = await prisma.$queryRawUnsafe(
        `SELECT status, cross_match_status, ordered_by FROM blood_requests WHERE id = $1`, requestId);
      expect(row[0].status).toBe('requested');
      expect(row[0].cross_match_status).toBe('pending');
      expect(row[0].ordered_by).toBe(DOCTOR_UID);
    });

    it('rejects cross-match without cross_match_status', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/cross-match`).send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects unknown cross_match_status value', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/cross-match`).send({
        cross_match_status: 'maybe',
      });
      expect(res.statusCode).toBe(400);
    });

    it('records a compatible cross-match and advances status=cross_matched', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/cross-match`).send({
        cross_match_status: 'compatible',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('cross_matched');
      expect(res.body.data.cross_match_status).toBe('compatible');
      expect(res.body.data.cross_matched_by).toBe(BLOOD_BANK_UID);
      expect(res.body.data.cross_matched_at).toBeTruthy();
    });

    it('blocks a second cross-match attempt (status no longer requested)', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/cross-match`).send({
        cross_match_status: 'compatible',
      });
      expect(res.statusCode).toBe(400);
    });

    it('issues blood after compatible cross-match and advances status=issued', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/issue`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('issued');
      expect(res.body.data.issued_by).toBe(BLOOD_BANK_UID);
      expect(res.body.data.issued_at).toBeTruthy();
    });

    it('records transfusion without reaction and advances status=transfused', async () => {
      // B5: completion is gated on bedside verification; this unit-less
      // legacy request proceeds via the audited override path.
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/transfused`).send({
        transfusion_reaction: false,
        verification_override_reason: 'Legacy unit-less request fixture — bedside scan not possible',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('transfused');
      expect(res.body.data.transfused_at).toBeTruthy();
    });

    it('blocks further transitions from terminal transfused state', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/transfused`).send({
        transfusion_reaction: false,
        verification_override_reason: 'Legacy unit-less request fixture — bedside scan not possible',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('incompatible cross-match branch', () => {
    let requestId;

    beforeAll(async () => {
      const res = await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID,
        blood_group: 'AB-', component: 'ffp', units: 1,
        urgency: 'emergency',
        clinical_indication: 'DIC, active bleeding',
      });
      requestId = res.body.data.id;
    });

    it('records an incompatible cross-match (status advances but flag stays)', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/cross-match`).send({
        cross_match_status: 'incompatible',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.cross_match_status).toBe('incompatible');
      expect(res.body.data.status).toBe('cross_matched');
    });

    it('refuses to issue blood when cross-match was incompatible', async () => {
      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/issue`);
      expect(res.statusCode).toBe(400);
      expect(String(res.body.message || '')).toMatch(/incompatible/i);
    });
  });

  describe('reaction during transfusion is captured in notes', () => {
    let requestId;

    beforeAll(async () => {
      const r1 = await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID,
        blood_group: 'B+', component: 'prbc', units: 1,
        clinical_indication: 'Anaemia workup',
      });
      requestId = r1.body.data.id;
      await bloodStaff.put(`/api/v1/blood-bank/${requestId}/cross-match`).send({
        cross_match_status: 'compatible',
      });
      await bloodStaff.put(`/api/v1/blood-bank/${requestId}/issue`);
    });

    it('appends the transfusion reaction into notes (no dedicated column exists)', async () => {
      // B5: bedside verification now gates completion. This legacy request
      // pinned no blood_units row at crossmatch, so there is nothing to
      // scan — the silent path must 409 and the audited unit-less override
      // proceeds.
      const gated = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/transfused`).send({
        transfusion_reaction: 'Mild fever, chills — resolved after paracetamol',
      });
      expect(gated.statusCode).toBe(409);

      const res = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/transfused`).send({
        transfusion_reaction: 'Mild fever, chills — resolved after paracetamol',
        verification_override_reason: 'Legacy unit-less request fixture — bedside scan not possible',
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.$queryRawUnsafe(
        `SELECT notes, status, transfused_at FROM blood_requests WHERE id = $1`, requestId);
      expect(row[0].status).toBe('transfused');
      expect(row[0].transfused_at).toBeTruthy();
      expect(row[0].notes).toMatch(/Transfusion reaction:/);
      expect(row[0].notes).toMatch(/Mild fever/);
    });
  });

  describe('inventory + pending views', () => {
    it('returns inventory aggregated by blood_group + component with integer counts', async () => {
      const res = await bloodStaff.get('/api/v1/blood-bank/inventory');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // We've created at least 3 requests above — there should be at least one row
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const r of res.body.data) {
        // All count columns are ::int-cast so they're real numbers, not BigInt strings
        expect(typeof r.total_requests).toBe('number');
        expect(typeof r.transfused_units).toBe('number');
      }
    });

    it('returns pending requests filtered by blood_group', async () => {
      // Create a fresh pending request that should appear
      await doctor.post('/api/v1/blood-bank/request').send({
        patient_uid: PATIENT_UID,
        blood_group: 'A-', component: 'platelets', units: 1,
        urgency: 'urgent',
        clinical_indication: 'Thrombocytopenia',
      });

      const res = await bloodStaff.get('/api/v1/blood-bank/pending?blood_group=A-&urgency=urgent');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      for (const r of res.body.data) {
        expect(r.blood_group).toBe('A-');
        expect(r.urgency).toBe('urgent');
        expect(['requested', 'cross_matched']).toContain(r.status);
      }
    });

    it('sorts emergency before urgent before routine in pending view', async () => {
      const res = await bloodStaff.get('/api/v1/blood-bank/pending');
      expect(res.statusCode).toBe(200);
      const rank = { emergency: 1, urgent: 2, routine: 3 };
      let last = 0;
      for (const r of res.body.data) {
        const rr = rank[r.urgency] || 99;
        expect(rr).toBeGreaterThanOrEqual(last);
        last = rr;
      }
    });
  });

  describe('auth', () => {
    it('rejects unauthenticated inventory request', async () => {
      const res = await request(app).get('/api/v1/blood-bank/inventory');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('forbids PATIENT role from the inventory view', async () => {
      const patient = mkClient('PATIENT', PATIENT_UID, patientIntId);
      const res = await patient.get('/api/v1/blood-bank/inventory');
      expect([401, 403]).toContain(res.statusCode);
    });
  });
});
