// Regression test for the P2 finding:
//   POST /api/v1/clinical/progress-notes 500s on OPD note save.
//
// The discoverability alias folded appointment_id into encounter_id
// (`encounter_id: req.body.encounter_id || req.body.appointment_id`). For an
// OPD note that put an INTEGER appointment id into the UUID encounter lookup
// (prisma.admissions.findFirst({ where: { encounter_id } })), throwing a type
// error → 500. createNote already binds OPD notes via a separate
// appointment_id param (migration 240); the route now passes both keys
// distinctly. Canonical encounter lifecycle support may additionally bind the
// note to the appointment's UUID patient_encounters row.

import request from 'supertest';
import app from '../app.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a90901';
const DOCTOR_UID = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a90902';
const TENANT_ID = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a90903';
const TODAY_HOSPITAL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

describe('POST /clinical/progress-notes — OPD note save (no 500)', () => {
  let patientId;
  let appointmentId;
  let createdNoteId;
  const priorAllowDefaultTenant = process.env.ALLOW_DEFAULT_TENANT;
  const doctorToken = generateTestToken('DOCTOR', {
    uid: DOCTOR_UID,
    id: 990902,
    tenant_id: TENANT_ID,
  });

  beforeAll(async () => {
    process.env.ALLOW_DEFAULT_TENANT = 'false';
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'progress-note-non-default', 'Progress Note Non-Default')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, '9009090901', 'Progress Note Patient', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, updated_at = NOW()
       RETURNING id`, PATIENT_UID, TENANT_ID);
    patientId = u[0].id;

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
          (tenant_id, patient_id, doctor_id, appointment_date, appointment_time, phone, reason,
           status, department, updated_at)
       VALUES ($1::uuid, $2, NULL, $3::date, '11:00', '9009090901', 'OPD follow-up',
                'CONFIRMED', 'General Medicine', NOW())
       RETURNING id`, TENANT_ID, patientId, TODAY_HOSPITAL_DATE);
    appointmentId = a[0].id;
  });

  /** phiAccessLogger writes AFTER the response (fire-and-forget on
   *  res 'finish'), so the suite's PHI-audit rows can land after the last
   *  assertion. Poll for them before teardown — otherwise the transaction
   *  below deletes hipaa_access_log and then the late insert recreates an FK
   *  child of tenants just as (or after) the tenant DELETE runs, failing the
   *  suite with a 23503 (bit CI 2026-08-16). Pattern from
   *  investigationLabAlertTenantScope.deep.test.js. */
  async function waitForPhiAuditWrites(expected, timeoutMs = 10000) {
    if (expected === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM hipaa_access_log
          WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      if (row.count >= expected) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  afterAll(async () => {
    // Both tests hit the PHI-logged progress-notes route: the 201 logs CREATE
    // and the 404 logs ACCESS_DENIED (patient_uid resolved from the body).
    await waitForPhiAuditWrites(2);
    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_audit_events
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND resource_table = 'clinical_notes'`,
        TENANT_ID,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND source_table = 'clinical_notes'`,
        TENANT_ID,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM patient_encounters
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid`,
        TENANT_ID,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM appointments
          WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM hipaa_access_log WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID);
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID);
    });
    if (priorAllowDefaultTenant === undefined) delete process.env.ALLOW_DEFAULT_TENANT;
    else process.env.ALLOW_DEFAULT_TENANT = priorAllowDefaultTenant;
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('saves an OPD progress note bound to the appointment (201, not 500)', async () => {
    const res = await request(app)
      .post('/api/v1/clinical/progress-notes')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        patient_uid: PATIENT_UID,
        appointment_id: appointmentId,
        note_type: 'consultant_round', // alias → 'progress'
        content: 'OPD follow-up: patient stable, continue current medications.',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.note_type).toBe('progress');
    createdNoteId = res.body.data.id;

    // The fix routes appointment_id to the appointment binding. Canonical OP
    // encounters also stamp the UUID encounter_id so note/timeline/signature
    // lifecycle state can be audited per visit.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text, appointment_id, encounter_id
         FROM clinical_notes
        WHERE id = $1::int`,
      createdNoteId,
    );
    expect(rows[0].tenant_id).toBe(TENANT_ID);
    expect(Number(rows[0].appointment_id)).toBe(appointmentId);
    expect(rows[0].encounter_id).toMatch(/^[0-9a-f-]{36}$/i);

    const [timelineRows, auditRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT tenant_id::text
           FROM clinical_timeline_events
          WHERE source_table = 'clinical_notes' AND source_id = $1::text`,
        String(createdNoteId),
      ),
      prisma.$queryRawUnsafe(
        `SELECT tenant_id::text
           FROM clinical_audit_events
          WHERE resource_table = 'clinical_notes' AND resource_id = $1::text`,
        String(createdNoteId),
      ),
    ]);
    expect(timelineRows).toHaveLength(1);
    expect(timelineRows[0].tenant_id).toBe(TENANT_ID);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].tenant_id).toBe(TENANT_ID);
  });

  it('rejects an unknown appointment_id with 404 (not 500)', async () => {
    const res = await request(app)
      .post('/api/v1/clinical/progress-notes')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        patient_uid: PATIENT_UID,
        appointment_id: 2000000001,
        note_type: 'progress',
        content: 'note text',
      });

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
