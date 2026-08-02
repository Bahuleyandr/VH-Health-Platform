import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from '../services/integrations/externalInterfaceRecoveryService.js';
import {
  I01_ORU_SEQUENCE_CONTRACT,
  I02_ASTM_SEQUENCE_CONTRACT,
  astmCanonicalMessage,
  i01DuplicateKey,
  i01SourceToken,
  i02DuplicateKey,
  i02SourceToken,
  ingestSequencedAstmRecovery,
  ingestSequencedOruRecovery,
} from '../services/integrations/externalLabRecoveryService.js';
import { sha256Utf8 } from '../services/integrations/externalVitalsRecoveryService.js';
import { listInboxTasks } from '../services/workflow/taskService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const ACTOR_UID = randomUUID();
const REVIEWER_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const ORU_ANALYZER = `C61C-ORU-${SUFFIX}`;
const ASTM_ANALYZER = `C61C-ASTM-${SUFFIX}`;
const ASTM_SENDER = `C61C-${SUFFIX}^Analyzer`;
const ORU_TEST_CODE = `C61CO${SUFFIX}`;
const ASTM_TEST_CODE = `C61CA${SUFFIX}`;
const ACCESSION = `C61C-ACC-${SUFFIX}`;
const OCCURRED_AT = '2026-07-29T07:00:00.000Z';
const RECEIVED_AT = '2026-07-29T07:00:09.000Z';
const POLICY = Object.freeze({
  policyVersion: 'c-d8-v1',
  policySignature: `c61c-${SUFFIX}`,
  retentionPolicy: 'clinical-lab-730d',
  retentionUntil: '2029-07-29T00:00:00.000Z',
});
const context = Object.freeze({
  actorUid: ACTOR_UID,
  actorRole: 'LAB_STAFF',
  actorRoles: ['LAB_STAFF'],
});

let patientId;
let astmAnalyzerId;
let specimenId;

function recoveryCommon({ family, offsetId, sourcePartition, sourceToken, duplicateKey }) {
  return {
    schema: family === 'I01' ? I01_ORU_SEQUENCE_CONTRACT : I02_ASTM_SEQUENCE_CONTRACT,
    interface_family: family,
    arrival_class: 'recovery_backlog',
    tenant_id: TENANT_ID,
    offset_id: offsetId,
    source_partition: sourcePartition,
    generation: 1,
    source_position: '11',
    source_token: sourceToken,
    predecessor_token: `${family.toLowerCase()}-token-10`,
    duplicate_key: duplicateKey,
    source_observed_at: OCCURRED_AT,
    source_received_at: RECEIVED_AT,
    clock_evidence: { source: 'synthetic_ntp', maximum_error_ms: 12 },
  };
}

async function offsetFor(family, sourcePartition) {
  const predecessorToken = `${family.toLowerCase()}-token-10`;
  return registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: family,
    sourcePartition,
    initialPosition: 10,
    initialToken: predecessorToken,
    retainedFromPosition: 10,
    retainedFromToken: predecessorToken,
    ...POLICY,
  });
}

async function authorize(offsetId, family, sourceToken) {
  return authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId,
    interfaceFamily: family,
    resumeCutoffPosition: 11,
    resumeCutoffToken: sourceToken,
  });
}

async function effectSnapshot() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM lab_results
         WHERE tenant_id = $1::uuid AND is_critical = TRUE) AS critical_results,
       (SELECT COUNT(*)::integer FROM tasks
         WHERE tenant_id = $1::uuid
           AND metadata->>'contract' = 'late_pending_only') AS pending_tasks,
       (SELECT COUNT(*)::integer FROM lab_critical_alerts
         WHERE tenant_id = $1::uuid) AS critical_alerts,
       (SELECT COUNT(*)::integer FROM workflow_sla_instances
         WHERE tenant_id = $1::uuid) AS slas,
       (SELECT COUNT(*)::integer FROM care_pathway_transition_events
         WHERE tenant_id = $1::uuid) AS pathway_transitions,
       (SELECT COUNT(*)::integer FROM notification_outbox
         WHERE tenant_id = $1::uuid) AS notifications`,
    TENANT_ID,
  );
  return rows[0];
}

async function expectGuardedFailure(statement, params = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [TENANT_ID]);
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

describeIfDb('C6.1-C I01/I02 constrained late laboratory recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-C laboratory recovery tenant')`,
      TENANT_ID,
      `c61c-lab-${SUFFIX.toLowerCase()}`,
    );
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5::text, 'C6.1-C patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $4::uuid, $6::text, 'C6.1-C lab actor', 'LAB_STAFF', TRUE, 'active', NOW()),
         ($3::uuid, $4::uuid, $7::text, 'C6.1-C duty doctor', 'DUTY_DOCTOR', TRUE, 'active', NOW())
       RETURNING uid::text, id`,
      PATIENT_UID,
      ACTOR_UID,
      REVIEWER_UID,
      TENANT_ID,
      `91${SUFFIX.slice(0, 10)}`,
      `92${SUFFIX.slice(0, 10)}`,
      `93${SUFFIX.slice(0, 10)}`,
    );
    patientId = Number(users.find(row => row.uid === PATIENT_UID).id);
    const analyzers = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzers
         (tenant_id, analyzer_code, display_name, interface_kind, status, metadata)
       VALUES
         ($1::uuid, $2::text, 'C6.1-C ORU analyzer', 'hl7', 'active',
          jsonb_build_object('hl7_actor_uids', jsonb_build_array($4::text))),
         ($1::uuid, $3::text, 'C6.1-C ASTM analyzer', 'astm', 'active',
          jsonb_build_object(
            'astm_sender_aliases', jsonb_build_array($5::text),
            'astm_manual_import_actor_uids', jsonb_build_array($4::text)))
       RETURNING id, analyzer_code`,
      TENANT_ID,
      ORU_ANALYZER,
      ASTM_ANALYZER,
      ACTOR_UID,
      ASTM_SENDER,
    );
    astmAnalyzerId = Number(analyzers.find(row => row.analyzer_code === ASTM_ANALYZER).id);
    const specimens = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, accession_number, specimen_type,
          priority, status, collected_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'blood', 'stat', 'collected',
               $4::timestamptz)
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      ACCESSION,
      OCCURRED_AT,
    );
    specimenId = Number(specimens[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, unit, critical_low, critical_high,
          applies_to, is_active, source)
       VALUES
         ($1::uuid, $2::text, $2::text, 'mmol/L', 0, 10, 'all', TRUE, 'c61c-test'),
         ($1::uuid, $3::text, $3::text, 'mmol/L', 0, 10, 'all', TRUE, 'c61c-test')`,
      TENANT_ID,
      ORU_TEST_CODE,
      ASTM_TEST_CODE,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists a late critical I01 result and actionable no-SLA inbox task', async () => {
    const controlId = `C61C-ORU-${SUFFIX}`;
    const message = [
      `MSH|^~\\&|${ORU_ANALYZER}|LAB|VH|VH|20260729123009+0530||ORU^R01|${controlId}|P|2.5`,
      `PID|1||${PATIENT_UID}||Recovery^Patient`,
      `OBR|1|||${ORU_TEST_CODE}^Recovered critical|||20260729123000+0530`,
      `OBX|1|NM|${ORU_TEST_CODE}^Recovered critical||99|mmol/L|0-10|H|||F`,
    ].join('\r');
    const sourcePartition = `i01/sender/${sha256Utf8(ORU_ANALYZER.toLowerCase()).slice(0, 32)}`;
    const offset = await offsetFor('I01', sourcePartition);
    const duplicateKey = i01DuplicateKey({
      tenantId: TENANT_ID,
      trustedSenderIdentity: ORU_ANALYZER,
      messageControlId: controlId,
    });
    const sourceToken = i01SourceToken({
      tenantId: TENANT_ID,
      sourcePartition,
      generation: 1,
      sourcePosition: '11',
      predecessorToken: 'i01-token-10',
      duplicateKey,
      payloadSha256: sha256Utf8(message),
    });
    await authorize(offset.offset_id, 'I01', sourceToken);
    const recovery = {
      ...recoveryCommon({
        family: 'I01',
        offsetId: offset.offset_id,
        sourcePartition,
        sourceToken,
        duplicateKey,
      }),
      trusted_sender_identity: ORU_ANALYZER,
      message_control_id: controlId,
      message_sha256: sha256Utf8(message),
    };

    const outcome = await ingestSequencedOruRecovery({
      tenantId: TENANT_ID,
      message,
      recovery,
    }, context);
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i01_lab_results_pending_review',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT receipt.id AS message_id, receipt.recovery_inbox_id::text,
              receipt.recovery_interface_family,
              receipt.recovery_pending_task_id,
              receipt.message_sha256,
              receipt.critical_result_ids,
              result.id AS result_id, result.is_critical, result.performed_at,
              task.task_kind, task.priority, task.status AS task_status,
              task.assigned_to_role, task.workflow_sla_instance_id,
              task.sla_completion_semantics, task.due_at, task.metadata
         FROM lab_oru_ingest_messages AS receipt
         JOIN lab_results AS result
           ON result.tenant_id = receipt.tenant_id
          AND result.oru_ingest_message_id = receipt.id
         JOIN tasks AS task
           ON task.tenant_id = receipt.tenant_id
          AND task.id = receipt.recovery_pending_task_id
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.message_control_id = $2::text`,
      TENANT_ID,
      controlId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recovery_inbox_id: outcome.inbox_id,
      recovery_interface_family: 'I01',
      message_sha256: sha256Utf8(message),
      result_id: Number(outcome.result_id),
      is_critical: true,
      task_kind: 'review',
      priority: 'critical',
      task_status: 'open',
      assigned_to_role: 'DUTY_DOCTOR',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      due_at: null,
    });
    expect(new Date(rows[0].performed_at).toISOString()).toBe(OCCURRED_AT);
    expect(rows[0].critical_result_ids.map(Number)).toEqual([Number(rows[0].result_id)]);
    expect(rows[0].metadata).toMatchObject({
      contract: 'late_pending_only',
      interface_family: 'I01',
      recovery_inbox_id: outcome.inbox_id,
      critical_result_ids: [Number(rows[0].result_id)],
      owner_reconciliation_required: true,
    });
    const inbox = await listInboxTasks({
      tenantId: TENANT_ID,
      assigneeUid: REVIEWER_UID,
      roles: ['DUTY_DOCTOR'],
      primaryRole: 'DUTY_DOCTOR',
      rawRole: 'DUTY_DOCTOR',
    });
    expect(inbox.tasks.map(task => Number(task.id)))
      .toContain(Number(rows[0].recovery_pending_task_id));
  }, 30_000);

  it('persists I02 with byte-identical ASTM identity and the same constrained contract', async () => {
    const message = [
      `H|\\^&|||${ASTM_SENDER}|||||||P|E1394-97|20260729`,
      'P|1',
      `O|1|${ACCESSION}||^^^${ASTM_TEST_CODE}|R`,
      `R|1|^^^${ASTM_TEST_CODE}|99|mmol/L|0^10|H||F`,
      'L|1|N',
    ].join('\r');
    const sourcePartition = `i02/analyzer/${astmAnalyzerId}`;
    const offset = await offsetFor('I02', sourcePartition);
    const astmMessageSha256 = sha256Utf8(astmCanonicalMessage(message));
    const duplicateKey = i02DuplicateKey({
      tenantId: TENANT_ID,
      analyzerId: astmAnalyzerId,
      astmMessageSha256,
    });
    const sourceToken = i02SourceToken({
      tenantId: TENANT_ID,
      sourcePartition,
      generation: 1,
      sourcePosition: '11',
      predecessorToken: 'i02-token-10',
      duplicateKey,
      payloadSha256: astmMessageSha256,
    });
    await authorize(offset.offset_id, 'I02', sourceToken);
    const recovery = {
      ...recoveryCommon({
        family: 'I02',
        offsetId: offset.offset_id,
        sourcePartition,
        sourceToken,
        duplicateKey,
      }),
      analyzer_id: astmAnalyzerId,
      analyzer_code: ASTM_ANALYZER,
      analyzer_sender_identity: ASTM_SENDER,
      raw_message_sha256: sha256Utf8(message),
      astm_message_sha256: astmMessageSha256,
    };

    const outcome = await ingestSequencedAstmRecovery({
      tenantId: TENANT_ID,
      message,
      analyzerCode: ASTM_ANALYZER,
      recovery,
    }, context);
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i02_lab_results_pending_review',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT receipt.id AS message_id, receipt.recovery_inbox_id::text,
              receipt.recovery_interface_family,
              receipt.raw_message_sha256, receipt.astm_message_sha256,
              receipt.recovery_critical_result_ids,
              receipt.recovery_pending_task_id,
              lab_astm_canonical_message(receipt.raw_message) AS db_canonical_message,
              result.id AS result_id, result.is_critical, result.performed_at,
              result.specimen_id, task.priority, task.status AS task_status,
              task.workflow_sla_instance_id, task.sla_completion_semantics,
              task.due_at, task.metadata
         FROM lab_interface_messages AS receipt
         JOIN lab_results AS result
           ON result.tenant_id = receipt.tenant_id
          AND result.interface_message_id = receipt.id
         JOIN tasks AS task
           ON task.tenant_id = receipt.tenant_id
          AND task.id = receipt.recovery_pending_task_id
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.recovery_inbox_id = $2::uuid`,
      TENANT_ID,
      outcome.inbox_id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recovery_inbox_id: outcome.inbox_id,
      recovery_interface_family: 'I02',
      raw_message_sha256: sha256Utf8(message),
      astm_message_sha256: astmMessageSha256,
      result_id: Number(outcome.result_id),
      is_critical: true,
      specimen_id: specimenId,
      priority: 'critical',
      task_status: 'open',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      due_at: null,
      db_canonical_message: astmCanonicalMessage(message),
    });
    expect(new Date(rows[0].performed_at).toISOString()).toBe(OCCURRED_AT);
    expect(rows[0].recovery_critical_result_ids.map(Number))
      .toEqual([Number(rows[0].result_id)]);
    expect(rows[0].metadata).toMatchObject({
      contract: 'late_pending_only',
      interface_family: 'I02',
      critical_result_ids: [Number(rows[0].result_id)],
      owner_reconciliation_required: true,
    });

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await expect(client.query(
        'SELECT lab_interface_assert_astm_ingested_complete($1::uuid, $2::integer)',
        [TENANT_ID, Number(rows[0].message_id)],
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.end();
    }
  }, 30_000);

  it('allows pending-review task writes while migration 603 still blocks forbidden effects', async () => {
    expect(await effectSnapshot()).toEqual({
      critical_results: 2,
      pending_tasks: 2,
      critical_alerts: 0,
      slas: 0,
      pathway_transitions: 0,
      notifications: 0,
    });
    await expectGuardedFailure(
      'INSERT INTO workflow_sla_instances (tenant_id) VALUES ($1::uuid)',
      [TENANT_ID],
    );
    await expectGuardedFailure(
      'INSERT INTO care_pathway_transition_events (tenant_id) VALUES ($1::uuid)',
      [TENANT_ID],
    );
    await expectGuardedFailure(
      `INSERT INTO notification_outbox (tenant_id, type, title, body)
       VALUES ($1::uuid, 'push', 'blocked', 'blocked')`,
      [TENANT_ID],
    );
  });

  it('raw PostgreSQL rejects cross-family provenance and completed evidence mutation', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const receipts = await client.query(
        `SELECT id, recovery_inbox_id::text, recovery_pending_task_id
           FROM lab_oru_ingest_messages
          WHERE tenant_id = $1::uuid AND recovery_interface_family = 'I01'`,
        [TENANT_ID],
      );
      expect(receipts.rows).toHaveLength(1);
      await expect(client.query(
        `UPDATE lab_oru_ingest_messages
            SET recovery_interface_family = 'I02'
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        [TENANT_ID, receipts.rows[0].id],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(
        `UPDATE lab_interface_messages
            SET recovery_pending_task_id = recovery_pending_task_id + 1
          WHERE tenant_id = $1::uuid AND recovery_interface_family = 'I02'`,
        [TENANT_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});
