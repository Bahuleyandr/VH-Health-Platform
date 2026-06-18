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

const isTest = process.env.NODE_ENV === 'test';
const isProduction = process.env.NODE_ENV === 'production';

// Where rotated file logs live. In production the container runs with
// readOnlyRootFilesystem:true (only /tmp, /app/tmp, /app/node_modules/.prisma
// are writable — see infra/kubernetes), so the default `../logs` under the app
// root is NOT writable and mkdirSync there throws EROFS at import → boot crash
// (audit C-8). Prod also logs structured JSON to stdout already, so file
// transports are silenced there (see fileTransportsSilent below) and this dir
// is only a fallback target. Override with LOG_DIR if a writable log volume is
// mounted. Default to a writable tmp path in production.
const logsDir = process.env.LOG_DIR
  || (isProduction ? path.join('/app', 'tmp', 'logs') : path.join(__dirname, '../logs'));

// File transports are silent in test (keep logs/ clean) AND in production
// (stdout/json is the prod log path; the FS is read-only). So we only ever
// create the dir / write files in dev. Guard mkdirSync so a read-only or
// permission-denied FS can never throw at module load — fall back to silent
// file transports instead of crashing the process.
let fileTransportsSilent = isTest || isProduction;

if (!fileTransportsSilent) {
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  } catch (err) {
    // Read-only FS / EACCES — degrade to stdout-only rather than crash at import.
    // console.error (not the winston logger — it isn't constructed yet here).
    fileTransportsSilent = true;
    console.error(`Logger: log directory not writable (${logsDir}); file transports disabled: ${err.message}`);
  }
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

// In test mode, still surface ERROR-level logs to the console — Jest unit
// tests stay quiet (almost nothing logs at error level under happy paths)
// but the smoke E2E pipeline can see backend exceptions instead of getting a
// generic "Failed to fetch ..." with no stack. File transports stay silent
// to keep the logs/ dir clean across test runs (and in prod — see
// fileTransportsSilent above, set near logsDir).
const consoleSilent = false;

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