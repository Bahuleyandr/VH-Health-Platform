// src/middleware/auditLogger.js
import logger from '../logging/logger.js';
import { redactSensitiveQueryParams } from '../utils/urlRedaction.js';

export function auditLogger(req, res, next) {
  const uid = req.user?.uid || 'UNKNOWN';
  const role = req.user?.role || 'ANONYMOUS';
  const ip = req.ip || req.connection?.remoteAddress;

  // Scrub secret-bearing query params (e.g. ?idToken=...) before logging.
  const safeUrl = redactSensitiveQueryParams(req.originalUrl);

  logger.info(`[AUDIT] ${req.method} ${safeUrl} | UID: ${uid} | Role: ${role} | IP: ${ip}`);
  next();
}
