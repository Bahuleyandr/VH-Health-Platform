// src/tests/reliability-metrics.deep.test.js
// Proves collectReliabilityMetrics() reads the real reliability tables and that
// serializeReliabilityMetrics() reports the correct values. Seeds event_outbox
// (pending + failed/dead-letter), notification_outbox (PENDING), and
// webhook_deliveries (pending/failed/dead), and the canonical
// pathway_projector_inbox consumer (pending/leased/dead) with run-unique event
// IDs, runs the collector, and asserts the gauge values reflect AT LEAST the
// seeded rows (other suites may add rows, so assert >= seeded).
//
// Seed-column reconciliation (vs real QA schema):
//   event_outbox        — NOT-NULL-no-default cols = event_type, aggregate_type
//                         (MARK stashed in aggregate_type; cleanup filters it).
//   webhook_deliveries  — NOT-NULL-no-default cols = event_type, payload
//                         (MARK in event_type; payload added to the INSERT).
//   notification_outbox — NOT-NULL-no-default cols = type, title, body. MARK
//                         stashed in `type`; cleanup filters on `type`. The
//                         mig-609 prepare-intent trigger fills channel /
//                         source_event_key / recipient_key / hash on INSERT.
//                         Seeds PENDING + FAILED(retry 1) + FAILED(retry 3) +
//                         RECONCILIATION_REQUIRED for the F7/F11 gauges.
import { randomUUID } from 'crypto';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../config/pathwayProjectorConfig.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const { collectReliabilityMetrics, serializeReliabilityMetrics } =
  await import('../observability/reliabilityMetrics.js');

const PATIENT_UID = randomUUID();
const MARK = `relmetrics-${PATIENT_UID.slice(0, 8)}`;
const PROJECTOR_EVENT_ID_BASE = BigInt(Number.MAX_SAFE_INTEGER)
  + 1n
  + BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 15)}`);
const PROJECTOR_EVENT_IDS = [0n, 1n, 2n, 3n]
  .map((offset) => (PROJECTOR_EVENT_ID_BASE + offset).toString());
const RETIRED_GENERATION = 1_000_000
  + (Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 7), 16) % 1_000_000_000);

function gaugeValue(text, name) {
  const m = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return m ? Number(m[1]) : null;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM pathway_projector_inbox
      WHERE consumer_key = $1
        AND generation = $2
        AND event_id IN (
          SELECT id
            FROM event_outbox
           WHERE aggregate_type = $3
        )`,
    PATHWAY_PROJECTOR_CONSUMER_KEY,
    PATHWAY_PROJECTOR_GENERATION,
    MARK,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM webhook_deliveries WHERE event_type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM notification_outbox WHERE type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pathway_projector_inbox
      WHERE consumer_key = $1
        AND generation = $2
        AND event_id IN ($3::bigint, $4::bigint, $5::bigint)`,
    PATHWAY_PROJECTOR_CONSUMER_KEY,
    PATHWAY_PROJECTOR_GENERATION,
    ...PROJECTOR_EVENT_IDS.slice(0, 3),
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pathway_projector_inbox
      WHERE consumer_key = $1
        AND generation = $2`,
    PATHWAY_PROJECTOR_CONSUMER_KEY,
    RETIRED_GENERATION,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM event_consumer_offsets
      WHERE consumer_key = $1
        AND generation = $2`,
    PATHWAY_PROJECTOR_CONSUMER_KEY,
    RETIRED_GENERATION,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE aggregate_type = $1`, MARK).catch(() => {});
}

d('reliability metrics collector (QA DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO event_outbox
         (event_type, aggregate_type, payload, status, available_at, created_at,
          lease_owner, lease_expires_at)
       VALUES ('x', $1, '{}'::jsonb, 'pending', now() - interval '1 hour', now(), NULL, NULL),
              ('x', $1, '{}'::jsonb, 'pending', now(), now(), NULL, NULL),
              ('x', $1, '{}'::jsonb, 'failed',  now(), now(), NULL, NULL),
              ('x', $1, '{}'::jsonb, 'processing', now(), now(), $2::uuid,
               '2099-01-01T00:00:00Z'::timestamptz),
              ('x', $1, '{}'::jsonb, 'processing', now(), now(), $3::uuid,
               '2000-01-01T00:00:00Z'::timestamptz)`,
      MARK,
      randomUUID(),
      randomUUID(),
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO webhook_deliveries
         (event_type, payload, status, created_at, lease_owner, lease_expires_at,
          source_kind, source_identity, payload_sha256)
       VALUES ($1, '{}'::jsonb, 'pending', now(), NULL, NULL, 'legacy_orphan',
               gen_random_uuid()::text, encode(digest('{}'::jsonb::text, 'sha256'), 'hex')),
              ($1, '{}'::jsonb, 'failed', now(), NULL, NULL, 'legacy_orphan',
               gen_random_uuid()::text, encode(digest('{}'::jsonb::text, 'sha256'), 'hex')),
              ($1, '{}'::jsonb, 'dead', now(), NULL, NULL, 'legacy_orphan',
               gen_random_uuid()::text, encode(digest('{}'::jsonb::text, 'sha256'), 'hex')),
              ($1, '{}'::jsonb, 'in_flight', now(), $2::uuid,
               '2099-01-01T00:00:00Z'::timestamptz, 'legacy_orphan',
               gen_random_uuid()::text, encode(digest('{}'::jsonb::text, 'sha256'), 'hex')),
              ($1, '{}'::jsonb, 'in_flight', now(), $3::uuid,
               '2000-01-01T00:00:00Z'::timestamptz, 'legacy_orphan',
               gen_random_uuid()::text, encode(digest('{}'::jsonb::text, 'sha256'), 'hex'))`,
      MARK,
      randomUUID(),
      randomUUID(),
    );
    // PENDING + the two dead-letter shapes (F7/F11, audit 2026-08-10):
    // FAILED at the retry ceiling (never re-claimed by the drain) and
    // RECONCILIATION_REQUIRED (never auto-retried at all).
    await prisma.$executeRawUnsafe(
      `INSERT INTO notification_outbox (type, title, body, status, retry_count, created_at)
       VALUES ($1, 'relmetrics', 'relmetrics', 'PENDING', 0, now()),
              ($1, 'relmetrics-f1', 'relmetrics', 'FAILED', 1, now()),
              ($1, 'relmetrics-f3', 'relmetrics', 'FAILED', 3, now()),
              ($1, 'relmetrics-rr', 'relmetrics', 'RECONCILIATION_REQUIRED', 1, now())`,
      MARK,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (consumer_key, generation, event_id, status, lease_owner, lease_expires_at, outcome_at, created_at)
       VALUES
         ($1, $2, $3::bigint, 'pending', NULL, NULL, NULL, now() - interval '1 hour'),
         ($1, $2, $4::bigint, 'pending', $6::uuid, now() + interval '5 minutes', NULL, now()),
         ($1, $2, $5::bigint, 'dead', NULL, NULL, now(), now())`,
      PATHWAY_PROJECTOR_CONSUMER_KEY,
      PATHWAY_PROJECTOR_GENERATION,
      ...PROJECTOR_EVENT_IDS.slice(0, 3),
      randomUUID(),
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO event_consumer_offsets
         (consumer_key, generation, historical_cutoff_event_id,
          backfill_cursor_event_id, backfill_completed_at, intake_retired_at)
       VALUES ($1, $2, 0, 0, NOW(), NOW())`,
      PATHWAY_PROJECTOR_CONSUMER_KEY,
      RETIRED_GENERATION,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (consumer_key, generation, event_id, status, created_at)
       VALUES ($1, $2, $3::bigint, 'pending', NOW())`,
      PATHWAY_PROJECTOR_CONSUMER_KEY,
      RETIRED_GENERATION,
      PROJECTOR_EVENT_IDS[3],
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('reports event_outbox pending/dead-letter/oldest-age', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'event_outbox_pending_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'event_outbox_dead_letter_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'event_outbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(3000);
    expect(gaugeValue(out, 'event_outbox_processing_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'event_outbox_stale_processing_rows')).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('reports notification_outbox pending/failed/reconciliation-required/dead-letter gauges', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'notification_outbox_pending_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'notification_outbox_failed_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'notification_outbox_reconciliation_required_rows')).toBeGreaterThanOrEqual(1);
    // dead letters = FAILED at the retry ceiling (1 seeded) + RECONCILIATION_REQUIRED (1 seeded);
    // the retrying FAILED row (retry_count 1) must NOT count.
    expect(gaugeValue(out, 'notification_outbox_dead_letter_rows')).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('reports webhook + circuit-breaker gauges', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'webhook_deliveries_dead_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'webhook_deliveries_in_flight_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'webhook_deliveries_stale_in_flight_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'webhook_deliveries_parked_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'db_circuit_breaker_open')).toBe(0);
  }, 30_000);

  it('reports pathway projector pending/oldest-age/leased/dead gauges', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'pathway_projector_inbox_pending_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'pathway_projector_inbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(3000);
    expect(gaugeValue(out, 'pathway_projector_inbox_leased_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'pathway_projector_inbox_dead_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'pathway_projector_inbox_retired_pending_rows'))
      .toBeGreaterThanOrEqual(1);
  }, 30_000);
});
