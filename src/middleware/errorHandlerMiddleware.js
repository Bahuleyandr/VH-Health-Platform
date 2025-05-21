// src/middleware/errorHandlerMiddleware.js

import logger from '../logging/logger.js';

/**
 * Centralized error handling middleware.
 * Logs the error and sends a formatted JSON response.
 */
export default function errorHandlerMiddleware(err, req, res, next) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`[${new Date().toISOString()}] ${status} - ${message} - ${req.originalUrl} - ${req.method}`);

  res.status(status).json({
    success: false,
    message: message,
  });
}
