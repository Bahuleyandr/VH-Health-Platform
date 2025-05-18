// src/middleware/rateLimitMiddleware.js

const rateLimit = require('express-rate-limit');

const getRateLimiter = (windowMinutes, maxRequests, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max: maxRequests,
  message: message,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Configurable Generic Limiter
 */
const genericLimiter = getRateLimiter(
  parseInt(process.env.GENERIC_RATE_LIMIT_WINDOW_MINUTES || '1', 10),
  parseInt(process.env.GENERIC_RATE_LIMIT_MAX_REQUESTS || '100', 10),
  'Too many requests, please try again later.'
);

/**
 * Configurable Patient Limiter
 */
const patientRateLimiter = getRateLimiter(
  parseInt(process.env.PATIENT_RATE_LIMIT_WINDOW_MINUTES || '1', 10),
  parseInt(process.env.PATIENT_RATE_LIMIT_MAX_REQUESTS || '10', 10),
  'Too many requests from this IP, please try again later.'
);

/**
 * No Limiter for Staff APIs (Pass-through)
 */
const noRateLimiter = (req, res, next) => next();

module.exports = {
  genericLimiter,
  patientRateLimiter,
  noRateLimiter,
};
