import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const ADMIN_UID = '11111111-2222-4333-8444-000000010099';
const INCHARGE_UID = '11111111-2222-4333-8444-000000010022';
const STAFF_UID = '11111111-2222-4333-8444-000000010020';
const NURSE_UID = '11111111-2222-4333-8444-000000010001';

function authed(role, uid, id) {
  const token = generateTestToken(role, { uid, id });
  return {
    get: path =>
      request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: path =>
      request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: path =>
      request(app).delete(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

describe('housekeeping floor delegation', () => {
  let adminId;
  let inchargeId;
  let staffId;
  let nurseId;
  let zoneId;
  let unusedZoneId;
  let assignmentId;
  let requestId;
  let rosterBoardId;
  let rosterPreferenceRequestId;

  beforeAll(async () => {
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2, 'Delegation Admin', 'ADMIN', true, NOW()),
         ($3::uuid, $4, 'Delegation Incharge', 'HOUSEKEEPING_INCHARGE', true, NOW()),
         ($5::uuid, $6, 'Delegation Staff', 'HOUSEKEEPING_STAFF', true, NOW()),
         ($7::uuid, $8, 'Delegation Nurse', 'NURSING_STAFF', true, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET is_active = EXCLUDED.is_active, role = EXCLUDED.role, updated_at = NOW()
       RETURNING id, uid`,
      ADMIN_UID,
      `98${STAMP.slice(-8)}0`,
      INCHARGE_UID,
      `98${STAMP.slice(-8)}1`,
      STAFF_UID,
      `98${STAMP.slice(-8)}2`,
      NURSE_UID,
      `98${STAMP.slice(-8)}3`
    );
    adminId = users.find(u => u.uid === ADMIN_UID)?.id;
    inchargeId = users.find(u => u.uid === INCHARGE_UID)?.id;
    staffId = users.find(u => u.uid === STAFF_UID)?.id;
    nurseId = users.find(u => u.uid === NURSE_UID)?.id;

    await prisma.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id IN ($1::uuid,$2::uuid)`,
      INCHARGE_UID,
      STAFF_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff (user_id, employee_id, name, designation, department, position, is_active, updated_at)
       VALUES
         ($1::uuid, $2, 'Delegation Incharge', 'Housekeeping Incharge', 'Housekeeping', 'Housekeeping Incharge', true, NOW()),
         ($3::uuid, $4, 'Delegation Staff', 'Housekeeping Staff', 'Housekeeping', 'Housekeeping Staff', true, NOW())`,
      INCHARGE_UID,
      `EMP-HKI-${STAMP.slice(-5)}`,
      STAFF_UID,
      `EMP-HKS-${STAMP.slice(-5)}`
    );

    const zones = await prisma.$queryRawUnsafe(
      `INSERT INTO housekeeping_zones (name, zone_type, floor, building, is_active)
       VALUES ($1, 'ward', '2', 'Main', true)
       RETURNING id`,
      `Delegation Ward ${STAMP}`
    );
    zoneId = zones[0].id;
  });

  afterAll(async () => {
    if (requestId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM housekeeping_request_updates WHERE request_id = $1::int`,
          requestId
        )
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(`DELETE FROM housekeeping_requests WHERE id = $1::int`, requestId)
        .catch(() => {});
    }
    if (assignmentId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM housekeeping_floor_assignments WHERE id = $1::int`,
          assignmentId
        )
        .catch(() => {});
    }
    if (rosterBoardId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM housekeeping_floor_assignments WHERE roster_board_id = $1::int`,
          rosterBoardId
        )
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM staff_shift_roster_boards WHERE id = $1::int`,
          rosterBoardId
        )
        .catch(() => {});
    }
    if (rosterPreferenceRequestId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM staff_shift_roster_request_audit WHERE request_id = $1::int`,
          rosterPreferenceRequestId
        )
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM staff_shift_roster_requests WHERE id = $1::int`,
          rosterPreferenceRequestId
        )
        .catch(() => {});
    }
    if (zoneId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM housekeeping_zones WHERE id = $1::int`, zoneId)
        .catch(() => {});
    }
    if (unusedZoneId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM housekeeping_zones WHERE id = $1::int`, unusedZoneId)
        .catch(() => {});
    }
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM staff WHERE user_id IN ($1::uuid,$2::uuid)`,
        INCHARGE_UID,
        STAFF_UID
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        ADMIN_UID,
        INCHARGE_UID,
        STAFF_UID,
        NURSE_UID
      )
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('returns active zones from the backend with floor and building metadata', async () => {
    const nurse = authed('NURSING_STAFF', NURSE_UID, nurseId);
    const res = await nurse.get('/api/v1/housekeeping/zones');

    expect(res.statusCode).toBe(200);
    const zone = (res.body.data ?? []).find(row => row.id === zoneId);
    expect(zone).toMatchObject({
      id: zoneId,
      floor: '2',
      building: 'Main',
      is_active: true
    });
  });

  it('lets housekeeping incharge delegate staff to a busy floor zone', async () => {
    const incharge = authed('HOUSEKEEPING_INCHARGE', INCHARGE_UID, inchargeId);
    const res = await incharge.post('/api/v1/housekeeping/delegation/assignments').send({
      staff_id: staffId,
      zone_id: zoneId,
      shift_label: 'morning',
      reason: 'Ward workload increased',
      is_temporary: true
    });

    expect(res.statusCode).toBe(200);
    assignmentId = res.body.data.assignment.id;
    expect(res.body.data.assignment).toMatchObject({
      staff_id: staffId,
      zone_id: zoneId,
      status: 'active',
      is_temporary: true
    });
  });

  it('keeps zone creation and removal admin-only', async () => {
    const incharge = authed('HOUSEKEEPING_INCHARGE', INCHARGE_UID, inchargeId);
    const denied = await incharge.post('/api/v1/housekeeping/zones').send({
      name: `Incharge Zone ${STAMP}`,
      zone_type: 'ward',
      floor: '3',
      building: 'Main'
    });
    expect(denied.statusCode).toBe(403);

    const admin = authed('ADMIN', ADMIN_UID, adminId);
    const created = await admin.post('/api/v1/housekeeping/zones').send({
      name: `Unused Zone ${STAMP}`,
      zone_type: 'ward',
      floor: '4',
      building: 'Annex'
    });
    expect(created.statusCode).toBe(200);
    unusedZoneId = created.body.data.id;

    const removed = await admin.delete(`/api/v1/housekeeping/zones/${unusedZoneId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.body.data).toMatchObject({ id: unusedZoneId, is_active: false });
  });

  it('does not remove a zone while staff are actively assigned to it', async () => {
    const admin = authed('ADMIN', ADMIN_UID, adminId);
    const res = await admin.delete(`/api/v1/housekeeping/zones/${zoneId}`);
    expect(res.statusCode).toBe(409);
  });

  it('surfaces active assignments in the incharge overview', async () => {
    const incharge = authed('HOUSEKEEPING_INCHARGE', INCHARGE_UID, inchargeId);
    const res = await incharge.get('/api/v1/housekeeping/delegation/overview');

    expect(res.statusCode).toBe(200);
    const assignments = res.body.data.assignments ?? [];
    expect(assignments.some(row => row.id === assignmentId && row.staff_id === staffId)).toBe(true);
  });

  it('saves and publishes a reusable central housekeeping shift roster board', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const incharge = authed('HOUSEKEEPING_INCHARGE', INCHARGE_UID, inchargeId);

    const saved = await incharge
      .post('/api/v1/staff/roster-board/departments/housekeeping/boards')
      .send({
        roster_date: tomorrow,
        shift_label: 'Morning',
        notes: 'Morning floor deployment',
        assignments: [
          {
            staff_id: staffId,
            assignment_target_type: 'housekeeping_zone',
            assignment_target_id: zoneId,
            is_lead: true
          }
        ]
      });

    expect(saved.statusCode).toBe(200);
    rosterBoardId = saved.body.data.id;
    expect(saved.body.data).toMatchObject({
      department: 'housekeeping',
      roster_date: tomorrow,
      status: 'draft'
    });
    expect(saved.body.data.assignments).toHaveLength(1);

    const published = await incharge
      .post(`/api/v1/staff/roster-board/boards/${rosterBoardId}/publish`)
      .send({ reason: 'Publish tomorrow morning roster' });

    expect(published.statusCode).toBe(200);
    expect(published.body.data).toMatchObject({
      id: rosterBoardId,
      department: 'housekeeping',
      status: 'published',
      projection_count: 1
    });

    const projection = await prisma.$queryRawUnsafe(
      `SELECT staff_id, zone_id, shift_label, assignment_kind, is_temporary, status
         FROM housekeeping_floor_assignments
        WHERE roster_board_id = $1::int
        LIMIT 1`,
      rosterBoardId
    );
    expect(projection[0]).toMatchObject({
      staff_id: staffId,
      zone_id: zoneId,
      shift_label: 'Morning',
      assignment_kind: 'roster',
      is_temporary: false,
      status: 'active'
    });
  });

  it('keeps ordinary housekeeping staff out of the central roster board', async () => {
    const staff = authed('HOUSEKEEPING_STAFF', STAFF_UID, staffId);
    const res = await staff.get('/api/v1/staff/roster-board/departments/housekeeping');
    expect(res.statusCode).toBe(403);
  });

  it('lets staff request duty preferences and manager approval leaves an audit trail', async () => {
    const rosterDate = new Date(Date.now() + 172_800_000).toISOString().slice(0, 10);
    const nurse = authed('NURSING_STAFF', NURSE_UID, nurseId);

    const created = await nurse.post('/api/v1/staff/roster-board/requests').send({
      department: 'nursing',
      requested_start_date: rosterDate,
      requested_end_date: rosterDate,
      period_type: 'day',
      shift_label: 'Morning',
      reason: 'Prefers ward duty that day'
    });

    expect(created.statusCode).toBe(200);
    rosterPreferenceRequestId = created.body.data.id;
    expect(created.body.data).toMatchObject({
      staff_id: nurseId,
      department: 'nursing',
      status: 'pending',
      shift_label: 'Morning'
    });

    const mine = await nurse.get('/api/v1/staff/roster-board/requests/my');
    expect(mine.statusCode).toBe(200);
    expect((mine.body.data ?? []).some(row => row.id === rosterPreferenceRequestId)).toBe(true);

    const admin = authed('ADMIN', ADMIN_UID, adminId);
    const snapshot = await admin.get(`/api/v1/staff/roster-board/departments/nursing?date=${rosterDate}`);
    expect(snapshot.statusCode).toBe(200);
    expect(
      (snapshot.body.data.requests ?? []).some(row => row.id === rosterPreferenceRequestId)
    ).toBe(true);

    const reviewed = await admin
      .post(`/api/v1/staff/roster-board/requests/${rosterPreferenceRequestId}/review`)
      .send({ decision: 'approved', review_notes: 'Rostered preference accepted' });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.body.data).toMatchObject({
      id: rosterPreferenceRequestId,
      status: 'approved',
      reviewed_by: adminId
    });

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, actor_id
         FROM staff_shift_roster_request_audit
        WHERE request_id = $1::int
        ORDER BY created_at DESC`,
      rosterPreferenceRequestId
    );
    expect(audit.map(row => row.action)).toEqual(expect.arrayContaining(['created', 'approved']));
    expect(audit.some(row => row.actor_id === adminId)).toBe(true);
  });

  it('auto-routes new zone requests to the active delegated staff member', async () => {
    const nurse = authed('NURSING_STAFF', NURSE_UID, nurseId);
    const res = await nurse.post('/api/v1/housekeeping/requests').send({
      zone_id: zoneId,
      request_type: 'cleaning',
      urgency: 'high',
      description: 'Patient room needs priority cleaning'
    });

    expect(res.statusCode).toBe(200);
    requestId = res.body.data.id;
    expect(res.body.data).toMatchObject({
      assigned_to: staffId,
      status: 'assigned'
    });
  });

  it('lets assigned housekeeping staff start their live task queue item', async () => {
    const staff = authed('HOUSEKEEPING_STAFF', STAFF_UID, staffId);
    const started = await staff.post(`/api/v1/housekeeping/requests/${requestId}/start`).send({});

    expect(started.statusCode).toBe(200);
    expect(started.body.data).toMatchObject({
      id: requestId,
      status: 'in_progress'
    });

    const mine = await staff.get('/api/v1/housekeeping/requests/my');
    expect(mine.statusCode).toBe(200);
    expect(
      (mine.body.data.assigned ?? []).some(
        row => row.id === requestId && row.status === 'in_progress'
      )
    ).toBe(true);
  });

  it('keeps ordinary housekeeping staff out of the delegation console', async () => {
    const staff = authed('HOUSEKEEPING_STAFF', STAFF_UID, staffId);
    const res = await staff.get('/api/v1/housekeeping/delegation/overview');
    expect(res.statusCode).toBe(403);
  });
});
