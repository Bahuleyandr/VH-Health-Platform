// src/middleware/rateLimitMiddleware.js

const rateLimit = require('express-rate-limit');

/**
 * Provides a rate-limiting middleware with optional overrides.
 * @param {Object} options - Optional configuration overrides.
 * @returns {Function} Express middleware function.
 */
module.exports = (options = {}) => rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,                // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,   // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false,    // Disable the `X-RateLimit-*` headers
  ...options               // Allow overrides via options
});
