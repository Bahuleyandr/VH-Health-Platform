// src/routes/health/uptimeRoutes.js
// Dedicated health check endpoints optimized for external monitoring tools
import express from 'express';
import prisma, { circuitBreakerStatus, tenantRlsRolePosture } from '../../lib/prisma.js';
import { assertRedisWritable, getRedisClient, isRedisConfigured, redisIsRequired } from '../../lib/redis.js';
import logger from '../../logging/logger.js';
import { requireProductionMonitoringAccess } from '../../middleware/infrastructureAccessMiddleware.js';
import { rateLimitStoreStatus } from '../../middleware/rateLimitStoreHealth.js';
import { readMigrationState } from '../../utils/migrations/runMigrations.js';
import { isWsFanoutReady } from '../../utils/websocket/wsServer.js';

const router = express.Router();

// In-memory counters (reset on restart — acceptable for monitoring)
let totalRequests = 0;
let totalErrors = 0;
const startTime = Date.now();

/**
 * Middleware to count requests (mounted at app level if desired,
 * but these counters track only /health/* hits by default).
 */
export function requestCounter(req, res, next) {
  totalRequests++;
  res.on('finish', () => {
    if (res.statusCode >= 500) totalErrors++;
  });
  next();
}

// GET /health/ping — lightweight liveness probe (no DB, < 10ms)
router.get('/ping', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

// GET /health/version — reports the deployed git commit + build timestamp.
//
// Lets the vh-health-swarm's auditor compare the live deploy against
// latest main before filing a finding — if main has moved past the
// deploy, the auditor stamps a `live_commit_lag: true` flag on the
// finding's frontmatter so the human-triage step can defer/drop it.
// Stops the swarm from re-filing already-fixed bugs (the 2026-05-15→16
// burst was 73% stale-by-existing-code purely from deploy lag).
//
// GIT_COMMIT is injected at image-build time by the deploy workflow
// (.github/workflows/deploy-dalekdefender.yml + the Argo overlays).
// Falls back to "unknown" if the env var wasn't set so callers can
// still parse the shape; they should treat "unknown" as "can't verify
// freshness" and proceed cautiously.
router.get('/version', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    commit: process.env.GIT_COMMIT || 'unknown',
    branch: process.env.GIT_BRANCH || 'main',
    built_at: process.env.GIT_BUILT_AT || null,
    node_env: process.env.NODE_ENV || 'unknown',
    uptime_seconds: Math.round((Date.now() - startTime) / 1000),
  });
});

// GET /health/live — Kubernetes liveness/startup probe alias for /ping.
router.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

// 873-F2: first-seen timestamps for RUN-TIME Redis degradation, so the
// readiness payload can say since-when honestly. Per-process (reset on
// restart) — the same lifetime as the degradation it describes.
const degradedSince = {
  redis: null,
  redis_websocket_subscriber: null,
};

/** Test-only: reset the degraded-since latches between cases. */
export function __resetReadinessDegradedSinceForTests() {
  degradedSince.redis = null;
  degradedSince.redis_websocket_subscriber = null;
}

function markDegraded(name) {
  if (!degradedSince[name]) degradedSince[name] = Date.now();
  return new Date(degradedSince[name]).toISOString();
}

// GET /health/ready — readiness probe for traffic admission.
router.get('/ready', requireProductionMonitoringAccess, async (_req, res) => {
  const checks = {};
  const degraded = {};

  try {
    const start = Date.now();
    const migrationState = await readMigrationState();

    checks.database = { status: 'ok', latency_ms: Date.now() - start };
    checks.migrations = migrationState.requiredCurrent
      ? {
        status: 'ok',
        expected_tip: migrationState.expectedTip,
        database_tip: migrationState.executedTip,
        database_ahead: migrationState.unexpected.length > 0,
      }
      : {
        status: 'error',
        expected_tip: migrationState.expectedTip,
        database_tip: migrationState.executedTip,
        pending_count: migrationState.pending.length,
        message: 'Required migrations are pending',
      };
  } catch (err) {
    checks.database = { status: 'error', message: 'Database check failed' };
    checks.migrations = { status: 'unknown', message: 'Migration tracker check failed' };
    logger.warn('Readiness probe failed:', err.message);
  }

  // 873-F2: strictness (REDIS_REQUIRE_SENTINEL=true) is a BOOT gate, not a
  // run-time traffic gate. A strict pod that cannot reach Redis at startup
  // exits 1 (bin/www.js) and never serves. But once a pod has initialized,
  // a MID-FLIGHT store outage must NOT fail readiness: this probe used to
  // 503 on any Redis loss, so kubelet pulled EVERY pod from the Service
  // within ~15s (period 5 / threshold 3) — the exact hospital-wide outage
  // the fail-open store-loss posture (rateLimitStoreLossPolicy.js) exists to
  // prevent. The pod deliberately serves degraded through an outage:
  // fail-closed limiter profiles answer honest 429s, fail-open profiles pass
  // unmetered, and the blacklist/cache paths fall to the authoritative DB.
  // Degradation is reported honestly below (status + `degraded` block with
  // since-when) instead of being converted into a fleet-wide NotReady.
  if (redisIsRequired()) {
    const client = getRedisClient();
    if (!client) {
      // Never-initialized under strict mode: the boot gate should have
      // exited before listen; a strict pod with no client at all is in an
      // impossible-to-serve state, so this remains NOT ready (unchanged —
      // the boot path itself is pinned by redisInitDeadline.test.js).
      checks.redis = {
        status: 'error',
        message: 'Required Redis client was never initialized',
      };
    } else {
      try {
        const start = Date.now();
        await assertRedisWritable();
        checks.redis = { status: 'ok', latency_ms: Date.now() - start };
        degradedSince.redis = null;
      } catch (err) {
        const since = markDegraded('redis');
        checks.redis = {
          status: 'degraded',
          message: 'Redis store unreachable — serving degraded per the store-loss posture',
          degraded_since: since,
        };
        degraded.redis = { state: 'store_unwritable', since };
        logger.warn('Readiness Redis probe degraded (still serving):', err.message);
      }
    }
  }

  // 873-F10: the cross-pod WebSocket fan-out subscriber is surfaced in BOTH
  // strict and non-strict modes (it used to be strict-only, so a non-strict
  // degraded-start pod that recovered its cache via background reinit could
  // stay silently deaf to cross-pod code-blue/vitals broadcasts while
  // reporting ready). Like the store check above it reports degradation
  // without flipping the HTTP status: a deaf pod still serves API traffic.
  if (redisIsRequired() || isRedisConfigured()) {
    if (isWsFanoutReady()) {
      checks.redis_websocket_subscriber = { status: 'ok' };
      degradedSince.redis_websocket_subscriber = null;
    } else {
      const since = markDegraded('redis_websocket_subscriber');
      checks.redis_websocket_subscriber = {
        status: 'degraded',
        message: 'Redis WebSocket fan-out subscriber unavailable — broadcasts are single-process only',
        degraded_since: since,
      };
      degraded.redis_websocket_subscriber = { state: 'subscriber_unavailable', since };
    }
  }

  // NB: tenant-RLS *security posture* is deliberately NOT part of the readiness
  // gate (audit C-7). It used to be — an `ok:false` posture (e.g. an unforced
  // table after a migration, or a bypassing role) made `ready` false on EVERY
  // replica simultaneously → a full API outage triggered by a security WARNING,
  // not by the service being unable to serve traffic. Readiness now gates on
  // DB reachability + the image's required migration set. Redis is a boot-time
  // gate in strict Sentinel mode only; a run-time store outage on an
  // initialized pod is REPORTED (see the 873-F2 block above) but never fails
  // readiness — pulling every pod for a cache outage is the outage. A database
  // ahead of an old pod remains ready during a rolling deploy, while a new pod
  // with pending requirements is rejected. RLS posture is still
  // surfaced loudly elsewhere: a boot-time ERROR (logTenantRlsRolePosture in
  // bin/www.js) and a live signal on GET /health/metrics (`tenant_rls`), which
  // is where alerting should hang — not on the traffic-admission probe.

  // 'degraded' checks admit traffic (HTTP 200); only 'error' fails readiness.
  const ready = Object.values(checks).every(
    (c) => c.status === 'ok' || c.status === 'degraded',
  );
  const anyDegraded = Object.keys(degraded).length > 0;
  const payload = {
    status: ready ? (anyDegraded ? 'degraded' : 'ok') : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  };
  if (anyDegraded) payload.degraded = degraded;
  res.status(ready ? 200 : 503).json(payload);
});

// GET /health/deep — full connectivity check (DB, Redis, R2, Firebase)
router.get('/deep', requireProductionMonitoringAccess, async (_req, res) => {
  const checks = {};

  // Database
  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.database = { status: 'ok', latency_ms: Date.now() - start };
  } catch (_err) {
    checks.database = { status: 'error', message: 'Database check failed' };
  }

  // Database target — surface host/port/database (NEVER user/password) so
  // QA orchestrators / swarm drivers can verify the backend is connected
  // to the same DB they intend to verify against. Silent target mismatch
  // (backend writing to dev :5433/vhhealth while the swarm verifies on
  // QA :55432/vhhealth_test) was a recurring class of false negatives —
  // see swarm finding 2026-05-11-pediatric-opd-receptionist-80e83c7f.
  // Parsed from DATABASE_URL on every call (not cached) so a runtime
  // env-flip surfaces immediately. Best-effort: if URL is unparseable,
  // we surface the error rather than crashing the deep-health endpoint.
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const u = new URL(dbUrl);
      checks.database_target = {
        status: 'ok',
        host: u.hostname,
        port: u.port || '5432',
        database: u.pathname.replace(/^\//, '') || null,
      };
    } else {
      checks.database_target = { status: 'not_configured' };
    }
  } catch (_err) {
    checks.database_target = { status: 'error', message: 'DATABASE_URL parse failed' };
  }

  // Redis — check the actual singleton rather than an unwired global.
  try {
    const client = getRedisClient();
    if (client && typeof client.ping === 'function') {
      const start = Date.now();
      await client.ping();
      checks.redis = { status: 'ok', latency_ms: Date.now() - start };
    } else {
      checks.redis = { status: 'not_configured' };
    }
  } catch (_err) {
    checks.redis = { status: 'error', message: 'Redis check failed' };
  }

  // R2 (Cloudflare) — check env vars are present
  try {
    const r2Configured = !!(
      process.env.CF_ACCOUNT_ID &&
      process.env.CF_R2_BUCKET &&
      process.env.CF_R2_URL &&
      process.env.CF_R2_ACCESS_KEY_ID &&
      process.env.CF_R2_SECRET_ACCESS_KEY
    );
    checks.r2 = { status: r2Configured ? 'configured' : 'not_configured' };
  } catch (_err) {
    checks.r2 = { status: 'error', message: 'R2 check failed' };
  }

  // Firebase — check if admin SDK is initialized
  try {
    const firebaseConfigured = !!(
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
    checks.firebase = { status: firebaseConfigured ? 'configured' : 'not_configured' };
  } catch (_err) {
    checks.firebase = { status: 'error', message: 'Firebase check failed' };
  }

  const allOk = Object.values(checks).every(
    (c) => c.status === 'ok' || c.status === 'configured' || c.status === 'not_configured'
  );

  const statusCode = allOk ? 200 : 503;

  res.status(statusCode).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// GET /health/metrics — key operational metrics for monitoring dashboards
router.get('/metrics', requireProductionMonitoringAccess, async (_req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const memUsage = process.memoryUsage();

  // Database health — SELECT 1 proves the driver is live; circuit breaker
  // status tells operators whether the client is rejecting queries due to
  // prior failures. The legacy pg pool (totalCount/idleCount/waitingCount)
  // is gone since batch 28; use `prisma.$metrics.json()` if per-pool
  // counters become load-bearing again.
  let dbPoolStats = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbPoolStats = { healthy: true, circuitBreaker: circuitBreakerStatus() };
  } catch (err) {
    logger.warn('Failed DB health probe for metrics:', err.message);
    dbPoolStats = { healthy: false, error: 'Database check failed', circuitBreaker: circuitBreakerStatus() };
  }

  // Tenant-RLS posture: surfaces whether tenant isolation is actually being
  // enforced. `enforced && ok === false` means AUTH_ENFORCE_TENANT_RLS=true
  // but the effective role bypasses RLS (super/BYPASSRLS) — policies inert.
  // Lets ops + the swarm detect the inert-RLS misconfig without log access.
  let tenantRls = null;
  try {
    tenantRls = await tenantRlsRolePosture();
  } catch (_err) {
    tenantRls = { error: 'rls_posture_unavailable' };
  }

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: uptimeSeconds,
    total_requests: totalRequests,
    total_errors: totalErrors,
    error_rate: totalRequests > 0 ? (totalErrors / totalRequests).toFixed(4) : '0.0000',
    database: dbPoolStats,
    tenant_rls: tenantRls,
    // Redis-backed rate-limit store posture (Redis-loss drill 2026-08-15):
    // 'degraded' means fail-closed profiles are answering 429 and fail-open
    // profiles are passing unmetered. Same operator pattern as circuitBreaker.
    rate_limit_store: rateLimitStoreStatus(),
    memory: {
      rss_mb: Math.round(memUsage.rss / 1024 / 1024),
      heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
      external_mb: Math.round(memUsage.external / 1024 / 1024),
    },
    node_version: process.version,
    environment: process.env.NODE_ENV || 'development',
  });
});

export default router;
