// utils/logger.js
const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format
const logFormat = format.printf(({ timestamp, level, message }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

// Create Winston logger instance
const logger = createLogger({
  level: 'debug', // Enable debug & verbose levels
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console output with colors
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      ),
    }),

    // Error level to error.log
    new transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),

    // Combined logs to combined.log
    new transports.File({ filename: path.join(logsDir, 'combined.log') }),

    // Daily Rotate with 90 days retention and compression
    new DailyRotateFile({
      filename: path.join(logsDir, 'vh-health-%DATE%.log'),
      datePattern: 'DD-MM-YYYY',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d',  // Retain up to 90 days
    }),
  ],
});

// Handle logger transport errors gracefully
logger.on('error', (err) => {
  console.error('Logger failed:', err);
});

// Morgan HTTP logging stream
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  },
};

// Morgan middleware pre-configured
logger.morganMiddleware = morgan('combined', { stream: logger.stream });

module.exports = logger;
