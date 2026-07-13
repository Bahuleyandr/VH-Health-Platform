// Deep integration tests for vitals recording + anomaly alert generation.
// Exercises vitals_chart persistence, trend/latest/chart queries, and verifies that
// out-of-range vitals create clinical_alerts rows via vitalSignMonitor.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { istDateString } from '../utils/dateUtils.js';

const PATIENT_UID = 'a2222222-2222-4222-8222-222222222a01';
const RECORDER_UID = 'a2222222-2222-4222-8222-222222222a02';
const ANC_UID = 'a2222222-2222-4222-8222-222222222a04';
const PATIENT_PHONE = '9000020001';
const ANC_PHONE = '9000020004';
const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function doctorAs(uid = RECORDER_UID, id = 990201) {
  const token = generateTestToken('DOCTOR', { uid, id });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: (p) => request(app).patch(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function clearCareTeam(patientUid) {
  await prisma.$executeRawUnsafe(`DELETE FROM care_team_members WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM care_teams WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
}

async function grantDoctorCareTeam(patientUid, displayName) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO care_teams
       (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'longitudinal', $3, 'active', $4::uuid, NOW())
     RETURNING id`,
    TENANT_ID,
    patientUid,
    displayName,
    RECORDER_UID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO care_team_members
       (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
        relationship_kind, break_glass_allowed, created_by, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'DOCTOR', 'Vitals Test Doctor',
             'attending_doctor', true, $4::uuid, NOW())`,
    TENANT_ID,
    rows[0].id,
    patientUid,
    RECORDER_UID,
  );
}

// audit_logs is append-only (mig-324 audit-chain hardening): a DELETE is blocked
// unless an authorized maintenance path opts in via the transaction-local
// app.audit_bypass = 'on' GUC. Test fixture cleanup is exactly that path.
async function purgeCorrectVitalsAudit(recorderUid) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE uid = $1::uuid AND action = 'CORRECT_VITALS'`,
      recorderUid,
    );
  });
}

describe('EMR vitals + anomaly alerts — deep integration', () => {
  const doctor = doctorAs();
  let patientIntId;
  let recorderIntId;
  let ancPatientIntId;

  beforeAll(async () => {
    // Cleanup — delete alerts + vitals tied to our fixtures
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, ANC_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, ANC_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM intake_output WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await purgeCorrectVitalsAudit(RECORDER_UID);
    // clinical_alerts keyed by int patient_id — look it up first, then delete
    const existing = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT_UID);
    if (existing.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, existing[0].id);
    }
    const existingAnc = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, ANC_UID);
    if (existingAnc.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, existingAnc[0].id);
    }
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE visit_no LIKE 'EMER-VITALS-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE visit_no LIKE 'ANC-VITALS-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM emergency_visits WHERE visit_number LIKE 'EMER-VITALS-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM maternity_pregnancies WHERE patient_uid = $1::uuid`, ANC_UID);
    await clearCareTeam(PATIENT_UID);
    await clearCareTeam(ANC_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`, PATIENT_UID, RECORDER_UID, ANC_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Vitals Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    const recorder = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000020002', 'Vitals Test Doctor', 'DOCTOR', true, NOW())
       RETURNING id`,
      RECORDER_UID);
    recorderIntId = recorder[0].id;

    const ancPatient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, gender, is_active, updated_at)
       VALUES ($1::uuid, $2, 'ANC Vitals Test Patient', 'PATIENT', 'Female', true, NOW())
       RETURNING id`,
      ANC_UID, ANC_PHONE);
    ancPatientIntId = ancPatient[0].id;

    await grantDoctorCareTeam(PATIENT_UID, 'Vitals Test Patient care team');
    await grantDoctorCareTeam(ANC_UID, 'ANC Vitals Test Patient care team');

    await prisma.$executeRawUnsafe(
      `INSERT INTO maternity_pregnancies
         (patient_uid, pregnancy_number, lmp_date, gravida, parity, living_children,
          abortions, high_risk_reasons, status, created_by, updated_at)
       VALUES ($1::uuid, 1, (CURRENT_DATE - INTERVAL '24 weeks')::date,
               1, 0, 0, 0, ARRAY[]::text[], 'ongoing', $2::uuid, NOW())`,
      ANC_UID, RECORDER_UID);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, ANC_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, ANC_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM intake_output WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await purgeCorrectVitalsAudit(RECORDER_UID).catch(() => {});
    if (patientIntId) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, patientIntId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE visit_no LIKE 'EMER-VITALS-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE visit_no LIKE 'ANC-VITALS-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM emergency_visits WHERE visit_number LIKE 'EMER-VITALS-%'`).catch(() => {});
    const existingAnc = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, ANC_UID).catch(() => []);
    if (existingAnc.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, existingAnc[0].id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM maternity_pregnancies WHERE patient_uid = $1::uuid`, ANC_UID).catch(() => {});
    await clearCareTeam(PATIENT_UID);
    await clearCareTeam(ANC_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`, PATIENT_UID, RECORDER_UID, ANC_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects vitals without a patient identifier', async () => {
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

    it('preserves caller-supplied recovery observation timestamps', async () => {
      const observedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 82,
        systolic_bp: 120,
        recorded_at: observedAt,
      });

      expect(res.statusCode).toBe(201);
      expect(new Date(res.body.data.vitals.recorded_at).toISOString()).toBe(observedAt);

      const row = await prisma.$queryRawUnsafe(
        `SELECT recorded_at FROM vitals_chart WHERE id = $1`,
        res.body.data.vitals.id,
      );
      expect(new Date(row[0].recorded_at).toISOString()).toBe(observedAt);
    });

    it('corrects a recent vitals row and records an audit trail', async () => {
      const res = await doctor.put(`/api/v1/emr/vitals/${normalVitalsId}`).send({
        temperature: 36.9,
        notes: 'Corrected within 5 minutes',
      });
      expect(res.statusCode).toBe(200);
      expect(parseFloat(res.body.data.temperature)).toBe(36.9);
      expect(res.body.data.notes).toBe('Corrected within 5 minutes');
    });

    it('accepts PATCH as an alias of PUT for partial corrections', async () => {
      // The HTTP-correct verb for a partial update is PATCH, and at least
      // one swarm finding (surgical-day-care-nurse-3f022b39) saw nurses
      // get a 404 because only PUT was wired. Both verbs route to the same
      // handler so a PATCH-flavoured client gets identical semantics.
      const res = await doctor.patch(`/api/v1/emr/vitals/${normalVitalsId}`).send({
        pain_score: 3,
        notes: 'PATCH alias works',
      });
      expect(res.statusCode).toBe(200);
      // pain_score is a NUMERIC column and Prisma serialises it as a
      // string; match the same pattern other vitals tests use.
      expect(Number(res.body.data.pain_score)).toBe(3);
      expect(res.body.data.notes).toBe('PATCH alias works');

      const latest = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/latest`);
      expect(latest.statusCode).toBe(200);
      expect(latest.body.data.id).toBe(normalVitalsId);
      expect(parseFloat(latest.body.data.temperature)).toBe(36.9);

      const auditRows = await prisma.$queryRawUnsafe(
        `SELECT action, resource, metadata
         FROM audit_logs
         WHERE uid = $1::uuid AND action = 'CORRECT_VITALS' AND resource_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        RECORDER_UID, String(normalVitalsId));
      expect(auditRows.length).toBe(1);
      expect(auditRows[0].resource).toBe('vitals_chart');
      // The most-recent audit row is this PATCH (the prior test's PUT only
      // touched temperature + notes). Assert on what *this* call mutated.
      expect(auditRows[0].metadata.corrected_fields).toContain('pain_score');

      const canonicalAudit = await prisma.$queryRawUnsafe(
        `SELECT actor_uid, actor_role, before_state, after_state
           FROM clinical_audit_events
          WHERE resource_table = 'vitals_chart' AND resource_id = $1
            AND action = 'vitals.corrected'
          ORDER BY occurred_at DESC LIMIT 1`,
        String(normalVitalsId),
      );
      expect(canonicalAudit).toHaveLength(1);
      expect(String(canonicalAudit[0].actor_uid)).toBe(RECORDER_UID);
      expect(canonicalAudit[0].actor_role).toBe('DOCTOR');
      expect(canonicalAudit[0].before_state.corrected_fields).toHaveProperty('pain_score');
      expect(canonicalAudit[0].after_state.corrected_fields).toHaveProperty('pain_score');
    });

    it('accepts patient_id when patient_uid is not supplied', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_id: patientIntId,
        heart_rate: 84,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.patient_uid).toBe(PATIENT_UID);
    });

    it('allows latest-vitals lookup by integer patient_id for walk-in handoffs', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_id: patientIntId,
        weight_kg: 12.5,
        height_cm: 87,
        respiratory_rate: 30,
        temperature: 38.6,
        temperature_route: 'axillary',
      });
      expect(res.statusCode).toBe(201);

      const latest = await doctor.get(`/api/v1/emr/vitals/${patientIntId}/latest`);
      expect(latest.statusCode).toBe(200);
      expect(latest.body.data.id).toBe(res.body.data.vitals.id);
      expect(parseFloat(latest.body.data.weight_kg)).toBe(12.5);
      expect(parseFloat(latest.body.data.height_cm)).toBe(87);
      expect(parseFloat(latest.body.data.respiratory_rate)).toBe(30);
      expect(latest.body.data.temperature_route).toBe('axillary');
    });

    it('records ATS triage acuity and preserves terminology on the emergency queue spine', async () => {
      const visitNo = `EMER-VITALS-${Date.now()}`;
      const today = istDateString();
      const visitRows = await prisma.$queryRawUnsafe(
        `INSERT INTO emergency_visits
           (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint,
            status, created_by, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000001'::uuid,
                 $1, $2::uuid, 'walk_in', 'Acute breathlessness',
                 'arriving', $3::uuid, NOW())
         RETURNING id`,
        visitNo,
        PATIENT_UID,
        RECORDER_UID,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO appointments
         (phone, patient_id, doctor_name, patient_name, appointment_date,
            appointment_time, status, token_number, department, visit_type,
            visit_no, confirmed_at, created_at, updated_at)
         VALUES ($1, $2, '', 'Vitals Test Patient', $3::date,
                 '09:15', 'CONFIRMED', 'EMER-001', 'Emergency', 'EMERGENCY',
                 $4, NOW(), NOW(), NOW())`,
        PATIENT_PHONE,
        patientIntId,
        today,
        visitNo,
      );

      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_id: patientIntId,
        visit_id: visitRows[0].id,
        triage_priority: 'ATS-2',
        heart_rate: 118,
        respiratory_rate: 25,
        spo2: 92,
        systolic_bp: 110,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.triage_acuity).toBe(2);
      expect(res.body.data.triage.triage_priority).toBe('ats_2');
      expect(res.body.data.triage.emergency_visit_id).toBe(visitRows[0].id);
      expect(res.body.data.news2?.total_score).toBeGreaterThanOrEqual(5);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT vc.triage_acuity AS vitals_acuity,
                ev.triage_priority,
                a.triage_acuity AS appointment_acuity
           FROM vitals_chart vc
           CROSS JOIN emergency_visits ev
           JOIN appointments a ON a.visit_no = ev.visit_number
          WHERE vc.id = $1
            AND ev.id = $2`,
        res.body.data.vitals.id,
        visitRows[0].id,
      );
      expect(rows[0].vitals_acuity).toBe(2);
      expect(rows[0].triage_priority).toBe('ats_2');
      expect(rows[0].appointment_acuity).toBe(2);
    });

    it('propagates ANC vitals triage acuity to the doctor queue appointment row', async () => {
      const visitNo = `ANC-VITALS-${Date.now()}`;
      const today = istDateString();
      const apptRows = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (phone, patient_id, doctor_id, doctor_name, patient_name,
            appointment_date, appointment_time, status, token_number,
            department, visit_type, visit_no, confirmed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'Vitals Test Doctor', 'ANC Vitals Test Patient',
                 $4::date, '10:15', 'CONFIRMED', 'ANC-001',
                 'Obstetric ANC', 'NEW', $5, NOW(), NOW(), NOW())
         RETURNING id`,
        ANC_PHONE,
        ancPatientIntId,
        recorderIntId,
        today,
        visitNo,
      );
      const appointmentId = apptRows[0].id;

      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: ANC_UID,
        visit_id: appointmentId,
        triage_acuity: 2,
        systolic_bp: 150,
        diastolic_bp: 96,
        fhr: 142,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.triage).toMatchObject({
        triage_acuity: 2,
        emergency_visit_id: null,
        appointment_id: appointmentId,
      });

      const recorderDoctor = doctorAs(RECORDER_UID, recorderIntId);
      const queue = await recorderDoctor.get('/api/v1/appointments/queue/today');
      expect(queue.statusCode).toBe(200);
      const ancRow = queue.body.data.find((row) => row.id === appointmentId);
      expect(ancRow).toBeDefined();
      expect(ancRow.triage_acuity).toBe(2);
      expect(ancRow.triage_priority).toBe('esi_2');
      expect(ancRow.acuity_rank).toBe(2);
      expect(ancRow.is_emergent).toBe(true);
    });

    // Finding: 2026-05-17-obstetric-anc-nurse-6fe6f592.
    // POST /api/v1/emr/vitals previously dropped `visit_id` entirely
    // (the controller destructured it but the service never used it),
    // so the persisted vitals_chart row stayed encounter_id=null even
    // when the nurse explicitly supplied visit_id. The doctor's screen
    // then couldn't tie the vitals to today's consult.
    it('persists encounter_id from a supplied visit_id (regression for orphan vitals)', async () => {
      // Seed a fresh emergency-visits row so visit_id is a valid integer
      // pointer the controller can resolve.
      const visitNo = `EMER-VITALS-LINK-${Date.now()}`;
      const visitRows = await prisma.$queryRawUnsafe(
        `INSERT INTO emergency_visits
           (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint,
            status, created_by, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000001'::uuid,
                 $1, $2::uuid, 'walk_in', 'Acute headache',
                 'arriving', $3::uuid, NOW())
         RETURNING id`,
        visitNo, PATIENT_UID, RECORDER_UID,
      );
      const visitId = visitRows[0].id;

      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_id: patientIntId,
        visit_id: visitId,
        heart_rate: 88,
        systolic_bp: 118,
        diastolic_bp: 76,
        respiratory_rate: 16,
        spo2: 98,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.encounter_id).toBe(visitId);
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

    it('raises a critical pre-eclampsia screen alert for ANC hypertension with proteinuria', async () => {
      const ancPatient = await prisma.$queryRawUnsafe(
        `SELECT id FROM users WHERE uid = $1::uuid`,
        ANC_UID,
      );
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: ANC_UID,
        systolic_bp: 150,
        diastolic_bp: 95,
        urine_albumin: '2+',
        fhr: 142,
        fundal_height_cm: 24,
      });
      expect(res.statusCode).toBe(201);
      const alert = (res.body.data.alerts || []).find((a) => a.vital_name === 'preeclampsia_screen');
      expect(alert).toBeDefined();
      expect(alert.severity).toBe('CRITICAL');

      const persisted = await prisma.$queryRawUnsafe(
        `SELECT vital_name, severity, message
           FROM clinical_alerts
          WHERE patient_id = $1
            AND vital_name = 'preeclampsia_screen'
          ORDER BY created_at DESC
          LIMIT 1`,
        ancPatient[0].id,
      );
      expect(persisted.length).toBe(1);
      expect(persisted[0].severity).toBe('CRITICAL');
      expect(persisted[0].message).toMatch(/pre-eclampsia/i);
    });

    it('warns at exactly 140/90 without proteinuria (gestational HTN boundary)', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: ANC_UID,
        systolic_bp: 140,
        diastolic_bp: 90,
        urine_albumin: 'negative',
      });
      expect(res.statusCode).toBe(201);
      const alerts = res.body.data.alerts || [];
      // Negative urine → no combined CRITICAL pre-eclampsia screen ...
      expect(alerts.find((a) => a.vital_name === 'preeclampsia_screen')).toBeUndefined();
      // ... but the exact 140/90 boundary must still warn (gestational HTN is
      // defined at ≥140/90; the range check uses `> max`, so max=139/89).
      const bpAlert = alerts.find(
        (a) => (a.vital_name === 'systolic_bp' || a.vital_name === 'diastolic_bp')
          && a.severity === 'WARNING',
      );
      expect(bpAlert).toBeDefined();
      expect(bpAlert.message).toMatch(/pregnancy-induced hypertension/i);
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

  describe('temperature_route (migration 225)', () => {
    it('persists temperature_route alongside the temperature value', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 38.5,
        temperature_route: 'axillary',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.temperature_route).toBe('axillary');
      const row = await prisma.$queryRawUnsafe(
        `SELECT temperature_route FROM vitals_chart WHERE id = $1`, res.body.data.vitals.id);
      expect(row[0].temperature_route).toBe('axillary');
    });

    it('lowercases and trims the recorded route', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 37.0,
        temperature_route: '  Oral ',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.temperature_route).toBe('oral');
    });

    it('rejects an unknown temperature route', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 37.0,
        temperature_route: 'forehead',
      });
      expect(res.statusCode).toBe(400);
    });

    it('leaves temperature_route null when omitted', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 36.9,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.vitals.temperature_route).toBeNull();
    });
  });

  describe('paediatric growth percentile (growth-not-linked-to-vitals + 4354eb08)', () => {
    const PAEDS_UID = 'a2222222-2222-4222-8222-222222222a03';

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PAEDS_UID);
      await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PAEDS_UID);
      await clearCareTeam(PAEDS_UID);
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PAEDS_UID);
      // ~2-year-old (730 days) male — the Baby Aarav cohort from 4354eb08.
      const dob = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, gender, birthday, is_active, updated_at)
         VALUES ($1::uuid, '9000020003', 'Growth Test Toddler', 'PATIENT', 'Male', $2::date, true, NOW())`,
        PAEDS_UID, dob);
      await grantDoctorCareTeam(PAEDS_UID, 'Growth Test Toddler care team');
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PAEDS_UID).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PAEDS_UID).catch(() => {});
      await clearCareTeam(PAEDS_UID);
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PAEDS_UID).catch(() => {});
    });

    it('auto-computes WHO weight + height percentiles in the vitals response', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PAEDS_UID,
        weight_kg: 12.5,
        height_cm: 87,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.growth).not.toBeNull();
      expect(res.body.data.growth.reference_dataset).toBe('WHO_0_5');
      expect(res.body.data.growth.metrics.weight_kg.percentile).toBeGreaterThan(0);
      expect(res.body.data.growth.metrics.weight_kg.percentile).toBeLessThan(100);
      expect(res.body.data.growth.metrics.height_cm.percentile).toBeGreaterThan(0);
    });

    // Finding 2026-05-22-pediatric-opd-nurse-d9b616dc: the percentile was
    // computed only in the POST response and never persisted, so a doctor
    // opening the chart/latest later saw weight/height with NO growth context.
    // The read path now recomputes the snapshot from the stored measurement +
    // the patient's age/sex, so the value survives the round-trip and matches
    // exactly what the nurse saw at triage.
    it('returns the same growth percentiles on latest read-back (not transient)', async () => {
      const post = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PAEDS_UID,
        weight_kg: 12.5,
        height_cm: 87,
      });
      expect(post.statusCode).toBe(201);
      const posted = post.body.data.growth;
      expect(posted).not.toBeNull();
      const postedWeightPct = posted.metrics.weight_kg.percentile;
      const postedHeightPct = posted.metrics.height_cm.percentile;
      const postedVitalsId = post.body.data.vitals.id;

      const latest = await doctor.get(`/api/v1/emr/vitals/${PAEDS_UID}/latest`);
      expect(latest.statusCode).toBe(200);
      // The read-back must be the row we just wrote ...
      expect(latest.body.data.id).toBe(postedVitalsId);
      // ... and must carry the same WHO growth context, not drop it.
      expect(latest.body.data.growth).not.toBeNull();
      expect(latest.body.data.growth.reference_dataset).toBe('WHO_0_5');
      expect(latest.body.data.growth.metrics.weight_kg.percentile).toBe(postedWeightPct);
      expect(latest.body.data.growth.metrics.height_cm.percentile).toBe(postedHeightPct);
      // z-scores survive too, so the "below 5th percentile" band is reconstructable.
      expect(latest.body.data.growth.metrics.weight_kg.z_score)
        .toBe(posted.metrics.weight_kg.z_score);
    });

    it('returns recomputed growth percentiles on chart read-back', async () => {
      const post = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PAEDS_UID,
        weight_kg: 12.5,
        height_cm: 87,
      });
      expect(post.statusCode).toBe(201);
      const postedWeightPct = post.body.data.growth.metrics.weight_kg.percentile;
      const postedVitalsId = post.body.data.vitals.id;

      const chart = await doctor.get(`/api/v1/emr/vitals/${PAEDS_UID}/chart?limit=50`);
      expect(chart.statusCode).toBe(200);
      const row = chart.body.data.find((r) => r.id === postedVitalsId);
      expect(row).toBeDefined();
      expect(row.growth).not.toBeNull();
      expect(row.growth.metrics.weight_kg.percentile).toBe(postedWeightPct);
    });

    it('latest read-back carries growth: null for a non-paediatric patient', async () => {
      // The adult fixture has weight but no DOB/sex cohort → no percentile,
      // and the recompute on read must not invent one or error.
      const post = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        weight_kg: 70,
        height_cm: 170,
      });
      expect(post.statusCode).toBe(201);
      expect(post.body.data.growth).toBeNull();

      const latest = await doctor.get(`/api/v1/emr/vitals/${PATIENT_UID}/latest`);
      expect(latest.statusCode).toBe(200);
      expect(latest.body.data.id).toBe(post.body.data.vitals.id);
      expect(latest.body.data.growth).toBeNull();
    });

    it('returns growth: null for a patient with no DOB/sex on file', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        weight_kg: 12.5,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.growth).toBeNull();
    });

    it('omits the growth block when no weight/height is recorded', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PAEDS_UID,
        heart_rate: 110,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.growth).toBeNull();
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

    // Finding 2026-05-21-walk-in-opd-doctor-126619d3: a Fahrenheit temperature
    // (100.4°F ≈ 38°C, a mild OPD fever) was compared against the Celsius
    // critical_max (40.0) and raised a false CRITICAL hyperthermia alert with
    // value=100.4. The reading must be normalized to Celsius — stored as ~38
    // AND alert-evaluated as ~38 — so no alert fires for a normothermic fever.
    it('does NOT raise a false critical alert for a 100.4°F fever (unit normalized)', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 100.4,
        temperature_unit: 'F',
        temperature_route: 'oral',
        heart_rate: 96, systolic_bp: 112, diastolic_bp: 74, spo2: 99, respiratory_rate: 18,
      });
      expect(res.statusCode).toBe(201);
      // Stored as Celsius (~38.0).
      expect(parseFloat(res.body.data.vitals.temperature)).toBeCloseTo(38.0, 1);
      // No temperature alert at all — 38°C is within the adult normal band.
      const tempAlert = (res.body.data.alerts || []).find((a) => a.vital_name === 'temperature');
      expect(tempAlert).toBeUndefined();

      const row = await prisma.$queryRawUnsafe(
        `SELECT temperature FROM vitals_chart WHERE id = $1`, res.body.data.vitals.id);
      expect(parseFloat(row[0].temperature)).toBeCloseTo(38.0, 1);
    });

    it('still raises a CRITICAL alert for genuine hyperpyrexia recorded in Celsius', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 41.0, // unambiguously Celsius, above critical_max 40.0
      });
      expect(res.statusCode).toBe(201);
      const tempAlert = (res.body.data.alerts || []).find((a) => a.vital_name === 'temperature');
      expect(tempAlert).toBeDefined();
      expect(tempAlert.severity).toBe('CRITICAL');
      expect(tempAlert.value).toBeCloseTo(41.0, 1);
      expect(tempAlert.unit).toBe('°C');
    });

    it('still raises a CRITICAL alert for genuine hyperpyrexia recorded in Fahrenheit (105°F)', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        temperature: 105, // ≈ 40.6°C — above the 40.0°C critical threshold
        temperature_unit: 'F',
      });
      expect(res.statusCode).toBe(201);
      const tempAlert = (res.body.data.alerts || []).find((a) => a.vital_name === 'temperature');
      expect(tempAlert).toBeDefined();
      expect(tempAlert.severity).toBe('CRITICAL');
      // Alert value is the normalized Celsius reading, not the raw 105.
      expect(tempAlert.value).toBeCloseTo(40.56, 1);
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

    it('returns OB fhr and fundal-height trends', async () => {
      const fhr = await doctor.get(`/api/v1/emr/vitals/${ANC_UID}/trend?vital=fhr`);
      expect(fhr.statusCode).toBe(200);
      expect(fhr.body.data.some((p) => Number(p.value) === 142)).toBe(true);

      const fundal = await doctor.get(`/api/v1/emr/vitals/${ANC_UID}/trend?vital=fundal_height_cm`);
      expect(fundal.statusCode).toBe(200);
      expect(fundal.body.data.some((p) => Number(p.value) === 24)).toBe(true);
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
      const intake = await doctor.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID, io_type: 'intake', category: 'oral', amount_ml: 500,
      });
      expect(intake.statusCode).toBe(201);
      const balanceDate = new Date(intake.body.data.recorded_at).toISOString().slice(0, 10);
      const output = await doctor.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID, io_type: 'output', category: 'urine', amount_ml: 300,
      });
      expect(output.statusCode).toBe(201);

      const bal = await doctor.get(`/api/v1/emr/io/${PATIENT_UID}/balance?date=${balanceDate}`);
      expect(bal.statusCode).toBe(200);
      expect(bal.body.data.total_intake).toBe(500);
      expect(bal.body.data.total_output).toBe(300);
      expect(bal.body.data.balance).toBe(200);
      expect(bal.body.data.entries.length).toBe(2);
    });
  });
});
