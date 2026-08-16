// Ambulance live GPS tracking (migration 683) — full lifecycle against a real
// DB: the tenant config gate (disabled ingest 403 / explicit disabled read
// marker), driver-app ingest validation (coordinate + clock-skew bounds,
// lifecycle state, per-reporter rate floor), out-of-order fixes never
// regressing the derived latest, trail + ETA passthrough reads, mount RBAC,
// cross-tenant scoping, and the retention sweep.
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import {
  sweepAmbulancePositionEvents,
  __testing__ as trackingTesting,
} from '../services/ed/ambulanceTrackingService.js';
import { getTenantSettings, getAmbulanceGpsTrackingSettings } from '../services/tenant/tenantSettingsService.js';
import { updateTenant, DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

const DRIVER_UID = '11111111-2222-4333-8444-000000683001';
const DRIVER2_UID = '11111111-2222-4333-8444-000000683002';
const ED_NURSE_UID = '11111111-2222-4333-8444-000000683003';
const LAB_UID = '11111111-2222-4333-8444-000000683004';

const FOREIGN_TENANT = 'd6830000-0000-4000-8000-0000006830aa';

const HOOK_TIMEOUT_MS = 180000;

function authed(role, uid, id) {
  const token = generateTestToken(role, { uid, id });
  return {
    get: path =>
      request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: path =>
      request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function createRequestRow({ status = 'en_route', tenantId = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ambulance_requests
       (request_number, request_kind, priority, status, ambulance_unit_id,
        dispatched_at${tenantId ? ', tenant_id' : ''})
     VALUES ($1, 'pickup', 'high', $2, 'AMB-683', NOW()${tenantId ? ', $3::uuid' : ''})
     RETURNING id, tenant_id, status`,
    `AMB-683-${STAMP}-${Math.floor(Math.random() * 1_000_000)}`,
    status,
    ...(tenantId ? [tenantId] : []),
  );
  return rows[0];
}

async function setGpsSettings(value) {
  const current = await getTenantSettings(DEFAULT_TENANT_ID);
  const next = { ...current };
  if (value === undefined) delete next.ambulanceGpsTracking;
  else next.ambulanceGpsTracking = value;
  // updateTenant serializes + replaces generic settings and invalidates the
  // 60s tenant cache, so reads below observe the change immediately.
  await updateTenant(DEFAULT_TENANT_ID, { settings: next });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('ambulance live GPS tracking', () => {
  let originalSettings;
  let driverId;
  let driver2Id;
  let nurseId;
  let labId;

  beforeAll(async () => {
    originalSettings = await getTenantSettings(DEFAULT_TENANT_ID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'amb-track-foreign-683', 'Ambulance Foreign Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      FOREIGN_TENANT,
    );

    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2, 'Ambulance Driver [test]', 'DRIVER', true, NOW()),
         ($3::uuid, $4, 'Ambulance Driver Two [test]', 'DRIVER', true, NOW()),
         ($5::uuid, $6, 'ED Nurse 683 [test]', 'NURSING_STAFF', true, NOW()),
         ($7::uuid, $8, 'Lab Tech 683 [test]', 'LAB_TECHNICIAN', true, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET is_active = EXCLUDED.is_active, role = EXCLUDED.role, updated_at = NOW()
       RETURNING id, uid`,
      DRIVER_UID, `96${STAMP.slice(-8)}1`,
      DRIVER2_UID, `96${STAMP.slice(-8)}2`,
      ED_NURSE_UID, `96${STAMP.slice(-8)}3`,
      LAB_UID, `96${STAMP.slice(-8)}4`,
    );
    const byUid = new Map(users.map(u => [u.uid, u.id]));
    driverId = byUid.get(DRIVER_UID);
    driver2Id = byUid.get(DRIVER2_UID);
    nurseId = byUid.get(ED_NURSE_UID);
    labId = byUid.get(LAB_UID);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await updateTenant(DEFAULT_TENANT_ID, { settings: originalSettings });
    await prisma.$executeRawUnsafe(
      `DELETE FROM ambulance_position_events
        WHERE reported_by_uid IN ($1::uuid, $2::uuid)`,
      DRIVER_UID, DRIVER2_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM prehospital_handovers WHERE handover_number LIKE $1`,
      `PH-683-${STAMP}%`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ambulance_requests WHERE request_number LIKE $1`,
      `AMB-683-${STAMP}%`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      DRIVER_UID, DRIVER2_UID, ED_NURSE_UID, LAB_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`, FOREIGN_TENANT,
    );
  }, HOOK_TIMEOUT_MS);

  describe('settings accessor', () => {
    it('defaults to disabled with sane retention/interval', async () => {
      await setGpsSettings(undefined);
      const settings = await getAmbulanceGpsTrackingSettings(DEFAULT_TENANT_ID);
      expect(settings).toEqual({ enabled: false, retentionDays: 7, minSecondsBetweenFixes: 3 });
    });

    it('clamps malformed overrides back to defaults', async () => {
      await setGpsSettings({ enabled: true, retentionDays: 9999, minSecondsBetweenFixes: -4 });
      const settings = await getAmbulanceGpsTrackingSettings(DEFAULT_TENANT_ID);
      expect(settings).toEqual({ enabled: true, retentionDays: 7, minSecondsBetweenFixes: 3 });
    });
  });

  describe('config gate (feature disabled)', () => {
    beforeAll(async () => { await setGpsSettings(undefined); });

    it('rejects ingest with AMBULANCE_GPS_TRACKING_DISABLED', async () => {
      const row = await createRequestRow();
      const res = await authed('DRIVER', DRIVER_UID, driverId)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.9716, longitude: 77.5946 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AMBULANCE_GPS_TRACKING_DISABLED');
    });

    it('returns an explicit disabled marker on reads', async () => {
      const row = await createRequestRow();
      const res = await authed('NURSING_STAFF', ED_NURSE_UID, nurseId)
        .get(`/api/v1/ambulance/requests/${row.id}/tracking`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: false, tracking: null });

      const list = await authed('NURSING_STAFF', ED_NURSE_UID, nurseId)
        .get('/api/v1/ambulance/tracking/active');
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual({ enabled: false, requests: [], count: 0 });
    });
  });

  describe('ingest (feature enabled)', () => {
    beforeAll(async () => {
      await setGpsSettings({ enabled: true, minSecondsBetweenFixes: 1 });
    });

    it('records a fix from the assigned driver and derives it latest', async () => {
      const row = await createRequestRow();
      const res = await authed('DRIVER', DRIVER_UID, driverId)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({
          latitude: 12.9716,
          longitude: 77.5946,
          speed_kmh: 62.5,
          heading_deg: 270,
          accuracy_m: 8,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.is_latest).toBe(true);
      expect(res.body.data.position).toMatchObject({
        ambulance_request_id: row.id,
        ambulance_unit_id: 'AMB-683',
        source: 'driver_app',
        reported_by_uid: DRIVER_UID,
      });
      expect(Number(res.body.data.position.latitude)).toBeCloseTo(12.9716, 4);
    });

    it('rejects out-of-range coordinates and speed', async () => {
      const row = await createRequestRow();
      const driver = authed('DRIVER', DRIVER_UID, driverId);
      const badLat = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 91, longitude: 77.5 });
      expect(badLat.status).toBe(400);
      const badSpeed = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.9, longitude: 77.5, speed_kmh: 900 });
      expect(badSpeed.status).toBe(400);
      const noCoords = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({});
      expect(noCoords.status).toBe(400);
    });

    it('rejects future-skewed and prehistoric recorded_at', async () => {
      const row = await createRequestRow();
      const driver = authed('DRIVER', DRIVER_UID, driverId);
      const future = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({
          latitude: 12.9, longitude: 77.5,
          recorded_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
      expect(future.status).toBe(400);
      expect(future.body.code).toBe('AMBULANCE_POSITION_CLOCK_SKEW');
      const ancient = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({
          latitude: 12.9, longitude: 77.5,
          recorded_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        });
      expect(ancient.status).toBe(400);
      expect(ancient.body.code).toBe('AMBULANCE_POSITION_STALE_FIX');
    });

    it('rejects fixes for requests that are not actively transporting', async () => {
      const requested = await createRequestRow({ status: 'requested' });
      const res = await authed('DRIVER', DRIVER_UID, driverId)
        .post(`/api/v1/ambulance/requests/${requested.id}/positions`)
        .send({ latitude: 12.9, longitude: 77.5 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AMBULANCE_TRACKING_REQUEST_NOT_ACTIVE');
    });

    it('enforces the per-reporter minimum fix interval on server time', async () => {
      const row = await createRequestRow();
      const driver = authed('DRIVER', DRIVER_UID, driverId);
      const first = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.9, longitude: 77.5 });
      expect(first.status).toBe(201);
      const second = await driver
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.91, longitude: 77.51 });
      expect(second.status).toBe(429);
      expect(second.body.code).toBe('AMBULANCE_POSITION_RATE_LIMITED');
      // A different reporter is not throttled by the first reporter's fix.
      const other = await authed('DRIVER', DRIVER2_UID, driver2Id)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.92, longitude: 77.52 });
      expect(other.status).toBe(201);
    });

    it('stores out-of-order fixes without regressing the derived latest', async () => {
      const row = await createRequestRow();
      const now = Date.now();
      const newest = await authed('DRIVER', DRIVER_UID, driverId)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({
          latitude: 13.0, longitude: 77.6,
          recorded_at: new Date(now).toISOString(),
        });
      expect(newest.status).toBe(201);
      expect(newest.body.data.is_latest).toBe(true);

      await sleep(1100);
      const older = await authed('DRIVER', DRIVER_UID, driverId)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({
          latitude: 12.5, longitude: 77.1,
          recorded_at: new Date(now - 60 * 1000).toISOString(),
        });
      expect(older.status).toBe(201);
      expect(older.body.data.is_latest).toBe(false);

      const view = await authed('NURSING_STAFF', ED_NURSE_UID, nurseId)
        .get(`/api/v1/ambulance/requests/${row.id}/tracking`);
      expect(view.status).toBe(200);
      expect(view.body.data.enabled).toBe(true);
      expect(Number(view.body.data.tracking.latest.latitude)).toBeCloseTo(13.0, 4);
      expect(view.body.data.tracking.trail).toHaveLength(2);
    });
  });

  describe('live read API (feature enabled)', () => {
    beforeAll(async () => {
      await setGpsSettings({ enabled: true, minSecondsBetweenFixes: 1 });
    });

    it('serves latest + bounded trail + prehospital ETA passthrough', async () => {
      const row = await createRequestRow();
      const etaLatest = new Date(Date.now() + 12 * 60 * 1000).toISOString();
      await prisma.$executeRawUnsafe(
        `INSERT INTO prehospital_handovers
           (handover_number, ambulance_request_id, patient_uid, status,
            manual_entry, source_type, eta_first_at, eta_latest_at,
            eta_change_reason)
         VALUES ($1, $2, $3::uuid, 'ready_for_acceptance',
                 true, 'manual', NOW(), $4::timestamptz, 'traffic')`,
        `PH-683-${STAMP}-${row.id}`,
        row.id,
        DRIVER_UID,
        etaLatest,
      );
      const post = await authed('DRIVER', DRIVER_UID, driverId)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.97, longitude: 77.59 });
      expect(post.status).toBe(201);

      const view = await authed('NURSING_STAFF', ED_NURSE_UID, nurseId)
        .get(`/api/v1/ambulance/requests/${row.id}/tracking?trail_limit=1`);
      expect(view.status).toBe(200);
      const tracking = view.body.data.tracking;
      expect(tracking.is_trackable).toBe(true);
      expect(tracking.trail).toHaveLength(1);
      expect(new Date(tracking.eta.eta_latest_at).getTime())
        .toBe(new Date(etaLatest).getTime());
      expect(tracking.eta.eta_change_reason).toBe('traffic');

      const active = await authed('NURSING_STAFF', ED_NURSE_UID, nurseId)
        .get('/api/v1/ambulance/tracking/active');
      expect(active.status).toBe(200);
      expect(active.body.data.enabled).toBe(true);
      const entry = active.body.data.requests
        .find(r => r.ambulance_request_id === row.id);
      expect(entry).toBeDefined();
      expect(Number(entry.latitude)).toBeCloseTo(12.97, 4);
      expect(entry.eta_latest_at).toBeTruthy();
    });

    it('404s a foreign tenant ambulance request', async () => {
      const foreign = await createRequestRow({ tenantId: FOREIGN_TENANT });
      const res = await authed('NURSING_STAFF', ED_NURSE_UID, nurseId)
        .get(`/api/v1/ambulance/requests/${foreign.id}/tracking`);
      expect(res.status).toBe(404);
    });
  });

  describe('RBAC', () => {
    it('rejects roles outside the ambulance tracking roster at the mount', async () => {
      const row = await createRequestRow();
      const read = await authed('LAB_TECHNICIAN', LAB_UID, labId)
        .get(`/api/v1/ambulance/requests/${row.id}/tracking`);
      expect(read.status).toBe(403);
      const write = await authed('LAB_TECHNICIAN', LAB_UID, labId)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .send({ latitude: 12.9, longitude: 77.5 });
      expect(write.status).toBe(403);
    });

    it('rejects unauthenticated ingest', async () => {
      const row = await createRequestRow();
      const res = await request(app)
        .post(`/api/v1/ambulance/requests/${row.id}/positions`)
        .set('x-api-key', API_KEY)
        .send({ latitude: 12.9, longitude: 77.5 });
      expect(res.status).toBe(401);
    });
  });

  describe('retention sweep', () => {
    it('deletes fixes past the tenant retention window and keeps recent ones', async () => {
      await setGpsSettings({ enabled: true, retentionDays: 7, minSecondsBetweenFixes: 1 });
      const row = await createRequestRow();
      await prisma.$executeRawUnsafe(
        `INSERT INTO ambulance_position_events
           (tenant_id, ambulance_request_id, latitude, longitude,
            recorded_at, received_at, reported_by_uid)
         VALUES
           ($1::uuid, $2, 12.9, 77.5, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days', $3::uuid),
           ($1::uuid, $2, 12.91, 77.51, NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days', $3::uuid),
           ($1::uuid, $2, 12.92, 77.52, NOW(), NOW(), $3::uuid)`,
        DEFAULT_TENANT_ID,
        row.id,
        DRIVER_UID,
      );
      const result = await sweepAmbulancePositionEvents({ tenantId: DEFAULT_TENANT_ID });
      expect(result.retention_days).toBe(7);
      expect(result.deleted).toBeGreaterThanOrEqual(2);
      const remaining = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM ambulance_position_events
          WHERE tenant_id = $1::uuid AND ambulance_request_id = $2`,
        DEFAULT_TENANT_ID,
        row.id,
      );
      expect(remaining[0].count).toBe(1);
    });
  });

  describe('service internals', () => {
    it('pins the trackable lifecycle statuses', () => {
      expect(trackingTesting.TRACKABLE_STATUSES)
        .toEqual(['dispatched', 'en_route', 'on_scene', 'returning']);
    });
  });
});
