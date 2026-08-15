#!/usr/bin/env node

// src/bin/www.js

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

// BigInt JSON serialization. Postgres BIGSERIAL columns come back as
// JS BigInt via Prisma raw queries; without this every endpoint that
// returns one would throw "Do not know how to serialize a BigInt".
// Most application IDs comfortably fit in Number (< 2^53), so we
// emit them as numbers when safe and fall back to string for the rare
// out-of-range case.

BigInt.prototype.toJSON = function bigIntToJSON() {
  const n = Number(this);
  return Number.isSafeInteger(n) ? n : this.toString();
};

import http from 'http';
import app from '../app.js';
import { logTenantRlsRolePosture, ensureTenantRlsRuntimeRoleGrants, tenantRlsPostureMustFailClosed } from '../lib/prisma.js';
import { initRedis, getRedisClient, disconnectRedis, redisIsRequired, scheduleRedisReinit } from '../lib/redis.js';
import logger from '../logging/logger.js';
import { checkDependencyHealth } from '../utils/dependencyChecker.js';
import { runMigrations, verifyMigrationsCurrent } from '../utils/migrations/runMigrations.js';
import { checkSchemaHealth } from '../utils/schemaHealthCheck.js';
import { initWebSocket, initWsFanout, closeWsFanout, isWsFanoutReady } from '../utils/websocket/wsServer.js';
import { collectReliabilityMetrics } from '../observability/reliabilityMetrics.js';
import { collectTeleconsultOpsMetrics } from '../observability/teleconsultOpsMetrics.js';
import { logPrivilegeGateStates } from '../config/privilegeGates.js';

let schedulerModule = null;

// Normalize port
function normalizePort(val) {
  const port = parseInt(val, 10);
  if (isNaN(port)) {return val;} // Named pipe
  if (port >= 0) {return port;} // Port number
  return false;
}

const PORT = normalizePort(process.env.PORT || '5000');
app.set('port', PORT);

// HTTP server timeout configuration (REL-4 / B2.4).
//
// Slow-loris and hung-request protection: without these, a client that
// opens a connection and trickles headers (or never completes a request
// body) ties up a worker indefinitely. The DB statement_timeout enforced
// by CNPG only covers query time; non-DB paths (file uploads, external
// API calls, etc.) are unprotected without request-level timeouts.
//
// Ordering constraint: keepAliveTimeout MUST be < headersTimeout.
// Node.js has a known race where, on a keep-alive connection, the headers
// timer fires before the keep-alive idle timer, causing an abrupt ECONNRESET
// instead of a clean 408. Keeping keepAlive < headers avoids the race.
//
// Defaults (env-overridable):
//   HTTP_REQUEST_TIMEOUT_MS  = 60000   (60 s) — max time from request start
//                                               to response complete
//   HTTP_KEEPALIVE_TIMEOUT_MS = 61000  (61 s) — idle keep-alive connection
//   HTTP_HEADERS_TIMEOUT_MS  = 65000   (65 s) — max time to receive full headers
//
// requestTimeout < headersTimeout: a request that has been fully parsed
// but not responded to within 60 s is killed before the 65 s header timer,
// which is the normal case. headersTimeout covers the slow-header attack
// window. keepAlive sits between the two so persistent connections are
// recycled before the header timer would fire on a new request over the
// same socket.
const HTTP_REQUEST_TIMEOUT_MS  = parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS  || '60000', 10);
const HTTP_KEEPALIVE_TIMEOUT_MS = parseInt(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || '61000', 10);
const HTTP_HEADERS_TIMEOUT_MS  = parseInt(process.env.HTTP_HEADERS_TIMEOUT_MS  || '65000', 10);

// Create HTTP server
const server = http.createServer(app);

// Apply timeouts BEFORE listen() so they are set on the server object
// before any connection arrives. These are server-level defaults that
// apply to every incoming socket.
server.requestTimeout  = HTTP_REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = HTTP_KEEPALIVE_TIMEOUT_MS;
server.headersTimeout  = HTTP_HEADERS_TIMEOUT_MS;

// Handle server errors
function onError(error) {
  if (error.syscall !== 'listen') {throw error;}

  const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;
  switch (error.code) {
    case 'EACCES':
      logger.error(`${bind} requires elevated privileges`);
      process.exit(1);
      break;

    case 'EADDRINUSE':
      logger.error(`${bind} is already in use`);
      process.exit(1);
      break;

    default:
      throw error;
  }
}

async function prepareApplication() {
  // Boot summary of credential-gate enforcement state, so a mistyped gate flag
  // can't silently leave a clinical privilege gate disabled unnoticed.
  logPrivilegeGateStates(logger);

  // Run dependency health check
  await checkDependencyHealth();

  // Production DDL is owned solely by Argo's owner-credential PreSync Job.
  // API workers connect as a least-privilege role and only verify that the
  // image's immutable migration directory exactly matches the tracker. Local
  // development keeps the convenient tracker-driven writer unless explicitly
  // disabled with RUN_MIGRATIONS=false.
  try {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production'
      || String(process.env.RUN_MIGRATIONS || '').toLowerCase() === 'false') {
      const state = await verifyMigrationsCurrent();
      logger.info('Migration tracker matches application image', {
        expectedTip: state.expectedTip,
        migrationCount: state.expectedCount,
      });
    } else {
      await runMigrations();
      logger.info('Migrations completed successfully');
    }
  } catch (err) {
    logger.error('Migration readiness failed — refusing to start with a broken schema.', {
      error: err?.message,
      code: err?.code,
      migrationState: err?.migrationState,
    });
    process.stderr.write(
      `\n❌ Database migration readiness failed (${err?.code || 'unknown'}): ${err?.message}\n` +
        'The owner-credential PreSync migration Job must apply the exact image migration set before API workers start.\n',
    );
    throw err;
  }

  // Verify schema health after migrations
  const schemaHealth = await checkSchemaHealth();
  if (!schemaHealth?.healthy) {
    const err = new Error('Critical database schema health checks failed');
    err.code = 'SCHEMA_HEALTH_UNSAFE';
    err.schemaHealth = schemaHealth;
    throw err;
  }

  // Local/QA owner connections may provision the runtime role. Production API
  // workers are deliberately non-DDL: the PreSync owner Job and migrations own
  // grants, while workers verify posture only.
  if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    await ensureTenantRlsRuntimeRoleGrants();
  }

  // Tenant-RLS posture guard: when AUTH_ENFORCE_TENANT_RLS=true, log a loud
  // ERROR if the effective DB role bypasses RLS (superuser/BYPASSRLS) or owns
  // unforced tenant_isolation tables, so a deployment can't silently ship
  // inert tenant isolation. Best-effort.
  const rlsPosture = await logTenantRlsRolePosture({ attempts: 3, delayMs: 250 });
  // CAN-040: fail closed in production when the posture is unsafe (RLS off or
  // inert) unless an audited single-tenant override is set — don't serve PHI
  // with tenant isolation silently disabled.
  if (tenantRlsPostureMustFailClosed(rlsPosture)) {
    logger.error(
      'FATAL: tenant-RLS posture is unsafe in production — refusing to start. '
      + 'Set AUTH_ENFORCE_TENANT_RLS=true and connect as a non-superuser/non-BYPASSRLS role, '
      + 'or set AUTH_TENANT_RLS_FAIL_OPEN=true to override for a confirmed single-tenant maintenance window.',
      { enforced: rlsPosture?.enforced, ok: rlsPosture?.ok, reason: rlsPosture?.reason },
    );
    const err = new Error('Tenant RLS posture is unsafe in production');
    err.code = 'TENANT_RLS_POSTURE_UNSAFE';
    throw err;
  }

  // NB: database pool health monitor was removed with the DatabaseManager
  // shim — Prisma doesn't expose pool counts directly. Circuit-breaker
  // state is surfaced by `circuitBreakerStatus()` and scraped via
  // /health/metrics.

  // Initialize Redis cache. initRedis() settles within REDIS_INIT_TIMEOUT_MS
  // in every configuration (lib/redis.js bounds the initial connect+ping), so
  // this gate now actually executes: with unreachable Sentinels it used to hang
  // forever inside ioredis's infinite discovery loop — neither the strict
  // fail-fast below nor a degraded start, and in k8s a pod that never became
  // ready and never crash-looped into visibility. Mid-flight connection loss is
  // NOT this path: it is handled by ioredis's own reconnection (infinite
  // retryStrategy, proven by the 2026-08-15 failover drill) and never exits.
  try {
    await initRedis();
  } catch (err) {
    if (redisIsRequired()) {
      logger.error('Required Redis Sentinel initialization failed — refusing to start:', err.message);
      throw err;
    }
    logger.warn('Redis initialization failed — running without cache:', err.message);
    // Degraded start: keep trying in the background (off the request path) so
    // the shared cache and rate-limit store come back without a pod restart.
    // Until then the rate limiter applies its per-profile store-loss posture
    // (config/rateLimitStoreLossPolicy.js).
    //
    // 873-F10: the cache/limiter recover through the singleton automatically,
    // but the WS fan-out subscriber below is boot-wired only — without this
    // hook a reinit-recovered pod stayed silently deaf to cross-pod clinical
    // broadcasts (code-blue / vitals) until restart, while reporting ready.
    // Rewire it on the same background recovery.
    scheduleRedisReinit({
      onReconnect: async (client) => {
        if (isWsFanoutReady()) return; // already wired by someone else
        try {
          const initialized = await initWsFanout({ pub: client });
          if (initialized) {
            logger.info('WS Redis fan-out restored after background Redis reconnect');
          }
        } catch (wsErr) {
          logger.warn(
            'WS fan-out rewire after Redis reconnect failed — broadcasts stay single-process '
              + '(visible as redis_websocket_subscriber on /health/ready):',
            wsErr.message,
          );
        }
      },
    });
  }

  // Wire cross-process WebSocket fan-out onto the Redis bus. The publisher is
  // the shared singleton; the subscriber is a dedicated duplicate connection
  // (subscriber-mode connections can't run normal commands). When Redis is
  // absent this is a no-op and broadcasts stay single-process (degraded).
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      const initialized = await initWsFanout({ pub: redisClient });
      if (!initialized) {
        throw new Error('Redis WebSocket subscriber did not initialize');
      }
    } else {
      logger.warn('WS Redis fan-out not wired — Redis unavailable; broadcasts are single-process only');
    }
  } catch (err) {
    if (redisIsRequired()) {
      logger.error('Required WS Redis fan-out initialization failed — refusing to start:', err.message);
      throw err;
    }
    logger.warn('WS Redis fan-out init failed — single-process broadcasts only:', err.message);
  }

  // Boot-time sweep. Awaited so a rejection is surfaced/handled rather than
  // becoming an unhandledRejection that tears the process down. The heavy
  // mutating jobs inside are advisory-locked + gated behind RUN_STARTUP_TASKS
  // (see scheduler.js) so this does NOT stampede across the worker fleet.
  try {
    // Importing scheduler.js registers its cron handles and immediate probes.
    // Keep that side effect behind the completed migration/schema/RLS gates.
    schedulerModule = await import('../utils/scheduler.js');
    await schedulerModule.runAllScheduledTasksNow();
  } catch (err) {
    logger.error('Boot-time runAllScheduledTasksNow failed:', err.message || err);
  }
}

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  logger.info(`VH Health Backend running on ${bind}`);

  initWebSocket(server);
  void schedulerModule?.primeOperationalRealtimeChannels?.();
}

// Timer handle for the reliability metrics collector (set after server.listen).
// Box wrapper keeps ESLint prefer-const happy while allowing the timer to be
// set after listen() and cleared in the pre-existing gracefulShutdown closure.
const reliabilityMetricsBox = { timer: null };

async function collectRuntimeMetrics() {
  await collectReliabilityMetrics();
  await collectTeleconsultOpsMetrics();
}

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  server.close(async () => {
    logger.info('HTTP server closed.');
    // Stop all node-cron tasks BEFORE disconnecting Prisma so no scheduled
    // tick fires a query against a closing connection (audit §4 "graceful
    // shutdown never stops crons"). .stop() prevents future invocations; any
    // in-flight tick finishes against the still-open pool below.
    try {
      clearInterval(reliabilityMetricsBox.timer);
      schedulerModule?.stopAllScheduledTasks();
    } catch (err) {
      logger.error('Error stopping scheduled tasks:', err.message);
    }
    try {
      // Disconnect Prisma primary + read-replica (if configured). Both
      // clients come from src/lib/prisma.js; prismaReadOnly is the same
      // instance as `prisma` when DATABASE_READ_URL isn't set.
      const { default: prisma, prismaReadOnly } = await import('../lib/prisma.js');
      await prisma.$disconnect();
      if (prismaReadOnly !== prisma) {
        await prismaReadOnly.$disconnect();
      }
      logger.info('Database clients disconnected.');
    } catch (err) {
      logger.error('Error disconnecting Prisma:', err.message);
    }
    try {
      // Tear down the WS fan-out subscriber connection before quitting the
      // shared Redis client.
      await closeWsFanout();
    } catch (err) {
      logger.error('Error closing WS fan-out:', err.message);
    }
    try {
      await disconnectRedis();
      logger.info('Redis disconnected.');
    } catch (err) {
      logger.error('Error disconnecting Redis:', err.message);
    }
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — shutting down:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

server.on('error', onError);
server.on('listening', onListening);
const RELIABILITY_METRICS_INTERVAL_MS = 20_000;
prepareApplication()
  .then(() => {
    server.listen(PORT);

    // Reliability metrics collector — refresh DB-derived gauges every 20s.
    // It starts only after the application passed every boot/readiness gate.
    collectRuntimeMetrics();
    reliabilityMetricsBox.timer = setInterval(collectRuntimeMetrics, RELIABILITY_METRICS_INTERVAL_MS);
    reliabilityMetricsBox.timer.unref();
  })
  .catch((err) => {
    logger.error('Application startup failed before listen', {
      error: err?.message,
      code: err?.code,
    });
    schedulerModule?.stopAllScheduledTasks();
    process.exit(1);
  });

export default server;
