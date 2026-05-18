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
const UNIDENT_COLLISION_PHONE = `97773${RUN_SUFFIX}`;
const ALLERGY_PHONE = `97775${RUN_SUFFIX}`;
const ANC_PHONE = `97776${RUN_SUFFIX}`;
const MINOR_GUARDIAN_PHONE = `97777${RUN_SUFFIX}`;
const MINOR_ALIAS_PHONE = `97778${RUN_SUFFIX}`;
const MINOR_NODOB_PHONE = `97779${RUN_SUFFIX}`;
const PHONE_FORMS = [
  EMER_PHONE,
  `+91${EMER_PHONE}`,
  OPD_PHONE,
  `+91${OPD_PHONE}`,
  UNIDENT_COLLISION_PHONE,
  `+91${UNIDENT_COLLISION_PHONE}`,
  ALLERGY_PHONE,
  `+91${ALLERGY_PHONE}`,
  ANC_PHONE,
  `+91${ANC_PHONE}`,
  MINOR_GUARDIAN_PHONE,
  `+91${MINOR_GUARDIAN_PHONE}`,
  MINOR_ALIAS_PHONE,
  `+91${MINOR_ALIAS_PHONE}`,
  MINOR_NODOB_PHONE,
  `+91${MINOR_NODOB_PHONE}`,
];
// `Stage5Emergency-...` → deptPrefix() substring-matches "emergency" → EMER.
// `Stage5Reception-...` → no map hit → first-4-alpha fallback → STAG.
const EMER_DEPARTMENT = `Stage5Emergency-${RUN_SUFFIX}`;
const OPD_DEPARTMENT = `Stage5Reception-${RUN_SUFFIX}`;

async function cleanupFixtures() {
  await prisma
    .$executeRawUnsafe(
      `UPDATE users
          SET guardian_user_id = NULL
        WHERE phone = ANY($1::text[]) OR guardian_phone = ANY($1::text[])`,
      PHONE_FORMS,
    )
    .catch(() => {});
  const userRows = await prisma
    .$queryRawUnsafe(
      `SELECT id, uid
         FROM users
        WHERE uid = $1::uuid
           OR phone = ANY($2::text[])
           OR guardian_phone = ANY($2::text[])`,
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
    await prisma
      .$executeRawUnsafe(`DELETE FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[])`, userUids)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM patient_allergies WHERE patient_uid = ANY($1::uuid[])`, userUids)
      .catch(() => {});
  }
  if (userIds.length > 0) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM patient_allergies WHERE patient_id = ANY($1::int[])`, userIds)
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
      `DELETE FROM users
        WHERE uid = $1::uuid
           OR phone = ANY($2::text[])
           OR guardian_phone = ANY($2::text[])`,
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
       VALUES ($1::uuid, '9777100099', 'Walk-in Fields Staff', 'RECEPTIONIST', true, NOW())
       RETURNING id`,
      STAFF_UID,
    );
    staffId = rows[0].id;
    staffToken = generateTestToken('RECEPTIONIST', { uid: STAFF_UID, id: staffId });

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

  it('rejects lab staff attempts to create official OPD walk-in visits', async () => {
    const labToken = generateTestToken('LAB_STAFF', {
      uid: 'a6666666-6666-4666-8666-66666666fd03',
      id: staffId + 100,
    });

    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${labToken}`)
      .send({
        patient_name: 'Unauthorized Lab Walkin',
        patient_phone: `97774${RUN_SUFFIX}`,
        department: OPD_DEPARTMENT,
        reason: 'Should be forbidden',
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/front-desk/i);
  });

  it('creates an unidentified emergency patient without colliding on placeholder phone', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'Existing Placeholder Patient', 'PATIENT', true, NOW())
       ON CONFLICT (phone) DO NOTHING`,
      `+91${UNIDENT_COLLISION_PHONE}`,
    );

    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Unknown trauma patient',
        patient_phone: UNIDENT_COLLISION_PHONE,
        patient_gender: 'M',
        visit_type: 'EMERGENCY',
        is_unidentified: true,
        chief_complaint: 'Unconscious after fall',
        mlc: true,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.visit_no).toMatch(/^EMER-\d{8}-\d{3}$/);
    expect(res.body.data.er_visit_id).not.toBeNull();
    expect(res.body.data.is_unidentified).toBe(true);
    expect(res.body.data.phone).toMatch(/^UNIDENT-[A-Z0-9]{6}$/);

    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT phone, is_unidentified FROM users WHERE id = $1`,
      res.body.data.patient_id,
    );
    expect(patientRows[0]).toMatchObject({
      phone: res.body.data.phone,
      is_unidentified: true,
    });

    const erRows = await prisma.$queryRawUnsafe(
      `SELECT chief_complaint, is_mlc FROM emergency_visits WHERE id = $1`,
      res.body.data.er_visit_id,
    );
    expect(erRows[0]).toMatchObject({
      chief_complaint: 'Unconscious after fall',
      is_mlc: true,
    });

    await prisma.$executeRawUnsafe(
      `DELETE FROM emergency_visits WHERE id = $1`,
      res.body.data.er_visit_id,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history WHERE appointment_id = $1`,
      res.body.data.id,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE id = $1`,
      res.body.data.id,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE id = $1`,
      res.body.data.patient_id,
    );
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

  it('surfaces allergy risk on the walk-in response for returning patients', async () => {
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, allergies, updated_at)
       VALUES ($1, 'Allergy Flag Patient', 'PATIENT', true, 'Penicillin', NOW())
       RETURNING id, uid`,
      `+91${ALLERGY_PHONE}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies
         (patient_id, patient_uid, allergy_name, severity, reaction, is_active, created_at)
       VALUES ($1::int, $2::uuid, 'Penicillin', 'SEVERE', 'Wheeze', true, NOW())`,
      patient[0].id,
      patient[0].uid,
    );

    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Allergy Flag Patient',
        patient_phone: ALLERGY_PHONE,
        patient_gender: 'F',
        department: OPD_DEPARTMENT,
        reason: 'Acute abdomen with known drug allergy',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.returning_patient).toBe(true);
    expect(res.body.data.has_allergies).toBe(true);
    expect(res.body.data.allergies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ allergy_name: 'Penicillin', severity: 'SEVERE' }),
      ]),
    );
  });

  it('stamps ANC walk-in LMP on both pregnancy and patient profile', async () => {
    const lmp = new Date(Date.now() - 24 * 7 * 86400000).toISOString().slice(0, 10);
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'ANC Walk-in',
        patient_phone: ANC_PHONE,
        patient_gender: 'F',
        department: 'Obstetrics',
        reason: '24 week ANC booking',
        visit_type: 'NEW',
        lmp_date: lmp,
        gravida: 2,
        parity: 1,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.gestational_age?.weeks).toBeGreaterThanOrEqual(23);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.is_pregnant, u.pregnancy_lmp_date, p.id AS pregnancy_id
         FROM users u
         LEFT JOIN maternity_pregnancies p ON p.patient_uid = u.uid AND p.status = 'ongoing'
        WHERE u.id = $1::int`,
      res.body.data.patient_id,
    );
    expect(rows[0].is_pregnant).toBe(true);
    expect(new Date(rows[0].pregnancy_lmp_date).toISOString().slice(0, 10)).toBe(lmp);
    expect(rows[0].pregnancy_id).toBeTruthy();
  });

  it('creates a guardian account and links a minor dependent when the guardian phone is the contact phone', async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 6);
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Minor Dependent',
        patient_phone: MINOR_GUARDIAN_PHONE,
        patient_birthday: dob.toISOString().slice(0, 10),
        patient_gender: 'F',
        department: 'Paediatrics',
        reason: 'Paediatric fever',
        visit_type: 'PAEDIATRIC_OPD',
        guardian_name: 'Minor Parent',
        guardian_phone: MINOR_GUARDIAN_PHONE,
        guardian_relationship: 'mother',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.phone).toMatch(/^DEPEND-[A-Z0-9]{8}$/);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT child.phone AS child_phone,
              child.guardian_phone,
              child.guardian_relationship,
              guardian.phone AS guardian_phone_login
         FROM users child
         LEFT JOIN users guardian ON guardian.id = child.guardian_user_id
        WHERE child.id = $1::int`,
      res.body.data.patient_id,
    );
    expect(rows[0]).toMatchObject({
      child_phone: res.body.data.phone,
      guardian_phone: `+91${MINOR_GUARDIAN_PHONE}`,
      guardian_relationship: 'mother',
      guardian_phone_login: `+91${MINOR_GUARDIAN_PHONE}`,
    });
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

  // Regression: 2026-05-18-pediatric-opd-receptionist-185a6357.
  // Without these guards a minor registered under an adult's phone
  // silently merged onto the adult's patient row, dropping name / DOB /
  // gender / guardian / allergies — a safety-critical paeds prescribing
  // hazard.
  it('accepts date_of_birth as alias for patient_birthday and treats a minor with shared guardian phone as a distinct dependent', async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 2);
    const dobIso = dob.toISOString().slice(0, 10);
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Baby Alias',
        patient_phone: MINOR_ALIAS_PHONE,
        // Alias names — receptionist dialog + external API callers use these
        date_of_birth: dobIso,
        gender: 'M',
        department: 'Paediatrics',
        reason: 'Paediatric fever',
        visit_type: 'PAEDIATRIC_OPD',
        guardian_name: 'Alias Parent',
        guardian_phone: MINOR_ALIAS_PHONE,
        guardian_relationship: 'mother',
        allergies: 'Cefixime',
      });

    expect(res.statusCode).toBe(200);
    // Must NOT have merged onto an existing patient on the same phone.
    expect(res.body.data.phone).toMatch(/^DEPEND-[A-Z0-9]{8}$/);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT name, birthday::text AS birthday, gender, allergies,
              guardian_name, guardian_relationship, is_minor
         FROM users WHERE id = $1::int`,
      res.body.data.patient_id,
    );
    expect(rows[0]).toMatchObject({
      name: 'Baby Alias',
      birthday: dobIso,
      gender: 'male',
      allergies: 'Cefixime',
      guardian_name: 'Alias Parent',
      guardian_relationship: 'mother',
      is_minor: true,
    });
  });

  it('refuses to merge a minor onto an existing adult patient row even when DOB is omitted (guardian fields suffice as signal)', async () => {
    // Seed an adult on the shared phone first.
    const adultRes = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Existing Adult',
        patient_phone: MINOR_NODOB_PHONE,
        patient_gender: 'F',
        department: OPD_DEPARTMENT,
        reason: 'Adult walk-in',
      });
    expect(adultRes.statusCode).toBe(200);
    const adultId = adultRes.body.data.patient_id;

    // Now register a "dependent" walk-in under the same phone with NO DOB.
    // The receptionist forgetting DOB is the common real-world case; we
    // rely on the guardian fields + phone match to detect the minor flow.
    const childRes = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        patient_name: 'Baby No-DOB',
        patient_phone: MINOR_NODOB_PHONE,
        gender: 'M',
        department: 'Paediatrics',
        guardian_name: 'Adult Parent',
        guardian_phone: MINOR_NODOB_PHONE,
        guardian_relationship: 'mother',
        allergies: 'Penicillin',
      });

    expect(childRes.statusCode).toBe(200);
    expect(childRes.body.data.patient_id).not.toBe(adultId);
    expect(childRes.body.data.phone).toMatch(/^DEPEND-[A-Z0-9]{8}$/);

    // The adult row must remain untouched.
    const adultAfter = await prisma.$queryRawUnsafe(
      `SELECT name, gender, allergies FROM users WHERE id = $1::int`,
      adultId,
    );
    expect(adultAfter[0]).toMatchObject({
      name: 'Existing Adult',
      gender: 'female',
    });
    expect(adultAfter[0].allergies).not.toBe('Penicillin');
  });

  // Findings:
  //   2026-05-17-walk-in-opd-receptionist-a99111c4
  //   2026-05-17-walk-in-opd-receptionist-e00d0e2e
  //   plus paediatric / dynamic-acute-abdomen variants of the same shape.
  // Without auto-assignment the appointment was created with doctor_id=null
  // and the receptionist had no in-flow path to set it (PUT /appointments/:id
  // is SUPER_ADMIN only).
  it('auto-assigns next-available DOCTOR in the requested department when doctor_id is omitted', async () => {
    // Seed a DOCTOR user + doctors profile linked to a unique department
    // so we don't collide with whatever the QA fixtures already have.
    const deptName = `AutoAssign-${RUN_SUFFIX}`;
    const doctorUid = 'a8888888-8888-4888-8888-88888888fd02';
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE name = $1`,
      `Dr. Auto Assign ${RUN_SUFFIX}`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`,
      doctorUid,
    ).catch(() => {});
    const userRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'DOCTOR', true, NOW())
       RETURNING id`,
      doctorUid,
      `+9199998${RUN_SUFFIX}`,
      `Dr. Auto Assign ${RUN_SUFFIX}`,
    );
    const doctorUserId = userRows[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO doctors (user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
       VALUES ($1, $2, $3, 'General Practitioner', true, true, ARRAY['Mon','Tue','Wed','Thu','Fri','Sat'], NOW())`,
      doctorUserId,
      `Dr. Auto Assign ${RUN_SUFFIX}`,
      deptName,
    );

    const autoAssignPhone = `97774${RUN_SUFFIX}`;
    try {
      const res = await request(app)
        .post('/api/v1/appointments/walk-in')
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          patient_name: 'Auto-Assign Patient',
          patient_phone: autoAssignPhone,
          patient_gender: 'F',
          department: deptName,
          reason: 'Auto-assign smoke',
          // no doctor_id — controller must pick the only doctor in this dept
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.doctor_id).toBe(doctorUserId);
    } finally {
      // Best-effort cleanup. department-scoped so we don't drag siblings.
      await prisma.$executeRawUnsafe(
        `DELETE FROM appointment_status_history
           WHERE appointment_id IN (SELECT id FROM appointments WHERE department = $1)`,
        deptName,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM appointments WHERE department = $1`,
        deptName,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE phone IN ($1, $2)`,
        autoAssignPhone, `+91${autoAssignPhone}`,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM doctors WHERE user_id = $1`,
        doctorUserId,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE id = $1`,
        doctorUserId,
      ).catch(() => {});
    }
  });
});
