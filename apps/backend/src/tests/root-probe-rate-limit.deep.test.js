// src/tests/root-probe-rate-limit.deep.test.js
//
// Finding 2026-08-14 (backend-HTTP P2): the `genericLimiter` on the `/metrics`
// mount and the root `GET /` probe was a provable NO-OP, and `HEAD /` had no
// limiter at all. Express strips the mount prefix, so both surfaces observe
// `req.path === '/'` — exactly the path the default profile's built-in skip()
// exempts (alongside /health and /api-docs). Every request sailed through
// uncounted; the root probe runs a real `SELECT 1` per hit, so it was an
// unmetered DB-load amplifier, and /metrics an unmetered recon/log sink.
//
// The fix mounts a dedicated `probeLimiter` built with the existing
// `enforceOnMatchedPath` escape hatch (the same one mountHl7Interface.js uses
// for the identical trap on the HL7 bridge base path).
//
// Follow-up finding 2026-08-15: that limiter fired, but from the wrong profile
// and the wrong key. It reused `default` — derived from the blanket
// RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX knobs, which prod sets to 900000/100 —
// and every Prometheus scrape in the fleet collapsed into ONE cluster-wide
// Redis bucket (single static Bearer, no x-api-key, mount ahead of auth). At
// 30s scrape interval x 2 Prometheus HA replicas that is 60 scrapes/pod/window,
// so 180 at the HPA floor of 3 and 600 at the ceiling of 10, all against a
// bucket of 100. Monitoring degraded hardest during scale-up — during an
// incident — taking SLO burn-rate alerting with it. Now a dedicated `probe`
// profile (60s/120), mounted `instanceScoped` so the budget is per pod and
// therefore invariant to replica count.
//
// This suite must prove BOTH halves: the probe surfaces still throttle under
// abuse, AND a realistic fleet-scale scrape rate does not trip them. The
// derivation of 120 against the live infra manifests is pinned separately by
// src/tests/unit/probeRateLimitProfile.test.js.
//
// Test seam (same as hl7-inbound-disabled.deep.test.js): the limiter skips
// under jest unless its profile opts in, and both `enforceInTest` and `max`
// are read per request, so the suite flips them on the live profile object and
// restores them. Each burst uses a unique credential — the bucket selector in
// defaultKeyGenerator — so buckets never leak across tests or into other
// suites (the window outlives this file).

import crypto from 'crypto';
import request from 'supertest';
import app from '../app.js';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

const BURST_MAX = 2;

// Worst-case legitimate scrapes ONE pod receives in one 60s probe window.
// 2/min (60s / 30s ServiceMonitor interval) x2 Prometheus HA replicas x2 for a
// possible annotation-based scrape job x3 for incident-time interval
// tightening down to the 10s scrapeTimeout floor. Derived and pinned against
// the manifests in src/tests/unit/probeRateLimitProfile.test.js.
const WORST_CASE_SCRAPES_PER_POD_PER_WINDOW = 24;
// infra/kubernetes/apps/backend/hpa.yaml — maxReplicas.
const HPA_MAX_REPLICAS = 10;

describe('root probe + /metrics rate limiting actually enforces (path skip trap)', () => {
  let previousEnforceInTest;
  let previousMax;
  let previousInstanceId;

  beforeAll(() => {
    previousEnforceInTest = RATE_LIMIT_PROFILES.probe.enforceInTest;
    previousMax = RATE_LIMIT_PROFILES.probe.max;
    previousInstanceId = process.env.RATE_LIMIT_INSTANCE_ID;
    RATE_LIMIT_PROFILES.probe.enforceInTest = true;
  });

  afterAll(() => {
    RATE_LIMIT_PROFILES.probe.enforceInTest = previousEnforceInTest;
    RATE_LIMIT_PROFILES.probe.max = previousMax;
    if (previousInstanceId === undefined) delete process.env.RATE_LIMIT_INSTANCE_ID;
    else process.env.RATE_LIMIT_INSTANCE_ID = previousInstanceId;
  });

  describe('abuse of the probe surfaces is still refused', () => {
    beforeEach(() => {
      RATE_LIMIT_PROFILES.probe.max = BURST_MAX;
    });

    async function burst(method, path, count) {
      // Unique bucket per burst; sequential on purpose — the assertion is about
      // the ORDER in which the limiter starts refusing.
      const bucketKey = `probe-burst-${crypto.randomUUID()}`;
      const statuses = [];
      for (let attempt = 0; attempt < count; attempt += 1) {
        const res = await request(app)[method](path).set('x-api-key', bucketKey);
        statuses.push(res.statusCode);
      }
      return statuses;
    }

    it('GET / throttles after the threshold instead of skipping its own path', async () => {
      const statuses = await burst('get', '/', BURST_MAX + 2);
      // Healthy probe, healthy probe, then throttled — pre-fix this was an
      // endless stream of 200s (each one a real DB round-trip).
      expect(statuses).toEqual([200, 200, 429, 429]);
    });

    it('HEAD / (previously completely unlimited) shares the enforced probe bucket', async () => {
      const statuses = await burst('head', '/', BURST_MAX + 2);
      expect(statuses).toEqual([200, 200, 429, 429]);
    });

    it('GET /metrics throttles ahead of the monitoring-token gate', async () => {
      const statuses = await burst('get', '/metrics', BURST_MAX + 2);
      // No monitoring token configured in test → the gate 401s; the limiter
      // sits ahead of it, so past the threshold the gate is not even reached.
      expect(statuses).toEqual([401, 401, 429, 429]);
    });
  });

  describe('legitimate Prometheus scraping is not refused', () => {
    // The ServiceMonitor sends ONE static Bearer for every scrape of every pod
    // and no x-api-key, so defaultKeyGenerator reaches its Bearer branch and
    // all scrapes share a credential. That is what collapsed the fleet into a
    // single bucket; instance scoping is what un-collapses it. Each test mints
    // its own token so the buckets cannot depend on test order — but WITHIN a
    // test one token is shared across every simulated replica, which is the
    // property under examination.
    async function scrape(podName, token) {
      process.env.RATE_LIMIT_INSTANCE_ID = podName;
      return request(app).get('/metrics').set('Authorization', `Bearer ${token}`);
    }

    it('the probe bucket is keyed per instance, so the fleet does not share one quota', async () => {
      RATE_LIMIT_PROFILES.probe.max = BURST_MAX;
      const scrapeToken = `monitoring-token-${crypto.randomUUID()}`;
      const podA = `vhhealth-backend-${crypto.randomUUID()}`;
      const podB = `vhhealth-backend-${crypto.randomUUID()}`;

      const first = [];
      for (let i = 0; i < BURST_MAX + 1; i += 1) {
        first.push((await scrape(podA, scrapeToken)).statusCode);
      }
      // Same Bearer, same tenant, same path — pod A is now exhausted.
      expect(first).toEqual([401, 401, 429]);

      // A second replica carrying identical scrape traffic gets its OWN
      // budget. Under the fleet-collapsed key this was already 429 on request
      // one, which is precisely how scale-up blinded monitoring.
      const second = [];
      for (let i = 0; i < BURST_MAX; i += 1) {
        second.push((await scrape(podB, scrapeToken)).statusCode);
      }
      expect(second).toEqual([401, 401]);
    });

    it('a full HPA-ceiling fleet scraping at the worst-case rate never trips the limiter', async () => {
      // Shipped settings, not a test threshold — this is the real number.
      RATE_LIMIT_PROFILES.probe.max = previousMax;
      expect(previousMax).toBe(120);
      const scrapeToken = `monitoring-token-${crypto.randomUUID()}`;

      const statuses = [];
      for (let replica = 0; replica < HPA_MAX_REPLICAS; replica += 1) {
        const podName = `vhhealth-backend-fleet-${crypto.randomUUID()}`;
        for (let n = 0; n < WORST_CASE_SCRAPES_PER_POD_PER_WINDOW; n += 1) {
          statuses.push((await scrape(podName, scrapeToken)).statusCode);
        }
      }

      // 10 replicas x 24 worst-case scrapes = 240 scrapes in one window. Under
      // the old fleet-collapsed `default` bucket (100/15min) this was 140
      // refusals; every status here must be the monitoring gate's 401, never a
      // 429 from the limiter.
      expect(statuses).toHaveLength(HPA_MAX_REPLICAS * WORST_CASE_SCRAPES_PER_POD_PER_WINDOW);
      expect(statuses.filter((s) => s === 429)).toEqual([]);
      expect(new Set(statuses)).toEqual(new Set([401]));
    }, 60000);
  });
});
