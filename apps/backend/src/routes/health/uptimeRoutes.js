// src/routes/health/uptimeRoutes.js
// Dedicated health check endpoints optimized for external monitoring tools
import express from 'express';
import prisma, { circuitBreakerStatus, tenantRlsRolePosture } from '../../lib/prisma.js';
import { assertRedisWritable, getRedisClient, redisIsRequired } from '../../lib/redis.js';
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

// GET /health/ready — readiness probe for traffic admission.
router.get('/ready', requireProductionMonitoringAccess, async (_req, res) => {
  const checks = {};

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

  if (redisIsRequired()) {
    try {
      const start = Date.now();
      await assertRedisWritable();
      checks.redis = { status: 'ok', latency_ms: Date.now() - start };
      checks.redis_websocket_subscriber = isWsFanoutReady()
        ? { status: 'ok' }
        : { status: 'error', message: 'Required Redis WebSocket subscriber is unavailable' };
    } catch (err) {
      checks.redis = { status: 'error', message: 'Required Redis check failed' };
      logger.warn('Readiness Redis probe failed:', err.message);
    }
  }

  // NB: tenant-RLS *security posture* is deliberately NOT part of the readiness
  // gate (audit C-7). It used to be — an `ok:false` posture (e.g. an unforced
  // table after a migration, or a bypassing role) made `ready` false on EVERY
  // replica simultaneously → a full API outage triggered by a security WARNING,
  // not by the service being unable to serve traffic. Readiness now gates on
  // DB reachability + the image's required migration set, plus Redis only when
  // the deployment explicitly opts into strict Sentinel mode. A database ahead
  // of an old pod remains ready during a rolling deploy, while a new pod with
  // pending requirements is rejected. RLS posture is still
  // surfaced loudly elsewhere: a boot-time ERROR (logTenantRlsRolePosture in
  // bin/www.js) and a live signal on GET /health/metrics (`tenant_rls`), which
  // is where alerting should hang — not on the traffic-admission probe.

  const ready = Object.values(checks).every((c) => c.status === 'ok');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
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
