// src/tests/contracts/realtime-flow.test.js
//
// Wire-level contract + differential-delivery test for the realtime fabric.
//
// Two layers:
//   1. channel-auth + single-server contract (proves "emit → channel auth →
//      client stream" works end-to-end without a Flutter runner), and
//   2. the CROSS-PROCESS DIFFERENTIAL-DELIVERY HARNESS — the instrument that
//      detects the Gap-2 failure mode: a broadcast issued in one process must
//      reach sockets connected to EVERY process, and must NOT cross tenants.
//
// ── How the harness simulates two processes ────────────────────────────────
// wsServer.js keeps its socket state (clients/socketMeta/wss) AND its fan-out
// instance in module scope. Importing it twice with a cache-busting query string
// (`?inst=A` / `?inst=B`) yields two genuinely independent module realms — two
// separate socket registries and two separate fan-outs — exactly like two OS
// processes. Both fan-outs are wired to ONE shared in-memory pub/sub bus
// (FakeRedisBus below), so a PUBLISH from realm A is delivered to realm B's
// SUBSCRIBE consumer — genuinely exercising cross-instance pub/sub.
//
// ── Why a fake bus (not real Redis / ioredis-mock) ─────────────────────────
// There is no local Redis on this dev box and `ioredis-mock` is not a
// dependency. ioredis-mock also historically does NOT share pub/sub state across
// two separately-constructed clients, so it could not prove cross-instance
// delivery even if installed. The FakeRedisBus here is a ~30-line shared event
// emitter implementing exactly the psubscribe/publish/pmessage surface the
// adapter uses; both realms attach to the SAME bus object, so cross-instance
// pub/sub is real (just in-process). The RED proof below confirms the harness
// detects the cross-process drop, so it is testing something real.
//
// ── Escaping the ESM-mock-hoist trap ───────────────────────────────────────
// The previously-skipped tests mocked verifyToken, but jest.unstable_mockModule
// did not reach the copy of jwtUtils transitively imported by wsServer, so the
// server silently rejected the fake token. This harness instead mints REAL
// short-lived JWT tickets with the REAL generateToken (carrying tenant_id +
// scope:'ws', exactly like POST /realtime/ticket) and lets the REAL verifyToken
// validate them — no verifyToken mock, no trap. Only tokenBlacklist is stubbed,
// to keep the harness free of a live revocation store (Redis/DB).

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import http from 'http';
import WebSocket from 'ws';

const realtimeAccess = {
  patients: new Set(),
  careTeam: new Set(),
  breakGlass: new Set(),
};

function realtimeRelationshipKey(tenantId, patientUid, actorUid) {
  return `${tenantId}:${patientUid}:${actorUid}`.toLowerCase();
}

// Stub ONLY the revocation store so the harness doesn't need a live Redis/DB.
// verifyToken/generateToken are the REAL implementations (the whole point — see
// header). Set up before any dynamic import below.
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  isTokenBlacklisted: async () => false,
  isDelegatedTupleRevoked: async () => false,
  isUserTokensRevoked: async () => false,
  RevocationCheckUnavailableError: class extends Error {},
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $transaction: async (fn) => fn({
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async (sql, uid) => {
        if (String(sql).includes('FROM users dep')) {
          return [{
            uid,
            role: 'PATIENT',
            is_minor: true,
            is_minor_now: true,
            is_active: true,
            status: 'active',
            is_deleted: false,
            deleted_at: null,
            merged_into_uid: null,
            guardian_role: 'PATIENT',
            guardian_is_active: true,
            guardian_status: 'active',
            guardian_is_deleted: false,
            guardian_deleted_at: null,
            guardian_merged_into_uid: null,
          }];
        }
        if (String(sql).includes('FROM users')) return [];
        if (String(sql).includes('FROM admins')) {
          return [{ uid, tenant_id: null, is_active: true, status: 'active' }];
        }
        return [];
      },
    }),
  },
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  authorizePatientAccessRequest: async (req, { patient }) => {
    const tenantId = req.tenantId || req.user?.tenant_id;
    const patientUid = patient?.uid;
    const patientKey = `${tenantId}:${patientUid}`.toLowerCase();
    if (!realtimeAccess.patients.has(patientKey)) {
      return { allowed: false, no_patient_context: true };
    }
    if (req.user?.role === 'PATIENT'
      && String(req.user?.uid).toLowerCase() === String(patientUid).toLowerCase()) {
      return { allowed: true, accessSource: 'guardian' };
    }
    const actorUid = req.acting?.actorUid || req.user?.uid;
    const relationshipKey = realtimeRelationshipKey(tenantId, patientUid, actorUid);
    if (realtimeAccess.breakGlass.has(relationshipKey)) {
      return { allowed: true, accessSource: 'break_glass' };
    }
    if (realtimeAccess.careTeam.has(relationshipKey)) {
      return { allowed: true, accessSource: 'care_team' };
    }
    return { allowed: false, accessSource: 'unknown' };
  },
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordWsBroadcastDropped: jest.fn(),
  recordWsFanoutSubscriberError: jest.fn(),
}));

const { generateToken } = await import('../../utils/jwtUtils.js');
const { authorizeChannel } = await import('../../utils/websocket/channelAuth.js');

// Two tenants, valid-UUID uids (so any incidental uid→users lookup is clean).
const TENANT_1 = 'fa11ed00-0000-4000-8000-0000000000a1';
const TENANT_2 = 'fa11ed00-0000-4000-8000-0000000000a2';

function ticket({ uid, role = 'NURSING_STAFF', tenantId, ...claims }) {
  return generateToken(
    { uid, role, tenant_id: tenantId, tenantId, scope: 'ws', ...claims },
    '120s',
  );
}

// ── Shared in-memory pub/sub bus ───────────────────────────────────────────
// Implements the psubscribe/publish/pmessage/punsubscribe/on/off/duplicate
// surface the adapter calls. ONE instance is shared by both wsServer realms, so
// a publish in realm A reaches realm B's pattern subscriber.
function createFakeRedisBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const subscribers = []; // { client, pattern, handler }

  function matches(pattern, channel) {
    // Only 'ws:*' is used; translate the glob to a prefix match.
    if (pattern.endsWith('*')) return channel.startsWith(pattern.slice(0, -1));
    return pattern === channel;
  }

  function makeClient() {
    const client = new EventEmitter();
    client.psubscribe = async (pattern) => {
      // Idempotent: re-subscribing the same pattern (e.g. the adapter's
      // 'ready'-driven re-assert after a reconnect) must not stack handlers,
      // or a single publish would be delivered N times.
      if (subscribers.some((s) => s.client === client && s.pattern === pattern)) return 1;
      const handler = (channel, message) => {
        if (matches(pattern, channel)) client.emit('pmessage', pattern, channel, message);
      };
      subscribers.push({ client, pattern, handler });
      emitter.on('publish', handler);
      return 1;
    };
    client.punsubscribe = async (pattern) => {
      for (let i = subscribers.length - 1; i >= 0; i--) {
        const s = subscribers[i];
        if (s.client === client && (pattern === undefined || s.pattern === pattern)) {
          emitter.off('publish', s.handler);
          subscribers.splice(i, 1);
        }
      }
      return 1;
    };
    client.publish = (channel, message) => {
      emitter.emit('publish', channel, message);
      return 1;
    };
    client.duplicate = () => makeClient();
    client.quit = async () => {
      await client.punsubscribe();
      client.removeAllListeners();
    };
    // Mirror ioredis: emit 'ready' once shortly after construction so the
    // adapter's 'ready'-driven re-subscribe path is exercised. The psubscribe
    // idempotency guard above keeps this from stacking handlers.
    setImmediate(() => client.emit('ready'));
    return client;
  }

  return makeClient();
}

// ── Spin up an independent wsServer realm (= one "process") ─────────────────
let realmSeq = 0;
async function startProcess(bus) {
  realmSeq += 1;
  // Cache-busting query → a fresh, isolated wsServer module instance.
  const wsMod = await import(`../../utils/websocket/wsServer.js?proc=${realmSeq}`);
  const server = http.createServer();
  wsMod.initWebSocket(server);
  // Wire this realm's fan-out to the SHARED bus. pub = a bus client; sub = a
  // duplicate (its own subscriber connection), mirroring redis.duplicate().
  const pub = bus;
  await wsMod.initWsFanout({ pub, sub: pub.duplicate() });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { wsMod, server, port };
}

function connect(port, token) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
}

/** Resolve once `ws` emits an event matching `predicate`; reject on timeout. */
function awaitEvent(ws, predicate, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timeout waiting for event'));
    }, timeoutMs);
    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      } catch (_) {/* ignore non-JSON frames */}
    }
    ws.on('message', onMessage);
  });
}

/** Assert NO event matching `predicate` arrives within `windowMs` (negative). */
function expectNoEvent(ws, predicate, { windowMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, windowMs);
    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          reject(new Error('received an event that should NOT have been delivered'));
        }
      } catch (_) {/* ignore */}
    }
    ws.on('message', onMessage);
  });
}

function awaitClose(ws, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('close', onClose);
      reject(new Error('timeout waiting for socket close'));
    }, timeoutMs);
    function onClose(code, reason) {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    }
    ws.once('close', onClose);
  });
}

async function openAndConnect(port, token) {
  const ws = connect(port, token);
  // Attach the 'connected'-waiter BEFORE awaiting open so we never miss the
  // welcome frame the server sends immediately on auth (it can arrive in the
  // same tick as 'open'). Also surface an early server-side close (auth reject)
  // as a clear failure instead of a generic timeout.
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for connected'));
    }, 2000);
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`socket closed before 'connected' (${code} ${reason})`));
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onMessage = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.event === 'connected') {
          cleanup();
          resolve(ws);
        }
      } catch (_) {/* ignore */}
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
  return connected;
}

async function subscribe(ws, channel) {
  ws.send(JSON.stringify({ action: 'subscribe', channel }));
  await awaitEvent(ws, (m) => m.event === 'subscribed' && m.channel === channel);
}

// ───────────────────────────────────────────────────────────────────────────
// Static channel-authorization contract (no sockets).
// ───────────────────────────────────────────────────────────────────────────
describe('channel authorization contract', () => {
  test('denies unscoped admin subscribe for non-admin', () => {
    const allowed = authorizeChannel('admin:kpi', { role: 'PATIENT', userId: '42' });
    expect(allowed.allowed).toBe(false);
    expect(allowed.reason).toMatch(/admin/i);
  });

  test('patient:<userId>:... static authorization never grants another subject', () => {
    const patientUid = '11111111-1111-4111-8111-111111111111';
    const actorUid = '22222222-2222-4222-8222-222222222222';
    expect(authorizeChannel(`patient:${patientUid}:queue`, {
      role: 'PATIENT',
      userId: patientUid,
    }).allowed).toBe(true);
    expect(authorizeChannel(`patient:${patientUid}:queue`, { role: 'PATIENT', userId: actorUid }).allowed).toBe(false);
    expect(authorizeChannel(`patient:${patientUid}:queue`, { role: 'DOCTOR', userId: actorUid }).allowed).toBe(false);
    expect(authorizeChannel(`patient:${patientUid}:queue`, { role: 'ADMIN', userId: actorUid }).allowed).toBe(false);
    expect(authorizeChannel(`patient:${patientUid}:queue`, { role: 'SUPER_ADMIN', userId: actorUid }).allowed).toBe(false);
  });

  test('staff:code-blue is gated to staff roles', () => {
    expect(authorizeChannel('staff:code-blue', { role: 'PATIENT', userId: '42' }).allowed).toBe(false);
    expect(authorizeChannel('staff:code-blue', { role: 'NURSING_STAFF', userId: '77' }).allowed).toBe(true);
  });

  test('legacy global channels are gated to staff roles', () => {
    expect(authorizeChannel('appointment-updates', { role: 'PATIENT', userId: '42' }).allowed).toBe(false);
    expect(authorizeChannel('appointment-updates', { role: 'RECEPTIONIST', userId: '77' }).allowed).toBe(true);
    expect(authorizeChannel('queue-updates', { role: 'PATIENT', userId: '42' }).allowed).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cross-process differential-delivery harness (the Gap-2 instrument).
// ───────────────────────────────────────────────────────────────────────────
describe('cross-process realtime fan-out (Redis pub/sub)', () => {
  let bus;
  let procA;
  let procB;
  const sockets = [];

  beforeEach(async () => {
    realtimeAccess.patients.clear();
    realtimeAccess.careTeam.clear();
    realtimeAccess.breakGlass.clear();
    bus = createFakeRedisBus();
    procA = await startProcess(bus);
    procB = await startProcess(bus);
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try { ws.close(); } catch (_) {/* noop */}
    }
    // Tear down fan-out subscribers, then WS servers, then HTTP servers.
    await procA.wsMod.closeWsFanout();
    await procB.wsMod.closeWsFanout();
    await procA.wsMod.closeWebSocket();
    await procB.wsMod.closeWebSocket();
    await new Promise((r) => procA.server.close(r));
    await new Promise((r) => procB.server.close(r));
    try { await bus.quit(); } catch (_) {/* noop */}
  });

  // ★ CORE RED→GREEN: a broadcast on process A must reach a client on process B.
  // Against the old in-process-only broadcast, client-2 (on B) gets nothing.
  test('broadcast on process A reaches a same-tenant client on process B', async () => {
    const uidA = 'fa11ed00-0000-4000-8000-000000000001';
    const uidB = 'fa11ed00-0000-4000-8000-000000000002';
    const c1 = await openAndConnect(procA.port, ticket({ uid: uidA, tenantId: TENANT_1 }));
    const c2 = await openAndConnect(procB.port, ticket({ uid: uidB, tenantId: TENANT_1 }));
    sockets.push(c1, c2);

    await subscribe(c1, 'staff:code-blue');
    await subscribe(c2, 'staff:code-blue');

    const [r1, r2] = await Promise.all([
      awaitEvent(c1, (m) => m.event === 'staff:code-blue'),
      awaitEvent(c2, (m) => m.event === 'staff:code-blue'),
      Promise.resolve().then(() =>
        procA.wsMod.broadcast(
          'staff:code-blue',
          { kind: 'code-blue', patientId: '42', ward: '3W' },
          { tenantId: TENANT_1 },
        ),
      ),
    ]);
    expect(r1.data.kind).toBe('code-blue');
    expect(r2.data.kind).toBe('code-blue'); // ← the cross-process assertion
    expect(r2.data.ward).toBe('3W');
  });

  // Cross-tenant isolation: a tenant-1 broadcast must NOT reach a tenant-2 socket
  // on the same global channel, even cross-process.
  test('a tenant-1 broadcast does NOT reach a tenant-2 socket on the same channel', async () => {
    const uidT1 = 'fa11ed00-0000-4000-8000-000000000011';
    const uidT2 = 'fa11ed00-0000-4000-8000-000000000012';
    const t1 = await openAndConnect(procA.port, ticket({ uid: uidT1, tenantId: TENANT_1 }));
    const t2 = await openAndConnect(procB.port, ticket({ uid: uidT2, tenantId: TENANT_2 }));
    sockets.push(t1, t2);

    await subscribe(t1, 'staff:beds');
    await subscribe(t2, 'staff:beds');

    const t1Received = awaitEvent(t1, (m) => m.event === 'staff:beds');
    const t2Silent = expectNoEvent(t2, (m) => m.event === 'staff:beds');

    procA.wsMod.broadcast(
      'staff:beds',
      { kind: 'patient-admitted', status: 'OCCUPIED' },
      { tenantId: TENANT_1 },
    );

    const r1 = await t1Received;
    expect(r1.data.kind).toBe('patient-admitted');
    await t2Silent; // tenant-2 must have received nothing
  });

  test('patient channel acknowledgement enforces governed relationships and tenant isolation', async () => {
    const patientUid = 'fa11ed00-0000-4000-8000-000000000013';
    const guardianUid = 'fa11ed00-0000-4000-8000-000000000014';
    const clinicianUid = 'fa11ed00-0000-4000-8000-000000000015';
    const careTeamUid = 'fa11ed00-0000-4000-8000-000000000016';
    const breakGlassUid = 'fa11ed00-0000-4000-8000-000000000017';
    const channel = `patient:${patientUid}:appointments`;
    realtimeAccess.patients.add(`${TENANT_1}:${patientUid}`.toLowerCase());
    realtimeAccess.patients.add(`${TENANT_2}:${patientUid}`.toLowerCase());
    realtimeAccess.careTeam.add(realtimeRelationshipKey(TENANT_1, patientUid, careTeamUid));
    realtimeAccess.breakGlass.add(realtimeRelationshipKey(TENANT_1, patientUid, breakGlassUid));
    const owner = await openAndConnect(procB.port, ticket({
      uid: patientUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
    }));
    const delegatedSubject = await openAndConnect(procB.port, ticket({
      uid: patientUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
      revocationOwnerUid: guardianUid,
    }));
    const unrelatedClinician = await openAndConnect(procB.port, ticket({
      uid: clinicianUid,
      role: 'DOCTOR',
      tenantId: TENANT_1,
    }));
    const careTeamClinician = await openAndConnect(procB.port, ticket({
      uid: careTeamUid,
      role: 'DOCTOR',
      tenantId: TENANT_1,
    }));
    const breakGlassAdmin = await openAndConnect(procB.port, ticket({
      uid: breakGlassUid,
      role: 'ADMIN',
      tenantId: TENANT_1,
    }));
    const otherTenantSameSubject = await openAndConnect(procB.port, ticket({
      uid: patientUid,
      role: 'PATIENT',
      tenantId: TENANT_2,
    }));
    sockets.push(
      owner,
      delegatedSubject,
      unrelatedClinician,
      careTeamClinician,
      breakGlassAdmin,
      otherTenantSameSubject,
    );

    await subscribe(owner, channel);
    await subscribe(delegatedSubject, channel);
    await subscribe(careTeamClinician, channel);
    await subscribe(breakGlassAdmin, channel);
    await subscribe(otherTenantSameSubject, channel);

    const denied = awaitEvent(
      unrelatedClinician,
      (message) => message.event === 'subscribe-denied' && message.channel === channel,
    );
    const deniedAck = expectNoEvent(
      unrelatedClinician,
      (message) => message.event === 'subscribed' && message.channel === channel,
    );
    unrelatedClinician.send(JSON.stringify({ action: 'subscribe', channel }));
    await expect(denied).resolves.toMatchObject({
      event: 'subscribe-denied',
      channel,
      reason: 'Patient channel access denied',
    });
    await deniedAck;

    const ownerDelivery = awaitEvent(owner, (message) => message.event === channel);
    const delegatedDelivery = awaitEvent(
      delegatedSubject,
      (message) => message.event === channel,
    );
    const careTeamDelivery = awaitEvent(
      careTeamClinician,
      (message) => message.event === channel,
    );
    const breakGlassDelivery = awaitEvent(
      breakGlassAdmin,
      (message) => message.event === channel,
    );
    const clinicianSilent = expectNoEvent(
      unrelatedClinician,
      (message) => message.event === channel,
    );
    const otherTenantSilent = expectNoEvent(
      otherTenantSameSubject,
      (message) => message.event === channel,
    );

    procA.wsMod.broadcast(
      channel,
      { appointmentId: '42', status: 'CONFIRMED' },
      { tenantId: TENANT_1 },
    );

    await expect(ownerDelivery).resolves.toMatchObject({
      data: { appointmentId: '42', status: 'CONFIRMED' },
    });
    await expect(delegatedDelivery).resolves.toMatchObject({
      data: { appointmentId: '42', status: 'CONFIRMED' },
    });
    await expect(careTeamDelivery).resolves.toMatchObject({
      data: { appointmentId: '42', status: 'CONFIRMED' },
    });
    await expect(breakGlassDelivery).resolves.toMatchObject({
      data: { appointmentId: '42', status: 'CONFIRMED' },
    });
    await clinicianSilent;
    await otherTenantSilent;
  });

  test('patient channel delivery revalidates and evicts revoked care-team and break-glass access', async () => {
    const patientUid = 'fa11ed00-0000-4000-8000-000000000018';
    const careTeamUid = 'fa11ed00-0000-4000-8000-000000000019';
    const breakGlassUid = 'fa11ed00-0000-4000-8000-00000000001a';
    const appointmentsChannel = `patient:${patientUid}:appointments`;
    const queueChannel = `patient:${patientUid}:queue`;
    const careTeamKey = realtimeRelationshipKey(TENANT_1, patientUid, careTeamUid);
    const breakGlassKey = realtimeRelationshipKey(TENANT_1, patientUid, breakGlassUid);
    realtimeAccess.patients.add(`${TENANT_1}:${patientUid}`.toLowerCase());
    realtimeAccess.careTeam.add(careTeamKey);
    realtimeAccess.breakGlass.add(breakGlassKey);

    const careTeamClinician = await openAndConnect(procB.port, ticket({
      uid: careTeamUid,
      role: 'DOCTOR',
      tenantId: TENANT_1,
    }));
    const breakGlassAdmin = await openAndConnect(procB.port, ticket({
      uid: breakGlassUid,
      role: 'ADMIN',
      tenantId: TENANT_1,
    }));
    sockets.push(careTeamClinician, breakGlassAdmin);

    await subscribe(careTeamClinician, appointmentsChannel);
    await subscribe(breakGlassAdmin, queueChannel);

    // Authority is time/status bounded in production. Removing these live
    // relationships simulates care-team revocation and break-glass expiry
    // after the original ACK.
    realtimeAccess.careTeam.delete(careTeamKey);
    realtimeAccess.breakGlass.delete(breakGlassKey);

    const careTeamDenied = awaitEvent(
      careTeamClinician,
      (message) => message.event === 'subscribe-denied'
        && message.channel === appointmentsChannel,
    );
    const breakGlassDenied = awaitEvent(
      breakGlassAdmin,
      (message) => message.event === 'subscribe-denied'
        && message.channel === queueChannel,
    );
    const careTeamSilent = expectNoEvent(
      careTeamClinician,
      (message) => message.event === appointmentsChannel,
    );
    const breakGlassSilent = expectNoEvent(
      breakGlassAdmin,
      (message) => message.event === queueChannel,
    );

    procA.wsMod.broadcast(
      appointmentsChannel,
      { appointmentId: '51', status: 'CONFIRMED' },
      { tenantId: TENANT_1 },
    );
    procA.wsMod.broadcast(
      queueChannel,
      { appointmentId: '51', position: 2 },
      { tenantId: TENANT_1 },
    );

    await expect(careTeamDenied).resolves.toMatchObject({
      reason: 'Patient channel access denied',
    });
    await expect(breakGlassDenied).resolves.toMatchObject({
      reason: 'Patient channel access denied',
    });
    await careTeamSilent;
    await breakGlassSilent;

    // Restoring authority without a new subscribe must not restore delivery:
    // the failed revalidation must have evicted the old membership.
    realtimeAccess.careTeam.add(careTeamKey);
    realtimeAccess.breakGlass.add(breakGlassKey);
    const evictedCareTeamSilent = expectNoEvent(
      careTeamClinician,
      (message) => message.event === appointmentsChannel,
    );
    const evictedBreakGlassSilent = expectNoEvent(
      breakGlassAdmin,
      (message) => message.event === queueChannel,
    );
    procA.wsMod.broadcast(
      appointmentsChannel,
      { appointmentId: '51', status: 'IN_PROGRESS' },
      { tenantId: TENANT_1 },
    );
    procA.wsMod.broadcast(
      queueChannel,
      { appointmentId: '51', position: 1 },
      { tenantId: TENANT_1 },
    );
    await evictedCareTeamSilent;
    await evictedBreakGlassSilent;

    // Explicitly subscribing again after authority is restored remains valid.
    await subscribe(careTeamClinician, appointmentsChannel);
    await subscribe(breakGlassAdmin, queueChannel);
    const careTeamDelivery = awaitEvent(
      careTeamClinician,
      (message) => message.event === appointmentsChannel,
    );
    const breakGlassDelivery = awaitEvent(
      breakGlassAdmin,
      (message) => message.event === queueChannel,
    );
    procA.wsMod.broadcast(
      appointmentsChannel,
      { appointmentId: '51', status: 'COMPLETED' },
      { tenantId: TENANT_1 },
    );
    procA.wsMod.broadcast(
      queueChannel,
      { appointmentId: '51', position: 0 },
      { tenantId: TENANT_1 },
    );
    await expect(careTeamDelivery).resolves.toMatchObject({
      data: { appointmentId: '51', status: 'COMPLETED' },
    });
    await expect(breakGlassDelivery).resolves.toMatchObject({
      data: { appointmentId: '51', position: 0 },
    });
  });

  // sendToUser cross-process: a user connected on process B receives a
  // sendToUser issued on process A.
  test('sendToUser on process A reaches that user on process B', async () => {
    const uid = 'fa11ed00-0000-4000-8000-000000000021';
    // Same user connected on BOTH processes (multi-device / load-balanced).
    const onA = await openAndConnect(procA.port, ticket({ uid, role: 'PATIENT', tenantId: TENANT_1 }));
    const onB = await openAndConnect(procB.port, ticket({ uid, role: 'PATIENT', tenantId: TENANT_1 }));
    sockets.push(onA, onB);

    const got = awaitEvent(onB, (m) => m.event === 'queue-position');
    procA.wsMod.sendToUser(uid, 'queue-position', { position: 3, etaMinutes: 12 }, { tenantId: TENANT_1 });
    const r = await got;
    expect(r.data.position).toBe(3);
    expect(r.data.etaMinutes).toBe(12);
  });

  test('tuple revocation crosses processes and preserves guardian and sibling sockets', async () => {
    const guardianUid = 'fa11ed00-0000-4000-8000-000000000031';
    const dependentUid = 'fa11ed00-0000-4000-8000-000000000032';
    const siblingUid = 'fa11ed00-0000-4000-8000-000000000033';
    const delegated = await openAndConnect(procB.port, ticket({
      uid: dependentUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
      revocationOwnerUid: guardianUid,
    }));
    const sibling = await openAndConnect(procB.port, ticket({
      uid: siblingUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
      revocationOwnerUid: guardianUid,
    }));
    const guardian = await openAndConnect(procB.port, ticket({
      uid: guardianUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
    }));
    sockets.push(delegated, sibling, guardian);

    const revoked = awaitEvent(
      delegated,
      (m) => m.event === 'session:revoked' && m.data?.delegatedSubjectUid === dependentUid,
    );
    const siblingSilent = expectNoEvent(sibling, (m) => m.event === 'session:revoked');
    const guardianSilent = expectNoEvent(guardian, (m) => m.event === 'session:revoked');

    procA.wsMod.pushDelegatedSessionRevoked(guardianUid, dependentUid, {
      reason: 'dependent_unlinked',
    });

    await expect(revoked).resolves.toMatchObject({
      data: { reason: 'dependent_unlinked', delegatedSubjectUid: dependentUid },
    });
    await siblingSilent;
    await guardianSilent;
    expect(sibling.readyState).toBe(WebSocket.OPEN);
    expect(guardian.readyState).toBe(WebSocket.OPEN);
  });

  test('selectorless legacy revocation crosses processes and closes correlated direct and delegated tickets only', async () => {
    const guardianUid = 'fa11ed00-0000-4000-8000-000000000041';
    const dependentUid = 'fa11ed00-0000-4000-8000-000000000042';
    const siblingUid = 'fa11ed00-0000-4000-8000-000000000043';
    const accessSessionJti = 'legacy-access-session-jti';
    const direct = await openAndConnect(procB.port, ticket({
      uid: guardianUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
      accessSessionJti,
    }));
    const delegated = await openAndConnect(procB.port, ticket({
      uid: dependentUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
      revocationOwnerUid: guardianUid,
      accessSessionJti,
    }));
    const sibling = await openAndConnect(procB.port, ticket({
      uid: siblingUid,
      role: 'PATIENT',
      tenantId: TENANT_1,
      revocationOwnerUid: guardianUid,
      accessSessionJti: 'sibling-access-session-jti',
    }));
    sockets.push(direct, delegated, sibling);

    const directRevoked = awaitEvent(direct, (m) => m.event === 'session:revoked');
    const delegatedRevoked = awaitEvent(delegated, (m) => m.event === 'session:revoked');
    const directClosed = awaitClose(direct);
    const delegatedClosed = awaitClose(delegated);
    const siblingSilent = expectNoEvent(sibling, (m) => m.event === 'session:revoked');

    procA.wsMod.pushSessionRevoked(guardianUid, {
      reason: 'session_revoked',
      jti: accessSessionJti,
    });

    await expect(directRevoked).resolves.toMatchObject({
      data: { reason: 'session_revoked', jti: accessSessionJti },
    });
    await expect(delegatedRevoked).resolves.toMatchObject({
      data: { reason: 'session_revoked', jti: accessSessionJti },
    });
    await expect(directClosed).resolves.toEqual({ code: 4001, reason: 'Session revoked' });
    await expect(delegatedClosed).resolves.toEqual({ code: 4001, reason: 'Session revoked' });
    await siblingSilent;
    expect(sibling.readyState).toBe(WebSocket.OPEN);
  });
});
