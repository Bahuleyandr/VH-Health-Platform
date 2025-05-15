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

    // File transport for error level
    new transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),

    // File transport for all logs
    new transports.File({ filename: path.join(logsDir, 'combined.log') }),

    // Daily Rotate File for rolling logs
    new DailyRotateFile({
      filename: path.join(logsDir, 'application-%DATE%.log'),
      datePattern: 'DD-MM-YYYY',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
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

// Optional: Provide morgan middleware pre-configured to use the logger
logger.morganMiddleware = morgan('combined', { stream: logger.stream });

module.exports = logger;
