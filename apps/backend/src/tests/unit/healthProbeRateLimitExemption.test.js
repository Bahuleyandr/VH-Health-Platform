// src/tests/unit/healthProbeRateLimitExemption.test.js
//
// P1 finding 2026-08-15 (873-F1): the `/health` mount carried the generic
// limiter, and Express strips the mount prefix for `app.use('/health', ...)`
// middleware — inside the limiter the k8s probes read `req.path === '/ready'`
// and `'/live'`, so the default profile's built-in `startsWith('/health')`
// skip matched NOTHING and the probes were metered in the shared
// `t:default:127.0.0.1` bucket. At prod's 100/15min `default` cap, 3 replicas
// x 12 readiness hits/min saturated the window in ~3 minutes and every pod
// went NotReady for ~12 of each 15 minutes (the readiness exec probe treats a
// 429 as failure) — a cyclic full-API outage with no attacker required.
//
// This suite pins the remediation from three sides:
//   1. behaviour — healthMountRateLimiter dispatches exactly the
//      mount-relative probe paths to the probe limiter, everything else to
//      the general limiter, under a REAL express mount (proving the
//      prefix-strip semantics rather than assuming them);
//   2. the trap — the probe paths are mount-relative, i.e. the old skip
//      list's '/health' prefix test can never have matched them;
//   3. infra coherence — the paths the live k8s manifests actually probe are
//      all covered by the exemption set, so a probe-path change in the
//      deployment fails this test instead of silently re-metering probes.
import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import express from 'express';
import request from 'supertest';

// Keep the module graph light (same pattern as rateLimitStoreLossPosture):
// the middleware imports the Redis lib and the DB-backed tenant override.
jest.unstable_mockModule('rate-limit-redis', () => ({ RedisStore: class {} }));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  initRedis: jest.fn(async () => null),
  getRedisClient: () => null,
  isRedisConnected: () => false,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => false,
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => false),
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getRateLimitOverride: jest.fn(async () => null),
}));

const { HEALTH_MOUNT_PROBE_PATHS, healthMountRateLimiter } = await import(
  '../../middleware/rateLimitMiddleware.js'
);

const appSource = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const deployment = parseYaml(
  readFileSync(
    new URL('../../../../../infra/kubernetes/apps/backend/deployment.yaml', import.meta.url),
    'utf8'
  )
);

describe('healthMountRateLimiter dispatch (behaviour under a real mount)', () => {
  let probeCalls;
  let generalCalls;
  let app;

  beforeEach(() => {
    probeCalls = [];
    generalCalls = [];
    const probeSpy = (req, _res, next) => {
      probeCalls.push(req.path);
      next();
    };
    const generalSpy = (req, _res, next) => {
      generalCalls.push(req.path);
      next();
    };
    const router = express.Router();
    router.get('*splat', (_req, res) => res.status(200).json({ ok: true }));
    app = express();
    app.use('/health', healthMountRateLimiter(probeSpy, generalSpy), router);
  });

  it.each(['/health/ready', '/health/live'])(
    '%s goes through the probe limiter (and the limiter sees the STRIPPED path)',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      // The limiter observes the mount-relative path — the prefix-strip trap
      // this fix exists for. If express ever stopped stripping, the selector
      // would need re-verification, so pin what was actually seen.
      expect(probeCalls).toEqual([path.replace('/health', '')]);
      expect(generalCalls).toEqual([]);
    }
  );

  it.each(['/health/metrics', '/health/deep', '/health/version', '/health/ping'])(
    '%s keeps the general limiter — probes are exempted narrowly, not the mount',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(generalCalls).toHaveLength(1);
      expect(probeCalls).toEqual([]);
    }
  );
});

describe('the prefix-strip trap, pinned', () => {
  it('probe paths are MOUNT-RELATIVE — the old startsWith("/health") skip can never match them', () => {
    expect(HEALTH_MOUNT_PROBE_PATHS.length).toBeGreaterThan(0);
    for (const p of HEALTH_MOUNT_PROBE_PATHS) {
      expect(p.startsWith('/')).toBe(true);
      // This is the bug: under the /health mount the limiter never sees a
      // '/health...' path, so a '/health' prefix skip is unreachable there.
      expect(p.startsWith('/health')).toBe(false);
    }
  });
});

describe('mount wiring in app.js', () => {
  it('mounts /health through healthMountRateLimiter(probeLimiter, genericLimiter)', () => {
    expect(appSource).toMatch(
      /app\.use\('\/health',\s*healthMountRateLimiter\(probeLimiter,\s*genericLimiter\),\s*uptimeRoutes\)/
    );
  });

  it('never mounts /health behind a bare limiter again', () => {
    expect(appSource).not.toMatch(/app\.use\('\/health',\s*genericLimiter/);
  });
});

describe('infra coherence — every path k8s actually probes is exempted', () => {
  const container = deployment.spec.template.spec.containers.find(
    (c) => c.name === 'backend' || (c.ports || []).some((p) => p.name === 'http')
  );
  const exempted = HEALTH_MOUNT_PROBE_PATHS.map((p) => `/health${p}`);

  it('readiness (in-pod exec fetch) targets an exempted path', () => {
    const script = container.readinessProbe.exec.command.join('\n');
    const match = script.match(/127\.0\.0\.1:\$\{port\}(\/[\w/-]+)/);
    expect(match).not.toBeNull();
    expect(exempted).toContain(match[1]);
  });

  it.each(['livenessProbe', 'startupProbe'])('%s (kubelet httpGet) targets an exempted path', (probe) => {
    expect(exempted).toContain(container[probe].httpGet.path);
  });
});
