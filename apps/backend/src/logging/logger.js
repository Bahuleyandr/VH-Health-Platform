// src/logging/logger.js
import fs from 'fs';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import phiRedactionFormat from './phiRedactionFormat.js';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format (includes metadata so extra args are not silently dropped).
// Inline Error instances explicitly so stack/message survive — JSON.stringify
// drops both on plain Error objects, which is how `logger.error('foo', err)`
// silently swallowed the underlying Postgres exception in the smoke pipeline.
const logFormat = format.printf(({ timestamp, level, message, stack, ...meta }) => {
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v instanceof Error) {
      meta[k] = { message: v.message, code: v.code, stack: v.stack };
    }
  }
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const stackStr = stack ? `\n${stack}` : '';
  return `[${timestamp}] ${level}: ${message}${metaStr}${stackStr}`;
});

const isTest = process.env.NODE_ENV === 'test';
const isProduction = process.env.NODE_ENV === 'production';

// In test mode, still surface ERROR-level logs to the console — Jest unit
// tests stay quiet (almost nothing logs at error level under happy paths)
// but the smoke E2E pipeline can see backend exceptions instead of getting a
// generic "Failed to fetch ..." with no stack. File transports stay silent
// to keep the logs/ dir clean across test runs.
const consoleSilent = false;
const fileTransportsSilent = isTest;

// Structured (JSON) output for production log aggregators (CloudWatch/Loki/
// Datadog). Opt-in via LOG_FORMAT=json or enabled by default in production so
// operators can scrape `kpi.*` / `request.*` events without regex-parsing
// plain text. Dev keeps the human-readable printf format.
const useJson = process.env.LOG_FORMAT === 'json' || (isProduction && process.env.LOG_FORMAT !== 'text');
const fileFormat = useJson
  ? format.combine(phiRedactionFormat(), format.timestamp(), format.errors({ stack: true }), format.json())
  : format.combine(phiRedactionFormat(), format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat);

// Create Winston logger instance.
// phiRedactionFormat (audit finding H5) scrubs phone/email/MRN patterns from
// every record on EVERY transport as a global backstop — call sites must
// still mask identifiers explicitly via utils/logMasking.js.
const logger = createLogger({
  level: isTest ? 'error' : 'debug',
  format: format.combine(phiRedactionFormat(), format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    // Console logger with color. In test, the parent logger's `level: 'error'`
    // already filters out info/debug noise, so we keep this transport on.
    new transports.Console({
      silent: consoleSilent,
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
      silent: fileTransportsSilent
    }),
    new transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      silent: fileTransportsSilent
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
      silent: fileTransportsSilent
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