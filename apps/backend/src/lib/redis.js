// src/lib/redis.js — Redis client singleton with standalone + Sentinel discovery
import { randomUUID } from 'node:crypto';
import logger from '../logging/logger.js';

let redis = null;
let redisInitPromise = null;
let isConnected = false;

const DEFAULT_SENTINEL_PORT = 26379;
const DEFAULT_SENTINEL_MASTER = 'vhhealth-primary';

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${name} is required when Redis Sentinel mode is configured`);
  }
  return normalized;
}

export function parseSentinelHosts(value) {
  if (!String(value || '').trim()) return [];

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/);
      if (!match) {
        throw new Error(`Invalid REDIS_SENTINEL_HOSTS entry: ${entry}`);
      }
      const host = (match[1] || match[2] || '').trim();
      const port = Number.parseInt(match[3] || String(DEFAULT_SENTINEL_PORT), 10);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid REDIS_SENTINEL_HOSTS entry: ${entry}`);
      }
      return { host, port };
    });
}

export function isRedisConfigured(env = process.env) {
  return Boolean(String(env.REDIS_URL || '').trim() || String(env.REDIS_SENTINEL_HOSTS || '').trim());
}

export function redisIsRequired(env = process.env) {
  return enabled(env.REDIS_REQUIRE_SENTINEL);
}

/**
 * Resolve the constructor shape without exposing credentials to logs. Sentinel
 * mode deliberately has no REDIS_URL fallback when required: a typo must not
 * silently downgrade production to per-process rate limits and WebSockets.
 */
export function resolveRedisConnection(env = process.env) {
  const url = String(env.REDIS_URL || '').trim();
  const sentinels = parseSentinelHosts(env.REDIS_SENTINEL_HOSTS);
  const sentinelRequired = redisIsRequired(env);

  if (url && sentinels.length > 0) {
    throw new Error('Configure either REDIS_URL or REDIS_SENTINEL_HOSTS, not both');
  }

  if (sentinels.length > 0) {
    const uniqueSentinels = new Set(sentinels.map(({ host, port }) => `${host}:${port}`));
    if (sentinelRequired && uniqueSentinels.size < 3) {
      throw new Error('At least three unique REDIS_SENTINEL_HOSTS are required in strict Sentinel mode');
    }
    const password = required(env.REDIS_PASSWORD, 'REDIS_PASSWORD');
    const sentinelPassword = required(env.REDIS_SENTINEL_PASSWORD, 'REDIS_SENTINEL_PASSWORD');
    const username = required(env.REDIS_USERNAME || 'default', 'REDIS_USERNAME');
    const sentinelUsername = required(
      env.REDIS_SENTINEL_USERNAME || 'default',
      'REDIS_SENTINEL_USERNAME',
    );
    if (sentinelRequired && (username === 'default' || sentinelUsername === 'default')) {
      throw new Error('Strict Sentinel mode requires named least-privilege Redis and Sentinel users');
    }
    return {
      mode: 'sentinel',
      options: {
        sentinels,
        name: required(env.REDIS_SENTINEL_MASTER || DEFAULT_SENTINEL_MASTER, 'REDIS_SENTINEL_MASTER'),
        role: 'master',
        username,
        password,
        sentinelUsername,
        sentinelPassword,
      },
    };
  }

  if (sentinelRequired) {
    throw new Error('REDIS_SENTINEL_HOSTS is required when REDIS_REQUIRE_SENTINEL=true');
  }

  return url ? { mode: 'url', url } : null;
}

function commonOptions() {
  return {
    // ioredis 6 switched the default wire protocol to RESP3 (it sends HELLO 3
    // on connect). We pin RESP2 so that the ioredis 5 -> 6 bump changes no
    // observable behaviour: a dependency upgrade should not also flip the wire
    // protocol the hospital cluster negotiates.
    //
    // This is a conservative choice, NOT a compatibility requirement. The
    // deployed server IS pinned — infra/kubernetes/base/redis/redis-sentinel.yaml
    // runs redis:7.4.1-alpine by sha256 digest — and 7.4 speaks RESP3 fine, so
    // dropping this line is safe whenever someone wants to make that change
    // deliberately and observe it on its own. Nothing here needs RESP3: the only
    // commands issued are get/set/del/scan plus pattern pub/sub, whose reply
    // shapes are identical under both protocols (ioredis 6 also defaults
    // replyMapping to "legacy", so even on RESP3 the shapes would not move).
    protocol: 2,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.info(`Redis reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    sentinelRetryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.info(`Redis Sentinel discovery retry in ${delay}ms (attempt ${times})`);
      return delay;
    },
  };
}

/**
 * Create the Redis client if standalone or Sentinel configuration is present.
 * If neither is configured, all exports remain safe no-op stubs for local use.
 */
async function createClient() {
  const connection = resolveRedisConnection();

  if (!connection) {
    logger.warn('Redis not configured — running without Redis cache');
    return null;
  }

  // Dynamic import so ioredis is only required when Redis is configured.
  const { default: Redis } = await import('ioredis');
  const options = { ...commonOptions(), ...(connection.options || {}) };
  const client = connection.mode === 'sentinel'
    ? new Redis(options)
    : new Redis(connection.url, options);

  client.on('ready', () => {
    isConnected = true;
    logger.info(`Redis ready (${connection.mode})`);
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

  try {
    await client.connect();
    await client.ping();
    isConnected = true;
    return client;
  } catch (err) {
    isConnected = false;
    client.disconnect?.(false);
    throw err;
  }
}

/**
 * Initialise the singleton. Safe to call multiple times — only connects once.
 */
export async function initRedis() {
  if (redis) return redis;

  if (!redisInitPromise) {
    redisInitPromise = createClient()
      .then((client) => {
        redis = client;
        return client;
      })
      .finally(() => {
        redisInitPromise = null;
      });
  }

  return redisInitPromise;
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

/**
 * Prove the discovered primary is writable, not merely reachable. A primary
 * fenced by min-replicas-to-write still answers PING, so strict production
 * readiness uses an expiring, non-PHI write/read probe.
 */
export async function assertRedisWritable() {
  if (!redis) {
    throw new Error('required Redis client is unavailable');
  }

  const key = `vhhealth:health:redis-write-probe:${process.pid}:${randomUUID()}`;
  const value = randomUUID();
  let written = false;

  try {
    const result = await redis.set(key, value, 'PX', 10000, 'NX');
    if (result !== 'OK') {
      throw new Error('Redis readiness write was not accepted');
    }
    written = true;
    if (await redis.get(key) !== value) {
      throw new Error('Redis readiness read did not match its write');
    }
    return true;
  } finally {
    if (written) {
      try {
        await redis.del(key);
      } catch (err) {
        logger.warn('Redis readiness probe cleanup failed; key will expire:', err.message);
      }
    }
  }
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
  assertRedisWritable,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheClear,
  disconnectRedis,
};
