// src/lib/redis.js — Redis client singleton with no-op fallback
import logger from '../logging/logger.js';

let redis = null;
let isConnected = false;

/**
 * Create the Redis client if REDIS_URL is configured.
 * If not configured, all exports are safe no-op stubs so the app runs without Redis.
 */
async function createClient() {
  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn('REDIS_URL not set — running without Redis cache');
    return null;
  }

  // Dynamic import so ioredis is only required when REDIS_URL is present
  const { default: Redis } = await import('ioredis');

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.info(`Redis reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    lazyConnect: false,
  });

  client.on('connect', () => {
    isConnected = true;
    logger.info('Redis connected');
  });

  client.on('error', (err) => {
    logger.error('Redis error:', err.message);
  });

  client.on('reconnecting', () => {
    isConnected = false;
    logger.info('Redis reconnecting...');
  });

  client.on('close', () => {
    isConnected = false;
    logger.info('Redis connection closed');
  });

  return client;
}

/**
 * Initialise the singleton. Safe to call multiple times — only connects once.
 */
export async function initRedis() {
  if (!redis) {
    redis = await createClient();
  }
  return redis;
}

/**
 * Return the current client (may be null if Redis is not configured).
 */
export function getRedisClient() {
  return redis;
}

/**
 * Whether we currently have a live Redis connection.
 */
export function isRedisConnected() {
  return isConnected;
}

// ---------------------------------------------------------------------------
// Cache helpers — safe to call even when Redis is not configured
// ---------------------------------------------------------------------------

/**
 * Get a cached value by key. Returns parsed JSON or null.
 */
export async function cacheGet(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.error('cacheGet error:', { key, error: err.message });
    return null;
  }
}

/**
 * Set a cached value with an optional TTL (seconds).
 */
export async function cacheSet(key, value, ttlSeconds) {
  if (!redis) return false;
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await redis.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await redis.set(key, serialized);
    }
    return true;
  } catch (err) {
    logger.error('cacheSet error:', { key, error: err.message });
    return false;
  }
}

/**
 * Delete a single cache key.
 */
export async function cacheDelete(key) {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.error('cacheDelete error:', { key, error: err.message });
  }
}

/**
 * Delete all keys matching a glob pattern (e.g. "appointments:*").
 * Uses SCAN to avoid blocking the server.
 */
export async function cacheClear(pattern) {
  if (!redis) return;
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error('cacheClear error:', { pattern, error: err.message });
  }
}

/**
 * Gracefully disconnect from Redis.
 */
export async function disconnectRedis() {
  if (redis) {
    try {
      await redis.quit();
      redis = null;
      isConnected = false;
      logger.info('Redis disconnected gracefully');
    } catch (err) {
      logger.error('Error disconnecting Redis:', err.message);
    }
  }
}

// Graceful disconnect on process exit signals
process.on('beforeExit', () => {
  disconnectRedis();
});

export default {
  initRedis,
  getRedisClient,
  isRedisConnected,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheClear,
  disconnectRedis,
};
