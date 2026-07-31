import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  claimDueInboxRows,
  processClaimedInboxRow,
} from '../services/events/pathwayProjectorService.js';
import { createPathwayProjectorRegistry } from '../services/events/pathwayProjectorRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const FINGERPRINT = 'a'.repeat(64);
const OCCURRED_AT = '2026-07-30T12:00:00.000Z';
const CONSUMER_KEY = `c61_late_fence_${SUFFIX}`;
const GENERATION = 77;
const EVENT_TYPE = `test.external_recovery.late_${SUFFIX}`;

let facilityId;
let taskId;
let offsetId;
let recoveryInboxId;
let eventId;

async function guardedInsert(statement, params = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [TENANT_ID],
    );
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)",
    );
    let failure;
    try {
      await client.query(statement, params);
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK');
    expect(failure).toMatchObject({
      code: '23514',
      constraint: 'chk_external_recovery_late_effect_guard',
    });
  } finally {
    await client.end();
  }
}

describeIfDb('late external-recovery effect fences', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1 late fence tenant')`,
      TENANT_ID,
      `c61-late-${SUFFIX}`,
    );
    const facilities = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, timezone)
       VALUES ($1::uuid, $2::text, 'C6.1 late fence facility', 'Asia/Kolkata')
       RETURNING id`,
      TENANT_ID,
      `C61-LATE-${SUFFIX}`,
    );
    facilityId = facilities[0].id;
    const tasks = await prisma.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, related_resource_type,
          related_resource_id, priority, status, metadata)
       VALUES
         ($1::uuid, 'review', 'Synthetic late recovery review',
          'cold_chain_readings', $2::text, 'normal', 'open',
          '{"contract":"external_recovery_late_pending_only_v1"}'::jsonb)
       RETURNING id`,
      TENANT_ID,
      `synthetic-${SUFFIX}`,
    );
    taskId = tasks[0].id;
    await setTenantTx(TENANT_ID, async (tx) => {
      const offsets = await tx.$queryRawUnsafe(
        `INSERT INTO event_consumer_offsets
           (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
            direction, source_partition, consumer_key, generation, cursor_kind,
            high_water_position, high_water_token, recovery_state,
            policy_version, policy_signature, retention_policy, retention_until,
            historical_cutoff_event_id, backfill_cursor_event_id)
         VALUES
           ('external_interface', $1::uuid, 'facility', $2::integer, 'I10',
            'inbound', $3::text, 'external:I10', 1,
            'monotonic_position_and_predecessor', 10, 'token-10', 'paused',
            'c-d8-v1', 'synthetic-signature', 'cold-chain-730d',
            NOW() + INTERVAL '730 days', NULL, NULL)
         RETURNING offset_id::text`,
        TENANT_ID,
        facilityId,
        `late-fence-${SUFFIX}`,
      );
      offsetId = offsets[0].offset_id;
      const inbox = await tx.$queryRawUnsafe(
        `INSERT INTO pathway_projector_inbox
           (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
            interface_family, direction, source_partition, source_position,
            source_token, predecessor_token, duplicate_key, command_fingerprint,
            occurred_at, received_at, recorded_at, arrival_class,
            effect_disposition, status, outcome_at, outcome_code, pending_task_id,
            policy_version, policy_signature, retention_policy, retention_until)
         VALUES
           ('external_interface', $1::uuid, 'external:I10', 1, $2::uuid,
            $3::integer, 'I10', 'inbound', $4::text, 11, 'token-11', 'token-10',
            $5::text, $6::char(64), $7::timestamptz, NOW(), NOW(),
            'recovery_backlog', 'late_pending_only', 'handled', NOW(),
            'cold_chain_reading_pending_review', $8::integer,
            'c-d8-v1', 'synthetic-signature', 'cold-chain-730d',
            NOW() + INTERVAL '730 days')
         RETURNING inbox_id::text`,
        TENANT_ID,
        offsetId,
        facilityId,
        `late-fence-${SUFFIX}`,
        `reading-${SUFFIX}`,
        FINGERPRINT,
        OCCURRED_AT,
        taskId,
      );
      recoveryInboxId = inbox[0].inbox_id;
    });
    const events = await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox
         (event_type, aggregate_type, aggregate_id, payload, tenant_id, status,
          available_at, created_at, occurred_at, occurred_at_source,
          recovery_inbox_id, recovery_fingerprint,
          recovery_effect_disposition)
       VALUES
         ($1::text, 'c6_1_late_test', $2::text, '{}'::jsonb, $3::uuid,
          'pending', NOW(), NOW(), $4::timestamptz, 'explicit', $5::uuid,
          $6::char(64), 'late_pending_only')
       RETURNING id::text`,
      EVENT_TYPE,
      SUFFIX,
      TENANT_ID,
      OCCURRED_AT,
      recoveryInboxId,
      FINGERPRINT,
    );
    eventId = events[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, event_id)
       VALUES
         ('pathway_registry', $1::uuid, $2::text, $3::integer, $4::bigint)
       ON CONFLICT DO NOTHING`,
      TENANT_ID,
      CONSUMER_KEY,
      GENERATION,
      eventId,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid
          AND scope_kind = 'pathway_registry'
          AND (event_id = $2::bigint OR consumer_key = $3::text)`,
      TENANT_ID,
      eventId,
      CONSUMER_KEY,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      eventId,
    ).catch(() => {});
    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox
          WHERE tenant_id = $1::uuid
            AND scope_kind = 'external_interface'
            AND inbox_id = $2::uuid`,
        TENANT_ID,
        recoveryInboxId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        TENANT_ID,
        offsetId,
      );
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM facilities WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$disconnect();
  }, 60_000);

  it.each([
    [
      'workflow SLA',
      `INSERT INTO workflow_sla_instances (tenant_id)
       VALUES ($1::uuid)`,
      [TENANT_ID],
    ],
    [
      'pathway transition',
      `INSERT INTO care_pathway_transition_events (tenant_id)
       VALUES ($1::uuid)`,
      [TENANT_ID],
    ],
    [
      'notification',
      `INSERT INTO notification_outbox (type, title, body)
       VALUES ('push', 'blocked', 'blocked')`,
      [],
    ],
  ])('database guard rejects retrospective %s creation', async (
    _label,
    statement,
    params,
  ) => {
    await guardedInsert(statement, params);
  });

  it('records a typed ignored projector outcome without invoking the handler', async () => {
    const handler = jest.fn().mockResolvedValue({ should_not_run: true });
    const registry = createPathwayProjectorRegistry({
      generation: GENERATION,
      entries: [[EVENT_TYPE, handler]],
    });
    const claims = await claimDueInboxRows({
      consumerKey: CONSUMER_KEY,
      generation: GENERATION,
      limit: 1,
      leaseOwner: randomUUID(),
    });
    expect(claims).toHaveLength(1);
    const outcome = await processClaimedInboxRow({
      claim: claims[0],
      registry,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'ignored',
      outcome_code: 'late_pending_only_pathway_suppressed',
      metadata: {
        recovery_inbox_id: recoveryInboxId,
        pending_task_id: taskId,
      },
    });
  });
});
