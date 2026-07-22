import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import {
  completeClaimedEventFanout,
  failClaimedEvent,
  listEvents,
  reapStaleProcessingEvents,
  redriveFailedEvent,
} from '../services/events/eventOutboxService.js';

const databaseConfigured = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const describeWithDatabase = databaseConfigured ? describe : describe.skip;

const TENANT_ONE = '00000000-0000-4000-8000-000000000001';
const TENANT_TWO = randomUUID();
const ACTOR = randomUUID();
const RUN = `${process.pid}_${Date.now()}`;
const EVENT_TYPE = `test.event_outbox_recovery.${RUN}`;
const BIGINT_ID = '9007199254740997';

describeWithDatabase('event outbox recovery contracts (deep)', () => {
  const eventIds = [];
  const integrationIds = [];
  const subscriptionIds = [];

  async function seedEvent({
    tenantId = TENANT_ONE,
    eventType = EVENT_TYPE,
    status = 'pending',
    attempts = 0,
    leaseOwner = null,
    leaseExpiresAt = null,
    id = null,
  } = {}) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox
         (id, tenant_id, event_type, aggregate_type, payload, status, attempts,
          available_at, last_error, lease_owner, lease_expires_at, created_at)
       VALUES (COALESCE($1::bigint, nextval('event_outbox_id_seq')), $2::uuid, $3::text,
               'test_aggregate', '{}'::jsonb, $4::text, $5::integer, NOW(),
               CASE WHEN $4::text = 'failed' THEN 'terminal test failure' ELSE NULL END,
               $6::uuid, $7::timestamptz, NOW())
       RETURNING id::text, tenant_id, status, attempts, lease_owner, lease_expires_at`,
      id,
      tenantId,
      eventType,
      status,
      attempts,
      leaseOwner,
      leaseExpiresAt,
    );
    eventIds.push(rows[0].id);
    return rows[0];
  }

  async function createSubscription({
    tenantId = TENANT_ONE,
    integrationStatus = 'active',
    active = true,
    eventFilter = {},
    eventType = EVENT_TYPE,
  } = {}) {
    const integrations = await prisma.$queryRawUnsafe(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2::text, 'webhook', $3::text)
       RETURNING id`,
      tenantId,
      `outbox-recovery-${RUN}-${integrationIds.length}`,
      integrationStatus,
    );
    const integrationId = integrations[0].id;
    integrationIds.push(integrationId);
    const subscriptions = await prisma.$queryRawUnsafe(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, event_filter, endpoint_url,
          signing_algorithm, is_active)
       VALUES ($1::uuid, $2::integer, $3::text, $4::jsonb, $5::text, 'none', $6::boolean)
       RETURNING id`,
      tenantId,
      integrationId,
      eventType,
      JSON.stringify(eventFilter),
      `https://example.test/${RUN}/${subscriptionIds.length}`,
      active,
    );
    subscriptionIds.push(subscriptions[0].id);
    return subscriptions[0].id;
  }

  function claimFor(row) {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      attempts: row.attempts,
      lease_owner: row.lease_owner,
    };
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, $3::text)`,
      TENANT_TWO,
      `outbox-recovery-${RUN}`,
      `Outbox recovery ${RUN}`,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE resource IN ('event_outbox', 'webhook_delivery')
          AND resource_id = ANY($1::text[])`,
      eventIds.map(String),
    );
    if (eventIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox WHERE event_id = ANY($1::bigint[])`,
        eventIds.map(String),
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM webhook_deliveries WHERE event_outbox_id = ANY($1::bigint[])`,
        eventIds.map(String),
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM event_outbox WHERE id = ANY($1::bigint[])`,
        eventIds.map(String),
      );
    }
    if (subscriptionIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM webhook_subscriptions WHERE id = ANY($1::integer[])`,
        subscriptionIds,
      );
    }
    if (integrationIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM integrations WHERE id = ANY($1::integer[])`,
        integrationIds,
      );
    }
    await prisma.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', TENANT_TWO);
    await prisma.$disconnect();
  });

  it('atomically fans out once to only active empty-filter subscriptions', async () => {
    const eligibleOne = await createSubscription();
    const eligibleTwo = await createSubscription();
    await createSubscription({ active: false });
    await createSubscription({ integrationStatus: 'inactive' });
    await createSubscription({ eventFilter: { unsupported: true } });
    const leaseOwner = randomUUID();
    const source = await seedEvent({
      status: 'processing',
      attempts: 1,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await completeClaimedEventFanout({ claim: claimFor(source) });
    expect(result).toMatchObject({ delivered: true, lost_fence: false, enqueued: 2, eligible: 2 });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT subscription_id, event_outbox_id::text
         FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND event_outbox_id = $2::bigint
        ORDER BY subscription_id`,
      TENANT_ONE,
      source.id,
    );
    expect(rows.map((row) => row.subscription_id)).toEqual([eligibleOne, eligibleTwo].sort((a, b) => a - b));
    expect(rows.every((row) => row.event_outbox_id === source.id)).toBe(true);

    await expect(completeClaimedEventFanout({ claim: claimFor(source) }))
      .resolves.toMatchObject({ delivered: false, lost_fence: true });
    const duplicateCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND event_outbox_id = $2::bigint`,
      TENANT_ONE,
      source.id,
    );
    expect(duplicateCount[0].count).toBe(2);
  });

  it('rolls back both fan-out and source completion when a delivery insert fails', async () => {
    const eventType = `${EVENT_TYPE}.rollback`;
    await createSubscription({ eventType });
    const leaseOwner = randomUUID();
    const source = await seedEvent({
      eventType,
      status: 'processing',
      attempts: 1,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const functionName = `test_reject_delivery_${process.pid}`;
    const triggerName = `test_reject_delivery_${process.pid}`;
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $body$
       BEGIN
         IF NEW.event_outbox_id = ${source.id}::bigint THEN
           RAISE EXCEPTION 'injected fanout failure';
         END IF;
         RETURN NEW;
       END
       $body$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON webhook_deliveries
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      await expect(completeClaimedEventFanout({ claim: claimFor(source) }))
        .rejects.toThrow(/injected fanout failure/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON webhook_deliveries`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, lease_owner FROM event_outbox WHERE id = $1::bigint`,
      source.id,
    );
    expect(rows[0]).toMatchObject({ status: 'processing', lease_owner: leaseOwner });
    const deliveries = await prisma.$queryRawUnsafe(
      'SELECT id FROM webhook_deliveries WHERE event_outbox_id = $1::bigint',
      source.id,
    );
    expect(deliveries).toHaveLength(0);
  });

  it('delivers a source with zero matching subscriptions without inventing work', async () => {
    const leaseOwner = randomUUID();
    const source = await seedEvent({
      eventType: `${EVENT_TYPE}.zero`,
      status: 'processing',
      attempts: 1,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(completeClaimedEventFanout({ claim: claimFor(source) }))
      .resolves.toMatchObject({ delivered: true, enqueued: 0, eligible: 0 });
  });

  it('fences stale workers and reaps only expired leases, including attempt seven', async () => {
    const owner = randomUUID();
    const unexpired = await seedEvent({
      status: 'processing',
      attempts: 1,
      leaseOwner: owner,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    const expired = await seedEvent({
      status: 'processing',
      attempts: 7,
      leaseOwner: owner,
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });

    await expect(failClaimedEvent({
      claim: { ...claimFor(unexpired), lease_owner: randomUUID() },
      message: 'stale worker',
    })).resolves.toMatchObject({ lost_fence: true, failed: false });

    const beforeReap = await prisma.$queryRawUnsafe(
      `SELECT lease_expires_at > NOW() AS lease_is_live
         FROM event_outbox WHERE id = $1::bigint`,
      unexpired.id,
    );
    expect(beforeReap[0].lease_is_live).toBe(true);

    const reaped = await reapStaleProcessingEvents({ limit: 200 });
    expect(reaped.rows.map((row) => row.id)).toContain(expired.id);
    expect(reaped.rows.map((row) => row.id)).not.toContain(unexpired.id);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, status, lease_owner FROM event_outbox
        WHERE id IN ($1::bigint, $2::bigint) ORDER BY id`,
      unexpired.id,
      expired.id,
    );
    expect(rows.find((row) => row.id === unexpired.id)).toMatchObject({
      status: 'processing',
      lease_owner: owner,
    });
    expect(rows.find((row) => row.id === expired.id)).toMatchObject({
      status: 'failed',
      lease_owner: null,
    });
  });

  it('keeps BIGINT ids exact, tenant-scopes reads/redrive, audits atomically, and does not retrigger projector insert', async () => {
    const source = await seedEvent({
      tenantId: TENANT_ONE,
      status: 'failed',
      attempts: 7,
      id: BIGINT_ID,
    });
    const otherTenantSource = await seedEvent({
      tenantId: TENANT_TWO,
      status: 'failed',
      attempts: 7,
    });
    const beforeInbox = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::integer AS count FROM pathway_projector_inbox WHERE event_id = $1::bigint',
      source.id,
    );

    const listed = await listEvents({ tenantId: TENANT_ONE, status: 'failed', limit: 200 });
    expect(listed.map((row) => row.id)).toContain(BIGINT_ID);
    expect(listed.map((row) => row.id)).not.toContain(otherTenantSource.id);
    await expect(redriveFailedEvent({
      tenantId: TENANT_TWO,
      id: BIGINT_ID,
      reason: 'Cross-tenant attempt',
      actorUid: ACTOR,
      actorRole: 'ADMIN',
    })).rejects.toMatchObject({ statusCode: 404 });

    const redriven = await redriveFailedEvent({
      tenantId: TENANT_ONE,
      id: BIGINT_ID,
      reason: 'Reviewed source failure and approved retry',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: `request-${RUN}`,
    });
    expect(redriven).toMatchObject({ id: BIGINT_ID, status: 'pending', attempts: 0, redrive_count: 1 });
    const audits = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, uid, role, action, resource_id, metadata
         FROM audit_logs
        WHERE resource = 'event_outbox' AND resource_id = $1::text`,
      BIGINT_ID,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: TENANT_ONE,
      uid: ACTOR,
      role: 'SUPER_ADMIN',
      action: 'EVENT_OUTBOX_REDRIVEN',
      resource_id: BIGINT_ID,
    });
    expect(audits[0].metadata).toMatchObject({
      reason: 'Reviewed source failure and approved retry',
      prior_status: 'failed',
      prior_attempts: 7,
      resulting_status: 'pending',
    });
    const afterInbox = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::integer AS count FROM pathway_projector_inbox WHERE event_id = $1::bigint',
      source.id,
    );
    expect(afterInbox[0].count).toBe(beforeInbox[0].count);
  });
});
