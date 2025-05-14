// src/middleware/errorHandlerMiddleware.js

const logger = require('../utils/logger');

/**
 * Centralized error handling middleware.
 * Logs the error and sends a formatted JSON response.
 */
function errorHandlerMiddleware(err, req, res, next) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`[${new Date().toISOString()}] ${status} - ${message} - ${req.originalUrl} - ${req.method}`);
  
  res.status(status).json({
    success: false,
    message: message,
  });
}

module.exports = errorHandlerMiddleware;
