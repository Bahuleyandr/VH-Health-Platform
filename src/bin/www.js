#!/usr/bin/env node

// src/bin/www.js

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import app from '../app.js';
import logger from '../logging/logger.js';
import { runAllScheduledTasksNow } from '../utils/scheduler.js';
import { initWebSocket } from '../utils/websocket/wsServer.js';
import { runMigrations } from '../utils/migrations/runMigrations.js';



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

  // Run database migrations then scheduled tasks
  try {
    await runMigrations();
    logger.info('Migrations completed successfully');
  } catch (err) {
    logger.error('FATAL: Migration failed:', err);
    process.exit(1);
  }
  runAllScheduledTasksNow();
}

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    // Close DB pool if available
    import('../config/database.js').then(db => {
      if (db.default?.end) db.default.end();
      logger.info('Database pool closed.');
      process.exit(0);
    }).catch(() => process.exit(0));
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
