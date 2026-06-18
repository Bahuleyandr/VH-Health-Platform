// C-4 (interop) — cross-replica HMAC replay store.
//
// signedRequest.js used a per-PROCESS Map for replay protection, which the
// 3-replica × CLUSTER_WORKERS cluster defeats: a captured, still-fresh signed
// request replayed against a DIFFERENT process is not in that process's empty
// Map and is accepted again.
//
// This proves the SHARED store (DB-backed migration 321 here; Redis SET NX EX
// when wired) rejects a replay even when the in-process Map is empty — i.e.
// when the second attempt lands on a "different process". We simulate the
// second process by clearing the in-memory replayCache between the two
// attempts, so ONLY the shared store can catch the replay.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL). Self-skips when
// unconfigured.

import crypto from 'crypto';

import prisma from '../lib/prisma.js';
import {
  verifySignedRequest,
  assertSharedReplayOnce,
  __testing__,
} from '../utils/signedRequest.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SECRET = 'interop-replay-test-secret';
const NS = 'interop-replay-test';

function sign({ secret, timestamp, requestId, payload }) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${body}`)
    .digest('hex');
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM interop_replay_guard WHERE namespace = $1`, NS,
  ).catch(() => {});
}

d('interop shared replay store (C-4)', () => {
  beforeEach(async () => {
    __testing__.replayCache.clear();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('rejects a replay across two processes (in-memory Map empty on the 2nd)', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = `rid-${Date.now()}`;
    const payload = 'MSH|^~\\&|VH';
    const signature = sign({ secret: SECRET, timestamp, requestId, payload });

    // --- Process 1 ---
    verifySignedRequest({
      secret: SECRET, signature, timestamp, requestId, payload, replayNamespace: NS,
    });
    await assertSharedReplayOnce({
      replayNamespace: NS, requestId, timestamp, signature,
    });

    // Simulate a SECOND, distinct process: its in-memory replay cache is empty.
    __testing__.replayCache.clear();

    // --- Process 2 (replay) --- the sync in-memory check now passes (empty
    // Map), so only the shared store can reject. It must.
    verifySignedRequest({
      secret: SECRET, signature, timestamp, requestId, payload, replayNamespace: NS,
    });
    await expect(
      assertSharedReplayOnce({ replayNamespace: NS, requestId, timestamp, signature }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/REPLAY/) });
  });

  test('persists exactly one guard row per replay tuple', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = `rid-once-${Date.now()}`;
    const signature = sign({ secret: SECRET, timestamp, requestId, payload: {} });

    await assertSharedReplayOnce({ replayNamespace: NS, requestId, timestamp, signature });
    // Second claim for the same id throws but must not create a second row.
    await expect(
      assertSharedReplayOnce({ replayNamespace: NS, requestId, timestamp, signature }),
    ).rejects.toBeTruthy();

    // The stored request_id is the composite replay tuple (id:ts:sig), matching
    // the in-memory key shape — query by the requestId prefix.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM interop_replay_guard
        WHERE namespace = $1 AND request_id LIKE $2`,
      NS, `${requestId}:%`,
    );
    expect(rows[0].n).toBe(1);
  });

  test('distinct request ids in the same namespace both succeed', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const ridA = `rid-a-${Date.now()}`;
    const ridB = `rid-b-${Date.now()}`;
    const sigA = sign({ secret: SECRET, timestamp, requestId: ridA, payload: {} });
    const sigB = sign({ secret: SECRET, timestamp, requestId: ridB, payload: {} });

    await expect(
      assertSharedReplayOnce({ replayNamespace: NS, requestId: ridA, timestamp, signature: sigA }),
    ).resolves.not.toThrow();
    await expect(
      assertSharedReplayOnce({ replayNamespace: NS, requestId: ridB, timestamp, signature: sigB }),
    ).resolves.not.toThrow();
  });
});
