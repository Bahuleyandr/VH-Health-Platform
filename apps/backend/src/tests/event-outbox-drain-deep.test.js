// src/tests/event-outbox-drain-deep.test.js
//
// GAP: the event_outbox table was written by ~40 publishEvent() call sites but
// NOTHING drained it — rows sat at status='pending' forever. This deep test
// proves the new drain (scheduler.drainEventOutbox + eventOutboxService.claim
// PendingEvents) claims a pending row, bridges it to a webhook_deliveries row
// (event_outbox_id FK) for every matching active subscription, and marks the
// outbox row delivered. The failure path marks the row failed with backoff;
// a backed-off row is not re-claimed before its available_at.
//
// Requires a reachable Postgres (DATABASE_URL / TEST_DATABASE_URL → the QA
// cluster). Skipped if none configured. No network egress: the drain only
// ENQUEUES webhook_deliveries rows (the separate webhook-delivery-dispatch cron
// owns the actual POST), so nothing here opens an outbound connection. We still
// mock the scheduler's send-path modules so the scheduler module graph links.

import { jest } from '@jest/globals';

const sendPushMock = jest.fn();
const sendSmsMock = jest.fn();

jest.unstable_mockModule('../utils/notifications/sendPushNotification.js', () => ({
  __esModule: true,
  sendPushNotification: sendPushMock,
}));
jest.unstable_mockModule('../services/smsService.js', () => ({
  __esModule: true,
  sendSMS: sendSmsMock,
  sendAppointmentConfirmationSMS: jest.fn(),
  sendAppointmentReminderSMS: jest.fn(),
  default: { sendSMS: sendSmsMock },
}));

const { drainEventOutbox } = await import('../utils/scheduler.js');
const { publishEvent, claimPendingEvents } = await import('../services/events/eventOutboxService.js');
const prisma = (await import('../lib/prisma.js')).default;

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function eventRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, attempts, available_at, last_error, delivered_at, tenant_id
     FROM event_outbox WHERE id = $1::bigint`,
    String(id),
  );
  return rows[0];
}

async function deliveriesForOutbox(id) {
  // event_outbox_id is BIGINT (mig 347) — bind as a string + cast ::bigint so a
  // value past JS Number's safe-int ceiling round-trips exactly.
  return prisma.$queryRawUnsafe(
    `SELECT id, subscription_id, event_outbox_id, event_type, status
     FROM webhook_deliveries WHERE event_outbox_id = $1::bigint`,
    String(id),
  );
}

d('event_outbox drain (deep)', () => {
  const insertedEventIds = [];
  let integrationId = null;
  let subscriptionId = null;
  // Unique event_type per run so this suite's subscription only matches THIS
  // suite's events (no cross-talk with other suites' webhook subscriptions).
  const EVENT_TYPE = `test.event_outbox_drain.${Date.now()}`;

  beforeAll(async () => {
    // Isolation: clear any stale pending/processing rows left by prior runs /
    // other suites so the bounded claim batch (limit) deterministically reaches
    // THIS suite's rows rather than being crowded out by older pending leftovers.
    // (These are orphan rows from the very bug this fix addresses — the outbox
    // was never drained, so the QA DB accumulates un-drained pending rows.)
    // Detach any deliveries that link to rows we're about to delete first.
    await prisma.$executeRawUnsafe(
      `UPDATE webhook_deliveries SET event_outbox_id = NULL
        WHERE event_outbox_id IN (SELECT id FROM event_outbox WHERE status IN ('pending','processing'))`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox WHERE status IN ('pending','processing')`,
    ).catch(() => {});

    // Seed an integration + an active webhook subscription for EVENT_TYPE so the
    // drain bridge has something to enqueue against. signing_algorithm='none'
    // avoids needing a signing credential.
    const integ = await prisma.$queryRawUnsafe(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2, 'webhook', 'active')
       RETURNING id`,
      DEFAULT_TENANT_ID, `test-outbox-drain-${Date.now()}`,
    );
    integrationId = integ[0].id;

    const sub = await prisma.$queryRawUnsafe(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, endpoint_url, signing_algorithm, is_active)
       VALUES ($1::uuid, $2, $3, 'https://example.test/hook', 'none', true)
       RETURNING id`,
      DEFAULT_TENANT_ID, integrationId, EVENT_TYPE,
    );
    subscriptionId = sub[0].id;
  });

  afterAll(async () => {
    if (insertedEventIds.length) {
      // ::bigint[] (not ::int[]) — the suite now seeds BigInt-range ids that
      // overflow int, and the FK column is BIGINT (mig 347). Bind as strings.
      await prisma.$executeRawUnsafe(
        `DELETE FROM webhook_deliveries WHERE event_outbox_id = ANY($1::bigint[])`,
        insertedEventIds.map(String),
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM event_outbox WHERE id = ANY($1::bigint[])`,
        insertedEventIds.map(String),
      ).catch(() => {});
    }
    if (subscriptionId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM webhook_subscriptions WHERE id = $1`, subscriptionId,
      ).catch(() => {});
    }
    if (integrationId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM integrations WHERE id = $1`, integrationId,
      ).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function seedEvent(overrides = {}) {
    const row = await publishEvent({
      eventType: EVENT_TYPE,
      aggregateType: 'test_aggregate',
      aggregateId: null,
      patientUid: null,
      payload: { kind: 'test', ...overrides.payload },
    });
    expect(row?.id).toBeTruthy();
    insertedEventIds.push(row.id);
    return row;
  }

  // Seed a pending row with an EXPLICIT id (bypassing the sequence) so we can
  // exercise the BigInt FK path without permanently advancing the shared
  // event_outbox sequence. The id is bound as a string + cast ::bigint so the
  // exact value lands in Postgres regardless of JS Number precision.
  async function seedEventWithId(explicitId) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox
         (id, event_type, aggregate_type, payload, status, available_at, created_at)
       VALUES ($1::bigint, $2, 'test_aggregate', $3::jsonb, 'pending', NOW(), NOW())
       RETURNING id`,
      String(explicitId), EVENT_TYPE, JSON.stringify({ kind: 'bigint-id' }),
    );
    insertedEventIds.push(rows[0].id);
    return rows[0];
  }

  describe('claimPendingEvents', () => {
    it('claims only pending rows with available_at<=now, flips them to processing, respects the limit', async () => {
      const a = await seedEvent();
      const b = await seedEvent();
      // A future-dated row must NOT be claimed.
      const future = await seedEvent();
      await prisma.$executeRawUnsafe(
        `UPDATE event_outbox SET available_at = NOW() + INTERVAL '1 hour' WHERE id = $1::bigint`,
        String(future.id),
      );

      const claimed = await claimPendingEvents(2);
      expect(claimed.length).toBe(2);
      for (const r of claimed) {
        expect(r.status).toBe('processing');
      }
      const claimedIds = claimed.map((r) => String(r.id));
      expect(claimedIds).not.toContain(String(future.id));

      // The two non-future rows are now 'processing'; the future row stays pending.
      const fa = await eventRow(future.id);
      expect(fa.status).toBe('pending');

      // a and b should be among the claimed set (only our 3 seeded; 2 claimed).
      const all = [String(a.id), String(b.id)];
      const intersect = claimedIds.filter((id) => all.includes(id));
      expect(intersect.length).toBeGreaterThanOrEqual(1);
    });

    it('is concurrency-safe: two concurrent claims return disjoint rows (SKIP LOCKED)', async () => {
      // Reset our pending rows back to pending so this test has a clean pool.
      await prisma.$executeRawUnsafe(
        `UPDATE event_outbox SET status='pending', available_at=NOW()
         WHERE id = ANY($1::bigint[]) AND status='processing'`,
        insertedEventIds.map(String),
      );
      // Ensure at least 4 pending rows available now.
      await seedEvent();
      await seedEvent();

      const [c1, c2] = await Promise.all([
        claimPendingEvents(10),
        claimPendingEvents(10),
      ]);
      const ids1 = new Set(c1.map((r) => String(r.id)));
      const ids2 = c2.map((r) => String(r.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false); // disjoint — no row claimed twice
      }
    });
  });

  describe('publishEvent (tx-aware)', () => {
    it('writes the outbox row inside a caller $transaction and rolls it back with the tx', async () => {
      let rolledBackId = null;
      // The producer's business tx fails AFTER publishing the event → the outbox
      // row must NOT survive (atomic with the business write). publishEvent must
      // re-throw inside a tx (never swallow) so the tx aborts.
      await expect(
        prisma.$transaction(async (tx) => {
          const row = await publishEvent({
            eventType: EVENT_TYPE,
            aggregateType: 'test_aggregate',
            payload: { kind: 'tx-rollback' },
            tx,
          });
          expect(row?.id).toBeTruthy();
          rolledBackId = row.id;
          throw new Error('business write failed after publishEvent');
        }),
      ).rejects.toThrow(/business write failed/);

      // The row was rolled back — it must not exist.
      const after = await eventRow(rolledBackId);
      expect(after).toBeUndefined();
    });
  });

  describe('drainEventOutbox', () => {
    beforeEach(() => {
      sendPushMock.mockReset();
      sendSmsMock.mockReset();
    });

    it('marks a pending event delivered AND enqueues a webhook_deliveries row bridged by event_outbox_id', async () => {
      // Reset pool to pending so the drain reaches this row.
      await prisma.$executeRawUnsafe(
        `UPDATE event_outbox SET status='pending', available_at=NOW()
         WHERE id = ANY($1::bigint[]) AND status='processing'`,
        insertedEventIds.map(String),
      );
      const ev = await seedEvent();

      const result = await drainEventOutbox({ limit: 100 });
      expect(result.claimed).toBeGreaterThanOrEqual(1);

      const row = await eventRow(ev.id);
      expect(row.status).toBe('delivered');
      expect(row.delivered_at).toBeTruthy();

      const deliveries = await deliveriesForOutbox(ev.id);
      expect(deliveries.length).toBe(1);
      expect(Number(deliveries[0].event_outbox_id)).toBe(Number(ev.id));
      expect(deliveries[0].event_type).toBe(EVENT_TYPE);
      expect(Number(deliveries[0].subscription_id)).toBe(Number(subscriptionId));
    });

    it('bridges a BigInt-range outbox id to webhook_deliveries with NO truncation', async () => {
      // Reset pool to pending so the drain reaches our row.
      await prisma.$executeRawUnsafe(
        `UPDATE event_outbox SET status='pending', available_at=NOW()
         WHERE id = ANY($1::bigint[]) AND status='processing'`,
        insertedEventIds.map(String),
      );
      // 2^53 + 1 — NOT representable as a JS Number (9007199254740992 === 9007199254740993
      // returns true), and far past Int's 2^31 ceiling. If event_outbox_id were still
      // INTEGER the INSERT would overflow (22003); if the service still Number.parseInt'd
      // the id, the stored value would be rounded — both regressions this asserts against.
      const BIG_ID = '9007199254740993';
      const ev = await seedEventWithId(BIG_ID);
      expect(String(ev.id)).toBe(BIG_ID);

      const result = await drainEventOutbox({ limit: 100 });
      expect(result.claimed).toBeGreaterThanOrEqual(1);

      const row = await eventRow(BIG_ID);
      expect(row.status).toBe('delivered');

      const deliveries = await deliveriesForOutbox(BIG_ID);
      expect(deliveries.length).toBe(1);
      // Exact, precision-safe comparison: the stored FK must equal the BigInt id
      // verbatim. Compare as strings — Number() would itself lose precision here.
      expect(String(deliveries[0].event_outbox_id)).toBe(BIG_ID);
      expect(deliveries[0].event_type).toBe(EVENT_TYPE);
    });

    it('failure path: a delivery that throws marks the event failed with attempts bumped + backoff', async () => {
      const ev = await seedEvent();
      // Force the bridge to throw via the injectable enqueueImpl seam.
      const throwingEnqueue = jest.fn().mockRejectedValue(new Error('bridge boom'));

      await drainEventOutbox({ limit: 100, enqueueImpl: throwingEnqueue });

      const row = await eventRow(ev.id);
      expect(Number(row.attempts)).toBe(1);
      expect(row.last_error).toMatch(/bridge boom/);
      // Not a terminal 'failed' on the first attempt — backed off to pending so
      // it retries after available_at; available_at pushed into the future.
      expect(['pending', 'failed']).toContain(row.status);
      expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('does NOT re-claim a backed-off row before its available_at', async () => {
      // Seed a row, fail it (backoff), then drain again immediately — it must be
      // skipped (attempts stays 1) because available_at is in the future.
      const ev = await seedEvent();
      const throwingEnqueue = jest.fn().mockRejectedValue(new Error('first failure'));
      await drainEventOutbox({ limit: 100, enqueueImpl: throwingEnqueue });
      const afterFirst = await eventRow(ev.id);
      expect(Number(afterFirst.attempts)).toBe(1);

      // Second drain — this row is backed off, must not be re-attempted.
      // (enqueueDelivery is real now; if it WERE re-claimed it would succeed and
      // flip to delivered. We assert it stayed failed/pending with attempts=1.)
      await drainEventOutbox({ limit: 100 });
      const afterSecond = await eventRow(ev.id);
      expect(Number(afterSecond.attempts)).toBe(1); // unchanged — not re-claimed
      expect(afterSecond.status).not.toBe('delivered');
    });
  });
});
