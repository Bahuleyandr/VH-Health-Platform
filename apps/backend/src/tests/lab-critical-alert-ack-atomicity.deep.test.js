import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const FORCED_FAILURE = 'forced critical-lab canonical audit failure';
const ctl = { failPattern: null, faultHit: false };

const actualPrismaModule = await import('../lib/prisma.js');
const actualHumanOwnerModule = await import('../services/workflow/workflowHumanOwnerService.js');
const proxiedTransactions = new WeakMap();

function acknowledgementFaultProxy(tx) {
  const proxy = new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          if (ctl.failPattern?.test(String(sql))) {
            ctl.faultHit = true;
            throw new Error(FORCED_FAILURE);
          }
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  proxiedTransactions.set(proxy, tx);
  return proxy;
}

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx: (tenantId, fn, options) => actualPrismaModule.setTenantTx(
    tenantId,
    (tx) => fn(acknowledgementFaultProxy(tx)),
    options,
  ),
}));
jest.unstable_mockModule('../services/workflow/workflowHumanOwnerService.js', () => ({
  ...actualHumanOwnerModule,
  resolveCurrentHumanActorTx: (input = {}) => actualHumanOwnerModule.resolveCurrentHumanActorTx({
    ...input,
    tx: proxiedTransactions.get(input.tx) || input.tx,
  }),
}));

const prisma = (await import('../lib/prisma.js')).default;
const {
  acknowledgeAlert,
  acknowledgeCriticalAlertForInboxTask,
} = await import('../services/lab/labResultsService.js');
const { materializeLabCriticalAlertGeneration } = await import('../services/lab/labCriticalAlertService.js');
const { default: clinicalInboxRoutes } = await import('../routes/clinicalInboxRoutes.js');
const { default: labRoutes } = await import('../routes/lab/labRoutes.js');
const { default: tasksWorkflowRoutes } = await import('../routes/admin/tasksWorkflowRoutes.js');
const { errorHandlerMiddleware } = await import('../middleware/errorHandlerMiddleware.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const ASSIGNEE_UID = randomUUID();
const UNAUTHORIZED_UID = randomUUID();
const SLA_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const TENANT_SLUG = `lab-alert-ack-atomic-${SUFFIX}`;
const PATIENT_PHONE = `5${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const ASSIGNEE_PHONE = `6${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let resultId;
let alertId;
let taskId;
let inboxActor;
let finishedPhiContext;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'lab-critical-inbox-deep';
  req.tenantId = TENANT_ID;
  req.user = inboxActor;
  next();
});
app.use((req, res, next) => {
  res.on('finish', () => { finishedPhiContext = req.phiContext || null; });
  next();
});
app.use('/api/v1/clinical-inbox', clinicalInboxRoutes);
app.use(errorHandlerMiddleware);

const labApp = express();
labApp.use(express.json());
labApp.use((req, _res, next) => {
  req.id = 'lab-critical-direct-deep';
  req.tenantId = TENANT_ID;
  req.user = inboxActor;
  next();
});
labApp.use('/api/v1/lab', labRoutes);
labApp.use(errorHandlerMiddleware);

const adminApp = express();
adminApp.use(express.json());
adminApp.use((req, _res, next) => {
  req.id = 'lab-critical-admin-deep';
  req.tenantId = TENANT_ID;
  req.user = { ...inboxActor, role: 'ADMIN', roles: ['ADMIN'], rawRole: 'ADMIN' };
  next();
});
adminApp.use('/api/v1/admin/workflow', tasksWorkflowRoutes);
adminApp.use(errorHandlerMiddleware);

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    // Migration 581 intentionally makes alert-generation evidence immutable.
    // Test teardown runs only on the disposable deep-test database and disables
    // user/constraint triggers on this one transaction so each case starts from
    // a genuinely empty fixture without weakening production cleanup paths.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_acknowledgement_receipts WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alerts WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
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
      `DELETE FROM lab_pathologist_signoffs WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    );
  }).catch(() => {});
}

async function seedAcknowledgement() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, 'Critical lab acknowledgement atomicity tenant')`,
    TENANT_ID,
    TENANT_SLUG,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Critical lab test patient', 'PATIENT', TRUE, $4::uuid, NOW()),
            ($3::uuid, $5, 'Critical lab assignee', 'DOCTOR', TRUE, $4::uuid, NOW())`,
    PATIENT_UID,
    PATIENT_PHONE,
    ASSIGNEE_UID,
    TENANT_ID,
    ASSIGNEE_PHONE,
  );
  const results = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text,
        value_numeric, unit, status, is_critical)
     VALUES ($1::uuid, $2::uuid, 'K', 'Potassium', '7.1', 7.1,
             'mmol/L', 'final', TRUE)
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
  );
  resultId = results[0].id;
  const alerts = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_critical_alerts
       (tenant_id, result_id, patient_uid, test_name, value_text,
        value_numeric, unit, threshold_breached, threshold_value)
     VALUES ($1::uuid, $2::int, $3::uuid, 'Potassium', '7.1', 7.1,
             'mmol/L', 'high', 6.2)
     RETURNING id`,
    TENANT_ID,
    resultId,
    PATIENT_UID,
  );
  alertId = alerts[0].id;
  const tasks = await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_id, rule_code, patient_uid, source_table, source_id,
          status, priority, started_at, due_at, assigned_user_uid, metadata)
       SELECT $1::uuid, $2::uuid, rule.id, 'critical_result_ack', $3::uuid,
              'lab_result', $4::text, 'active', 'critical', NOW(),
              NOW() + INTERVAL '15 minutes', $5::uuid,
              '{"test":"lab_critical_alert_ack_atomicity",\
                "task_materialization_contract":"application_atomic_v1"}'::jsonb
         FROM workflow_sla_rules AS rule
        WHERE rule.rule_code = 'critical_result_ack'
          AND rule.enabled = TRUE
          AND (rule.tenant_id = $2::uuid OR rule.tenant_id IS NULL)
        ORDER BY rule.tenant_id NULLS LAST
        LIMIT 1`,
      SLA_ID,
      TENANT_ID,
      PATIENT_UID,
      String(resultId),
      ASSIGNEE_UID,
    );
    const taskRows = await tx.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, description, patient_uid,
          related_resource_type, related_resource_id, priority, status,
          assigned_to_uid, created_by, due_at, workflow_sla_instance_id,
          sla_completion_semantics, metadata)
       SELECT $1::uuid, 'review', 'Acknowledge critical potassium',
              'Critical lab acknowledgement atomicity fixture', $2::uuid,
              'lab_result', $3::text, 'critical', 'open', $4::uuid, $4::uuid,
              sla.due_at, sla.id, 'acknowledgement',
              jsonb_build_object(
                'sla_key', 'critical_result_ack',
                'test', 'lab_critical_alert_ack_atomicity'
              )
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $5::uuid
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      String(resultId),
      ASSIGNEE_UID,
      SLA_ID,
    );
    await tx.$executeRawUnsafe(
      `UPDATE tasks
          SET metadata = metadata || jsonb_build_object(
                'lab_critical_alert_id', $3::int,
                'lab_alert_generation_state', 'critical'
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT_ID,
      taskRows[0].id,
      alertId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE lab_critical_alerts
          SET acknowledgement_task_id = $3::int,
              generation_metadata = jsonb_build_object(
                'kind', 'initial_result_generation',
                'source', 'lab_critical_alert_ack_atomicity_fixture',
                'acknowledgement_task_id', $3::int,
                'corrected_state', 'critical'
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT_ID,
      alertId,
      taskRows[0].id,
    );
    return taskRows;
  });
  taskId = tasks[0].id;
}

async function seedLegacySplit({ includeReceiptComment = true } = {}) {
  const acknowledgedAt = new Date().toISOString();
  await prisma.$transaction(async (tx) => {
    // Simulate the exact pre-fix state that a rolling replica could have
    // committed before the cross-table invariant existed. Production code has
    // no bypass; this is confined to the disposable deep-test database.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `UPDATE tasks
          SET status = 'in_progress',
              metadata = metadata || jsonb_build_object(
                'acknowledged_at', $3::text,
                'acknowledged_by', $4::text,
                'acknowledged_via', 'assignee'
              ),
              updated_at = $3::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT_ID,
      taskId,
      acknowledgedAt,
      ASSIGNEE_UID,
    );
    await tx.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'completed',
              completed_at = $3::timestamptz,
              metadata = metadata || jsonb_build_object(
                'completed_via', 'task_ack',
                'completed_by_task', $4::int,
                'completed_by', $5::text
              ),
              updated_at = $3::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
      acknowledgedAt,
      taskId,
      ASSIGNEE_UID,
    );
    if (includeReceiptComment) {
      await tx.$executeRawUnsafe(
        `INSERT INTO task_comments
           (tenant_id, task_id, author_uid, body, body_kind, metadata)
         VALUES ($1::uuid, $2::int, $3::uuid,
                 'Task acknowledged (open to in_progress) via assignee',
                 'state_change',
                 jsonb_build_object(
                   'from', 'open',
                   'to', 'in_progress',
                   'acknowledged_at', $4::text,
                   'via', 'assignee'
                 ))`,
        TENANT_ID,
        taskId,
        ASSIGNEE_UID,
        acknowledgedAt,
      );
    }
  });
  return acknowledgedAt;
}

async function seedLegacyAlertOnlyAcknowledgement() {
  const acknowledgedAt = new Date().toISOString();
  await prisma.$transaction(async (tx) => {
    // Reproduce a retained pre-581 row after the migration guards exist. This
    // bypass is confined to the disposable test database; production runtime
    // has no automatic bridge for this historically under-authorized receipt.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `UPDATE lab_critical_alerts
          SET acknowledged_at = $3::timestamptz,
              acknowledged_by = $4::uuid,
              acknowledged_by_name = 'Critical lab assignee',
              acknowledgement_task_id = NULL,
              generation_metadata = '{}'::jsonb
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT_ID,
      alertId,
      acknowledgedAt,
      ASSIGNEE_UID,
    );
    await tx.$executeRawUnsafe(
      `UPDATE tasks
          SET status = 'open',
              metadata = metadata
                - 'lab_critical_alert_id'
                - 'lab_alert_generation_state'
                - 'lab_alert_generation_signoff_id'
                - 'ack_contract_version',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT_ID,
      taskId,
    );
  });
  return acknowledgedAt;
}

async function readState() {
  const [alerts, tasks, slas, comments, timeline, audit, receipts] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT acknowledged_at, acknowledged_by, read_back_method,
              (EXTRACT(EPOCH FROM acknowledged_at) * 1000)::bigint
                AS acknowledged_at_epoch_ms
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      alertId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT status, metadata,
              CASE
                WHEN pg_input_is_valid(metadata->>'acknowledged_at', 'timestamp with time zone')
                  THEN (EXTRACT(EPOCH FROM (metadata->>'acknowledged_at')::timestamptz) * 1000)::bigint
                ELSE NULL
              END AS acknowledged_at_epoch_ms
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint
                AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, metadata
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id,
              (EXTRACT(EPOCH FROM occurred_at) * 1000)::bigint
                AS occurred_at_epoch_ms,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
                AS created_at_epoch_ms,
              payload
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'lab_critical_alerts'
          AND source_id = $2::text`,
      TENANT_ID,
      String(alertId),
    ),
    prisma.$queryRawUnsafe(
      `SELECT id,
              (EXTRACT(EPOCH FROM occurred_at) * 1000)::bigint
                AS occurred_at_epoch_ms,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
                AS created_at_epoch_ms,
              action_status,
              metadata,
              after_state
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND resource_table = 'lab_critical_alerts'
          AND resource_id = $2::text`,
      TENANT_ID,
      String(alertId),
    ),
    prisma.$queryRawUnsafe(
      `SELECT acknowledgement_task_id, workflow_sla_instance_id,
              task_comment_id, timeline_event_id, audit_event_id,
              acknowledged_at, acknowledged_by,
              acknowledgement_authorization, read_back_method,
              ack_contract_version,
              (EXTRACT(EPOCH FROM acknowledged_at) * 1000)::bigint
                AS acknowledged_at_epoch_ms,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
                AS created_at_epoch_ms
         FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid
          AND alert_id = $2::int`,
      TENANT_ID,
      alertId,
    ),
  ]);
  return {
    alert: alerts[0],
    task: tasks[0],
    sla: slas[0],
    commentCount: comments.length,
    timelineCount: timeline.length,
    auditCount: audit.length,
    receiptCount: receipts.length,
    comment: comments[0] || null,
    timeline: timeline[0] || null,
    audit: audit[0] || null,
    receipt: receipts[0] || null,
  };
}

function expectOpenState(state) {
  expect(state.alert.acknowledged_at).toBeNull();
  expect(state.alert.acknowledged_by).toBeNull();
  expect(state.task.status).toBe('open');
  expect(state.task.metadata).not.toHaveProperty('acknowledged_at');
  expect(state.task.metadata).not.toHaveProperty('acknowledged_by');
  expect(state.task.metadata).not.toHaveProperty('acknowledged_via');
  expect(state.sla.status).toBe('active');
  expect(state.sla.completed_at).toBeNull();
  expect(state.sla.metadata).not.toHaveProperty('completed_via');
  expect(state.commentCount).toBe(0);
  expect(state.timelineCount).toBe(0);
  expect(state.auditCount).toBe(0);
  expect(state.receiptCount).toBe(0);
}

d('critical-lab alert acknowledgement authorization and atomicity', () => {
  beforeEach(async () => {
    ctl.failPattern = null;
    ctl.faultHit = false;
    inboxActor = {
      uid: ASSIGNEE_UID,
      name: 'Critical lab assignee',
      role: 'DOCTOR',
      roles: ['DOCTOR'],
    };
    finishedPhiContext = null;
    await cleanup();
    await seedAcknowledgement();
  }, 60_000);

  afterEach(() => {
    ctl.failPattern = null;
    ctl.faultHit = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('denies a non-assignee/non-role caller without stopping the task or SLA clock', async () => {
    inboxActor = {
      uid: UNAUTHORIZED_UID,
      name: 'Unauthorized caller',
      role: 'NURSE',
      roles: ['NURSE'],
    };
    const response = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({ alert_id: alertId, result_id: resultId, override_reason: 'caller text' });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/potassium|patient|critical alert/i);
    expect(finishedPhiContext).toBeNull();

    expectOpenState(await readState());
  }, 30_000);

  it('blocks an ADMIN generic task acknowledgement before any split write', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET role = 'ADMIN', updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      TENANT_ID,
      ASSIGNEE_UID,
    );
    const response = await request(adminApp)
      .post(`/api/v1/admin/workflow/tasks/${taskId}/acknowledge`)
      .send({});
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      success: false,
      code: 'LAB_CRITICAL_ALERT_ACK_REQUIRED',
    });

    expectOpenState(await readState());
  }, 30_000);

  it('fails closed on a pre-581 alert-only acknowledgement without mutating its open task or active SLA', async () => {
    const legacyAcknowledgedAt = await seedLegacyAlertOnlyAcknowledgement();

    const direct = await request(labApp)
      .post(`/api/v1/lab/alerts/critical/${alertId}/ack`)
      .send({});
    expect(direct.statusCode).toBe(409);
    expect(direct.body).toMatchObject({
      success: false,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
      message: 'Critical alert acknowledgement requires reconciliation',
    });
    expect(JSON.stringify(direct.body)).not.toMatch(/potassium|patient/i);

    const afterDirect = await readState();
    expect(afterDirect.alert.acknowledged_at_epoch_ms)
      .toBe(BigInt(Date.parse(legacyAcknowledgedAt)));
    expect(afterDirect.task.status).toBe('open');
    expect(afterDirect.task.metadata).not.toHaveProperty('acknowledged_at');
    expect(afterDirect.sla.status).toBe('active');
    expect(afterDirect.sla.completed_at).toBeNull();
    expect(afterDirect.commentCount).toBe(0);
    expect(afterDirect.timelineCount).toBe(0);
    expect(afterDirect.auditCount).toBe(0);

    const inboxProbe = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(inboxProbe.statusCode).toBe(403);
    expect(inboxProbe.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });
    expect(await readState()).toEqual(afterDirect);
  }, 30_000);

  it('acknowledges a blocked current alert task atomically while preserving authorization and replay', async () => {
    await actualPrismaModule.setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET status = 'blocked', updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT_ID,
      taskId,
    ));

    inboxActor = {
      uid: UNAUTHORIZED_UID,
      name: 'Unauthorized caller',
      role: 'NURSE',
      roles: ['NURSE'],
    };
    const denied = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });

    const deniedState = await readState();
    expect(deniedState.alert.acknowledged_at).toBeNull();
    expect(deniedState.task.status).toBe('blocked');
    expect(deniedState.task.metadata).not.toHaveProperty('acknowledged_at');
    expect(deniedState.sla.status).toBe('active');
    expect(deniedState.sla.completed_at).toBeNull();
    expect(deniedState.commentCount).toBe(0);
    expect(deniedState.timelineCount).toBe(0);
    expect(deniedState.auditCount).toBe(0);

    inboxActor = {
      uid: ASSIGNEE_UID,
      name: 'Critical lab assignee',
      role: 'DOCTOR',
      roles: ['DOCTOR'],
    };
    const acknowledged = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.body).toMatchObject({
      success: true,
      message: 'Task acknowledged',
      data: { id: taskId, status: 'in_progress' },
    });

    const state = await readState();
    expect(state.task.status).toBe('in_progress');
    expect(state.sla.status).toBe('completed');
    expect(state.alert.acknowledged_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.sla.completed_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.timeline.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.audit.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.task.metadata.ack_contract_version).toBe(2);
    expect(state.sla.metadata.ack_contract_version).toBe(2);
    expect(state.comment.metadata.ack_contract_version).toBe(2);
    expect(state.timeline.payload.ack_contract_version).toBe(2);
    expect(state.audit.metadata.ack_contract_version).toBe(2);
    expect(state.audit.action_status).toBe('success');
    expect(state.audit.after_state).toMatchObject({
      ack_contract_version: 2,
      acknowledged_at: state.task.metadata.acknowledged_at,
      acknowledged_by: ASSIGNEE_UID,
      read_back_method: null,
    });
    expect(state.commentCount).toBe(1);
    expect(state.timelineCount).toBe(1);
    expect(state.auditCount).toBe(1);
    expect(state.receiptCount).toBe(1);
    expect(state.receipt).toMatchObject({
      acknowledgement_task_id: taskId,
      workflow_sla_instance_id: SLA_ID,
      task_comment_id: state.comment.id,
      timeline_event_id: state.timeline.id,
      audit_event_id: state.audit.id,
      acknowledged_by: ASSIGNEE_UID,
      acknowledgement_authorization: 'assignee',
      read_back_method: null,
      ack_contract_version: 2,
      acknowledged_at_epoch_ms: state.task.acknowledged_at_epoch_ms,
    });

    const acknowledgedAt = state.task.metadata.acknowledged_at;
    const timelineCreatedAt = state.timeline.created_at_epoch_ms;
    const auditCreatedAt = state.audit.created_at_epoch_ms;
    const receiptCreatedAt = state.receipt.created_at_epoch_ms;
    const replay = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(replay.statusCode).toBe(200);
    const replayState = await readState();
    expect(replayState.task.metadata.acknowledged_at).toBe(acknowledgedAt);
    expect(replayState.commentCount).toBe(1);
    expect(replayState.timelineCount).toBe(1);
    expect(replayState.auditCount).toBe(1);
    expect(replayState.receiptCount).toBe(1);
    expect(replayState.timeline.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(replayState.audit.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(replayState.timeline.created_at_epoch_ms).toBe(timelineCreatedAt);
    expect(replayState.audit.created_at_epoch_ms).toBe(auditCreatedAt);
    expect(replayState.receipt.created_at_epoch_ms).toBe(receiptCreatedAt);
  }, 30_000);

  it('acknowledges and concurrently replays the inbox task through one exact alert transition', async () => {
    const responses = await Promise.all([1, 2].map(() => request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({
        // Hostile body identifiers must never redirect the server-resolved
        // task -> current alert generation binding.
        alert_id: alertId + 9999,
        result_id: resultId + 9999,
      })));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        message: 'Task acknowledged',
        data: { id: taskId, status: 'in_progress' },
      });
    }

    const state = await readState();
    expect(state.task.status).toBe('in_progress');
    expect(state.sla.status).toBe('completed');
    expect(state.alert.acknowledged_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.sla.completed_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.timeline.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.audit.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(state.commentCount).toBe(1);
    expect(state.timelineCount).toBe(1);
    expect(state.auditCount).toBe(1);
    expect(state.receiptCount).toBe(1);
    expect(state.alert.read_back_method).toBeNull();
    expect(state.task.metadata.ack_contract_version).toBe(2);
    expect(state.sla.metadata.ack_contract_version).toBe(2);
    expect(state.comment.metadata.ack_contract_version).toBe(2);
    expect(state.timeline.payload).toMatchObject({
      ack_contract_version: 2,
      read_back_method: null,
    });
    expect(state.audit.metadata.ack_contract_version).toBe(2);
    expect(state.audit.action_status).toBe('success');
    expect(state.audit.after_state).toMatchObject({
      ack_contract_version: 2,
      acknowledged_at: state.task.metadata.acknowledged_at,
      acknowledged_by: ASSIGNEE_UID,
      read_back_method: null,
    });

    const acknowledgedAt = state.task.metadata.acknowledged_at;
    const timelineCreatedAt = state.timeline.created_at_epoch_ms;
    const auditCreatedAt = state.audit.created_at_epoch_ms;
    const receiptCreatedAt = state.receipt.created_at_epoch_ms;
    const replay = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(replay.statusCode).toBe(200);
    const replayState = await readState();
    expect(replayState.task.metadata.acknowledged_at).toBe(acknowledgedAt);
    expect(replayState.commentCount).toBe(1);
    expect(replayState.timelineCount).toBe(1);
    expect(replayState.auditCount).toBe(1);
    expect(replayState.receiptCount).toBe(1);
    expect(replayState.timeline.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(replayState.audit.occurred_at_epoch_ms)
      .toBe(state.task.acknowledged_at_epoch_ms);
    expect(replayState.timeline.created_at_epoch_ms).toBe(timelineCreatedAt);
    expect(replayState.audit.created_at_epoch_ms).toBe(auditCreatedAt);
    expect(replayState.receipt.created_at_epoch_ms).toBe(receiptCreatedAt);

    const directReplay = await request(labApp)
      .post(`/api/v1/lab/alerts/critical/${alertId}/ack`)
      .send({});
    expect(directReplay.statusCode).toBe(200);
    expect(directReplay.body).toMatchObject({
      success: true,
      data: { id: alertId },
    });
    expect(await readState()).toEqual(replayState);
  }, 30_000);

  it.each([41, 160])(
    'preserves an exact %i-character read-back method across alert, receipt, and canonical evidence',
    async (length) => {
      const readBackMethod = 'r'.repeat(length);
      const acknowledged = await request(labApp)
        .post(`/api/v1/lab/alerts/critical/${alertId}/ack`)
        .send({ read_back_method: readBackMethod });
      expect(acknowledged.statusCode).toBe(200);
      expect(acknowledged.body.data.read_back_method).toBe(readBackMethod);

      const state = await readState();
      expect(state.alert.read_back_method).toBe(readBackMethod);
      expect(state.receipt.read_back_method).toBe(readBackMethod);
      expect(state.timeline.payload.read_back_method).toBe(readBackMethod);
      expect(state.audit.after_state.read_back_method).toBe(readBackMethod);
      expect(state.receiptCount).toBe(1);
      expect(state.commentCount).toBe(1);
      expect(state.timelineCount).toBe(1);
      expect(state.auditCount).toBe(1);
    },
    30_000,
  );

  it('rejects a 161-character read-back method at the existing database boundary and rolls back', async () => {
    const readBackMethod = 'r'.repeat(161);
    let rejection;
    try {
      await acknowledgeAlert(alertId, {
        tenantId: TENANT_ID,
        acknowledged_by: ASSIGNEE_UID,
        acknowledged_by_name: 'Critical lab assignee',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
        read_back_method: readBackMethod,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection?.name).toBe('PrismaClientKnownRequestError');
    expect(rejection?.code).toBe('P2010');
    expect(rejection?.meta?.driverAdapterError?.cause?.kind).toBe('LengthMismatch');
    expect(rejection?.meta?.driverAdapterError?.cause?.originalCode).toBe('22001');
    expect(rejection?.meta?.driverAdapterError?.cause?.originalMessage).toMatch(/character varying\(160\)/);
    expectOpenState(await readState());
  }, 30_000);

  it('fails closed without writes when a versioned closed contract marker is mismatched', async () => {
    const acknowledged = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(acknowledged.statusCode).toBe(200);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET metadata = jsonb_set(metadata, '{ack_contract_version}', '1'::jsonb)
          WHERE tenant_id = $1::uuid
            AND id = $2::int`,
        TENANT_ID,
        taskId,
      );
    });
    const corrupted = await readState();
    expect(corrupted.task.metadata.ack_contract_version).toBe(1);

    const direct = await request(labApp)
      .post(`/api/v1/lab/alerts/critical/${alertId}/ack`)
      .send({});
    expect(direct.statusCode).toBe(409);
    expect(direct.body).toMatchObject({
      success: false,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    const inboxProbe = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(inboxProbe.statusCode).toBe(403);
    expect(inboxProbe.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });
    expect(await readState()).toEqual(corrupted);
  }, 30_000);

  it('does not auto-upgrade an unversioned legacy task/SLA/comment receipt', async () => {
    const legacyAcknowledgedAt = await seedLegacySplit();

    await expect(acknowledgeAlert(alertId, {
      tenantId: TENANT_ID,
      acknowledged_by: ASSIGNEE_UID,
      acknowledged_by_name: 'Critical lab assignee',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    await expect(acknowledgeCriticalAlertForInboxTask(taskId, {
      tenantId: TENANT_ID,
      actorUid: ASSIGNEE_UID,
      actorName: 'Critical lab assignee',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    const state = await readState();
    expect(state.alert.acknowledged_at).toBeNull();
    expect(state.task.metadata.acknowledged_at).toBe(legacyAcknowledgedAt);
    expect(state.commentCount).toBe(1);
    expect(state.timelineCount).toBe(0);
    expect(state.auditCount).toBe(0);
    expect(state.receiptCount).toBe(0);
  }, 30_000);

  it('refuses to rearm a receipt-less legacy closure and commits no generation writes', async () => {
    await seedLegacySplit();
    const signoffs = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_pathologist_signoffs
         (tenant_id, patient_uid, result_ids, signed_off_by, decision, comments)
       VALUES ($1::uuid, $2::uuid, ARRAY[$3::int], $4::uuid, 'amended',
               'receipt-less predecessor must reconcile before rearm')
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      resultId,
      ASSIGNEE_UID,
    );
    const generationCounts = () => prisma.$queryRawUnsafe(
      `SELECT
          (SELECT COUNT(*)::int
             FROM lab_critical_alerts
            WHERE tenant_id = $1::uuid
              AND result_id = $2::int) AS alert_count,
          (SELECT COUNT(*)::int
             FROM tasks
            WHERE tenant_id = $1::uuid
              AND related_resource_type = 'lab_result'
              AND related_resource_id = $2::text) AS task_count,
          (SELECT COUNT(*)::int
             FROM workflow_sla_instances
            WHERE tenant_id = $1::uuid
              AND source_table = 'lab_result'
              AND source_id = $2::text) AS sla_count,
          (SELECT COUNT(*)::int
             FROM lab_critical_alert_acknowledgement_receipts
            WHERE tenant_id = $1::uuid
              AND result_id = $2::int) AS receipt_count`,
      TENANT_ID,
      resultId,
    );
    const beforeState = await readState();
    const beforeCounts = await generationCounts();

    await expect(materializeLabCriticalAlertGeneration({
      tenantId: TENANT_ID,
      resultId,
      expectedPatientUid: PATIENT_UID,
      orderingClinicianUid: ASSIGNEE_UID,
      generationSignoffId: signoffs[0].id,
      generationDecision: 'amended',
      generationActorUid: ASSIGNEE_UID,
      source: 'receipt_less_legacy_rearm_regression',
      criticality: {
        breached: true,
        matched: true,
        breachedSide: 'high',
        breachedValue: 6.2,
        evaluatedValue: 7.1,
        criticalLow: null,
        criticalHigh: 6.2,
      },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    expect(await readState()).toEqual(beforeState);
    expect(await generationCounts()).toEqual(beforeCounts);
    expect(beforeCounts).toEqual([{
      alert_count: 1,
      task_count: 1,
      sla_count: 1,
      receipt_count: 0,
    }]);
  }, 45_000);

  it('rejects a forged legacy split when the exact acknowledgement comment is absent', async () => {
    await seedLegacySplit({ includeReceiptComment: false });

    await expect(acknowledgeCriticalAlertForInboxTask(taskId, {
      tenantId: TENANT_ID,
      actorUid: ASSIGNEE_UID,
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to acknowledge this critical alert',
    });

    const state = await readState();
    expect(state.alert.acknowledged_at).toBeNull();
    expect(state.task.status).toBe('in_progress');
    expect(state.sla.status).toBe('completed');
    expect(state.commentCount).toBe(0);
    expect(state.timelineCount).toBe(0);
    expect(state.auditCount).toBe(0);
  }, 30_000);

  it('rolls back alert, task, SLA, comment, and partial canonical evidence, then retries cleanly', async () => {
    ctl.failPattern = /INSERT\s+INTO\s+clinical_audit_events/i;

    const failed = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({ read_back_method: 'phone', notes: 'Read back to the ordering clinician' });
    expect(failed.statusCode).toBe(500);

    expect(ctl.faultHit).toBe(true);
    expectOpenState(await readState());

    ctl.failPattern = null;
    ctl.faultHit = false;
    const acknowledged = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({ read_back_method: 'phone', notes: 'Read back to the ordering clinician' });
    expect(acknowledged.statusCode).toBe(200);

    const state = await readState();
    expect(state.alert.acknowledged_at).toBeTruthy();
    expect(state.alert.acknowledged_by).toBe(ASSIGNEE_UID);
    expect(state.alert.read_back_method).toBe('phone');
    expect(state.task.status).toBe('in_progress');
    expect(state.task.metadata).toMatchObject({
      acknowledged_by: ASSIGNEE_UID,
      acknowledged_via: 'assignee',
    });
    expect(state.sla.status).toBe('completed');
    expect(state.sla.completed_at).toBeTruthy();
    expect(state.sla.metadata.completed_via).toBe('task_ack');
    expect(state.commentCount).toBe(1);
    expect(state.timelineCount).toBe(1);
    expect(state.auditCount).toBe(1);
    expect(state.receiptCount).toBe(1);

    await expect(acknowledgeAlert(alertId, {
      tenantId: TENANT_ID,
      acknowledged_by: UNAUTHORIZED_UID,
      actorRoles: ['NURSE'],
      actorRole: 'NURSE',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN',
    });
    const replayState = await readState();
    expect(replayState.commentCount).toBe(1);
    expect(replayState.timelineCount).toBe(1);
    expect(replayState.auditCount).toBe(1);
    expect(replayState.receiptCount).toBe(1);
  }, 30_000);

  it('selects only the current corrected alert generation for an inbox task', async () => {
    const initialAck = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});
    expect(initialAck.statusCode).toBe(200);
    const originalAlertId = alertId;
    const originalTaskId = taskId;

    const signoffs = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_pathologist_signoffs
         (tenant_id, patient_uid, result_ids, signed_off_by, decision, comments)
       VALUES ($1::uuid, $2::uuid, ARRAY[$3::int], $4::uuid, 'amended',
               'corrected generation inbox binding test')
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      resultId,
      ASSIGNEE_UID,
    );
    const corrected = await materializeLabCriticalAlertGeneration({
      tenantId: TENANT_ID,
      resultId,
      expectedPatientUid: PATIENT_UID,
      orderingClinicianUid: ASSIGNEE_UID,
      generationSignoffId: signoffs[0].id,
      generationDecision: 'amended',
      generationActorUid: ASSIGNEE_UID,
      source: 'lab_critical_inbox_corrected_generation_test',
      criticality: {
        breached: true,
        matched: true,
        breachedSide: 'high',
        breachedValue: 6.2,
        evaluatedValue: 7.1,
        criticalLow: null,
        criticalHigh: 6.2,
      },
    });
    expect(corrected).toMatchObject({ created: true, state: 'critical' });
    expect(corrected.alert.id).not.toBe(originalAlertId);
    expect(corrected.task.taskId).not.toBe(originalTaskId);

    const stale = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${originalTaskId}/acknowledge`)
      .send({});
    expect(stale.statusCode).toBe(403);
    expect(stale.body.message).toBe('Not authorized to acknowledge this task');

    const current = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${corrected.task.taskId}/acknowledge`)
      .send({ alert_id: originalAlertId, result_id: resultId });
    expect(current.statusCode).toBe(200);
    expect(current.body.data.id).toBe(corrected.task.taskId);

    const generations = await prisma.$queryRawUnsafe(
      `SELECT id, acknowledged_at, superseded_at, acknowledgement_task_id
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid
          AND result_id = $2::int
        ORDER BY id`,
      TENANT_ID,
      resultId,
    );
    expect(generations).toHaveLength(2);
    expect(generations[0]).toMatchObject({
      id: originalAlertId,
      acknowledgement_task_id: originalTaskId,
    });
    expect(generations[0].superseded_at).toBeTruthy();
    expect(generations[1]).toMatchObject({
      id: corrected.alert.id,
      acknowledgement_task_id: corrected.task.taskId,
    });
    expect(generations[1].acknowledged_at).toBeTruthy();
  }, 45_000);

  it('never lets a delayed replay of the old alert acknowledge the corrected-result replacement window', async () => {
    const original = await acknowledgeAlert(alertId, {
      tenantId: TENANT_ID,
      acknowledged_by: ASSIGNEE_UID,
      acknowledged_by_name: 'Critical lab assignee',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
      read_back_method: 'phone',
    });
    expect(original.acknowledged_at).toBeTruthy();

    const predecessorReceipts = await prisma.$queryRawUnsafe(
      `SELECT receipt.ack_contract_version,
              assert_lab_critical_alert_acknowledgement_receipt(
                receipt.tenant_id,
                receipt.alert_id,
                FALSE
              ) AS receipt_valid
         FROM lab_critical_alert_acknowledgement_receipts AS receipt
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.alert_id = $2::int`,
      TENANT_ID,
      alertId,
    );
    expect(predecessorReceipts).toEqual([{
      ack_contract_version: 2,
      receipt_valid: true,
    }]);

    const signoffs = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_pathologist_signoffs
         (tenant_id, patient_uid, result_ids, signed_off_by, decision, comments)
       VALUES ($1::uuid, $2::uuid, ARRAY[$3::int], $4::uuid, 'amended',
               'delayed acknowledgement replay regression')
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      resultId,
      ASSIGNEE_UID,
    );
    const corrected = await materializeLabCriticalAlertGeneration({
      tenantId: TENANT_ID,
      resultId,
      expectedPatientUid: PATIENT_UID,
      orderingClinicianUid: ASSIGNEE_UID,
      generationSignoffId: signoffs[0].id,
      generationDecision: 'amended',
      generationActorUid: ASSIGNEE_UID,
      source: 'corrected_result_replay_regression',
      criticality: {
        breached: true,
        matched: true,
        breachedSide: 'high',
        breachedValue: 6.2,
        evaluatedValue: 7.1,
        criticalLow: null,
        criticalHigh: 6.2,
      },
    });
    expect(corrected).toMatchObject({
      created: true,
      task: expect.objectContaining({ slaInstanceId: SLA_ID }),
    });
    const replacementTaskId = corrected.task.taskId;
    expect(replacementTaskId).not.toBe(taskId);

    const beforeReplay = await prisma.$queryRawUnsafe(
      `SELECT task.status,
              task.metadata,
              sla.status AS sla_status,
              sla.completed_at AS sla_completed_at,
              (SELECT COUNT(*)::int
                 FROM task_comments AS comment
                WHERE comment.tenant_id = task.tenant_id
                  AND comment.task_id = task.id) AS comment_count
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      TENANT_ID,
      replacementTaskId,
    );
    expect(beforeReplay[0]).toMatchObject({
      status: 'open',
      sla_status: 'active',
      sla_completed_at: null,
      comment_count: 0,
    });
    expect(beforeReplay[0].metadata).not.toHaveProperty('acknowledged_at');

    await expect(acknowledgeAlert(alertId, {
      tenantId: TENANT_ID,
      acknowledged_by: ASSIGNEE_UID,
      acknowledged_by_name: 'Critical lab assignee',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
      read_back_method: 'phone',
    })).rejects.toMatchObject({ statusCode: 403 });

    const afterReplay = await prisma.$queryRawUnsafe(
      `SELECT task.status,
              task.metadata,
              sla.status AS sla_status,
              sla.completed_at AS sla_completed_at,
              (SELECT COUNT(*)::int
                 FROM task_comments AS comment
                WHERE comment.tenant_id = task.tenant_id
                  AND comment.task_id = task.id) AS comment_count
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      TENANT_ID,
      replacementTaskId,
    );
    expect(afterReplay[0]).toMatchObject({
      status: 'open',
      sla_status: 'active',
      sla_completed_at: null,
      comment_count: 0,
    });
    expect(afterReplay[0].metadata).not.toHaveProperty('acknowledged_at');

    const evidence = await prisma.$queryRawUnsafe(
      `SELECT
          (SELECT COUNT(*)::int
             FROM clinical_timeline_events
            WHERE tenant_id = $1::uuid
              AND source_table = 'lab_critical_alerts'
              AND source_id = $2::text) AS timeline_count,
          (SELECT COUNT(*)::int
             FROM clinical_audit_events
            WHERE tenant_id = $1::uuid
              AND resource_table = 'lab_critical_alerts'
              AND resource_id = $2::text) AS audit_count`,
      TENANT_ID,
      String(alertId),
    );
    expect(evidence[0]).toEqual({ timeline_count: 1, audit_count: 1 });
  }, 30_000);
});
