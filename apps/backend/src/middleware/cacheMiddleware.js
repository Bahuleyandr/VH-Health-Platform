// src/middleware/cacheMiddleware.js — Express response caching via Redis
import { cacheGet, cacheSet } from '../lib/redis.js';
import logger from '../logging/logger.js';

/**
 * Express middleware that caches JSON responses in Redis.
 *
 * @param {number} ttlSeconds  — time-to-live for the cached response
 * @param {string} keyPrefix   — prefix for the cache key (e.g. "appointments")
 * @returns {Function} Express middleware
 *
 * Cache key format: `keyPrefix:METHOD:path:querystring`
 *
 * Behaviour:
 *  - Only GET requests are cached.
 *  - Admin users always receive fresh data (cache is skipped).
 *  - Adds `X-Cache: HIT` or `X-Cache: MISS` header.
 */
export function cacheResponse(ttlSeconds, keyPrefix) {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Skip caching for admin users — they always see fresh data
    if (req.user && req.user.role === 'ADMIN') {
      return next();
    }

    const queryString = req.originalUrl.includes('?')
      ? req.originalUrl.split('?')[1]
      : '';
    const cacheKey = `${keyPrefix}:${req.method}:${req.path}:${queryString}`;

    try {
      const cached = await cacheGet(cacheKey);
      if (cached !== null) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
    } catch (err) {
      // Cache read failed — continue to handler, just log
      logger.error('Cache middleware read error:', { key: cacheKey, error: err.message });
    }

    // Cache miss — monkey-patch res.json to intercept the response
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      // Only cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cacheSet(cacheKey, body, ttlSeconds).catch((err) => {
          logger.error('Cache middleware write error:', { key: cacheKey, error: err.message });
        });
      }

      res.set('X-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
}

export default cacheResponse;
