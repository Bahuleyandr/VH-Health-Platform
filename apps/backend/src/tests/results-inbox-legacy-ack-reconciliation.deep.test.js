import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { setTenantTx } = prismaModule;
const { enqueueCriticalResultTask } = await import('../services/results/resultsInboxService.js');
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');

const PATIENT_UID = randomUUID();
const ACTOR_UID = randomUUID();
const SLA_ID = randomUUID();
const RESOURCE_ID = `legacy-ack-${randomUUID()}`;
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 9);
const PATIENT_PHONE = `6${String(parseInt(SUFFIX, 16) % 1_000_000_000).padStart(9, '0')}`;
const ACTOR_PHONE = `5${String((parseInt(SUFFIX, 16) + 1) % 1_000_000_000).padStart(9, '0')}`;
const ACKNOWLEDGED_AT = '2026-07-19T00:05:00.000Z';

let taskId = null;

async function cleanup() {
  await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'lab_result'
          AND related_resource_id = $2::text`,
      DEFAULT_TENANT_ID,
      RESOURCE_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND rule_code = 'critical_result_ack'
          AND source_table = 'lab_result'
          AND source_id = $2::text`,
      DEFAULT_TENANT_ID,
      RESOURCE_ID,
    );
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)',
    PATIENT_UID,
    ACTOR_UID,
  ).catch(() => {});
}

d('legacy critical-result acknowledgement reconciliation', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Legacy acknowledgement patient', 'PATIENT', TRUE, $3::uuid, NOW()),
              ($4::uuid, $5, 'Legacy acknowledgement doctor', 'DOCTOR', TRUE, $3::uuid, NOW())`,
      PATIENT_UID,
      PATIENT_PHONE,
      DEFAULT_TENANT_ID,
      ACTOR_UID,
      ACTOR_PHONE,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('repairs an acknowledged task/incomplete SLA split with canonical task_ack evidence', async () => {
    const result = await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      const rules = await tx.$queryRawUnsafe(
        `SELECT id, target_minutes
           FROM workflow_sla_rules
          WHERE rule_code = 'critical_result_ack'
            AND enabled = TRUE
          ORDER BY (tenant_id = $1::uuid) DESC, tenant_id NULLS LAST
          LIMIT 1`,
        DEFAULT_TENANT_ID,
      );
      expect(rules[0]).toBeTruthy();
      await tx.$executeRawUnsafe(
        `INSERT INTO workflow_sla_instances
           (id, tenant_id, rule_id, rule_code, source_table, source_id, patient_uid,
             status, priority, started_at, due_at, metadata)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'critical_result_ack', 'lab_result',
                  $4::text, $5::uuid, 'active', 'critical',
                  $7::timestamptz - INTERVAL '5 minutes',
                  ($7::timestamptz - INTERVAL '5 minutes')
                    + ($6::int * INTERVAL '1 minute'),
                  jsonb_build_object('source', 'legacy_ack_reconciliation_deep'))`,
        SLA_ID,
        DEFAULT_TENANT_ID,
        rules[0].id,
        RESOURCE_ID,
        PATIENT_UID,
        Number(rules[0].target_minutes),
        ACKNOWLEDGED_AT,
      );
      const tasks = await tx.$queryRawUnsafe(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, patient_uid, related_resource_type,
            related_resource_id, priority, status, assigned_to_uid, created_by,
            due_at, workflow_sla_instance_id, sla_completion_semantics, metadata)
         VALUES ($1::uuid, 'review', 'Legacy acknowledged critical result', $2::uuid,
                 'lab_result', $3::text, 'critical', 'in_progress', $4::uuid, $4::uuid,
                 (SELECT due_at FROM workflow_sla_instances
                   WHERE tenant_id = $1::uuid AND id = $5::uuid),
                 $5::uuid, 'acknowledgement', jsonb_build_object(
                   'sla_instance_id', $5::text,
                   'sla_key', 'critical_result_ack',
                   'acknowledged_at', $6::text,
                   'acknowledged_by', $4::text,
                   'acknowledged_via', 'assignee'
                 ))
         RETURNING id`,
        DEFAULT_TENANT_ID,
        PATIENT_UID,
        RESOURCE_ID,
        ACTOR_UID,
        SLA_ID,
        ACKNOWLEDGED_AT,
      );
      taskId = tasks[0].id;

      return enqueueCriticalResultTask({
        tenantId: DEFAULT_TENANT_ID,
        patientUid: PATIENT_UID,
        source: 'lab_result',
        resourceType: 'lab_result',
        resourceId: RESOURCE_ID,
        severity: 'critical',
        orderingClinicianUid: ACTOR_UID,
        tx,
        strict: true,
      });
    });

    expect(result).toMatchObject({
      created: false,
      skipped: true,
      reason: 'task_already_acknowledged',
      taskId,
      slaInstanceId: SLA_ID,
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT task.workflow_sla_instance_id,
              task.sla_completion_semantics,
              task.due_at = sla.due_at AS exact_deadline,
              sla.status AS sla_status,
              sla.completed_at IS NOT NULL AS has_completed_at,
              sla.metadata,
              (EXTRACT(EPOCH FROM (sla.metadata->>'acknowledged_at')::timestamptz) * 1000)::bigint
                AS acknowledged_at_epoch_ms
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::bigint`,
      DEFAULT_TENANT_ID,
      taskId,
    );

    expect(rows[0]).toMatchObject({
      sla_completion_semantics: 'acknowledgement',
      exact_deadline: true,
      sla_status: 'completed',
      has_completed_at: true,
      acknowledged_at_epoch_ms: BigInt(new Date(ACKNOWLEDGED_AT).getTime()),
      metadata: {
        completed_via: 'task_ack',
        completed_by_task: Number(taskId),
        completed_by: ACTOR_UID,
        acknowledged_at: ACKNOWLEDGED_AT,
        acknowledged_by: ACTOR_UID,
        acknowledged_via: 'assignee',
      },
    });
    expect(rows[0].workflow_sla_instance_id).toBeTruthy();
  }, 30_000);
});
