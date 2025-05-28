#!/usr/bin/env node

// src/bin/www.js

import dotenv from 'dotenv';
import http from 'http';
import app from '../app.js';
import { runAllScheduledTasksNow } from '../utils/scheduler.js';

// Load environment variables from .env.local or fallback to .env
dotenv.config();

// Normalize port
function normalizePort(val) {
  const port = parseInt(val, 10);
  if (isNaN(port)) return val; // Named pipe
  if (port >= 0) return port; // Port number
  return false;
}

const PORT = normalizePort(process.env.PORT || '5000');
app.set('port', PORT);

// Create HTTP server
const server = http.createServer(app);

// Handle server errors
function onError(error) {
  if (error.syscall !== 'listen') throw error;

  const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;
  switch (error.code) {
    case 'EACCES':
      console.error(`${bind} requires elevated privileges`);
      process.exit(1);
    case 'EADDRINUSE':
      console.error(`${bind} is already in use`);
      process.exit(1);
    default:
      throw error;
  }
}

// On server listening
function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  console.log(`VH Health Backend running on ${bind}`);

  // Run all scheduled tasks once at startup
  runAllScheduledTasksNow();
}

server.on('error', onError);
server.on('listening', onListening);
server.listen(PORT);

export default server;
