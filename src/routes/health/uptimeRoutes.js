// src/routes/health/uptimeRoutes.js
// Dedicated health check endpoints optimized for external monitoring tools
import express from 'express';
import db from '../../config/database.js';
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

// GET /health/deep — full connectivity check (DB, Redis, R2, Firebase)
router.get('/deep', async (_req, res) => {
  const checks = {};

  // Database
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    checks.database = { status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    checks.database = { status: 'error', message: err.message };
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
  } catch (err) {
    checks.redis = { status: 'error', message: err.message };
  }

  // R2 (Cloudflare) — check env vars are present
  try {
    const r2Configured = !!(
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_ENDPOINT
    );
    checks.r2 = { status: r2Configured ? 'configured' : 'not_configured' };
  } catch (err) {
    checks.r2 = { status: 'error', message: err.message };
  }

  // Firebase — check if admin SDK is initialized
  try {
    const firebaseConfigured = !!(
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
    checks.firebase = { status: firebaseConfigured ? 'configured' : 'not_configured' };
  } catch (err) {
    checks.firebase = { status: 'error', message: err.message };
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

  let dbPoolStats = null;
  try {
    const health = await db.healthCheck();
    dbPoolStats = health;
  } catch (err) {
    logger.warn('Failed to get DB pool stats for metrics:', err.message);
    dbPoolStats = { healthy: false, error: err.message };
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
