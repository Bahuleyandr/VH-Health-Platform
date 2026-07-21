import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../migrations/583_lab_astm_atomic_replay.sql', import.meta.url),
  'utf8',
);

const CLONED_TABLES = [
  'tenants',
  'users',
  'patient_access_break_glass',
  'api_clients',
  'lab_analyzers',
  'lab_specimens',
  'investigation_bookings',
  'investigations',
  'lab_critical_thresholds',
  'lab_interface_messages',
  'lab_results',
  'workflow_sla_instances',
  'tasks',
  'task_comments',
  'lab_critical_alerts',
  'lab_critical_alert_acknowledgement_receipts',
  'lab_pathologist_signoffs',
  'clinical_timeline_events',
  'clinical_audit_events',
];

const FIXTURE = Object.freeze({
  tenantId: '10000000-0000-4000-8000-000000000001',
  patientUid: '20000000-0000-4000-8000-000000000001',
  actorUid: '30000000-0000-4000-8000-000000000001',
  slaId: '40000000-0000-4000-8000-000000000001',
  patientId: 1101,
  actorId: 1102,
  analyzerId: 2101,
  specimenId: 3101,
  messageId: 4101,
  resultId: 5101,
  taskId: 6101,
  alertId: 7101,
  thresholdId: 8101,
  createdAt: '2026-07-19T06:00:00.000Z',
  resultAt: '2026-07-19T06:05:00.000Z',
  firedAt: '2026-07-19T06:06:00.000Z',
  acknowledgedAt: '2026-07-19T06:08:00.000Z',
  processedAt: '2026-07-19T06:10:00.000Z',
});

const NORMAL_ASTM = [
  'H|\\^&|||ANALYZER',
  'O|1|ACC-583||^^^GLU|R',
  'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
  'L|1|N',
].join('\r');

const CRITICAL_ASTM = [
  'H|\\^&|||ANALYZER',
  'O|1|ACC-583||^^^GLU|R',
  'R|1|^^^GLU|20|mmol/L|3.9^6.1|H||F',
  'L|1|N',
].join('\r');

const CRITICAL_THRESHOLD_ASSESSMENT = Object.freeze({
  matched: true,
  breached: true,
  threshold_id: FIXTURE.thresholdId,
  threshold_test_code: 'GLU',
  threshold_loinc_code: null,
  threshold_unit: 'mmol/L',
  threshold_applies_to: 'all',
  critical_low: null,
  critical_high: 10,
  breached_side: 'high',
  breached_value: 10,
  evaluated_value: 20,
  conversion: null,
});

const CRITICAL_VERDICT = Object.freeze({
  test_code: 'GLU',
  decision: 'critical',
  critical_band: 'high',
  interface_result_index: 1,
  critical_threshold_matched: true,
  threshold_assessment: CRITICAL_THRESHOLD_ASSESSMENT,
});

function schemaMigration(sql, schemaName) {
  return sql
    .replaceAll('SET search_path = public, pg_temp', `SET search_path = "${schemaName}", pg_temp`)
    .replaceAll("table_schema = 'public'", `table_schema = '${schemaName}'`)
    .replaceAll("to_regclass('public.", `to_regclass('${schemaName}.`);
}

async function seedClinicalSource(client) {
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, 'astm-583-fixture', 'ASTM 583 Fixture')`,
    [FIXTURE.tenantId],
  );
  await client.query(
    `INSERT INTO users
       (id, uid, tenant_id, role, is_active, status, is_deleted, updated_at)
     VALUES
       ($1, $2::uuid, $3::uuid, 'PATIENT', TRUE, 'active', FALSE, NOW()),
       ($4, $5::uuid, $3::uuid, 'LAB_STAFF', TRUE, 'active', FALSE, NOW())`,
    [
      FIXTURE.patientId,
      FIXTURE.patientUid,
      FIXTURE.tenantId,
      FIXTURE.actorId,
      FIXTURE.actorUid,
    ],
  );
  await client.query(
    `INSERT INTO lab_analyzers
       (id, tenant_id, analyzer_code, display_name, interface_kind, status, metadata)
     VALUES
       ($1, $2::uuid, 'ASTM-583', 'ASTM 583 Analyzer', 'astm', 'active',
        jsonb_build_object(
          'astm_sender_aliases', jsonb_build_array('ANALYZER'),
          'astm_manual_import_actor_uids', jsonb_build_array($3::text)
        ))`,
    [FIXTURE.analyzerId, FIXTURE.tenantId, FIXTURE.actorUid],
  );
  await client.query(
    `INSERT INTO lab_specimens
       (id, tenant_id, patient_uid, accession_number, barcode, status)
     VALUES ($1, $2::uuid, $3::uuid, 'ACC-583', 'BAR-583', 'received')`,
    [FIXTURE.specimenId, FIXTURE.tenantId, FIXTURE.patientUid],
  );
}

async function seedAggregateEvidence(client) {
  await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, source_table, source_id,
        resource_type, resource_id, actor_uid, actor_role, occurred_at,
        payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'lab.analyzer_results_ingested',
        'lab_interface_messages', $3::text, 'lab_interface_message', $3::text,
        $4::uuid, 'LAB_STAFF', $5::timestamptz, '{}'::jsonb,
        ARRAY['lab', 'astm']::text[],
        'lab_interface_messages:' || $3::text || ':ingested')`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.messageId,
      FIXTURE.actorUid,
      FIXTURE.processedAt,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, actor_uid, actor_role, resource_type,
        resource_table, resource_id, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'lab.analyzer_results_ingested', $3::uuid,
        'LAB_STAFF', 'lab_interface_message', 'lab_interface_messages',
        $4::text, '{}'::jsonb,
        'lab_interface_messages:' || $4::text || ':audit:ingested',
        $5::timestamptz)`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.actorUid,
      FIXTURE.messageId,
      FIXTURE.processedAt,
    ],
  );
}

async function seedCriticalObligation(
  client,
  {
    acknowledged = false,
    readBackMethod = 'verbal_readback',
    ackContractVersion = acknowledged ? 2 : null,
  } = {},
) {
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_code, patient_uid, source_table, source_id,
        status, priority, started_at, due_at, completed_at, metadata)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result_ack', $3::uuid, 'lab_result',
        $4::text, $5::varchar, 'critical', $6::timestamptz,
        ($6::timestamptz + INTERVAL '1 hour'), $7::timestamptz,
        CASE WHEN $5::text = 'completed'
          THEN jsonb_build_object(
            'completed_via', 'task_ack',
            'completed_by_task', $8::text,
            'completed_by', $9::text
          )
          || CASE WHEN $10::integer IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('ack_contract_version', $10::integer)
             END
          ELSE '{}'::jsonb
        END)`,
    [
      FIXTURE.slaId,
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.resultId,
      acknowledged ? 'completed' : 'active',
      FIXTURE.firedAt,
      acknowledged ? FIXTURE.acknowledgedAt : null,
      FIXTURE.taskId,
      FIXTURE.actorUid,
      ackContractVersion,
    ],
  );
  const taskMetadata = {
    sla_instance_id: FIXTURE.slaId,
    sla_key: 'critical_result_ack',
    lab_critical_alert_id: String(FIXTURE.alertId),
    lab_alert_generation_state: 'critical',
    ...(acknowledged
      ? {
          acknowledged_by: FIXTURE.actorUid,
          acknowledged_via: 'role',
          acknowledged_at: FIXTURE.acknowledgedAt,
          ...(ackContractVersion == null
            ? {}
            : { ack_contract_version: ackContractVersion }),
        }
      : {}),
  };
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
      acknowledged ? 'in_progress' : 'open',
      FIXTURE.slaId,
      JSON.stringify(taskMetadata),
    ],
  );
  const generationMetadata = {
    kind: 'initial_result_generation',
    acknowledgement_task_id: String(FIXTURE.taskId),
    corrected_state: 'critical',
    active_threshold_id: FIXTURE.thresholdId,
    active_threshold_low: null,
    active_threshold_high: 10,
    threshold_evaluated_value: 20,
    threshold_value_conversion: null,
  };
  await client.query(
    `INSERT INTO lab_critical_alerts
       (id, tenant_id, result_id, patient_uid, test_name, value_text,
        value_numeric, unit, threshold_breached, threshold_value, fired_at,
        acknowledged_at, acknowledged_by, read_back_method,
        acknowledgement_task_id, generation_metadata)
     VALUES
       ($1, $2::uuid, $3, $4::uuid, 'Glucose', '20', 20, 'mmol/L',
        'high', 10, $5::timestamptz, $6::timestamptz, $7::uuid, $8,
        $9, $10::jsonb)`,
    [
      FIXTURE.alertId,
      FIXTURE.tenantId,
      FIXTURE.resultId,
      FIXTURE.patientUid,
      FIXTURE.firedAt,
      acknowledged ? FIXTURE.acknowledgedAt : null,
      acknowledged ? FIXTURE.actorUid : null,
      acknowledged ? readBackMethod : null,
      FIXTURE.taskId,
      JSON.stringify(generationMetadata),
    ],
  );
}

async function seedAcknowledgementEvidence(
  client,
  {
    commentCount = 1,
    readBackMethod = 'verbal_readback',
    ackContractVersion = 2,
  } = {},
) {
  for (let ordinal = 0; ordinal < commentCount; ordinal += 1) {
    const commentId = 7201 + ordinal;
    await client.query(
      `INSERT INTO task_comments
         (id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at)
       VALUES
         ($1, $2::uuid, $3, $4::uuid, 'Acknowledgement receipt',
           'state_change', jsonb_build_object(
             'from', 'open', 'to', 'in_progress',
             'acknowledged_at', $5::text, 'via', 'role'
           ), $5::timestamptz)`,
      [
        commentId,
        FIXTURE.tenantId,
        FIXTURE.taskId,
        FIXTURE.actorUid,
        FIXTURE.acknowledgedAt,
      ],
    );
    if (ackContractVersion != null) {
      await client.query(
        `UPDATE task_comments
            SET metadata = metadata || jsonb_build_object(
                  'ack_contract_version', $1::integer
                )
          WHERE tenant_id = $2::uuid AND id = $3`,
        [ackContractVersion, FIXTURE.tenantId, commentId],
      );
    }
  }
  await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table, source_id,
        resource_type, resource_id, actor_uid, actor_role, occurred_at,
        payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'acknowledged',
        'lab_critical_alerts', $3::text, 'critical_lab_alert', $3::text,
        $4::uuid, 'LAB_STAFF', $5::timestamptz,
         jsonb_build_object(
           'alert_id', $3::integer,
           'result_id', $6::integer,
           'acknowledgement_authorization', 'role',
           'read_back_method', $7::text
         ) || CASE WHEN $8::integer IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('ack_contract_version', $8::integer)
              END,
        ARRAY['lab', 'critical']::text[],
        'lab_critical_alerts:' || $3::text || ':acknowledged')`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.alertId,
      FIXTURE.actorUid,
      FIXTURE.acknowledgedAt,
      FIXTURE.resultId,
      readBackMethod,
      ackContractVersion,
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
          'read_back_method', $7::text
        ) || CASE WHEN $6::integer IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('ack_contract_version', $6::integer)
             END,
        CASE WHEN $6::integer IS NULL THEN '{}'::jsonb
             ELSE jsonb_build_object('ack_contract_version', $6::integer)
        END,
        'lab_critical_alerts:' || $4::text || ':audit:acknowledged',
        $5::timestamptz)`,
    [
      FIXTURE.tenantId,
      FIXTURE.patientUid,
      FIXTURE.actorUid,
      FIXTURE.alertId,
      FIXTURE.acknowledgedAt,
      ackContractVersion,
      readBackMethod,
    ],
  );
}

async function seedLegacyReceipt(
  client,
  {
    critical = false,
    includeResult = true,
    includeAggregateEvidence = true,
    obligation = 'none',
    readBackMethod = 'verbal_readback',
    acknowledgementCommentCount = 2,
    ackContractVersion = 2,
  } = {},
) {
  await seedClinicalSource(client);
  if (critical) {
    await client.query(
      `INSERT INTO lab_critical_thresholds
         (id, tenant_id, test_code, test_name, unit, critical_high, applies_to)
       VALUES ($1, $2::uuid, 'GLU', 'Glucose', 'mmol/L', 10, 'all')`,
      [FIXTURE.thresholdId, FIXTURE.tenantId],
    );
  }
  await client.query(
    `INSERT INTO lab_interface_messages
       (id, tenant_id, analyzer_id, analyzer_code, direction, protocol,
        message_type, raw_message, status, result_count, specimen_id,
        verdicts, processed_at, created_at)
     OVERRIDING SYSTEM VALUE
     VALUES
       ($1, $2::uuid, $3, 'ASTM-583', 'inbound', 'astm_e1394',
        'results', $4, 'ingested', 1, $5,
        jsonb_build_array(jsonb_build_object(
          'test_code', 'GLU',
          'decision', $6::text,
          'critical_band', $7::text
        )), $8::timestamptz, $9::timestamptz)`,
    [
      FIXTURE.messageId,
      FIXTURE.tenantId,
      FIXTURE.analyzerId,
      critical ? CRITICAL_ASTM : NORMAL_ASTM,
      FIXTURE.specimenId,
      critical ? 'critical' : 'auto_verify',
      critical ? 'high' : 'normal',
      FIXTURE.processedAt,
      FIXTURE.createdAt,
    ],
  );
  if (includeResult) {
    const rawResult = {
      test_code: 'GLU',
      value_text: critical ? '20' : '5.8',
      unit: 'mmol/L',
      reference_range: '3.9-6.1',
      abnormal_flag: critical ? 'H' : 'N',
      result_status: 'F',
    };
    await client.query(
      `INSERT INTO lab_results
         (id, tenant_id, patient_uid, test_code, test_name, value_text,
          value_numeric, unit, reference_range, abnormal_flag, status,
          is_critical, raw_obx, specimen_id, analyzer_id, received_at, updated_at)
       VALUES
         ($1, $2::uuid, $3::uuid, 'GLU', 'Glucose', $4::text, $5::numeric,
          'mmol/L', '3.9-6.1', $6::text, 'preliminary', $7::boolean,
          $8::text, $9, $10, $11::timestamptz, $11::timestamptz)`,
      [
        FIXTURE.resultId,
        FIXTURE.tenantId,
        FIXTURE.patientUid,
        critical ? '20' : '5.8',
        critical ? 20 : 5.8,
        critical ? 'H' : 'N',
        critical,
        JSON.stringify(rawResult),
        FIXTURE.specimenId,
        FIXTURE.analyzerId,
        FIXTURE.resultAt,
      ],
    );
  }
  if (includeAggregateEvidence) {
    await seedAggregateEvidence(client);
  }
  if (obligation !== 'none') {
    await seedCriticalObligation(client, {
      acknowledged: obligation === 'acknowledged',
      readBackMethod,
      ackContractVersion,
    });
  }
  if (obligation === 'acknowledged') {
    await seedAcknowledgementEvidence(client, {
      commentCount: acknowledgementCommentCount,
      readBackMethod,
      ackContractVersion,
    });
  }
}

async function seedRuntimeCriticalReceipt(client) {
  await seedClinicalSource(client);
  await client.query(
    `INSERT INTO lab_critical_thresholds
       (id, tenant_id, test_code, test_name, unit, critical_high, applies_to)
     VALUES ($1, $2::uuid, 'GLU', 'Glucose', 'mmol/L', 10, 'all')`,
    [FIXTURE.thresholdId, FIXTURE.tenantId],
  );
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO lab_interface_messages
         (id, tenant_id, analyzer_id, analyzer_code, direction, protocol,
          message_type, raw_message, status, created_at,
          ingest_contract_version, authenticated_actor_uid,
          authenticated_actor_roles, analyzer_binding_mode,
          analyzer_binding_identity, analyzer_sender_identity)
       OVERRIDING SYSTEM VALUE
       VALUES
         ($1, $2::uuid, $3, 'ASTM-583', 'inbound', 'astm_e1394',
          'results', $4, 'received', $5::timestamptz, 1, $6::uuid,
          ARRAY['LAB_STAFF']::text[], 'manual_import_actor', $6::text,
          'ANALYZER')`,
      [
        FIXTURE.messageId,
        FIXTURE.tenantId,
        FIXTURE.analyzerId,
        CRITICAL_ASTM,
        FIXTURE.createdAt,
        FIXTURE.actorUid,
      ],
    );
    const rawResult = {
      test_code: 'GLU',
      value_text: '20',
      unit: 'mmol/L',
      reference_range: '3.9-6.1',
      abnormal_flag: 'H',
      result_status: 'F',
    };
    await client.query(
      `INSERT INTO lab_results
         (id, tenant_id, patient_uid, test_code, test_name, value_text,
          value_numeric, unit, reference_range, abnormal_flag, status,
          is_critical, raw_obx, specimen_id, analyzer_id, received_at, updated_at,
          interface_message_id, interface_result_index)
       VALUES
         ($1, $2::uuid, $3::uuid, 'GLU', 'Glucose', '20', 20, 'mmol/L',
          '3.9-6.1', 'H', 'preliminary', TRUE, $4::text, $5, $6,
          $7::timestamptz, $7::timestamptz, $8, 1)`,
      [
        FIXTURE.resultId,
        FIXTURE.tenantId,
        FIXTURE.patientUid,
        JSON.stringify(rawResult),
        FIXTURE.specimenId,
        FIXTURE.analyzerId,
        FIXTURE.resultAt,
        FIXTURE.messageId,
      ],
    );
    const bindingEvidence = {
      authenticated_actor_uid: FIXTURE.actorUid,
      authenticated_actor_roles: ['LAB_STAFF'],
      analyzer_binding_mode: 'manual_import_actor',
      analyzer_binding_identity: FIXTURE.actorUid,
      analyzer_sender_identity: 'ANALYZER',
    };
    const resultEvidence = {
      interface_message_id: FIXTURE.messageId,
      interface_result_index: 1,
      specimen_id: FIXTURE.specimenId,
      threshold_assessment: CRITICAL_THRESHOLD_ASSESSMENT,
      autoverification_verdict: CRITICAL_VERDICT,
      ...bindingEvidence,
    };
    await client.query(
      `INSERT INTO clinical_timeline_events
         (tenant_id, patient_uid, event_type, event_subtype, event_status,
          source_table, source_id, resource_type, resource_id, actor_uid,
          actor_role, occurred_at, visible_to_patient, clinical_summary,
          payload, tags, idempotency_key)
       VALUES
         ($1::uuid, $2::uuid, 'lab.result_recorded', 'lab', 'preliminary',
          'lab_results', $3::text, 'lab_result', $3::text, $4::uuid,
          'LAB_STAFF', $5::timestamptz, FALSE, 'ASTM result recorded',
          $6::jsonb, ARRAY['lab', 'lab_result', 'astm']::text[],
          'lab_results:' || $3::text || ':lab.result_recorded:astm:' || $7::text)`,
      [
        FIXTURE.tenantId,
        FIXTURE.patientUid,
        FIXTURE.resultId,
        FIXTURE.actorUid,
        FIXTURE.resultAt,
        JSON.stringify(resultEvidence),
        FIXTURE.messageId,
      ],
    );
    await client.query(
      `INSERT INTO clinical_audit_events
         (tenant_id, patient_uid, action, actor_uid, actor_role, resource_type,
          resource_table, resource_id, after_state, metadata, idempotency_key,
          occurred_at)
       VALUES
         ($1::uuid, $2::uuid, 'lab.result_recorded', $3::uuid, 'LAB_STAFF',
          'lab_result', 'lab_results', $4::text,
          jsonb_build_object('status', 'preliminary'), $5::jsonb,
          'lab_results:' || $4::text || ':audit:lab.result_recorded:astm:' || $6::text,
          $7::timestamptz)`,
      [
        FIXTURE.tenantId,
        FIXTURE.patientUid,
        FIXTURE.actorUid,
        FIXTURE.resultId,
        JSON.stringify(resultEvidence),
        FIXTURE.messageId,
        FIXTURE.resultAt,
      ],
    );
    await seedAggregateEvidence(client);
    await client.query(
      `UPDATE clinical_timeline_events
          SET payload = $1::jsonb
        WHERE tenant_id = $2::uuid
          AND event_type = 'lab.analyzer_results_ingested'
          AND source_id = $3::text`,
      [JSON.stringify(bindingEvidence), FIXTURE.tenantId, FIXTURE.messageId],
    );
    await client.query(
      `UPDATE clinical_audit_events
          SET metadata = $1::jsonb
        WHERE tenant_id = $2::uuid
          AND action = 'lab.analyzer_results_ingested'
          AND resource_id = $3::text`,
      [JSON.stringify(bindingEvidence), FIXTURE.tenantId, FIXTURE.messageId],
    );
    await seedCriticalObligation(client);
    await client.query(
      `UPDATE lab_interface_messages
          SET status = 'ingested',
              result_count = 1,
              specimen_id = $1,
              verdicts = jsonb_build_array($2::jsonb),
              processed_at = $3::timestamptz
        WHERE tenant_id = $4::uuid AND id = $5`,
      [
        FIXTURE.specimenId,
        JSON.stringify(CRITICAL_VERDICT),
        FIXTURE.processedAt,
        FIXTURE.tenantId,
        FIXTURE.messageId,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function closeCriticalObligation(client, { readBackMethod = 'verbal_readback' } = {}) {
  await client.query(
    `UPDATE lab_critical_alerts
        SET acknowledged_at = $1::timestamptz,
            acknowledged_by = $2::uuid,
            read_back_method = $5::text
      WHERE tenant_id = $3::uuid AND id = $4`,
    [
      FIXTURE.acknowledgedAt,
      FIXTURE.actorUid,
      FIXTURE.tenantId,
      FIXTURE.alertId,
      readBackMethod,
    ],
  );
  await client.query(
    `UPDATE tasks
        SET status = 'in_progress',
            metadata = metadata || jsonb_build_object(
              'acknowledged_by', $1::text,
              'acknowledged_via', 'role',
              'acknowledged_at', $2::text,
              'ack_contract_version', 2
            )
      WHERE tenant_id = $3::uuid AND id = $4`,
    [
      FIXTURE.actorUid,
      FIXTURE.acknowledgedAt,
      FIXTURE.tenantId,
      FIXTURE.taskId,
    ],
  );
  await client.query(
    `UPDATE workflow_sla_instances
        SET status = 'completed',
            completed_at = $1::timestamptz,
            metadata = metadata || jsonb_build_object(
              'completed_via', 'task_ack',
              'completed_by_task', $2::text,
              'completed_by', $3::text,
              'ack_contract_version', 2
            )
      WHERE tenant_id = $4::uuid AND id = $5::uuid`,
    [
      FIXTURE.acknowledgedAt,
      FIXTURE.taskId,
      FIXTURE.actorUid,
      FIXTURE.tenantId,
      FIXTURE.slaId,
    ],
  );
  await seedAcknowledgementEvidence(client, { readBackMethod });
}

async function clinicalSnapshot(client) {
  const snapshot = await client.query(
    `SELECT jsonb_build_object(
       'message', (
         SELECT to_jsonb(message)
           FROM lab_interface_messages AS message
          WHERE message.tenant_id = $1::uuid AND message.id = $2
       ),
       'result', (
         SELECT to_jsonb(result)
           FROM lab_results AS result
          WHERE result.tenant_id = $1::uuid AND result.id = $3
       ),
       'alert', (
         SELECT to_jsonb(alert)
           FROM lab_critical_alerts AS alert
          WHERE alert.tenant_id = $1::uuid AND alert.id = $4
       ),
       'task', (
         SELECT to_jsonb(task)
           FROM tasks AS task
          WHERE task.tenant_id = $1::uuid AND task.id = $5
       ),
       'sla', (
         SELECT to_jsonb(sla)
           FROM workflow_sla_instances AS sla
          WHERE sla.tenant_id = $1::uuid AND sla.id = $6::uuid
       ),
       'timeline', (
         SELECT jsonb_agg(to_jsonb(timeline) ORDER BY timeline.id)
           FROM clinical_timeline_events AS timeline
          WHERE timeline.tenant_id = $1::uuid
       ),
       'audit', (
         SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)
           FROM clinical_audit_events AS audit
          WHERE audit.tenant_id = $1::uuid
       )
     ) AS snapshot`,
    [
      FIXTURE.tenantId,
      FIXTURE.messageId,
      FIXTURE.resultId,
      FIXTURE.alertId,
      FIXTURE.taskId,
      FIXTURE.slaId,
    ],
  );
  return snapshot.rows[0].snapshot;
}

async function expectDeferredCommitFailure(client, mutate, expectedMessage) {
  await client.query('BEGIN');
  try {
    await mutate();
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
      message: expectedMessage,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

async function expectMigrationFailure(client, sql, expected) {
  await expect(client.query(sql)).rejects.toMatchObject(expected);
  await client.query('ROLLBACK');
}

describeIfDb('migration 583 ASTM atomic replay', () => {
  let client;
  let schemaName;
  let scopedMigration;

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    schemaName = `astm_mig_${randomUUID().replaceAll('-', '')}`;
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
      ALTER TABLE lab_interface_messages
        DROP CONSTRAINT IF EXISTS ck_lab_interface_astm_atomic_contract,
        DROP COLUMN IF EXISTS raw_message_sha256 CASCADE,
        DROP COLUMN IF EXISTS ingest_contract_version CASCADE,
        DROP COLUMN IF EXISTS astm_message_sha256 CASCADE,
        DROP COLUMN IF EXISTS authenticated_actor_uid CASCADE,
        DROP COLUMN IF EXISTS authenticated_actor_roles CASCADE,
        DROP COLUMN IF EXISTS analyzer_binding_mode CASCADE,
        DROP COLUMN IF EXISTS analyzer_binding_identity CASCADE,
        DROP COLUMN IF EXISTS analyzer_sender_identity CASCADE;
      ALTER TABLE lab_results
        DROP CONSTRAINT IF EXISTS ck_lab_results_interface_replay_identity_complete,
        DROP COLUMN IF EXISTS interface_message_id CASCADE,
        DROP COLUMN IF EXISTS interface_result_index CASCADE;
    `);
  });

  afterEach(async () => {
    if (client && schemaName) {
      await client.query('SET search_path TO public').catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
    }
    await client?.end();
  });

  test('installs cleanly, reruns, and canonicalizes CR/LF framing without changing raw evidence', async () => {
    await expect(client.query(scopedMigration)).resolves.toBeDefined();
    await expect(client.query(scopedMigration)).resolves.toBeDefined();

    const canonical = await client.query(`
      SELECT lab_astm_canonical_message(E'H|\\\\^&|||ANALYZER\rO|1|ACC||^^^GLU|R\rR|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F\rL|1|N') =
             lab_astm_canonical_message(E' H|\\\\^&|||ANALYZER \n O|1|ACC||^^^GLU|R\n R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F \n L|1|N ') AS same_semantics,
             encode(digest(E'raw-one', 'sha256'), 'hex') <>
             encode(digest(E'raw-two', 'sha256'), 'hex') AS raw_can_differ
    `);
    expect(canonical.rows[0]).toEqual({ same_semantics: true, raw_can_differ: true });

    const constraints = await client.query(`
      SELECT conname, contype, convalidated, condeferrable, condeferred
        FROM pg_constraint
       WHERE conrelid IN ('lab_interface_messages'::regclass, 'lab_results'::regclass)
         AND conname IN (
           'fk_lab_interface_astm_authenticated_actor',
           'ck_lab_results_interface_replay_identity_complete',
           'fk_lab_results_interface_message_tenant'
         )
       ORDER BY conname
    `);
    expect(constraints.rows).toEqual([
      {
        conname: 'ck_lab_results_interface_replay_identity_complete',
        contype: 'c',
        convalidated: true,
        condeferrable: false,
        condeferred: false,
      },
      {
        conname: 'fk_lab_interface_astm_authenticated_actor',
        contype: 'f',
        convalidated: true,
        condeferrable: true,
        condeferred: true,
      },
      {
        conname: 'fk_lab_results_interface_message_tenant',
        contype: 'f',
        convalidated: true,
        condeferrable: true,
        condeferred: true,
      },
    ]);
  });

  test('rejects duplicate parser-equivalent legacy receipts before installing the replay index', async () => {
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'astm-duplicate-fixture', 'ASTM Duplicate Fixture')`,
      [FIXTURE.tenantId],
    );
    await client.query(
      `INSERT INTO lab_interface_messages
         (id, tenant_id, analyzer_id, analyzer_code, direction, protocol,
          message_type, raw_message, status, error, processed_at, created_at)
       OVERRIDING SYSTEM VALUE
       VALUES
         (4201, $1::uuid, 2201, 'ASTM-DUP', 'inbound', 'astm_e1394',
          'results', $2, 'failed', 'fixture failure', $3::timestamptz,
          $4::timestamptz),
         (4202, $1::uuid, 2201, 'ASTM-DUP', 'inbound', 'astm_e1394',
          'results', $5, 'failed', 'fixture failure', $3::timestamptz,
          $4::timestamptz)`,
      [
        FIXTURE.tenantId,
        NORMAL_ASTM,
        FIXTURE.processedAt,
        FIXTURE.createdAt,
        NORMAL_ASTM.split('\r').map((record) => ` ${record} `).join('\n'),
      ],
    );

    await expectMigrationFailure(client, scopedMigration, {
      code: '23505',
      message: 'Cannot install ASTM replay identity: 1 duplicate raw-message group(s) exist',
    });

    const stillLegacy = await client.query(
      `SELECT COUNT(*)::integer AS row_count
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid`,
      [FIXTURE.tenantId],
    );
    expect(stillLegacy.rows[0].row_count).toBe(2);
  });

  test('adopts one exact legacy result and rejects a parser-equivalent replay', async () => {
    await seedLegacyReceipt(client);
    await client.query(scopedMigration);

    const adopted = await client.query(
      `SELECT message.ingest_contract_version,
              message.authenticated_actor_uid::text,
              message.authenticated_actor_roles,
              message.analyzer_binding_mode,
              message.analyzer_binding_identity,
              message.analyzer_sender_identity,
              result.interface_message_id,
              result.interface_result_index,
              result.booking_id,
              result.investigation_id,
              message.verdicts
         FROM lab_interface_messages AS message
         JOIN lab_results AS result
           ON result.tenant_id = message.tenant_id
          AND result.interface_message_id = message.id
        WHERE message.tenant_id = $1::uuid
          AND message.id = $2`,
      [FIXTURE.tenantId, FIXTURE.messageId],
    );
    expect(adopted.rows[0]).toEqual(
      expect.objectContaining({
        ingest_contract_version: 1,
        authenticated_actor_uid: FIXTURE.actorUid,
        authenticated_actor_roles: ['LAB_STAFF'],
        analyzer_binding_mode: 'manual_import_actor',
        analyzer_binding_identity: FIXTURE.actorUid,
        analyzer_sender_identity: 'ANALYZER',
        interface_message_id: FIXTURE.messageId,
        interface_result_index: 1,
        booking_id: null,
        investigation_id: null,
        verdicts: [
          expect.objectContaining({
            test_code: 'GLU',
            interface_result_index: 1,
            critical_threshold_matched: false,
            threshold_assessment: expect.objectContaining({
              matched: false,
              breached: false,
            }),
          }),
        ],
      }),
    );

    const canonical = await client.query(
      `SELECT COUNT(*) FILTER (
                WHERE event_type = 'lab.result_recorded'
                  AND payload->>'legacy_contract_adoption' = 'true'
              )::integer AS result_timeline_count,
              (SELECT COUNT(*)::integer
                 FROM clinical_audit_events
                WHERE tenant_id = $1::uuid
                  AND action = 'lab.result_recorded'
                  AND metadata->>'legacy_contract_adoption' = 'true')
                AS result_audit_count
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid`,
      [FIXTURE.tenantId],
    );
    expect(canonical.rows[0]).toEqual({
      result_timeline_count: 1,
      result_audit_count: 1,
    });

    const newlineReplay = NORMAL_ASTM.split('\r')
      .map((record) => ` ${record} `)
      .join('\n');
    await expect(
      client.query(
        `INSERT INTO lab_interface_messages
           (id, tenant_id, analyzer_id, analyzer_code, direction, protocol,
            message_type, raw_message, status, error, processed_at, created_at,
            ingest_contract_version, authenticated_actor_uid,
            authenticated_actor_roles, analyzer_binding_mode,
            analyzer_binding_identity, analyzer_sender_identity)
         OVERRIDING SYSTEM VALUE
         VALUES
           (4202, $1::uuid, $2, 'ASTM-583', 'inbound', 'astm_e1394',
            'results', $3, 'failed', 'replayed fixture', $4::timestamptz,
            $5::timestamptz, 1, $6::uuid, ARRAY['LAB_STAFF']::text[],
            'manual_import_actor', $6::text, 'ANALYZER')`,
        [
          FIXTURE.tenantId,
          FIXTURE.analyzerId,
          newlineReplay,
          FIXTURE.processedAt,
          FIXTURE.createdAt,
          FIXTURE.actorUid,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_lab_interface_astm_inbound_fingerprint',
    });
  });

  test('adopts a critical result only with one exact active alert/task/SLA obligation', async () => {
    await seedLegacyReceipt(client, { critical: true, obligation: 'active' });
    await client.query(scopedMigration);

    await expect(
      client.query(
        'SELECT lab_interface_assert_astm_ingested_complete($1::uuid, $2)',
        [FIXTURE.tenantId, FIXTURE.messageId],
      ),
    ).resolves.toBeDefined();

    await expectDeferredCommitFailure(
      client,
      async () => {
        await client.query(
          `DELETE FROM clinical_timeline_events
            WHERE tenant_id = $1::uuid
              AND event_type = 'lab.result_recorded'
              AND source_id = $2::text`,
          [FIXTURE.tenantId, FIXTURE.resultId],
        );
        await client.query(
          `UPDATE lab_interface_messages
              SET verdicts = verdicts
            WHERE tenant_id = $1::uuid AND id = $2`,
          [FIXTURE.tenantId, FIXTURE.messageId],
        );
      },
      `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a result without exact canonical timeline/audit evidence`,
    );
    const restoredCanonical = await client.query(
      `SELECT COUNT(*)::integer AS row_count
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND event_type = 'lab.result_recorded'
          AND source_id = $2::text`,
      [FIXTURE.tenantId, FIXTURE.resultId],
    );
    expect(restoredCanonical.rows[0].row_count).toBe(1);

    await expectDeferredCommitFailure(
      client,
      async () => {
        await client.query(
          `UPDATE tasks
              SET related_resource_id = 'detached-result'
            WHERE tenant_id = $1::uuid AND id = $2`,
          [FIXTURE.tenantId, FIXTURE.taskId],
        );
        await client.query(
          `UPDATE lab_interface_messages
              SET verdicts = verdicts
            WHERE tenant_id = $1::uuid AND id = $2`,
          [FIXTURE.tenantId, FIXTURE.messageId],
        );
      },
      `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    );
    const restoredTask = await client.query(
      `SELECT related_resource_id
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );
    expect(restoredTask.rows[0].related_resource_id).toBe(String(FIXTURE.resultId));

    await expect(
      client.query(
        `UPDATE lab_results
            SET specimen_id = NULL
          WHERE tenant_id = $1::uuid AND id = $2`,
        [FIXTURE.tenantId, FIXTURE.resultId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Result source binding for an ingested ASTM receipt is immutable',
    });

    await expect(
      client.query(
        `DELETE FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND id = $2`,
        [FIXTURE.tenantId, FIXTURE.alertId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Critical-alert evidence for an ingested ASTM result cannot be deleted',
    });
  });

  test('fails closed on an unreconciled legacy receipt and rolls back all schema changes', async () => {
    await seedLegacyReceipt(client, {
      includeResult: false,
      includeAggregateEvidence: false,
    });

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: 'Cannot install ASTM atomic replay: 1 ingested receipt(s) lack exact durable result evidence',
    });

    const rolledBackColumn = await client.query(
      `SELECT COUNT(*)::integer AS column_count
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'lab_results'
          AND column_name = 'interface_message_id'`,
      [schemaName],
    );
    expect(rolledBackColumn.rows[0].column_count).toBe(0);
  });

  test('fails closed on a critical legacy result with no alert/task/SLA rail and leaves no partial adoption', async () => {
    await seedLegacyReceipt(client, { critical: true });

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });

    const rollbackEvidence = await client.query(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'lab_results'
             AND column_name = 'interface_message_id') AS column_count,
         (SELECT COUNT(*)::integer
            FROM clinical_timeline_events
           WHERE tenant_id = $2::uuid
             AND event_type = 'lab.result_recorded') AS adopted_timeline_count,
         (SELECT COUNT(*)::integer
            FROM clinical_audit_events
           WHERE tenant_id = $2::uuid
             AND action = 'lab.result_recorded') AS adopted_audit_count`,
      [schemaName, FIXTURE.tenantId],
    );
    expect(rollbackEvidence.rows[0]).toEqual({
      column_count: 0,
      adopted_timeline_count: 0,
      adopted_audit_count: 0,
    });
  });

  test('rejects ambiguous legacy closed-acknowledgement evidence', async () => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
    });

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });

    const commentsRemainLegacy = await client.query(
      `SELECT COUNT(*)::integer AS row_count
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );
    expect(commentsRemainLegacy.rows[0].row_count).toBe(2);
  });

  test.each([
    { label: 'nonblank', readBackMethod: 'verbal_readback' },
    { label: 'explicit null', readBackMethod: null },
  ])('adopts one exact v2 legacy closed-acknowledgement proof with $label read-back', async ({
    readBackMethod,
  }) => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
      acknowledgementCommentCount: 1,
      readBackMethod,
      ackContractVersion: 2,
    });

    await expect(client.query(scopedMigration)).resolves.toBeDefined();

    const evidence = await client.query(
      `SELECT timeline.payload->'legacy_acknowledgement_proof' AS timeline_proof,
              audit.metadata->'legacy_acknowledgement_proof' AS audit_proof
         FROM clinical_timeline_events AS timeline
         JOIN clinical_audit_events AS audit
           ON audit.tenant_id = timeline.tenant_id
          AND audit.resource_table = 'lab_results'
          AND audit.resource_id = timeline.source_id
          AND audit.action = 'lab.result_recorded'
        WHERE timeline.tenant_id = $1::uuid
          AND timeline.source_table = 'lab_results'
          AND timeline.source_id = $2::text
          AND timeline.event_type = 'lab.result_recorded'
          AND timeline.payload->>'legacy_contract_adoption' = 'true'`,
      [FIXTURE.tenantId, FIXTURE.resultId],
    );
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0].audit_proof).toEqual(evidence.rows[0].timeline_proof);
    expect(evidence.rows[0].timeline_proof).toMatchObject({
      kind: 'migration_583_closed_critical_acknowledgement',
      alert_id: FIXTURE.alertId,
      task_id: FIXTURE.taskId,
      sla_instance_id: FIXTURE.slaId,
      comment_id: 7201,
      acknowledged_by: FIXTURE.actorUid,
      read_back_method: readBackMethod,
      acknowledgement_authorization: 'role',
      ack_contract_version: 2,
      canonical_timestamp_policy: 'acknowledgement_exact',
    });
    expect(new Date(evidence.rows[0].timeline_proof.acknowledged_at).toISOString())
      .toBe(FIXTURE.acknowledgedAt);
    expect(evidence.rows[0].timeline_proof.timeline_event_id).toBeTruthy();
    expect(evidence.rows[0].timeline_proof.audit_event_id).toBeTruthy();

    const beforeRerun = await clinicalSnapshot(client);
    await expect(client.query(scopedMigration)).resolves.toBeDefined();
    expect(await clinicalSnapshot(client)).toEqual(beforeRerun);
  });

  test('rejects a superseded receipt backfilled after an acknowledgement that predates the evidence boundary', async () => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
      acknowledgementCommentCount: 1,
      ackContractVersion: 2,
    });
    await client.query(scopedMigration);
    await client.query(
      `UPDATE tasks
          SET status = 'completed'
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );
    await client.query(
      `UPDATE lab_critical_alerts
          SET superseded_at = '2026-07-19T06:09:00.000Z'::timestamptz,
              superseded_by_alert_id = 7102,
              superseded_by_signoff_id = 9101
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    );
    await client.query(
      `INSERT INTO lab_critical_alert_acknowledgement_receipts
         (tenant_id, alert_id, result_id, patient_uid, generation_signoff_id,
          generation_state, acknowledgement_task_id, workflow_sla_instance_id,
          task_comment_id, timeline_event_id, audit_event_id, acknowledged_at,
          acknowledged_by, acknowledgement_authorization, read_back_method,
          task_status_at_ack, comment_from_status, sla_status_at_ack,
          sla_completed_at, sla_completed_via, sla_completed_by_task,
          sla_completed_by, override_source, override_id, override_reason_sha256,
          ack_contract_version, created_at)
       VALUES
         ($1::uuid, $2::int, $3::int, $4::uuid, NULL, 'critical', $5::int,
          $6::uuid, 7201,
          (SELECT id FROM clinical_timeline_events
            WHERE tenant_id = $1::uuid
              AND event_type = 'critical_result.acknowledged'),
          (SELECT id FROM clinical_audit_events
            WHERE tenant_id = $1::uuid
              AND action = 'critical_result.acknowledged'),
          $7::timestamptz, $8::uuid, 'role', 'verbal_readback', 'in_progress',
          'open', 'completed', $7::timestamptz, 'task_ack', $5::int, $8::uuid,
          NULL, NULL, NULL, 2, '2026-07-19T06:08:45.000Z'::timestamptz)`,
      [
        FIXTURE.tenantId,
        FIXTURE.alertId,
        FIXTURE.resultId,
        FIXTURE.patientUid,
        FIXTURE.taskId,
        FIXTURE.slaId,
        FIXTURE.acknowledgedAt,
        FIXTURE.actorUid,
      ],
    );

    const proofs = await client.query(
      `SELECT lab_astm_superseded_acknowledgement_proof(
                $1::uuid, $2::int, '2026-07-19T06:07:00.000Z'::timestamptz
              ) AS valid_proof,
              lab_astm_superseded_acknowledgement_proof(
                $1::uuid, $2::int, '2026-07-19T06:08:30.000Z'::timestamptz
              ) AS backfilled_proof`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    );
    expect(proofs.rows[0].valid_proof).toMatchObject({
      alert_id: FIXTURE.alertId,
      ack_contract_version: 2,
    });
    expect(proofs.rows[0].backfilled_proof).toBeNull();
  });

  test('rejects an unversioned legacy closed acknowledgement without minting v2 proof', async () => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
      acknowledgementCommentCount: 1,
      ackContractVersion: null,
    });

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });
  });

  test('rejects a legacy alert T1 plus task/SLA/comment T2 split', async () => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
      acknowledgementCommentCount: 1,
      ackContractVersion: 2,
    });
    await client.query(
      `UPDATE tasks
          SET metadata = jsonb_set(
                metadata,
                '{acknowledged_at}',
                to_jsonb($1::text)
              )
        WHERE tenant_id = $2::uuid AND id = $3`,
      [FIXTURE.processedAt, FIXTURE.tenantId, FIXTURE.taskId],
    );
    await client.query(
      `UPDATE workflow_sla_instances
          SET completed_at = $1::timestamptz
        WHERE tenant_id = $2::uuid AND id = $3::uuid`,
      [FIXTURE.processedAt, FIXTURE.tenantId, FIXTURE.slaId],
    );
    await client.query(
      `UPDATE task_comments
          SET metadata = jsonb_set(
                metadata,
                '{acknowledged_at}',
                to_jsonb($1::text)
              ),
              created_at = $1::timestamptz
        WHERE tenant_id = $2::uuid AND task_id = $3`,
      [FIXTURE.processedAt, FIXTURE.tenantId, FIXTURE.taskId],
    );

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });
  });

  test('rejects weak comment and canonical identity despite matching row counts', async () => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
      acknowledgementCommentCount: 1,
      ackContractVersion: 2,
    });
    await client.query(
      `UPDATE task_comments
          SET metadata = (metadata - 'from') || jsonb_build_object('via', 'admin')
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );
    await client.query(
      `UPDATE clinical_timeline_events
          SET event_status = 'entered-in-error',
              actor_uid = NULL,
              payload = (payload - 'alert_id' - 'result_id')
                || jsonb_build_object('acknowledgement_authorization', 'admin')
        WHERE tenant_id = $1::uuid
          AND event_type = 'critical_result.acknowledged'`,
      [FIXTURE.tenantId],
    );
    await client.query(
      `UPDATE clinical_audit_events
          SET action_status = 'failure', actor_uid = NULL
        WHERE tenant_id = $1::uuid
          AND action = 'critical_result.acknowledged'`,
      [FIXTURE.tenantId],
    );

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });
  });

  test.each([
    ['acknowledged_at', '2026-07-19T06:09:00.000Z'],
    ['acknowledged_by', '30000000-0000-4000-8000-000000000002'],
    ['read_back_method', 'telephone'],
  ])('rejects a v2 acknowledgement whose audit after-state has a different %s', async (
    field,
    value,
  ) => {
    await seedLegacyReceipt(client, {
      critical: true,
      obligation: 'acknowledged',
      acknowledgementCommentCount: 1,
      ackContractVersion: 2,
    });
    await client.query(
      `UPDATE clinical_audit_events
          SET after_state = jsonb_set(
                after_state,
                ARRAY[$1::text],
                $2::jsonb,
                TRUE
              )
        WHERE tenant_id = $3::uuid
          AND action = 'critical_result.acknowledged'`,
      [field, JSON.stringify(value), FIXTURE.tenantId],
    );

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });
  });

  test('does not treat an in-progress task as an active unacknowledged critical obligation', async () => {
    await seedLegacyReceipt(client, { critical: true, obligation: 'active' });
    await client.query(
      `UPDATE tasks
          SET status = 'in_progress'
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );

    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message: `ASTM ingested receipt ${FIXTURE.tenantId}/${FIXTURE.messageId} has a critical result without one exact actionable task/SLA obligation`,
    });

    const preservedTask = await client.query(
      `SELECT status
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.taskId],
    );
    expect(preservedTask.rows[0].status).toBe('in_progress');
  });

  test('reruns after normal actor, analyzer, source, and critical-obligation lifecycle changes without mutating evidence', async () => {
    await client.query(scopedMigration);
    await seedRuntimeCriticalReceipt(client);
    await closeCriticalObligation(client);
    await client.query(
      `UPDATE lab_analyzers
          SET status = 'retired'
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.analyzerId],
    );
    await client.query(
      `UPDATE users
          SET is_active = FALSE, status = 'inactive', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [FIXTURE.tenantId, FIXTURE.actorUid],
    );
    await client.query(
      `UPDATE lab_specimens
          SET status = 'disposed', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2`,
      [FIXTURE.tenantId, FIXTURE.specimenId],
    );
    const beforeRerun = await clinicalSnapshot(client);

    await expect(client.query(scopedMigration)).resolves.toBeDefined();

    expect(await clinicalSnapshot(client)).toEqual(beforeRerun);
  });

  test('accepts an authoritative closed acknowledgement with an explicit null read-back method', async () => {
    await client.query(scopedMigration);
    await seedRuntimeCriticalReceipt(client);
    await closeCriticalObligation(client, { readBackMethod: null });

    const acknowledgement = await client.query(
      `SELECT alert.read_back_method,
              timeline.payload ? 'read_back_method' AS has_read_back_method,
              timeline.payload->>'read_back_method' AS evidenced_read_back_method
         FROM lab_critical_alerts AS alert
         JOIN clinical_timeline_events AS timeline
           ON timeline.tenant_id = alert.tenant_id
          AND timeline.source_table = 'lab_critical_alerts'
          AND timeline.source_id = alert.id::text
          AND timeline.event_type = 'critical_result.acknowledged'
        WHERE alert.tenant_id = $1::uuid AND alert.id = $2`,
      [FIXTURE.tenantId, FIXTURE.alertId],
    );
    expect(acknowledgement.rows).toEqual([{
      read_back_method: null,
      has_read_back_method: true,
      evidenced_read_back_method: null,
    }]);

    const beforeRerun = await clinicalSnapshot(client);
    await expect(client.query(scopedMigration)).resolves.toBeDefined();
    expect(await clinicalSnapshot(client)).toEqual(beforeRerun);
  });

  test('permits only an exact in-transaction retry of a failed contract-v1 receipt', async () => {
    await client.query(scopedMigration);
    await seedClinicalSource(client);
    await expect(
      client.query(
        `INSERT INTO lab_interface_messages
           (id, tenant_id, analyzer_id, analyzer_code, direction, protocol,
            message_type, raw_message, status, error, processed_at, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES
           (4200, $1::uuid, $2, 'ASTM-583', 'inbound', 'astm_e1394',
            'results', $3, 'failed', 'old writer fixture', $4::timestamptz,
            $5::timestamptz)`,
        [
          FIXTURE.tenantId,
          FIXTURE.analyzerId,
          CRITICAL_ASTM,
          FIXTURE.processedAt,
          FIXTURE.createdAt,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ck_lab_interface_astm_atomic_contract',
    });
    const rejectedOldWriter = await client.query(
      `SELECT COUNT(*)::integer AS row_count
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid AND id = 4200`,
      [FIXTURE.tenantId],
    );
    expect(rejectedOldWriter.rows[0].row_count).toBe(0);

    await client.query(
      `INSERT INTO lab_interface_messages
         (id, tenant_id, analyzer_id, analyzer_code, direction, protocol,
          message_type, raw_message, status, error, processed_at, created_at,
          ingest_contract_version, authenticated_actor_uid,
          authenticated_actor_roles, analyzer_binding_mode,
          analyzer_binding_identity, analyzer_sender_identity)
       OVERRIDING SYSTEM VALUE
       VALUES
         (4201, $1::uuid, $2, 'ASTM-583', 'inbound', 'astm_e1394',
          'results', $3, 'failed', 'fixture parse failure', $4::timestamptz,
          $5::timestamptz, 1, $6::uuid, ARRAY['LAB_STAFF']::text[],
          'manual_import_actor', $6::text, 'ANALYZER')`,
      [
        FIXTURE.tenantId,
        FIXTURE.analyzerId,
        NORMAL_ASTM,
        FIXTURE.processedAt,
        FIXTURE.createdAt,
        FIXTURE.actorUid,
      ],
    );

    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `UPDATE lab_interface_messages
              SET status = 'received', error = NULL, processed_at = NULL
            WHERE tenant_id = $1::uuid AND id = 4201`,
          [FIXTURE.tenantId],
        ),
      ).resolves.toBeDefined();
      const transient = await client.query(
        `SELECT status, error, processed_at
           FROM lab_interface_messages
          WHERE tenant_id = $1::uuid AND id = 4201`,
        [FIXTURE.tenantId],
      );
      expect(transient.rows[0]).toEqual({
        status: 'received',
        error: null,
        processed_at: null,
      });
    } finally {
      await client.query('ROLLBACK');
    }

    await expect(
      client.query(
        `UPDATE lab_interface_messages
            SET raw_message = raw_message || E'\\rC|1|mutated',
                status = 'received', error = NULL, processed_at = NULL
          WHERE tenant_id = $1::uuid AND id = 4201`,
        [FIXTURE.tenantId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'ASTM interface replay identity is immutable once assigned',
    });
    await expect(
      client.query(
        `DELETE FROM lab_interface_messages
          WHERE tenant_id = $1::uuid AND id = 4201`,
        [FIXTURE.tenantId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Terminal ASTM interface receipt is immutable',
    });
  });

  test.each([
    {
      label: 'actor foreign key',
      setup: `
        ALTER TABLE lab_interface_messages
          ADD COLUMN authenticated_actor_uid UUID;
        ALTER TABLE lab_interface_messages
          ADD CONSTRAINT fk_lab_interface_astm_authenticated_actor
          CHECK (authenticated_actor_uid IS NULL);
      `,
      message: 'fk_lab_interface_astm_authenticated_actor has an incompatible definition',
    },
    {
      label: 'result identity check',
      setup: `
        ALTER TABLE lab_results
          ADD COLUMN interface_message_id INTEGER,
          ADD COLUMN interface_result_index INTEGER;
        ALTER TABLE lab_results
          ADD CONSTRAINT ck_lab_results_interface_replay_identity_complete
          CHECK (interface_message_id IS NULL);
      `,
      message: 'ck_lab_results_interface_replay_identity_complete has an incompatible definition',
    },
    {
      label: 'result receipt foreign key',
      setup: `
        ALTER TABLE lab_results
          ADD COLUMN interface_message_id INTEGER,
          ADD COLUMN interface_result_index INTEGER;
        ALTER TABLE lab_results
          ADD CONSTRAINT fk_lab_results_interface_message_tenant
          CHECK (interface_message_id IS NULL);
      `,
      message: 'fk_lab_results_interface_message_tenant has an incompatible definition',
    },
  ])('rejects a same-name wrong-shape $label', async ({ setup, message }) => {
    await client.query(setup);
    await expectMigrationFailure(client, scopedMigration, {
      code: '23514',
      message,
    });
  });
});
