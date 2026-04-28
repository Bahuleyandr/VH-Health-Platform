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
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function bigIntToJSON() {
  const n = Number(this);
  return Number.isSafeInteger(n) ? n : this.toString();
};

import http from 'http';
import app from '../app.js';
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

  // Run database migrations then scheduled tasks
  try {
    await runMigrations();
    logger.info('Migrations completed successfully');
  } catch (err) {
    // Migration runner is advisory — DB schema managed by prisma db push.
    // Log the error but do NOT exit; the schema is already correct.
    logger.warn('Migration runner encountered an error (non-fatal — schema managed by Prisma):', err.message);
  }

  // Verify schema health after migrations
  await checkSchemaHealth();

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
