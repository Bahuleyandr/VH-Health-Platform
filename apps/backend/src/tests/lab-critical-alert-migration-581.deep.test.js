import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../migrations/581_lab_critical_alert_generations.sql', import.meta.url),
  'utf8',
);

const CLONED_TABLES = [
  'tenants',
  'patient_access_break_glass',
  'lab_results',
  'lab_critical_thresholds',
  'lab_pathologist_signoffs',
  'workflow_sla_instances',
  'tasks',
  'task_comments',
  'lab_critical_alerts',
  'clinical_timeline_events',
  'clinical_audit_events',
  'appointments',
  'admissions',
  'ot_schedules',
  'billing_payments',
  'insurance_preauth',
  'tpa_claims',
];

const FIXTURE = Object.freeze({
  tenantId: '10000000-0000-4000-8000-000000000581',
  patientUid: '20000000-0000-4000-8000-000000000581',
  actorUid: '30000000-0000-4000-8000-000000000581',
  slaId: '40000000-0000-4000-8000-000000000581',
  resultId: 58101,
  taskId: 58102,
  alertId: 58103,
  signoffId: 58104,
  successorTaskId: 58105,
  successorAlertId: 58106,
  successorCommentId: 58210,
  firedAt: '2026-07-19T05:00:00.000Z',
  acknowledgedAt: '2026-07-19T05:02:00.000Z',
  successorSignedAt: '2026-07-19T05:04:00.000Z',
  successorFiredAt: '2026-07-19T05:05:00.000Z',
  successorAcknowledgedAt: '2026-07-19T05:07:00.000Z',
  readBackMethod: 'phone',
});

function schemaMigration(sql, schemaName) {
  return sql
    .replaceAll('SET search_path = public, pg_temp', `SET search_path = "${schemaName}", pg_temp`)
    .replaceAll("table_schema = 'public'", `table_schema = '${schemaName}'`)
    .replaceAll("to_regclass('public.", `to_regclass('${schemaName}.`)
    .replace(
      /DROP INDEX IF EXISTS ([a-zA-Z0-9_]+);/g,
      `DROP INDEX IF EXISTS "${schemaName}".$1;`,
    );
}

async function seedBase(client) {
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, 'lab-581-fixture', 'Lab 581 Fixture')`,
    [FIXTURE.tenantId],
  );
  await client.query(
    `INSERT INTO lab_results
       (id, tenant_id, patient_uid, test_code, test_name, value_text,
        value_numeric, unit, status, is_critical, received_at, updated_at)
     VALUES
       ($1, $2::uuid, $3::uuid, 'K', 'Potassium', '7.1', 7.1, 'mmol/L',
        'preliminary', TRUE, $4::timestamptz, $4::timestamptz)`,
    [FIXTURE.resultId, FIXTURE.tenantId, FIXTURE.patientUid, FIXTURE.firedAt],
  );
}

async function seedAcknowledgedAlert(
  client,
  { readBackMethod = FIXTURE.readBackMethod } = {},
) {
  await client.query(
    `INSERT INTO lab_critical_alerts
       (id, tenant_id, result_id, patient_uid, test_name, value_text,
        value_numeric, unit, threshold_breached, threshold_value, fired_at,
        acknowledged_at, acknowledged_by, read_back_method)
     VALUES
       ($1, $2::uuid, $3, $4::uuid, 'Potassium', '7.1', 7.1, 'mmol/L',
        'high', 6.2, $5::timestamptz, $6::timestamptz, $7::uuid, $8)`,
    [
      FIXTURE.alertId,
      FIXTURE.tenantId,
      FIXTURE.resultId,
      FIXTURE.patientUid,
      FIXTURE.firedAt,
      FIXTURE.acknowledgedAt,
      FIXTURE.actorUid,
      readBackMethod,
    ],
  );
}

async function seedClosedContract(
  client,
  {
    contractVersion = 2,
    taskStatus = 'in_progress',
    slaStatus = 'completed',
    commentCount = 1,
    commentOffsetSeconds = 0,
    includeCanonical = true,
    canonicalActorUid = FIXTURE.actorUid,
    readBackMethod = FIXTURE.readBackMethod,
  } = {},
) {
  const taskMetadata = {
    sla_instance_id: FIXTURE.slaId,
    sla_key: 'critical_result_ack',
    acknowledged_at: FIXTURE.acknowledgedAt,
    acknowledged_by: FIXTURE.actorUid,
    acknowledged_via: 'role',
    ...(contractVersion == null ? {} : { ack_contract_version: contractVersion }),
  };
  const slaMetadata = {
    completed_via: 'task_ack',
    completed_by_task: String(FIXTURE.taskId),
    completed_by: FIXTURE.actorUid,
    ...(contractVersion == null ? {} : { ack_contract_version: contractVersion }),
  };
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_code, patient_uid, source_table, source_id,
        status, priority, started_at, due_at, completed_at, metadata)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result_ack', $3::uuid, 'lab_result',
        $4::text, $5, 'critical', $6::timestamptz,
        $6::timestamptz + INTERVAL '5 minutes', $7::timestamptz, $8::jsonb)`,
    [
      FIXTURE.slaId,
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.resultId,
      slaStatus,
      FIXTURE.firedAt,
      slaStatus === 'active' ? null : FIXTURE.acknowledgedAt,
      JSON.stringify(slaMetadata),
    ],
  );
  await client.query(
    `INSERT INTO tasks
       (id, tenant_id, task_kind, title, patient_uid, related_resource_type,
        related_resource_id, priority, status, assigned_to_role,
        workflow_sla_instance_id, sla_completion_semantics, metadata)
     VALUES
       ($1, $2::uuid, 'review', 'Acknowledge critical result',
        $3::uuid, 'lab_result', $4::text, 'critical', $5, 'LAB_STAFF',
        $6::uuid, 'acknowledgement', $7::jsonb)`,
    [
      FIXTURE.taskId,
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.resultId,
      taskStatus,
      FIXTURE.slaId,
      JSON.stringify(taskMetadata),
    ],
  );
  await seedAcknowledgedAlert(client, { readBackMethod });

  for (let ordinal = 0; ordinal < commentCount; ordinal += 1) {
    const commentMetadata = {
      from: 'open',
      to: 'in_progress',
      acknowledged_at: FIXTURE.acknowledgedAt,
      via: 'role',
      ...(contractVersion == null ? {} : { ack_contract_version: contractVersion }),
    };
    await client.query(
      `INSERT INTO task_comments
         (id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at)
       VALUES
         ($1, $2::uuid, $3, $4::uuid, 'Task acknowledged', 'state_change',
           $5::jsonb,
           $6::timestamptz + (($7::int + $8::int) * INTERVAL '1 second'))`,
      [
        58200 + ordinal,
        FIXTURE.tenantId,
        FIXTURE.taskId,
        FIXTURE.actorUid,
        JSON.stringify(commentMetadata),
        FIXTURE.acknowledgedAt,
        commentOffsetSeconds,
        ordinal,
      ],
    );
  }

  if (!includeCanonical) return;
  const timelinePayload = {
    alert_id: FIXTURE.alertId,
    result_id: FIXTURE.resultId,
    acknowledgement_authorization: 'role',
    read_back_method: readBackMethod,
    ...(contractVersion == null ? {} : { ack_contract_version: contractVersion }),
  };
  await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table, source_id,
        resource_type, resource_id, actor_uid, actor_role, occurred_at, payload,
        tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'acknowledged',
        'lab_critical_alerts', $3::text, 'critical_lab_alert', $3::text,
        $4::uuid, 'LAB_STAFF', $5::timestamptz, $6::jsonb,
        ARRAY['lab', 'critical']::text[],
        'lab_critical_alerts:' || $3::text || ':acknowledged')`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.alertId,
      canonicalActorUid,
      FIXTURE.acknowledgedAt,
      JSON.stringify(timelinePayload),
    ],
  );
  const auditMetadata = contractVersion == null ? {} : { ack_contract_version: contractVersion };
  const afterState = {
    acknowledged_at: FIXTURE.acknowledgedAt,
    acknowledged_by: FIXTURE.actorUid,
    read_back_method: readBackMethod,
    ...(contractVersion == null ? {} : { ack_contract_version: contractVersion }),
  };
  await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
        resource_type, resource_table, resource_id, after_state, metadata,
        idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'success', $3::uuid,
        'LAB_STAFF', 'critical_lab_alert', 'lab_critical_alerts', $4::text,
        $5::jsonb, $6::jsonb,
        'lab_critical_alerts:' || $4::text || ':audit:acknowledged',
        $7::timestamptz)`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      canonicalActorUid,
      FIXTURE.alertId,
      JSON.stringify(afterState),
      JSON.stringify(auditMetadata),
      FIXTURE.acknowledgedAt,
    ],
  );
}

async function seedActiveObligation(client) {
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_code, patient_uid, source_table, source_id,
        status, priority, started_at, due_at, metadata)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result_ack', $3::uuid, 'lab_result',
        $4::text, 'active', 'critical', $5::timestamptz,
        $5::timestamptz + INTERVAL '5 minutes', '{}'::jsonb)`,
    [
      FIXTURE.slaId,
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.resultId,
      FIXTURE.firedAt,
    ],
  );
  await client.query(
    `INSERT INTO tasks
       (id, tenant_id, task_kind, title, patient_uid, related_resource_type,
        related_resource_id, priority, status, assigned_to_role,
        workflow_sla_instance_id, sla_completion_semantics, metadata)
     VALUES
       ($1, $2::uuid, 'review', 'Acknowledge critical result',
        $3::uuid, 'lab_result', $4::text, 'critical', 'open', 'LAB_STAFF',
        $5::uuid, 'acknowledgement',
        jsonb_build_object(
          'sla_instance_id', $5::text,
          'sla_key', 'critical_result_ack'
        ))`,
    [
      FIXTURE.taskId,
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.resultId,
      FIXTURE.slaId,
    ],
  );
  await client.query(
    `INSERT INTO lab_critical_alerts
       (id, tenant_id, result_id, patient_uid, test_name, value_text,
        value_numeric, unit, threshold_breached, threshold_value, fired_at)
     VALUES
       ($1, $2::uuid, $3, $4::uuid, 'Potassium', '7.1', 7.1, 'mmol/L',
        'high', 6.2, $5::timestamptz)`,
    [
      FIXTURE.alertId,
      FIXTURE.tenantId,
      FIXTURE.resultId,
      FIXTURE.patientUid,
      FIXTURE.firedAt,
    ],
  );
}

async function expectMigrationFailure(client, sql, reason) {
  await expect(client.query(sql)).rejects.toMatchObject({
    code: '23514',
    message: expect.stringContaining(reason),
  });
  await client.query('ROLLBACK');
}

async function expectDeferredCommitFailure(client, mutate, reason) {
  await client.query('BEGIN');
  try {
    await mutate();
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining(reason),
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

async function closedContractSnapshot(client) {
  const snapshot = await client.query(
    `SELECT
       (SELECT jsonb_build_object(
          'status', status,
          'completed_at', completed_at,
          'metadata', metadata
        ) FROM workflow_sla_instances WHERE id = $1::uuid) AS sla,
       (SELECT jsonb_build_object(
          'status', status,
          'completed_at', completed_at,
          'metadata', metadata
        ) FROM tasks WHERE id = $2) AS task,
       (SELECT COUNT(*)::int FROM task_comments WHERE task_id = $2) AS comment_count,
       (SELECT COUNT(*)::int FROM clinical_timeline_events
         WHERE source_table = 'lab_critical_alerts' AND source_id = $3::text)
         AS timeline_count,
       (SELECT COUNT(*)::int FROM clinical_audit_events
         WHERE resource_table = 'lab_critical_alerts' AND resource_id = $3::text)
         AS audit_count`,
    [FIXTURE.slaId, FIXTURE.taskId, FIXTURE.alertId],
  );
  return snapshot.rows[0];
}

async function acknowledgementReceiptSnapshot(client) {
  const receipts = await client.query(
    `SELECT to_jsonb(receipt) AS receipt
       FROM lab_critical_alert_acknowledgement_receipts AS receipt
      WHERE receipt.tenant_id = $1::uuid
      ORDER BY receipt.alert_id`,
    [FIXTURE.tenantId],
  );
  return receipts.rows.map((row) => row.receipt);
}

async function writeV2Acknowledgement(
  client,
  {
    alertId,
    taskId,
    acknowledgedAt,
    commentId,
    recordReceipt = true,
    readBackMethod = FIXTURE.readBackMethod,
  },
) {
  await client.query(
    `UPDATE tasks
        SET status = 'in_progress',
            completed_at = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'acknowledged_at', $1::text,
              'acknowledged_by', $2::text,
              'acknowledged_via', 'role',
              'ack_contract_version', 2
            ),
            updated_at = $1::timestamptz
      WHERE tenant_id = $3::uuid AND id = $4::int`,
    [acknowledgedAt, FIXTURE.actorUid, FIXTURE.tenantId, taskId],
  );
  await client.query(
    `UPDATE workflow_sla_instances
        SET status = 'completed',
            completed_at = $1::timestamptz,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'completed_via', 'task_ack',
              'completed_by_task', $2::int,
              'completed_by', $3::text,
              'ack_contract_version', 2
            ),
            updated_at = $1::timestamptz
      WHERE tenant_id = $4::uuid AND id = $5::uuid`,
    [acknowledgedAt, taskId, FIXTURE.actorUid, FIXTURE.tenantId, FIXTURE.slaId],
  );
  await client.query(
    `INSERT INTO task_comments
       (id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at)
     VALUES
       ($1::int, $2::uuid, $3::int, $4::uuid, 'Task acknowledged', 'state_change',
        jsonb_build_object(
          'from', 'open',
          'to', 'in_progress',
          'acknowledged_at', $5::text,
          'via', 'role',
          'ack_contract_version', 2
        ),
        $5::timestamptz)`,
    [commentId, FIXTURE.tenantId, taskId, FIXTURE.actorUid, acknowledgedAt],
  );
  await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table, source_id,
        resource_type, resource_id, actor_uid, actor_role, occurred_at, payload,
        tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'acknowledged',
        'lab_critical_alerts', $3::text, 'critical_lab_alert', $3::text,
        $4::uuid, 'LAB_STAFF', $5::timestamptz,
        jsonb_build_object(
          'alert_id', $3::int,
          'result_id', $6::int,
          'acknowledgement_authorization', 'role',
          'read_back_method', $7::text,
          'ack_contract_version', 2
        ),
        ARRAY['lab', 'critical']::text[],
        'lab_critical_alerts:' || $3::text || ':acknowledged')`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      alertId,
      FIXTURE.actorUid,
      acknowledgedAt,
      FIXTURE.resultId,
      readBackMethod,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
        resource_type, resource_table, resource_id, after_state, metadata,
        idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'success', $3::uuid,
        'LAB_STAFF', 'critical_lab_alert', 'lab_critical_alerts', $4::text,
        jsonb_build_object(
          'acknowledged_at', $5::text,
          'acknowledged_by', $3::text,
          'read_back_method', $6::text,
          'ack_contract_version', 2
        ),
        jsonb_build_object('ack_contract_version', 2),
        'lab_critical_alerts:' || $4::text || ':audit:acknowledged',
        $5::timestamptz)`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.actorUid,
      alertId,
      acknowledgedAt,
      readBackMethod,
    ],
  );
  await client.query(
    `UPDATE lab_critical_alerts
        SET acknowledged_at = $1::timestamptz,
            acknowledged_by = $2::uuid,
            read_back_method = $3
      WHERE tenant_id = $4::uuid AND id = $5::int`,
    [
      acknowledgedAt,
      FIXTURE.actorUid,
      readBackMethod,
      FIXTURE.tenantId,
      alertId,
    ],
  );
  if (recordReceipt) {
    await client.query(
      `SELECT record_lab_critical_alert_acknowledgement_receipt(
         $1::uuid, $2::int, $3::int
       )`,
      [FIXTURE.tenantId, alertId, taskId],
    );
  }
}

async function writeCorrectedGeneration(client) {
  await client.query(
      `INSERT INTO lab_pathologist_signoffs
         (id, tenant_id, patient_uid, result_ids, signed_off_by, decision, signed_at)
       VALUES
         ($1::int, $2::uuid, $3::uuid, ARRAY[$4::int], $5::uuid,
          'corrected', $6::timestamptz)`,
      [
        FIXTURE.signoffId,
        FIXTURE.tenantId,
        FIXTURE.patientUid,
        FIXTURE.resultId,
        FIXTURE.actorUid,
        FIXTURE.successorSignedAt,
      ],
    );
  await client.query(
      `UPDATE tasks
          SET status = 'completed',
              completed_at = $1::timestamptz,
              updated_at = $1::timestamptz
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      [FIXTURE.successorFiredAt, FIXTURE.tenantId, FIXTURE.taskId],
    );
  await client.query(
      `INSERT INTO tasks
         (id, tenant_id, task_kind, title, patient_uid, related_resource_type,
          related_resource_id, priority, status, assigned_to_role,
          workflow_sla_instance_id, sla_completion_semantics, metadata,
          created_at, updated_at)
       VALUES
         ($1::int, $2::uuid, 'review', 'Acknowledge corrected critical result',
          $3::uuid, 'lab_result', $4::text, 'critical', 'open', 'LAB_STAFF',
          $5::uuid, 'acknowledgement',
          jsonb_build_object(
            'sla_instance_id', $5::text,
            'sla_key', 'critical_result_ack',
            'lab_critical_alert_id', $6::int,
            'lab_alert_generation_signoff_id', $7::int,
            'lab_alert_generation_state', 'critical'
          ),
          $8::timestamptz, $8::timestamptz)`,
      [
        FIXTURE.successorTaskId,
        FIXTURE.tenantId,
        FIXTURE.patientUid,
        FIXTURE.resultId,
        FIXTURE.slaId,
        FIXTURE.successorAlertId,
        FIXTURE.signoffId,
        FIXTURE.successorFiredAt,
      ],
    );
  await client.query(
      `UPDATE lab_critical_alerts
          SET superseded_at = $1::timestamptz,
              superseded_by_alert_id = $2::int,
              superseded_by_signoff_id = $3::int
        WHERE tenant_id = $4::uuid AND id = $5::int`,
      [
        FIXTURE.successorFiredAt,
        FIXTURE.successorAlertId,
        FIXTURE.signoffId,
        FIXTURE.tenantId,
        FIXTURE.alertId,
      ],
    );
  await client.query(
      `INSERT INTO lab_critical_alerts
         (id, tenant_id, result_id, patient_uid, test_name, value_text,
          value_numeric, unit, threshold_breached, threshold_value, fired_at,
          generation_signoff_id, acknowledgement_task_id, generation_metadata)
       VALUES
         ($1::int, $2::uuid, $3::int, $4::uuid, 'Potassium', '7.2', 7.2,
          'mmol/L', 'high', 6.2, $5::timestamptz, $6::int, $7::int,
          jsonb_build_object(
            'kind', 'corrected_result_generation',
            'signoff_id', $6::int,
            'supersedes_alert_id', $8::int,
            'acknowledgement_task_id', $7::int,
            'corrected_state', 'critical'
          ))`,
      [
        FIXTURE.successorAlertId,
        FIXTURE.tenantId,
        FIXTURE.resultId,
        FIXTURE.patientUid,
        FIXTURE.successorFiredAt,
        FIXTURE.signoffId,
        FIXTURE.successorTaskId,
        FIXTURE.alertId,
      ],
    );
  await client.query(
      `UPDATE workflow_sla_instances
          SET status = 'active',
              completed_at = NULL,
              breached_at = NULL,
              escalated_at = NULL,
              started_at = $1::timestamptz,
              due_at = $1::timestamptz + INTERVAL '5 minutes',
              metadata = (
                COALESCE(metadata, '{}'::jsonb)
                  - 'completed_via'
                  - 'completed_by_task'
                  - 'completed_by'
                  - 'acknowledged_by'
                  - 'completion_evidence'
                  - 'ack_contract_version'
              ) || jsonb_build_object(
                'reopened_at', $1::text,
                'reopen_reason', 'corrected_result_test'
              ),
              updated_at = $1::timestamptz
        WHERE tenant_id = $2::uuid AND id = $3::uuid`,
      [FIXTURE.successorFiredAt, FIXTURE.tenantId, FIXTURE.slaId],
    );
}

async function rearmCorrectedGeneration(client) {
  await client.query('BEGIN');
  try {
    await writeCorrectedGeneration(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

describeIfDb('migration 581 acknowledged alert binding', () => {
  let client;
  let schemaName;
  let scopedMigration;

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    schemaName = `lab_ack_581_${randomUUID().replaceAll('-', '')}`;
    scopedMigration = schemaMigration(migrationSql, schemaName);
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}", public`);
    for (const tableName of CLONED_TABLES) {
      await client.query(
        `CREATE TABLE "${schemaName}"."${tableName}"
           (LIKE public."${tableName}" INCLUDING ALL)`,
      );
    }
    await client.query(`
      ALTER TABLE lab_critical_alerts
        DROP COLUMN IF EXISTS superseded_at CASCADE,
        DROP COLUMN IF EXISTS superseded_by_alert_id CASCADE,
        DROP COLUMN IF EXISTS superseded_by_signoff_id CASCADE,
        DROP COLUMN IF EXISTS generation_signoff_id CASCADE,
        DROP COLUMN IF EXISTS acknowledgement_task_id CASCADE,
        DROP COLUMN IF EXISTS generation_metadata CASCADE
    `);
  });

  afterEach(async () => {
    if (client && schemaName) {
      const publicIndexes = await client.query(
        `SELECT COUNT(*)::int AS index_count
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = ANY($1::text[])`,
        [[
          'idx_critical_alerts_tenant_pending',
          'idx_lab_critical_alert_generation_signoff',
          'idx_lab_critical_alert_superseded_by',
        ]],
      ).catch(() => ({ rows: [{ index_count: 0 }] }));
      await client.query('SET search_path TO public').catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
      expect(publicIndexes.rows[0].index_count).toBe(3);
    }
    await client?.end();
  });

  test('rejects an acknowledged alert with no task/SLA rail on first apply', async () => {
    await seedBase(client);
    await seedAcknowledgedAlert(client);

    await expectMigrationFailure(client, scopedMigration, 'closed_ack_contract_count_0');
  });

  test('rejects an acknowledged alert whose task/SLA rail is still active', async () => {
    await seedBase(client);
    await seedClosedContract(client, { taskStatus: 'open', slaStatus: 'active' });

    await expectMigrationFailure(client, scopedMigration, 'closed_ack_contract_count_0');
  });

  test.each([
    {
      label: 'unversioned evidence',
      options: { contractVersion: null },
    },
    {
      label: 'canonical actor mismatch',
      options: { canonicalActorUid: '30000000-0000-4000-8000-000000000582' },
    },
  ])('rejects weak $label instead of inferring authorization', async ({ options }) => {
    await seedBase(client);
    await seedClosedContract(client, options);

    await expectMigrationFailure(client, scopedMigration, 'closed_ack_contract_count_0');
  });

  test('rejects ambiguous duplicate acknowledgement comments', async () => {
    await seedBase(client);
    await seedClosedContract(client, { commentCount: 2 });

    await expectMigrationFailure(client, scopedMigration, 'closed_ack_contract_count_0');
  });

  test.each([-60, 60])(
    'accepts an acknowledgement comment stored at the inclusive %i-second clock boundary',
    async (commentOffsetSeconds) => {
      await seedBase(client);
      await seedClosedContract(client, { commentOffsetSeconds });

      await expect(client.query(scopedMigration)).resolves.toBeDefined();
      expect(await acknowledgementReceiptSnapshot(client)).toHaveLength(1);
    },
  );

  test.each([-61, 61])(
    'rejects an acknowledgement comment stored outside the %i-second clock boundary',
    async (commentOffsetSeconds) => {
      await seedBase(client);
      await seedClosedContract(client, { commentOffsetSeconds });

      await expectMigrationFailure(client, scopedMigration, 'closed_ack_contract_count_0');
    },
  );

  test.each([40, 41, 160])(
    'preserves an exact %i-character read-back method in the acknowledgement receipt',
    async (methodLength) => {
      const readBackMethod = 'r'.repeat(methodLength);
      await seedBase(client);
      await seedClosedContract(client, { readBackMethod });

      await expect(client.query(scopedMigration)).resolves.toBeDefined();
      const receipt = await client.query(
        `SELECT read_back_method,
                character_length(read_back_method)::int AS method_length
           FROM lab_critical_alert_acknowledgement_receipts
          WHERE tenant_id = $1::uuid AND alert_id = $2::int`,
        [FIXTURE.tenantId, FIXTURE.alertId],
      );
      expect(receipt.rows[0]).toEqual({
        read_back_method: readBackMethod,
        method_length: methodLength,
      });
    },
  );

  test('keeps the existing 160-character alert contract fail-closed at 161 characters', async () => {
    await seedBase(client);
    const sourceWidth = await client.query(
      `SELECT character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'lab_critical_alerts'
          AND column_name = 'read_back_method'`,
      [schemaName],
    );
    expect(sourceWidth.rows[0].character_maximum_length).toBe(160);

    await expect(seedAcknowledgedAlert(client, {
      readBackMethod: 'r'.repeat(161),
    })).rejects.toMatchObject({ code: '22001' });
  });

  test('accepts one exact pre-reconciled contract, binds provenance only, and reruns', async () => {
    await seedBase(client);
    await seedClosedContract(client);
    const before = await closedContractSnapshot(client);

    await expect(client.query(scopedMigration)).resolves.toBeDefined();

    const bound = await client.query(
      `SELECT acknowledgement_task_id, generation_metadata
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    );
    expect(bound.rows[0]).toEqual({
      acknowledgement_task_id: FIXTURE.taskId,
      generation_metadata: expect.objectContaining({
        kind: 'initial_result_generation',
        source: 'migration_581_legacy_closed_ack_bridge',
        acknowledgement_task_id: FIXTURE.taskId,
        corrected_state: 'critical',
        legacy_bridge: true,
        closed_ack_contract_version: 2,
      }),
    });
    const afterFirstApply = await closedContractSnapshot(client);
    expect(afterFirstApply.sla).toEqual(before.sla);
    expect(afterFirstApply.task).toEqual({
      ...before.task,
      metadata: expect.objectContaining({
        ...before.task.metadata,
        lab_critical_alert_id: FIXTURE.alertId,
        lab_alert_generation_state: 'critical',
      }),
    });
    expect(afterFirstApply.comment_count).toBe(before.comment_count);
    expect(afterFirstApply.timeline_count).toBe(before.timeline_count);
    expect(afterFirstApply.audit_count).toBe(before.audit_count);

    const receiptsAfterFirstApply = await acknowledgementReceiptSnapshot(client);
    expect(receiptsAfterFirstApply).toHaveLength(1);
    expect(receiptsAfterFirstApply[0]).toEqual(expect.objectContaining({
      tenant_id: FIXTURE.tenantId,
      alert_id: FIXTURE.alertId,
      result_id: FIXTURE.resultId,
      patient_uid: FIXTURE.patientUid,
      acknowledgement_task_id: FIXTURE.taskId,
      workflow_sla_instance_id: FIXTURE.slaId,
      acknowledged_by: FIXTURE.actorUid,
      acknowledgement_authorization: 'role',
      ack_contract_version: 2,
    }));
    const rowSecurity = await client.query(
      `SELECT relation.relrowsecurity,
              relation.relforcerowsecurity,
              EXISTS (
                SELECT 1
                  FROM pg_policy AS policy
                 WHERE policy.polrelid = relation.oid
                   AND policy.polname = 'tenant_isolation'
                   AND policy.polqual IS NOT NULL
                   AND policy.polwithcheck IS NOT NULL
              ) AS has_tenant_policy
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND relation.relname = 'lab_critical_alert_acknowledgement_receipts'`,
      [schemaName],
    );
    expect(rowSecurity.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      has_tenant_policy: true,
    });
    const receiptWidth = await client.query(
      `SELECT character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'lab_critical_alert_acknowledgement_receipts'
          AND column_name = 'read_back_method'`,
      [schemaName],
    );
    expect(receiptWidth.rows[0].character_maximum_length).toBe(160);

    await expect(client.query(scopedMigration)).resolves.toBeDefined();
    expect(await closedContractSnapshot(client)).toEqual(afterFirstApply);
    expect(await acknowledgementReceiptSnapshot(client)).toEqual(receiptsAfterFirstApply);
  });

  test('makes the acknowledgement receipt itself append-only', async () => {
    await seedBase(client);
    await seedClosedContract(client);
    await client.query(scopedMigration);

    await expect(client.query(
      `UPDATE lab_critical_alert_acknowledgement_receipts
          SET created_at = created_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND alert_id = $2::int`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    )).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('append-only'),
    });
  });

  test.each([
    {
      label: 'task acknowledgement metadata',
      sql: `UPDATE tasks
               SET metadata = jsonb_set(
                 metadata,
                 '{acknowledged_by}',
                 to_jsonb('30000000-0000-4000-8000-000000000582'::text)
               )
             WHERE tenant_id = $1::uuid AND id = $2::int`,
      id: FIXTURE.taskId,
      reason: 'task receipt is immutable',
    },
    {
      label: 'task comment',
      sql: `UPDATE task_comments
               SET body = 'tampered acknowledgement'
             WHERE tenant_id = $1::uuid AND id = $2::int`,
      id: 58200,
      reason: 'receipt evidence is immutable',
    },
    {
      label: 'timeline event',
      sql: `UPDATE clinical_timeline_events
               SET actor_role = 'ADMIN'
             WHERE tenant_id = $1::uuid
               AND source_table = 'lab_critical_alerts'
               AND source_id = $2::text`,
      id: FIXTURE.alertId,
      reason: 'receipt evidence is immutable',
    },
    {
      label: 'audit event',
      sql: `UPDATE clinical_audit_events
               SET actor_role = 'ADMIN'
             WHERE tenant_id = $1::uuid
               AND resource_table = 'lab_critical_alerts'
               AND resource_id = $2::text`,
      id: FIXTURE.alertId,
      reason: 'receipt evidence is immutable',
    },
  ])('rejects tampering with sealed $label', async ({ sql, id, reason }) => {
    await seedBase(client);
    await seedClosedContract(client);
    await client.query(scopedMigration);

    await expect(client.query(sql, [FIXTURE.tenantId, id])).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining(reason),
    });
  });

  test('rejects a duplicate exact acknowledgement comment after the receipt is sealed', async () => {
    await seedBase(client);
    await seedClosedContract(client);
    await client.query(scopedMigration);

    await expectDeferredCommitFailure(
      client,
      () => client.query(
        `INSERT INTO task_comments
           (id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at)
         SELECT $1::int, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at
           FROM task_comments
          WHERE tenant_id = $2::uuid AND id = $3::int`,
        [58201, FIXTURE.tenantId, 58200],
      ),
      'acknowledgement receipt is invalid',
    );
    const comments = await client.query(
      `SELECT COUNT(*)::int AS comment_count
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2::int`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );
    expect(comments.rows[0].comment_count).toBe(1);
  });

  test('rejects a complete v2 acknowledgement chain that omits its same-transaction receipt', async () => {
    await seedBase(client);
    await seedActiveObligation(client);
    await client.query(scopedMigration);

    await expectDeferredCommitFailure(
      client,
      () => writeV2Acknowledgement(client, {
        alertId: FIXTURE.alertId,
        taskId: FIXTURE.taskId,
        acknowledgedAt: FIXTURE.acknowledgedAt,
        commentId: 58200,
        recordReceipt: false,
      }),
      'acknowledgement receipt',
    );
    const state = await client.query(
      `SELECT alert.acknowledged_at,
              task.status AS task_status,
              sla.status AS sla_status
         FROM lab_critical_alerts AS alert
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE alert.tenant_id = $1::uuid AND alert.id = $2::int`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    );
    expect(state.rows[0]).toEqual({
      acknowledged_at: null,
      task_status: 'open',
      sla_status: 'active',
    });
  });

  test('rejects rearming a sealed SLA without a replacement current generation', async () => {
    await seedBase(client);
    await seedClosedContract(client);
    await client.query(scopedMigration);

    await expectDeferredCommitFailure(
      client,
      () => client.query(
        `UPDATE workflow_sla_instances
            SET status = 'active',
                completed_at = NULL,
                metadata = metadata
                  - 'completed_via'
                  - 'completed_by_task'
                  - 'completed_by'
                  - 'ack_contract_version'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [FIXTURE.tenantId, FIXTURE.slaId],
      ),
      'acknowledgement receipt is invalid',
    );
    const sla = await client.query(
      `SELECT status, completed_at
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [FIXTURE.tenantId, FIXTURE.slaId],
    );
    expect(sla.rows[0]).toEqual({
      status: 'completed',
      completed_at: new Date(FIXTURE.acknowledgedAt),
    });
  });

  test('allows a newly sealed predecessor to be superseded and its SLA rearmed atomically', async () => {
    await seedBase(client);
    await seedActiveObligation(client);
    await client.query(scopedMigration);

    await client.query('BEGIN');
    try {
      await writeV2Acknowledgement(client, {
        alertId: FIXTURE.alertId,
        taskId: FIXTURE.taskId,
        acknowledgedAt: FIXTURE.acknowledgedAt,
        commentId: 58200,
      });
      await writeCorrectedGeneration(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const state = await client.query(
      `SELECT predecessor.superseded_by_alert_id,
              successor.acknowledged_at AS successor_acknowledged_at,
              successor.acknowledgement_task_id AS successor_task_id,
              sla.status AS sla_status,
              assert_lab_critical_alert_acknowledgement_receipt(
                predecessor.tenant_id, predecessor.id, FALSE
              ) AS predecessor_receipt_valid
         FROM lab_critical_alerts AS predecessor
         JOIN lab_critical_alerts AS successor
           ON successor.tenant_id = predecessor.tenant_id
          AND successor.id = predecessor.superseded_by_alert_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = predecessor.tenant_id
          AND sla.id = $3::uuid
        WHERE predecessor.tenant_id = $1::uuid
          AND predecessor.id = $2::int`,
      [FIXTURE.tenantId, FIXTURE.alertId, FIXTURE.slaId],
    );
    expect(state.rows[0]).toEqual({
      superseded_by_alert_id: FIXTURE.successorAlertId,
      successor_acknowledged_at: null,
      successor_task_id: FIXTURE.successorTaskId,
      sla_status: 'active',
      predecessor_receipt_valid: true,
    });
    expect(await acknowledgementReceiptSnapshot(client)).toHaveLength(1);
  });

  test('preserves each acknowledgement when a corrected generation reuses and recloses the SLA', async () => {
    await seedBase(client);
    await seedClosedContract(client);
    await client.query(scopedMigration);
    const predecessorReceipt = await acknowledgementReceiptSnapshot(client);

    await rearmCorrectedGeneration(client);
    const reopened = await client.query(
      `SELECT sla.status AS sla_status,
              sla.completed_at,
              task.status AS task_status,
              task.metadata ? 'ack_contract_version' AS task_has_ack_version,
              sla.metadata ? 'ack_contract_version' AS sla_has_ack_version,
              assert_lab_critical_alert_acknowledgement_receipt(
                $1::uuid, $2::int, FALSE
              ) AS predecessor_receipt_valid
         FROM workflow_sla_instances AS sla
         JOIN tasks AS task
           ON task.tenant_id = sla.tenant_id
          AND task.workflow_sla_instance_id = sla.id
          AND task.id = $3::int
        WHERE sla.tenant_id = $1::uuid AND sla.id = $4::uuid`,
      [
        FIXTURE.tenantId,
        FIXTURE.alertId,
        FIXTURE.successorTaskId,
        FIXTURE.slaId,
      ],
    );
    expect(reopened.rows[0]).toEqual({
      sla_status: 'active',
      completed_at: null,
      task_status: 'open',
      task_has_ack_version: false,
      sla_has_ack_version: false,
      predecessor_receipt_valid: true,
    });
    expect(await acknowledgementReceiptSnapshot(client)).toEqual(predecessorReceipt);

    await client.query('BEGIN');
    try {
      await writeV2Acknowledgement(client, {
        alertId: FIXTURE.successorAlertId,
        taskId: FIXTURE.successorTaskId,
        acknowledgedAt: FIXTURE.successorAcknowledgedAt,
        commentId: FIXTURE.successorCommentId,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const sealed = await acknowledgementReceiptSnapshot(client);
    expect(sealed).toHaveLength(2);
    expect(sealed.map((receipt) => receipt.alert_id)).toEqual([
      FIXTURE.alertId,
      FIXTURE.successorAlertId,
    ]);
    expect(sealed.map((receipt) => receipt.acknowledgement_task_id)).toEqual([
      FIXTURE.taskId,
      FIXTURE.successorTaskId,
    ]);
    expect(new Set(sealed.map((receipt) => receipt.workflow_sla_instance_id))).toEqual(
      new Set([FIXTURE.slaId]),
    );
    const validations = await client.query(
      `SELECT alert_id,
              assert_lab_critical_alert_acknowledgement_receipt(
                tenant_id, alert_id, FALSE
              ) AS receipt_valid
         FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid
        ORDER BY alert_id`,
      [FIXTURE.tenantId],
    );
    expect(validations.rows).toEqual([
      { alert_id: FIXTURE.alertId, receipt_valid: true },
      { alert_id: FIXTURE.successorAlertId, receipt_valid: true },
    ]);

    await expect(client.query(scopedMigration)).resolves.toBeDefined();
    expect(await acknowledgementReceiptSnapshot(client)).toEqual(sealed);
  });

  test('rejects a late old-writer alert-only acknowledgement after migration', async () => {
    await seedBase(client);
    await seedActiveObligation(client);
    await client.query(scopedMigration);

    await expectDeferredCommitFailure(
      client,
      () => client.query(
        `UPDATE lab_critical_alerts
            SET acknowledged_at = $1::timestamptz,
                acknowledged_by = $2::uuid,
                read_back_method = $3
          WHERE tenant_id = $4::uuid AND id = $5`,
        [
          FIXTURE.acknowledgedAt,
          FIXTURE.actorUid,
          FIXTURE.readBackMethod,
          FIXTURE.tenantId,
          FIXTURE.alertId,
        ],
      ),
      'acknowledgement receipt is missing',
    );

    const alert = await client.query(
      `SELECT acknowledged_at, acknowledged_by
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    );
    expect(alert.rows[0]).toEqual({ acknowledged_at: null, acknowledged_by: null });
  });

  test('rejects a late insert of an acknowledged alert without an exact pointer', async () => {
    await seedBase(client);
    await client.query(scopedMigration);

    await expectDeferredCommitFailure(
      client,
      () => seedAcknowledgedAlert(client),
      'missing its acknowledgement task',
    );
    const alerts = await client.query('SELECT COUNT(*)::int AS row_count FROM lab_critical_alerts');
    expect(alerts.rows[0].row_count).toBe(0);
  });
});
