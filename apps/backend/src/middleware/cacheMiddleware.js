// src/middleware/cacheMiddleware.js — Express response caching via Redis
import { cacheGet, cacheSet, cacheClear } from '../lib/redis.js';
import logger from '../logging/logger.js';

/**
 * Build a TENANT-SCOPED cache key. Including the tenant is mandatory: two
 * hospitals hitting the same path+query must never share a cached response
 * (PHI/data bleed). A missing tenant buckets under `default` rather than
 * collapsing into a tenant-blind key.
 *
 * Key format: `keyPrefix:tenantId:METHOD:path:querystring`
 *
 * @param {string} keyPrefix
 * @param {{tenantId?: string, method: string, path: string, query: string}} parts
 * @returns {string}
 */
export function buildCacheKey(keyPrefix, { tenantId, method, path, query }) {
  return `${keyPrefix}:${tenantId || 'default'}:${method}:${path}:${query || ''}`;
}

/**
 * Evict every cached response for one tenant under a key prefix
 * (e.g. on a mutation). No-op when Redis is unavailable.
 *
 * @param {string} keyPrefix
 * @param {string} tenantId
 */
export function clearTenantCache(keyPrefix, tenantId) {
  return cacheClear(`${keyPrefix}:${tenantId || 'default'}:*`);
}

/**
 * Express middleware that caches JSON responses in Redis.
 *
 * @param {number} ttlSeconds  — time-to-live for the cached response
 * @param {string} keyPrefix   — prefix for the cache key (e.g. "appointments")
 * @returns {Function} Express middleware
 *
 * Cache key format: `keyPrefix:tenantId:METHOD:path:querystring` (tenant-scoped).
 *
 * Behaviour:
 *  - Only GET requests are cached.
 *  - Admin users always receive fresh data (cache is skipped).
 *  - Adds `X-Cache: HIT` or `X-Cache: MISS` header.
 *
 * NOTE: dormant by design — not mounted on any route (W3 decision C). The
 * tenant-scoped key closes the data-bleed gap BEFORE it is ever enabled;
 * mounting is a deliberate per-route decision for a later wave.
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
    const cacheKey = buildCacheKey(keyPrefix, {
      tenantId: req.tenantId,
      method: req.method,
      path: req.path,
      query: queryString,
    });

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
