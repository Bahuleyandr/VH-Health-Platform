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
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

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
const { pathwayProjectorRegistry } = await import('../services/events/pathwayProjectorRegistry.js');
const {
  claimDueInboxRows,
  materializeMissingInboxRows,
  processClaimedInboxRow,
} = await import('../services/events/pathwayProjectorService.js');
const prisma = (await import('../lib/prisma.js')).default;

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SUITE_LOCK_KEY = '57820260718';

async function eventRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, attempts, available_at::text, last_error,
            delivered_at::text, tenant_id
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
  let suiteLockClient = null;
  // Unique event_type per run so this suite's subscription only matches THIS
  // suite's events (no cross-talk with other suites' webhook subscriptions).
  const EVENT_TYPE = `test.event_outbox_drain.${Date.now()}`;
  const PATHWAY_CONSUMER = `s1a_webhook_coexistence_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    suiteLockClient = new Client({
      connectionString: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL,
    });
    await suiteLockClient.connect();
    await suiteLockClient.query('SELECT pg_advisory_lock($1::bigint)', [SUITE_LOCK_KEY]);

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
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox WHERE consumer_key = $1`,
        PATHWAY_CONSUMER,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM event_consumer_offsets WHERE consumer_key = $1`,
        PATHWAY_CONSUMER,
      );
      if (insertedEventIds.length) {
        // ::bigint[] (not ::int[]) — the suite now seeds BigInt-range ids that
        // overflow int, and the FK column is BIGINT (mig 347). Bind as strings.
        await prisma.$executeRawUnsafe(
          `DELETE FROM pathway_projector_inbox WHERE event_id = ANY($1::bigint[])`,
          insertedEventIds.map(String),
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM webhook_deliveries WHERE event_outbox_id = ANY($1::bigint[])`,
          insertedEventIds.map(String),
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM event_outbox WHERE id = ANY($1::bigint[])`,
          insertedEventIds.map(String),
        );
      }
      if (subscriptionId) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM webhook_subscriptions WHERE id = $1`, subscriptionId,
        );
      }
      if (integrationId) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM integrations WHERE id = $1`, integrationId,
        );
      }
    } finally {
      try {
        if (suiteLockClient) {
          await suiteLockClient.query('SELECT pg_advisory_unlock($1::bigint)', [SUITE_LOCK_KEY]);
        }
      } finally {
        await suiteLockClient?.end();
        await prisma.$disconnect();
      }
    }
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
       VALUES ($1::bigint, $2, 'test_aggregate', $3::jsonb, 'pending',
                NOW(), NOW())
       RETURNING id`,
      String(explicitId), EVENT_TYPE, JSON.stringify({ kind: 'bigint-id' }),
    );
    insertedEventIds.push(rows[0].id);
    return rows[0];
  }

  async function stageOwnedClaimTargets(events, { preserveEvents = [] } = {}) {
    const targetIds = events.map((event) => String(event.id));
    const preserveIds = preserveEvents.map((event) => String(event.id));
    await prisma.$executeRawUnsafe(
      `UPDATE event_outbox
          SET available_at = CASE
            WHEN id = ANY($1::bigint[]) THEN TIMESTAMPTZ '0001-01-01 00:00:00+00'
            ELSE TIMESTAMPTZ '2999-01-01 00:00:00+00'
          END
        WHERE id = ANY($2::bigint[])
          AND id <> ALL($3::bigint[])
          AND status = 'pending'`,
      targetIds,
      insertedEventIds.map(String),
      preserveIds,
    );
  }

  async function claimOwnedPendingEvents(events, limit) {
    const eventIdList = events.map((event) => String(event.id));
    const leaseOwner = randomUUID();
    return prisma.$queryRawUnsafe(
      `UPDATE event_outbox
          SET status = 'processing',
              attempts = attempts + 1,
              lease_owner = $3::uuid,
              lease_expires_at = NOW() + INTERVAL '2 minutes'
        WHERE id IN (
          SELECT id
            FROM event_outbox
           WHERE id = ANY($1::bigint[])
             AND status = 'pending'
             AND available_at <= NOW()
           ORDER BY available_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2::integer
        )
        RETURNING id, event_type, aggregate_type, aggregate_id, patient_uid,
                  payload, status, attempts, available_at, tenant_id,
                  lease_owner, lease_expires_at`,
      eventIdList,
      limit,
      leaseOwner,
    );
  }

  async function drainOwnedEvents(events, options = {}) {
    return drainEventOutbox({
      ...options,
      limit: events.length,
      claimImpl: ({ limit }) => claimOwnedPendingEvents(events, limit),
    });
  }

  async function primePathwayConsumer() {
    for (let batch = 0; batch < 500; batch += 1) {
      const rows = await materializeMissingInboxRows({
        consumerKey: PATHWAY_CONSUMER,
        generation: 1,
        limit: 200,
      });
      if (rows.completed) {
        await prisma.$executeRawUnsafe(
          `UPDATE pathway_projector_inbox
              SET status = 'ignored', outcome_at = COALESCE(outcome_at, NOW())
            WHERE consumer_key = $1 AND generation = 1 AND status = 'pending'`,
          PATHWAY_CONSUMER,
        );
        return;
      }
    }
    throw new Error('S1a webhook coexistence baseline exceeded 100000 rows');
  }

  async function materializePathwayEvent(eventId) {
    for (let batch = 0; batch < 500; batch += 1) {
      await materializeMissingInboxRows({
        consumerKey: PATHWAY_CONSUMER,
        generation: 1,
        limit: 200,
      });
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_id::text
           FROM pathway_projector_inbox
          WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
        PATHWAY_CONSUMER,
        String(eventId),
      );
      if (rows.length === 1) return;
    }
    throw new Error('S1a webhook coexistence event was not materialized');
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
      await stageOwnedClaimTargets([a, b], { preserveEvents: [future] });

      const claimed = await claimPendingEvents({ limit: 2 });
      expect(claimed).toHaveLength(2);
      for (const r of claimed) {
        expect(r.status).toBe('processing');
      }
      const claimedIds = claimed.map((r) => String(r.id));
      expect(new Set(claimedIds)).toEqual(new Set([String(a.id), String(b.id)]));

      // The two non-future rows are now 'processing'; the future row stays pending.
      const fa = await eventRow(future.id);
      expect(fa.status).toBe('pending');
    });

    it('is concurrency-safe: two concurrent claims return disjoint rows (SKIP LOCKED)', async () => {
      const targets = await Promise.all(Array.from({ length: 4 }, () => seedEvent()));
      await stageOwnedClaimTargets(targets);

      const [c1, c2] = await Promise.all([
        claimPendingEvents({ limit: 2 }),
        claimPendingEvents({ limit: 2 }),
      ]);
      expect(c1).toHaveLength(2);
      expect(c2).toHaveLength(2);
      const ids1 = new Set(c1.map((r) => String(r.id)));
      const ids2 = c2.map((r) => String(r.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false); // disjoint — no row claimed twice
      }
      const combinedIds = [...ids1, ...ids2];
      const targetIds = targets.map((event) => String(event.id));
      expect(new Set(combinedIds)).toEqual(new Set(targetIds));
      expect(combinedIds.every((id) => insertedEventIds.map(String).includes(id))).toBe(true);
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

    it('keeps webhook-owned outbox state and deliveries unchanged until the existing drain runs', async () => {
      await primePathwayConsumer();
      const event = await seedEvent({ payload: { coexistence: true } });
      const beforeSource = await eventRow(event.id);
      const beforeDeliveries = await deliveriesForOutbox(event.id);

      await materializePathwayEvent(event.id);
      const claims = await claimDueInboxRows({
        consumerKey: PATHWAY_CONSUMER,
        generation: 1,
        limit: 1,
        leaseOwner: randomUUID(),
      });
      expect(claims).toHaveLength(1);
      expect(String(claims[0].event_id)).toBe(String(event.id));
      const outcome = await processClaimedInboxRow({
        claim: claims[0],
        registry: pathwayProjectorRegistry,
      });
      expect(outcome.status).toBe('ignored');

      expect(await eventRow(event.id)).toEqual(beforeSource);
      expect(await deliveriesForOutbox(event.id)).toEqual(beforeDeliveries);

      await stageOwnedClaimTargets([event]);
      const drained = await drainOwnedEvents([event]);
      expect(drained.claimed).toBe(1);
      expect((await eventRow(event.id)).status).toBe('delivered');
      const deliveries = await deliveriesForOutbox(event.id);
      expect(deliveries).toHaveLength(1);
      expect(String(deliveries[0].event_outbox_id)).toBe(String(event.id));
    });

    it('marks a pending event delivered AND enqueues a webhook_deliveries row bridged by event_outbox_id', async () => {
      const ev = await seedEvent();
      await stageOwnedClaimTargets([ev]);

      const result = await drainOwnedEvents([ev]);
      expect(result.claimed).toBe(1);

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
      // Above Number.MAX_SAFE_INTEGER and intentionally distinct from the
      // pathway-delivery suite's fixed id. If event_outbox_id were still INTEGER
      // the INSERT would overflow (22003); Number coercion would round the value.
      const BIG_ID = '9007199254740995';
      const ev = await seedEventWithId(BIG_ID);
      expect(String(ev.id)).toBe(BIG_ID);
      await stageOwnedClaimTargets([ev]);

      const result = await drainOwnedEvents([ev]);
      expect(result.claimed).toBe(1);

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
      await stageOwnedClaimTargets([ev]);
      const throwingCompletion = jest.fn().mockRejectedValue(new Error('bridge boom'));

      const result = await drainOwnedEvents([ev], { completeImpl: throwingCompletion });
      expect(result.claimed).toBe(1);

      const row = await eventRow(ev.id);
      expect(Number(row.attempts)).toBe(1);
      expect(row.last_error).toMatch(/bridge boom/);
      // Not a terminal 'failed' on the first attempt — backed off to pending so
      // it retries after available_at; available_at pushed into the future.
      expect(row.status).toBe('pending');
      expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('does NOT re-claim a backed-off row before its available_at', async () => {
      // Seed a row, fail it (backoff), then drain again immediately — it must be
      // skipped (attempts stays 1) because available_at is in the future.
      const ev = await seedEvent();
      await stageOwnedClaimTargets([ev]);
      const throwingCompletion = jest.fn().mockRejectedValue(new Error('first failure'));
      const firstDrain = await drainOwnedEvents([ev], { completeImpl: throwingCompletion });
      expect(firstDrain.claimed).toBe(1);
      const afterFirst = await eventRow(ev.id);
      expect(Number(afterFirst.attempts)).toBe(1);

      const control = await seedEvent();
      await stageOwnedClaimTargets([control], { preserveEvents: [ev] });
      const secondDrain = await drainOwnedEvents([control]);
      expect(secondDrain.claimed).toBe(1);
      expect((await eventRow(control.id)).status).toBe('delivered');
      const afterSecond = await eventRow(ev.id);
      expect(afterSecond).toEqual(afterFirst);
    });
  });
});
