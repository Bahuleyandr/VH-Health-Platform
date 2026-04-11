// src/middleware/cacheControlMiddleware.js
// Sets Cache-Control headers on API responses to reduce redundant fetches.

/**
 * Private cache for patient-specific data (appointments, orders, records).
 * Short TTL: data changes frequently.
 */
export const privateCache = (maxAge = 60) => (_req, res, next) => {
  res.set('Cache-Control', `private, max-age=${maxAge}`);
  next();
};

/**
 * Public cache for reference data (departments, investigation catalog).
 * Longer TTL: data changes infrequently.
 */
export const publicCache = (maxAge = 300) => (_req, res, next) => {
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  next();
};

/**
 * No cache for mutation responses and sensitive data.
 */
export const noCache = (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
};
