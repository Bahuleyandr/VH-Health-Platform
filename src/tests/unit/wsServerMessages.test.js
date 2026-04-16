// src/tests/unit/wsServerMessages.test.js
//
// Unit tests for the app-level WebSocket message handlers added in the
// P1.3 realtime-hardening pass: ping/pong round-trip, resync-re-auth, and
// the new `ts` field on subscribe/unsubscribe acks. Tests exercise the
// message-routing logic via a stripped-down handler mirror so they don't
// need a live WebSocket server or jwt/db dependencies.
//
// The mirror replicates the message handler body from `wsServer.js`
// `ws.on('message', ...)` verbatim — keep in sync when the real handler
// changes. This approach matches the mirror-class pattern already used
// elsewhere in the repo (see `test/api_client_test.dart`).

import { jest } from '@jest/globals';

/**
 * Build a fake socket + a fake meta record. Returns a pair `{ ws, meta,
 * authorizeChannel }` where `ws.send` is a jest mock that captures every
 * outgoing frame as a parsed object.
 */
function makeFakeSocket({
  userId = 'u1',
  role = 'ADMIN',
  existingChannels = [],
  allow = true,
  reason = 'ok',
} = {}) {
  const sent = [];
  const ws = {
    isAlive: true,
    readyState: 1,
    send: jest.fn((raw) => { sent.push(JSON.parse(raw)); }),
  };
  const meta = { userId, role, channels: new Set(existingChannels) };
  const authorizeChannel = jest.fn(() => ({ allowed: allow, reason }));
  return { ws, meta, authorizeChannel, sent };
}

/**
 * Mirror of `wsServer.js` ws.on('message') body. Updating the real file
 * should be mirrored here; these tests pin the routing contract.
 */
function handle(raw, { ws, meta, authorizeChannel }) {
  try {
    const msg = JSON.parse(raw);
    if (msg.action === 'subscribe' && msg.channel) {
      if (!meta) return;
      const decision = authorizeChannel(msg.channel, { userId: meta.userId, role: meta.role });
      if (!decision.allowed) {
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
      meta?.channels.delete(msg.channel);
      ws.send(JSON.stringify({
        event: 'unsubscribed',
        channel: msg.channel,
        ts: Date.now(),
      }));
    } else if (msg.action === 'ping') {
      ws.isAlive = true;
      ws.send(JSON.stringify({
        event: 'pong',
        ts: typeof msg.ts === 'number' ? msg.ts : null,
        serverTs: Date.now(),
      }));
    } else if (msg.action === 'resync' && Array.isArray(msg.channels)) {
      if (!meta) return;
      for (const channel of msg.channels) {
        if (typeof channel !== 'string') continue;
        const decision = authorizeChannel(channel, { userId: meta.userId, role: meta.role });
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
    // malformed — ignore
  }
}

describe('wsServer message routing — app-level ping/pong', () => {
  test('responds to ping with pong echoing the client ts', () => {
    const ctx = makeFakeSocket();
    handle(JSON.stringify({ action: 'ping', ts: 12345 }), ctx);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].event).toBe('pong');
    expect(ctx.sent[0].ts).toBe(12345);
    expect(typeof ctx.sent[0].serverTs).toBe('number');
  });

  test('ping with no ts → pong ts=null (defensive)', () => {
    const ctx = makeFakeSocket();
    handle(JSON.stringify({ action: 'ping' }), ctx);
    expect(ctx.sent[0].event).toBe('pong');
    expect(ctx.sent[0].ts).toBeNull();
  });

  test('ping with non-numeric ts → pong ts=null (no echo of bad input)', () => {
    const ctx = makeFakeSocket();
    handle(JSON.stringify({ action: 'ping', ts: 'now' }), ctx);
    expect(ctx.sent[0].ts).toBeNull();
  });

  test('ping marks the socket alive (WS-frame heartbeat gate)', () => {
    const ctx = makeFakeSocket();
    ctx.ws.isAlive = false;
    handle(JSON.stringify({ action: 'ping', ts: 1 }), ctx);
    expect(ctx.ws.isAlive).toBe(true);
  });
});

describe('wsServer message routing — subscribe/unsubscribe acks', () => {
  test('subscribed events now carry a server ts field', () => {
    const ctx = makeFakeSocket();
    handle(JSON.stringify({ action: 'subscribe', channel: 'admin:kpi' }), ctx);
    expect(ctx.sent[0].event).toBe('subscribed');
    expect(ctx.sent[0].channel).toBe('admin:kpi');
    expect(typeof ctx.sent[0].ts).toBe('number');
    expect(ctx.meta.channels.has('admin:kpi')).toBe(true);
  });

  test('subscribe-denied still fires when authorization rejects + includes reason + ts', () => {
    const ctx = makeFakeSocket({ allow: false, reason: 'role-not-permitted' });
    handle(JSON.stringify({ action: 'subscribe', channel: 'admin:kpi' }), ctx);
    expect(ctx.sent[0].event).toBe('subscribe-denied');
    expect(ctx.sent[0].reason).toBe('role-not-permitted');
    expect(typeof ctx.sent[0].ts).toBe('number');
    expect(ctx.meta.channels.has('admin:kpi')).toBe(false);
  });

  test('unsubscribed ack also carries ts', () => {
    const ctx = makeFakeSocket({ existingChannels: ['staff:beds'] });
    handle(JSON.stringify({ action: 'unsubscribe', channel: 'staff:beds' }), ctx);
    expect(ctx.sent[0].event).toBe('unsubscribed');
    expect(ctx.sent[0].channel).toBe('staff:beds');
    expect(typeof ctx.sent[0].ts).toBe('number');
    expect(ctx.meta.channels.has('staff:beds')).toBe(false);
  });
});

describe('wsServer message routing — resync after reconnect', () => {
  test('resync re-authorizes every channel the client claims and acks each one', () => {
    const ctx = makeFakeSocket();
    handle(
      JSON.stringify({ action: 'resync', channels: ['admin:kpi', 'staff:beds', 'queue-position'] }),
      ctx,
    );
    expect(ctx.sent).toHaveLength(3);
    expect(ctx.sent.every((e) => e.event === 'subscribed')).toBe(true);
    expect(ctx.meta.channels.size).toBe(3);
  });

  test('resync drops channels the client lost access to since last session', () => {
    // Simulate an authorize function that denies exactly one channel.
    const ctx = makeFakeSocket();
    let calls = 0;
    ctx.authorizeChannel.mockImplementation((channel) => {
      calls++;
      if (channel === 'admin:kpi') return { allowed: false, reason: 'role-changed' };
      return { allowed: true, reason: 'ok' };
    });
    handle(
      JSON.stringify({ action: 'resync', channels: ['admin:kpi', 'staff:beds'] }),
      ctx,
    );
    expect(calls).toBe(2);
    const events = ctx.sent.map((e) => e.event);
    expect(events).toContain('subscribe-denied');
    expect(events).toContain('subscribed');
    expect(ctx.meta.channels.has('admin:kpi')).toBe(false);
    expect(ctx.meta.channels.has('staff:beds')).toBe(true);
  });

  test('resync tolerates non-string entries in the channels array', () => {
    const ctx = makeFakeSocket();
    handle(
      JSON.stringify({ action: 'resync', channels: ['admin:kpi', null, 42, 'staff:beds'] }),
      ctx,
    );
    // Only the two string entries should generate acks.
    expect(ctx.sent).toHaveLength(2);
  });

  test('malformed JSON is silently dropped (no crash, no send)', () => {
    const ctx = makeFakeSocket();
    handle('not-json{{', ctx);
    expect(ctx.sent).toHaveLength(0);
  });
});
