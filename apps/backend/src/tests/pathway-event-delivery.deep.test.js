import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import { runInTenantContext, runWithSuperAdmin } from '../lib/tenantContext.js';
import {
  createPathwayProjectorRegistry,
  PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES,
  pathwayProjectorRegistry,
} from '../services/events/pathwayProjectorRegistry.js';
import {
  claimDueInboxRows,
  materializeMissingInboxRows,
  processClaimedInboxRow,
  reapStaleInboxLeases,
} from '../services/events/pathwayProjectorService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const RUN_ID = `${process.pid}-${Date.now()}`;
const RUN_TOKEN = RUN_ID.replaceAll('-', '_');
const CONSUMER_PREFIX = `s1a_delivery_${RUN_ID}`;
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RLS_ROLE = 'rls_test_app';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const BIG_EVENT_ID = '9007199254740993';
const HANDLED_EVENT_TYPE = PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES[0];
const HANDLER_RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 14400];
const DB_DELAY_TOLERANCE_SECONDS = 5;

const consumers = new Set();
const eventIds = new Set();
let savedRlsEnforcement;
let savedRlsRole;

function consumerFor(label) {
  const consumer = `${CONSUMER_PREFIX}_${label}`;
  consumers.add(consumer);
  return consumer;
}

function throwingRegistry(generation, eventType, message = 'observer failed') {
  return createPathwayProjectorRegistry({
    generation,
    entries: [[eventType, async () => { throw new Error(message); }]],
  });
}

async function seedOutboxEvent({
  tenantId = TENANT_A,
  eventType = `test.pathway.s1a.${RUN_ID.replaceAll('-', '_')}`,
  status = 'pending',
  attempts = 0,
  lastError = null,
  deliveredAt = null,
  explicitId = null,
  payload = { test_run: RUN_ID },
} = {}) {
  const commonColumns = `
    event_type, aggregate_type, aggregate_id, patient_uid, payload,
    tenant_id, status, attempts, available_at, last_error, created_at, delivered_at
  `;
  const commonValues = `
    $1::text, 's1a_test', NULL, NULL, $2::jsonb,
    $3::uuid, $4::text, $5::integer, NOW() - INTERVAL '100 years',
    $6::text, NOW(), $7::timestamptz
  `;
  const params = [
    eventType,
    JSON.stringify(payload),
    tenantId,
    status,
    attempts,
    lastError,
    deliveredAt,
  ];
  const rows = explicitId
    ? await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox (id, ${commonColumns})
       VALUES ($8::bigint, ${commonValues})
       RETURNING id::text, tenant_id::text, event_type, status`,
      ...params,
      String(explicitId),
    )
    : await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox (${commonColumns})
       VALUES (${commonValues})
       RETURNING id::text, tenant_id::text, event_type, status`,
      ...params,
    );
  eventIds.add(rows[0].id);
  return rows[0];
}

async function inboxRows(consumerKey, generation, expectedEventIds = null) {
  if (expectedEventIds && expectedEventIds.length === 0) return [];
  const eventPredicate = expectedEventIds
    ? 'AND event_id = ANY($3::bigint[])'
    : '';
  const params = expectedEventIds
    ? [consumerKey, generation, expectedEventIds.map(String)]
    : [consumerKey, generation];
  return prisma.$queryRawUnsafe(
    `SELECT consumer_key, generation, event_id::text, tenant_id::text,
            status, attempts, lease_owner::text, lease_expires_at,
            next_attempt_at, last_error, outcome_at, created_at
       FROM pathway_projector_inbox
      WHERE consumer_key = $1
        AND generation = $2::integer
        ${eventPredicate}
      ORDER BY event_id`,
    ...params,
  );
}

async function materializeUntilPresent({ consumerKey, generation = 1, expectedEventIds }) {
  const expected = expectedEventIds.map(String);
  for (let batch = 0; batch < 500; batch += 1) {
    await materializeMissingInboxRows({ consumerKey, generation, limit: 200 });
    const rows = await inboxRows(consumerKey, generation, expected);
    if (rows.length === expected.length) return rows;
  }
  throw new Error(`S1a materializer did not reach ${expected.length} expected events`);
}

async function primeConsumer(consumerKey, generation = 1) {
  let exhausted = false;
  for (let batch = 0; batch < 500; batch += 1) {
    const rows = await materializeMissingInboxRows({ consumerKey, generation, limit: 200 });
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) throw new Error('S1a materializer baseline exceeded 100000 rows');
  await prisma.$executeRawUnsafe(
    `UPDATE pathway_projector_inbox
        SET status = 'ignored', lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL, outcome_at = COALESCE(outcome_at, NOW())
      WHERE consumer_key = $1 AND generation = $2::integer AND status = 'pending'`,
    consumerKey,
    generation,
  );
}

async function prepareClaimableEvents({
  consumerKey,
  generation = 1,
  events,
}) {
  await primeConsumer(consumerKey, generation);
  const seeded = [];
  for (const event of events) seeded.push(await seedOutboxEvent(event));
  await materializeUntilPresent({
    consumerKey,
    generation,
    expectedEventIds: seeded.map((row) => row.id),
  });
  return seeded;
}

async function sourceSnapshot(eventId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text, status, attempts, available_at, last_error, delivered_at
       FROM event_outbox WHERE id = $1::bigint`,
    String(eventId),
  );
  return rows[0];
}

async function noOpBoundaryCounts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM workflow_runs) AS workflow_runs,
       (SELECT COUNT(*)::integer FROM tasks) AS tasks,
       (SELECT COUNT(*)::integer FROM workflow_sla_instances) AS workflow_sla_instances,
       (SELECT COUNT(*)::integer FROM notification_outbox) AS notification_outbox,
       (SELECT COUNT(*)::integer FROM clinical_timeline_events) AS clinical_timeline_events,
       (SELECT COUNT(*)::integer FROM clinical_audit_events) AS clinical_audit_events`,
  );
  return rows[0];
}

async function expectDbDelay(timestamp, expectedSeconds) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))::double precision
            AS delay_seconds`,
    timestamp,
  );
  expect(rows[0].delay_seconds).toBeGreaterThanOrEqual(
    expectedSeconds - DB_DELAY_TOLERANCE_SECONDS,
  );
  expect(rows[0].delay_seconds).toBeLessThanOrEqual(
    expectedSeconds + DB_DELAY_TOLERANCE_SECONDS,
  );
}

async function asAppRole(tenantId, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      tenantId,
    );
    return callback(tx);
  });
}

async function withFreshAppRole(tenantSetting, callback) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (tenantSetting !== undefined) {
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true)`,
        [tenantSetting],
      );
    }
    const setting = await client.query(
      `SELECT current_setting('app.current_tenant_id', true) AS tenant_setting`,
    );
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    return await callback(client, setting.rows[0].tenant_setting);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function cleanup() {
  const consumerList = [...consumers];
  const idList = [...eventIds];
  if (consumerList.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pathway_projector_inbox WHERE consumer_key = ANY($1::text[])`,
      consumerList,
    ).catch(() => {});
  }
  if (idList.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM webhook_deliveries WHERE event_outbox_id = ANY($1::bigint[])`,
      idList,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox WHERE id = ANY($1::bigint[])`,
      idList,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
}

describeIfDb('pathway projector event delivery (deep)', () => {
  beforeAll(async () => {
    savedRlsEnforcement = process.env.AUTH_ENFORCE_TENANT_RLS;
    savedRlsRole = process.env.AUTH_TENANT_RLS_TEST_ROLE;

    await prisma.$executeRawUnsafe(
      `DELETE FROM pathway_projector_inbox
        WHERE event_id = $1::bigint AND consumer_key LIKE 's1a_delivery_%'`,
      BIG_EVENT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM webhook_deliveries WHERE event_outbox_id = $1::bigint`,
      BIG_EVENT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox
        WHERE id = $1::bigint AND event_type = 'test.pathway.s1a.bigint'`,
      BIG_EVENT_ID,
    ).catch(() => {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'S1a Delivery Tenant A'),
              ($3::uuid, $4, 'S1a Delivery Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      `s1a-delivery-a-${RUN_ID}`,
      TENANT_B,
      `s1a-delivery-b-${RUN_ID}`,
    );
  }, 60_000);

  afterAll(async () => {
    if (savedRlsEnforcement === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedRlsEnforcement;
    if (savedRlsRole === undefined) delete process.env.AUTH_TENANT_RLS_TEST_ROLE;
    else process.env.AUTH_TENANT_RLS_TEST_ROLE = savedRlsRole;
    await cleanup();
  }, 60_000);

  it('is backed by migration 578 with BIGINT, uniqueness, and forced Pattern-A RLS', async () => {
    const migration = await prisma.$queryRawUnsafe(
      `SELECT name FROM _migrations WHERE name = '578_pathway_projector_inbox.sql'`,
    );
    expect(migration).toHaveLength(1);

    const columns = await prisma.$queryRawUnsafe(
      `SELECT column_name, data_type, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pathway_projector_inbox'
        ORDER BY ordinal_position`,
    );
    expect(columns.find((column) => column.column_name === 'event_id')?.data_type).toBe('bigint');
    expect(columns.find((column) => column.column_name === 'tenant_id')?.column_default)
      .toMatch(/current_setting\('app\.current_tenant_id'/i);
    expect(columns.find((column) => column.column_name === 'tenant_id')?.column_default)
      .toContain(DEFAULT_TENANT_ID);
    expect(columns.map((column) => column.column_name)).toEqual(expect.arrayContaining([
      'tenant_id', 'consumer_key', 'generation', 'event_id', 'status', 'attempts',
      'lease_owner', 'lease_expires_at', 'next_attempt_at', 'last_error', 'outcome_at',
    ]));

    const posture = await prisma.$queryRawUnsafe(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, p.policyname,
              p.qual, p.with_check
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
        WHERE n.nspname = 'public'
          AND c.relname = 'pathway_projector_inbox'
          AND p.policyname = 'tenant_isolation'`,
    );
    expect(posture).toHaveLength(1);
    expect(posture[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      policyname: 'tenant_isolation',
    });
    expect(posture[0].qual).toMatch(/tenant_id.*app_current_tenant_id_uuid\(\)/i);
    expect(posture[0].with_check).toMatch(/tenant_id.*app_current_tenant_id_uuid\(\)/i);
    expect(posture[0].with_check).toBe(posture[0].qual);

    const constraints = await prisma.$queryRawUnsafe(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND rel.relname = 'pathway_projector_inbox'`,
    );
    const definitions = new Map(constraints.map((row) => [row.conname, row.definition]));
    expect(definitions.get('fk_pathway_projector_inbox_tenant'))
      .toMatch(/FOREIGN KEY \(tenant_id\) REFERENCES tenants\(id\)/i);
    expect(definitions.get('pathway_projector_inbox_status_check')).toMatch(/pending.*handled.*ignored.*dead/i);
    expect(definitions.get('chk_pathway_projector_inbox_outcome')).toMatch(/outcome_at/i);
    expect(definitions.get('chk_pathway_projector_inbox_lease_pair')).toMatch(/lease_owner.*lease_expires_at/i);

    const indexes = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'pathway_projector_inbox'`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'idx_pathway_projector_inbox_pending',
      'idx_pathway_projector_inbox_stale',
      'idx_pathway_projector_inbox_tenant_ops',
    ]));
  });

  it('proves every Pattern-A GUC branch and omitted tenant default under the non-owner role', async () => {
    const consumerKey = consumerFor('pattern_a_branches');
    const seeded = await prepareClaimableEvents({
      consumerKey,
      events: [{ tenantId: TENANT_A }, { tenantId: TENANT_B }],
    });
    const eventA = seeded.find((event) => event.tenant_id === TENANT_A);
    expect(eventA).toBeDefined();
    expect(await prisma.$queryRawUnsafe(
      `SELECT id::text FROM tenants WHERE id = $1::uuid`,
      DEFAULT_TENANT_ID,
    )).toEqual([{ id: DEFAULT_TENANT_ID }]);

    const branchCases = [
      { label: 'unset', setting: undefined, observed: null, defaultTenant: DEFAULT_TENANT_ID },
      { label: 'empty', setting: '', observed: '', defaultTenant: DEFAULT_TENANT_ID },
      { label: 'bypass', setting: 'bypass', observed: 'bypass', defaultTenant: DEFAULT_TENANT_ID },
      { label: 'tenant', setting: TENANT_A, observed: TENANT_A, defaultTenant: TENANT_A },
    ];
    const allTenantIds = [TENANT_A, TENANT_B].sort();

    for (const branch of branchCases) {
      await withFreshAppRole(branch.setting, async (client, observedSetting) => {
        expect(observedSetting).toBe(branch.observed);
        const identity = await client.query('SELECT current_user AS current_user');
        expect(identity.rows).toEqual([{ current_user: RLS_ROLE }]);

        const visible = await client.query(
          `SELECT tenant_id::text
             FROM pathway_projector_inbox
            WHERE consumer_key = $1
              AND event_id = ANY($2::bigint[])
            ORDER BY tenant_id`,
          [consumerKey, seeded.map((event) => event.id)],
        );
        const expectedTenantIds = branch.setting === TENANT_A ? [TENANT_A] : allTenantIds;
        expect(visible.rows.map((row) => row.tenant_id)).toEqual(expectedTenantIds);

        const inserted = await client.query(
          `INSERT INTO pathway_projector_inbox (consumer_key, generation, event_id)
           VALUES ($1, 1, $2::bigint)
           RETURNING tenant_id::text`,
          [`${CONSUMER_PREFIX}_pattern_default_${branch.label}`, eventA.id],
        );
        expect(inserted.rows).toEqual([{ tenant_id: branch.defaultTenant }]);
      });
    }
  }, 60_000);

  it('materializes every source status and availability, copies tenant ids, and preserves a bigint id exactly', async () => {
    const consumerKey = consumerFor('statuses_bigint');
    await primeConsumer(consumerKey);
    const pending = await seedOutboxEvent({ status: 'pending' });
    const processing = await seedOutboxEvent({ status: 'processing' });
    const delivered = await seedOutboxEvent({ status: 'delivered', deliveredAt: new Date() });
    const failed = await seedOutboxEvent({ status: 'failed', attempts: 7, lastError: 'webhook failed' });
    const future = await seedOutboxEvent();
    const futureAvailability = await prisma.$queryRawUnsafe(
      `UPDATE event_outbox
          SET available_at = clock_timestamp() + INTERVAL '1 day'
        WHERE id = $1::bigint
        RETURNING available_at > clock_timestamp() AS is_future`,
      future.id,
    );
    expect(futureAvailability).toEqual([{ is_future: true }]);
    const big = await seedOutboxEvent({
      eventType: 'test.pathway.s1a.bigint',
      explicitId: BIG_EVENT_ID,
      tenantId: TENANT_B,
    });

    const expectedIds = [pending.id, processing.id, delivered.id, failed.id, future.id, big.id];
    const materialized = await materializeUntilPresent({ consumerKey, expectedEventIds: expectedIds });
    expect(new Set(materialized.map((row) => row.event_id))).toEqual(new Set(expectedIds));
    expect(materialized.find((row) => row.event_id === BIG_EVENT_ID)).toMatchObject({
      event_id: BIG_EVENT_ID,
      tenant_id: TENANT_B,
    });
    expect(materialized.find((row) => row.event_id === future.id)).toBeDefined();

    const claims = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 10,
      leaseOwner: randomUUID(),
    });
    const bigClaim = claims.find((claim) => claim.event_id === BIG_EVENT_ID);
    expect(bigClaim?.event_id).toBe(BIG_EVENT_ID);
    const outcome = await processClaimedInboxRow({ claim: bigClaim, registry: pathwayProjectorRegistry });
    expect(outcome).toMatchObject({ event_id: BIG_EVENT_ID, tenant_id: TENANT_B, status: 'ignored' });
  }, 60_000);

  it('makes repeated and concurrent discovery idempotent and recovers bounded work on later sweeps', async () => {
    const consumerKey = consumerFor('discovery_race');
    await primeConsumer(consumerKey);
    const seeded = [];
    for (let index = 0; index < 3; index += 1) seeded.push(await seedOutboxEvent());

    await Promise.all([
      materializeMissingInboxRows({ consumerKey, generation: 1, limit: 1 }),
      materializeMissingInboxRows({ consumerKey, generation: 1, limit: 1 }),
    ]);
    const firstPass = await inboxRows(consumerKey, 1, seeded.map((row) => row.id));
    expect(firstPass.length).toBeGreaterThanOrEqual(1);
    expect(firstPass.length).toBeLessThanOrEqual(2);

    await materializeUntilPresent({
      consumerKey,
      expectedEventIds: seeded.map((row) => row.id),
    });
    await Promise.all([
      materializeMissingInboxRows({ consumerKey, generation: 1, limit: 200 }),
      materializeMissingInboxRows({ consumerKey, generation: 1, limit: 200 }),
    ]);
    const finalRows = await inboxRows(consumerKey, 1, seeded.map((row) => row.id));
    expect(finalRows).toHaveLength(3);
    expect(new Set(finalRows.map((row) => row.event_id)).size).toBe(3);
  }, 60_000);

  it('finds a lower BIGSERIAL id that commits after a higher id without sleeps or a scan floor', async () => {
    const consumerKey = consumerFor('inverted_commit');
    await primeConsumer(consumerKey);
    const lowerTx = new Client({ connectionString: databaseUrl });
    const higherTx = new Client({ connectionString: databaseUrl });
    let lowerId;
    let higherId;
    await Promise.all([lowerTx.connect(), higherTx.connect()]);
    try {
      await lowerTx.query('BEGIN');
      await higherTx.query('BEGIN');
      const lower = await lowerTx.query(
        `INSERT INTO event_outbox
           (event_type, aggregate_type, payload, tenant_id, status, available_at, created_at)
         VALUES ($1, 's1a_test', $2::jsonb, $3::uuid, 'pending', NOW(), NOW())
         RETURNING id::text`,
        [`test.pathway.s1a.inverted.lower.${RUN_ID}`, JSON.stringify({ order: 'lower' }), TENANT_A],
      );
      lowerId = lower.rows[0].id;
      eventIds.add(lowerId);

      const higher = await higherTx.query(
        `INSERT INTO event_outbox
           (event_type, aggregate_type, payload, tenant_id, status, available_at, created_at)
         VALUES ($1, 's1a_test', $2::jsonb, $3::uuid, 'pending', NOW(), NOW())
         RETURNING id::text`,
        [`test.pathway.s1a.inverted.higher.${RUN_ID}`, JSON.stringify({ order: 'higher' }), TENANT_A],
      );
      higherId = higher.rows[0].id;
      eventIds.add(higherId);
      expect(typeof lowerId).toBe('string');
      expect(typeof higherId).toBe('string');
      const ordering = await higherTx.query(
        'SELECT $1::bigint < $2::bigint AS lower_precedes_higher',
        [lowerId, higherId],
      );
      expect(ordering.rows).toEqual([{ lower_precedes_higher: true }]);

      await higherTx.query('COMMIT');
      await materializeUntilPresent({ consumerKey, expectedEventIds: [higherId] });
      expect(await inboxRows(consumerKey, 1, [lowerId])).toHaveLength(0);

      await lowerTx.query('COMMIT');
      await materializeUntilPresent({ consumerKey, expectedEventIds: [lowerId, higherId] });
      const finalRows = await inboxRows(consumerKey, 1, [lowerId, higherId]);
      expect(new Set(finalRows.map((row) => row.event_id))).toEqual(new Set([lowerId, higherId]));
    } finally {
      await Promise.allSettled([
        lowerTx.query('ROLLBACK'),
        higherTx.query('ROLLBACK'),
      ]);
      await Promise.allSettled([lowerTx.end(), higherTx.end()]);
    }
  }, 60_000);

  it('gives two concurrent workers disjoint leases and increments attempts exactly once', async () => {
    const consumerKey = consumerFor('two_workers');
    const seeded = await prepareClaimableEvents({
      consumerKey,
      events: Array.from({ length: 4 }, () => ({})),
    });
    const workerA = randomUUID();
    const workerB = randomUUID();
    const [claimsA, claimsB] = await Promise.all([
      claimDueInboxRows({ consumerKey, generation: 1, limit: 2, leaseOwner: workerA }),
      claimDueInboxRows({ consumerKey, generation: 1, limit: 2, leaseOwner: workerB }),
    ]);
    expect(claimsA).toHaveLength(2);
    expect(claimsB).toHaveLength(2);
    const idsA = new Set(claimsA.map((claim) => claim.event_id));
    const idsB = new Set(claimsB.map((claim) => claim.event_id));
    expect([...idsA].some((id) => idsB.has(id))).toBe(false);
    expect(new Set([...idsA, ...idsB])).toEqual(new Set(seeded.map((row) => row.id)));
    expect(claimsA.every((claim) => claim.lease_owner === workerA && claim.attempts === 1)).toBe(true);
    expect(claimsB.every((claim) => claim.lease_owner === workerB && claim.attempts === 1)).toBe(true);
    expect([...claimsA, ...claimsB].every(
      (claim) => claim.lease_expires_at instanceof Date
        && claim.lease_expires_at.getTime() > Date.now(),
    )).toBe(true);
  }, 60_000);

  it('records all six handled types and one ignored outcome while observers remain clinically inert', async () => {
    const consumerKey = consumerFor('terminal_outcomes');
    const ignoredEventType = `test.pathway.s1a.ignored.${RUN_ID}`;
    const seeded = await prepareClaimableEvents({
      consumerKey,
      events: [
        ...PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.map((eventType) => ({ eventType })),
        { eventType: ignoredEventType },
      ],
    });
    const before = await noOpBoundaryCounts();
    const claims = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.length + 1,
      leaseOwner: randomUUID(),
    });
    expect(claims).toHaveLength(PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.length + 1);
    const outcomes = [];
    for (const claim of claims) {
      outcomes.push(await processClaimedInboxRow({ claim, registry: pathwayProjectorRegistry }));
    }
    for (const eventType of PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES) {
      const eventId = seeded.find((event) => event.event_type === eventType)?.id;
      expect(outcomes.find((row) => row.event_id === eventId)?.status).toBe('handled');
    }
    const ignoredEventId = seeded.find((event) => event.event_type === ignoredEventType)?.id;
    expect(outcomes.find((row) => row.event_id === ignoredEventId)?.status).toBe('ignored');
    expect(await noOpBoundaryCounts()).toEqual(before);
  }, 60_000);

  it('retries handler failures without double-increment and dead-letters the seventh failed claim', async () => {
    const consumerKey = consumerFor('handler_failure');
    const generation = 2;
    const eventType = `test.pathway.s1a.poison_${RUN_TOKEN}`;
    const [event] = await prepareClaimableEvents({
      consumerKey,
      generation,
      events: [{ eventType }],
    });
    const registry = throwingRegistry(generation, eventType);
    let outcome;
    for (let expectedAttempt = 1; expectedAttempt <= 7; expectedAttempt += 1) {
      await prisma.$executeRawUnsafe(
        `UPDATE pathway_projector_inbox
            SET next_attempt_at = NOW()
          WHERE consumer_key = $1 AND generation = $2::integer AND event_id = $3::bigint`,
        consumerKey,
        generation,
        event.id,
      );
      const [claim] = await claimDueInboxRows({
        consumerKey,
        generation,
        limit: 1,
        leaseOwner: randomUUID(),
      });
      expect(claim.attempts).toBe(expectedAttempt);
      outcome = await processClaimedInboxRow({ claim, registry });
      expect(outcome.attempts).toBe(expectedAttempt);
      expect(outcome.status).toBe(expectedAttempt === 7 ? 'dead' : 'pending');
      if (expectedAttempt <= HANDLER_RETRY_DELAYS_SECONDS.length) {
        await expectDbDelay(
          outcome.next_attempt_at,
          HANDLER_RETRY_DELAYS_SECONDS[expectedAttempt - 1],
        );
        expect(await claimDueInboxRows({ consumerKey, generation, limit: 1 })).toHaveLength(0);
      } else {
        expect(outcome.outcome_at).toBeInstanceOf(Date);
      }
    }
    const [finalRow] = await inboxRows(consumerKey, generation, [event.id]);
    expect(finalRow).toMatchObject({ status: 'dead', attempts: 7 });
    expect(finalRow.lease_owner).toBeNull();
    expect(finalRow.outcome_at).toBeInstanceOf(Date);
    expect(finalRow.last_error).toBe('Registered shadow observer processing failed');
    expect(await claimDueInboxRows({ consumerKey, generation, limit: 1 })).toHaveLength(0);
  }, 60_000);

  it('rolls back a handler database write before scheduling the original row for retry', async () => {
    const consumerKey = consumerFor('handler_tx_rollback');
    const markerConsumer = consumerFor('handler_tx_marker');
    const generation = 3;
    const eventType = `test.pathway.s1a.rollback_${RUN_TOKEN}`;
    const [event] = await prepareClaimableEvents({
      consumerKey,
      generation,
      events: [{ eventType }],
    });
    const registry = createPathwayProjectorRegistry({
      generation,
      entries: [[eventType, async ({ tx, tenantId, event: sourceEvent }) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO pathway_projector_inbox
             (tenant_id, consumer_key, generation, event_id)
           VALUES ($1::uuid, $2, $3::integer, $4::bigint)`,
          tenantId,
          markerConsumer,
          generation,
          sourceEvent.event_id,
        );
        throw new Error('forced failure after marker write');
      }]],
    });
    const [claim] = await claimDueInboxRows({
      consumerKey,
      generation,
      limit: 1,
      leaseOwner: randomUUID(),
    });

    const outcome = await processClaimedInboxRow({ claim, registry });
    expect(outcome).toMatchObject({ event_id: event.id, status: 'pending', attempts: 1 });
    expect(await inboxRows(markerConsumer, generation, [event.id])).toHaveLength(0);
    const [original] = await inboxRows(consumerKey, generation, [event.id]);
    expect(original).toMatchObject({ status: 'pending', attempts: 1, lease_owner: null });
    expect(original.last_error).toBe('Registered shadow observer processing failed');
  }, 60_000);

  it('applies the exact stale-reaper retry ladder for attempts one through six', async () => {
    const consumerKey = consumerFor('stale_retry_ladder');
    const seeded = await prepareClaimableEvents({
      consumerKey,
      events: HANDLER_RETRY_DELAYS_SECONDS.map(() => ({})),
    });
    const fixtures = seeded.map((event, index) => ({
      event,
      attempt: index + 1,
      delaySeconds: HANDLER_RETRY_DELAYS_SECONDS[index],
    }));
    for (const fixture of fixtures) {
      await prisma.$executeRawUnsafe(
        `UPDATE pathway_projector_inbox
            SET attempts = $4::integer - 1,
                next_attempt_at = NOW()
          WHERE consumer_key = $1
            AND generation = $2::integer
            AND event_id = $3::bigint`,
        consumerKey,
        1,
        fixture.event.id,
        fixture.attempt,
      );
    }

    const claims = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: fixtures.length,
      leaseOwner: randomUUID(),
    });
    expect(claims).toHaveLength(fixtures.length);
    for (const fixture of fixtures) {
      expect(claims.find((claim) => claim.event_id === fixture.event.id)?.attempts)
        .toBe(fixture.attempt);
    }
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE consumer_key = $1
          AND generation = 1
          AND event_id = ANY($2::bigint[])`,
      consumerKey,
      seeded.map((event) => event.id),
    );

    const reaped = await reapStaleInboxLeases({
      consumerKey,
      generation: 1,
      limit: fixtures.length,
    });
    expect(reaped).toMatchObject({
      reaped: fixtures.length,
      retried: fixtures.length,
      dead: 0,
    });
    for (const fixture of fixtures) {
      const row = reaped.rows.find((candidate) => candidate.event_id === fixture.event.id);
      expect(row).toMatchObject({ status: 'pending', attempts: fixture.attempt });
      await expectDbDelay(row.next_attempt_at, fixture.delaySeconds);
    }
    expect(await claimDueInboxRows({ consumerKey, generation: 1, limit: fixtures.length }))
      .toHaveLength(0);
  }, 60_000);

  it('lets an owner finish after expiry until reaped, then fences the old token after reclaim', async () => {
    const consumerKey = consumerFor('lease_fencing');
    const seeded = await prepareClaimableEvents({
      consumerKey,
      events: [{ eventType: HANDLED_EVENT_TYPE }, { eventType: HANDLED_EVENT_TYPE }],
    });
    const ownerBeforeReap = randomUUID();
    const [finishable] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: ownerBeforeReap,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      finishable.event_id,
    );
    expect((await processClaimedInboxRow({ claim: finishable, registry: pathwayProjectorRegistry })).status)
      .toBe('handled');

    const oldOwner = randomUUID();
    const [crashed] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: oldOwner,
    });
    expect(seeded.map((row) => row.id)).toContain(crashed.event_id);
    expect(crashed.event_id).not.toBe(finishable.event_id);
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      crashed.event_id,
    );
    const reaped = await reapStaleInboxLeases({ consumerKey, generation: 1, limit: 10 });
    expect(reaped).toMatchObject({ reaped: 1, retried: 1, dead: 0 });
    expect(reaped.rows[0].attempts).toBe(1);
    await expectDbDelay(reaped.rows[0].next_attempt_at, 30);
    expect(await claimDueInboxRows({ consumerKey, generation: 1, limit: 1 })).toHaveLength(0);

    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET next_attempt_at = NOW()
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      crashed.event_id,
    );
    const newOwner = randomUUID();
    const [reclaimed] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: newOwner,
    });
    expect(reclaimed).toMatchObject({ event_id: crashed.event_id, attempts: 2, lease_owner: newOwner });

    const stale = await processClaimedInboxRow({ claim: crashed, registry: pathwayProjectorRegistry });
    expect(stale).toMatchObject({ status: 'stale', event_id: crashed.event_id, attempts: 1 });
    const afterStale = await inboxRows(consumerKey, 1, [crashed.event_id]);
    expect(afterStale[0]).toMatchObject({ status: 'pending', attempts: 2, lease_owner: newOwner });

    const terminal = await processClaimedInboxRow({ claim: reclaimed, registry: pathwayProjectorRegistry });
    expect(terminal).toMatchObject({ status: 'handled', attempts: 2 });
    expect(await claimDueInboxRows({ consumerKey, generation: 1, limit: 10 })).toHaveLength(0);
    expect((await processClaimedInboxRow({ claim: reclaimed, registry: pathwayProjectorRegistry })).status)
      .toBe('stale');
  }, 60_000);

  it('fences a stale claim even when a later attempt deliberately reuses the same owner UUID', async () => {
    const consumerKey = consumerFor('same_token_fence');
    const [event] = await prepareClaimableEvents({
      consumerKey,
      events: [{ eventType: HANDLED_EVENT_TYPE }],
    });
    const reusedOwner = randomUUID();
    const [attemptOne] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: reusedOwner,
    });
    expect(attemptOne).toMatchObject({ event_id: event.id, attempts: 1, lease_owner: reusedOwner });
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      event.id,
    );
    expect(await reapStaleInboxLeases({ consumerKey, generation: 1, limit: 1 }))
      .toMatchObject({ reaped: 1, retried: 1, dead: 0 });
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET next_attempt_at = NOW()
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      event.id,
    );
    const [attemptTwo] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: reusedOwner,
    });
    expect(attemptTwo).toMatchObject({ event_id: event.id, attempts: 2, lease_owner: reusedOwner });

    expect(await processClaimedInboxRow({ claim: attemptOne, registry: pathwayProjectorRegistry }))
      .toMatchObject({ status: 'stale', event_id: event.id, attempts: 1 });
    const [stillAttemptTwo] = await inboxRows(consumerKey, 1, [event.id]);
    expect(stillAttemptTwo).toMatchObject({ status: 'pending', attempts: 2, lease_owner: reusedOwner });
    expect(await processClaimedInboxRow({ claim: attemptTwo, registry: pathwayProjectorRegistry }))
      .toMatchObject({ status: 'handled', event_id: event.id, attempts: 2 });
  }, 60_000);

  it('dead-letters a seventh stale claim without incrementing attempts in the reaper', async () => {
    const consumerKey = consumerFor('stale_dead');
    const [event] = await prepareClaimableEvents({ consumerKey, events: [{}] });
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET attempts = 6, next_attempt_at = NOW()
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      event.id,
    );
    const [claim] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: randomUUID(),
    });
    expect(claim.attempts).toBe(7);
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint`,
      consumerKey,
      event.id,
    );
    const result = await reapStaleInboxLeases({ consumerKey, generation: 1, limit: 1 });
    expect(result).toMatchObject({ reaped: 1, retried: 0, dead: 1 });
    expect(result.rows[0]).toMatchObject({ event_id: event.id, status: 'dead', attempts: 7 });
    expect(result.rows[0].outcome_at).toBeInstanceOf(Date);
    const [terminal] = await inboxRows(consumerKey, 1, [event.id]);
    expect(terminal).toMatchObject({ status: 'dead', attempts: 7, lease_owner: null });
    expect(terminal.outcome_at).toBeInstanceOf(Date);
    expect(await claimDueInboxRows({ consumerKey, generation: 1, limit: 1 })).toHaveLength(0);
  }, 60_000);

  it('fails closed for missing and tenant-mismatched source rows', async () => {
    const consumerKey = consumerFor('source_fail_closed');
    await primeConsumer(consumerKey);
    const missing = await seedOutboxEvent({ tenantId: TENANT_A });
    await materializeUntilPresent({ consumerKey, expectedEventIds: [missing.id] });
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox WHERE id = $1::bigint`,
      missing.id,
    );

    const mismatched = await seedOutboxEvent({ tenantId: TENANT_B });
    await prisma.$executeRawUnsafe(
      `INSERT INTO pathway_projector_inbox (tenant_id, consumer_key, generation, event_id)
       VALUES ($1::uuid, $2, 1, $3::bigint)`,
      TENANT_A,
      consumerKey,
      mismatched.id,
    );
    const claims = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 2,
      leaseOwner: randomUUID(),
    });
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      const outcome = await processClaimedInboxRow({ claim, registry: pathwayProjectorRegistry });
      expect(outcome).toMatchObject({ status: 'pending', attempts: 1 });
    }
    const rows = await inboxRows(consumerKey, 1, [missing.id, mismatched.id]);
    expect(rows.every((row) => row.status === 'pending' && row.outcome_at === null)).toBe(true);
    expect(rows.every((row) => row.last_error === 'Source event unavailable for claimed inbox row')).toBe(true);
  }, 60_000);

  it('enforces tenant visibility, claiming, finishing, and WITH CHECK through a non-owner role', async () => {
    const consumerKey = consumerFor('tenant_rls');
    const seeded = await prepareClaimableEvents({
      consumerKey,
      events: [{ tenantId: TENANT_A }, { tenantId: TENANT_B }],
    });
    const eventA = seeded.find((event) => event.tenant_id === TENANT_A);
    const eventB = seeded.find((event) => event.tenant_id === TENANT_B);
    expect(eventA).toBeDefined();
    expect(eventB).toBeDefined();
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_TEST_ROLE = RLS_ROLE;
    try {
      const visibleToA = await asAppRole(TENANT_A, (tx) => tx.$queryRawUnsafe(
        `SELECT event_id::text, tenant_id::text
           FROM pathway_projector_inbox
          WHERE consumer_key = $1 AND generation = 1
            AND event_id = ANY($2::bigint[])`,
        consumerKey,
        seeded.map((row) => row.id),
      ));
      expect(visibleToA).toEqual([{ event_id: eventA.id, tenant_id: TENANT_A }]);

      const ownerA = randomUUID();
      const claimedAsA = await runInTenantContext(TENANT_A, () => claimDueInboxRows({
        consumerKey,
        generation: 1,
        limit: 10,
        leaseOwner: ownerA,
      }));
      expect(claimedAsA).toHaveLength(1);
      expect(claimedAsA[0]).toMatchObject({ event_id: eventA.id, tenant_id: TENANT_A });

      const terminalAsA = await runInTenantContext(TENANT_A, () => processClaimedInboxRow({
        claim: claimedAsA[0],
        registry: pathwayProjectorRegistry,
      }));
      expect(terminalAsA).toMatchObject({
        event_id: eventA.id,
        tenant_id: TENANT_A,
        status: 'ignored',
      });

      const visibleAfterTerminal = await asAppRole(TENANT_A, (tx) => tx.$queryRawUnsafe(
        `SELECT event_id::text, tenant_id::text, status
           FROM pathway_projector_inbox
          WHERE consumer_key = $1 AND generation = 1
            AND event_id = ANY($2::bigint[])`,
        consumerKey,
        seeded.map((row) => row.id),
      ));
      expect(visibleAfterTerminal).toEqual([{
        event_id: eventA.id,
        tenant_id: TENANT_A,
        status: 'ignored',
      }]);
      expect(await runInTenantContext(TENANT_A, () => claimDueInboxRows({
        consumerKey,
        generation: 1,
        limit: 10,
        leaseOwner: randomUUID(),
      }))).toHaveLength(0);

      const finishedB = await asAppRole(TENANT_A, (tx) => tx.$queryRawUnsafe(
        `UPDATE pathway_projector_inbox
            SET status = 'ignored', outcome_at = NOW()
          WHERE consumer_key = $1 AND generation = 1 AND event_id = $2::bigint
          RETURNING event_id::text`,
        consumerKey,
        eventB.id,
      ));
      expect(finishedB).toHaveLength(0);

      await expect(asAppRole(TENANT_A, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO pathway_projector_inbox (tenant_id, consumer_key, generation, event_id)
         VALUES ($1::uuid, $2, 1, $3::bigint)`,
        TENANT_B,
        `${consumerKey}_wrong`,
        eventA.id,
      ))).rejects.toThrow();

      const bypassRows = await runWithSuperAdmin(() => prisma.$queryRawUnsafe(
        `SELECT event_id::text, tenant_id::text, status
           FROM pathway_projector_inbox
          WHERE consumer_key = $1 AND generation = 1
            AND event_id = ANY($2::bigint[])
          ORDER BY tenant_id`,
        consumerKey,
        seeded.map((row) => row.id),
      ));
      expect(bypassRows).toHaveLength(2);
      expect(bypassRows.find((row) => row.event_id === eventB.id)).toMatchObject({
        tenant_id: TENANT_B,
        status: 'pending',
      });
    } finally {
      if (savedRlsEnforcement === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
      else process.env.AUTH_ENFORCE_TENANT_RLS = savedRlsEnforcement;
      if (savedRlsRole === undefined) delete process.env.AUTH_TENANT_RLS_TEST_ROLE;
      else process.env.AUTH_TENANT_RLS_TEST_ROLE = savedRlsRole;
    }
  }, 60_000);

  it('never mutates webhook-owned source fields while processing the independent inbox', async () => {
    const consumerKey = consumerFor('source_immutable');
    const [event] = await prepareClaimableEvents({
      consumerKey,
      events: [{
        status: 'failed',
        attempts: 3,
        lastError: 'webhook-owned failure',
        eventType: HANDLED_EVENT_TYPE,
      }],
    });
    const before = await sourceSnapshot(event.id);
    const [claim] = await claimDueInboxRows({
      consumerKey,
      generation: 1,
      limit: 1,
      leaseOwner: randomUUID(),
    });
    expect((await processClaimedInboxRow({ claim, registry: pathwayProjectorRegistry })).status)
      .toBe('handled');
    expect(await sourceSnapshot(event.id)).toEqual(before);
  }, 60_000);
});
