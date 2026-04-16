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

const isTest = process.env.NODE_ENV === 'test';
const isProduction = process.env.NODE_ENV === 'production';

// Structured (JSON) output for production log aggregators (CloudWatch/Loki/
// Datadog). Opt-in via LOG_FORMAT=json or enabled by default in production so
// operators can scrape `kpi.*` / `request.*` events without regex-parsing
// plain text. Dev keeps the human-readable printf format.
const useJson = process.env.LOG_FORMAT === 'json' || (isProduction && process.env.LOG_FORMAT !== 'text');
const fileFormat = useJson
  ? format.combine(format.timestamp(), format.errors({ stack: true }), format.json())
  : format.combine(format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat);

// Create Winston logger instance
const logger = createLogger({
  level: isTest ? 'error' : 'debug',
  silent: isTest,
  format: format.combine(format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    // Console logger with color
    new transports.Console({
      silent: isTest,
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      )
    }),

    // File-based logs — structured JSON in production for log aggregators
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      silent: isTest
    }),
    new transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      silent: isTest
    }),

    // Daily rotated .gz compressed logs
    new DailyRotateFile({
      dirname: logsDir,
      filename: 'vh-health-%DATE%.log',
      datePattern: 'DD-MM-YYYY',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d', // retain logs for 90 days
      format: fileFormat,
      silent: isTest
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