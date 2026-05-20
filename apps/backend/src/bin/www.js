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
import { logTenantRlsRolePosture } from '../lib/prisma.js';
import { initRedis, disconnectRedis } from '../lib/redis.js';
import logger from '../logging/logger.js';
import { checkDependencyHealth } from '../utils/dependencyChecker.js';
import { runMigrations } from '../utils/migrations/runMigrations.js';
import { runAllScheduledTasksNow } from '../utils/scheduler.js';
import { checkSchemaHealth } from '../utils/schemaHealthCheck.js';
import { initWebSocket } from '../utils/websocket/wsServer.js';



// Normalize port
function normalizePort(val) {
  const port = parseInt(val, 10);
  if (isNaN(port)) {return val;} // Named pipe
  if (port >= 0) {return port;} // Port number
  return false;
}

const PORT = normalizePort(process.env.PORT || '5000');
app.set('port', PORT);

// Create HTTP server
const server = http.createServer(app);

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

// On server listening
async function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  logger.info(`VH Health Backend running on ${bind}`);

  // Initialize WebSocket server
  initWebSocket(server);

  // Run dependency health check
  await checkDependencyHealth();

  // Run database migrations. Migration failure is FATAL by design — a
  // half-applied schema produces silent runtime errors that are much harder
  // to diagnose than a startup crash. The runner re-throws on any per-
  // statement failure; we surface a clear startup error and exit non-zero
  // so the orchestrator (k8s / systemd / nodemon) can flag it.
  try {
    await runMigrations();
    logger.info('Migrations completed successfully');
  } catch (err) {
    logger.error('Migration runner failed — refusing to start with a broken schema.', {
      error: err?.message,
      code: err?.code,
    });
    process.stderr.write(
      `\n❌ Database migrations failed (${err?.code || 'unknown'}): ${err?.message}\n` +
        `Inspect apps/backend/src/migrations/ + the _migrations tracker table; ` +
        `fix the failing file and restart. The previous behavior of swallowing ` +
        `migration errors masked real schema drift (see runMigrations.js).\n`,
    );
    process.exit(1);
  }

  // Verify schema health after migrations
  await checkSchemaHealth();

  // Tenant-RLS posture guard: when AUTH_ENFORCE_TENANT_RLS=true, log a loud
  // ERROR if the effective DB role bypasses RLS (superuser/BYPASSRLS) so a
  // deployment can't silently ship inert tenant isolation. Best-effort.
  await logTenantRlsRolePosture();

  // NB: database pool health monitor was removed with the DatabaseManager
  // shim — Prisma doesn't expose pool counts directly. Circuit-breaker
  // state is surfaced by `circuitBreakerStatus()` and scraped via
  // /health/metrics.

  // Initialize Redis cache
  try {
    await initRedis();
  } catch (err) {
    logger.warn('Redis initialization failed — running without cache:', err.message);
  }

  runAllScheduledTasksNow();
}

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  server.close(async () => {
    logger.info('HTTP server closed.');
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
server.listen(PORT);

export default server;
