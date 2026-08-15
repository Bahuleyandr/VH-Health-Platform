// src/middleware/cacheControlMiddleware.js
// Sets Cache-Control headers on API responses to reduce redundant fetches.

/**
 * Public cache for reference data (departments, investigation catalog).
 * Longer TTL: data changes infrequently.
 */
export const publicCache = (maxAge = 300) => (_req, res, next) => {
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  next();
};
