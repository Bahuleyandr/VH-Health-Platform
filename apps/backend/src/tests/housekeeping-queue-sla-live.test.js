// Regression test for finding 2026-05-22-inpatient-admission-housekeeping-7a73a9b5.
//
// `GET /api/v1/housekeeping/requests` had two bugs:
//   (a) `sla_breached` came from the stored column, set by an async
//       breach-detector job. A ticket past its SLA could still show
//       `sla_breached: false` between job runs — `/stats` said "8
//       currently breached" while every row had sla_breached: false.
//   (b) ORDER BY was urgency tier THEN newest-first — older breached
//       dirty-bed tickets sank below newer ones and were invisible
//       to housekeeping staff, blocking discharge throughput.
//
// Fix:
//   - Compute the live breach at read time and surface it as
//     `sla_breached` (overriding the stored value); keep the stored
//     value as `sla_breached_stored` for forensics.
//   - ORDER BY now puts live-breached first, then urgency, then
//     oldest-due / oldest-created first.

import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { generateTestToken } from './testClient.js';

const ADMIN_UID = 'd1000000-0000-4000-8000-000000000001';
const API_KEY = process.env.API_KEY || 'test-api-key';
const createdRequestIds = [];

async function seedRequest({ urgency, status, slaDueAt, slaBreached = false, label, requesterId }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO housekeeping_requests
       (request_number, requester_id, request_type, urgency, description,
        status, sla_due_at, sla_breached, created_at)
     VALUES ($1, $2::int, 'discharge_cleaning', $3, $4, $5, $6::timestamptz, $7::boolean,
             NOW() - ($8 || ' minutes')::interval)
     RETURNING id`,
    `HKR-TEST-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    requesterId,
    urgency, label, status, slaDueAt, slaBreached,
    String(label === 'OLDEST-BREACHED' ? 240 : label === 'NEWER-OPEN' ? 30 : 5),
  );
  createdRequestIds.push(rows[0].id);
  return rows[0].id;
}

describe('housekeeping queue — live SLA breach + oldest-first ordering (7a73a9b5)', () => {
  let adminClient;
  let oldestBreachedId, newerOpenId, latestUrgentId;

  let adminIntId;

  beforeAll(async () => {
    const adminRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000111002', 'HK Admin', 'SUPER_ADMIN', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET is_active = true
       RETURNING id`, ADMIN_UID);
    adminIntId = adminRows[0].id;
    const token = generateTestToken('SUPER_ADMIN', { uid: ADMIN_UID, id: adminIntId });
    adminClient = {
      get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    };

    oldestBreachedId = await seedRequest({
      urgency: 'high', status: 'pending', requesterId: adminIntId,
      slaDueAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      slaBreached: false, label: 'OLDEST-BREACHED',
    });
    newerOpenId = await seedRequest({
      urgency: 'high', status: 'pending', requesterId: adminIntId,
      slaDueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      slaBreached: false, label: 'NEWER-OPEN',
    });
    latestUrgentId = await seedRequest({
      urgency: 'urgent', status: 'pending', requesterId: adminIntId,
      slaDueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      slaBreached: false, label: 'LATEST-URGENT',
    });
  });

  afterAll(async () => {
    for (const id of createdRequestIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM housekeeping_requests WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  it('SLA breach is computed live at read time, overriding the stored false flag (the repro)', async () => {
    const res = await adminClient.get('/api/v1/housekeeping/requests?status=pending');
    expect(res.statusCode).toBe(200);
    const rows = res.body?.data?.requests ?? [];
    const oldest = rows.find(r => r.id === oldestBreachedId);
    expect(oldest).toBeTruthy();
    expect(oldest.sla_breached).toBe(true);          // live-computed
    expect(oldest.sla_breached_stored).toBe(false);  // stored async-job flag (unchanged)

    const newer = rows.find(r => r.id === newerOpenId);
    expect(newer.sla_breached).toBe(false);
  });

  it('queue puts live-breached tickets FIRST, then urgency, then oldest-due', async () => {
    const res = await adminClient.get('/api/v1/housekeeping/requests?status=pending');
    const rows = res.body?.data?.requests ?? [];
    const ourRows = rows.filter(r => [oldestBreachedId, newerOpenId, latestUrgentId].includes(r.id));
    // Oldest-breached (sla_breached=true live) MUST come before the
    // newer urgent + newer-open tickets even though they're newer.
    const idx = (id) => ourRows.findIndex(r => r.id === id);
    expect(idx(oldestBreachedId)).toBe(0);
    // The other two are not-breached; sort by urgency (urgent > high), then SLA due.
    expect(idx(latestUrgentId)).toBeGreaterThan(idx(oldestBreachedId));
    expect(idx(newerOpenId)).toBeGreaterThan(idx(oldestBreachedId));
  });
});
