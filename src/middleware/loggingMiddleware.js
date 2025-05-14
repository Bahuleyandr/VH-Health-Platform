// src/middleware/loggingMiddleware.js

const logger = require('../logging/logger');

/**
 * Logs basic request details for each incoming request.
 */
const loggingMiddleware = (req, res, next) => {
  const { method, originalUrl } = req;
  const timestamp = new Date().toISOString();
  logger.info(`[${timestamp}] ${method} ${originalUrl}`);
  next();
};

module.exports = loggingMiddleware;
