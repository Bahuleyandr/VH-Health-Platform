// src/routes/health/uptimeRoutes.js
// Dedicated health check endpoints optimized for external monitoring tools
import express from 'express';
import prisma, { circuitBreakerStatus } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

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

// GET /health/live — Kubernetes liveness/startup probe alias for /ping.
router.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

// GET /health/ready — readiness probe for traffic admission.
router.get('/ready', async (_req, res) => {
  const checks = {};

  try {
    const start = Date.now();
    const [migrationState] = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'appointment_status_history'
      ) AS exists
    `;

    checks.database = { status: 'ok', latency_ms: Date.now() - start };
    checks.migration_106 = migrationState?.exists
      ? { status: 'ok', table: 'appointment_status_history' }
      : { status: 'error', table: 'appointment_status_history', message: 'Migration 106 table missing' };
  } catch (err) {
    checks.database = { status: 'error', message: 'Database check failed' };
    checks.migration_106 = { status: 'unknown', table: 'appointment_status_history' };
    logger.warn('Readiness probe failed:', err.message);
  }

  const ready = Object.values(checks).every((c) => c.status === 'ok');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// GET /health/deep — full connectivity check (DB, Redis, R2, Firebase)
router.get('/deep', async (_req, res) => {
  const checks = {};

  // Database
  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.database = { status: 'ok', latency_ms: Date.now() - start };
  } catch (_err) {
    checks.database = { status: 'error', message: 'Database check failed' };
  }

  // Redis — check if ioredis client is available
  try {
    if (global.__redisClient && typeof global.__redisClient.ping === 'function') {
      const start = Date.now();
      await global.__redisClient.ping();
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
router.get('/metrics', async (_req, res) => {
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

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: uptimeSeconds,
    total_requests: totalRequests,
    total_errors: totalErrors,
    error_rate: totalRequests > 0 ? (totalErrors / totalRequests).toFixed(4) : '0.0000',
    database: dbPoolStats,
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
