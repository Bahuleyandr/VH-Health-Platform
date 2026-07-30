// Roadmap B2.5 (WS2 / REL-5) — DB-free static downtime mirror.
//
// PROVES DB-INDEPENDENCE: unlike downtime-pack.deep.test.js, this test does NO
// Prisma seeding at all. It points DOWNTIME_MIRROR_DIR at a throwaway temp dir,
// drops a fixture ward-<id>.html on disk, and asserts the static route serves
// it straight off the filesystem. It also asserts:
//   * a missing ward → HTTP 200 + the paper-fallback HTML (never 404/500),
//   * a path-traversal attempt is safe (no escape, no file leak),
//   * the surface keeps working even when the Prisma singleton is mocked to
//     throw on every call (i.e. the DB is "down").
//
// The route is mounted BEFORE validateApiKey/jwtAuth, but the monitoring-token
// gate now fails CLOSED in every env and requires its own dedicated token. The
// DB-down proof is unaffected: the gate is auth-only and touches no DB.

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// Make the DB layer hostile: every prisma raw/model CALL rejects, so if the
// static route touched prisma at all these tests would fail — that's the point.
// We spread the REAL module first so app.js's import graph still finds every
// symbol it needs (tenantRlsRolePosture, logTenantRlsRolePosture, setTenant*,
// …), then override only the call surface with throwing versions. The real
// module imports cleanly because DATABASE_URL is set in the jest env.
const DB_DOWN = () => Promise.reject(new Error('DB is down (test)'));
const explodingPrisma = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined; // not a thenable
    // Any model delegate (e.g. downtime_snapshots) → object whose methods throw.
    if (typeof prop === 'string' && !prop.startsWith('$') && /^[a-z]/.test(prop)) {
      return new Proxy({}, { get: () => DB_DOWN });
    }
    return DB_DOWN; // $queryRaw / $executeRaw / $transaction / etc.
  },
});

const actualPrisma = await import('../lib/prisma.js');
jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrisma,
  default: explodingPrisma,
  prismaReadOnly: explodingPrisma,
  setTenant: DB_DOWN,
  setTenantTx: DB_DOWN,
}));

const WARD_ID = 4242;
const FIXTURE_HTML = '<!DOCTYPE html><html><body><h1>DOWNTIME PACK — STATIC FIXTURE WARD</h1></body></html>';
const DOWNTIME_TOKEN = 'test-downtime-token';

let app;
let mirrorDir;

beforeAll(async () => {
  mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhhealth-downtime-mirror-test-'));
  process.env.DOWNTIME_MIRROR_DIR = mirrorDir;
  // Downtime gate fails closed off-prod too — supply a dedicated token for the
  // mounted /downtime/static gate (set BEFORE app.js is imported below).
  process.env.DOWNTIME_ACCESS_TOKEN = DOWNTIME_TOKEN;
  // Drop a fixture ward pack + an index — NO Prisma involved.
  fs.writeFileSync(path.join(mirrorDir, `ward-${WARD_ID}.html`), FIXTURE_HTML, 'utf8');
  fs.writeFileSync(
    path.join(mirrorDir, 'index.html'),
    `<!DOCTYPE html><html><body><h1>DOWNTIME WARD PACKS</h1><a href="wards/${WARD_ID}">Ward ${WARD_ID}</a></body></html>`,
    'utf8',
  );
  ({ default: app } = await import('../app.js'));
});

afterAll(() => {
  try { fs.rmSync(mirrorDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.DOWNTIME_MIRROR_DIR;
  delete process.env.DOWNTIME_ACCESS_TOKEN;
});

describe('DB-free static downtime mirror (roadmap B2.5)', () => {
  it('serves a mirrored ward pack straight off disk (no Prisma)', async () => {
    const res = await request(app).get(`/downtime/static/wards/${WARD_ID}`).set('x-downtime-token', DOWNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.link).toContain('rel="deprecation"');
    expect(res.headers.warning).toContain('Deprecated legacy ward-pack route');
    expect(res.text).toContain('STATIC FIXTURE WARD');
  });

  it('fails closed (401) without a dedicated downtime token', async () => {
    const res = await request(app).get(`/downtime/static/wards/${WARD_ID}`);
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'DOWNTIME_AUTH_REQUIRED');
  });

  it('serves the mirror index off disk', async () => {
    const res = await request(app).get('/downtime/static').set('x-downtime-token', DOWNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('DOWNTIME WARD PACKS');
  });

  it('returns 200 + paper-fallback HTML for a ward with no mirrored pack', async () => {
    const res = await request(app).get('/downtime/static/wards/999999').set('x-downtime-token', DOWNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('paper downtime forms');
    expect(res.text).not.toContain('STATIC FIXTURE WARD');
  });

  it('accepts a UUID ward id shape (fallback when absent, never 404/500)', async () => {
    const res = await request(app).get('/downtime/static/wards/11111111-2222-3333-4444-555555555555').set('x-downtime-token', DOWNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toContain('paper downtime forms');
  });

  it('is safe against a path-traversal attempt — no escape, no file leak', async () => {
    // Plant a secret OUTSIDE the mirror dir, then try to escape to it.
    const secretPath = path.join(mirrorDir, '..', 'downtime-static-secret.txt');
    fs.writeFileSync(secretPath, 'TOP-SECRET-SHOULD-NOT-LEAK', 'utf8');
    try {
      // Express decodes %2e%2e; both encoded and literal forms must be safe.
      const attempts = [
        '/downtime/static/wards/..%2f..%2fdowntime-static-secret',
        '/downtime/static/wards/..%2F..%2Fdowntime-static-secret.txt',
        '/downtime/static/wards/%2e%2e%2f%2e%2e%2fpackage',
      ];
      for (const url of attempts) {
        const res = await request(app).get(url).set('x-downtime-token', DOWNTIME_TOKEN);
        // Either a 200 fallback (handler reached, id rejected) or a 404 from the
        // router not matching — NEVER the secret content, NEVER a 500.
        expect([200, 404]).toContain(res.status);
        expect(res.text || '').not.toContain('TOP-SECRET-SHOULD-NOT-LEAK');
      }
    } finally {
      try { fs.rmSync(secretPath, { force: true }); } catch { /* ignore */ }
    }
  });

  it('works even though the Prisma singleton is mocked to throw (DB down)', async () => {
    // Sanity: the mock IS active — a raw call rejects.
    const prismaMod = await import('../lib/prisma.js');
    await expect(prismaMod.default.$queryRaw`SELECT 1`).rejects.toThrow('DB is down (test)');
    // Yet the static surface still serves the pack.
    const res = await request(app).get(`/downtime/static/wards/${WARD_ID}`).set('x-downtime-token', DOWNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toContain('STATIC FIXTURE WARD');
  });
});
