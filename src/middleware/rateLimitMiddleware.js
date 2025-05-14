// src/middleware/rateLimitMiddleware.js

const rateLimit = require('express-rate-limit');

/**
 * Configurable rate limiting middleware.
 * Defaults to 100 requests per minute, stricter in production.
 */
const rateLimitMiddleware = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1 minute default
  max: parseInt(process.env.RATE_LIMIT_MAX || (process.env.NODE_ENV === 'production' ? '50' : '100')),
  message: 'Too many requests from this IP, please try again later.',
});

module.exports = rateLimitMiddleware;
