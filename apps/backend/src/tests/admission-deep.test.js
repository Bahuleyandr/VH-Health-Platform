// Deep integration tests for the ADT (Admission/Discharge/Transfer) flow.
// Unlike emr.test.js (which accepts [200,500] and masks real failures), these tests
// seed the DB, assert exact status codes, and verify row-level side effects.

import { authClient, generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

// Unique v4-shaped UUIDs so the suite is rerunnable and isolated from other tests.
const DOCTOR_UID = 'a1111111-1111-4111-8111-111111111a01';
const PATIENT_UID = 'a1111111-1111-4111-8111-111111111a02';
const ADMIN_UID = 'a1111111-1111-4111-8111-111111111a03';
// A second patient that exists in users but has NO patient_consents row,
// so the admit consent check is the firing condition rather than the
// upstream "patient not found" check (which returned 404 before the
// patient was seeded).
const NO_CONSENT_PATIENT_UID = 'a1111111-1111-4111-8111-111111111a04';
const BEDLESS_PATIENT_UID = 'a1111111-1111-4111-8111-111111111a05';
const PATIENT_PHONE = '9000010001';

const API_KEY = process.env.API_KEY || 'test-api-key';

// Admin with uid matching inserted users row (so ::uuid cast + audit FK is valid)
function adminAs(uid = ADMIN_UID) {
  const token = generateTestToken('ADMIN', { uid, id: 990001 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('EMR admission/discharge/transfer — deep integration', () => {
  const admin = adminAs();
  const general = authClient('GENERAL');
  let wardId;
  let bed1Id;
  let bed2Id;
  let bed3Id;
  let bed4Id;
  let patientIntId;

  beforeAll(async () => {
    // Clean any leftovers from prior runs (in reverse FK order)
    await prisma.$executeRawUnsafe(
      `DELETE FROM bed_transfers WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM follow_up_plans WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE resource = 'admission' AND metadata->>'patient_uid' IN ($1, $2, $3)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE action = 'EMERGENCY_CONSENT_BYPASS' AND resource = 'admissions'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_consents WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number IN ('DEEP-BED-A','DEEP-BED-B','DEEP-BED-C','DEEP-BED-D')`);
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = 'DEEP-TEST-WARD'`);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID);

    // Seed patient (users row)
    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Deep Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = patientRows[0].id;

    // Second patient — exists but deliberately has no patient_consents row
    // so the consent gate is the firing condition for the "no active
    // consent" test below.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010004', 'Deep Test No-Consent Patient', 'PATIENT', true, NOW())`,
      NO_CONSENT_PATIENT_UID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010005', 'Deep Test Bedless Patient', 'PATIENT', true, NOW())`,
      BEDLESS_PATIENT_UID);

    // Admin user (for audit FK — not strictly required since uid FK is soft, but keeps data clean)
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010003', 'Deep Test Admin', 'ADMIN', true, NOW())`,
      ADMIN_UID);

    // Doctor user (if admissions.admitting_doctor had a FK it'd need staff, but it doesn't)
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010002', 'Deep Test Doctor', 'DOCTOR', true, NOW())`,
      DOCTOR_UID);

    // Active treatment consent (required by admitPatient)
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status)
       VALUES ($1::uuid, 'treatment', true, 'active')`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status)
       VALUES ($1::uuid, 'treatment', true, 'active')`,
      BEDLESS_PATIENT_UID);

    // Ward + two beds
    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards
         (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level)
       VALUES ('DEEP-TEST-WARD', 2, 3, 'blue', 'enhanced')
       RETURNING id`
    );
    wardId = wardRows[0].id;

    const bedA = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status) VALUES ($1, 'DEEP-BED-A', 'available') RETURNING id`,
      wardId);
    bed1Id = bedA[0].id;
    const bedB = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status) VALUES ($1, 'DEEP-BED-B', 'available') RETURNING id`,
      wardId);
    bed2Id = bedB[0].id;
    const bedC = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, status) VALUES ($1, 'DEEP-TEST-WARD', 'DEEP-BED-C', 'available') RETURNING id`,
      wardId);
    bed3Id = bedC[0].id;
    // bed4Id is reserved for the "relocates active attendant passes" test —
    // the NSTEMI admit test earlier in this file occupies bed3Id, so the
    // relocates test needs its own fresh bed.
    const bedD = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, status) VALUES ($1, 'DEEP-TEST-WARD', 'DEEP-BED-D', 'available') RETURNING id`,
      wardId);
    bed4Id = bedD[0].id;
  });

  afterAll(async () => {
    // Best-effort teardown — mirror beforeAll in FK-safe order
    await prisma.$executeRawUnsafe(
      `DELETE FROM bed_transfers WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE resource = 'admission' AND metadata->>'patient_uid' IN ($1, $2, $3)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE action = 'EMERGENCY_CONSENT_BYPASS' AND resource = 'admissions'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_consents WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number IN ('DEEP-BED-A','DEEP-BED-B','DEEP-BED-C','DEEP-BED-D')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE id = $1`, wardId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID, NO_CONSENT_PATIENT_UID, BEDLESS_PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  let admissionId;

  describe('authorization', () => {
    it('forbids GENERAL role from admitting patients', async () => {
      const res = await general.post('/api/v1/emr/admit').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('admitPatient', () => {
    it('rejects admission without required fields', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({});
      expect(res.statusCode).toBe(400);
    });

    it('exposes the top-level admission-desk create alias', async () => {
      const res = await admin.post('/api/v1/admissions').send({});
      expect(res.statusCode).toBe(400);
      expect(String(res.body.message || '')).toMatch(/required|patient/i);
    });

    it('rejects admission without active consent', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: NO_CONSENT_PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'chest pain',
        // Elective admission with a real bed so we exercise the consent
        // gate, not the admit-bed gate. Critically, NOT emergency:
        // admission_type='emergency' uses implied-consent bypass (B-4,
        // migration 182) — any emergency qualifies regardless of priority.
        // This test asserts the default rule for non-emergency admits.
        bed_id: bed2Id,
        admission_type: 'elective',
        priority: 'routine',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.code || res.body.message || '')).toMatch(/CONSENT|consent/i);
    });

    it('allows emergency admission without prior consent (implied-consent bypass, priority=urgent)', async () => {
      // Regression for finding 2026-05-08-emergency-walk-in-doctor-admit-consent-blocks-emergency.
      // The consent gate must not block admission_type='emergency' regardless of priority level.
      // Before the fix, only priority='emergent' triggered the bypass; priority='urgent' returned 403.
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: NO_CONSENT_PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'NSTEMI — troponin 0.85 ng/mL, chest pain',
        admitting_diagnosis: 'NSTEMI rule-in',
        admission_type: 'emergency',
        priority: 'urgent',
        bed_id: bed3Id,
        code_status: 'full_code',
        emergency_consent_bypass_reason: 'Implied consent — acute coronary syndrome, verbal consent obtained from daughter',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data?.admission?.id).toBeDefined();

      // Bypass must be recorded on the admission row itself
      const rows = await prisma.$queryRawUnsafe(
        `SELECT emergency_consent_bypass_at, emergency_consent_bypass_reason
         FROM admissions WHERE id = $1`,
        res.body.data.admission.id);
      expect(rows[0].emergency_consent_bypass_at).not.toBeNull();
      expect(rows[0].emergency_consent_bypass_reason).toMatch(/implied consent/i);

      // EMERGENCY_CONSENT_BYPASS audit entry must exist for compliance
      const audits = await prisma.$queryRawUnsafe(
        `SELECT action FROM audit_logs
         WHERE action = 'EMERGENCY_CONSENT_BYPASS' AND resource_id = $1`,
        String(res.body.data.admission.id));
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it('creates admission and occupies the bed', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        department: 'Cardiology',
        ward: 'DEEP-TEST-WARD',
        bed_id: bed1Id,
        chief_complaint: 'chest pain',
        admitting_diagnosis: 'ACS rule-out',
        admission_type: 'emergency',
        priority: 'urgent',
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data?.admission?.id).toBeDefined();
      admissionId = res.body.data.admission.id;

      // Side-effect: bed now occupied + assigned to this patient
      const beds = await prisma.$queryRawUnsafe(
        `SELECT status, patient_id FROM beds WHERE id = $1`, bed1Id);
      expect(beds[0].status).toBe('occupied');
      expect(beds[0].patient_id).toBe(patientIntId);

      // Side-effect: bed_transfers row with admission_id link + reason='Admission'
      const transfers = await prisma.$queryRawUnsafe(
        `SELECT reason, from_bed_id, to_bed_id, admission_id
         FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID);
      expect(transfers.length).toBe(1);
      expect(transfers[0].reason).toBe('Admission');
      expect(transfers[0].from_bed_id).toBeNull();
      expect(transfers[0].to_bed_id).toBe(bed1Id);
      expect(transfers[0].admission_id).toBe(admissionId);

      // Side-effect: audit_log written with correct canonical columns
      const audits = await prisma.$queryRawUnsafe(
        `SELECT uid, action, resource, resource_id, metadata FROM audit_logs
         WHERE resource = 'admission' AND resource_id = $1 AND action = 'ADMIT_PATIENT'`,
        String(admissionId));
      expect(audits.length).toBe(1);
      expect(audits[0].action).toBe('ADMIT_PATIENT');
      expect(audits[0].metadata).toMatchObject({ patient_uid: PATIENT_UID, admission_type: 'emergency' });
    });

    it('exposes top-level admission-desk read aliases', async () => {
      const list = await admin.get('/api/v1/admissions');
      expect(list.statusCode).toBe(200);
      expect(Array.isArray(list.body.data)).toBe(true);

      const stats = await admin.get('/api/v1/admissions/stats');
      expect(stats.statusCode).toBe(200);
      expect(stats.body.data).toMatchObject({
        total_beds: expect.any(Number),
        occupied_beds: expect.any(Number),
      });

      const history = await admin.get(`/api/v1/admissions/patient/${PATIENT_UID}`);
      expect(history.statusCode).toBe(200);
      expect(history.body.data?.admissions?.some((a) => a.id === admissionId)).toBe(true);

      const detail = await admin.get(`/api/v1/admissions/${admissionId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.body.data?.admission?.id).toBe(admissionId);
    });

    it('rejects a second active admission for the same patient', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'duplicate',
        // Bedless-emergency exception (migration 171) so the admit-bed
        // gate passes and the duplicate-active-admission check is the
        // firing condition.
        admission_type: 'emergency',
        priority: 'emergent',
      });
      expect(res.statusCode).toBe(409);
    });

    it('relocates active attendant passes when a bedless emergency admission gets a final bed', async () => {
      const admit = await admin.post('/api/v1/emr/admit').send({
        patient_uid: BEDLESS_PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        department: 'Emergency',
        ward: 'Emergency Holding',
        chief_complaint: 'Peritonitis with no bed ready',
        admitting_diagnosis: 'Acute abdomen',
        admission_type: 'emergency',
        priority: 'emergent',
        emergency_consent_bypass_reason: 'Life-saving emergency admission',
      });
      expect(admit.statusCode).toBe(201);
      const bedlessAdmissionId = admit.body.data.admission.id;

      const before = await prisma.$queryRawUnsafe(
        `SELECT ward_at_issue
           FROM attendant_passes
          WHERE admission_id = $1
          ORDER BY pass_index`,
        bedlessAdmissionId,
      );
      expect(before).toHaveLength(2);
      expect(before.every((p) => p.ward_at_issue === 'Emergency Holding')).toBe(true);

      const assigned = await admin.post(`/api/v1/emr/${bedlessAdmissionId}/assign-bed`).send({
        bed_id: bed4Id,
      });
      expect(assigned.statusCode).toBe(200);

      const after = await prisma.$queryRawUnsafe(
        `SELECT ward_at_issue, pass_color, screening_level
           FROM attendant_passes
          WHERE admission_id = $1
          ORDER BY pass_index`,
        bedlessAdmissionId,
      );
      expect(after).toHaveLength(2);
      expect(after.every((p) => p.ward_at_issue === 'DEEP-TEST-WARD')).toBe(true);
      expect(after.every((p) => p.pass_color === 'blue')).toBe(true);
      expect(after.every((p) => p.screening_level === 'enhanced')).toBe(true);
    });
  });

  describe('transferPatient', () => {
    it('rejects transfer without to_bed_id', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/transfer`).send({ reason: 'ICU' });
      expect(res.statusCode).toBe(400);
    });

    it('moves the patient to a new bed and records a transfer', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/transfer`).send({
        to_bed_id: bed2Id,
        reason: 'Stepdown',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.status).toBe('transferred');

      const bedA = await prisma.$queryRawUnsafe(`SELECT status, patient_id FROM beds WHERE id = $1`, bed1Id);
      const bedB = await prisma.$queryRawUnsafe(`SELECT status, patient_id FROM beds WHERE id = $1`, bed2Id);
      expect(bedA[0].status).toBe('available');
      expect(bedA[0].patient_id).toBeNull();
      expect(bedB[0].status).toBe('occupied');
      expect(bedB[0].patient_id).toBe(patientIntId);

      const transfers = await prisma.$queryRawUnsafe(
        `SELECT reason, from_bed_id, to_bed_id FROM bed_transfers
         WHERE patient_uid = $1::uuid AND reason = 'Stepdown'`, PATIENT_UID);
      expect(transfers.length).toBe(1);
      expect(transfers[0].from_bed_id).toBe(bed1Id);
      expect(transfers[0].to_bed_id).toBe(bed2Id);
    });
  });

  describe('updateCodeStatus', () => {
    it('rejects invalid code_status', async () => {
      const res = await admin.put(`/api/v1/emr/${admissionId}/code-status`).send({
        code_status: 'BOGUS',
      });
      expect(res.statusCode).toBe(400);
    });

    it('updates code status to DNR and writes audit log', async () => {
      const res = await admin.put(`/api/v1/emr/${admissionId}/code-status`).send({
        code_status: 'dnr',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.code_status).toBe('dnr');

      const audits = await prisma.$queryRawUnsafe(
        `SELECT action, metadata FROM audit_logs
         WHERE resource_id = $1 AND action = 'UPDATE_CODE_STATUS'`,
        String(admissionId));
      expect(audits.length).toBeGreaterThan(0);
      expect(audits[audits.length - 1].metadata).toMatchObject({ new: 'dnr' });
    });
  });

  describe('dischargePatient', () => {
    it('rejects discharge without discharge_type', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects discharge with invalid discharge_type', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'BOGUS',
      });
      expect(res.statusCode).toBe(400);
    });

    it('blocks home discharge when no finalized invoice exists', async () => {
      // Drive cascade pre-reqs only — no billing_closed_at, no invoices —
      // and assert the NO_INVOICE blocker fires.
      await prisma.$executeRawUnsafe(
        `UPDATE admissions
            SET discharge_initiated_at = NOW(),
                summary_signed_at = NOW(),
                discharge_drugs_dispensed_at = NOW(),
                billing_closed_at = NULL
          WHERE id = $1`,
        admissionId,
      );
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
        discharge_summary: { notes: 'attempt without invoice' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.code || res.body.details?.code || '').toBe('DISCHARGE_NOT_READY');
      const types = (res.body.details?.blockers || []).map((b) => b.type);
      expect(types).toContain('NO_INVOICE');
    });

    it('discharges, releases the bed, and records audit', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE admissions
            SET discharge_initiated_at = NOW(),
                summary_signed_at = NOW(),
                discharge_drugs_dispensed_at = NOW(),
                billing_closed_at = NOW()
          WHERE id = $1`,
        admissionId,
      );

      // Final-discharge readiness gate (chip B, finding
      // 2026-05-10-surgical-day-care-discharge-followup-not-in-readiness)
      // requires an open/scheduled follow_up_plans row for the admission
      // patient — POD1 review handoff is mandatory. Seed one for the
      // happy-path discharge test.
      await prisma.$executeRawUnsafe(
        `INSERT INTO follow_up_plans
           (tenant_id, patient_uid, origin_kind, reason, status, due_at)
         VALUES
           ('00000000-0000-4000-8000-000000000001'::uuid, $1::uuid,
            'admission_discharge', 'POD1 review for deep-test admission',
            'open', NOW() + INTERVAL '7 days')`,
        PATIENT_UID,
      );

      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
        discharge_summary: { notes: 'Follow up in 2 weeks' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.status).toBe('discharged');
      expect(res.body.data?.admission?.los_days).toBeGreaterThanOrEqual(1);

      // Bed released
      const bedB = await prisma.$queryRawUnsafe(`SELECT status, patient_id FROM beds WHERE id = $1`, bed2Id);
      expect(bedB[0].status).toBe('cleaning');
      expect(bedB[0].patient_id).toBeNull();

      const housekeeping = await prisma.$queryRawUnsafe(
        `SELECT status, request_type, urgency
           FROM housekeeping_requests
          WHERE description LIKE $1`,
        `%admission #${admissionId}%`,
      );
      expect(housekeeping.length).toBe(1);
      expect(housekeeping[0]).toMatchObject({
        status: 'open',
        request_type: 'cleaning',
        urgency: 'high',
      });

      // Admission row shows discharged state
      const adm = await prisma.$queryRawUnsafe(
        `SELECT status, discharge_type, discharged_at FROM admissions WHERE id = $1`, admissionId);
      expect(adm[0].status).toBe('discharged');
      expect(adm[0].discharge_type).toBe('home');
      expect(adm[0].discharged_at).not.toBeNull();

      const audits = await prisma.$queryRawUnsafe(
        `SELECT action FROM audit_logs WHERE resource_id = $1 AND action = 'DISCHARGE_PATIENT'`,
        String(admissionId));
      expect(audits.length).toBe(1);
    });

    it('blocks a second discharge attempt (terminal state)', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('history + stats', () => {
    it('returns the patient\'s admission history with los_days', async () => {
      const res = await admin.get(`/api/v1/emr/admissions/patient/${PATIENT_UID}`);
      expect(res.statusCode).toBe(200);
      const admissions = res.body.data?.admissions || [];
      expect(admissions.length).toBeGreaterThanOrEqual(1);
      const ours = admissions.find((a) => a.id === admissionId);
      expect(ours).toBeDefined();
      expect(ours.status).toBe('discharged');
      expect(ours.los_days).toBeGreaterThanOrEqual(1);
    });

    it('returns admission statistics including bed occupancy', async () => {
      const res = await admin.get('/api/v1/emr/admissions/stats');
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        total_beds: expect.any(Number),
        occupied_beds: expect.any(Number),
        occupancy_rate: expect.any(Number),
      });
    });
  });

  describe('re-admission continuity (migration 230)', () => {
    // After the dischargePatient suite, `admissionId` is a discharged
    // admission for PATIENT_UID with discharged_at ≈ now. A re-admission
    // within the 7-day window must back-link to it via prior_admission_id.
    // Finding: 2026-05-10-surgical-day-care-discharge-readmit-continuity-unlinked.
    let readmissionId;

    it('links a re-admission within 7 days to the prior discharge', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'post-op review — eye pain',
        // Bedless emergency-emergent admit so this case is independent of
        // the bed state left behind by the transfer/discharge suites.
        admission_type: 'emergency',
        priority: 'emergent',
      });
      expect(res.statusCode).toBe(201);
      readmissionId = res.body.data?.admission?.id;
      expect(readmissionId).toBeDefined();
      expect(readmissionId).not.toBe(admissionId);
      expect(res.body.data.admission.prior_admission_id).toBe(admissionId);
    });

    it('surfaces the linked prior admission on the admission detail read', async () => {
      const res = await admin.get(`/api/v1/emr/admission/${readmissionId}`);
      expect(res.statusCode).toBe(200);
      const detail = res.body.data?.admission;
      expect(detail.prior_admission_id).toBe(admissionId);
      expect(detail.prior_admission).toMatchObject({
        id: admissionId,
        discharge_type: 'home',
      });
      expect(detail.prior_admission.discharged_at).not.toBeNull();
    });
  });
});
