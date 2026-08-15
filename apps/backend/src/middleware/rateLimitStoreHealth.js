// src/middleware/rateLimitStoreHealth.js
//
// Runtime health + posture enforcement for the shared Redis rate-limit store.
// The DECISION TABLE (which profile fails closed vs open under store loss)
// lives in config/rateLimitStoreLossPolicy.js; this module owns the mutable
// state: outage detection, the short-circuit that keeps requests from paying a
// store round-trip while Redis is known-down, the once-per-transition operator
// log lines, and the counters surfaced through /health/metrics.
//
// DETECTION — three independent ways the store can be gone, three signals:
//   1. Detected loss (node killed, RST seen): ioredis emits 'close' and
//      isRedisConnected() flips false immediately. We short-circuit on that
//      flag; ioredis's own infinite retryStrategy self-heals the connection
//      and the flag flips back on 'ready'. No probing needed. Without the
//      short-circuit, every request's command sits in the offline queue for
//      up to maxRetriesPerRequest reconnect attempts — measured 1,164ms early
//      in an outage, rising to 15,239ms once the backoff matures to its 5s cap.
//   2. Silent loss (blackholed socket: peer stopped responding, no FIN/RST):
//      the connection still LOOKS up, so detection is a failed command —
//      bounded at REDIS_COMMAND_TIMEOUT_MS by lib/redis.js (measured 2,004ms;
//      UNBOUNDED before that option). A failure opens a breaker here; while it
//      is open, one request per PROBE interval goes through as a half-open
//      probe (cost ≤ the command timeout) and everything else short-circuits.
//   3. Never-initialized (non-strict boot with Redis down): getRedisClient()
//      is null and hasRedisInitFailed() is true. Request-path probing would
//      pay a full bounded connect attempt per probe, so recovery is owned
//      entirely by scheduleRedisReinit() off the request path.
//
// lib/redis.js is imported as a namespace on purpose: several test suites mock
// that module with partial export sets, and a static named import of a newer
// export would break their module graphs at load.

import * as redisLib from '../lib/redis.js';
import {
  RATE_LIMIT_STORE_LOSS_POSTURE,
  RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS,
} from '../config/rateLimitStoreLossPolicy.js';
import logger from '../logging/logger.js';

// While the failure breaker is open, allow one half-open probe through to the
// real store this often. Bounds silent-loss recovery detection at one probe
// interval + one command timeout.
const STORE_PROBE_INTERVAL_MS = 15000;

let breakerOpenedAt = null; // non-null => command-failure breaker is open
let nextProbeAt = 0;
let lastErrorMessage = null;

// Once-per-transition operator signal latch.
let reportedDown = false;
let downSince = null;
let lastTransitionAt = null;

const counters = {
  deniedWhileDown: 0,
  passedUnmeteredWhileDown: 0,
  storeErrors: 0,
  probes: 0,
};

function noteDown(reason) {
  if (reportedDown) return;
  reportedDown = true;
  downSince = Date.now();
  lastTransitionAt = downSince;
  logger.error(
    'Rate-limit store DOWN — Redis-backed rate limiting degraded: '
      + 'fail-closed profiles (auth/otp/sos/dataExport/dashboard/smartFhirOAuth) now answer 429, '
      + 'fail-open profiles pass unmetered. See /health/metrics rate_limit_store.',
    { reason, error: lastErrorMessage },
  );
}

function noteUp() {
  if (!reportedDown) return;
  const downForMs = downSince ? Date.now() - downSince : null;
  logger.warn('Rate-limit store RECOVERED — Redis-backed rate limiting restored.', {
    downForMs,
    deniedWhileDown: counters.deniedWhileDown,
    passedUnmeteredWhileDown: counters.passedUnmeteredWhileDown,
  });
  reportedDown = false;
  downSince = null;
  lastTransitionAt = Date.now();
  counters.deniedWhileDown = 0;
  counters.passedUnmeteredWhileDown = 0;
}

export function markStoreCommandOk() {
  breakerOpenedAt = null;
  lastErrorMessage = null;
  noteUp();
}

export function markStoreCommandFailed(err, now = Date.now()) {
  counters.storeErrors += 1;
  lastErrorMessage = err?.message || String(err);
  if (breakerOpenedAt === null) {
    breakerOpenedAt = now;
  }
  nextProbeAt = now + STORE_PROBE_INTERVAL_MS;
  noteDown('store_command_failed');
}

/**
 * Decide how a store operation should proceed right now.
 * @returns {{mode: 'store'|'probe'|'short_circuit', reason?: string}}
 */
export function evaluateStoreAccess(now = Date.now()) {
  const client = redisLib.getRedisClient?.();
  if (!client) {
    const initFailed = redisLib.hasRedisInitFailed ? redisLib.hasRedisInitFailed() : false;
    if (initFailed) {
      noteDown('redis_never_initialized');
      return { mode: 'short_circuit', reason: 'redis_never_initialized' };
    }
    // First lazy use before any init attempt: let it through — initRedis() is
    // bounded by REDIS_INIT_TIMEOUT_MS and this happens at most once.
    return { mode: 'store' };
  }
  if (redisLib.isRedisConnected && !redisLib.isRedisConnected()) {
    noteDown('redis_disconnected');
    return { mode: 'short_circuit', reason: 'redis_disconnected' };
  }
  if (breakerOpenedAt !== null) {
    if (now >= nextProbeAt) {
      nextProbeAt = now + STORE_PROBE_INTERVAL_MS;
      counters.probes += 1;
      return { mode: 'probe' };
    }
    return { mode: 'short_circuit', reason: 'store_errors' };
  }
  // Healthy path. If we were down for a connection-level reason (disconnected
  // or never-initialized) and the client is back, the recovery is visible here
  // even before any request exercises the store — clear the latch so the
  // operator signal and /health/metrics don't stay stale on a quiet system.
  noteUp();
  return { mode: 'store' };
}

function recordDenied() {
  counters.deniedWhileDown += 1;
}

function recordPassedUnmetered() {
  counters.passedUnmeteredWhileDown += 1;
}

/**
 * Wraps a rate-limit-redis RedisStore so that store loss NEVER reaches the
 * Express error chain (the drill's 500 storm) and instead resolves to the
 * profile's declared posture:
 *
 *   fail_closed         => increment() reports the bucket as saturated
 *                          (Number.MAX_SAFE_INTEGER hits), so the limiter's
 *                          normal handler answers 429 — with Retry-After set
 *                          from resetTime, i.e. the SHORT store-loss value
 *                          rather than the profile window.
 *   fail_open_unmetered => increment() reports one hit, so the request passes.
 *
 * The short-circuit lives here (not in an outer middleware) so it runs AFTER
 * express-rate-limit's own skip() logic — DISABLE_RATE_LIMITING and the
 * test-env skips keep working — and so both the known-down fast path and the
 * fresh-failure path produce one identical denial shape.
 */
export class ResilientRateLimitStore {
  constructor({ inner, profileName, posture }) {
    this.inner = inner;
    this.profileName = profileName;
    this.posture = posture;
    this.windowMs = undefined;
    this.innerInitFailed = false;
  }

  // MUST await (and absorb) the inner init. rate-limit-redis v6 loads its Lua
  // scripts inside init(); with Redis down at construction the returned
  // promise REJECTS, and dropping it fire-and-forget turns a degraded start
  // into an unhandledRejection storm that trips www.js's shutdown handler —
  // observed as 4+ parallel gracefulShutdown() runs before listen. The failure
  // is recorded (breaker opens) and the store is re-initialized on the next
  // healthy access, because a failed init leaves the library's cached
  // script-SHA promise permanently rejected.
  async init(options) {
    this.windowMs = options?.windowMs ?? this.windowMs;
    await this.initInner(options);
  }

  async initInner(options) {
    try {
      await this.inner.init?.(options ?? { windowMs: this.windowMs });
      this.innerInitFailed = false;
    } catch (err) {
      this.innerInitFailed = true;
      markStoreCommandFailed(err);
    }
  }

  storeLossResult(now = Date.now()) {
    if (this.posture === RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED) {
      recordPassedUnmetered();
      return { totalHits: 1, resetTime: new Date(now + (this.windowMs ?? 60000)) };
    }
    recordDenied();
    return {
      totalHits: Number.MAX_SAFE_INTEGER,
      resetTime: new Date(now + RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS * 1000),
    };
  }

  async increment(key) {
    const access = evaluateStoreAccess();
    if (access.mode === 'short_circuit') {
      return this.storeLossResult();
    }
    try {
      if (this.innerInitFailed) {
        await this.initInner();
        if (this.innerInitFailed) return this.storeLossResult();
      }
      const result = await this.inner.increment(key);
      markStoreCommandOk();
      return result;
    } catch (err) {
      markStoreCommandFailed(err);
      return this.storeLossResult();
    }
  }

  async decrement(key) {
    if (evaluateStoreAccess().mode === 'short_circuit') return;
    try {
      await this.inner.decrement(key);
    } catch (err) {
      markStoreCommandFailed(err);
    }
  }

  async resetKey(key) {
    if (evaluateStoreAccess().mode === 'short_circuit') return;
    try {
      await this.inner.resetKey(key);
    } catch (err) {
      markStoreCommandFailed(err);
    }
  }
}

/**
 * Operator-facing snapshot, surfaced as `rate_limit_store` on /health/metrics
 * (same pattern as circuitBreakerStatus() from lib/prisma.js).
 */
export function rateLimitStoreStatus() {
  const configured = redisLib.isRedisConfigured ? redisLib.isRedisConfigured() : false;
  if (!configured) {
    return { state: 'not_configured', note: 'per-process MemoryStore; store loss not applicable' };
  }
  const access = evaluateStoreAccess();
  const degraded = reportedDown || access.mode === 'short_circuit';
  return {
    state: degraded ? 'degraded' : 'ok',
    reason: degraded ? (access.reason || 'store_errors') : null,
    down_since: downSince ? new Date(downSince).toISOString() : null,
    last_transition_at: lastTransitionAt ? new Date(lastTransitionAt).toISOString() : null,
    last_error: lastErrorMessage,
    counters: { ...counters },
  };
}

/** Test-only: reset all module state between cases. */
export function __resetRateLimitStoreHealthForTests() {
  breakerOpenedAt = null;
  nextProbeAt = 0;
  lastErrorMessage = null;
  reportedDown = false;
  downSince = null;
  lastTransitionAt = null;
  counters.deniedWhileDown = 0;
  counters.passedUnmeteredWhileDown = 0;
  counters.storeErrors = 0;
  counters.probes = 0;
}
