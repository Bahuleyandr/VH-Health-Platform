// HEAD-002: a uid-only (no token phone) self-service caller must not be able to
// retarget another user's profile by submitting their phone in the body.
//
// Staff password-login tokens carry { id, uid, role } with NO phone claim
// (staffAuthService). The profile self-service flow allows GENERAL_STAFF, and
// userValidation requires a body phone. Before the fix, the controller only
// rebound/validated the body phone when the token HAD a phone, and the service
// looked the user up by body phone first — so a uid-only staff token could POST
// another patient's phone and overwrite that patient's demographics. The fix
// binds self-service writes to the caller's token uid and never resolves a
// caller-supplied body phone for non-privileged actors.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';
const VICTIM = 'c0de0b02-00a0-4000-8000-0000000000a1';
const STAFF = 'c0de0b02-00b0-4000-8000-0000000000b1';
const VICTIM_PHONE = '+919000402701';
const STAFF_PHONE = '+919000402702';

// A uid-only staff token: explicitly drop the default phone claim.
function uidOnlyStaff() {
  const t = generateTestToken('GENERAL_STAFF', { uid: STAFF, id: 91234, tenant_id: TENANT, phone: undefined });
  return request(app).post('/api/v1/users/profile')
    .set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, VICTIM, STAFF).catch(() => {});
}

async function nameOf(uid) {
  const rows = await prisma.$queryRawUnsafe(`SELECT name FROM users WHERE uid = $1::uuid`, uid);
  return rows[0]?.name ?? null;
}

d('HEAD-002 profile owner binding (uid-only token)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,$3,'Victim Original','PATIENT',true,NOW()),
              ($4::uuid,$2::uuid,$5,'Staff Original','GENERAL_STAFF',true,NOW())`,
      VICTIM, TENANT, VICTIM_PHONE, STAFF, STAFF_PHONE);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a uid-only staff token cannot overwrite another user via body phone', async () => {
    // Submits the VICTIM's phone (userValidation requires a body phone). The
    // write must bind to the caller's token uid, never the victim's phone row.
    await uidOnlyStaff().send({ phone: VICTIM_PHONE, name: 'HACKED BY STAFF' });
    expect(await nameOf(VICTIM)).toBe('Victim Original'); // victim row UNTOUCHED
  });

  it('legit self-service (own phone) still updates the caller\'s own row', async () => {
    await uidOnlyStaff().send({ phone: STAFF_PHONE, name: 'Staff Self Update' });
    expect(await nameOf(STAFF)).toBe('Staff Self Update'); // caller's own row updated
    expect(await nameOf(VICTIM)).toBe('Victim Original');   // victim still untouched
  });
});
