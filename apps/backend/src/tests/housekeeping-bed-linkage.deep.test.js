// Phase-3 B-L4 — bed↔ticket linkage must be the structured
// housekeeping_requests.bed_id column (migration 643), not a spoofable
// free-text "bed_id=N." marker parsed out of user-suppliable description text.
//
// Pre-fix, a manual request whose description merely CONTAINED "bed_id=N."
// (a) satisfied the dispatcher's dedupe probe — suppressing the real
// bed-cleaning dispatch for bed N, and (b) silenced the missing-dispatch
// sweep the same way, so a cleaning bed could sit with no real ticket forever.
//
// Proven against the real dispatch service + real QA DB:
//   1. createBedCleaningRequest ignores a spoofed free-text marker and creates
//      a REAL request carrying bed_id (+ patient_uid when the discharge flow
//      passes one).
//   2. The dedupe probe keys on bed_id: a second dispatch for the same bed
//      returns the existing linked request (created:false), not a duplicate.
//   3. sweepMissingBedCleaningDispatches treats only bed_id-linked tickets as
//      dispatch evidence — a spoofed marker does not stop the sweep from
//      re-dispatching.
//
// Self-isolating fixtures.

import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const {
  createBedCleaningRequest,
  sweepMissingBedCleaningDispatches,
} = await import('../services/staff/housekeepingTaskDispatchService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const REQUESTER_UID = randomUUID();
const PATIENT_UID = randomUUID();
const REQUESTER_PHONE = `9100${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const PATIENT_PHONE = `9100${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const WARD_NAME = `HK-LINK-${randomUUID().slice(0, 8)}`;

let requesterId;
let wardId;
let bedA;
let bedB;

async function makeCleaningBed(bedNumber) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
     VALUES ($1, $2, $3, 'general', 'cleaning', $4::uuid) RETURNING id`,
    wardId, WARD_NAME, bedNumber, TENANT_ID,
  );
  return rows[0].id;
}

async function insertSpoofedRequest(bedId) {
  // A manual (non-dispatch) request whose free text carries the legacy marker.
  // bed_id stays NULL — exactly what the manual endpoints produce.
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO housekeeping_requests
       (requester_id, requester_uid, location_text, request_type, urgency,
        description, status, tenant_id, updated_at)
     VALUES ($1::int, $2::uuid, $3, 'cleaning', 'high', $4, 'open', $5::uuid, NOW())
     RETURNING id`,
    requesterId, REQUESTER_UID, WARD_NAME,
    `Please also check the corridor. bed_id=${bedId}.`,
    TENANT_ID,
  );
  return rows[0].id;
}

async function linkedRequests(bedId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, bed_id, patient_uid, request_type, status
       FROM housekeeping_requests
      WHERE tenant_id = $1::uuid AND bed_id = $2::int
      ORDER BY id`,
    TENANT_ID, bedId,
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances
      WHERE source_table = 'housekeeping_requests'
        AND source_id IN (
          SELECT id::text FROM housekeeping_requests WHERE requester_uid = $1::uuid OR location_text = $2
        )`,
    REQUESTER_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events
      WHERE resource_table = 'housekeeping_requests'
        AND resource_id IN (
          SELECT id::text FROM housekeeping_requests WHERE requester_uid = $1::uuid OR location_text = $2
        )`,
    REQUESTER_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_request_updates
      WHERE request_id IN (
        SELECT id FROM housekeeping_requests WHERE requester_uid = $1::uuid OR location_text = $2
      )`,
    REQUESTER_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_request_recipients
      WHERE request_id IN (
        SELECT id FROM housekeeping_requests WHERE requester_uid = $1::uuid OR location_text = $2
      )`,
    REQUESTER_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_requests WHERE requester_uid = $1::uuid OR location_text = $2`,
    REQUESTER_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE ward_name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, REQUESTER_UID, PATIENT_UID,
  ).catch(() => {});
}

d('housekeeping bed↔ticket structured linkage (B-L4)', () => {
  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'HK Link Incharge', 'HOUSEKEEPING_INCHARGE', true, $3::uuid, NOW())
       RETURNING id`,
      REQUESTER_UID, REQUESTER_PHONE, TENANT_ID,
    );
    requesterId = u[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'HK Link Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 4) RETURNING id`, WARD_NAME,
    );
    wardId = w[0].id;
    bedA = await makeCleaningBed(`HKL-A-${randomUUID().slice(0, 4)}`);
    bedB = await makeCleaningBed(`HKL-B-${randomUUID().slice(0, 4)}`);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('dispatch ignores a spoofed free-text marker and creates a real bed_id-linked request', async () => {
    const spoofId = await insertSpoofedRequest(bedA);

    const { request, created } = await createBedCleaningRequest({
      bedId: bedA,
      requesterUid: REQUESTER_UID,
      trigger: 'final_discharge',
      urgency: 'high',
      patientUid: PATIENT_UID,
    });

    expect(created).toBe(true);
    expect(request.id).not.toBe(spoofId);
    expect(Number(request.bed_id)).toBe(bedA);
    expect(String(request.patient_uid)).toBe(PATIENT_UID);

    const linked = await linkedRequests(bedA);
    expect(linked).toHaveLength(1);
    expect(linked[0].request_type).toBe('bed_cleaning');
  }, 30_000);

  it('dedupe keys on bed_id: a second dispatch returns the existing linked request', async () => {
    const again = await createBedCleaningRequest({
      bedId: bedA,
      requesterUid: REQUESTER_UID,
      trigger: 'bed_cleaning',
      urgency: 'high',
    });
    expect(again.created).toBe(false);
    expect((await linkedRequests(bedA)).length).toBe(1);
  }, 30_000);

  it('the sweep re-dispatches a cleaning bed whose only "ticket" is a spoofed marker', async () => {
    await insertSpoofedRequest(bedB);
    expect(await linkedRequests(bedB)).toHaveLength(0);

    const result = await sweepMissingBedCleaningDispatches({ tenantId: TENANT_ID, limit: 500 });
    expect(result.scanned).toBeGreaterThanOrEqual(1);

    const linked = await linkedRequests(bedB);
    expect(linked).toHaveLength(1);
    expect(linked[0].request_type).toBe('bed_cleaning');
    expect(['open', 'assigned']).toContain(linked[0].status);
  }, 60_000);

  it('patient-tied dispatch lands a canonical timeline row for that patient', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, event_type FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND source_table = 'housekeeping_requests'`,
      PATIENT_UID,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.event_type)).toContain('housekeeping.requested');
  }, 30_000);
});
