// src/tests/notification-my.test.js
// Integration tests for the /my notification endpoints.
//
// This suite owns two tenants, three users, and its notification rows. The
// fixtures prove that /my derives all recipient keys from the authenticated
// database user while the explicit tenant predicate keeps same-phone rows in a
// different tenant out of both the read and mark-all-read paths.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { waitForAuditLogDrain } from '../middleware/auditLog.js';
import { generateToken } from '../utils/jwtUtils.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const OWNER_TENANT_ID = 'a07f0000-0000-4000-8000-00000000a001';
const OTHER_TENANT_ID = 'a07f0000-0000-4000-8000-00000000b001';
const OWNER_UID = 'a07f0000-0000-4000-8000-00000000a101';
const STRANGER_UID = 'a07f0000-0000-4000-8000-00000000a102';
const OTHER_TENANT_UID = 'a07f0000-0000-4000-8000-00000000b101';
const OWNER_PHONE = '+919811110001';
const STRANGER_PHONE = '+919811110002';
const OWNER_UID_ONLY_PHONE = '+919811110003';
const OWNER_ID_ONLY_PHONE = '+919811110004';
const FIXTURE_KEY = 'notification-my-owner-path';

let ownerId;
let strangerId;
let otherTenantUserId;
const notificationIds = {};

// ── Test tokens ─────────────────────────────────────────────────────────────
const patientToken = generateToken({
  uid: 'test-notif-patient',
  id: 5,
  phone: '1234567890',
  role: 'PATIENT'
});

const staffToken = generateToken({
  uid: 'test-notif-staff',
  id: 101,
  phone: '5551112222',
  role: 'ADMIN'
});

const tokenWithoutPhone = generateToken({
  uid: 'test-notif-nophone',
  id: 50,
  role: 'PATIENT'
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Authenticated supertest request with API key + Bearer token */
const authRequest = (method, path, token) => {
  return request(app)[method](path)
    .set('X-API-Key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
};

function fixtureToken(uid, id, phone, tenantId) {
  return generateToken({
    uid,
    id,
    phone,
    role: 'PATIENT',
    tenant_id: tenantId,
  });
}

function ownerToken() {
  return fixtureToken(OWNER_UID, ownerId, OWNER_PHONE, OWNER_TENANT_ID);
}

function strangerToken() {
  return fixtureToken(STRANGER_UID, strangerId, STRANGER_PHONE, OWNER_TENANT_ID);
}

function otherTenantToken() {
  return fixtureToken(
    OTHER_TENANT_UID,
    otherTenantUserId,
    OWNER_PHONE,
    OTHER_TENANT_ID,
  );
}

async function cleanupOwnerPathFixtures() {
  await waitForAuditLogDrain();
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM audit_log
      WHERE tenant_id IN ($1::uuid, $2::uuid)
         OR uid IN ($3::uuid, $4::uuid, $5::uuid)`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
    OWNER_UID,
    STRANGER_UID,
    OTHER_TENANT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM audit_logs
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    OWNER_UID,
    STRANGER_UID,
    OTHER_TENANT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_events
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM notifications
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE tenant_id IN ($1::uuid, $2::uuid)
         OR uid IN ($3::uuid, $4::uuid, $5::uuid)`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
    OWNER_UID,
    STRANGER_UID,
    OTHER_TENANT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
  );
}

async function seedOwnerPathFixtures() {
  await cleanupOwnerPathFixtures();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1::uuid, 'notification-my-owner-path', 'Notification My Owner Path'),
       ($2::uuid, 'notification-my-other-tenant', 'Notification My Other Tenant')`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
  );

  const users = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
       ($1::uuid, $2, 'Notification Owner', 'PATIENT', true, $7::uuid, NOW()),
       ($3::uuid, $4, 'Notification Stranger', 'PATIENT', true, $7::uuid, NOW()),
       ($5::uuid, $6, 'Other Tenant Same Phone', 'PATIENT', true, $8::uuid, NOW())
     RETURNING id, uid`,
    OWNER_UID,
    OWNER_PHONE,
    STRANGER_UID,
    STRANGER_PHONE,
    OTHER_TENANT_UID,
    OWNER_PHONE,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
  );
  const userIds = new Map(users.map((row) => [String(row.uid), Number(row.id)]));
  ownerId = userIds.get(OWNER_UID);
  strangerId = userIds.get(STRANGER_UID);
  otherTenantUserId = userIds.get(OTHER_TENANT_UID);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO notifications
       (uid, user_id, phone, title, body, type, priority, data, is_read,
        read_at, tenant_id, created_at, updated_at)
     VALUES
       ($1::uuid, NULL, $2, 'Owner UID notification', 'Owned through uid',
        'GENERAL', 'NORMAL', $9::jsonb, false, NULL, $7::uuid, NOW() - INTERVAL '4 minutes', NOW()),
       (NULL, $3::int, $4, 'Owner user-id notification', 'Owned through user_id',
        'GENERAL', 'NORMAL', $9::jsonb, false, NULL, $7::uuid, NOW() - INTERVAL '3 minutes', NOW()),
       (NULL, NULL, $5, 'Owner legacy-phone notification', 'Owned through normalized phone',
        'GENERAL', 'NORMAL', $9::jsonb, false, NULL, $7::uuid, NOW() - INTERVAL '2 minutes', NOW()),
       ($1::uuid, NULL, $2, 'Owner already-read notification', 'Already read',
        'GENERAL', 'NORMAL', $9::jsonb, true, NOW() - INTERVAL '1 minute', $7::uuid, NOW() - INTERVAL '1 minute', NOW()),
       ($6::uuid, $10::int, $11, 'Same-tenant stranger notification', 'Not owned by caller',
        'GENERAL', 'NORMAL', $9::jsonb, false, NULL, $7::uuid, NOW(), NOW()),
       ($8::uuid, $12::int, $5, 'Other-tenant same-phone notification', 'Tenant isolation sentinel',
        'GENERAL', 'NORMAL', $9::jsonb, false, NULL, $13::uuid, NOW(), NOW())
     RETURNING id, title`,
    OWNER_UID,
    OWNER_UID_ONLY_PHONE,
    ownerId,
    OWNER_ID_ONLY_PHONE,
    OWNER_PHONE,
    STRANGER_UID,
    OWNER_TENANT_ID,
    OTHER_TENANT_UID,
    JSON.stringify({ fixture: FIXTURE_KEY }),
    strangerId,
    STRANGER_PHONE,
    otherTenantUserId,
    OTHER_TENANT_ID,
  );
  for (const row of rows) {
    notificationIds[row.title] = Number(row.id);
  }
}

async function resetFixtureReadState() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_events
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND notification_id = ANY($3::int[])`,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
    Object.values(notificationIds),
  );
  await prisma.$executeRawUnsafe(
    `UPDATE notifications
        SET is_read = (title = 'Owner already-read notification'),
            read_at = CASE
              WHEN title = 'Owner already-read notification' THEN NOW()
              ELSE NULL
            END
      WHERE id = ANY($1::int[])`,
    Object.values(notificationIds),
  );
}

beforeAll(async () => {
  await seedOwnerPathFixtures();
}, 120000);

afterAll(async () => {
  try {
    await cleanupOwnerPathFixtures();
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}, 120000);

// ═════════════════════════════════════════════════════════════════════════════
// 1. GET /api/v1/notifications/my — AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/notifications/my — Authentication', () => {
  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/my')
      .set('X-API-Key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when no API key is provided', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/my')
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when neither API key nor token is provided', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/my');

    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. GET /api/v1/notifications/my — ROUTE EXISTS
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/notifications/my — Route Existence', () => {
  it('should not return 404 for authenticated ADMIN request', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', staffToken);

    // The /my route derives phone from JWT. Without a DB the query may fail (500),
    // but the route itself must exist (not 404).
    expect(res.statusCode).not.toBe(404);
  });

  it('should not return 404 for authenticated PATIENT request', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', patientToken);

    // RBAC config includes PATIENT for notificationRoutes. The route should exist.
    // Depending on RBAC enforcement: 400 (validation), 403, or 500 (no DB).
    expect(res.statusCode).not.toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET /api/v1/notifications/my — RESPONSE FOR AUTHENTICATED USER
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/notifications/my — Authenticated Access', () => {
  it('should allow ADMIN to reach the /my endpoint (not 403)', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', staffToken);

    // Admin passes RBAC. Without a DB, expect 500. Should not be 403.
    expect(res.statusCode).not.toBe(403);
  });

  it('should return 400 when JWT has no phone claim (cannot derive phone)', async () => {
    const res = await authRequest('get', '/api/v1/notifications/my', tokenWithoutPhone);

    // The /my handler checks req.user.phone; if absent, returns 400 with message.
    // RBAC may also reject first (403). Either way, never 200 with wrong data.
    expect([400, 403]).toContain(res.statusCode);
  });

  it('should return only the authenticated owner notifications across every supported recipient key', async () => {
    await resetFixtureReadState();

    const ownerRes = await authRequest('get', '/api/v1/notifications/my', ownerToken());

    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.body.data).toEqual(expect.objectContaining({
      count: 4,
      total: 4,
      unread_count: 3,
      requestedBy: OWNER_UID,
      accessLevel: 'PATIENT',
    }));
    expect(ownerRes.body.data.notifications.map((row) => row.id).sort((a, b) => a - b)).toEqual([
      notificationIds['Owner UID notification'],
      notificationIds['Owner user-id notification'],
      notificationIds['Owner legacy-phone notification'],
      notificationIds['Owner already-read notification'],
    ].sort((a, b) => a - b));

    const strangerRes = await authRequest('get', '/api/v1/notifications/my', strangerToken());
    expect(strangerRes.statusCode).toBe(200);
    expect(strangerRes.body.data.notifications.map((row) => row.id)).toEqual([
      notificationIds['Same-tenant stranger notification'],
    ]);

    const otherTenantRes = await authRequest('get', '/api/v1/notifications/my', otherTenantToken());
    expect(otherTenantRes.statusCode).toBe(200);
    expect(otherTenantRes.body.data.notifications.map((row) => row.id)).toEqual([
      notificationIds['Other-tenant same-phone notification'],
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PATCH /api/v1/notifications/my/mark-all-read — AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/notifications/my/mark-all-read — Authentication', () => {
  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .patch('/api/v1/notifications/my/mark-all-read')
      .set('X-API-Key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when no API key is provided', async () => {
    const res = await request(app)
      .patch('/api/v1/notifications/my/mark-all-read')
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. PATCH /api/v1/notifications/my/mark-all-read — ROUTE EXISTS
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/notifications/my/mark-all-read — Route Existence', () => {
  it('should not return 404 for authenticated ADMIN request', async () => {
    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', staffToken);

    // The route must exist. Without a DB: 500. With DB: 200.
    expect(res.statusCode).not.toBe(404);
  });

  it('should return 400 when JWT has no phone claim', async () => {
    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', tokenWithoutPhone);

    // The /my/mark-all-read handler checks req.user.phone; if absent, returns 400.
    // RBAC may block first (403).
    expect([400, 403]).toContain(res.statusCode);
  });

  it('should mark only the authenticated owner unread notifications and append one read event per transition', async () => {
    await resetFixtureReadState();

    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', ownerToken());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      updated_count: 3,
      user_id: ownerId,
      updatedBy: OWNER_UID,
    }));

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, title, tenant_id, is_read, read_at
         FROM notifications
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      Object.values(notificationIds),
    );
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    for (const title of [
      'Owner UID notification',
      'Owner user-id notification',
      'Owner legacy-phone notification',
      'Owner already-read notification',
    ]) {
      expect(byTitle.get(title)).toEqual(expect.objectContaining({
        tenant_id: OWNER_TENANT_ID,
        is_read: true,
      }));
      expect(byTitle.get(title).read_at).toBeTruthy();
    }
    expect(byTitle.get('Same-tenant stranger notification').is_read).toBe(false);
    expect(byTitle.get('Same-tenant stranger notification').read_at).toBeNull();
    expect(byTitle.get('Other-tenant same-phone notification').is_read).toBe(false);
    expect(byTitle.get('Other-tenant same-phone notification').read_at).toBeNull();

    const events = await prisma.$queryRawUnsafe(
      `SELECT notification_id, tenant_id, event_type, actor_uid, actor_role, metadata
         FROM notification_events
        WHERE notification_id = ANY($1::int[])
        ORDER BY notification_id`,
      Object.values(notificationIds),
    );
    expect(events).toHaveLength(3);
    expect(events.map((event) => Number(event.notification_id)).sort((a, b) => a - b)).toEqual([
      notificationIds['Owner UID notification'],
      notificationIds['Owner user-id notification'],
      notificationIds['Owner legacy-phone notification'],
    ].sort((a, b) => a - b));
    for (const event of events) {
      expect(event).toEqual(expect.objectContaining({
        tenant_id: OWNER_TENANT_ID,
        event_type: 'read',
        actor_uid: OWNER_UID,
        actor_role: 'PATIENT',
        metadata: { source: 'mark_all_mine' },
      }));
    }

    const replay = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', ownerToken());
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.updated_count).toBe(0);
    const eventCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM notification_events
        WHERE notification_id = ANY($1::int[])`,
      Object.values(notificationIds),
    );
    expect(eventCount[0].count).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PATCH /api/v1/notifications/my/mark-all-read — AUTHENTICATED ACCESS
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/v1/notifications/my/mark-all-read — Authenticated Access', () => {
  it('should allow ADMIN to reach the mark-all-read endpoint (not 403)', async () => {
    const res = await authRequest('patch', '/api/v1/notifications/my/mark-all-read', staffToken);

    // Admin passes RBAC. Without DB: 500. Should not be 403.
    expect(res.statusCode).not.toBe(403);
  });
});
