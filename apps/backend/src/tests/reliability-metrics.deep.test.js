// src/tests/reliability-metrics.deep.test.js
// Proves collectReliabilityMetrics() reads the real reliability tables and that
// serializeReliabilityMetrics() reports the correct values. Seeds event_outbox
// (pending + failed/dead-letter), notification_outbox (PENDING), and
// webhook_deliveries (pending/failed/dead), and pathway_projector_inbox
// (pending/leased/dead) under a unique marker, runs the collector, and asserts
// the gauge values reflect AT LEAST the seeded rows (other suites may add rows,
// so assert >= seeded).
//
// Seed-column reconciliation (vs real QA schema):
//   event_outbox        — NOT-NULL-no-default cols = event_type, aggregate_type
//                         (MARK stashed in aggregate_type; cleanup filters it).
//   webhook_deliveries  — NOT-NULL-no-default cols = event_type, payload
//                         (MARK in event_type; payload added to the INSERT).
//   notification_outbox — NO `channel` column exists; NOT-NULL-no-default cols =
//                         type, title, body. MARK stashed in `type`; cleanup
//                         filters on `type`. (row is seeded but not asserted.)
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const { collectReliabilityMetrics, serializeReliabilityMetrics } =
  await import('../observability/reliabilityMetrics.js');

const PATIENT_UID = randomUUID();
const MARK = `relmetrics-${PATIENT_UID.slice(0, 8)}`;

function gaugeValue(text, name) {
  const m = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return m ? Number(m[1]) : null;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE aggregate_type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM webhook_deliveries WHERE event_type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM notification_outbox WHERE type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM pathway_projector_inbox WHERE consumer_key = $1`, MARK).catch(() => {});
}

d('reliability metrics collector (QA DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO event_outbox (event_type, aggregate_type, payload, status, available_at, created_at)
       VALUES ('x', $1, '{}'::jsonb, 'pending', now() - interval '1 hour', now()),
              ('x', $1, '{}'::jsonb, 'pending', now(), now()),
              ('x', $1, '{}'::jsonb, 'failed',  now(), now())`,
      MARK,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO webhook_deliveries (event_type, payload, status, created_at)
       VALUES ($1, '{}'::jsonb, 'pending', now()),
              ($1, '{}'::jsonb, 'failed',  now()),
              ($1, '{}'::jsonb, 'dead',    now())`,
      MARK,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO notification_outbox (type, title, body, status, created_at)
       VALUES ($1, 'relmetrics', 'relmetrics', 'PENDING', now())`,
      MARK,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (consumer_key, generation, event_id, status, lease_owner, lease_expires_at, outcome_at, created_at)
       VALUES
         ($1, 1, 1, 'pending', NULL, NULL, NULL, now() - interval '1 hour'),
         ($1, 1, 2, 'pending', $2::uuid, now() + interval '5 minutes', NULL, now()),
         ($1, 1, 3, 'dead', NULL, NULL, now(), now())`,
      MARK,
      randomUUID(),
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
  }, 30_000);

  it('reports webhook + circuit-breaker gauges', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'webhook_deliveries_dead_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'db_circuit_breaker_open')).toBe(0);
  }, 30_000);

  it('reports pathway projector pending/oldest-age/leased/dead gauges', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'pathway_projector_inbox_pending_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'pathway_projector_inbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(3000);
    expect(gaugeValue(out, 'pathway_projector_inbox_leased_rows')).toBeGreaterThanOrEqual(1);
    expect(gaugeValue(out, 'pathway_projector_inbox_dead_rows')).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
