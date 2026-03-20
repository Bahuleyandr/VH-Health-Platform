// src/logging/logger.js
import fs from 'fs';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format (includes metadata so extra args are not silently dropped)
const logFormat = format.printf(({ timestamp, level, message, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] ${level}: ${message}${metaStr}`;
});

// Create Winston logger instance
const logger = createLogger({
  level: 'debug',
  format: format.combine(format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    // Console logger with color
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      )
    }),

    // File-based logs
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error'
    }),
    new transports.File({
      filename: path.join(logsDir, 'combined.log')
    }),

    // Daily rotated .gz compressed logs
    new DailyRotateFile({
      dirname: logsDir,
      filename: 'vh-health-%DATE%.log',
      datePattern: 'DD-MM-YYYY',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d' // retain logs for 90 days
    })
  ]
});

// Handle logger transport errors gracefully
logger.on('error', err => {
  console.error('Logger failed:', err);
});

// Morgan HTTP logging stream for express middleware
logger.stream = {
  write: message => {
    logger.http(message.trim());
  }
};

// Preconfigured morgan middleware
logger.morganMiddleware = morgan('combined', { stream: logger.stream });

export default logger;