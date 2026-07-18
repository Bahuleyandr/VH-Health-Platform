import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import {
  createPathwayProjectorRegistry,
  pathwayProjectorRegistry,
} from '../services/events/pathwayProjectorRegistry.js';
import {
  claimDueInboxRows,
  materializeMissingInboxRows,
  processClaimedInboxRow,
  runPathwayProjectorShadowTick,
} from '../services/events/pathwayProjectorService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RUN_ID = `${process.pid}-${Date.now()}`;
const RUN_TOKEN = RUN_ID.replaceAll('-', '_');
const TENANT_ID = randomUUID();
const HANDLED_EVENT_TYPE = 'clinical.handover.created';
const GENERATION_2_EVENT_TYPE = `test.pathway.replay.added_${RUN_TOKEN}`;

const consumers = new Set();
const eventIds = new Set();

function consumerFor(label) {
  const consumer = `s1a_replay_${RUN_ID}_${label}`;
  consumers.add(consumer);
  return consumer;
}

const GENERATION_TWO_REGISTRY = createPathwayProjectorRegistry({
  generation: 2,
  entries: [
    [HANDLED_EVENT_TYPE, async () => Object.freeze({ shadow_observed: true, generation: 2 })],
    [GENERATION_2_EVENT_TYPE, async () => Object.freeze({ shadow_observed: true, generation: 2 })],
  ],
});

async function seedEvent(eventType) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO event_outbox
       (event_type, aggregate_type, payload, tenant_id, status, available_at, created_at)
     VALUES ($1, 's1a_replay_test', $2::jsonb, $3::uuid, 'pending',
             NOW() - INTERVAL '100 years', NOW())
     RETURNING id::text, tenant_id::text, event_type`,
    eventType,
    JSON.stringify({ test_run: RUN_ID }),
    TENANT_ID,
  );
  eventIds.add(rows[0].id);
  return rows[0];
}

async function rowsFor(consumerKey, generation, ids) {
  return prisma.$queryRawUnsafe(
    `SELECT consumer_key, generation, event_id::text, tenant_id::text, status,
            attempts, lease_owner::text, lease_expires_at, next_attempt_at,
            last_error, outcome_at, created_at
       FROM pathway_projector_inbox
      WHERE consumer_key = $1
        AND generation = $2::integer
        AND event_id = ANY($3::bigint[])
      ORDER BY event_id`,
    consumerKey,
    generation,
    ids.map(String),
  );
}

async function primeGeneration(consumerKey, generation) {
  let exhausted = false;
  for (let batch = 0; batch < 500; batch += 1) {
    const rows = await materializeMissingInboxRows({ consumerKey, generation, limit: 200 });
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) throw new Error('S1a replay baseline exceeded 100000 rows');
  await prisma.$executeRawUnsafe(
    `UPDATE pathway_projector_inbox
        SET status = 'ignored', lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL, outcome_at = COALESCE(outcome_at, NOW())
      WHERE consumer_key = $1 AND generation = $2::integer AND status = 'pending'`,
    consumerKey,
    generation,
  );
}

async function materializeExpected(consumerKey, generation, ids) {
  for (let batch = 0; batch < 500; batch += 1) {
    await materializeMissingInboxRows({ consumerKey, generation, limit: 200 });
    const rows = await rowsFor(consumerKey, generation, ids);
    if (rows.length === ids.length) return rows;
  }
  throw new Error(`S1a replay materializer did not reach generation ${generation} fixtures`);
}

async function processAll(consumerKey, generation, registry, expectedCount) {
  const claims = await claimDueInboxRows({
    consumerKey,
    generation,
    limit: expectedCount,
    leaseOwner: randomUUID(),
  });
  expect(claims).toHaveLength(expectedCount);
  const outcomes = [];
  for (const claim of claims) {
    outcomes.push(await processClaimedInboxRow({ claim, registry }));
  }
  return outcomes;
}

async function cleanup() {
  if (consumers.size > 0) {
    const consumerKeys = Array.from(consumers);
    await prisma.$executeRawUnsafe(
      `DELETE FROM pathway_projector_inbox WHERE consumer_key = ANY($1::text[])`,
      consumerKeys,
    ).catch(() => {});
  }
  if (eventIds.size > 0) {
    const trackedIds = Array.from(eventIds);
    await prisma.$executeRawUnsafe(
      `DELETE FROM webhook_deliveries WHERE event_outbox_id = ANY($1::bigint[])`,
      trackedIds,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox WHERE id = ANY($1::bigint[])`,
      trackedIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

describeIfDb('pathway projector generation replay (deep)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'S1a Replay Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
      `s1a-replay-${RUN_ID}`,
    );
  });

  afterAll(cleanup, 60_000);

  it('creates a fresh terminal ledger for generation 2 without mutating generation 1', async () => {
    const consumerKey = consumerFor('fresh_generation');
    await primeGeneration(consumerKey, 1);
    await primeGeneration(consumerKey, 2);
    const known = await seedEvent(HANDLED_EVENT_TYPE);
    const added = await seedEvent(GENERATION_2_EVENT_TYPE);
    const ids = [known.id, added.id];

    await materializeExpected(consumerKey, 1, ids);
    const generationOneOutcomes = await processAll(
      consumerKey,
      1,
      pathwayProjectorRegistry,
      2,
    );
    expect(generationOneOutcomes.find((row) => row.event_id === known.id)?.status).toBe('handled');
    expect(generationOneOutcomes.find((row) => row.event_id === added.id)?.status).toBe('ignored');
    const generationOneSnapshot = await rowsFor(consumerKey, 1, ids);

    const registryV2 = GENERATION_TWO_REGISTRY;
    await materializeExpected(consumerKey, 2, ids);
    const generationTwoOutcomes = await processAll(consumerKey, 2, registryV2, 2);
    expect(generationTwoOutcomes.map((row) => row.status)).toEqual(['handled', 'handled']);

    const generationTwoRows = await rowsFor(consumerKey, 2, ids);
    expect(generationTwoRows).toHaveLength(2);
    expect(generationTwoRows.every((row) => row.status === 'handled')).toBe(true);
    expect(await rowsFor(consumerKey, 1, ids)).toEqual(generationOneSnapshot);

    await Promise.all([
      materializeMissingInboxRows({ consumerKey, generation: 1, limit: 200 }),
      materializeMissingInboxRows({ consumerKey, generation: 2, limit: 200 }),
    ]);
    expect(await claimDueInboxRows({ consumerKey, generation: 1, limit: 10 })).toHaveLength(0);
    expect(await claimDueInboxRows({ consumerKey, generation: 2, limit: 10 })).toHaveLength(0);
    expect(await rowsFor(consumerKey, 1, ids)).toEqual(generationOneSnapshot);
    expect(await rowsFor(consumerKey, 2, ids)).toHaveLength(2);
  }, 60_000);

  it('rejects generation-2 semantics for generation-1 work and leaves its claim intact', async () => {
    const consumerKey = consumerFor('registry_generation_fence');
    await primeGeneration(consumerKey, 1);
    const event = await seedEvent(HANDLED_EVENT_TYPE);
    await materializeExpected(consumerKey, 1, [event.id]);
    const owner = randomUUID();
    const [claim] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: owner,
    });

    await expect(processClaimedInboxRow({ claim, registry: GENERATION_TWO_REGISTRY }))
      .rejects.toMatchObject({ code: 'PATHWAY_PROJECTOR_REGISTRY_GENERATION_MISMATCH' });
    const [stillClaimed] = await rowsFor(consumerKey, 1, [event.id]);
    expect(stillClaimed).toMatchObject({
      status: 'pending',
      attempts: 1,
      lease_owner: owner,
      outcome_at: null,
    });

    const terminal = await processClaimedInboxRow({ claim, registry: pathwayProjectorRegistry });
    expect(terminal.status).toBe('handled');
  }, 60_000);

  it('runs a generation-scoped shadow tick with exact counts and idempotent reruns', async () => {
    const consumerKey = consumerFor('runner');
    await primeGeneration(consumerKey, 2);
    const known = await seedEvent(HANDLED_EVENT_TYPE);
    const ignored = await seedEvent(`test.pathway.replay.ignored_${RUN_TOKEN}`);

    const result = await runPathwayProjectorShadowTick({
      consumerKey,
      generation: 2,
      registry: GENERATION_TWO_REGISTRY,
      maxBatches: 5,
      materializeLimit: 10,
      claimLimit: 10,
      leaseSeconds: 60,
    });
    expect(result).toEqual({
      materialized: 2,
      claimed: 2,
      handled: 1,
      ignored: 1,
      retried: 0,
      dead: 0,
    });
    const rows = await rowsFor(consumerKey, 2, [known.id, ignored.id]);
    expect(rows.map((row) => row.status).sort()).toEqual(['handled', 'ignored']);

    expect(await runPathwayProjectorShadowTick({
      consumerKey,
      generation: 2,
      registry: GENERATION_TWO_REGISTRY,
      maxBatches: 5,
      materializeLimit: 10,
      claimLimit: 10,
      leaseSeconds: 60,
    })).toEqual({
      materialized: 0,
      claimed: 0,
      handled: 0,
      ignored: 0,
      retried: 0,
      dead: 0,
    });
  }, 60_000);
});
