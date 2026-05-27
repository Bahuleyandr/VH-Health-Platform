import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const INCHARGE_UID = '11111111-2222-4333-8444-000000010022';
const STAFF_UID = '11111111-2222-4333-8444-000000010020';
const NURSE_UID = '11111111-2222-4333-8444-000000010001';

function authed(role, uid, id) {
  const token = generateTestToken(role, { uid, id });
  return {
    get: path =>
      request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

describe('housekeeping floor delegation', () => {
  let inchargeId;
  let staffId;
  let nurseId;
  let zoneId;
  let assignmentId;
  let requestId;

  beforeAll(async () => {
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2, 'Delegation Incharge', 'HOUSEKEEPING_INCHARGE', true, NOW()),
         ($3::uuid, $4, 'Delegation Staff', 'HOUSEKEEPING_STAFF', true, NOW()),
         ($5::uuid, $6, 'Delegation Nurse', 'NURSING_STAFF', true, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET is_active = EXCLUDED.is_active, role = EXCLUDED.role, updated_at = NOW()
       RETURNING id, uid`,
      INCHARGE_UID,
      `98${STAMP.slice(-8)}1`,
      STAFF_UID,
      `98${STAMP.slice(-8)}2`,
      NURSE_UID,
      `98${STAMP.slice(-8)}3`
    );
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
    if (zoneId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM housekeeping_zones WHERE id = $1::int`, zoneId)
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
        `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`,
        INCHARGE_UID,
        STAFF_UID,
        NURSE_UID
      )
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
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

  it('surfaces active assignments in the incharge overview', async () => {
    const incharge = authed('HOUSEKEEPING_INCHARGE', INCHARGE_UID, inchargeId);
    const res = await incharge.get('/api/v1/housekeeping/delegation/overview');

    expect(res.statusCode).toBe(200);
    const assignments = res.body.data.assignments ?? [];
    expect(assignments.some(row => row.id === assignmentId && row.staff_id === staffId)).toBe(true);
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

  it('keeps ordinary housekeeping staff out of the delegation console', async () => {
    const staff = authed('HOUSEKEEPING_STAFF', STAFF_UID, staffId);
    const res = await staff.get('/api/v1/housekeeping/delegation/overview');
    expect(res.statusCode).toBe(403);
  });
});
