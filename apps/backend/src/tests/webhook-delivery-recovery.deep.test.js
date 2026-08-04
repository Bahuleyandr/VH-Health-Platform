import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';
import {
  dispatchPendingDeliveries,
  redriveDelivery,
  reapStaleInFlightDeliveries,
} from '../services/integrations/webhookDeliveryService.js';

const databaseConfigured = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const describeWithDatabase = databaseConfigured ? describe : describe.skip;

const TENANT = randomUUID();
const WRONG_TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = randomUUID();
const RUN = `${process.pid}_${Date.now()}`;

describeWithDatabase('webhook delivery recovery contracts (deep)', () => {
  let integrationId;
  let subscriptionId;

  async function setIntegrationStatus(status) {
    await prisma.$executeRawUnsafe(
      'UPDATE integrations SET status = $2::text WHERE tenant_id = $1::uuid AND id = $3::integer',
      TENANT,
      status,
      integrationId,
    );
  }

  async function setSubscriptionFilter(filter) {
    await prisma.$executeRawUnsafe(
      `UPDATE webhook_subscriptions
          SET event_filter = $3::jsonb
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      subscriptionId,
      JSON.stringify(filter),
    );
  }

  async function seedDelivery({
    status = 'pending',
    attemptNumber = 0,
    subscription = subscriptionId,
    leaseOwner = null,
    leaseExpiresAt = null,
    eventType = `test.webhook.${RUN}`,
  } = {}) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_type, payload, status, attempt_number,
          next_retry_at, request_id, lease_owner, lease_expires_at, started_at,
          source_kind, source_identity, payload_sha256)
       VALUES ($1::uuid, $2::integer, $3::text, '{}'::jsonb, $4::text, $5::integer,
               NOW(), $6::text, $7::uuid, $8::timestamptz,
               CASE WHEN $4::text = 'in_flight' THEN NOW() ELSE NULL END,
               CASE WHEN $2::integer IS NULL THEN 'legacy_orphan' ELSE 'adhoc' END,
               $6::text, encode(digest('{}'::jsonb::text, 'sha256'), 'hex'))
       RETURNING id, status, attempt_number, lease_owner, lease_expires_at`,
      TENANT,
      subscription,
      eventType,
      status,
      attemptNumber,
      `request-${randomUUID()}`,
      leaseOwner,
      leaseExpiresAt,
    );
    return rows[0];
  }

  async function deliveryRow(id) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status, attempt_number, lease_owner, lease_expires_at,
              http_status, completed_at, redrive_count
         FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      id,
    );
    return rows[0];
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      'INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2::text, $3::text)',
      TENANT,
      `webhook-recovery-${RUN}`,
      `Webhook recovery ${RUN}`,
    );
    const integrations = await prisma.$queryRawUnsafe(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2::text, 'webhook', 'active') RETURNING id`,
      TENANT,
      `webhook-recovery-${RUN}`,
    );
    integrationId = integrations[0].id;
    const subscriptions = await prisma.$queryRawUnsafe(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, event_filter, endpoint_url,
          signing_algorithm, is_active)
       VALUES ($1::uuid, $2::integer, $3::text, '{}'::jsonb,
               'https://8.8.8.8/hook', 'none', TRUE)
       RETURNING id`,
      TENANT,
      integrationId,
      `test.webhook.${RUN}`,
    );
    subscriptionId = subscriptions[0].id;
  });

  afterEach(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      await tx.$executeRawUnsafe(
        "DELETE FROM audit_logs WHERE tenant_id = $1::uuid AND resource = 'webhook_delivery'",
        TENANT,
      );
    });
    await prisma.$executeRawUnsafe('DELETE FROM webhook_deliveries WHERE tenant_id = $1::uuid', TENANT);
    await prisma.$executeRawUnsafe('DELETE FROM integration_logs WHERE tenant_id = $1::uuid', TENANT);
    await setIntegrationStatus('active');
    await prisma.$executeRawUnsafe(
      `UPDATE webhook_subscriptions
          SET event_filter = '{}'::jsonb,
              is_active = TRUE,
              consecutive_failures = 0,
              last_failure_at = NULL,
              last_delivered_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      subscriptionId,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', TENANT);
    await prisma.$disconnect();
  });

  it('leases, delivers, preserves a stable delivery id, and updates the subscription in the fenced transaction', async () => {
    const delivery = await seedDelivery();
    const fetchMock = jest.fn(async () => ({ status: 204, text: async () => '' }));
    const result = await dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      leaseOwner: randomUUID(),
    });
    expect(result).toMatchObject({
      dispatched: 1,
      succeeded: 1,
      failed: 0,
      dead: 0,
      lost_fence: 0,
    });
    expect(fetchMock.mock.calls[0][1].headers['X-VHHealth-Delivery-Id']).toBe(String(delivery.id));
    await expect(deliveryRow(delivery.id)).resolves.toMatchObject({
      status: 'succeeded',
      attempt_number: 1,
      lease_owner: null,
      http_status: 204,
    });
    const subscriptions = await prisma.$queryRawUnsafe(
      `SELECT consecutive_failures, last_delivered_at
         FROM webhook_subscriptions WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      subscriptionId,
    );
    expect(subscriptions[0].consecutive_failures).toBe(0);
    expect(subscriptions[0].last_delivered_at).toBeTruthy();
  });

  it('does not let a stale worker complete after its lease owner changes', async () => {
    const delivery = await seedDelivery();
    const replacementOwner = randomUUID();
    const fetchMock = jest.fn(async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE webhook_deliveries
            SET lease_owner = $3::uuid,
                lease_expires_at = '2000-01-01T00:00:00Z'::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::integer AND status = 'in_flight'`,
        TENANT,
        delivery.id,
        replacementOwner,
      );
      return { status: 200, text: async () => 'ok' };
    });
    const result = await dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      leaseOwner: randomUUID(),
    });
    expect(result).toMatchObject({ dispatched: 1, succeeded: 0, lost_fence: 1 });
    await expect(deliveryRow(delivery.id)).resolves.toMatchObject({
      status: 'in_flight',
      lease_owner: replacementOwner,
      http_status: null,
    });
    const reaped = await reapStaleInFlightDeliveries({ limit: 200 });
    expect(reaped.rows.map((row) => row.id)).toContain(delivery.id);
    await expect(deliveryRow(delivery.id)).resolves.toMatchObject({
      status: 'failed',
      lease_owner: null,
    });
  });

  it('makes inactive parents and unsupported filters fetch-ineligible, then resumes after explicit reactivation', async () => {
    const parentParked = await seedDelivery();
    await setIntegrationStatus('inactive');
    const fetchMock = jest.fn(async () => ({ status: 200, text: async () => 'ok' }));
    await expect(dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      leaseOwner: randomUUID(),
    })).resolves.toMatchObject({ dispatched: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(deliveryRow(parentParked.id)).resolves.toMatchObject({ status: 'pending' });

    await setIntegrationStatus('active');
    await setSubscriptionFilter({ unsupported: true });
    await expect(dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      leaseOwner: randomUUID(),
    })).resolves.toMatchObject({ dispatched: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    await setSubscriptionFilter({});
    await expect(dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      leaseOwner: randomUUID(),
    })).resolves.toMatchObject({ dispatched: 1, succeeded: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(deliveryRow(parentParked.id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('dead-letters orphan rows without outbound fetch', async () => {
    const orphan = await seedDelivery({ subscription: null });
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      leaseOwner: randomUUID(),
    });
    expect(result).toMatchObject({ dispatched: 0, dead: 1, orphaned: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(deliveryRow(orphan.id)).resolves.toMatchObject({ status: 'dead' });
  });

  it('dead-letters the seventh failed attempt and permits only audited dead-state redrive', async () => {
    const delivery = await seedDelivery({ attemptNumber: 6 });
    await expect(dispatchPendingDeliveries({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => ({ status: 503, text: async () => 'busy' })),
      leaseOwner: randomUUID(),
    })).resolves.toMatchObject({ dispatched: 1, dead: 1, failed: 0 });
    await expect(deliveryRow(delivery.id)).resolves.toMatchObject({
      status: 'dead',
      attempt_number: 7,
    });

    await expect(redriveDelivery({
      tenantId: WRONG_TENANT,
      id: delivery.id,
      reason: 'Cross-tenant attempt',
      actorUid: ACTOR,
      actorRole: 'ADMIN',
    })).rejects.toMatchObject({ statusCode: 404 });

    const redriven = await redriveDelivery({
      tenantId: TENANT,
      id: delivery.id,
      reason: 'Endpoint owner confirmed recovery',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: `request-${RUN}`,
    });
    expect(redriven).toMatchObject({
      status: 'pending',
      attempt_number: 0,
      redrive_count: 1,
    });
    const audits = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, uid, role, action, metadata
         FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND resource = 'webhook_delivery'
          AND resource_id = $2::text`,
      TENANT,
      String(delivery.id),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: TENANT,
      uid: ACTOR,
      role: 'SUPER_ADMIN',
      action: 'WEBHOOK_DELIVERY_REDRIVEN',
    });
    expect(audits[0].metadata).toMatchObject({
      reason: 'Endpoint owner confirmed recovery',
      prior_status: 'dead',
      prior_attempt_number: 7,
      resulting_status: 'pending',
      resulting_attempt_number: 0,
    });
  });

  it('reaps an expired attempt-seven lease directly to dead', async () => {
    const delivery = await seedDelivery({
      status: 'in_flight',
      attemptNumber: 7,
      leaseOwner: randomUUID(),
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    const result = await reapStaleInFlightDeliveries({ limit: 200 });
    expect(result.rows.map((row) => row.id)).toContain(delivery.id);
    await expect(deliveryRow(delivery.id)).resolves.toMatchObject({
      status: 'dead',
      attempt_number: 7,
      lease_owner: null,
    });
  });
});
