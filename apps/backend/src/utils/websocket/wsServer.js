// src/utils/websocket/wsServer.js

import { WebSocketServer } from 'ws';
import logger from '../../logging/logger.js';
import { verifyToken } from '../jwtUtils.js';
import * as tokenBlacklist from '../tokenBlacklist.js';
import {
  normalizeCanonicalIdentity,
  resolveCanonicalTokenIdentity,
} from '../tokenIdentity.js';
import { authorizeSubscriptionChannel } from './subscriptionAuth.js';
import { parsePatientChannel } from './channelAuth.js';
import { createWsFanout } from './wsRedisAdapter.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import { recordWsBroadcastDropped } from '../../observability/reliabilityMetrics.js';

// One fan-out per wsServer module instance (= one per process in production).
// Created here rather than imported as a shared singleton so the
// differential-delivery harness can load two independent wsServer realms (via
// query-string cache-busting) that own separate fan-outs over one shared bus.
const fanout = createWsFanout();
const {
  isDelegatedTupleRevoked,
  isSubjectDelegationRevoked,
  isTokenBlacklisted,
  isUserTokensRevoked,
} = tokenBlacklist;
if (
  process.env.NODE_ENV !== 'test'
  && (
    typeof tokenBlacklist.authRevocationLockKeys !== 'function'
    || typeof tokenBlacklist.withAuthRevocationLocks !== 'function'
  )
) {
  throw new Error('WebSocket auth revocation lock protocol is unavailable');
}
// A few legacy unit suites install intentionally partial ESM mocks. Production
// cannot enter these fallbacks because the invariant above is fail-fast.
const authRevocationLockKeys = tokenBlacklist.authRevocationLockKeys ?? (() => []);
const withAuthRevocationLocks = tokenBlacklist.withAuthRevocationLocks
  ?? ((_client, _keys, fn) => fn(_client));

/** Wire this process's fan-out onto the Redis bus. Called from bin/www.js. */
export function initWsFanout(opts) {
  return fanout.init(opts);
}

/** Strict production readiness must prove the dedicated PSUBSCRIBE is live. */
export function isWsFanoutReady() {
  return fanout.isEnabled();
}

/** Tear down this process's fan-out subscriber (graceful shutdown / tests). */
export function closeWsFanout() {
  cancelWsFanoutRewire();
  return fanout.close();
}

// --- Background fan-out rewire (PR #874 follow-up) -------------------------
//
// Closes the LAST degraded-start hole in the fan-out wiring: Redis init
// SUCCEEDED at boot but initWsFanout itself failed (subscriber duplicate
// couldn't connect / PSUBSCRIBE rejected / zero-subscription ack). The
// non-strict posture logged a warning and served anyway — and since nothing
// ever called initWsFanout again, the pod stayed silently deaf to cross-pod
// clinical broadcasts (code-blue / vitals) until restart. The sibling holes
// were already closed: an initRedis failure arms scheduleRedisReinit with an
// onReconnect rewire hook (873-F10), and a mid-flight subscriber drop is
// re-subscribed by the adapter's own 'ready' handler — but neither path fires
// when the boot-time init itself is what failed.
//
// Shape mirrors scheduleRedisReinit (unref'd timer, idempotent, loud logs,
// stop-on-success) with two deliberate differences: exponential backoff with
// a delay cap instead of a fixed cadence (each failed attempt burns a Redis
// duplicate connection, so probe fast at first and settle to a slow patrol),
// and a bounded attempt count — Redis-down recovery is owned by
// scheduleRedisReinit/ioredis, so an attempt cap here cannot strand the
// cache; it only stops re-probing a bus that keeps refusing PSUBSCRIBE while
// the degraded state stays visible on /health/ready
// (redis_websocket_subscriber), the vh_redis_ws_fanout_ready gauge, and the
// WsFanoutSubscriberDown alert. Failed attempts also count into
// recordWsFanoutSubscriberError via the adapter.
//
// The adapter owns subscriber creation and failed-initialization cleanup. Its
// single-flight init also coalesces a reconnect-hook attempt with a timer tick,
// preventing parallel duplicates and competing PSUBSCRIBEs.

const WS_FANOUT_REWIRE_INITIAL_DELAY_MS = 5_000;
const WS_FANOUT_REWIRE_MAX_DELAY_MS = 300_000;
const WS_FANOUT_REWIRE_MAX_ATTEMPTS = 40;

let fanoutRewireTimer = null;
let fanoutRewireActive = false;
let fanoutRewireGeneration = 0;

/**
 * Arm the background rewire loop. Called from bin/www.js when the boot-time
 * (or reinit-hook) initWsFanout fails on a non-strict start.
 * @param {object} opts
 * @param {() => object|null} opts.getClient - returns the live Redis singleton
 *   (bin/www.js passes lib/redis.js getRedisClient; injected for tests).
 * @returns {boolean} true when a loop was armed; false when one is already
 *   running or the fan-out is already wired.
 */
export function scheduleWsFanoutRewire({
  getClient,
  initialDelayMs = WS_FANOUT_REWIRE_INITIAL_DELAY_MS,
  maxDelayMs = WS_FANOUT_REWIRE_MAX_DELAY_MS,
  maxAttempts = WS_FANOUT_REWIRE_MAX_ATTEMPTS,
} = {}) {
  if (typeof getClient !== 'function') {
    throw new TypeError('scheduleWsFanoutRewire requires a getClient function');
  }
  if (fanoutRewireActive || fanout.isEnabled()) return false;
  fanoutRewireActive = true;
  const rewireGeneration = ++fanoutRewireGeneration;
  let attempts = 0;

  logger.warn(
    `WS fan-out degraded at start — retrying subscriber wiring in the background `
      + `(first attempt in ${initialDelayMs}ms, backoff capped at ${maxDelayMs}ms, `
      + `up to ${maxAttempts} attempts; broadcasts stay single-process until then)`,
  );

  const armNext = (delayMs) => {
    if (!fanoutRewireActive || rewireGeneration !== fanoutRewireGeneration) return;
    fanoutRewireTimer = setTimeout(async () => {
      fanoutRewireTimer = null;
      if (!fanoutRewireActive || rewireGeneration !== fanoutRewireGeneration) return;
      if (fanout.isEnabled()) {
        // Wired by another path (Redis reinit hook) — stand down quietly.
        fanoutRewireActive = false;
        return;
      }
      attempts += 1;
      try {
        const client = getClient();
        if (!client) {
          // Redis itself is gone (again); its recovery is owned elsewhere —
          // treat as a failed attempt and keep patrolling.
          throw new Error('Redis client unavailable');
        }
        const initialized = await initWsFanout({ pub: client });
        if (!fanoutRewireActive || rewireGeneration !== fanoutRewireGeneration) return;
        if (!initialized) {
          throw new Error('Redis WebSocket subscriber did not initialize');
        }
        fanoutRewireActive = false;
        logger.info(
          `WS Redis fan-out restored by background rewire (attempt ${attempts}/${maxAttempts})`,
        );
      } catch (err) {
        if (!fanoutRewireActive || rewireGeneration !== fanoutRewireGeneration) return;
        if (attempts >= maxAttempts) {
          fanoutRewireActive = false;
          logger.error(
            `WS fan-out background rewire GAVE UP after ${attempts} attempts — cross-pod `
              + 'broadcasts remain single-process until this pod restarts (visible as '
              + 'redis_websocket_subscriber on /health/ready, vh_redis_ws_fanout_ready, '
              + 'and the WsFanoutSubscriberDown alert):',
            err?.message || err,
          );
          return;
        }
        logger.warn(
          `WS fan-out background rewire attempt ${attempts}/${maxAttempts} failed — retrying in ${Math.min(delayMs * 2, maxDelayMs)}ms:`,
          err?.message || err,
        );
        armNext(Math.min(delayMs * 2, maxDelayMs));
      }
    }, delayMs);
    // Never hold the process open for the patrol.
    fanoutRewireTimer.unref?.();
  };

  armNext(initialDelayMs);
  return true;
}

/** Disarm the rewire loop (graceful shutdown / tests). */
export function cancelWsFanoutRewire() {
  fanoutRewireGeneration += 1;
  if (fanoutRewireTimer) {
    clearTimeout(fanoutRewireTimer);
    fanoutRewireTimer = null;
  }
  fanoutRewireActive = false;
}

/** @type {Map<string, Set<import('ws').WebSocket>>} userId → Set of sockets */
const clients = new Map();

/** @type {Map<string, Set<import('ws').WebSocket>>} authenticated owner uid → Set of sockets */
const revocationClients = new Map();

/** @type {Map<import('ws').WebSocket, { userId: string, revocationOwnerUid: string, role: string, tenantId?: string, jti?: string, accessSessionJti?: string, sessionFamilyId?: string, stableDeviceId?: string, channels: Set<string>, revocationDeliveryQueue: Promise<void> }>} */
const socketMeta = new Map();

// Pending-auth sockets are visible only to revocation closers. They are never
// considered by normal user delivery or broadcast loops until their final
// durable revocation check succeeds and they are promoted synchronously.
const pendingClients = new Map();
const pendingRevocationClients = new Map();
const pendingSocketMeta = new Map();

let wss = null;
let heartbeatInterval = null;

const HEARTBEAT_INTERVAL = 30_000; // 30s
export const WS_REMOTE_REVOCATION_CLOSE_BOUND_MS = HEARTBEAT_INTERVAL;
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit per client
const MAX_CONNECTIONS_PER_USER = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeIdentityKey(value) {
  return normalizeCanonicalIdentity(value) ?? String(value).trim();
}

async function registerDirectClientIfLive(userId, tenantId, lockKeys, registerClient) {
  const { default: prisma } = await import('../../lib/prisma.js');
  return prisma.$transaction((tx) => withAuthRevocationLocks(tx, lockKeys, async () => {
    const users = await tx.$queryRawUnsafe(
      `SELECT uid, tenant_id, is_active, status, is_deleted, deleted_at,
              merged_into_uid
         FROM users
        WHERE uid = $1::uuid
        FOR SHARE`,
      userId,
    );
    const admins = await tx.$queryRawUnsafe(
      `SELECT uid, tenant_id, is_active, status
         FROM admins
        WHERE uid = $1::uuid
        FOR SHARE`,
      userId,
    );

    const user = users[0];
    const admin = admins[0];
    const exactlyOneIdentity = (users.length + admins.length) === 1;
    const userLive = Boolean(
      exactlyOneIdentity
      && user
      && String(user.tenant_id || '').toLowerCase() === tenantId.toLowerCase()
      && user.is_active === true
      && String(user.status || '').trim().toLowerCase() === 'active'
      && user.is_deleted === false
      && user.deleted_at == null
      && user.merged_into_uid == null
    );
    const adminLive = Boolean(
      exactlyOneIdentity
      && admin
      && (admin.tenant_id == null
        || String(admin.tenant_id).toLowerCase() === tenantId.toLowerCase())
      && admin.is_active === true
      && String(admin.status || '').trim().toLowerCase() === 'active'
    );
    const live = userLive || adminLive;
    if (!live) return { live: false, revocationDenial: null };
    return { live: true, revocationDenial: await registerClient(tx) };
  }));
}

async function registerDelegatedClientIfLive(
  userId,
  revocationOwnerUid,
  tenantId,
  lockKeys,
  registerClient,
) {
  const { default: prisma } = await import('../../lib/prisma.js');
  return prisma.$transaction((tx) => withAuthRevocationLocks(tx, lockKeys, async () => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT dep.uid, dep.role, dep.is_minor, dep.is_active, dep.status,
              (dep.birthday IS NULL
                OR dep.birthday > (CURRENT_DATE - INTERVAL '18 years'))
                AS is_minor_now,
              dep.is_deleted, dep.deleted_at, dep.merged_into_uid,
              guardian.role AS guardian_role,
              guardian.is_active AS guardian_is_active,
              guardian.status AS guardian_status,
              guardian.is_deleted AS guardian_is_deleted,
              guardian.deleted_at AS guardian_deleted_at,
              guardian.merged_into_uid AS guardian_merged_into_uid
         FROM users dep
         JOIN users guardian ON guardian.id = dep.guardian_user_id
        WHERE dep.uid = $1::uuid
          AND dep.tenant_id = $2::uuid
          AND guardian.uid = $3::uuid
          AND guardian.tenant_id = dep.tenant_id
          AND dep.role = 'PATIENT'
          AND dep.is_minor = TRUE
          -- Minor status recomputed from date of birth at handshake time:
          -- delegation ends at 18; a missing birthday falls back to the flag
          -- (same contract as jwtMiddleware.applyActingAsHop).
          AND (dep.birthday IS NULL
               OR dep.birthday > (CURRENT_DATE - INTERVAL '18 years'))
          AND dep.is_active = TRUE
          AND dep.status = 'active'
          AND dep.is_deleted = FALSE
          AND dep.deleted_at IS NULL
          AND dep.merged_into_uid IS NULL
          AND guardian.role = 'PATIENT'
          AND guardian.is_active = TRUE
          AND guardian.status = 'active'
          AND guardian.is_deleted = FALSE
          AND guardian.deleted_at IS NULL
          AND guardian.merged_into_uid IS NULL
        LIMIT 1
        FOR SHARE OF dep, guardian`,
      userId,
      tenantId,
      revocationOwnerUid,
    );
    const subject = rows[0];
    const live = Boolean(
      subject
      && subject.role === 'PATIENT'
      && subject.is_minor === true
      && subject.is_minor_now === true
      && subject.is_active === true
      && String(subject.status || '').trim().toLowerCase() === 'active'
      && subject.is_deleted === false
      && subject.deleted_at == null
      && subject.merged_into_uid == null
      && subject.guardian_role === 'PATIENT'
      && subject.guardian_is_active === true
      && String(subject.guardian_status || '').trim().toLowerCase() === 'active'
      && subject.guardian_is_deleted === false
      && subject.guardian_deleted_at == null
      && subject.guardian_merged_into_uid == null
    );
    if (!live) return { live: false, revocationDenial: null };
    return { live: true, revocationDenial: await registerClient(tx) };
  }));
}

async function registerNonUuidClient(lockKeys, registerClient) {
  const { default: prisma } = await import('../../lib/prisma.js');
  return prisma.$transaction((tx) => withAuthRevocationLocks(
    tx,
    lockKeys,
    () => registerClient(tx),
  ));
}

export function initWebSocket(server) {
  if (wss) {
    closeWebSocket();
  }

  wss = new WebSocketServer({ server, path: '/ws' });

  logger.info('🔌 WebSocket server initialized on /ws');

  wss.on('connection', async (ws, req) => {
    // Accept token from Authorization header, ?token= query param, or first message frame.
    // Browsers cannot set custom headers on WebSocket connections, so query param
    // and message-based auth are the two client options.
    const wsUrl = new URL(req.url, 'ws://localhost');
    const queryToken = wsUrl.searchParams.get('token');
    const headerToken = req.headers.authorization?.replace('Bearer ', '');
    const token = headerToken || queryToken;

    if (token) {
      // Immediate auth via header or query param
      await authenticateAndRegister(ws, token);
    } else {
      // No token in URL — wait for auth message as first frame (5s timeout)
      const authTimeout = setTimeout(() => {
        if (!socketMeta.has(ws)) {
          ws.close(4001, 'Authentication timeout: send {"action":"auth","token":"..."} within 5 seconds');
        }
      }, 5000);

      ws.once('message', async (raw) => {
        clearTimeout(authTimeout);
        try {
          const msg = JSON.parse(raw);
          if (msg.action === 'auth' && msg.token) {
            await authenticateAndRegister(ws, msg.token);
          } else {
            ws.close(4001, 'First message must be {"action":"auth","token":"..."}');
          }
        } catch {
          ws.close(4001, 'Invalid auth message');
        }
      });
    }
  });

  // The same bounded patrol that detects dead connections also revalidates
  // durable revocation state. Redis PubSub accelerates remote socket closure,
  // but correctness does not depend on that lossy notification channel.
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
    void runDurableRevocationSweep();
  }, HEARTBEAT_INTERVAL);

  if (heartbeatInterval.unref) heartbeatInterval.unref();
  wss.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    clients.clear();
    revocationClients.clear();
    socketMeta.clear();
    pendingClients.clear();
    pendingRevocationClients.clear();
    pendingSocketMeta.clear();
  });
}

export function closeWebSocket() {
  const activeServer = wss;
  if (!activeServer) return Promise.resolve();

  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = null;

  for (const ws of activeServer.clients) {
    ws.terminate();
  }

  return new Promise((resolve) => {
    activeServer.close(() => {
      if (wss === activeServer) wss = null;
      clients.clear();
      revocationClients.clear();
      socketMeta.clear();
      pendingClients.clear();
      pendingRevocationClients.clear();
      pendingSocketMeta.clear();
      resolve();
    });
  });
}

/**
 * Authenticate a WebSocket connection and register it for messaging.
 * Shared by both URL-based and message-based auth flows.
 */
async function authenticateAndRegister(ws, token) {
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    ws.close(4001, 'Invalid token');
    return;
  }

  if (!decoded) {
    ws.close(4001, 'Invalid token');
    return;
  }

  const identityResolution = resolveCanonicalTokenIdentity(decoded);
  if (identityResolution.conflict) {
    ws.close(4001, 'Invalid token payload');
    return;
  }
  const userId = identityResolution.identity === undefined
    || identityResolution.identity === null
    ? null
    : normalizeIdentityKey(identityResolution.identity);
  const role = decoded.role;
  const tenantId = decoded.tenant_id || decoded.tenantId || null;
  const revocationOwnerUid = decoded.revocationOwnerUid === undefined
    || decoded.revocationOwnerUid === null
    ? userId
    : normalizeIdentityKey(decoded.revocationOwnerUid);
  if (!userId) {
    ws.close(4001, 'Invalid token payload');
    return;
  }
  if (!tenantId) {
    ws.close(4001, 'Invalid token tenant');
    return;
  }
  if (!revocationOwnerUid) {
    ws.close(4001, 'Invalid token payload');
    return;
  }
  const ownerIsSubject = revocationOwnerUid === userId;
  const delegatedTupleKey = ownerIsSubject
    ? null
    : `delegated:${revocationOwnerUid}:${userId}`;
  const revocationLockKeys = authRevocationLockKeys({
    identityUids: [revocationOwnerUid, ...(ownerIsSubject ? [] : [userId])],
    jtis: [decoded.jti],
    tupleKeys: [delegatedTupleKey],
  });

  const getRevocationDenial = async (client) => {
    const checkOpts = client ? { client } : undefined;
    const tokenBlacklisted = decoded.jti && (client
      ? await isTokenBlacklisted(decoded.jti, checkOpts)
      : await isTokenBlacklisted(decoded.jti));
    if (tokenBlacklisted) {
      return 'Token has been revoked';
    }
    const ownerRevoked = client
      ? await isUserTokensRevoked(
          revocationOwnerUid,
          decoded.iat,
          decoded.token_epoch,
          checkOpts,
        )
      : await isUserTokensRevoked(revocationOwnerUid, decoded.iat, decoded.token_epoch);
    if (ownerRevoked) {
      return 'All sessions revoked';
    }

    // A delegated ticket is authorized as the dependent but owned by the
    // guardian session. Either identity's later revoke-all must stop the
    // handshake. The guardian's token_epoch is not meaningful for the
    // dependent, so that second check uses the durable timestamp predicate
    // (isSubjectDelegationRevoked — including the epoch-bump TIMESTAMP, so a
    // subject revoke-all severs tickets issued before it without denying
    // forever; a ticket minted after guardian re-login recovers).
    if (!ownerIsSubject) {
      const subjectRevoked = client
        ? await isSubjectDelegationRevoked(userId, decoded.iat, checkOpts)
        : await isSubjectDelegationRevoked(userId, decoded.iat);
      if (subjectRevoked) {
        return 'All sessions revoked';
      }
      const tupleRevoked = client
        ? await isDelegatedTupleRevoked(
            revocationOwnerUid,
            userId,
            decoded.iat,
            checkOpts,
          )
        : await isDelegatedTupleRevoked(revocationOwnerUid, userId, decoded.iat);
      if (tupleRevoked) {
        return 'Delegated session revoked';
      }
    }
    return null;
  };

  // Check both single-token and revoke-all state before doing any registration.
  // UUID and delegated registrations repeat the same check after the socket is
  // visible to revocation closers (but not normal delivery) while their
  // lifecycle locks are still held. That closes the gap in which a committed
  // revocation push could otherwise run before registration.
  try {
    const revocationDenial = await getRevocationDenial();
    if (revocationDenial) {
      ws.close(4001, revocationDenial);
      return;
    }
  } catch (err) {
    logger.error('WS denied (fail closed): revocation store unreachable', {
      error: err?.message,
      userId,
      revocationOwnerUid,
    });
    ws.close(1013, 'Authentication unavailable');
    return;
  }

  // Enforce per-user connection limit before either direct or delegated
  // registration. Delegated registration then happens under the subject lock.
  const connectionCount = (clients.get(userId)?.size || 0)
    + (pendingClients.get(userId)?.size || 0);
  if (connectionCount >= MAX_CONNECTIONS_PER_USER) {
    ws.close(4029, 'Too many concurrent connections');
    return;
  }

  const meta = {
    userId,
    revocationOwnerUid,
    role,
    tenantId,
    jti: decoded.jti ?? null,
    accessSessionJti: decoded.accessSessionJti ?? null,
    sessionFamilyId: decoded.sessionFamilyId ?? null,
    stableDeviceId: decoded.stableDeviceId ?? null,
    channels: new Set(),
    revocationDeliveryQueue: Promise.resolve(),
    revocationLockKeys,
    getRevocationDenial,
  };
  const removeSocketFrom = (registry, key) => {
    registry.get(key)?.delete(ws);
    if (registry.get(key)?.size === 0) registry.delete(key);
  };
  const cleanupRegistration = () => {
    const registeredMeta = socketMeta.get(ws) ?? pendingSocketMeta.get(ws) ?? meta;
    removeSocketFrom(clients, registeredMeta.userId);
    removeSocketFrom(revocationClients, registeredMeta.revocationOwnerUid);
    removeSocketFrom(pendingClients, registeredMeta.userId);
    removeSocketFrom(pendingRevocationClients, registeredMeta.revocationOwnerUid);
    socketMeta.delete(ws);
    pendingSocketMeta.delete(ws);
  };
  ws.on('close', cleanupRegistration);

  const registerPending = () => {
    if (!pendingClients.has(userId)) pendingClients.set(userId, new Set());
    pendingClients.get(userId).add(ws);
    if (!pendingRevocationClients.has(revocationOwnerUid)) {
      pendingRevocationClients.set(revocationOwnerUid, new Set());
    }
    pendingRevocationClients.get(revocationOwnerUid).add(ws);
    pendingSocketMeta.set(ws, meta);
  };
  const promotePending = () => {
    removeSocketFrom(pendingClients, userId);
    removeSocketFrom(pendingRevocationClients, revocationOwnerUid);
    pendingSocketMeta.delete(ws);
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);
    if (!revocationClients.has(revocationOwnerUid)) {
      revocationClients.set(revocationOwnerUid, new Set());
    }
    revocationClients.get(revocationOwnerUid).add(ws);
    socketMeta.set(ws, meta);
  };
  const registerAndRevalidate = async (client) => {
    let revocationDenial;
    try {
      revocationDenial = await getRevocationDenial(client);
    } catch (err) {
      cleanupRegistration();
      throw err;
    }
    if (revocationDenial) {
      cleanupRegistration();
      return revocationDenial;
    }
    if (ws.readyState !== 1 || pendingSocketMeta.get(ws) !== meta) {
      cleanupRegistration();
      return 'Session revoked';
    }
    promotePending();
    return null;
  };

  // Reserve synchronously after the count and before the next await. Pending
  // sockets are invisible to normal delivery but visible to revocation closers.
  registerPending();

  // The revocation watermark only rejects tickets issued before retirement.
  // Hold identity share locks through socket registration, so a concurrent
  // deactivation/merge/deletion either wins before validation or waits until
  // the socket is visible to its post-commit revocation push.
  if (!ownerIsSubject) {
    try {
      const result = await registerDelegatedClientIfLive(
        userId,
        revocationOwnerUid,
        tenantId,
        revocationLockKeys,
        registerAndRevalidate,
      );
      if (!result.live) {
        cleanupRegistration();
        ws.close(4001, 'Delegated subject unavailable');
        return;
      }
      if (result.revocationDenial) {
        if (ws.readyState === 1) ws.close(4001, result.revocationDenial);
        return;
      }
    } catch (err) {
      cleanupRegistration();
      logger.error('WS denied (fail closed): delegated subject lookup unavailable', {
        error: err?.message,
        userId,
        revocationOwnerUid,
      });
      ws.close(1013, 'Authentication unavailable');
      return;
    }
  } else if (!UUID_RE.test(userId)) {
    try {
      const revocationDenial = await registerNonUuidClient(
        revocationLockKeys,
        registerAndRevalidate,
      );
      if (revocationDenial) {
        if (ws.readyState === 1) ws.close(4001, revocationDenial);
        return;
      }
    } catch (err) {
      cleanupRegistration();
      logger.error('WS denied (fail closed): revocation store unreachable', {
        error: err?.message,
        userId,
        revocationOwnerUid,
      });
      ws.close(1013, 'Authentication unavailable');
      return;
    }
  } else {
    try {
      const result = await registerDirectClientIfLive(
        userId,
        tenantId,
        revocationLockKeys,
        registerAndRevalidate,
      );
      if (!result.live) {
        cleanupRegistration();
        ws.close(4001, 'Identity unavailable');
        return;
      }
      if (result.revocationDenial) {
        if (ws.readyState === 1) ws.close(4001, result.revocationDenial);
        return;
      }
    } catch (err) {
      cleanupRegistration();
      logger.error('WS denied (fail closed): identity lookup unavailable', {
        error: err?.message,
        userId,
      });
      ws.close(1013, 'Authentication unavailable');
      return;
    }
  }

  if (ws.readyState !== 1) return;

  logger.info(`🔌 WS connected: user=${userId} role=${role || 'unknown'}`);

  // Ping/pong heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let messageQueue = Promise.resolve();
  ws.on('message', (raw) => {
    messageQueue = messageQueue.then(async () => {
      try {
        const msg = JSON.parse(raw);
        if (msg.action === 'subscribe' && msg.channel) {
          const meta = socketMeta.get(ws);
          if (!meta) return;
          const decision = await authorizeSubscriptionChannel(msg.channel, meta);
          if (socketMeta.get(ws) !== meta || ws.readyState !== 1) return;
          if (!decision.allowed) {
            meta.channels.delete(msg.channel);
            ws.send(JSON.stringify({
              event: 'subscribe-denied',
              channel: msg.channel,
              reason: decision.reason,
              ts: Date.now(),
            }));
            return;
          }
          meta.channels.add(msg.channel);
          ws.send(JSON.stringify({
            event: 'subscribed',
            channel: msg.channel,
            ts: Date.now(),
          }));
        } else if (msg.action === 'unsubscribe' && msg.channel) {
          socketMeta.get(ws)?.channels.delete(msg.channel);
          ws.send(JSON.stringify({
            event: 'unsubscribed',
            channel: msg.channel,
            ts: Date.now(),
          }));
        } else if (msg.action === 'ping') {
          // App-level ping/pong. Browsers hide WS-frame pings from JS, so
          // clients can't measure RTT or detect half-open connections that way.
          // This lets clients do both via normal JSON messages. Echo the
          // client ts back so the client can compute round-trip latency.
          ws.isAlive = true; // any traffic counts as alive for the WS-frame heartbeat too
          ws.send(JSON.stringify({
            event: 'pong',
            ts: typeof msg.ts === 'number' ? msg.ts : null,
            serverTs: Date.now(),
          }));
        } else if (msg.action === 'resync' && Array.isArray(msg.channels)) {
          // Client reconnected after a disconnect and wants to re-assert its
          // subscription list. We re-authorize each channel (role may have
          // changed since the old session) and emit one `subscribed` /
          // `subscribe-denied` event per channel so the client can reconcile
          // its local state.
          const meta = socketMeta.get(ws);
          if (!meta) return;
          for (const channel of msg.channels) {
            if (typeof channel !== 'string') continue;
            const decision = await authorizeSubscriptionChannel(channel, meta);
            if (socketMeta.get(ws) !== meta || ws.readyState !== 1) return;
            if (decision.allowed) {
              meta.channels.add(channel);
              ws.send(JSON.stringify({ event: 'subscribed', channel, ts: Date.now() }));
            } else {
              meta.channels.delete(channel);
              ws.send(JSON.stringify({
                event: 'subscribe-denied',
                channel,
                reason: decision.reason,
                ts: Date.now(),
              }));
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });
  });

  ws.on('error', (err) => {
    logger.error(`WS error for user=${userId}:`, err.message);
  });

  // Send welcome
  await queueRevocationGuardedDelivery(ws, meta, async () => {
    ws.send(JSON.stringify({ event: 'connected', userId }));
  });
}

// ---------------------------------------------------------------------------
// Local (in-process) delivery loops.
//
// These are the ONLY place a socket.send() happens for a fan-out. They are
// invoked two ways:
//   1) directly, when the Redis bus is unavailable (degraded single-process), or
//   2) by the wsRedisAdapter SUBSCRIBE consumer, when a broadcast/sendToUser
//      published from THIS or ANY OTHER process arrives over the bus.
// Either way the 1MB bufferedAmount backpressure guard and the per-broadcast
// tenant filter apply identically.
// ---------------------------------------------------------------------------

/**
 * Per-broadcast tenant filter. A socket only receives a message whose tenant
 * matches the socket's own tenant (captured from the ws ticket at connect time).
 * `eventTenantId == null` means "no tenant scoping" (legacy / system events) and
 * is delivered to everyone subscribed — but every first-party emit now carries a
 * tenant, so the global staff:/admin: channels are tenant-isolated in practice.
 */
function tenantMatches(socketTenantId, eventTenantId) {
  if (eventTenantId == null) return true;
  return String(socketTenantId) === String(eventTenantId);
}

async function deliverWithDurableRevocationBarrier(ws, meta, deliver) {
  try {
    const { default: prisma } = await import('../../lib/prisma.js');
    await prisma.$transaction(async (tx) => {
      await withAuthRevocationLocks(tx, meta.revocationLockKeys, async () => {
        const revocationDenial = await meta.getRevocationDenial(tx);
        if (socketMeta.get(ws) !== meta || ws.readyState !== 1) return;
        if (revocationDenial) {
          ws.close(SESSION_REVOKED_CLOSE_CODE, revocationDenial);
          return;
        }
        await deliver();
      });
    });
  } catch (err) {
    logger.error('WebSocket delivery denied: durable revocation check unavailable', {
      error: err?.message,
      userId: meta.userId,
      revocationOwnerUid: meta.revocationOwnerUid,
    });
    if (ws.readyState === 1) ws.close(1013, 'Authentication unavailable');
  }
}

// The barrier holds one pool connection for the life of its transaction and
// the pg pool is the adapter default (10). Sweeping every socket with
// Promise.all opened one transaction per connected socket, so a ward with more
// sockets than pool slots made every sweep queue past the interactive
// transaction timeout — and the barrier's catch closes a timed-out socket with
// 1013. Walk the sockets in bounded batches instead.
const REVOCATION_SWEEP_CONCURRENCY = 4;

async function runDurableRevocationSweep() {
  const sockets = [...socketMeta];
  for (let i = 0; i < sockets.length; i += REVOCATION_SWEEP_CONCURRENCY) {
    await Promise.all(sockets.slice(i, i + REVOCATION_SWEEP_CONCURRENCY).map(([ws, meta]) => (
      deliverWithDurableRevocationBarrier(ws, meta, async () => {})
    )));
  }
}

// Serializes work on a socket without itself opening a transaction.
function queueSocketDelivery(meta, run) {
  const queued = meta.revocationDeliveryQueue.then(run);
  meta.revocationDeliveryQueue = queued.catch(() => {});
  return queued;
}

function queueRevocationGuardedDelivery(ws, meta, deliver) {
  return queueSocketDelivery(meta, () => (
    deliverWithDurableRevocationBarrier(ws, meta, deliver)
  ));
}

// Re-authorization MUST NOT run inside the barrier transaction.
// `authorizeSubscriptionChannel` -> `authorizePatientAccessRequest` issues its
// own queries on the module-level prisma client — the same pool the barrier
// already holds a connection from. Nesting the two checkouts deadlocked the
// pool under fan-out (one broadcast per waiting patient starts one barrier
// each), and the barrier's catch then closed every stalled clinical socket
// with 1013. So: authorize first on a released connection, then run only the
// send itself through the barrier, whose callback touches no database.
async function deliverPatientBroadcastLocal(ws, meta, channel, payload, tenantId) {
  let decision;
  try {
    decision = await authorizeSubscriptionChannel(channel, meta);
  } catch (err) {
    logger.error('WebSocket delivery denied: patient re-authorization unavailable', {
      error: err?.message,
      userId: meta.userId,
      channel,
    });
    if (ws.readyState === 1) ws.close(1013, 'Authentication unavailable');
    return;
  }
  if (
    socketMeta.get(ws) !== meta
    || ws.readyState !== 1
    || !meta.channels.has(channel)
    || !tenantMatches(meta.tenantId, tenantId)
  ) {
    return;
  }
  if (!decision.allowed) {
    meta.channels.delete(channel);
    ws.send(JSON.stringify({
      event: 'subscribe-denied',
      channel,
      reason: decision.reason,
      ts: Date.now(),
    }));
    return;
  }
  if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    recordWsBroadcastDropped('backpressure');
    logger.warn(`Skipping broadcast to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
    return;
  }
  await deliverWithDurableRevocationBarrier(ws, meta, async () => {
    ws.send(payload);
  });
}

/** Deliver a channel broadcast to this process's subscribed sockets. */
function deliverBroadcastLocal(channel, event, data, tenantId) {
  if (!wss) return;
  const patientChannel = parsePatientChannel(channel);
  if (patientChannel && tenantId == null) {
    logger.warn('Dropping patient realtime broadcast without tenant scope', {
      topic: patientChannel.topic,
    });
    return;
  }
  const payload = JSON.stringify({ event: event ?? channel, data });
  for (const [ws, meta] of socketMeta) {
    if (!meta.channels.has(channel) || ws.readyState !== 1) continue;
    // Cross-tenant realtime leak guard: drop messages for a different tenant.
    if (!tenantMatches(meta.tenantId, tenantId)) continue;
    if (patientChannel) {
      // Care-team and break-glass authority can expire or be revoked after the
      // subscription ACK. Re-authorize immediately before every personal PHI
      // delivery and serialize per socket so events cannot overtake each other.
      queueSocketDelivery(
        meta,
        () => deliverPatientBroadcastLocal(ws, meta, channel, payload, tenantId),
      );
      continue;
    }
    queueRevocationGuardedDelivery(ws, meta, async () => {
      // Skip slow clients to prevent memory buildup (1MB buffer cap).
      if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        recordWsBroadcastDropped('backpressure');
        logger.warn(`Skipping broadcast to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
        return;
      }
      ws.send(payload);
    });
  }
}

// Session-revocation events must not leave the revoked session's sockets
// open: on shared ward devices the still-connected socket kept delivering
// message subjects/bodies onto the login screen after logout (STF-1 / H3).
// After delivering `session:revoked`, the socket is closed server-side —
// the client's own teardown is belt-and-braces, not the enforcement point.
const SESSION_REVOKED_EVENT = 'session:revoked';
const SESSION_REVOKED_CLOSE_CODE = 4001;

/** Deliver a user-targeted message to this process's sockets for that user. */
function deliverUserLocal(userId, event, data, tenantId) {
  const isRevocation = event === SESSION_REVOKED_EVENT;
  const uid = normalizeIdentityKey(userId);
  const deliverySockets = clients.get(uid);
  const ownerSockets = isRevocation ? revocationClients.get(uid) : null;
  const pendingDeliverySockets = isRevocation ? pendingClients.get(uid) : null;
  const pendingOwnerSockets = isRevocation ? pendingRevocationClients.get(uid) : null;
  if (
    !deliverySockets
    && !ownerSockets
    && !pendingDeliverySockets
    && !pendingOwnerSockets
  ) return;
  // Normal user delivery remains effective-subject scoped. Only revocation
  // adds sockets authenticated by that owner (for guardian acting-as tickets).
  const sockets = isRevocation
    ? new Set([
        ...(deliverySockets || []),
        ...(ownerSockets || []),
        ...(pendingDeliverySockets || []),
        ...(pendingOwnerSockets || []),
      ])
    : deliverySockets;
  const payload = JSON.stringify({ event, data });
  const revokedJti = isRevocation && data?.jti ? String(data.jti) : null;
  const revokedSessionFamilyId = isRevocation && data?.sessionFamilyId
    ? String(data.sessionFamilyId)
    : null;
  const revokedStableDeviceId = isRevocation && data?.stableDeviceId
    ? String(data.stableDeviceId)
    : null;
  const revokedDelegatedSubjectUid = isRevocation && data?.delegatedSubjectUid
    ? normalizeIdentityKey(data.delegatedSubjectUid)
    : null;
  // Copy: closing a socket mutates `sockets` via the ws 'close' handler.
  for (const ws of [...sockets]) {
    const meta = socketMeta.get(ws) ?? pendingSocketMeta.get(ws);
    if (!tenantMatches(meta?.tenantId, tenantId)) continue;
    if (
      revokedDelegatedSubjectUid
      && (
        normalizeIdentityKey(meta?.revocationOwnerUid || '') !== uid
        || normalizeIdentityKey(meta?.userId || '') !== revokedDelegatedSubjectUid
        || normalizeIdentityKey(meta?.revocationOwnerUid || '')
          === normalizeIdentityKey(meta?.userId || '')
      )
    ) {
      continue;
    }
    if (revokedSessionFamilyId) {
      // A family identifies one login across access rotation and WS-ticket
      // exchange. Prefer it over the broader device selector so revoking one
      // login does not close a sibling family opened on the same installation.
      const matchesJti = revokedJti && String(meta?.jti || '') === revokedJti;
      const matchesFamily = String(meta?.sessionFamilyId || '') === revokedSessionFamilyId;
      if (!matchesJti && !matchesFamily) continue;
    } else if (revokedStableDeviceId) {
      if (String(meta?.stableDeviceId || '') !== revokedStableDeviceId) continue;
    } else if (revokedJti) {
      // A legacy registry row has no family/device selectors. Realtime tickets
      // carry their authenticated access token's jti so its revocation still
      // reaches the ticket even though the ticket has a distinct jti.
      const matchesJti = String(meta?.jti || '') === revokedJti;
      const matchesAccessSession = String(meta?.accessSessionJti || '') === revokedJti;
      if (!matchesJti && !matchesAccessSession) continue;
    }
    if (isRevocation) {
      const open = ws.readyState === 1;
      if (open) {
        if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          recordWsBroadcastDropped('backpressure');
          logger.warn(`Skipping sendToUser to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
        } else {
          ws.send(payload);
        }
      }
      // Close even when the send was skipped (backpressure) or the socket
      // is still connecting — a revoked session gets no further delivery.
      try {
        ws.close(SESSION_REVOKED_CLOSE_CODE, 'Session revoked');
      } catch {
        ws.terminate();
      }
    } else {
      queueRevocationGuardedDelivery(ws, meta, async () => {
        if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          recordWsBroadcastDropped('backpressure');
          logger.warn(`Skipping sendToUser to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
          return;
        }
        ws.send(payload);
      });
    }
  }
}

// Register the local loops with the Redis adapter once, at module load. The
// adapter's SUBSCRIBE consumer calls these on every bus message. This wiring is
// independent of whether Redis is actually configured — if it isn't, the
// publish() helpers below return false and we run these loops directly.
fanout.registerLocalDelivery({
  deliverBroadcast: deliverBroadcastLocal,
  deliverUser: deliverUserLocal,
});

/**
 * Resolve the tenant to stamp on a fan-out. A broadcast issued by a service has
 * no per-message tenant, so we derive it from the request-scoped tenant context
 * (AsyncLocalStorage) when present. Falls back to null (no scoping) so a missing
 * context degrades to the pre-existing broadcast-to-all behaviour rather than
 * dropping the event entirely.
 */
function resolveTenantId(explicitTenantId) {
  if (explicitTenantId != null) return explicitTenantId;
  try {
    return getCurrentTenantId() ?? null;
  } catch {
    return null;
  }
}

/**
 * Broadcast to all clients subscribed to a channel, across EVERY process.
 *
 * Publishes the event onto the Redis bus so every process's SUBSCRIBE consumer
 * delivers it to its own local sockets. When the bus is unavailable, falls back
 * to delivering only to this process's sockets (degraded, single-process).
 *
 * @param {string} channel
 * @param {*} data
 * @param {object} [opts]
 * @param {string} [opts.tenantId] - explicit tenant scope; defaults to the
 *        request-scoped tenant context. Pass null to broadcast unscoped.
 */
export function broadcast(channel, data, opts = {}) {
  if (!wss) return;
  const tenantId = resolveTenantId(opts.tenantId);
  const published = fanout.publishBroadcast(channel, channel, data, tenantId);
  if (!published) {
    recordWsBroadcastDropped('fanout_local_fallback');
    // Redis down / not configured — deliver locally so single-process dev and
    // degraded prod still work.
    deliverBroadcastLocal(channel, channel, data, tenantId);
  }
}

/**
 * Broadcast with an awaited Redis acknowledgement for scheduler accounting.
 * A Redis publish rejection still delivers locally, then rejects so the
 * scheduler records degraded fleet fan-out instead of durable success.
 */
export async function broadcastConfirmed(channel, data, opts = {}) {
  if (!wss) throw new Error('WebSocket server is not initialized');
  const tenantId = resolveTenantId(opts.tenantId);
  try {
    const published = await fanout.publishBroadcastConfirmed(
      channel,
      channel,
      data,
      tenantId,
    );
    if (published) return { scope: 'fleet' };
  } catch (err) {
    recordWsBroadcastDropped('fanout_local_fallback');
    deliverBroadcastLocal(channel, channel, data, tenantId);
    throw err;
  }
  recordWsBroadcastDropped('fanout_local_fallback');
  deliverBroadcastLocal(channel, channel, data, tenantId);
  const err = new Error('WebSocket fleet fan-out unavailable; delivered locally only');
  err.code = 'WS_FLEET_FANOUT_UNAVAILABLE';
  throw err;
}

/**
 * Send a message to a specific user (all their connected sockets) across EVERY
 * process. Publishes onto the bus; falls back to local delivery when the bus is
 * unavailable.
 *
 * @param {string} userId
 * @param {string} event
 * @param {*} data
 * @param {object} [opts]
 * @param {string} [opts.tenantId]
 */
export function sendToUser(userId, event, data, opts = {}) {
  const uid = normalizeIdentityKey(userId);
  const tenantId = resolveTenantId(opts.tenantId);
  const published = fanout.publishUser(uid, event, data, tenantId);
  if (!published) {
    recordWsBroadcastDropped('fanout_local_fallback');
    deliverUserLocal(uid, event, data, tenantId);
  }
}

/**
 * Push `session:revoked` to every reachable socket of a user and close local
 * sockets synchronously. A remote process that misses the lossy PubSub event
 * closes from the durable marker patrol within
 * WS_REMOTE_REVOCATION_CLOSE_BOUND_MS.
 *
 * Called by the revocation chokepoint (tokenBlacklist.revokeAllUserTokens) so
 * logout, force-revoke-all, and SCIM deprovisioning all tear down live sockets
 * — previously only the env-gated single-session replacement path emitted this
 * event, so a "revoked" session's socket kept delivering realtime data (R14).
 *
 * Deliberately UNSCOPED by tenant (explicit null, bypassing the ambient
 * request tenant context): a revocation must reach every socket the identity
 * holds regardless of the caller's tenant stamp — mirroring the deliberately
 * unscoped SCIM session-kill queries. uid is globally unique, so this cannot
 * leak across identities.
 *
 * @param {string} userId
 * @param {object} [data] - payload delivered with the event (e.g. { reason }).
 */
export function pushSessionRevoked(userId, data = {}) {
  const uid = normalizeIdentityKey(userId);
  // Close this process's sockets synchronously. Redis publish acknowledgement
  // is asynchronous, so its immediate boolean cannot prove remote delivery or
  // safely decide whether local fallback is necessary.
  deliverUserLocal(uid, SESSION_REVOKED_EVENT, data, null);
  fanout.publishUser(uid, SESSION_REVOKED_EVENT, data, null, {
    // This path already delivered locally before publishing.
    fallbackOnReject: false,
  });
}

/** Close only sockets for one authenticated guardian-dependent delegation. */
export function pushDelegatedSessionRevoked(guardianUid, dependentUid, data = {}) {
  pushSessionRevoked(normalizeIdentityKey(guardianUid), {
    ...data,
    delegatedSubjectUid: normalizeIdentityKey(dependentUid),
  });
}

/**
 * Get count of connected clients.
 */
export function getConnectedCount() {
  return wss ? wss.clients.size : 0;
}
