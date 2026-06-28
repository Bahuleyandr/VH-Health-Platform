// Investigation booking-id bigint resolution (CAN-017 follow-up).
//
// investigation_bookings.id is a BigInt, and the booking care-team resolver
// casts `ib.id = $2::bigint`. But it routed the id through the shared int4-bounded
// cleanInt() (hardened in c15b3192 to stop phone overflow on int4 `id` columns),
// so a booking id above int4 max (2,147,483,647) was silently rejected →
// resolvePatientForResourceAccess returned null → the /bookings/:id* care-team
// guard could not resolve the patient (fails closed in enforce / pass-through in
// shadow). The resolver now uses a bigint-aware cleaner for this one case, WITHOUT
// weakening the int4 bound that protects the int4 `id` resolvers.
//
// RLS is OFF in the test env, so the resolver's tenant predicate is exercised by
// the req.tenantId passed in.
import { resolvePatientForResourceAccess } from '../services/security/accessDecisionService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'c0de0a35-0000-4000-8000-0000000007a1';
const BIG_ID = '3000000001';   // > int4 max (2147483647), well within int8
const SMALL_ID = '2000000001'; // < int4 max — control (worked before too)
const BEYOND_INT8 = '99999999999999999999'; // > int8 max (9223372036854775807)
const req = { tenantId: TENANT_ID };

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_bookings WHERE id IN ($1::bigint, $2::bigint)`, BIG_ID, SMALL_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

const resolveBooking = (id) =>
  resolvePatientForResourceAccess(req, { resourceType: 'investigation_booking', resourceId: id });

d('Investigation booking-id bigint resolution (CAN-017 follow-up)', () => {
  beforeAll(async () => {
    await clean();
    const userRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000035701','Bigint Booking Patient','PATIENT',true,NOW())
       RETURNING id`, PATIENT, TENANT_ID);
    const patientIntId = Number(userRows[0].id);
    // Seed bookings with EXPLICIT ids straddling the int4 boundary.
    for (const id of [BIG_ID, SMALL_ID]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO investigation_bookings (id, patient_id, selected_tests, actual_tests, tenant_id, status, updated_at)
         VALUES ($1::bigint, $2::int, '{}'::int[], '{}'::int[], $3::uuid, 'BOOKED', NOW())`,
        id, patientIntId, TENANT_ID);
    }
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('resolves the patient for a booking id ABOVE int4 max', async () => {
    const patient = await resolveBooking(BIG_ID);
    expect(patient).not.toBeNull();
    expect(patient.uid).toBe(PATIENT);
  });

  it('still resolves a small (sub-int4) booking id', async () => {
    const patient = await resolveBooking(SMALL_ID);
    expect(patient?.uid).toBe(PATIENT);
  });

  it('returns null (no crash) for an id beyond int8 max', async () => {
    const patient = await resolveBooking(BEYOND_INT8);
    expect(patient).toBeNull();
  });
});
