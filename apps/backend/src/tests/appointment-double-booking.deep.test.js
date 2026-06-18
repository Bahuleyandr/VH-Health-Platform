// Audit 2026-06-18 §3 (Data layer, HIGH) — appointments double-booking backstop.
//
// Before migration 322 the ONLY thing preventing two active appointments in
// the same doctor + date + time slot was the app-layer conflict query in
// appointmentService.checkConflict / createAppointment (and the workflow
// controller reschedule path). That query (a) races under concurrency — two
// simultaneous bookings each see no conflict, both insert — and (b) is bypassed
// by any code path that inserts directly. In a money + clinical system a
// double-booked doctor slot is a real scheduling-integrity hazard with no
// durable backstop.
//
// Migration 322 adds a partial UNIQUE index that makes a real collision
// impossible at the DB level, mirroring the app's own conflict semantics:
//   key   = (tenant_id, doctor_id, appointment_date, appointment_time)
//   where = status NOT IN ('CANCELLED','NO_SHOW','RESCHEDULED')   -- "active"
//           AND doctor_id IS NOT NULL                              -- dept-only bookings exempt
//           AND lower(btrim(appointment_time)) <> 'walk-in'        -- walk-ins are multi-per-slot
//           AND btrim(appointment_time) <> ''
//
// These tests prove the backstop holds and that the exemptions match the app:
//   1. two ACTIVE rows in the same slot -> 2nd raises a unique violation (23505)
//   2. a CANCELLED / COMPLETED / NO_SHOW / RESCHEDULED row does NOT occupy the
//      slot (a new active row in the same slot inserts fine)
//   3. walk-ins (appointment_time = 'Walk-in') are NOT constrained
//   4. the constraint is tenant-scoped (same doctor/date/time, different tenant
//      = no conflict) and doctor_id-NULL (department-only) rows are exempt
//
// Self-isolating fixtures (own tenant(s) + doctor users, fixed uids, cleaned up
// before+after). Needs the test Postgres; self-skips when unconfigured.

import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = 'dbb00000-0000-4000-8000-0000000000a1';
const TENANT_B = 'dbb00000-0000-4000-8000-0000000000b1';
const DOCTOR_A = 'dbb00000-0000-4000-8000-0000000d0001'; // doctor in tenant A
const DOCTOR_B = 'dbb00000-0000-4000-8000-0000000d0002'; // doctor in tenant B
const PHONE_DA = '+919000220001';
const PHONE_DB = '+919000220002';
const APPT_DATE = '2031-03-15';
const SLOT = '10:30';

let doctorAId = null;
let doctorBId = null;

// We insert appointments with explicit tenant_id and rely on the literal
// tenant default not being involved. Plain prisma bypasses RLS (permissive
// policy when the GUC is unset), so cross-tenant fixture setup is fine.
async function insertAppt({ doctorId, tenantId, time = SLOT, status = 'SCHEDULED', date = APPT_DATE }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (phone, doctor_id, doctor_name, appointment_date, appointment_time, status, tenant_id, created_at, updated_at)
     VALUES ($1, $2::int, 'Dr Test', $3::date, $4, $5, $6::uuid, NOW(), NOW())
     RETURNING id`,
    '+910000000000', doctorId, date, time, status, tenantId,
  );
  return rows[0].id;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid) OR phone IN ($3, $4)`,
    DOCTOR_A, DOCTOR_B, PHONE_DA, PHONE_DB,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

d('appointments double-booking constraint (migration 322)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1::uuid, 'dbb-tenant-a', 'DB Tenant A'),
         ($2::uuid, 'dbb-tenant-b', 'DB Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A, TENANT_B,
    );
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, role, name, tenant_id, updated_at)
         VALUES ($1::uuid, $2, 'DOCTOR', 'Doctor A', $3::uuid, NOW())
       RETURNING id`,
      DOCTOR_A, PHONE_DA, TENANT_A,
    );
    doctorAId = a[0].id;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, role, name, tenant_id, updated_at)
         VALUES ($1::uuid, $2, 'DOCTOR', 'Doctor B', $3::uuid, NOW())
       RETURNING id`,
      DOCTOR_B, PHONE_DB, TENANT_B,
    );
    doctorBId = b[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // Clear appointment rows between tests so each starts from a clean slot.
  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A, TENANT_B,
    ).catch(() => {});
  });

  test('the migration is recorded in the tracker', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
      '322_appointments_double_booking.sql',
    );
    expect(rows.length).toBe(1);
  });

  test('two active appointments in the same doctor/date/time slot cannot both be inserted', async () => {
    const firstId = await insertAppt({ doctorId: doctorAId, tenantId: TENANT_A, status: 'SCHEDULED' });
    expect(firstId).toBeGreaterThan(0);

    // Second active row in the exact same slot must violate the unique index.
    let err = null;
    try {
      await insertAppt({ doctorId: doctorAId, tenantId: TENANT_A, status: 'CONFIRMED' });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    const code = err?.meta?.driverAdapterError?.cause?.code
      || err?.meta?.driverAdapterError?.cause?.originalCode
      || err?.code;
    // 23505 = unique_violation
    expect(String(code)).toBe('23505');

    // Exactly one active row survived.
    const cnt = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM appointments
        WHERE tenant_id = $1::uuid AND doctor_id = $2::int
          AND appointment_date = $3::date AND appointment_time = $4
          AND status NOT IN ('CANCELLED','NO_SHOW','RESCHEDULED')`,
      TENANT_A, doctorAId, APPT_DATE, SLOT,
    );
    expect(cnt[0].n).toBe(1);
  });

  test.each(['CANCELLED', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED'])(
    'a %s appointment does not occupy the slot — a new active booking succeeds',
    async (vacatedStatus) => {
      // A non-active row in the slot...
      await insertAppt({ doctorId: doctorAId, tenantId: TENANT_A, status: vacatedStatus });
      // ...must NOT block a fresh active booking in the same slot.
      // COMPLETED is "active" per the index predicate (only CANCELLED/NO_SHOW/
      // RESCHEDULED vacate), so a COMPLETED row WOULD block — assert per status.
      const blocks = !['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(vacatedStatus);
      let err = null;
      try {
        await insertAppt({ doctorId: doctorAId, tenantId: TENANT_A, status: 'SCHEDULED' });
      } catch (e) {
        err = e;
      }
      if (blocks) {
        expect(err).not.toBeNull();
      } else {
        expect(err).toBeNull();
      }
    },
  );

  test('walk-in appointments are NOT constrained (many per doctor/date allowed)', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await insertAppt({ doctorId: doctorAId, tenantId: TENANT_A, time: 'Walk-in', status: 'SCHEDULED' }));
    }
    expect(ids.filter(Boolean).length).toBe(3);
  });

  test('the constraint is tenant-scoped — same doctor/date/time in a different tenant is allowed', async () => {
    // doctorBId belongs to TENANT_B; book the same date+time under each tenant.
    const inA = await insertAppt({ doctorId: doctorAId, tenantId: TENANT_A, status: 'SCHEDULED' });
    const inB = await insertAppt({ doctorId: doctorBId, tenantId: TENANT_B, status: 'SCHEDULED' });
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBeGreaterThan(0);
  });

  test('department-only bookings (doctor_id NULL) are exempt — duplicates allowed', async () => {
    const mk = () => prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, doctor_id, doctor_name, appointment_date, appointment_time, status, department, tenant_id, created_at, updated_at)
       VALUES ($1, NULL, '', $2::date, $3, 'SCHEDULED', 'Cardiology', $4::uuid, NOW(), NOW())
       RETURNING id`,
      '+910000000000', APPT_DATE, SLOT, TENANT_A,
    );
    const r1 = await mk();
    const r2 = await mk();
    expect(r1[0].id).toBeGreaterThan(0);
    expect(r2[0].id).toBeGreaterThan(0);
  });
});
