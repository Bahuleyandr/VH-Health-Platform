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
export function createWsFanout({ teardownTimeoutMs = 250 } = {}) {
  const teardownDeadlineMs = Number.isFinite(Number(teardownTimeoutMs))
    ? Math.max(1, Number(teardownTimeoutMs))
    : 250;
  let pub = null;
  let sub = null;
  let enabled = false;
  let subscribed = false;
  let initialized = false;
  let initializationPromise = null;
  let closePromise = null;
  let subscriptionPromise = null;
  let subscriptionGeneration = 0;
  let lifecycleGeneration = 0;
  let subscriberEventHandlers = null;
  let subOwned = false;

  // The local in-process delivery loops, registered by wsServer.
  //   deliverBroadcast(channel, event, data, tenantId)
  //   deliverUser(userId, event, data, tenantId)
  let deliverBroadcast = null;
  let deliverUser = null;

  function staleGenerationError() {
    const err = new Error('WebSocket fan-out lifecycle generation is stale');
    err.code = 'WS_FANOUT_GENERATION_STALE';
    return err;
  }

  function detachSubscriberHandlers(targetSub, handlers) {
    if (!targetSub || handlers?.sub !== targetSub) return;
    targetSub.off?.('pmessage', handlers.messageHandler);
    targetSub.off?.('ready', handlers.readyHandler);
    targetSub.off?.('close', handlers.closeHandler);
    targetSub.off?.('reconnecting', handlers.reconnectingHandler);
    targetSub.off?.('error', handlers.errorHandler);
  }

  async function teardownSubscriber(targetSub, handlers, owned, { disconnect = false } = {}) {
    detachSubscriberHandlers(targetSub, handlers);
    if (!targetSub || !owned) return;

    if (disconnect && typeof targetSub.disconnect === 'function') {
      try {
        targetSub.disconnect(false);
      } catch (err) {
        logger.warn('WS fan-out subscriber disconnect error:', err?.message || err);
      }
      return;
    }

    const operations = [];
    if (typeof targetSub.punsubscribe === 'function') {
      try {
        operations.push(Promise.resolve(targetSub.punsubscribe(PATTERN)).catch((err) => {
          logger.warn('WS fan-out subscriber unsubscribe error:', err?.message || err);
        }));
      } catch (err) {
        logger.warn('WS fan-out subscriber unsubscribe error:', err?.message || err);
      }
    }
    if (typeof targetSub.quit === 'function') {
      try {
        operations.push(Promise.resolve(targetSub.quit()).catch((err) => {
          logger.warn('WS fan-out subscriber close error:', err?.message || err);
        }));
      } catch (err) {
        logger.warn('WS fan-out subscriber close error:', err?.message || err);
      }
    } else if (typeof targetSub.disconnect === 'function') {
      try {
        targetSub.disconnect(false);
      } catch (err) {
        logger.warn('WS fan-out subscriber disconnect error:', err?.message || err);
      }
      return;
    }
    if (operations.length === 0) return;

    let deadline;
    const timedOut = await Promise.race([
      Promise.all(operations).then(() => false),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve(true), teardownDeadlineMs);
        deadline.unref?.();
      }),
    ]);
    clearTimeout(deadline);
    if (timedOut) {
      logger.warn(`WS fan-out subscriber teardown exceeded ${teardownDeadlineMs}ms; disconnecting`);
      try {
        targetSub.disconnect?.(false);
      } catch (err) {
        logger.warn('WS fan-out subscriber disconnect error:', err?.message || err);
      }
    }
  }

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
  async function initialize({ pub: pubClient, sub: subClient } = {}) {
    if (!pubClient) {
      enabled = false;
      logger.warn('WS Redis fan-out disabled — no Redis client; broadcasts are single-process only');
      return false;
    }

    const initializationLifecycleGeneration = lifecycleGeneration;
    const previousSub = sub;
    const previousHandlers = subscriberEventHandlers;
    const previousSubOwned = subOwned;
    const replacementGeneration = ++subscriptionGeneration;
    subscriptionPromise = null;
    subscribed = false;
    enabled = false;
    initialized = false;
    sub = null;
    subOwned = false;
    subscriberEventHandlers = null;

    // Detach synchronously before awaiting Redis shutdown. Even if EventEmitter
    // already snapshotted an old callback, its generation/identity guard below
    // keeps it inert while the owned connection is being closed.
    if (previousSub) {
      await teardownSubscriber(previousSub, previousHandlers, previousSubOwned);
    }
    if (initializationLifecycleGeneration !== lifecycleGeneration) throw staleGenerationError();
    if (replacementGeneration !== subscriptionGeneration) return false;

    pub = pubClient;
    const ownsSub = !subClient;
    sub = subClient || (typeof pubClient.duplicate === 'function' ? pubClient.duplicate() : null);
    if (!sub) {
      enabled = false;
      logger.warn('WS Redis fan-out disabled — subscriber connection unavailable');
      return false;
    }

    subOwned = ownsSub;
    const activeSub = sub;
    const messageHandler = (pattern, channel, message) => {
      if (
        sub !== activeSub
        || subscriberEventHandlers?.sub !== activeSub
        || subscriberEventHandlers.messageHandler !== messageHandler
      ) {
        return;
      }
      // ioredis emits ('pmessage', pattern, channel, message). A 3-arg fake bus
      // may emit (channel, message); guard both arities.
      if (message === undefined) {
        handleMessage(pattern, channel); // (channel, message) fallback
      } else {
        handleMessage(channel, message);
      }
    };
    const markSubscriberUnavailable = (reason, err) => {
      if (sub !== activeSub) return;
      subscriptionGeneration += 1;
      subscriptionPromise = null;
      subscribed = false;
      enabled = false;
      if (err) {
        recordWsFanoutSubscriberError();
        logger.error(reason, err?.message || err);
      }
    };

    const subscribe = ({ failInitialization = false } = {}) => {
      if (subscriptionPromise) return subscriptionPromise;
      const generation = ++subscriptionGeneration;
      subscribed = false;
      enabled = false;
      subscriptionPromise = (async () => {
        try {
          const count = await activeSub.psubscribe(PATTERN);
          if (initializationLifecycleGeneration !== lifecycleGeneration) {
            throw staleGenerationError();
          }
          if (generation !== subscriptionGeneration || sub !== activeSub) {
            return false;
          }
          if (typeof count === 'number' && count < 1) {
            throw new Error('Redis acknowledged zero WebSocket subscriptions');
          }
          subscribed = true;
          enabled = true;
          return true;
        } catch (err) {
          if (generation === subscriptionGeneration && sub === activeSub) {
            markSubscriberUnavailable('WS fan-out psubscribe failed:', err);
          }
          if (failInitialization) throw err;
          return false;
        } finally {
          if (generation === subscriptionGeneration) {
            subscriptionPromise = null;
          }
        }
      })();
      return subscriptionPromise;
    };

    const readyHandler = () => {
      if (initialized && sub === activeSub) void subscribe();
    };
    const closeHandler = () => {
      markSubscriberUnavailable('WS fan-out subscriber closed');
    };
    const reconnectingHandler = () => {
      markSubscriberUnavailable('WS fan-out subscriber reconnecting');
    };
    const errorHandler = (err) => {
      markSubscriberUnavailable('WS fan-out subscriber error:', err);
    };
    const activeHandlers = {
      sub: activeSub,
      messageHandler,
      readyHandler,
      closeHandler,
      reconnectingHandler,
      errorHandler,
    };
    subscriberEventHandlers = activeHandlers;

    activeSub.on?.('pmessage', messageHandler);
    // Re-assert the pattern subscription after any reconnect (Sentinel failover,
    // transient drop). ioredis emits 'ready' on (re)connect.
    activeSub.on?.('ready', readyHandler);
    activeSub.on?.('close', closeHandler);
    activeSub.on?.('reconnecting', reconnectingHandler);
    activeSub.on?.('error', errorHandler);

    try {
      const ready = await subscribe({ failInitialization: true });
      if (!ready) {
        const err = new Error('WebSocket fan-out subscription is not ready');
        err.code = 'WS_FANOUT_SUBSCRIPTION_NOT_READY';
        throw err;
      }
      initialized = true;
      logger.info('🔁 WS Redis fan-out enabled (cross-process broadcast via pub/sub)');
      return true;
    } catch (err) {
      if (sub === activeSub) {
        subscriptionGeneration += 1;
        subscriptionPromise = null;
        subscribed = false;
        enabled = false;
        initialized = false;
        subscriberEventHandlers = null;
        sub = null;
        subOwned = false;
      }
      await teardownSubscriber(activeSub, activeHandlers, ownsSub, { disconnect: true });
      throw err;
    }
  }

  function init(options = {}) {
    if (closePromise) return Promise.reject(staleGenerationError());
    if (isEnabled()) return Promise.resolve(true);
    if (initializationPromise) return initializationPromise;

    const pending = initialize(options).finally(() => {
      if (initializationPromise === pending) initializationPromise = null;
    });
    initializationPromise = pending;
    return pending;
  }

  function isEnabled() {
    return enabled && subscribed && !!pub;
  }

  function observePublish(pending, label, localFallback) {
    if (!pending || typeof pending.then !== 'function') {
      return pending !== 0;
    }
    pending.then((subscriberCount) => {
      if (subscriberCount === 0) {
        logger.error(`${label} reached zero subscribers — falling back to local delivery`);
        localFallback?.();
      }
    }).catch((err) => {
      logger.error(`${label} failed after dispatch — falling back to local:`, err?.message || err);
      localFallback?.();
    });
    return true;
  }

  function publishBroadcast(channel, event, data, tenantId, { fallbackOnReject = true } = {}) {
    if (!isEnabled()) return false;
    try {
      const pending = pub.publish(
        BROADCAST_PREFIX + channel,
        JSON.stringify({ event, data, tenantId }),
      );
      return observePublish(
        pending,
        'WS fan-out publishBroadcast',
        fallbackOnReject && deliverBroadcast
          ? () => deliverBroadcast(channel, event, data, tenantId)
          : null,
      );
    } catch (err) {
      logger.error('WS fan-out publishBroadcast failed — falling back to local:', err?.message || err);
      return false;
    }
  }

  async function publishBroadcastConfirmed(channel, event, data, tenantId) {
    if (!pub) return false;
    try {
      if (!isEnabled()) {
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

  function publishUser(userId, event, data, tenantId, { fallbackOnReject = true } = {}) {
    if (!isEnabled()) return false;
    try {
      const pending = pub.publish(USER_PREFIX + String(userId), JSON.stringify({ event, data, tenantId }));
      return observePublish(
        pending,
        'WS fan-out publishUser',
        fallbackOnReject && deliverUser
          ? () => deliverUser(String(userId), event, data, tenantId)
          : null,
      );
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
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      enabled = false;
      initializationPromise = null;
      lifecycleGeneration += 1;
      subscriptionGeneration += 1;
      subscriptionPromise = null;
      subscribed = false;
      initialized = false;
      const activeSub = sub;
      const activeHandlers = subscriberEventHandlers;
      const ownsActiveSub = subOwned;
      sub = null;
      subOwned = false;
      pub = null;
      subscriberEventHandlers = null;
      subscriptionPromise = null;
      await teardownSubscriber(activeSub, activeHandlers, ownsActiveSub);
      deliverBroadcast = null;
      deliverUser = null;
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
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
