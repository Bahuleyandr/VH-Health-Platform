// src/lib/redis.js — Redis client singleton with standalone + Sentinel discovery
import { randomUUID } from 'node:crypto';
import logger from '../logging/logger.js';

let redis = null;
let redisInitPromise = null;
let isConnected = false;
let initEverFailed = false;
let reinitTimer = null;

const DEFAULT_SENTINEL_PORT = 26379;
const DEFAULT_SENTINEL_MASTER = 'vhhealth-primary';

// Boot-time initialization deadline. Without one, initRedis() can hang FOREVER
// under the production config shape: with all Sentinels unreachable, ioredis's
// SentinelConnector exhausts the sentinel list, then sentinelRetryStrategy
// (which always returns a delay) restarts discovery "from scratch" indefinitely
// — connect() never rejects, so www.js's strict-mode fail-fast never fires and
// the pod neither becomes ready nor crash-loops into visibility. Measured
// 2026-08-15 (redis-loss drill follow-up): sentinel-all-closed still pending at
// 30s+ (17 discovery passes); a blackholed socket (TCP accepts, no bytes) also
// never settles in EITHER mode because the ready-check INFO is never answered
// and connectTimeout only bounds the TCP dial. Standalone against a CLOSED port
// is the one shape that already settled fast (~5ms).
const DEFAULT_INIT_TIMEOUT_MS = 15000;

// Per-command timeout. Without one, a command on a connection whose peer
// stopped responding (blackholed socket) waits UNBOUNDED (measured 30s+ and
// still pending), and a command queued while ioredis reconnects during a
// sustained outage waits for maxRetriesPerRequest reconnect attempts at the
// matured 5s backoff cap (measured 15,239ms). With commandTimeout=2000 both
// shapes fail in ~2s (measured 2,004ms / 2,008ms). Callers that already treat
// Redis as a best-effort cache (cacheGet/cacheSet, token-blacklist positive
// cache, rate-limit store) turn a multi-second stall into a fast fallback.
const DEFAULT_COMMAND_TIMEOUT_MS = 2000;

// Cadence of background reconnect attempts after a degraded (non-strict) start.
const REINIT_INTERVAL_MS = 30000;

function positiveIntFromEnv(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function redisInitTimeoutMs() {
  return positiveIntFromEnv('REDIS_INIT_TIMEOUT_MS', DEFAULT_INIT_TIMEOUT_MS);
}

export function redisCommandTimeoutMs() {
  return positiveIntFromEnv('REDIS_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS);
}

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
    // runs redis:7.4.10-alpine by sha256 digest — and 7.4 speaks RESP3 fine, so
    // dropping this line is safe whenever someone wants to make that change
    // deliberately and observe it on its own. Nothing here needs RESP3: the only
    // commands issued are get/set/del/scan plus pattern pub/sub, whose reply
    // shapes are identical under both protocols (ioredis 6 also defaults
    // replyMapping to "legacy", so even on RESP3 the shapes would not move).
    protocol: 2,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    // Bounds EVERY command — including one sitting in the offline queue while
    // ioredis reconnects, and one sent on a blackholed-but-established socket.
    // See DEFAULT_COMMAND_TIMEOUT_MS above for the measured shapes this fixes.
    commandTimeout: redisCommandTimeoutMs(),
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

  // Initialization must SETTLE in bounded time in every configuration.
  // retryStrategy/sentinelRetryStrategy stay infinite on purpose — that is what
  // makes MID-FLIGHT loss self-heal (the drill proved reconnection works) — so
  // the bound has to be an overall deadline on the initial connect+ping, not a
  // retry cap. On deadline we hard-disconnect the never-ready client so its
  // discovery/reconnect loop stops, and throw: www.js then either fail-fasts
  // (strict Sentinel mode → exit(1), pod restarts visibly) or continues
  // degraded (non-strict → scheduleRedisReinit keeps trying off-request-path).
  const timeoutMs = redisInitTimeoutMs();
  let deadlineTimer = null;
  const deadline = new Promise((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      const err = new Error(
        `Redis initialization did not complete within ${timeoutMs}ms (${connection.mode}) — endpoints unreachable or unresponsive`,
      );
      err.code = 'REDIS_INIT_TIMEOUT';
      reject(err);
    }, timeoutMs);
    deadlineTimer.unref?.();
  });

  try {
    const attempt = (async () => {
      await client.connect();
      await client.ping();
    })();
    // If the deadline wins the race, the losing attempt may still reject later
    // (e.g. "Connection is closed." after our disconnect). Mark it handled so
    // it cannot surface as an unhandledRejection and tear the process down.
    attempt.catch(() => {});
    await Promise.race([attempt, deadline]);
    isConnected = true;
    return client;
  } catch (err) {
    isConnected = false;
    client.disconnect?.(false);
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
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
        initEverFailed = false;
        return client;
      })
      .catch((err) => {
        initEverFailed = true;
        throw err;
      })
      .finally(() => {
        redisInitPromise = null;
      });
  }

  return redisInitPromise;
}

/**
 * Whether initialization has been attempted and failed without a later
 * success. Consumers that would otherwise lazily re-init on the REQUEST path
 * (the rate-limit store) use this to short-circuit instead of paying a
 * bounded-but-slow connect attempt per request; recovery is owned by
 * scheduleRedisReinit() off the request path.
 */
export function hasRedisInitFailed() {
  return initEverFailed;
}

/**
 * Background reconnect loop for a degraded (non-strict) start: Redis was
 * configured but unreachable at boot, and nothing else ever calls initRedis()
 * again. Keeps trying on a fixed cadence — each attempt bounded by the init
 * deadline — until Redis returns, then stops. The timer is unref'd so it never
 * holds the process open. Idempotent; a no-op when Redis is already up.
 *
 * This restores the shared cache, token-blacklist fast path, and the
 * rate-limit store through the singleton automatically. Consumers whose
 * wiring is boot-time-only (the WebSocket fan-out subscriber — a dedicated
 * duplicate connection, 873-F10) pass `onReconnect` so they are re-wired on
 * the SAME recovery instead of staying degraded until a pod restart. The
 * hook also fires when another path (e.g. the rate-limit store's lazy
 * initRedis on the request path) restored the singleton first — the timer's
 * job is "run the recovery wiring once Redis is back", however it came back.
 */
export function scheduleRedisReinit({ intervalMs = REINIT_INTERVAL_MS, onReconnect = null } = {}) {
  if (reinitTimer || redis) return false;
  logger.warn(`Redis unavailable — retrying connection in the background every ${intervalMs}ms`);
  reinitTimer = setInterval(async () => {
    try {
      const client = redis ?? await initRedis();
      clearInterval(reinitTimer);
      reinitTimer = null;
      if (!client) return; // not configured — nothing to restore
      logger.info('Redis background reconnect succeeded — shared cache and rate-limit store restored');
      if (onReconnect) {
        try {
          await onReconnect(client);
        } catch (err) {
          logger.error('Redis reinit onReconnect hook failed:', err.message);
        }
      }
    } catch (err) {
      logger.warn('Redis background reconnect attempt failed:', err.message);
    }
  }, intervalMs);
  reinitTimer.unref?.();
  return true;
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
  if (reinitTimer) {
    clearInterval(reinitTimer);
    reinitTimer = null;
  }
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
  hasRedisInitFailed,
  scheduleRedisReinit,
  assertRedisWritable,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheClear,
  disconnectRedis,
};
