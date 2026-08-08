// Housekeeping write-path transactionality.
//
// The multi-statement housekeeping mutations (request UPDATE/INSERT + linked
// bed flip + system update row + canonical timeline/audit emit) used to run as
// separate statements on the plain client — a failure mid-path left a
// half-updated request with a stale bed and no canonical rows. They now run in
// a single transaction, so a canonical emit failure rolls the whole write
// back. This suite keeps Prisma real and fault-injects the canonical writer
// (same pattern as clinical-mutation-canonical-null-rollback.deep.test.js).
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
let failCanonical = false;
const recordCanonicalClinicalEventMock = jest.fn(async (input, options) => {
  if (failCanonical) throw new Error('injected canonical failure');
  return actualCanonical.recordCanonicalClinicalEvent(input, options);
});
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const prisma = (await import('../lib/prisma.js')).default;
const housekeepingController = await import('../controllers/staff/housekeepingController.js');
const { emitHousekeepingRequestStatus } = await import(
  '../services/clinical/canonicalOperationalBridgeService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const STAFF_UID = randomUUID();
const PHONE = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const WARD_NAME = `HK-TX-${randomUUID().slice(0, 8)}`;
const RAISE_LOCATION = `HK-TX corridor ${randomUUID().slice(0, 8)}`;
const APP_ROLE = process.env.AUDIT_APPEND_ONLY_TEST_ROLE || 'rls_test_app';

let staffId;
let wardId;
const requestIds = [];
const bedIds = [];

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

async function appRoleAvailable() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    APP_ROLE,
  );
  return rows.length > 0 && rows[0].rolsuper === false && rows[0].rolbypassrls === false;
}

async function seedDirtyBed(bedNumber) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
     VALUES ($1, $2, $3, 'general', 'dirty', $4::uuid) RETURNING id`,
    wardId,
    WARD_NAME,
    bedNumber,
    TENANT,
  );
  bedIds.push(rows[0].id);
  return rows[0].id;
}

async function seedAssignedRequest(bedId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO housekeeping_requests
       (requester_id, requester_uid, location_text, request_type, urgency, description,
        status, assigned_to, assigned_to_uid, assigned_at, tenant_id, updated_at)
     VALUES ($1::int, $2::uuid, $3, 'bed_cleaning', 'high', $4,
             'assigned', $1::int, $2::uuid, NOW(), $5::uuid, NOW())
     RETURNING id, request_number, status`,
    staffId,
    STAFF_UID,
    WARD_NAME,
    `Bed turnover cleaning required for ${WARD_NAME}. bed_id=${bedId}.`,
    TENANT,
  );
  requestIds.push(rows[0].id);
  return rows[0];
}

async function requestState(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, completed_at FROM housekeeping_requests WHERE id = $1::int`,
    id,
  );
  return rows[0] || null;
}

async function bedStatus(id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1::int`, id);
  return rows[0]?.status || null;
}

async function updateCount(requestId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM housekeeping_request_updates WHERE request_id = $1::int`,
    requestId,
  );
  return rows[0].count;
}

// Housekeeping requests carry no patient identity, so the canonical emit
// persists a clinical_audit_events row (+ SLA instance on raise) — the
// patient-facing timeline writer no-ops without a patient_uid.
async function auditCount(requestId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM clinical_audit_events
      WHERE resource_table = 'housekeeping_requests' AND resource_id = $1`,
    String(requestId),
  );
  return rows[0].count;
}

async function slaCount(requestId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM workflow_sla_instances
      WHERE source_table = 'housekeeping_requests' AND source_id = $1`,
    String(requestId),
  );
  return rows[0].count;
}

async function cleanup() {
  const ids = requestIds.map(String);
  if (ids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE source_table = 'housekeeping_requests' AND source_id = ANY($1::text[])`,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events
        WHERE source_table = 'housekeeping_requests' AND source_id = ANY($1::text[])`,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
        WHERE resource_table = 'housekeeping_requests' AND resource_id = ANY($1::text[])`,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE resource = 'housekeeping_request' AND resource_id = ANY($1::text[])`,
      ids,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_request_updates
      WHERE request_id IN (SELECT id FROM housekeeping_requests WHERE requester_id = $1::int)`,
    staffId || -1,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_request_recipients
      WHERE request_id IN (SELECT id FROM housekeeping_requests WHERE requester_id = $1::int)`,
    staffId || -1,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_requests WHERE requester_id = $1::int`,
    staffId || -1,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE ward_name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, STAFF_UID).catch(() => {});
}

d('housekeeping write-path transactionality', () => {
  beforeAll(async () => {
    const staffRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'HK TX Staff', 'HOUSEKEEPING_STAFF', true, $3::uuid, NOW())
       RETURNING id`,
      STAFF_UID,
      PHONE,
      TENANT,
    );
    staffId = staffRows[0].id;
    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 4) RETURNING id`,
      WARD_NAME,
    );
    wardId = wardRows[0].id;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    failCanonical = false;
    recordCanonicalClinicalEventMock.mockClear();
  });

  test('startRequest rolls the request, bed, and update row back when the canonical emit fails', async () => {
    const bedId = await seedDirtyBed(`HKTX-A-${requestIds.length}`);
    const request = await seedAssignedRequest(bedId);

    failCanonical = true;
    const res = mockRes();
    await housekeepingController.startRequest(
      { params: { id: String(request.id) }, user: { uid: STAFF_UID, role: 'HOUSEKEEPING_STAFF' } },
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalled();
    // Whole write rolled back: no half-updated request, no stale bed flip,
    // no orphan system-update row, no canonical rows.
    expect((await requestState(request.id)).status).toBe('assigned');
    expect(await bedStatus(bedId)).toBe('dirty');
    expect(await updateCount(request.id)).toBe(0);
    expect(await auditCount(request.id)).toBe(0);
  }, 30_000);

  test('startRequest commits detail row, bed flip, update row, and canonical rows together', async () => {
    const bedId = await seedDirtyBed(`HKTX-B-${requestIds.length}`);
    const request = await seedAssignedRequest(bedId);

    const res = mockRes();
    await housekeepingController.startRequest(
      { params: { id: String(request.id) }, user: { uid: STAFF_UID, role: 'HOUSEKEEPING_STAFF' } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect((await requestState(request.id)).status).toBe('in_progress');
    expect(await bedStatus(bedId)).toBe('cleaning');
    // Linked-bed system note + started note.
    expect(await updateCount(request.id)).toBe(2);
    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE resource_table = 'housekeeping_requests' AND resource_id = $1`,
      String(request.id),
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe('housekeeping.started');
  }, 30_000);

  test('raiseRequest rolls the whole insert back when the canonical emit fails', async () => {
    failCanonical = true;
    const res = mockRes();
    await housekeepingController.raiseRequest(
      {
        user: { uid: STAFF_UID, role: 'HOUSEKEEPING_STAFF' },
        body: { location_text: RAISE_LOCATION, urgency: 'high', request_type: 'cleaning' },
      },
      res,
    );

    expect(res.statusCode).toBe(500);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM housekeeping_requests WHERE location_text = $1`,
      RAISE_LOCATION,
    );
    expect(rows).toHaveLength(0);
  }, 30_000);

  test('raiseRequest commits the request with its canonical rows', async () => {
    const res = mockRes();
    await housekeepingController.raiseRequest(
      {
        user: { uid: STAFF_UID, role: 'HOUSEKEEPING_STAFF' },
        body: { location_text: RAISE_LOCATION, urgency: 'high', request_type: 'cleaning' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const requestId = res.body.data.id;
    requestIds.push(requestId);
    expect(await updateCount(requestId)).toBe(1);
    expect(await auditCount(requestId)).toBe(1);
    expect(await slaCount(requestId)).toBe(1);
  }, 30_000);

  test('the in-tx canonical emit path works under the sealed non-superuser app role', async () => {
    if (!(await appRoleAvailable())) {
      console.warn(`Skipping: app role ${APP_ROLE} not present as NOSUPERUSER NOBYPASSRLS`);
      return;
    }
    const bedId = await seedDirtyBed(`HKTX-C-${requestIds.length}`);
    const request = await seedAssignedRequest(bedId);

    // Reproduce the controller's transactional shape under the sealed prod
    // posture: the append-only guards (migrations 324/599) must not block the
    // in-tx INSERT emits, and the migration-575 audit trigger must fire.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      const updated = await tx.$queryRawUnsafe(
        `UPDATE housekeeping_requests
            SET status = 'in_progress', updated_at = NOW()
          WHERE id = $1::int
          RETURNING id, request_number, status, request_type, completed_at, updated_at, created_at`,
        request.id,
      );
      await emitHousekeepingRequestStatus({
        db: tx,
        request: updated[0],
        actorUid: STAFF_UID,
        actorRole: 'HOUSEKEEPING_STAFF',
        eventType: 'housekeeping.started',
        previousStatus: 'assigned',
      });
    });

    expect((await requestState(request.id)).status).toBe('in_progress');
    expect(await auditCount(request.id)).toBe(1);
  }, 30_000);
});
