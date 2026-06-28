// Investigation booking-by-id patient-relationship guard (CAN-017).
//
// The booking workflow handlers (/investigations/bookings/:id and the
// confirm/dispatch/collected/processing/result mutations) address the patient
// indirectly through the booking id, which the parent INVESTIGATION guard can't
// resolve — so an in-role clinician could drive any patient's booking. A
// per-route guard now resolves the patient from the booking row and applies the
// care-team-governed ABAC posture (shadow by default → non-breaking; a real 403
// once the tenant/env flips to enforce). This proves the wiring: an unrelated
// clinician is denied under enforce and passes under shadow.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'c0de0017-0000-4000-8000-0000000007a1';

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: 'c0de0017-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

let bookingId;

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_bookings WHERE patient_id IN (SELECT id FROM users WHERE uid = $1::uuid)`,
    PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

d('Investigation booking-by-id care-team guard (CAN-017)', () => {
  let prevMode;
  beforeAll(async () => {
    prevMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await clean();
    const userRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000017701','Booking Patient','PATIENT',true,NOW())
       RETURNING id`, PATIENT, TENANT_ID);
    const patientIntId = Number(userRows[0].id);
    const bookingRows = await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_bookings (patient_id, selected_tests, actual_tests, tenant_id, status, updated_at)
       VALUES ($1::int, '{}'::int[], '{}'::int[], $2::uuid, 'BOOKED', NOW())
       RETURNING id`, patientIntId, TENANT_ID);
    bookingId = Number(bookingRows[0].id);
  }, 30000);
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = prevMode;
    await clean(); await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('ENFORCE: an unrelated clinician is denied the booking detail (403)', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    const res = await doctor().get(`/api/v1/investigations/bookings/${bookingId}`);
    expect(res.statusCode).toBe(403);
  });

  it('SHADOW (default): the same request is not blocked by the guard', async () => {
    delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    const res = await doctor().get(`/api/v1/investigations/bookings/${bookingId}`);
    expect(res.statusCode).not.toBe(403);
  });
});
