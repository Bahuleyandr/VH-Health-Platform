// CAN-054 — dedicated downtime-access token separates ward-pack PHI from metrics.
//
// The DB-free static downtime mirror (/downtime/static) serves PHI ward packs.
// It used to share the SAME monitoring token as /metrics and /health/deep, so a
// single leaked metrics/scrape token also unlocked ward packs. This test proves
// the dedicated-token posture:
//   * with DOWNTIME_ACCESS_TOKEN configured, ONLY that token is accepted — the
//     monitoring token alone is rejected (the separation we want);
//   * the dedicated token works over both its own header and the shared
//     monitoring/Bearer transport (so existing outage tooling can carry it);
//   * with NO dedicated token configured, it falls back to the monitoring token
//     so outage packs stay reachable until the operator provisions one.
//
// The env is read at REQUEST time, so the same app instance exercises both the
// dedicated-token and fallback postures by toggling process.env between requests.
// No Prisma seeding — the route is filesystem-only.

import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

const WARD_ID = 5454;
const FIXTURE_HTML = '<!DOCTYPE html><html><body><h1>DOWNTIME PACK — CAN-054 FIXTURE WARD</h1></body></html>';
const MONITORING_TOKEN = 'can054-monitoring-token';
const DOWNTIME_TOKEN = 'can054-dedicated-downtime-token';

let app;
let mirrorDir;

beforeAll(async () => {
  mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhhealth-downtime-dedicated-test-'));
  process.env.DOWNTIME_MIRROR_DIR = mirrorDir;
  process.env.MONITORING_TOKEN = MONITORING_TOKEN;
  fs.writeFileSync(path.join(mirrorDir, `ward-${WARD_ID}.html`), FIXTURE_HTML, 'utf8');
  ({ default: app } = await import('../app.js'));
});

afterAll(() => {
  try { fs.rmSync(mirrorDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.DOWNTIME_MIRROR_DIR;
  delete process.env.MONITORING_TOKEN;
  delete process.env.DOWNTIME_ACCESS_TOKEN;
});

const get = (url) => request(app).get(url);

describe('CAN-054 dedicated downtime token', () => {
  describe('with a dedicated downtime token configured', () => {
    beforeEach(() => { process.env.DOWNTIME_ACCESS_TOKEN = DOWNTIME_TOKEN; });
    afterEach(() => { delete process.env.DOWNTIME_ACCESS_TOKEN; });

    it('accepts the dedicated token via its own header', async () => {
      const res = await get(`/downtime/static/wards/${WARD_ID}`).set('x-downtime-token', DOWNTIME_TOKEN);
      expect(res.status).toBe(200);
      expect(res.text).toContain('CAN-054 FIXTURE WARD');
    });

    it('accepts the dedicated token over the shared monitoring/Bearer transport', async () => {
      const viaMonitoringHeader = await get(`/downtime/static/wards/${WARD_ID}`).set('x-monitoring-token', DOWNTIME_TOKEN);
      expect(viaMonitoringHeader.status).toBe(200);
      const viaBearer = await get(`/downtime/static/wards/${WARD_ID}`).set('Authorization', `Bearer ${DOWNTIME_TOKEN}`);
      expect(viaBearer.status).toBe(200);
    });

    it('REJECTS the monitoring token alone (metrics leak ≠ ward-pack access)', async () => {
      const res = await get(`/downtime/static/wards/${WARD_ID}`).set('x-monitoring-token', MONITORING_TOKEN);
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('code', 'DOWNTIME_AUTH_REQUIRED');
      expect(res.text).not.toContain('CAN-054 FIXTURE WARD');
    });

    it('rejects a request with no token', async () => {
      const res = await get(`/downtime/static/wards/${WARD_ID}`);
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('code', 'DOWNTIME_AUTH_REQUIRED');
    });
  });

  describe('with NO dedicated downtime token configured (backward-compat fallback)', () => {
    it('falls back to the monitoring token so outage packs stay reachable', async () => {
      const res = await get(`/downtime/static/wards/${WARD_ID}`).set('x-monitoring-token', MONITORING_TOKEN);
      expect(res.status).toBe(200);
      expect(res.text).toContain('CAN-054 FIXTURE WARD');
    });

    it('still fails closed without any token in fallback mode', async () => {
      const res = await get(`/downtime/static/wards/${WARD_ID}`);
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('code', 'MONITORING_AUTH_REQUIRED');
    });
  });
});
