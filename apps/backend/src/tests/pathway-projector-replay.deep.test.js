import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  createPathwayProjectorRegistry,
  pathwayProjectorRegistry,
  pathwayProjectorRegistryV1,
  pathwayProjectorRegistryV2,
} from '../services/events/pathwayProjectorRegistry.js';
import {
  claimDueInboxRows,
  materializeMissingInboxRows,
  processClaimedInboxRow,
  registerEventConsumer,
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

function migrationOwnerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (
    url.hostname === '127.0.0.1'
    && url.port === '55432'
    && url.username === 'qa_writer'
  ) {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function consumerFor(label) {
  const consumer = `s1a_replay_${RUN_ID}_${label}`;
  consumers.add(consumer);
  return consumer;
}

async function seedEvent(eventType) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH clock AS (SELECT NOW() AS inserted_at)
     INSERT INTO event_outbox
       (event_type, aggregate_type, payload, tenant_id, status, available_at,
        created_at, occurred_at, occurred_at_source)
     SELECT $1, 's1a_replay_test', $2::jsonb, $3::uuid, 'pending',
            clock.inserted_at - INTERVAL '100 years', clock.inserted_at,
            clock.inserted_at, 'explicit'
       FROM clock
     RETURNING id::text, tenant_id::text, event_type, created_at, occurred_at`,
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

async function offsetsFor(consumerKey) {
  return prisma.$queryRawUnsafe(
    `SELECT consumer_key, generation,
            historical_cutoff_event_id::text,
            backfill_cursor_event_id::text,
            backfill_completed_at,
            intake_retired_at,
            registered_at,
            updated_at
       FROM public.pathway_projector_offsets_list($1::text, FALSE)
      ORDER BY generation`,
    consumerKey,
  );
}

async function inboxCount(consumerKey, generation) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::integer AS row_count
       FROM pathway_projector_inbox
      WHERE consumer_key = $1 AND generation = $2::integer`,
    consumerKey,
    generation,
  );
  return rows[0].row_count;
}

async function primeGeneration(consumerKey, generation) {
  let exhausted = false;
  for (let batch = 0; batch < 500; batch += 1) {
    const rows = await materializeMissingInboxRows({ consumerKey, generation, limit: 200 });
    if (rows.completed) {
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
    const owner = new Client({
      connectionString: migrationOwnerDatabaseUrl(databaseUrl),
    });
    await owner.connect();
    try {
      await owner.query(
        `DELETE FROM event_consumer_offsets
          WHERE consumer_key = ANY($1::text[])`,
        [consumerKeys],
      );
    } finally {
      await owner.end();
    }
  }
  if (eventIds.size > 0) {
    const trackedIds = Array.from(eventIds);
    await prisma.$executeRawUnsafe(
      `DELETE FROM pathway_projector_inbox WHERE event_id = ANY($1::bigint[])`,
      trackedIds,
    ).catch(() => {});
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

  it('blocks generation handoff until predecessor backfill is complete', async () => {
    const consumerKey = consumerFor('blocked_handoff');
    await seedEvent(`test.pathway.replay.blocked_history_${RUN_TOKEN}`);
    const generationOne = await registerEventConsumer({ consumerKey, generation: 1 });
    expect(generationOne.backfill_completed_at).toBeNull();

    await expect(registerEventConsumer({ consumerKey, generation: 2 }))
      .rejects.toMatchObject({ code: 'PATHWAY_PROJECTOR_GENERATION_HANDOFF_BLOCKED' });
    expect(await offsetsFor(consumerKey)).toEqual([
      expect.objectContaining({ generation: 1, intake_retired_at: null }),
    ]);
  }, 60_000);

  it('cuts over intake without a gap and keeps the retired generation finite', async () => {
    const consumerKey = consumerFor('gap_free_handoff');
    await primeGeneration(consumerKey, 1);
    const beforeCutover = await seedEvent(HANDLED_EVENT_TYPE);
    expect(await rowsFor(consumerKey, 1, [beforeCutover.id])).toEqual([
      expect.objectContaining({ status: 'pending', event_id: beforeCutover.id }),
    ]);
    const retiredCount = await inboxCount(consumerKey, 1);

    const generationTwo = await registerEventConsumer({ consumerKey, generation: 2 });
    expect(generationTwo).toMatchObject({ generation: 2, intake_retired_at: null });
    const offsetsAfterCutover = await offsetsFor(consumerKey);
    expect(offsetsAfterCutover).toHaveLength(2);
    expect(offsetsAfterCutover.find((row) => row.generation === 1)?.intake_retired_at)
      .toBeInstanceOf(Date);
    expect(offsetsAfterCutover.find((row) => row.generation === 2)?.intake_retired_at)
      .toBeNull();

    expect(await materializeExpected(consumerKey, 2, [beforeCutover.id])).toEqual([
      expect.objectContaining({ event_id: beforeCutover.id, status: 'pending' }),
    ]);
    const afterCutover = await seedEvent(GENERATION_2_EVENT_TYPE);
    expect(await rowsFor(consumerKey, 2, [afterCutover.id])).toEqual([
      expect.objectContaining({ event_id: afterCutover.id, status: 'pending' }),
    ]);
    expect(await rowsFor(consumerKey, 1, [afterCutover.id])).toHaveLength(0);
    const [retiredOutcome] = await processAll(
      consumerKey,
      1,
      pathwayProjectorRegistryV1,
      1,
    );
    expect(retiredOutcome).toMatchObject({
      event_id: beforeCutover.id,
      status: 'handled',
    });
    expect(await inboxCount(consumerKey, 1)).toBe(retiredCount);

    const offsetsBeforeRetiredReuse = await offsetsFor(consumerKey);
    await expect(registerEventConsumer({ consumerKey, generation: 1 }))
      .rejects.toMatchObject({ code: 'PATHWAY_PROJECTOR_GENERATION_RETIRED' });
    expect(await offsetsFor(consumerKey)).toEqual(offsetsBeforeRetiredReuse);
  }, 60_000);

  it('serializes competing first registrations and leaves one live generation', async () => {
    const consumerKey = consumerFor('concurrent_handoff');
    await seedEvent(`test.pathway.replay.concurrent_${RUN_TOKEN}`);
    const results = await Promise.allSettled([
      registerEventConsumer({ consumerKey, generation: 1 }),
      registerEventConsumer({ consumerKey, generation: 2 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(
      (result) => result.status === 'rejected'
        && [
          'PATHWAY_PROJECTOR_GENERATION_HANDOFF_BLOCKED',
          'PATHWAY_PROJECTOR_GENERATION_OUT_OF_ORDER',
        ].includes(result.reason?.code),
    )).toHaveLength(1);
    expect(await offsetsFor(consumerKey)).toEqual([
      expect.objectContaining({ intake_retired_at: null }),
    ]);
  }, 60_000);

  it('rejects an absent generation below the highest generation already known', async () => {
    const consumerKey = consumerFor('monotonic_generation');
    await primeGeneration(consumerKey, 2);

    await expect(registerEventConsumer({ consumerKey, generation: 1 }))
      .rejects.toMatchObject({ code: 'PATHWAY_PROJECTOR_GENERATION_OUT_OF_ORDER' });
    expect(await offsetsFor(consumerKey)).toEqual([
      expect.objectContaining({ generation: 2, intake_retired_at: null }),
    ]);
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

    await expect(processClaimedInboxRow({ claim, registry: pathwayProjectorRegistry }))
      .rejects.toMatchObject({ code: 'PATHWAY_PROJECTOR_REGISTRY_GENERATION_MISMATCH' });
    const [stillClaimed] = await rowsFor(consumerKey, 1, [event.id]);
    expect(stillClaimed).toMatchObject({
      status: 'pending',
      attempts: 1,
      lease_owner: owner,
      outcome_at: null,
    });

    const terminal = await processClaimedInboxRow({ claim, registry: pathwayProjectorRegistryV1 });
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
      registry: pathwayProjectorRegistryV2,
      maxBatches: 5,
      materializeLimit: 10,
      claimLimit: 10,
      leaseSeconds: 60,
    });
    expect(result).toEqual({
      materialized: 0,
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
      registry: pathwayProjectorRegistryV2,
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

  it('claims only the row being dispatched while later rows remain untouched', async () => {
    const consumerKey = consumerFor('claim_on_dispatch');
    const generation = 10_005;
    const eventType = `test.pathway.replay.dispatch_${RUN_TOKEN}`;
    await primeGeneration(consumerKey, generation);
    const first = await seedEvent(eventType);
    const second = await seedEvent(eventType);
    let enterFirst;
    let releaseFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    let handlerCalls = 0;
    const registry = createPathwayProjectorRegistry({
      generation,
      entries: [[eventType, async () => {
        handlerCalls += 1;
        if (handlerCalls === 1) {
          enterFirst();
          await firstReleased;
        }
        return Object.freeze({ shadow_observed: true, generation });
      }]],
    });

    const tick = runPathwayProjectorShadowTick({
      consumerKey,
      generation,
      registry,
      maxBatches: 1,
      materializeLimit: 10,
      claimLimit: 2,
      leaseSeconds: 60,
    });
    try {
      await firstEntered;
      const queued = await rowsFor(consumerKey, generation, [first.id, second.id]);
      expect(queued.filter((row) => row.lease_owner !== null)).toHaveLength(1);
      expect(queued.filter((row) => row.attempts === 0 && row.lease_owner === null)).toHaveLength(1);
    } finally {
      releaseFirst();
      await tick;
    }
  }, 60_000);

  it('preserves the configured per-tick dispatch cap with claim-on-dispatch', async () => {
    const consumerKey = consumerFor('dispatch_cap');
    const generation = 10_006;
    const eventType = `test.pathway.replay.dispatch_cap_${RUN_TOKEN}`;
    await primeGeneration(consumerKey, generation);
    const events = [];
    for (let index = 0; index < 5; index += 1) {
      events.push(await seedEvent(eventType));
    }
    const registry = createPathwayProjectorRegistry({
      generation,
      entries: [[eventType, async () => Object.freeze({ shadow_observed: true, generation })]],
    });

    expect(await runPathwayProjectorShadowTick({
      consumerKey,
      generation,
      registry,
      maxBatches: 2,
      materializeLimit: 10,
      claimLimit: 2,
      leaseSeconds: 60,
    })).toEqual({
      materialized: 0,
      claimed: 4,
      handled: 4,
      ignored: 0,
      retried: 0,
      dead: 0,
    });

    const afterFirstTick = await rowsFor(
      consumerKey,
      generation,
      events.map((event) => event.id),
    );
    expect(afterFirstTick.filter((row) => row.status === 'handled')).toHaveLength(4);
    expect(afterFirstTick.filter(
      (row) => row.status === 'pending' && row.attempts === 0 && row.lease_owner === null,
    )).toHaveLength(1);

    expect(await runPathwayProjectorShadowTick({
      consumerKey,
      generation,
      registry,
      maxBatches: 2,
      materializeLimit: 10,
      claimLimit: 2,
      leaseSeconds: 60,
    })).toEqual({
      materialized: 0,
      claimed: 1,
      handled: 1,
      ignored: 0,
      retried: 0,
      dead: 0,
    });
  }, 60_000);
});
