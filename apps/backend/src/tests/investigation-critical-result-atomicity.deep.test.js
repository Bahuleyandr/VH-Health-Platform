import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const notificationFault = { enabled: false, hit: false };
const actualPrismaModule = await import('../lib/prisma.js');
const faultingPrisma = new Proxy(actualPrismaModule.default, {
  get(target, prop, receiver) {
    if (prop === '$queryRawUnsafe') {
      return async (sql, ...params) => {
        if (notificationFault.enabled && /INSERT\s+INTO\s+notification_outbox/i.test(String(sql))) {
          notificationFault.hit = true;
          throw new Error('forced post-commit notification outbox failure');
        }
        return target.$queryRawUnsafe(sql, ...params);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  default: faultingPrisma,
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { setTenantTx } = prismaModule;
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const { addResults } = await import('../services/investigation/investigationService.js');
const { createTask, transitionTask } = await import('../services/workflow/taskService.js');

let PATIENT_UID;
let DOCTOR_UID;
let PATIENT_PHONE;
let DOCTOR_PHONE;

let investigationId;

async function cleanup() {
  if (investigationId) {
    const immutableEvidence = await prisma.$queryRawUnsafe(
      `SELECT 1
         FROM diagnostic_result_generations
        WHERE tenant_id = $1::uuid
          AND investigation_id = $2::integer
        LIMIT 1`,
      DEFAULT_TENANT_ID,
      investigationId,
    ).catch(() => []);
    if (immutableEvidence.length > 0) {
      investigationId = null;
      return;
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE payload->>'investigation_id' = $1::text`,
      String(investigationId),
    ).catch(() => {});
    await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = 'investigations'
            AND related_resource_id = $2::text`,
        DEFAULT_TENANT_ID,
        String(investigationId),
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND source_table = 'investigations'
            AND source_id = $2::text`,
        DEFAULT_TENANT_ID,
        String(investigationId),
      );
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      'DELETE FROM investigations WHERE id = $1::int',
      investigationId,
    ).catch(() => {});
    investigationId = null;
  }
  if (PATIENT_UID && DOCTOR_UID) {
    await prisma.$executeRawUnsafe(
      'DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)',
      PATIENT_UID,
      DOCTOR_UID,
    ).catch(() => {});
  }
}

function resetIdentity() {
  PATIENT_UID = randomUUID();
  DOCTOR_UID = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 9);
  PATIENT_PHONE = `8${String(parseInt(suffix, 16) % 1_000_000_000).padStart(9, '0')}`;
  DOCTOR_PHONE = `7${String((parseInt(suffix, 16) + 1) % 1_000_000_000).padStart(9, '0')}`;
}

async function seedInvestigation() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Investigation atomicity patient', 'PATIENT', TRUE, $3::uuid, NOW()),
            ($4::uuid, $5, 'Investigation atomicity doctor', 'DOCTOR', TRUE, $3::uuid, NOW())`,
    PATIENT_UID,
    PATIENT_PHONE,
    DEFAULT_TENANT_ID,
    DOCTOR_UID,
    DOCTOR_PHONE,
  );
  const patientRows = await prisma.$queryRawUnsafe(
    'SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid',
    DEFAULT_TENANT_ID,
    PATIENT_UID,
  );
  const investigationRows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (phone, patient_id, patient_uid, test_name, test_type, status,
        requested_by, requested_at, updated_at)
     VALUES ($1, $2::int, $3::uuid, 'Serum Potassium', 'LAB', 'COLLECTED',
             $4::uuid, NOW(), NOW())
     RETURNING id`,
    PATIENT_PHONE,
    patientRows[0].id,
    PATIENT_UID,
    DOCTOR_UID,
  );
  investigationId = investigationRows[0].id;
}

d('investigation critical-result transaction atomicity', () => {
  beforeEach(async () => {
    notificationFault.enabled = false;
    notificationFault.hit = false;
    await cleanup();
    resetIdentity();
    await seedInvestigation();
  });

  afterEach(() => {
    notificationFault.enabled = false;
    notificationFault.hit = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('rolls back result, canonical evidence, notification, and rails when strict task creation fails', async () => {
    const blockingTask = await createTask({
      tenantId: DEFAULT_TENANT_ID,
      taskKind: 'review',
      title: 'Existing incompatible investigation work item',
      patientUid: PATIENT_UID,
      relatedResourceType: 'investigations',
      relatedResourceId: String(investigationId),
      assignedToUid: DOCTOR_UID,
      metadata: { source: 'investigation_atomicity_fixture' },
    });
    expect(blockingTask).toMatchObject({
      status: 'open',
      sla_completion_semantics: 'none',
      workflow_sla_instance_id: null,
    });

    await expect(addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.6', unit: 'mmol/L', flag: 'PANIC' },
          ],
        },
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
      'DOCTOR',
    )).rejects.toThrow('Active resource slot is occupied by an incompatible untyped task');

    const resultVersion = 1;
    const timelineKey = `investigations:${investigationId}:result:v${resultVersion}`;
    const auditKey = `investigations:${investigationId}:audit:result:v${resultVersion}`;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT investigation.status,
              investigation.results,
              investigation.result_summary,
              investigation.result_version,
              (SELECT COUNT(*)::int
                 FROM tasks task
                WHERE task.tenant_id = $1::uuid
                  AND task.related_resource_type = 'investigations'
                  AND task.related_resource_id = $2::text) AS task_count,
              (SELECT COUNT(*)::int
                 FROM tasks task
                WHERE task.tenant_id = $1::uuid
                  AND task.related_resource_type = 'investigations'
                  AND task.related_resource_id = $2::text
                  AND task.workflow_sla_instance_id IS NOT NULL) AS typed_task_count,
              (SELECT COUNT(*)::int
                 FROM workflow_sla_instances sla
                WHERE sla.tenant_id = $1::uuid
                  AND sla.source_table = 'investigations'
                  AND sla.source_id = $2::text) AS sla_count,
              (SELECT COUNT(*)::int
                 FROM clinical_timeline_events timeline
                WHERE timeline.idempotency_key = $3::text) AS timeline_count,
              (SELECT COUNT(*)::int
                 FROM clinical_audit_events audit
                WHERE audit.idempotency_key = $4::text) AS audit_count,
              (SELECT COUNT(*)::int
                 FROM notification_outbox outbox
                WHERE outbox.payload->>'investigation_id' = $2::text) AS notification_count
         FROM investigations investigation
        WHERE investigation.id = $5::int`,
      DEFAULT_TENANT_ID,
      String(investigationId),
      timelineKey,
      auditKey,
      investigationId,
    );
    expect(rows[0]).toEqual({
      status: 'COLLECTED',
      results: null,
      result_summary: null,
      result_version: 1,
      task_count: 1,
      typed_task_count: 0,
      sla_count: 0,
      timeline_count: 0,
      audit_count: 0,
      notification_count: 0,
    });
  }, 30_000);

  it('commits the critical result and task rails without notifying for an unsupported release source', async () => {
    notificationFault.enabled = true;

    await expect(addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.6', unit: 'mmol/L', flag: 'PANIC' },
          ],
        },
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
      'DOCTOR',
    )).resolves.toMatchObject({ status: 'COMPLETED', result_version: 1 });

    expect(notificationFault.hit).toBe(false);
    const timelineKey = `investigations:${investigationId}:result:v1`;
    const auditKey = `investigations:${investigationId}:audit:result:v1`;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT investigation.status,
              investigation.results IS NOT NULL AS has_results,
              investigation.result_version,
              (SELECT COUNT(*)::int
                 FROM tasks task
                WHERE task.tenant_id = $1::uuid
                  AND task.related_resource_type = 'investigations'
                  AND task.related_resource_id = $2::text
                  AND task.workflow_sla_instance_id IS NOT NULL) AS typed_task_count,
              (SELECT COUNT(*)::int
                 FROM workflow_sla_instances sla
                WHERE sla.tenant_id = $1::uuid
                  AND sla.source_table = 'investigations'
                  AND sla.source_id = $2::text) AS sla_count,
              (SELECT COUNT(*)::int
                 FROM clinical_timeline_events timeline
                WHERE timeline.idempotency_key = $3::text) AS timeline_count,
              (SELECT COUNT(*)::int
                 FROM clinical_audit_events audit
                WHERE audit.idempotency_key = $4::text) AS audit_count,
              (SELECT COUNT(*)::int
                 FROM notification_outbox outbox
                WHERE outbox.payload->>'investigation_id' = $2::text) AS notification_count
         FROM investigations investigation
        WHERE investigation.id = $5::int`,
      DEFAULT_TENANT_ID,
      String(investigationId),
      timelineKey,
      auditKey,
      investigationId,
    );
    expect(rows[0]).toEqual({
      status: 'COMPLETED',
      has_results: true,
      result_version: 1,
      typed_task_count: 1,
      sla_count: 1,
      timeline_count: 1,
      audit_count: 1,
      notification_count: 0,
    });
  }, 30_000);

  it('reopens a blocked prior-critical investigation when the rerun remains critical', async () => {
    await addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.6', unit: 'mmol/L', flag: 'PANIC' },
          ],
        },
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
      'DOCTOR',
    );
    const originalRows = await prisma.$queryRawUnsafe(
      `SELECT id, workflow_sla_instance_id
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'investigations'
          AND related_resource_id = $2::text
          AND status = 'open'
        ORDER BY id DESC
        LIMIT 1`,
      DEFAULT_TENANT_ID,
      String(investigationId),
    );
    expect(originalRows).toHaveLength(1);
    const original = originalRows[0];
    await transitionTask({
      tenantId: DEFAULT_TENANT_ID,
      id: original.id,
      nextStatus: 'blocked',
      actorUid: DOCTOR_UID,
    });

    await expect(addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.8', unit: 'mmol/L', flag: 'PANIC' },
          ],
        },
        re_run: true,
        re_run_reason: 'Analyzer rerun confirmed panic value',
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
      'DOCTOR',
    )).resolves.toMatchObject({ status: 'COMPLETED', result_version: 2 });

    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT id, status, metadata, workflow_sla_instance_id
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'investigations'
          AND related_resource_id = $2::text
        ORDER BY id ASC`,
      DEFAULT_TENANT_ID,
      String(investigationId),
    );
    expect(taskRows).toHaveLength(2);
    expect(taskRows[0]).toMatchObject({ id: original.id, status: 'completed' });
    expect(taskRows[1]).toMatchObject({
      status: 'open',
      workflow_sla_instance_id: original.workflow_sla_instance_id,
      metadata: {
        reopened_from_task_id: original.id,
        reopen_reason: 'investigation_result_rerun',
      },
    });

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      DEFAULT_TENANT_ID,
      original.workflow_sla_instance_id,
    );
    expect(slaRows[0]).toMatchObject({ status: 'active', completed_at: null });
    expect(slaRows[0].metadata?.reopen_history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reopen_reason: 'investigation_result_rerun',
        prior_completed_via: 'task_completion',
        prior_completed_by_task: original.id,
        prior_completed_by: DOCTOR_UID,
      }),
    ]));
  }, 30_000);

  it('does not create or rearm critical rails when a prior-critical rerun is currently normal', async () => {
    await addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.6', unit: 'mmol/L', flag: 'PANIC' },
          ],
        },
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
      'DOCTOR',
    );
    const beforeRows = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.updated_at AS task_updated_at,
              task.workflow_sla_instance_id,
              sla.status AS sla_status, sla.started_at, sla.due_at,
              sla.completed_at, sla.metadata AS sla_metadata
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.related_resource_type = 'investigations'
          AND task.related_resource_id = $2::text
        ORDER BY task.id`,
      DEFAULT_TENANT_ID,
      String(investigationId),
    );
    expect(beforeRows).toHaveLength(1);

    await expect(addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '4.2', unit: 'mmol/L', flag: 'N' },
          ],
        },
        re_run: true,
        re_run_reason: 'Analyzer calibration correction',
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
      'DOCTOR',
    )).resolves.toMatchObject({ status: 'COMPLETED', result_version: 2 });

    const afterRows = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.updated_at AS task_updated_at,
              task.workflow_sla_instance_id,
              sla.status AS sla_status, sla.started_at, sla.due_at,
              sla.completed_at, sla.metadata AS sla_metadata
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.related_resource_type = 'investigations'
          AND task.related_resource_id = $2::text
        ORDER BY task.id`,
      DEFAULT_TENANT_ID,
      String(investigationId),
    );
    expect(afterRows).toEqual(beforeRows);

    const investigationRows = await prisma.$queryRawUnsafe(
      `SELECT result_version, results,
              (SELECT COUNT(*)::int
                 FROM clinical_timeline_events AS timeline
                WHERE timeline.idempotency_key = $1::text) AS ready_timeline_count,
              (SELECT COUNT(*)::int
                 FROM clinical_audit_events AS audit
                WHERE audit.idempotency_key = $2::text) AS ready_audit_count
         FROM investigations
        WHERE id = $3::int`,
      `investigations:${investigationId}:result:v2`,
      `investigations:${investigationId}:audit:result:v2`,
      investigationId,
    );
    expect(investigationRows[0]).toMatchObject({
      result_version: 2,
      results: {
        analytes: [
          { name: 'Potassium', value: '4.2', unit: 'mmol/L', flag: 'N' },
        ],
      },
      ready_timeline_count: 1,
      ready_audit_count: 1,
    });
  }, 30_000);
});
