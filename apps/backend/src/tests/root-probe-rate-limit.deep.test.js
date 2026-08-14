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
// Test seam (same as hl7-inbound-disabled.deep.test.js): the limiter skips
// under jest unless its profile opts in, and both `enforceInTest` and `max`
// are read per request, so the suite flips them on the live profile object and
// restores them. Each burst uses a unique x-api-key — the pre-auth bucket
// selector in defaultKeyGenerator — so buckets never leak across tests or
// into other suites (the 15-minute window outlives this file).

import crypto from 'crypto';
import request from 'supertest';
import app from '../app.js';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

const BURST_MAX = 2;

describe('root probe + /metrics rate limiting actually enforces (path skip trap)', () => {
  let previousEnforceInTest;
  let previousMax;

  beforeAll(() => {
    previousEnforceInTest = RATE_LIMIT_PROFILES.default.enforceInTest;
    previousMax = RATE_LIMIT_PROFILES.default.max;
    RATE_LIMIT_PROFILES.default.enforceInTest = true;
    RATE_LIMIT_PROFILES.default.max = BURST_MAX;
  });

  afterAll(() => {
    RATE_LIMIT_PROFILES.default.enforceInTest = previousEnforceInTest;
    RATE_LIMIT_PROFILES.default.max = previousMax;
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
