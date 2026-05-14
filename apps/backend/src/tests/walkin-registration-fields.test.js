// Regression tests for the Stage-5 walk-in-registration cluster.
//
// Findings:
//   2026-05-09-emergency-walk-in-receptionist-no-mlc-flag-at-registration
//     — POST /appointments/walk-in accepted no medico-legal-case flag, so
//       emergency_visits.is_mlc stayed false no matter what the
//       receptionist sent.
//   2026-05-10-walk-in-opd-receptionist-no-tpa-fields
//   2026-05-11-dynamic-acute-abdomen-receptionist-6b6a9d03 (same locus)
//     — the walk-in payload had no structured payer/category/scheme
//       columns, so corporate-TPA and govt-scheme details could only go
//       into free-text appointments.notes.
//
// These tests seed a staff user, register walk-ins through the real HTTP
// surface, and assert the new columns are persisted on the row.
//
// Test-isolation notes:
//   * appointments.visit_no is globally UNIQUE and composed as
//     `${deptPrefix}-YYYYMMDD-${token}`. The OPD department name is
//     chosen so deptPrefix() resolves to a `STAG` prefix that no other
//     suite uses. The EMERGENCY walk-in must use the shared `EMER`
//     prefix, so beforeAll pre-seeds a high token_number for the (unique,
//     per-run) emergency department string — the walk-in then lands on a
//     collision-proof high token.
//   * registerWalkIn normalizes phones to E.164, so cleanup matches both
//     the raw and the +91 form, and also sweeps by the per-run
//     department string as a backstop.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAFF_UID = 'a6666666-6666-4666-8666-66666666fd01';
// Deterministically 10 digits so registerWalkIn's normalizePhone() always
// rewrites them to the +91 form — cleanup below matches both forms.
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const EMER_PHONE = `97771${RUN_SUFFIX}`;
const OPD_PHONE = `97772${RUN_SUFFIX}`;
const PHONE_FORMS = [EMER_PHONE, `+91${EMER_PHONE}`, OPD_PHONE, `+91${OPD_PHONE}`];
// `Stage5Emergency-...` → deptPrefix() substring-matches "emergency" → EMER.
// `Stage5Reception-...` → no map hit → first-4-alpha fallback → STAG.
const EMER_DEPARTMENT = `Stage5Emergency-${RUN_SUFFIX}`;
const OPD_DEPARTMENT = `Stage5Reception-${RUN_SUFFIX}`;

async function cleanupFixtures() {
  const userRows = await prisma
    .$queryRawUnsafe(
      `SELECT id, uid FROM users WHERE uid = $1::uuid OR phone = ANY($2::text[])`,
      STAFF_UID,
      PHONE_FORMS,
    )
    .catch(() => []);
  const userIds = userRows.map((r) => r.id);
  const userUids = userRows.map((r) => r.uid);
  if (userUids.length > 0) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM emergency_visits WHERE patient_uid = ANY($1::uuid[])`, userUids)
      .catch(() => {});
  }
  // Sweep appointment rows both by patient and by the per-run department
  // strings (the latter also catches the pre-seeded high-token row).
  const apptWhere = `department IN ($1, $2)${userIds.length ? ' OR patient_id = ANY($3::int[])' : ''}`;
  const apptParams = userIds.length
    ? [EMER_DEPARTMENT, OPD_DEPARTMENT, userIds]
    : [EMER_DEPARTMENT, OPD_DEPARTMENT];
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM appointment_status_history
       WHERE appointment_id IN (SELECT id FROM appointments WHERE ${apptWhere})`,
      ...apptParams,
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM appointments WHERE ${apptWhere}`, ...apptParams)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid OR phone = ANY($2::text[])`,
      STAFF_UID,
      PHONE_FORMS,
    )
    .catch(() => {});
}

describe('POST /appointments/walk-in — Stage-5 structured registration fields', () => {
  let staffId;
  let staffToken;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9777100099', 'Walk-in Fields Staff', 'GENERAL_STAFF', true, NOW())
       RETURNING id`,
      STAFF_UID,
    );
    staffId = rows[0].id;
    staffToken = generateTestToken('GENERAL_STAFF', { uid: STAFF_UID, id: staffId });

    // Pre-seed a high token for the (unique, per-run) emergency department
    // so the EMER-prefixed walk-in below lands on a collision-proof
    // visit_no even if another suite created EMER-<today>-001.
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (phone, appointment_date, appointment_time, status, confirmed_at,
          token_number, department, updated_at)
       VALUES ('0000000000', NOW(), 'seed', 'CONFIRMED', NOW(), '900', $1, NOW())`,
      EMER_DEPARTMENT,
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('flags an emergency walk-in as a medico-legal case on emergency_visits.is_mlc', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'RTA Victim',
        patient_phone: EMER_PHONE,
        patient_gender: 'M',
        department: EMER_DEPARTMENT,
        reason: 'Road traffic accident — brought by police',
        visit_type: 'EMERGENCY',
        mlc: true,
        mlc_number: 'FIR-2026-00481',
        mlc_notes: 'Brought by Indiranagar PS; rider, no helmet.',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.er_visit_id).not.toBeNull();
    expect(res.body.data.er_is_mlc).toBe(true);

    const ev = await prisma.$queryRawUnsafe(
      `SELECT is_mlc, metadata FROM emergency_visits WHERE id = $1`,
      res.body.data.er_visit_id,
    );
    expect(ev[0].is_mlc).toBe(true);
    expect(ev[0].metadata).toMatchObject({
      mlc_number: 'FIR-2026-00481',
      mlc_notes: 'Brought by Indiranagar PS; rider, no helmet.',
    });
  });

  it('persists structured payer / category / scheme fields on the appointment row', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Priya Iyer',
        patient_phone: OPD_PHONE,
        patient_gender: 'F',
        department: OPD_DEPARTMENT,
        reason: 'Walk-in OPD consultation',
        visit_type: 'NEW',
        // `corporate_tpa` is the receptionist's label — normalises to `tpa`.
        patient_category: 'corporate_tpa',
        payer_type: 'corporate group',
        insurer_name: 'Star Health',
        policy_number: 'STAR-CORP-EM12345',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.patient_category).toBe('tpa');
    expect(res.body.data.insurer_name).toBe('Star Health');

    const appt = await prisma.$queryRawUnsafe(
      `SELECT payer_type, patient_category, insurer_name, policy_number, scheme_name
         FROM appointments WHERE id = $1`,
      res.body.data.id,
    );
    expect(appt[0]).toMatchObject({
      payer_type: 'corporate group',
      patient_category: 'tpa',
      insurer_name: 'Star Health',
      policy_number: 'STAR-CORP-EM12345',
      scheme_name: null,
    });
  });

  it('records govt-scheme eligibility for a cash rural walk-in via scheme fields', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Karuppasamy',
        patient_phone: OPD_PHONE, // returning patient — same phone, dedupes
        patient_gender: 'M',
        department: OPD_DEPARTMENT,
        reason: 'Walk-in OPD consultation',
        visit_type: 'NEW',
        patient_category: 'scheme',
        scheme: 'CMCHIS',
      });

    expect(res.statusCode).toBe(200);
    const appt = await prisma.$queryRawUnsafe(
      `SELECT patient_category, scheme_name FROM appointments WHERE id = $1`,
      res.body.data.id,
    );
    expect(appt[0]).toMatchObject({ patient_category: 'scheme', scheme_name: 'CMCHIS' });
  });

  it('leaves the new columns null when the caller sends no payer fields (back-compat)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Plain Walk-in',
        patient_phone: OPD_PHONE,
        patient_gender: 'M',
        department: OPD_DEPARTMENT,
        reason: 'Walk-in OPD consultation',
      });

    expect(res.statusCode).toBe(200);
    const appt = await prisma.$queryRawUnsafe(
      `SELECT payer_type, patient_category, insurer_name, policy_number, scheme_name
         FROM appointments WHERE id = $1`,
      res.body.data.id,
    );
    expect(appt[0]).toMatchObject({
      payer_type: null,
      patient_category: null,
      insurer_name: null,
      policy_number: null,
      scheme_name: null,
    });
  });
});
