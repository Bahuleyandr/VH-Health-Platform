// Deep integration tests for the bloodbank module.
// Exercises the full lifecycle: request → cross-match → issue → transfused
// with status-machine enforcement and incompatible-match blocking. Validates
// canonical DB columns (no fictional `issued` / `transfused` / `transfusion_reaction`
// columns — they don't exist on blood_requests; the service folds reactions into notes).

import { generateTestToken } from './testClient.js';
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DOCTOR_UID = 'a9999999-9999-4999-8999-999999999a01';
const BLOOD_BANK_UID = 'a9999999-9999-4999-8999-999999999a02';
const PATIENT_UID = 'a9999999-9999-4999-8999-999999999a03';
const SECOND_BLOOD_BANK_UID = 'a9999999-9999-4999-8999-999999999a04';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `bloodbank-test-${randomUUID()}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Bloodbank lifecycle — deep integration', () => {
  let doctor;
  let bloodStaff;
  let secondBloodStaff;
  let doctorIntId, staffIntId, secondStaffIntId, patientIntId;
  let futureExpiryDate;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM transfusion_verifications
        WHERE request_id IN (SELECT id FROM blood_requests WHERE patient_uid = $1::uuid)`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM transfusion_reactions
        WHERE request_id IN (SELECT id FROM blood_requests WHERE patient_uid = $1::uuid)`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM blood_units WHERE unit_number LIKE 'B4SCAN-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM blood_requests WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      DOCTOR_UID, BLOOD_BANK_UID, PATIENT_UID, SECOND_BLOOD_BANK_UID);

    const dateRows = await prisma.$queryRawUnsafe(
      `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '14 days')::date::text AS expiry_date`);
    futureExpiryDate = dateRows[0].expiry_date;

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

    const s2 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000090004', 'Second Blood Bank Tech', 'ADMIN', true, NOW())
       RETURNING id`, SECOND_BLOOD_BANK_UID);
    secondStaffIntId = s2[0].id;

    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId);
    bloodStaff = mkClient('ADMIN', BLOOD_BANK_UID, staffIntId);
    secondBloodStaff = mkClient('ADMIN', SECOND_BLOOD_BANK_UID, secondStaffIntId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM transfusion_verifications
        WHERE request_id IN (SELECT id FROM blood_requests WHERE patient_uid = $1::uuid)`,
      PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM transfusion_reactions
        WHERE request_id IN (SELECT id FROM blood_requests WHERE patient_uid = $1::uuid)`,
      PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM blood_units WHERE unit_number LIKE 'B4SCAN-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM blood_requests WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      DOCTOR_UID, BLOOD_BANK_UID, PATIENT_UID, SECOND_BLOOD_BANK_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  async function createIssuedRequestWithUnit(unitNumber) {
    const requestRes = await doctor.post('/api/v1/blood-bank/request').send({
      patient_uid: PATIENT_UID,
      blood_group: 'O+',
      component: 'prbc',
      units: 1,
      urgency: 'urgent',
      clinical_indication: 'Batch 4 bedside scan fixture',
    });
    expect(requestRes.statusCode).toBe(201);
    const requestId = requestRes.body.data.id;

    const unitRes = await bloodStaff.post('/api/v1/blood-bank/units').send({
      unit_number: unitNumber,
      blood_group: 'O+',
      component: 'prbc',
      expiry_date: futureExpiryDate,
    });
    expect(unitRes.statusCode).toBe(201);
    const unitId = unitRes.body.data.id;

    const crossmatch = await bloodStaff.post(`/api/v1/blood-bank/${requestId}/crossmatch-unit`).send({
      unit_id: unitId,
      result: 'compatible',
    });
    expect(crossmatch.statusCode).toBe(200);

    const issue = await bloodStaff.put(`/api/v1/blood-bank/${requestId}/issue`);
    expect(issue.statusCode).toBe(200);

    return { requestId, unitId };
  }

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

  describe('request retry safety', () => {
    it('replays a lost 201 without duplicating the request or canonical events', async () => {
      const idempotencyKey = `bloodbank-lost-2xx-${randomUUID()}`;
      const clinicalIndication = `Lost 2xx replay regression ${randomUUID()}`;
      const payload = {
        patient_uid: PATIENT_UID,
        blood_group: 'O+',
        component: 'prbc',
        units: 1,
        urgency: 'urgent',
        clinical_indication: clinicalIndication,
      };

      const first = await doctor.post('/api/v1/blood-bank/request')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);
      expect(first.statusCode).toBe(201);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const claims = await prisma.$queryRawUnsafe(
          `SELECT status FROM idempotency_keys
            WHERE request_key = $1 AND request_path = '/api/v1/blood-bank/request'`,
          idempotencyKey,
        );
        if (claims[0]?.status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const retry = await doctor.post('/api/v1/blood-bank/request')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);
      expect(retry.statusCode).toBe(201);
      expect(retry.body).toEqual(first.body);

      const requests = await prisma.$queryRawUnsafe(
        `SELECT id FROM blood_requests
          WHERE patient_uid = $1::uuid AND clinical_indication = $2`,
        PATIENT_UID,
        clinicalIndication,
      );
      expect(requests).toHaveLength(1);

      const timelineEvents = await prisma.$queryRawUnsafe(
        `SELECT id FROM clinical_timeline_events
          WHERE source_table = 'blood_requests'
            AND source_id = $1
            AND event_type = 'transfusion.requested'`,
        String(requests[0].id),
      );
      expect(timelineEvents).toHaveLength(1);

      const auditEvents = await prisma.$queryRawUnsafe(
        `SELECT id FROM clinical_audit_events
          WHERE resource_table = 'blood_requests'
            AND resource_id = $1
            AND action = 'transfusion.requested'`,
        String(requests[0].id),
      );
      expect(auditEvents).toHaveLength(1);
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

  describe('closed-loop transfusion bedside scanning', () => {
    it('wrong unit barcode is a non-overridable hard-stop even with a reason', async () => {
      const { requestId } = await createIssuedRequestWithUnit('B4SCAN-UNIT-409');

      const mismatch = await bloodStaff.post(`/api/v1/blood-bank/${requestId}/verify-bedside`).send({
        verifier_role: 'first',
        scanned_unit_number: 'B4SCAN-OTHER-UNIT',
        scanned_patient_uid: PATIENT_UID,
        override_reason: 'Bag label damaged; attempted manual override at bedside',
      });

      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.body.details).toMatchObject({
        code: 'TRANSFUSION_UNIT_MISMATCH',
        hardStop: true,
        failedRight: 'unit',
      });
    });

    it('records both verifier wristband + unit barcodes before transfusion start', async () => {
      const { requestId } = await createIssuedRequestWithUnit('B4SCAN-UNIT-OK');

      const first = await bloodStaff.post(`/api/v1/blood-bank/${requestId}/verify-bedside`).send({
        verifier_role: 'first',
        scanned_unit_number: 'B4SCAN-UNIT-OK',
        scanned_patient_uid: PATIENT_UID,
      });
      expect(first.statusCode).toBe(200);
      expect(first.body.data.scanned_unit_number).toBe('B4SCAN-UNIT-OK');
      expect(first.body.data.scanned_patient_uid).toBe(PATIENT_UID);

      const second = await secondBloodStaff.post(`/api/v1/blood-bank/${requestId}/verify-bedside`).send({
        verifier_role: 'second',
        scanned_unit_number: 'B4SCAN-UNIT-OK',
        scanned_patient_uid: PATIENT_UID,
      });
      expect(second.statusCode).toBe(200);

      const start = await bloodStaff.post(`/api/v1/blood-bank/${requestId}/start-transfusion`).send({});
      expect(start.statusCode).toBe(200);
      expect(start.body.data.transfusion_started_at).toBeTruthy();

      const rows = await prisma.$queryRawUnsafe(
        `SELECT verifier_role, scanned_unit_number, scanned_patient_uid, unit_match, patient_match, all_checks_passed
           FROM transfusion_verifications
          WHERE request_id = $1
          ORDER BY verifier_role`,
        requestId,
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.scanned_unit_number)).toEqual(['B4SCAN-UNIT-OK', 'B4SCAN-UNIT-OK']);
      expect(rows.map((row) => String(row.scanned_patient_uid))).toEqual([PATIENT_UID, PATIENT_UID]);
      expect(rows.every((row) => row.unit_match && row.patient_match && row.all_checks_passed)).toBe(true);
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
