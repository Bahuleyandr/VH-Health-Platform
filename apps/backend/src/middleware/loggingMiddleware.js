// src/middleware/loggingMiddleware.js

import logger from '../logging/logger.js';

/**
 * Logs request details with UID (if available), IP, and API path.
 */
export default function loggingMiddleware(req, res, next) {
  const { method, originalUrl } = req;
  const timestamp = new Date().toISOString();

  // Extract UID if present
  const uid = req.user?.uid || 'anonymous';

  // Extract client IP
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  // Log in structured format
  logger.info(`[${timestamp}] ${method} ${originalUrl} | UID: ${uid} | IP: ${ip}`);

  next();
}
