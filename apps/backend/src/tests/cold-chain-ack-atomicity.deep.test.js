import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const FORCED_POST_BODY_FAILURE = 'forced failure after cold-chain tenant transaction body';
const ctl = { failAfterBody: false, failSlaStart: false, throwSlaStart: false };

const actualPrismaModule = await import('../lib/prisma.js');

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx: async (tenantId, fn, options) => actualPrismaModule.setTenantTx(
    tenantId,
    async (tx) => {
      const result = await fn(tx);
      if (ctl.failAfterBody) throw new Error(FORCED_POST_BODY_FAILURE);
      return result;
    },
    options,
  ),
}));

const actualCanonicalModule = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonicalModule,
  startWorkflowSla: (...args) => {
    if (ctl.throwSlaStart) throw new Error('forced cold-chain SLA start failure');
    return ctl.failSlaStart ? Promise.resolve(null) : actualCanonicalModule.startWorkflowSla(...args);
  },
}));

const prisma = (await import('../lib/prisma.js')).default;
const {
  acknowledgeColdChainExcursion,
  recordColdChainCorrectiveAction,
  runSilentSensorWatchdog,
} = await import('../services/devices/coldChainService.js');
const { acknowledgeTask, transitionTask } = await import('../services/workflow/taskService.js');

const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SLA_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const TENANT_SLUG = `cc-ack-atomic-${SUFFIX}`;
const DEVICE_CODE = `CC-ACK-DEVICE-${SUFFIX}`;
const UNIT_CODE = `CC-ACK-UNIT-${SUFFIX}`;
const ACTOR_PHONE = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let deviceId;
let unitId;
let excursionId;
let taskId;

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cold_chain_excursions WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_rules WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cold_chain_units WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM device_registry WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_ID,
      ACTOR_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    );
  });
}

async function seedLinkedExcursion() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, 'Cold-chain acknowledgement atomicity tenant')`,
    TENANT_ID,
    TENANT_SLUG,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO workflow_sla_rules
       (tenant_id, rule_code, title, trigger_event_type, target_minutes,
        severity, owner_role_codes, escalation_role_codes, enabled, metadata)
     SELECT $1::uuid, rule_code, title, trigger_event_type, target_minutes,
            severity, owner_role_codes, escalation_role_codes, TRUE,
            metadata || '{"test":"cold_chain_ack_atomicity"}'::jsonb
       FROM workflow_sla_rules
      WHERE rule_code = 'cold_chain_excursion_ack'
        AND enabled = TRUE
      ORDER BY tenant_id NULLS FIRST
      LIMIT 1`,
    TENANT_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Cold-chain acknowledgement responder',
             'PHARMACY_STAFF', TRUE, $3::uuid, NOW())`,
    ACTOR_UID,
    ACTOR_PHONE,
    TENANT_ID,
  );
  const devices = await prisma.$queryRawUnsafe(
    `INSERT INTO device_registry
       (tenant_id, device_code, display_name, kind, protocol, status, metadata)
     VALUES ($1::uuid, $2, 'Atomicity test cold-chain sensor',
             'fridge_sensor', 'http-json', 'active', '{"test":"cold_chain_ack_atomicity"}'::jsonb)
     RETURNING id`,
    TENANT_ID,
    DEVICE_CODE,
  );
  deviceId = devices[0].id;

  const units = await prisma.$queryRawUnsafe(
    `INSERT INTO cold_chain_units
       (tenant_id, unit_code, display_name, kind, department, device_registry_id,
        min_temp_c, max_temp_c, excursion_grace_minutes, alert_roles, status,
        retention_days, metadata, created_by)
     VALUES ($1::uuid, $2, 'Atomicity test vaccine refrigerator', 'fridge',
             'pharmacy', $3, 2.00, 8.00, 15, ARRAY['PHARMACY_STAFF']::text[],
             'active', 730, '{"test":"cold_chain_ack_atomicity"}'::jsonb, $4::uuid)
     RETURNING id`,
    TENANT_ID,
    UNIT_CODE,
    deviceId,
    ACTOR_UID,
  );
  unitId = units[0].id;

  const excursions = await prisma.$queryRawUnsafe(
    `INSERT INTO cold_chain_excursions
       (tenant_id, unit_id, breach_started_at, opened_at, last_out_of_range_at,
        breach_direction, peak_temp_c, min_seen_temp_c, max_seen_temp_c,
        severity, status, metadata)
     VALUES ($1::uuid, $2, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '15 minutes',
             NOW() - INTERVAL '1 minute', 'high', 12.50, 5.00, 12.50,
             'critical', 'open', '{"test":"cold_chain_ack_atomicity"}'::jsonb)
     RETURNING id`,
    TENANT_ID,
    unitId,
  );
  excursionId = excursions[0].id;

  await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, priority,
          started_at, due_at, assigned_role_codes, metadata)
       VALUES ($1::uuid, $2::uuid, 'cold_chain_excursion_ack',
               'cold_chain_excursions', $3, 'active', 'critical', NOW(),
               NOW() + INTERVAL '15 minutes', ARRAY['PHARMACY_STAFF']::text[],
               '{"test":"cold_chain_ack_atomicity","task_materialization_contract":"application_atomic_v1"}'::jsonb)`,
      SLA_ID,
      TENANT_ID,
      String(excursionId),
    );

    const tasks = await tx.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, description, related_resource_type,
          related_resource_id, priority, status, assigned_to_uid, assigned_to_role,
          created_by, due_at, workflow_sla_instance_id, sla_completion_semantics, metadata)
       VALUES ($1::uuid, 'review', 'Acknowledge cold-chain excursion',
                'Atomicity regression fixture', 'cold_chain_excursions', $2,
                'critical', 'open', NULL, 'PHARMACY_INCHARGE', $3::uuid,
                (SELECT due_at
                   FROM workflow_sla_instances
                  WHERE tenant_id = $1::uuid
                    AND id = $4::uuid),
                $4::uuid, 'acknowledgement',
                jsonb_build_object(
                  'sla_key', 'cold_chain_excursion_ack',
                  'unit_id', $5::int,
                  'test', 'cold_chain_ack_atomicity'
               ))
       RETURNING id`,
      TENANT_ID,
      String(excursionId),
      ACTOR_UID,
      SLA_ID,
      unitId,
    );
    taskId = tasks[0].id;

    await tx.$executeRawUnsafe(
      `UPDATE cold_chain_excursions
          SET task_id = $3, sla_instance_id = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      excursionId,
      taskId,
      SLA_ID,
    );
  });
}

d('cold-chain acknowledgement transaction atomicity', () => {
  beforeAll(async () => {
    await cleanup();
    await seedLinkedExcursion();
  }, 60_000);

  afterEach(() => {
    ctl.failAfterBody = false;
    ctl.failSlaStart = false;
    ctl.throwSlaStart = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('distinguishes SLA failure from missing policy, preserves degraded work, and deduplicates retries', async () => {
    const retryDeviceCode = `CC-RETRY-DEVICE-${SUFFIX}`;
    const retryUnitCode = `CC-RETRY-UNIT-${SUFFIX}`;
    const devices = await prisma.$queryRawUnsafe(
      `INSERT INTO device_registry
         (tenant_id, device_code, display_name, kind, protocol, status,
          last_seen_at, expected_interval_seconds, metadata)
       VALUES ($1::uuid, $2, 'Cold-chain SLA retry sensor',
               'fridge_sensor', 'http-json', 'active',
               NOW() - INTERVAL '1 hour', 300,
               '{"test":"cold_chain_sla_retry"}'::jsonb)
       RETURNING id`,
      TENANT_ID,
      retryDeviceCode,
    );
    const units = await prisma.$queryRawUnsafe(
      `INSERT INTO cold_chain_units
         (tenant_id, unit_code, display_name, kind, department, device_registry_id,
          min_temp_c, max_temp_c, excursion_grace_minutes, alert_roles, status,
          retention_days, metadata, created_by)
       VALUES ($1::uuid, $2, 'Cold-chain SLA retry refrigerator', 'fridge',
               'pharmacy', $3, 2.00, 8.00, 15, ARRAY['PHARMACY_STAFF']::text[],
               'active', 730, '{"test":"cold_chain_sla_retry"}'::jsonb, $4::uuid)
       RETURNING id`,
      TENANT_ID,
      retryUnitCode,
      devices[0].id,
      ACTOR_UID,
    );
    const retryUnitId = units[0].id;

    ctl.throwSlaStart = true;
    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID }))
      .rejects.toThrow('forced cold-chain SLA start failure');

    const rolledBack = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM cold_chain_excursions
           WHERE tenant_id = $1::uuid AND unit_id = $2::int) AS excursion_count,
         (SELECT COUNT(*)::int
            FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = 'cold_chain_excursions') AS task_count`,
      TENANT_ID,
      retryUnitId,
    );
    expect(rolledBack[0]).toEqual({ excursion_count: 0, task_count: 1 });

    ctl.throwSlaStart = false;
    ctl.failSlaStart = true;
    const degraded = await runSilentSensorWatchdog({ tenantId: TENANT_ID });
    expect(degraded.count).toBe(1);
    const degradedRails = await prisma.$queryRawUnsafe(
      `SELECT excursion.id AS excursion_id,
              excursion.sla_instance_id,
              task.id AS task_id,
              task.workflow_sla_instance_id,
              task.sla_completion_semantics,
              task.due_at,
              task.metadata,
              (SELECT COUNT(*)::int
                 FROM workflow_sla_instances sla
                WHERE sla.tenant_id = excursion.tenant_id
                  AND sla.source_table = 'cold_chain_excursions'
                  AND sla.source_id = excursion.id::text) AS sla_count
         FROM cold_chain_excursions excursion
         JOIN tasks task
           ON task.tenant_id = excursion.tenant_id
           AND task.id = excursion.task_id
        WHERE excursion.tenant_id = $1::uuid
          AND excursion.unit_id = $2::int`,
      TENANT_ID,
      retryUnitId,
    );
    expect(degradedRails).toHaveLength(1);
    expect(degradedRails[0]).toMatchObject({
      sla_instance_id: null,
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      due_at: null,
      sla_count: 0,
      metadata: {
        requested_sla_key: 'cold_chain_excursion_ack',
        sla_policy_status: 'missing',
      },
    });
    expect(degradedRails[0].metadata).not.toHaveProperty('sla_key');
    expect(degradedRails[0].metadata).not.toHaveProperty('sla_instance_id');

    const duplicate = await runSilentSensorWatchdog({ tenantId: TENANT_ID });
    expect(duplicate.count).toBe(0);
    const counts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM cold_chain_excursions
           WHERE tenant_id = $1::uuid AND unit_id = $2::int) AS excursion_count,
         (SELECT COUNT(*)::int
            FROM tasks task
            JOIN cold_chain_excursions excursion
              ON excursion.tenant_id = task.tenant_id
             AND excursion.id::text = task.related_resource_id
           WHERE task.tenant_id = $1::uuid
             AND excursion.unit_id = $2::int) AS task_count`,
      TENANT_ID,
      retryUnitId,
    );
    expect(counts[0]).toEqual({ excursion_count: 1, task_count: 1 });

    await expect(recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: degraded.opened[0].excursion.id,
      correctiveAction: 'Moved degraded-policy stock to a backup unit',
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).resolves.toMatchObject({ status: 'acknowledged' });
    const degradedTask = await prisma.$queryRawUnsafe(
      `SELECT task.status, task.workflow_sla_instance_id,
              task.sla_completion_semantics, task.metadata
         FROM tasks task
         JOIN cold_chain_excursions excursion
           ON excursion.tenant_id = task.tenant_id
          AND excursion.task_id = task.id
        WHERE excursion.tenant_id = $1::uuid
          AND excursion.id = $2::bigint`,
      TENANT_ID,
      degraded.opened[0].excursion.id,
    );
    expect(degradedTask[0]).toMatchObject({
      status: 'in_progress',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      metadata: {
        requested_sla_key: 'cold_chain_excursion_ack',
        sla_policy_status: 'missing',
      },
    });
  }, 60_000);

  it('rolls back the excursion, linked task, SLA, and task comment when the outer tenant transaction fails', async () => {
    ctl.failAfterBody = true;

    await expect(acknowledgeColdChainExcursion({
      tenantId: TENANT_ID,
      id: excursionId,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).rejects.toThrow(FORCED_POST_BODY_FAILURE);

    const excursionRows = await prisma.$queryRawUnsafe(
      `SELECT status, acknowledged_by, acknowledged_at
         FROM cold_chain_excursions
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      excursionId,
    );
    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT status, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
    );

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::double precision AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );

    const comments = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );

    expect({
      excursionStatus: excursionRows[0].status,
      excursionAcknowledgedBy: excursionRows[0].acknowledged_by,
      excursionAcknowledgedAt: excursionRows[0].acknowledged_at,
      taskStatus: taskRows[0].status,
      taskHasAcknowledgedAt: Object.hasOwn(taskRows[0].metadata, 'acknowledged_at'),
      taskHasAcknowledgedBy: Object.hasOwn(taskRows[0].metadata, 'acknowledged_by'),
      taskHasAcknowledgedVia: Object.hasOwn(taskRows[0].metadata, 'acknowledged_via'),
      taskHasOverrideReason: Object.hasOwn(taskRows[0].metadata, 'acknowledge_override_reason'),
      slaStatus: slaRows[0].status,
      slaCompletedAt: slaRows[0].completed_at,
      slaHasCompletedVia: Object.hasOwn(slaRows[0].metadata, 'completed_via'),
      taskCommentCount: comments.length,
    }).toEqual({
      excursionStatus: 'open',
      excursionAcknowledgedBy: null,
      excursionAcknowledgedAt: null,
      taskStatus: 'open',
      taskHasAcknowledgedAt: false,
      taskHasAcknowledgedBy: false,
      taskHasAcknowledgedVia: false,
      taskHasOverrideReason: false,
      slaStatus: 'active',
      slaCompletedAt: null,
      slaHasCompletedVia: false,
      taskCommentCount: 0,
    });
  }, 30_000);

  it('rejects cancellation while the cold-chain acknowledgement obligation is incomplete', async () => {
    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: taskId,
      nextStatus: 'cancelled',
      actorUid: ACTOR_UID,
    })).rejects.toMatchObject({ code: 'TASK_LINKED_SLA_INCOMPLETE' });

    const [taskRows, slaRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT status FROM tasks WHERE tenant_id = $1::uuid AND id = $2`,
        TENANT_ID,
        taskId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT status, completed_at
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT_ID,
        SLA_ID,
      ),
    ]);
    expect(taskRows[0].status).toBe('open');
    expect(slaRows[0]).toMatchObject({ status: 'active', completed_at: null });
  }, 30_000);

  it('rejects the generic in-progress transition without stopping the acknowledgement clock', async () => {
    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: taskId,
      nextStatus: 'in_progress',
      actorUid: ACTOR_UID,
      acknowledgementTransitionAuthority: { source: 'caller-controlled' },
      metadata: { acknowledged_at: new Date().toISOString() },
    })).rejects.toMatchObject({ code: 'TASK_ACKNOWLEDGEMENT_REQUIRED' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT task.status AS task_status,
              task.metadata AS task_metadata,
              sla.status AS sla_status,
              sla.completed_at AS sla_completed_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid AND task.id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(rows[0]).toMatchObject({
      task_status: 'open',
      sla_status: 'active',
      sla_completed_at: null,
    });
    expect(rows[0].task_metadata.acknowledged_at).toBeUndefined();
  }, 30_000);

  it('commits an authorized cold-chain responder as a resource-bound audited override', async () => {
    await expect(acknowledgeColdChainExcursion({
      tenantId: TENANT_ID,
      id: excursionId,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).resolves.toMatchObject({ status: 'acknowledged' });

    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT status, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(taskRows[0]).toMatchObject({
      status: 'in_progress',
      metadata: {
        acknowledged_via: 'override',
        acknowledge_override_source: 'cold_chain_excursion_ack',
        acknowledge_override_id: String(excursionId),
        acknowledge_override_reason: 'Acknowledged via cold-chain excursion acknowledgement',
      },
    });

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::double precision AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    expect(slaRows[0]).toMatchObject({
      status: 'completed',
      metadata: { completed_via: 'task_ack' },
    });
    expect(slaRows[0].completed_at).not.toBeNull();

    const comments = await prisma.$queryRawUnsafe(
      `SELECT body_kind, metadata
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body_kind: 'state_change',
      metadata: {
        via: 'override',
        override_source: 'cold_chain_excursion_ack',
        override_id: String(excursionId),
      },
    });
  }, 30_000);

  it('atomically repairs an in-progress task whose linked SLA remained active', async () => {
    // Migration 580 rejects an acknowledged task with an incomplete clock at
    // commit. Exercise the rolling-upgrade repair path inside one deferred-
    // constraint transaction, so the impossible intermediate state never
    // becomes externally visible.
    const task = await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = 'in_progress',
                assigned_to_uid = $3::uuid,
                assigned_to_role = 'PHARMACY_STAFF',
                metadata = metadata
                  - 'acknowledged_at'
                  - 'acknowledged_by'
                  - 'acknowledged_via'
                  - 'acknowledge_override_source'
                  - 'acknowledge_override_id'
                  - 'acknowledge_override_reason',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2`,
        TENANT_ID,
        taskId,
        ACTOR_UID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET status = 'active',
                completed_at = NULL,
                breached_at = NULL,
                metadata = metadata - 'completed_via' - 'completed_by_task' - 'acknowledged_by',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT_ID,
        SLA_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM task_comments
          WHERE tenant_id = $1::uuid AND task_id = $2`,
        TENANT_ID,
        taskId,
      );
      return acknowledgeTask({
        tenantId: TENANT_ID,
        id: taskId,
        actorUid: ACTOR_UID,
        actorRoles: ['PHARMACY_STAFF'],
        tx,
      });
    });
    expect(task.status).toBe('in_progress');

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::double precision AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    expect(slaRows[0].status).toBe('completed');
    expect(slaRows[0].completed_at).not.toBeNull();
    expect(slaRows[0].metadata).toMatchObject({ completed_via: 'task_ack' });

    const repairedTaskRows = await prisma.$queryRawUnsafe(
      `SELECT metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(repairedTaskRows[0].metadata).toMatchObject({
      acknowledged_by: ACTOR_UID,
      acknowledged_via: 'assignee',
      acknowledgement_receipt_repaired: true,
    });
    expect(new Date(repairedTaskRows[0].metadata.acknowledged_at).toString()).not.toBe('Invalid Date');
    expect(slaRows[0].completed_at_epoch_ms)
      .toBe(new Date(repairedTaskRows[0].metadata.acknowledged_at).getTime());

    const comments = await prisma.$queryRawUnsafe(
      `SELECT id, metadata
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].metadata).toMatchObject({ receipt_repaired: true });
  }, 30_000);

  it('records corrective-action acknowledgement atomically and stops a late linked clock', async () => {
    await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET status = 'active',
                due_at = NOW() - INTERVAL '1 minute',
                completed_at = NULL,
                breached_at = NULL,
                escalated_at = NULL,
                metadata = metadata
                  - 'completed_via'
                  - 'completed_by_task'
                  - 'completed_by'
                  - 'acknowledged_by',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT_ID,
        SLA_ID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = 'open',
                due_at = (
                  SELECT due_at
                    FROM workflow_sla_instances
                   WHERE tenant_id = $1::uuid AND id = $3::uuid
                ),
                assigned_to_uid = NULL,
                assigned_to_role = 'PHARMACY_STAFF',
                completed_at = NULL,
                metadata = metadata
                  - 'acknowledged_at'
                  - 'acknowledged_by'
                  - 'acknowledged_via'
                  - 'acknowledge_override_source'
                  - 'acknowledge_override_id'
                  - 'acknowledge_override_reason',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2`,
        TENANT_ID,
        taskId,
        SLA_ID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE cold_chain_excursions
            SET status = 'open',
                corrective_action = NULL,
                disposition_note = NULL,
                acknowledged_by = NULL,
                acknowledged_at = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT_ID,
        excursionId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM task_comments
          WHERE tenant_id = $1::uuid AND task_id = $2`,
        TENANT_ID,
        taskId,
      );
    });

    ctl.failAfterBody = true;
    await expect(recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: excursionId,
      correctiveAction: 'Moved stock to backup fridge',
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).rejects.toThrow(FORCED_POST_BODY_FAILURE);
    ctl.failAfterBody = false;

    const rolledBack = await prisma.$queryRawUnsafe(
      `SELECT excursion.status AS excursion_status,
              excursion.corrective_action,
              task.status AS task_status,
              sla.status AS sla_status,
              sla.completed_at AS sla_completed_at
         FROM cold_chain_excursions excursion
         JOIN tasks task
           ON task.tenant_id = excursion.tenant_id AND task.id = excursion.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = excursion.tenant_id AND sla.id = excursion.sla_instance_id
        WHERE excursion.tenant_id = $1::uuid AND excursion.id = $2::bigint`,
      TENANT_ID,
      excursionId,
    );
    expect(rolledBack[0]).toMatchObject({
      excursion_status: 'open',
      corrective_action: null,
      task_status: 'open',
      sla_status: 'active',
      sla_completed_at: null,
    });

    await expect(recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: excursionId,
      correctiveAction: 'Moved stock to backup fridge',
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).resolves.toMatchObject({
      status: 'acknowledged',
      corrective_action: 'Moved stock to backup fridge',
    });

    const committed = await prisma.$queryRawUnsafe(
      `SELECT excursion.status AS excursion_status,
              task.status AS task_status,
               task.metadata AS task_metadata,
               sla.status AS sla_status,
               sla.due_at AS sla_due_at,
               sla.breached_at AS sla_breached_at,
               sla.completed_at AS sla_completed_at,
               (EXTRACT(EPOCH FROM sla.due_at) * 1000)::double precision AS sla_due_at_epoch_ms,
               (EXTRACT(EPOCH FROM sla.breached_at) * 1000)::double precision AS sla_breached_at_epoch_ms,
               (EXTRACT(EPOCH FROM sla.completed_at) * 1000)::double precision AS sla_completed_at_epoch_ms,
               sla.metadata AS sla_metadata
         FROM cold_chain_excursions excursion
         JOIN tasks task
           ON task.tenant_id = excursion.tenant_id AND task.id = excursion.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = excursion.tenant_id AND sla.id = excursion.sla_instance_id
        WHERE excursion.tenant_id = $1::uuid AND excursion.id = $2::bigint`,
      TENANT_ID,
      excursionId,
    );
    expect(committed[0].sla_completed_at_epoch_ms)
      .toBeGreaterThan(committed[0].sla_due_at_epoch_ms);
    expect(new Date(committed[0].task_metadata.acknowledged_at).toISOString())
      .toBe(new Date(committed[0].sla_completed_at_epoch_ms).toISOString());
    expect(committed[0]).toMatchObject({
      excursion_status: 'acknowledged',
      task_status: 'in_progress',
      task_metadata: { acknowledged_via: 'role' },
      sla_status: 'breached',
      sla_metadata: { completed_via: 'task_ack' },
    });
    expect(committed[0].sla_breached_at_epoch_ms)
      .toBe(committed[0].sla_due_at_epoch_ms);
  }, 30_000);
});
