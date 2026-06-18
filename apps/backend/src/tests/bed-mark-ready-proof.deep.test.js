// MEDIUM (audit 2026-06-18 §4) — markBedReady must (a) write its audit row
// SYNCHRONOUSLY (in-band) and (b) require proof-of-cleaning.
//
// Defects:
//   * The BED_MARKED_READY audit_logs INSERT ran in setImmediate (fire-and-
//     forget) — a crash / process exit between the bed flip and the deferred
//     callback loses the only record of who closed the cleaning loop.
//   * A bed could be flipped cleaning → available with NO cleaning ticket and
//     NO cleaner — an infection-control proof gap.
//
// Fixes proven here against the real service + real DB:
//   1. Marking ready with NO proof (no cleaner, no ticket) is REJECTED and the
//      bed stays 'cleaning'.
//   2. A cleaningTicketId that is NOT resolved (still 'open') is REJECTED.
//   3. A resolved cleaning ticket (status 'completed') lets the bed go ready AND
//      the audit_logs row is present SYNCHRONOUSLY by the time the call returns
//      (no setImmediate race).
//   4. A cleanerId alone (direct attestation) is sufficient proof.
//
// Self-isolating fixtures.

import prisma from '../lib/prisma.js';
import bedManagementService from '../services/bed/bedManagementService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = 'b6ed0000-0000-4000-8000-0000000000c1';
const CLEANER_UID = 'b6ed0000-0000-4000-8000-0000000000c2';
const WARD_NAME = 'BED-READY-PROOF-WARD';

let wardId;
let actorId;

async function bedStatus(bedId) {
  const rows = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedId);
  return rows[0]?.status ?? null;
}
async function auditCount(bedId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM audit_logs
      WHERE action = 'BED_MARKED_READY' AND resource = 'bed' AND resource_id = $1`,
    String(bedId),
  );
  return Number(rows[0]?.n ?? 0);
}
async function makeCleaningBed(suffix) {
  const b = await prisma.$queryRawUnsafe(
    `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
     VALUES ($1, $2, $3, 'general', 'cleaning', $4::uuid) RETURNING id`,
    wardId, WARD_NAME, `BRP-${suffix}`, TENANT_ID,
  );
  return b[0].id;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE resource = 'bed' AND resource_id IN
       (SELECT id::text FROM beds WHERE bed_number LIKE 'BRP-%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM housekeeping_requests WHERE location_text LIKE 'BRP-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number LIKE 'BRP-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, ACTOR_UID, CLEANER_UID).catch(() => {});
}

d('markBedReady proof-of-cleaning + synchronous audit (MEDIUM §4)', () => {
  beforeAll(async () => {
    await cleanup();
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '9000088001', 'Bed Ready Actor', 'HOUSEKEEPING', true, $2::uuid, NOW())
       RETURNING id`,
      ACTOR_UID, TENANT_ID,
    );
    actorId = a[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '9000088002', 'Bed Cleaner', 'HOUSEKEEPING', true, $2::uuid, NOW())`,
      CLEANER_UID, TENANT_ID,
    );
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 5) RETURNING id`, WARD_NAME,
    );
    wardId = w[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects mark-ready with NO proof (no cleaner, no ticket) — bed stays cleaning', async () => {
    const bedId = await makeCleaningBed('NOPROOF');
    await expect(
      bedManagementService.markBedReady(bedId, { actorUid: ACTOR_UID, tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await bedStatus(bedId)).toBe('cleaning');
    expect(await auditCount(bedId)).toBe(0);
  });

  it('rejects an UNRESOLVED cleaning ticket (status open) — bed stays cleaning', async () => {
    const bedId = await makeCleaningBed('OPENTKT');
    const tkt = await prisma.$queryRawUnsafe(
      `INSERT INTO housekeeping_requests (requester_id, location_text, request_type, status)
       VALUES ($1, $2, 'cleaning', 'open') RETURNING id`,
      actorId, `BRP-OPENTKT`,
    );
    await expect(
      bedManagementService.markBedReady(bedId, {
        actorUid: ACTOR_UID, cleaningTicketId: tkt[0].id, tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await bedStatus(bedId)).toBe('cleaning');
  });

  it('a RESOLVED cleaning ticket lets the bed go ready AND writes the audit row synchronously', async () => {
    const bedId = await makeCleaningBed('DONETKT');
    const tkt = await prisma.$queryRawUnsafe(
      `INSERT INTO housekeeping_requests (requester_id, location_text, request_type, status, completed_at)
       VALUES ($1, $2, 'cleaning', 'completed', NOW()) RETURNING id`,
      actorId, `BRP-DONETKT`,
    );
    const bed = await bedManagementService.markBedReady(bedId, {
      actorUid: ACTOR_UID, cleaningTicketId: tkt[0].id, tenantId: TENANT_ID,
    });
    expect(bed.status).toBe('available');
    // Audit row is present the MOMENT the call returns — no setImmediate race.
    expect(await auditCount(bedId)).toBe(1);
  });

  it('a cleanerId alone is sufficient proof (direct attestation)', async () => {
    const bedId = await makeCleaningBed('CLEANER');
    const bed = await bedManagementService.markBedReady(bedId, {
      actorUid: ACTOR_UID, cleanerId: CLEANER_UID, tenantId: TENANT_ID,
    });
    expect(bed.status).toBe('available');
    expect(await auditCount(bedId)).toBe(1);
  });
});
