// src/middleware/errorHandlerMiddleware.js

import * as Sentry from '@sentry/node';
import logger from '../logging/logger.js';

/**
 * Centralized error handling middleware.
 * - Logs the error
 * - Sends formatted JSON response
 * - Reports 5xx errors to Sentry (not 4xx)
 */
export default function errorHandlerMiddleware(err, req, res, next) {
  const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
  const message = err.message || 'Internal Server Error';

  // 🚫 Suppress 4xx errors from being reported to Sentry
  if (statusCode >= 500) {
    Sentry.captureException(err);
  }

  logger.error(`[${new Date().toISOString()}] ${statusCode} - ${message} - ${req.originalUrl} - ${req.method}`);

  res.status(statusCode).json({
    success: false,
    message,
  });
}
