#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

// Scheduler
const { runAllScheduledTasksNow } = require('../utils/scheduler');

// Import the configured Express app
const app = require('../app');

// Normalize port function
function normalizePort(val) {
  const port = parseInt(val, 10);
  if (isNaN(port)) return val; // Named pipe
  if (port >= 0) return port;  // Port number
  return false;
}

// Determine and normalize the port
const PORT = normalizePort(process.env.PORT || '5000');
app.set('port', PORT);

// Create HTTP server
const http = require('http');
const server = http.createServer(app);

// Event listener for HTTP server "error" event.
function onError(error) {
  if (error.syscall !== 'listen') throw error;

  const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

// Event listener for HTTP server "listening" event.
function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  console.log(`VH Health Backend running on ${bind}`);

  // ✅ Run all scheduled tasks once on startup
  runAllScheduledTasksNow();
}

// Bind event listeners
server.on('error', onError);
server.on('listening', onListening);

// Start the server
server.listen(PORT);

// Export server for testing (optional)
module.exports = server;
