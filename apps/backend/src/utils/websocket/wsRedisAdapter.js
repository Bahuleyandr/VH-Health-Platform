// src/utils/websocket/wsRedisAdapter.js
//
// Cross-process WebSocket fan-out via Redis pub/sub.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// wsServer.broadcast()/sendToUser() only ever held the sockets connected to the
// *emitting* process. In production we run replicas:N pods × CLUSTER_WORKERS:M
// node workers behind sessionAffinity:None, so a broadcast issued in one process
// reached ~1-of-(N*M) of the connected sessions. Code-blue / vitals alerts
// silently failed to fan out to most clinicians. This adapter makes a broadcast
// in ANY process reach EVERY process's local sockets.
//
// HOW IT WORKS
// ------------
//   broadcast(ch, data)      → PUBLISH ws:broadcast:<ch>  {tenantId, event, data}
//   sendToUser(uid, ev, data)→ PUBLISH ws:user:<uid>      {tenantId, event, data}
// Every process runs ONE pattern SUBSCRIBE consumer (a dedicated
// redis.duplicate() connection, because a connection in subscriber mode can't
// issue normal commands). On a message, the consumer runs the EXISTING in-memory
// delivery loop (still applying the 1MB bufferedAmount backpressure guard). So
// the trigger moves from a direct in-process call to a Redis message, but the
// actual socket.send() logic is unchanged.
//
// TENANT ISOLATION
// ----------------
// The global staff:/admin: channels are shared across tenants. Before this
// adapter, a broadcast had NO per-message tenant filter, so a tenant-A bed event
// would reach a tenant-B staff socket subscribed to the same global channel — a
// latent cross-tenant realtime PHI leak. Every published envelope now carries
// `tenantId`, and the local delivery loop only sends to a socket whose tenant
// matches. Each socket's tenant is taken from its ws ticket / verifyToken claim
// at connect time.
//
// GRACEFUL DEGRADATION
// --------------------
// If Redis is not configured or is unreachable, the fan-out is "disabled" and
// the publish() helpers return false; the caller (wsServer) then runs the local
// delivery loop directly — degraded to single-process delivery, never a crash.
// This mirrors how the token blacklist degrades to its DB fallback. The SUBSCRIBE
// consumer auto-reconnects (ioredis reconnects the duplicated connection; we
// re-issue the pattern subscription on every 'ready').
//
// ★ HONEST LIMITATION — AT-MOST-ONCE
// ----------------------------------
// Redis pub/sub is fire-and-forget. A message published while this process's
// subscriber is mid-reconnect (e.g. during a Sentinel failover) is SILENTLY
// DROPPED — there is no buffering or replay. The per-socket bufferedAmount guard
// also can't see slow consumers *across* the bus. So this adapter does NOT
// guarantee delivery of code-blue / vitals alerts; it closes the cross-process
// SPLIT (most sessions getting nothing) but not the failover DROP. The
// differential-delivery harness in realtime-flow.test.js is the instrument that
// would later detect a real bus-level drop; if that ever fires in practice, it
// is the empirical trigger for a durable realtime path (the shelved BEAM plan).
// Do not represent this as guaranteed delivery.

import logger from '../../logging/logger.js';
import { recordWsFanoutSubscriberError } from '../../observability/reliabilityMetrics.js';

const BROADCAST_PREFIX = 'ws:broadcast:';
const USER_PREFIX = 'ws:user:';
// One pattern subscription covers every channel + user fan-out key, so adding a
// new channel needs no SUBSCRIBE change.
const PATTERN = 'ws:*';

/**
 * Create an isolated fan-out instance. Production uses ONE per process (the
 * module-level singleton in wsServer.js). The differential-delivery harness
 * creates two — one per simulated process — sharing a single in-memory bus, so
 * cross-instance pub/sub is genuinely exercised without a real Redis.
 */
export function createWsFanout() {
  let pub = null;
  let sub = null;
  let enabled = false;
  let subscriptionReady = false;
  let subscriptionReadyPromise = Promise.resolve(false);
  let subscriptionGeneration = 0;

  // The local in-process delivery loops, registered by wsServer.
  //   deliverBroadcast(channel, event, data, tenantId)
  //   deliverUser(userId, event, data, tenantId)
  let deliverBroadcast = null;
  let deliverUser = null;
  let onMessageHandler = null;

  function registerLocalDelivery({ deliverBroadcast: db, deliverUser: du }) {
    deliverBroadcast = db;
    deliverUser = du;
  }

  function handleMessage(rawChannel, raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return; // ignore malformed bus traffic
    }
    const { event, data, tenantId } = envelope;
    if (typeof rawChannel !== 'string') return;

    if (rawChannel.startsWith(BROADCAST_PREFIX)) {
      const channel = rawChannel.slice(BROADCAST_PREFIX.length);
      if (deliverBroadcast) deliverBroadcast(channel, event ?? channel, data, tenantId);
    } else if (rawChannel.startsWith(USER_PREFIX)) {
      const userId = rawChannel.slice(USER_PREFIX.length);
      if (deliverUser) deliverUser(userId, event, data, tenantId);
    }
  }

  /**
   * Wire to a Redis pub/sub bus.
   * @param {object} opts
   * @param {object} opts.pub  - a client able to PUBLISH (ioredis singleton)
   * @param {object} [opts.sub] - dedicated subscriber; defaults to pub.duplicate()
   */
  function init({ pub: pubClient, sub: subClient } = {}) {
    if (!pubClient) {
      enabled = false;
      logger.warn('WS Redis fan-out disabled — no Redis client; broadcasts are single-process only');
      return false;
    }
    pub = pubClient;
    sub = subClient || (typeof pubClient.duplicate === 'function' ? pubClient.duplicate() : null);
    if (!sub) {
      enabled = false;
      logger.warn('WS Redis fan-out disabled — subscriber connection unavailable');
      return false;
    }

    onMessageHandler = (pattern, channel, message) => {
      // ioredis emits ('pmessage', pattern, channel, message). A 3-arg fake bus
      // may emit (channel, message); guard both arities.
      if (message === undefined) {
        handleMessage(pattern, channel); // (channel, message) fallback
      } else {
        handleMessage(channel, message);
      }
    };

    const activeSub = sub;
    const doSubscribe = () => {
      const generation = ++subscriptionGeneration;
      subscriptionReady = false;
      try {
        const r = activeSub.psubscribe(PATTERN);
        return Promise.resolve(r)
          .then(() => {
            if (generation !== subscriptionGeneration || sub !== activeSub || !enabled) {
              return false;
            }
            subscriptionReady = true;
            return true;
          })
          .catch((err) => {
            if (generation === subscriptionGeneration && sub === activeSub) {
              subscriptionReady = false;
              logger.error('WS fan-out psubscribe failed:', err?.message || err);
            }
            return false;
          });
      } catch (err) {
        if (generation === subscriptionGeneration && sub === activeSub) {
          subscriptionReady = false;
          logger.error('WS fan-out psubscribe threw:', err?.message || err);
        }
        return Promise.resolve(false);
      }
    };

    activeSub.on?.('pmessage', onMessageHandler);
    // Re-assert the pattern subscription after any reconnect (Sentinel failover,
    // transient drop). ioredis emits 'ready' on (re)connect.
    activeSub.on?.('ready', () => {
      if (sub !== activeSub) return;
      subscriptionReadyPromise = doSubscribe();
    });
    const markSubscriptionUnavailable = () => {
      if (sub !== activeSub) return;
      subscriptionGeneration += 1;
      subscriptionReady = false;
      subscriptionReadyPromise = Promise.resolve(false);
    };
    activeSub.on?.('close', markSubscriptionUnavailable);
    activeSub.on?.('reconnecting', markSubscriptionUnavailable);
    activeSub.on?.('error', (err) => {
      markSubscriptionUnavailable();
      recordWsFanoutSubscriberError();
      logger.error('WS fan-out subscriber error:', err?.message || err);
    });

    enabled = true;
    subscriptionReadyPromise = doSubscribe();
    logger.info('🔁 WS Redis fan-out enabled (cross-process broadcast via pub/sub)');
    return true;
  }

  function isEnabled() {
    return enabled && !!pub;
  }

  function publishBroadcast(channel, event, data, tenantId) {
    if (!enabled || !pub) return false;
    try {
      const pending = pub.publish(
        BROADCAST_PREFIX + channel,
        JSON.stringify({ event, data, tenantId }),
      );
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          logger.error('WS fan-out publishBroadcast failed after dispatch:', err?.message || err);
        });
      }
      return true;
    } catch (err) {
      logger.error('WS fan-out publishBroadcast failed — falling back to local:', err?.message || err);
      return false;
    }
  }

  async function publishBroadcastConfirmed(channel, event, data, tenantId) {
    if (!enabled || !pub) return false;
    try {
      if (!subscriptionReady && !await subscriptionReadyPromise) {
        const err = new Error('WebSocket fan-out subscription is not ready');
        err.code = 'WS_FANOUT_SUBSCRIPTION_NOT_READY';
        throw err;
      }
      const subscribers = await pub.publish(
        BROADCAST_PREFIX + channel,
        JSON.stringify({ event, data, tenantId }),
      );
      if (!Number.isInteger(subscribers) || subscribers < 1) {
        const err = new Error('WebSocket fleet broadcast had no subscribers');
        err.code = 'WS_FANOUT_NO_SUBSCRIBERS';
        throw err;
      }
      return true;
    } catch (err) {
      logger.error('WS fan-out confirmed broadcast failed:', err?.message || err);
      throw err;
    }
  }

  function publishUser(userId, event, data, tenantId) {
    if (!enabled || !pub) return false;
    try {
      const pending = pub.publish(USER_PREFIX + String(userId), JSON.stringify({ event, data, tenantId }));
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          logger.error('WS fan-out publishUser failed after dispatch:', err?.message || err);
        });
      }
      return true;
    } catch (err) {
      logger.error('WS fan-out publishUser failed — falling back to local:', err?.message || err);
      return false;
    }
  }

  /**
   * Tear down: unsubscribe + drop the dedicated subscriber. Does NOT close `pub`
   * (the shared singleton owned by lib/redis.js) nor an injected shared bus
   * (owned by the test).
   */
  async function close() {
    enabled = false;
    subscriptionGeneration += 1;
    subscriptionReady = false;
    subscriptionReadyPromise = Promise.resolve(false);
    if (sub) {
      try {
        if (onMessageHandler) sub.off?.('pmessage', onMessageHandler);
        if (typeof sub.punsubscribe === 'function') await sub.punsubscribe(PATTERN);
        if (typeof sub.quit === 'function' && sub !== pub) await sub.quit();
      } catch (err) {
        logger.warn('WS fan-out subscriber teardown error:', err?.message || err);
      }
    }
    sub = null;
    pub = null;
    onMessageHandler = null;
    deliverBroadcast = null;
    deliverUser = null;
  }

  return {
    init,
    registerLocalDelivery,
    publishBroadcast,
    publishBroadcastConfirmed,
    publishUser,
    isEnabled,
    close,
  };
}
