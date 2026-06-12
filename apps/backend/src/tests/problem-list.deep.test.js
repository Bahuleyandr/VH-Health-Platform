// Roadmap B7 — longitudinal problem list deep round-trip.
//
// Covers: create (RBAC + dedupe), list ordering, resolve/reactivate flow,
// diagnosis promotion (idempotent), canonical timeline + audit rows landing
// in the same transaction, and the CDS active-problem summary feed.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { getActiveProblemSummary } from '../services/clinical/problemListService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199905${String(Date.now() % 10000).padStart(5, '0')}`;
const DOCTOR_UID = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b701';
let patientUid;
let patientId;
let diagnosisId;
let doctorId;
let doctor;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B7TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_code_bindings WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B7TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE source_table = 'patient_problems'
       AND patient_uid IN (SELECT uid FROM users WHERE name = 'B7TEST Patient')`,
  ).catch(() => {});
  // clinical_audit_events is append-only (C4 hash chain) — deleting rows
  // punches holes that fail document-integrity for the whole tenant.
  // Test rows may accumulate; assertions are scoped to this run's patient.
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_problems WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B7TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM diagnoses WHERE description LIKE 'B7TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B7TEST Patient'`).catch(() => {});
}

d('Problem list — deep round-trip (roadmap B7)', () => {
  beforeAll(async () => {
    await cleanup();
    const doc = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'B7TEST Doctor', 'DOCTOR', true, $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET phone = EXCLUDED.phone,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             is_active = EXCLUDED.is_active,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = NOW()
       RETURNING id, uid`,
      DOCTOR_UID,
      `+9199907${String(Date.now() % 10000).padStart(5, '0')}`,
      DEFAULT_TENANT_ID,
    );
    doctorId = Number(doc[0].id);
    doctor = authClient('DOCTOR', { uid: DOCTOR_UID, id: doctorId, phone: '9990700001' });

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1, 'B7TEST Patient', 'PATIENT', true, $2::uuid, NOW()) RETURNING id, uid`,
      PHONE,
      DEFAULT_TENANT_ID,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, admitting_doctor, attending_doctor,
          admitted_at, ward, bed_number, created_by, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'admitted', $3::uuid, $3::uuid,
          NOW(), 'B7TEST Ward', 'B7T-01', $3::uuid, NOW(), NOW())`,
      DEFAULT_TENANT_ID,
      patientUid,
      DOCTOR_UID,
    );

    const dx = await prisma.$queryRawUnsafe(
      `INSERT INTO diagnoses (tenant_id, patient_uid, icd10_code, icd10_description, description, status, severity)
       VALUES ($1::uuid, $2::uuid, 'B7T.9', 'B7TEST Type 2 diabetes mellitus', 'B7TEST T2DM', 'active', 'moderate')
       RETURNING id`,
      DEFAULT_TENANT_ID,
      patientUid,
    );
    diagnosisId = Number(dx[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  let problemId;

  test('doctor records a problem; nurse cannot', async () => {
    const nurse = await authClient('NURSING_STAFF')
      .post('/api/v1/problems')
      .send({ patient_uid: patientUid, title: 'B7TEST Hypertension' });
    expect(nurse.status).toBe(403);

    const res = await doctor
      .post('/api/v1/problems')
      .send({
        patient_uid: patientUid,
        title: 'B7TEST Hypertension',
        icd10_code: 'B7T.0',
        codings: [{
          system: 'ICD11',
          code: 'BA00',
          display: 'Essential hypertension',
          release_id: '2026-01',
          linearization_uri: 'http://id.who.int/icd/release/11/2026-01/mms/123',
          foundation_uri: 'http://id.who.int/icd/entity/123',
        }],
        is_chronic: true,
        severity: 'moderate',
        onset_date: '2024-04-01',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.problem).toMatchObject({
      title: 'B7TEST Hypertension',
      status: 'active',
      icd10_code: 'B7T.0',
      is_chronic: true,
    });
    expect(res.body.data.problem.codings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system_key: 'ICD10', code: 'B7T.0' }),
      expect.objectContaining({ system_key: 'ICD11', code: 'BA00' }),
    ]));
    problemId = res.body.data.problem.id;
    expect(Number(res.body.data.problem.patient_id)).toBe(patientId);
  });

  test('same-transaction canonical timeline + audit rows exist', async () => {
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, event_status, payload FROM clinical_timeline_events
        WHERE source_table = 'patient_problems' AND source_id = $1`,
      String(problemId),
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline[0]).toMatchObject({ event_type: 'problem.recorded', event_status: 'active' });
    expect(timeline[0].payload?.codings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system_key: 'ICD11', code: 'BA00' }),
    ]));

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE resource_table = 'patient_problems' AND resource_id = $1`,
      String(problemId),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].action).toBe('problem.recorded');

    const bindings = await prisma.$queryRawUnsafe(
      `SELECT system_key, code, display
         FROM clinical_code_bindings
        WHERE resource_type = 'patient_problem' AND resource_id = $1`,
      String(problemId),
    );
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system_key: 'ICD11', code: 'BA00', display: 'Essential hypertension' }),
    ]));
  });

  test('duplicate active coded problem is rejected with 409', async () => {
    const res = await doctor
      .post('/api/v1/problems')
      .send({ patient_uid: patientUid, title: 'B7TEST HTN again', icd10_code: 'B7T.0' });
    expect(res.status).toBe(409);
  });

  test('resolve → reactivate flow with audit fields', async () => {
    const resolve = await doctor
      .patch(`/api/v1/problems/${problemId}`)
      .send({ status: 'resolved', resolution_notes: 'B7TEST controlled on therapy' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.data.problem.status).toBe('resolved');
    expect(resolve.body.data.problem.resolved_date).toBeTruthy();
    expect(resolve.body.data.problem.resolution_notes).toBe('B7TEST controlled on therapy');

    const reactivate = await doctor
      .patch(`/api/v1/problems/${problemId}`)
      .send({ status: 'active' });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.data.problem.status).toBe('active');
    expect(reactivate.body.data.problem.resolved_date).toBeNull();

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'patient_problems' AND source_id = $1 ORDER BY created_at`,
      String(problemId),
    );
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['problem.recorded', 'problem.resolved', 'problem.reactivated']));
  });

  test('invalid transition is a 400, not a 500 (same-status PATCH stays a no-op 200)', async () => {
    // Same-status PATCH is a legitimate idempotent field update.
    const noop = await doctor
      .patch(`/api/v1/problems/${problemId}`)
      .send({ status: 'active', notes: 'B7TEST noop-note' });
    expect(noop.status).toBe(200);

    // resolved → inactive is NOT in the transition matrix.
    const scratch = await doctor
      .post('/api/v1/problems')
      .send({ patient_uid: patientUid, title: 'B7TEST Scratch problem' });
    expect(scratch.status).toBe(201);
    const scratchId = scratch.body.data.problem.id;
    const resolved = await doctor
      .patch(`/api/v1/problems/${scratchId}`)
      .send({ status: 'resolved' });
    expect(resolved.status).toBe(200);
    const bad = await doctor
      .patch(`/api/v1/problems/${scratchId}`)
      .send({ status: 'inactive' });
    expect(bad.status).toBe(400);
  });

  test('diagnosis promotion creates a problem once, then reports already_active', async () => {
    const first = await doctor
      .post(`/api/v1/problems/promote/${diagnosisId}`)
      .send({ is_chronic: true });
    expect(first.status).toBe(201);
    expect(first.body.data.already_active).toBe(false);
    expect(first.body.data.problem).toMatchObject({
      icd10_code: 'B7T.9',
      title: 'B7TEST Type 2 diabetes mellitus',
      source_diagnosis_id: diagnosisId,
    });

    const second = await doctor
      .post(`/api/v1/problems/promote/${diagnosisId}`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.data.already_active).toBe(true);
  });

  test('list returns actives first; status filter works', async () => {
    const all = await authClient('NURSING_STAFF').get(`/api/v1/problems/patient/${patientUid}`);
    expect(all.status).toBe(200);
    expect(all.body.data.count).toBeGreaterThanOrEqual(2);
    expect(all.body.data.problems[0].status).toBe('active');

    const active = await doctor
      .get(`/api/v1/problems/patient/${patientUid}`)
      .query({ status: 'active' });
    expect(active.status).toBe(200);
    for (const p of active.body.data.problems) expect(p.status).toBe('active');
  });

  test('CDS summary feed returns active problems, chronic first', async () => {
    const summary = await getActiveProblemSummary(patientUid);
    expect(summary.length).toBeGreaterThanOrEqual(2);
    expect(summary[0].is_chronic).toBe(true);
    for (const p of summary) {
      expect(p).toHaveProperty('title');
      expect(p).toHaveProperty('icd10_code');
    }
  });

  test('patient role blocked at mount', async () => {
    const res = await authClient('PATIENT').get(`/api/v1/problems/patient/${patientUid}`);
    expect(res.status).toBe(403);
  });
});
