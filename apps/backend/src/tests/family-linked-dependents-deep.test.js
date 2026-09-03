// Deep integration tests for family-member → linked-dependent promotion
// (migration 681) and booking-on-behalf of a linked dependent.
//
// Promotion bridges the `family_members` address book (migration 100) into
// the platform's ONE guardian→minor mechanism — `users.guardian_user_id`
// (migration 202), the same link the X-Acting-As-Uid hop and the D72
// explicit-id appointment reads validate. Booking-on-behalf extends the
// booking IDOR check with the D72 pattern: a PATIENT may book with
// `patient_id` = a confirmed minor dependent's id; the appointment lands on
// the DEPENDENT's identity while the guardian stays on the audit trail.
//
// Each test asserts exact status codes + row-level side effects.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateTestToken } from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const GUARDIAN_UID = 'b4444444-4444-4444-8444-444444444c01';
const GUARDIAN_PHONE = '9000040001';
const EXISTING_MINOR_UID = 'b4444444-4444-4444-8444-444444444c02';
const EXISTING_MINOR_PHONE = '9000040002';
const EXISTING_ADULT_UID = 'b4444444-4444-4444-8444-444444444c03';
const EXISTING_ADULT_PHONE = '9000040003';
const DOCTOR_UID = 'b4444444-4444-4444-8444-444444444c04';
const STRANGER_MINOR_UID = 'b4444444-4444-4444-8444-444444444c05';
const STRANGER_MINOR_PHONE = '9000040005';

function minorDobISO(years = 8) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function adultDobISO(years = 30) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function futureDateISO(offsetDays = 92) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function clientAs({ uid, id, role = 'PATIENT', phone = null }) {
  const token = generateTestToken(role, { uid, id, phone });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function withAuditBypass(fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    return fn(tx);
  });
}

async function purgeFixtures() {
  const fixedUids = [
    GUARDIAN_UID, EXISTING_MINOR_UID, EXISTING_ADULT_UID, DOCTOR_UID,
    STRANGER_MINOR_UID,
  ];
  // Minted dependents from earlier runs hang off the guardian by
  // guardian_name lookups being unreliable — find them via family_members
  // linkage + DEPEND- phone under the guardian.
  const minted = await prisma.$queryRawUnsafe(
    `SELECT u.uid
       FROM users u
       JOIN users g ON g.id = u.guardian_user_id
      WHERE g.uid = $1::uuid AND u.phone LIKE 'DEPEND-%'`,
    GUARDIAN_UID,
  );
  const allUids = [...fixedUids, ...minted.map((r) => String(r.uid))];

  await withAuditBypass(async (tx) => {
    for (const uid of allUids) {
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE uid = $1::uuid OR actor_uid = $1::uuid OR subject_uid = $1::uuid OR resource_id = $1::text`,
        uid,
      );
    }
  });
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE patient_id IN (SELECT id FROM users WHERE uid = ANY($1::uuid[]))`,
    allUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM family_members WHERE patient_uid = ANY($1::uuid[])`,
    allUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid = $1::uuid)`,
    DOCTOR_UID,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE users SET guardian_user_id = NULL WHERE uid = ANY($1::uuid[])`,
    allUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids,
  );
}

describe('Family-member promotion + booking-on-behalf — deep integration', () => {
  let guardianId;
  let existingMinorId;
  let strangerMinorId;
  let doctorId;
  let guardian;
  const apptDate = futureDateISO(92);

  beforeAll(async () => {
    await purgeFixtures();

    const g = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Family Promo Guardian', 'PATIENT', true, false, NOW())
       RETURNING id`,
      GUARDIAN_UID, GUARDIAN_PHONE,
    );
    guardianId = g[0].id;

    // A minor who already has their own account (link-by-phone path).
    const m = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Family Promo Existing Minor', 'PATIENT', true, true, NOW())
       RETURNING id`,
      EXISTING_MINOR_UID, EXISTING_MINOR_PHONE,
    );
    existingMinorId = m[0].id;

    // An adult account whose phone a contact might wrongly carry.
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Family Promo Adult', 'PATIENT', true, false, NOW())
       RETURNING id`,
      EXISTING_ADULT_UID, EXISTING_ADULT_PHONE,
    );

    // A minor linked to NOBODY — booking for them must stay forbidden.
    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, updated_at)
       VALUES ($1::uuid, $2, 'Family Promo Stranger Minor', 'PATIENT', true, true, NOW())
       RETURNING id`,
      STRANGER_MINOR_UID, STRANGER_MINOR_PHONE,
    );
    strangerMinorId = s[0].id;

    // Doctor + profile row for the booking path.
    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '+919000040004', 'Dr. Family Promo', 'DOCTOR', true, NOW())
       RETURNING id`,
      DOCTOR_UID,
    );
    doctorId = d[0].id;
    const profileIdRows = await prisma.$queryRawUnsafe(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(id) FROM users), 0),
         COALESCE((SELECT MAX(id) FROM doctors), 0)
       )::int + 51000 AS id`,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO doctors (id, user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
       VALUES ($1::int, $2::int, 'Dr. Family Promo', 'Paediatrics', 'Paediatrician', true, true, ARRAY['Mon','Tue'], NOW())
       RETURNING id`,
      Number(profileIdRows[0].id),
      doctorId,
    );

    guardian = clientAs({ uid: GUARDIAN_UID, id: guardianId, phone: GUARDIAN_PHONE });
  });

  // purgeFixtures unwinds a guardian/dependent graph across several tables and
  // does not fit jest's default 5s hook budget; every assertion in this suite
  // passes, only the teardown was timing out. Budgeted explicitly, as the
  // other DB-backed suites in this tree do.
  afterAll(async () => {
    await purgeFixtures();
    await prisma.$disconnect();
  }, 60000);

  async function addContact(body) {
    const res = await guardian.post('/api/v1/users/family-members').send(body);
    expect(res.status).toBe(201);
    return res.body.data;
  }

  // ── Promotion ─────────────────────────────────────────────────────────

  test('promotion without consent declaration is refused (400)', async () => {
    const contact = await addContact({
      name: 'No Consent Kid', phone: GUARDIAN_PHONE, relationship: 'Child',
      dateOfBirth: minorDobISO(6),
    });
    const res = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'parent' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GUARDIAN_CONSENT_REQUIRED');
  });

  test('promotion of an adult contact is refused (400 NOT_MINOR)', async () => {
    const contact = await addContact({
      name: 'Adult Contact', phone: GUARDIAN_PHONE, relationship: 'Parent',
      dateOfBirth: adultDobISO(55),
    });
    const res = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'other', consent_confirmed: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_MINOR');
  });

  test('promotion with no DOB anywhere is refused (400 BIRTHDAY_REQUIRED)', async () => {
    const contact = await addContact({
      name: 'No DOB Kid', phone: GUARDIAN_PHONE, relationship: 'Child',
    });
    const res = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'parent', consent_confirmed: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BIRTHDAY_REQUIRED');
  });

  test('promotion mints a minor identity with synthetic phone, links it, stamps consent + audit', async () => {
    const contact = await addContact({
      name: 'Minted Kid', phone: GUARDIAN_PHONE, relationship: 'Child',
      dateOfBirth: minorDobISO(9),
    });
    const res = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'father', consent_confirmed: true, gender: 'MALE' });
    expect(res.status).toBe(201);
    const { dependent, created_identity: created } = res.body.data;
    expect(created).toBe(true);
    expect(dependent.uid).toBeDefined();
    expect(dependent.is_minor).toBe(true);
    expect(dependent.guardian_relationship).toBe('father');

    // The minted users row: synthetic DEPEND- phone, guardian link set.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT phone, name, role, is_minor, is_active, guardian_user_id, guardian_relationship
         FROM users WHERE uid = $1::uuid`,
      dependent.uid,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toMatch(/^DEPEND-/);
    expect(rows[0].name).toBe('Minted Kid');
    expect(rows[0].role).toBe('PATIENT');
    expect(rows[0].is_minor).toBe(true);
    expect(rows[0].guardian_user_id).toBe(guardianId);
    expect(rows[0].guardian_relationship).toBe('father');

    // The contact row carries the linkage + consent evidence.
    const fm = await prisma.$queryRawUnsafe(
      `SELECT linked_dependent_uid, linked_at, link_consent_method
         FROM family_members WHERE id = $1`,
      contact.id,
    );
    expect(String(fm[0].linked_dependent_uid)).toBe(String(dependent.uid));
    expect(fm[0].linked_at).not.toBeNull();
    expect(fm[0].link_consent_method).toBe('guardian_declaration');

    // Audit row written in the same transaction.
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata FROM audit_logs
        WHERE action = 'FAMILY_MEMBER_PROMOTED' AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      String(contact.id),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.dependent_uid).toBe(dependent.uid);
    expect(audit[0].metadata.consent_method).toBe('guardian_declaration');
    expect(audit[0].metadata.created_identity).toBe(true);

    // The promoted dependent shows up in the acting-as roster.
    const deps = await guardian.get('/api/v1/users/dependents');
    expect(deps.status).toBe(200);
    expect(deps.body.data.dependents.map((x) => x.uid)).toContain(dependent.uid);

    // And the family list surfaces the linkage.
    const list = await guardian.get('/api/v1/users/family-members');
    expect(list.status).toBe(200);
    const listed = list.body.data.find((x) => x.id === contact.id);
    expect(listed.linkedDependentUid).toBe(dependent.uid);

    // Re-promotion is idempotent — 200, same dependent, no second identity.
    const again = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'father', consent_confirmed: true });
    expect(again.status).toBe(200);
    expect(again.body.data.already_linked).toBe(true);
    expect(again.body.data.dependent.uid).toBe(dependent.uid);
  });

  test('promotion links an existing minor account when the contact phone matches it', async () => {
    const contact = await addContact({
      name: 'Existing Minor Contact', phone: EXISTING_MINOR_PHONE,
      relationship: 'Child', dateOfBirth: minorDobISO(12),
    });
    const res = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'mother', consent_confirmed: true });
    expect(res.status).toBe(201);
    expect(res.body.data.created_identity).toBe(false);
    expect(res.body.data.dependent.uid).toBe(EXISTING_MINOR_UID);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT guardian_user_id, guardian_relationship FROM users WHERE uid = $1::uuid`,
      EXISTING_MINOR_UID,
    );
    expect(rows[0].guardian_user_id).toBe(guardianId);
    expect(rows[0].guardian_relationship).toBe('mother');
  });

  test('promotion refuses when the contact phone belongs to an unlinkable account (409)', async () => {
    const contact = await addContact({
      name: 'Wrong Phone Kid', phone: EXISTING_ADULT_PHONE,
      relationship: 'Child', dateOfBirth: minorDobISO(7),
    });
    const res = await guardian
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'parent', consent_confirmed: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FAMILY_MEMBER_PHONE_ACCOUNT_CONFLICT');
  });

  test('promotion IDOR — cannot promote another guardian\'s contact (404)', async () => {
    const contact = await addContact({
      name: 'IDOR Kid', phone: GUARDIAN_PHONE, relationship: 'Child',
      dateOfBirth: minorDobISO(5),
    });
    const strangerClient = clientAs({
      uid: STRANGER_MINOR_UID, id: strangerMinorId, phone: STRANGER_MINOR_PHONE,
    });
    const res = await strangerClient
      .post(`/api/v1/users/family-members/${contact.id}/promote`)
      .send({ relationship: 'parent', consent_confirmed: true });
    expect(res.status).toBe(404);
  });

  // ── Booking-on-behalf ─────────────────────────────────────────────────

  test('guardian books an appointment for a linked dependent — lands on the dependent, guardian on the audit trail', async () => {
    const res = await guardian.post('/api/v1/appointments/book').send({
      patient_id: existingMinorId,
      doctor_id: doctorId,
      appointment_date: apptDate,
      appointment_time: '10:00',
      reason: 'Paediatric review',
    });
    expect(res.status).toBe(201);
    const appt = res.body.data.appointment;
    expect(appt.status).toBe('SCHEDULED');

    const row = await prisma.$queryRawUnsafe(
      `SELECT patient_id, doctor_id FROM appointments WHERE id = $1`, appt.id,
    );
    expect(row[0].patient_id).toBe(existingMinorId);
    expect(row[0].doctor_id).toBe(doctorId);

    // Audit trail: the GUARDIAN is the booking actor; the appointment's
    // patient is the dependent.
    const audit = await prisma.$queryRawUnsafe(
      `SELECT actor_uid, metadata FROM audit_logs
        WHERE action = 'FRONT_OFFICE_APPOINTMENT_BOOKED'
          AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      String(appt.id),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_uid).toBe(GUARDIAN_UID);
    expect(String(audit[0].metadata.patient_uid)).toBe(EXISTING_MINOR_UID);
  });

  test('guardian booking via the X-Acting-As-Uid hop also lands on the dependent', async () => {
    const token = generateTestToken('PATIENT', {
      uid: GUARDIAN_UID, id: guardianId, phone: GUARDIAN_PHONE,
    });
    const res = await request(app)
      .post('/api/v1/appointments/book')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-As-Uid', EXISTING_MINOR_UID)
      .send({
        patient_id: existingMinorId,
        doctor_id: doctorId,
        // Different day from the explicit-id booking above so the
        // same-patient/doctor/day duplicate guard doesn't 409.
        appointment_date: futureDateISO(93),
        appointment_time: '11:00',
        reason: 'Paediatric follow-up',
      });
    expect(res.status).toBe(201);
    const row = await prisma.$queryRawUnsafe(
      `SELECT patient_id FROM appointments WHERE id = $1`, res.body.data.appointment.id,
    );
    expect(row[0].patient_id).toBe(existingMinorId);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT actor_uid, subject_uid, acting_as_dependent FROM audit_logs
        WHERE action = 'FRONT_OFFICE_APPOINTMENT_BOOKED'
          AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      String(res.body.data.appointment.id),
    );
    expect(audit[0].actor_uid).toBe(GUARDIAN_UID);
    expect(audit[0].subject_uid).toBe(EXISTING_MINOR_UID);
    expect(audit[0].acting_as_dependent).toBe(true);
  });

  test('booking for a NON-linked minor stays forbidden (400)', async () => {
    const res = await guardian.post('/api/v1/appointments/book').send({
      patient_id: strangerMinorId,
      doctor_id: doctorId,
      appointment_date: apptDate,
      appointment_time: '12:00',
      reason: 'Should not work',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message || '')).toMatch(/only book appointments for yourself/i);
  });

  test('guardian can read the linked dependent\'s appointment list (D72 path)', async () => {
    const res = await guardian.get(`/api/v1/appointments/patient/${existingMinorId}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.appointments.map((a) => a.patient_id ?? null);
    expect(res.body.data.count).toBeGreaterThanOrEqual(2);
    expect(ids.every((x) => x == null || String(x) === String(existingMinorId))).toBe(true);
  });
});
