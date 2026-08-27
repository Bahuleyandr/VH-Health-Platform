// src/tests/investigationLabAlertTenantScope.deep.test.js
//
// Cross-tenant PHI leak in the investigation booking "alert lab staff" fan-out.
//
// createBooking resolved lab/nursing recipients with a bare
//   SELECT device_token, name FROM users
//    WHERE role IN ('LAB_STAFF','NURSING_STAFF')
//      AND device_token IS NOT NULL AND is_active = TRUE LIMIT 20
// carrying NO tenant predicate, then pushed a body containing the patient's
// NAME. On a multi-tenant deployment that delivers tenant A's patient name to
// tenant B's staff devices.
//
// WHY AN EXPLICIT PREDICATE AND NOT setTenant:
// RLS cannot be what this test pins. Migration 075's tenant_isolation policy on
// `users` is PERMISSIVE whenever app.current_tenant_id is unset, and the prisma
// proxy only sets that GUC when AUTH_ENFORCE_TENANT_RLS=true (or NODE_ENV=
// production) — neither holds in the test env. So in THIS environment RLS scopes
// nothing, and a fix that relied on it would leave this test red. The explicit
// `tenant_id = $1::uuid` predicate in staffPushRecipientService is what makes it
// pass, which is exactly the property worth pinning: it holds in every env.
//
// The suite runs on its OWN two tenants so it cannot be perturbed by, and cannot
// perturb, the default-tenant corpus other suites share.
import { jest } from '@jest/globals';

// Must resolve a promise: the controller chains `.catch()` onto the call, so a
// bare jest.fn() returning undefined would throw inside the fan-out.
const sendPushMock = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0 });

jest.unstable_mockModule('../utils/notifications/sendPushNotification.js', () => ({
  __esModule: true,
  sendPushNotification: sendPushMock,
}));

const { generateTestToken, API_KEY } = await import('./testClient.js');
const prisma = (await import('../lib/prisma.js')).default;
const { resolveStaffPushRecipients } = await import(
  '../services/notification/staffPushRecipientService.js'
);
const request = (await import('supertest')).default;
const app = (await import('../app.js')).default;
const { waitForAuditLogDrain } = await import('../middleware/auditLog.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// tenantContextMiddleware's UUID_RE requires version nibble [1-5] and variant [89ab].
const TENANT_A = 'a1b00001-0000-4000-8000-00000000a001';
const TENANT_B = 'a1b00002-0000-4000-8000-00000000b002';

const PATIENT_A = 'a1b00003-0000-4000-8000-0000000000a1';
const DOCTOR_A = 'a1b00004-0000-4000-8000-0000000000d1';
const LAB_A = 'a1b00005-0000-4000-8000-0000000000b1';
const NURSE_A = 'a1b00006-0000-4000-8000-0000000000c1';
const LAB_B = 'a1b00007-0000-4000-8000-0000000000b2';

const TOKEN_LAB_A = 'device-token-tenantA-lab';
const TOKEN_NURSE_A = 'device-token-tenantA-nurse';
const TOKEN_LAB_B = 'device-token-tenantB-lab';

const ALL_UIDS = [PATIENT_A, DOCTOR_A, LAB_A, NURSE_A, LAB_B];

let patientAId;
let expectedPhiAuditWrites = 0;

function doctorOfTenantA() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_A, tenant_id: TENANT_A });
  return {
    post: (p, body) => request(app).post(p)
      .set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`).send(body),
  };
}

// tenant_id is set EXPLICITLY on every fixture row. users.tenant_id has a column
// DEFAULT of the default tenant, and these raw inserts run with the GUC unset —
// an omitted tenant_id would silently land the row on the DEFAULT tenant and the
// suite would measure nothing it created.
async function seedUser(uid, tenantId, role, phone, deviceToken) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, device_token, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,$6,NOW())
     RETURNING id`,
    uid, tenantId, phone, `LabAlert ${role}`, role, deviceToken,
  );
  return Number(rows[0].id);
}

// Children before parents, every delete scoped by tenant.
const CHILD_TABLES = [
  'pathway_projector_inbox',
  'event_outbox',
  'investigation_booking_history',
  'investigation_bookings',
  'clinical_timeline_events',
  'clinical_audit_events',
  // phiAccessLogger middleware writes one row per PHI request on this route.
  'hipaa_access_log',
  // auditLogMiddleware now attributes its detached universal row to the tenant.
  'audit_log',
];

async function clean() {
  await prisma.$transaction(async (tx) => {
    // Migration 599 makes clinical_timeline_events append-only (and the audit /
    // outbox evidence tables are similarly guarded). Teardown runs only against a
    // disposable test database, so it disables triggers for this ONE transaction
    // rather than weakening the production guard.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of CHILD_TABLES) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id IN ($1::uuid,$2::uuid)`,
        TENANT_A, TENANT_B,
      ).catch(() => {});
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, ALL_UIDS).catch(() => {});
  });

  // NEVER swallow the tenant DELETE — a leaked tenant keeps active config rows
  // that later sweeps in this DB will keep visiting, and the FK error names the
  // exact blocking child table, which is the most actionable signal available.
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B);
}

/** The lab alert is fire-and-forget in a setImmediate, so the HTTP response
 *  returns before it runs. Poll rather than guess a sleep duration. */
async function waitForPush(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sendPushMock.mock.calls.length > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** phiAccessLogger also writes after the response. Wait for this suite's
 *  tenant-scoped rows before teardown so a late insert cannot recreate an FK
 *  child after clean() has deleted hipaa_access_log. */
async function waitForPhiAuditWrites(expected, timeoutMs = 10000) {
  if (expected === 0) return;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM hipaa_access_log
        WHERE tenant_id = $1::uuid`,
      TENANT_A,
    );
    if (row.count >= expected) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

d('Investigation lab-alert fan-out is tenant scoped', () => {
  // tenants(id) is referenced by hundreds of FKs, so each tenant DELETE is slow.
  // Both hooks need an explicit timeout or the suite fails on jest's 5s default.
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'lab-alert-a','Lab Alert Tenant A')
       ON CONFLICT (id) DO NOTHING`, TENANT_A);
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'lab-alert-b','Lab Alert Tenant B')
       ON CONFLICT (id) DO NOTHING`, TENANT_B);

    patientAId = await seedUser(PATIENT_A, TENANT_A, 'PATIENT', '+919000045001', null);
    await seedUser(DOCTOR_A, TENANT_A, 'DOCTOR', '+919000045002', null);
    await seedUser(LAB_A, TENANT_A, 'LAB_STAFF', '+919000045003', TOKEN_LAB_A);
    await seedUser(NURSE_A, TENANT_A, 'NURSING_STAFF', '+919000045004', TOKEN_NURSE_A);
    // The decoy: an eligible lab tech in a DIFFERENT tenant. Pre-change this row
    // is exactly what the unscoped query would sweep up.
    await seedUser(LAB_B, TENANT_B, 'LAB_STAFF', '+919000045005', TOKEN_LAB_B);
  }, 120000);

  afterAll(async () => {
    await waitForPhiAuditWrites(expectedPhiAuditWrites);
    await waitForAuditLogDrain();
    await clean();
    await prisma.$disconnect().catch(() => {});
  }, 120000);

  beforeEach(() => sendPushMock.mockClear());

  it('pre-asserts the decoy is eligible, so the guard cannot go vacuous', async () => {
    // Without this, a typo in the decoy fixture (wrong role, inactive, null token)
    // would make the isolation assertion below pass for the wrong reason.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT device_token FROM users
        WHERE tenant_id = $1::uuid AND role IN ('LAB_STAFF','NURSING_STAFF')
          AND device_token IS NOT NULL AND is_active = TRUE`, TENANT_B);
    expect(rows.map((r) => r.device_token)).toEqual([TOKEN_LAB_B]);
  });

  it('alerts only the booking tenant\'s staff, never another tenant\'s', async () => {
    const res = await doctorOfTenantA().post(
      '/api/v1/investigations/bookings/create',
      { patient_id: patientAId, custom_test_names: 'CBC' },
    );
    expect(res.statusCode).toBe(200);
    expectedPhiAuditWrites += 1;

    expect(await waitForPush()).toBe(true);
    const pushed = sendPushMock.mock.calls[0][0];
    const tokens = Array.isArray(pushed.tokens) ? pushed.tokens : [pushed.tokens];

    // Both of tenant A's eligible staff are alerted...
    expect(tokens.sort()).toEqual([TOKEN_LAB_A, TOKEN_NURSE_A].sort());
    // ...and tenant B's lab tech is not. This is the assertion that fails
    // pre-change: the unscoped query returned all three tokens.
    expect(tokens).not.toContain(TOKEN_LAB_B);
  });

  it('the leaked payload really would have carried patient PHI', async () => {
    // Pins WHY this matters rather than just that a token list narrowed: the body
    // interpolates the patient's real name, so a cross-tenant delivery is a PHI
    // disclosure and not merely a misrouted ping.
    const res = await doctorOfTenantA().post(
      '/api/v1/investigations/bookings/create',
      { patient_id: patientAId, custom_test_names: 'Lipid Profile' },
    );
    expect(res.statusCode).toBe(200);
    expectedPhiAuditWrites += 1;
    expect(await waitForPush()).toBe(true);

    const { body } = sendPushMock.mock.calls[0][0];
    expect(body).toContain('LabAlert PATIENT');
  });

  it('resolves zero recipients for a tenant with no eligible staff', async () => {
    // The regression canary. users.tenant_id carries a column DEFAULT and several
    // staff-onboarding paths omit it, so staff can sit on the default tenant while
    // bookings are created under another — in which case correct scoping
    // legitimately matches nobody and the alert silently never sends. The service
    // must return an empty set (and log/count it) rather than fall back to an
    // unscoped sweep that would page strangers.
    const { tokens, totalMatched } = await resolveStaffPushRecipients(prisma, {
      tenantId: TENANT_B,
      roles: ['NURSING_STAFF'], // tenant B has only LAB_STAFF
      alert: 'test_zero_case',
    });
    expect(tokens).toEqual([]);
    expect(totalMatched).toBe(0);
  });

  it('reports the exact number of recipients dropped by the cap', async () => {
    // Restore immediately: jest runs suites sequentially in ONE process, so a
    // leaked env value would silently re-cap every later suite.
    const previous = process.env.STAFF_PUSH_FANOUT_CAP;
    process.env.STAFF_PUSH_FANOUT_CAP = '1';
    try {
      const { tokens, totalMatched, dropped } = await resolveStaffPushRecipients(prisma, {
        tenantId: TENANT_A,
        roles: ['LAB_STAFF', 'NURSING_STAFF'],
        alert: 'test_trim_case',
      });
      // COUNT(*) OVER () is evaluated before LIMIT, so the eligible total is exact
      // even though only one row came back.
      expect(tokens).toHaveLength(1);
      expect(totalMatched).toBe(2);
      expect(dropped).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.STAFF_PUSH_FANOUT_CAP;
      else process.env.STAFF_PUSH_FANOUT_CAP = previous;
    }
  });

  it('refuses to fan out without a tenant rather than sweeping every tenant', async () => {
    await expect(resolveStaffPushRecipients(prisma, {
      tenantId: null,
      roles: ['LAB_STAFF'],
      alert: 'test_missing_tenant',
    })).rejects.toThrow(/requires tenantId/);
  });

  it('clamps the cap to the Firebase multicast ceiling', async () => {
    // sendPushNotification THROWS above 500 tokens, so an operator raising the cap
    // to "stop dropping recipients" must not be able to flip the path from
    // notifying 500 staff to notifying zero.
    const { resolveFanoutCap, FCM_MULTICAST_LIMIT } = await import(
      '../services/notification/staffPushRecipientService.js'
    );
    expect(resolveFanoutCap({ STAFF_PUSH_FANOUT_CAP: '5000' })).toBe(FCM_MULTICAST_LIMIT);
    expect(resolveFanoutCap({ STAFF_PUSH_FANOUT_CAP: '0' })).toBe(FCM_MULTICAST_LIMIT);
    expect(resolveFanoutCap({ STAFF_PUSH_FANOUT_CAP: '25' })).toBe(25);
    expect(resolveFanoutCap({})).toBe(FCM_MULTICAST_LIMIT);
  });
});
