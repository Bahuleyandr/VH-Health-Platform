// Roadmap B3 — closed-loop lab deep round-trip.
//
// specimen label (Code 39 of the accession) → scan-on-receipt transition
// with history + canonical events → analyzer interface inbox: ASTM payload
// lands lab_results linked to the specimen with rules verdicts; unknown
// accessions fail closed and stay replayable in the inbox.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import prisma from '../lib/prisma.js';
import {
  acknowledgeAlert,
  signOffResults,
} from '../services/lab/labResultsService.js';
import { API_KEY, authClient } from './testClient.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const DB_CONFIGURED = !!DATABASE_URL;
const d = DB_CONFIGURED ? describe : describe.skip;
const ASTM_MIGRATION_SQL = readFileSync(
  new URL('../migrations/583_lab_astm_atomic_replay.sql', import.meta.url),
  'utf8',
);

const RUN = String(Date.now() % 100000).padStart(5, '0');
const ACCESSION = `B3TEST-ACC-${RUN}`;
const ANALYZER_CODE = `B3TEST-ANALYZER-${RUN}`;
const ASTM_SENDER = `B3TEST-${RUN}^Analyzer`;
const TEST_CODE = `B3GLU-${RUN}`;
const ROLLBACK_ACCESSION = `B3TEST-ROLLBACK-${RUN}`;
const ROLLBACK_TEST_CODE = `B3ROLLBACK-${RUN}`;
const CRITICAL_ACCESSION = `B3TEST-CRITICAL-${RUN}`;
const CRITICAL_TEST_CODE = `B3CRITICAL-${RUN}`;
const CORRECTED_ACCESSION = `B3TEST-CORRECTED-${RUN}`;
const CORRECTED_TEST_CODE = `B3CORRECTED-${RUN}`;
const PHONE = `+9199911${String(Date.now() % 10000).padStart(4, '0')}`;
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const TEST_ACTOR_UID = '550e8400-e29b-41d4-a716-446655440000';

let patientUid;
let patientId;
let specimenId;

const astmFor = (accession) => [
  `H|\\^&|||${ASTM_SENDER}|||||||P|E1394-97|20260610`,
  'P|1',
  `O|1|${accession}||^^^${TEST_CODE}|R`,
  `R|1|^^^${TEST_CODE}|5.8|mmol/L|3.9^6.1|N||F`,
  'L|1|N',
].join('\r');

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `UPDATE lab_analyzers
        SET status = 'retired', updated_at = NOW()
      WHERE analyzer_code LIKE 'B3TEST-ANALYZER-%'`,
  ).catch(() => {});
}

async function createOrderSource(testName) {
  const investigations = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, patient_id, patient_uid, phone, test_name, test_type,
        status, priority, requested_by, requested_at, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, 'blood',
             'REQUESTED', 'STAT', $6::uuid, NOW(), NOW())
     RETURNING id`,
    DEFAULT_TENANT,
    patientId,
    patientUid,
    PHONE,
    testName,
    TEST_ACTOR_UID,
  );
  const investigationId = Number(investigations[0].id);
  const bookings = await prisma.$queryRawUnsafe(
    `INSERT INTO investigation_bookings
       (tenant_id, patient_id, investigation_id, selected_tests, actual_tests,
        status, updated_at)
     VALUES ($1::uuid, $2::int, $3::int, '{}'::int[], '{}'::int[],
             'BOOKED', NOW())
     RETURNING id`,
    DEFAULT_TENANT,
    patientId,
    investigationId,
  );
  return {
    investigationId,
    bookingId: Number(bookings[0].id),
  };
}

async function astmCorrectionSnapshot({ messageId, resultId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT jsonb_build_object(
       'message', (
         SELECT to_jsonb(message)
           FROM lab_interface_messages AS message
          WHERE message.tenant_id = $1::uuid AND message.id = $2::int
       ),
       'result', (
         SELECT to_jsonb(result)
           FROM lab_results AS result
          WHERE result.tenant_id = $1::uuid AND result.id = $3::int
       ),
       'alerts', (
         SELECT jsonb_agg(to_jsonb(alert) ORDER BY alert.id)
           FROM lab_critical_alerts AS alert
          WHERE alert.tenant_id = $1::uuid AND alert.result_id = $3::int
       ),
       'tasks', (
         SELECT jsonb_agg(to_jsonb(task) ORDER BY task.id)
           FROM tasks AS task
          WHERE task.tenant_id = $1::uuid
            AND task.related_resource_type = 'lab_result'
            AND task.related_resource_id = $3::text
       ),
       'slas', (
         SELECT jsonb_agg(to_jsonb(sla) ORDER BY sla.id)
           FROM workflow_sla_instances AS sla
          WHERE sla.tenant_id = $1::uuid
            AND sla.rule_code = 'critical_result_ack'
            AND sla.source_table = 'lab_result'
            AND sla.source_id = $3::text
       ),
       'signoffs', (
         SELECT jsonb_agg(to_jsonb(signoff) ORDER BY signoff.id)
           FROM lab_pathologist_signoffs AS signoff
          WHERE signoff.tenant_id = $1::uuid
            AND $3::int = ANY(signoff.result_ids)
       ),
       'timeline', (
         SELECT jsonb_agg(to_jsonb(timeline) ORDER BY timeline.id)
           FROM clinical_timeline_events AS timeline
          WHERE timeline.tenant_id = $1::uuid
            AND (
              (timeline.source_table = 'lab_interface_messages'
                AND timeline.source_id = $2::text)
              OR (timeline.source_table = 'lab_results'
                AND timeline.source_id = $3::text)
              OR (timeline.source_table = 'lab_pathologist_signoffs'
                AND timeline.source_id IN (
                  SELECT signoff.id::text
                    FROM lab_pathologist_signoffs AS signoff
                   WHERE signoff.tenant_id = $1::uuid
                     AND $3::int = ANY(signoff.result_ids)
                ))
              OR (timeline.source_table = 'lab_critical_alerts'
                AND timeline.source_id IN (
                  SELECT alert.id::text
                    FROM lab_critical_alerts AS alert
                   WHERE alert.tenant_id = $1::uuid
                     AND alert.result_id = $3::int
                ))
            )
       ),
       'audit', (
         SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)
           FROM clinical_audit_events AS audit
          WHERE audit.tenant_id = $1::uuid
            AND (
              (audit.resource_table = 'lab_interface_messages'
                AND audit.resource_id = $2::text)
              OR (audit.resource_table = 'lab_results'
                AND audit.resource_id = $3::text)
              OR (audit.resource_table = 'lab_pathologist_signoffs'
                AND audit.resource_id IN (
                  SELECT signoff.id::text
                    FROM lab_pathologist_signoffs AS signoff
                   WHERE signoff.tenant_id = $1::uuid
                     AND $3::int = ANY(signoff.result_ids)
                ))
              OR (audit.resource_table = 'lab_critical_alerts'
                AND audit.resource_id IN (
                  SELECT alert.id::text
                    FROM lab_critical_alerts AS alert
                   WHERE alert.tenant_id = $1::uuid
                     AND alert.result_id = $3::int
                ))
            )
       )
     ) AS snapshot`,
    DEFAULT_TENANT,
    messageId,
    resultId,
  );
  return rows[0].snapshot;
}

async function rerunAstmMigrationWithoutMutation({ messageId, resultId }) {
  const before = await astmCorrectionSnapshot({ messageId, resultId });
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(ASTM_MIGRATION_SQL);
  } finally {
    await client.end();
  }
  const after = await astmCorrectionSnapshot({ messageId, resultId });
  expect(after).toEqual(before);
}

async function expectSplitCurrentTailRejected({ messageId, resultId }) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  try {
    const current = await client.query(
      `SELECT task.id AS task_id, task.workflow_sla_instance_id AS sla_id
         FROM lab_critical_alerts AS alert
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
        WHERE alert.tenant_id = $1::uuid
          AND alert.result_id = $2::int
          AND alert.superseded_at IS NULL`,
      [DEFAULT_TENANT, resultId],
    );
    expect(current.rows).toHaveLength(1);
    await client.query(
      `UPDATE tasks
          SET status = 'in_progress', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [DEFAULT_TENANT, current.rows[0].task_id],
    );
    await client.query(
      `UPDATE workflow_sla_instances
          SET status = 'completed', completed_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [DEFAULT_TENANT, current.rows[0].sla_id],
    );
    await expect(
      client.query(
        'SELECT lab_interface_assert_astm_ingested_complete($1::uuid, $2::int)',
        [DEFAULT_TENANT, messageId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining(
        'critical result without one exact actionable task/SLA obligation',
      ),
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function loadCriticalGenerationChain(resultId) {
  return prisma.$queryRawUnsafe(
    `SELECT alert.id,
            alert.value_text,
            alert.value_numeric,
            alert.unit,
            alert.superseded_at,
            alert.superseded_by_alert_id,
            alert.generation_signoff_id,
            alert.generation_metadata,
            alert.acknowledged_at,
            alert.read_back_method,
            task.id AS task_id,
            task.status AS task_status,
            sla.id AS sla_id,
            sla.status AS sla_status,
            sla.completed_at,
            result.value_text AS current_result_value_text,
            result.value_numeric AS current_result_value_numeric,
            result.is_critical AS current_result_is_critical
       FROM lab_critical_alerts AS alert
       JOIN lab_results AS result
         ON result.tenant_id = alert.tenant_id
        AND result.id = alert.result_id
       JOIN tasks AS task
         ON task.tenant_id = alert.tenant_id
        AND task.id = alert.acknowledgement_task_id
       JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE alert.tenant_id = $1::uuid
        AND alert.result_id = $2::int
      ORDER BY alert.id`,
    DEFAULT_TENANT,
    resultId,
  );
}

d('Closed-loop lab — deep round-trip (roadmap B3)', () => {
  beforeAll(async () => {
    await cleanup();
    const keyHash = createHash('sha256').update(`vhapi:${API_KEY}`).digest('hex');
    const apiClients = await prisma.$queryRawUnsafe(
      `SELECT client.id
         FROM api_keys AS key
         JOIN api_clients AS client
           ON client.tenant_id = key.tenant_id
          AND client.id = key.api_client_id
        WHERE key.key_hash = $1
          AND key.status = 'active'
          AND client.status = 'active'
          AND key.tenant_id = $2::uuid
        LIMIT 1`,
      keyHash,
      DEFAULT_TENANT,
    );
    const apiClientIds = apiClients[0] ? [String(apiClients[0].id)] : [];
    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_analyzers
         (tenant_id, analyzer_code, display_name, interface_kind, status, metadata)
       VALUES ($1::uuid, $2, 'B3TEST ASTM Analyzer', 'astm', 'active',
               jsonb_build_object(
                 'astm_sender_aliases', jsonb_build_array($3::text),
                 'astm_manual_import_actor_uids', jsonb_build_array($4::text),
                 'astm_api_client_ids', $5::jsonb
               ))
       ON CONFLICT (tenant_id, analyzer_code)
       DO UPDATE SET status = 'active', interface_kind = 'astm',
                     metadata = EXCLUDED.metadata, updated_at = NOW()`,
      DEFAULT_TENANT,
      ANALYZER_CODE,
      ASTM_SENDER,
      TEST_ACTOR_UID,
      JSON.stringify(apiClientIds),
    );
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'B3TEST Patient', 'PATIENT', true, NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, accession_number, specimen_type, priority, status, collected_at, collected_by)
       VALUES ($1::uuid, $2::uuid, $3, 'blood', 'routine', 'collected', NOW(), NULL)
       RETURNING id`,
      DEFAULT_TENANT, patientUid, ACCESSION,
    );
    specimenId = Number(s[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('specimen label issues the accession barcode with Code 39 SVG (JSON + HTML)', async () => {
    const res = await authClient('ADMIN').get(`/api/v1/lab/specimens/${specimenId}/label`);
    expect(res.status).toBe(200);
    expect(res.body.data.barcode).toBe(ACCESSION.toUpperCase());
    expect(res.body.data.svg).toContain('<svg');
    expect(res.body.data.patient.name).toBe('B3TEST Patient');

    const html = await authClient('ADMIN')
      .get(`/api/v1/lab/specimens/${specimenId}/label`)
      .query({ format: 'html' });
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain(ACCESSION);

    const row = await prisma.$queryRawUnsafe(
      `SELECT barcode, label_printed_at FROM lab_specimens WHERE id = $1`, specimenId,
    );
    expect(row[0].barcode).toBe(ACCESSION);
    expect(row[0].label_printed_at).toBeTruthy();
  });

  test('scan-on-receipt transitions collected → received once, with history + timeline', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/specimens/receive-scan')
      .send({ barcode: ACCESSION.toLowerCase() }); // case-insensitive scan
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('received');

    const again = await authClient('ADMIN')
      .post('/api/v1/lab/specimens/receive-scan')
      .send({ barcode: ACCESSION });
    expect(again.status).toBe(409);

    const history = await prisma.$queryRawUnsafe(
      `SELECT from_status, to_status FROM lab_specimen_status_history WHERE specimen_id = $1`,
      specimenId,
    );
    expect(history.some((h) => h.from_status === 'collected' && h.to_status === 'received')).toBe(true);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'lab_specimens' AND source_id = $1`,
      String(specimenId),
    );
    expect(timeline.map((t) => t.event_type)).toContain('lab.specimen_received');
  });

  test('unknown barcode fails closed', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/specimens/receive-scan')
      .send({ barcode: 'B3TEST-DOES-NOT-EXIST' });
    expect(res.status).toBe(404);
  });

  test('ASTM ingest: results land linked to the specimen with rules verdicts', async () => {
    const raw = astmFor(ACCESSION);
    const [crResponse, lfResponse] = await Promise.all([
      authClient('ADMIN')
        .post('/api/v1/lab/interface/ingest')
        .send({ protocol: 'astm_e1394', analyzer_code: ANALYZER_CODE, message: raw }),
      authClient('ADMIN')
        .post('/api/v1/lab/interface/ingest')
        .send({
          protocol: 'astm_e1394',
          analyzer_code: ANALYZER_CODE,
          message: raw.replaceAll('\r', '\n'),
        }),
    ]);
    expect([crResponse.status, lfResponse.status]).toEqual([200, 200]);
    expect(crResponse.body.data.message_id).toBe(lfResponse.body.data.message_id);
    expect(crResponse.body.data.results).toEqual(lfResponse.body.data.results);
    expect([crResponse.body.data.replayed, lfResponse.body.data.replayed].sort()).toEqual([
      false,
      true,
    ]);

    const exactReplay = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'astm_e1394', analyzer_code: ANALYZER_CODE, message: raw });
    expect(exactReplay.status).toBe(200);
    expect(exactReplay.body.data).toMatchObject({
      message_id: crResponse.body.data.message_id,
      status: 'ingested',
      replayed: true,
      results: crResponse.body.data.results,
    });
    expect(exactReplay.body.data.verdicts).toHaveLength(1);
    for (const verdict of exactReplay.body.data.verdicts) {
      expect(['auto_verify', 'hold_for_review', 'critical']).toContain(verdict.decision);
    }

    const results = await prisma.$queryRawUnsafe(
      `SELECT test_code, specimen_id, patient_uid, value_numeric FROM lab_results
        WHERE specimen_id = $1 ORDER BY test_code`,
      specimenId,
    );
    expect(results).toHaveLength(1);
    expect(results.map((r) => r.test_code)).toEqual([TEST_CODE]);
    expect(results[0].patient_uid).toBe(patientUid);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, result_count, specimen_id, verdicts FROM lab_interface_messages
        WHERE raw_message LIKE '%${ACCESSION}%' ORDER BY id DESC LIMIT 1`,
    );
    expect(inbox[0].status).toBe('ingested');
    expect(Number(inbox[0].result_count)).toBe(1);
    expect(Number(inbox[0].specimen_id)).toBe(specimenId);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE event_type = 'lab.analyzer_results_ingested' AND patient_uid = $1::uuid`,
      patientUid,
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);

    const receiptCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid
          AND analyzer_code = $2
          AND astm_message_sha256 = encode(
                digest(lab_astm_canonical_message($3::text), 'sha256'),
                'hex'
              )`,
      DEFAULT_TENANT,
      ANALYZER_CODE,
      raw,
    );
    expect(receiptCount[0].count).toBe(1);
  });

  test('canonical failure rolls back clinical artifacts, preserves one failed receipt, and exact retry reuses it', async () => {
    const specimenRows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, accession_number, specimen_type, priority, status,
          collected_at, received_at)
       VALUES ($1::uuid, $2::uuid, $3, 'blood', 'routine', 'received', NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT,
      patientUid,
      ROLLBACK_ACCESSION,
    );
    const rollbackSpecimenId = Number(specimenRows[0].id);
    const raw = [
      `H|\\^&|||${ASTM_SENDER}`,
      `O|1|${ROLLBACK_ACCESSION}||^^^${ROLLBACK_TEST_CODE}|R`,
      `R|1|^^^${ROLLBACK_TEST_CODE}|5.8|mmol/L|3.9^6.1|N||F`,
      'L|1|N',
    ].join('\r');
    const triggerName = `trg_astm_b3_fail_${RUN}`;
    const functionName = `astm_b3_fail_${RUN}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${functionName}()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.event_type = 'lab.result_recorded'
           AND NEW.payload->>'test_code' = '${ROLLBACK_TEST_CODE}' THEN
          RAISE EXCEPTION 'B3 forced canonical rollback';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON clinical_timeline_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);

    let failed;
    try {
      failed = await authClient('ADMIN')
        .post('/api/v1/lab/interface/ingest')
        .send({ protocol: 'astm_e1394', analyzer_code: ANALYZER_CODE, message: raw });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${triggerName} ON clinical_timeline_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`);
    }
    expect(failed.status).toBe(500);

    const failedReceipts = await prisma.$queryRawUnsafe(
      `SELECT id, status, error, result_count, specimen_id, verdicts, processed_at
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid
          AND analyzer_code = $2
          AND astm_message_sha256 = encode(
                digest(lab_astm_canonical_message($3::text), 'sha256'),
                'hex'
              )`,
      DEFAULT_TENANT,
      ANALYZER_CODE,
      raw,
    );
    expect(failedReceipts).toHaveLength(1);
    expect(failedReceipts[0]).toMatchObject({
      status: 'failed',
      result_count: null,
      specimen_id: null,
      verdicts: null,
    });
    expect(failedReceipts[0].error).toContain('B3 forced canonical rollback');
    expect(failedReceipts[0].processed_at).toBeTruthy();
    const failedMessageId = Number(failedReceipts[0].id);

    const partialArtifacts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM lab_results
           WHERE tenant_id = $1::uuid AND interface_message_id = $2::int) AS results,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND payload->>'interface_message_id' = $2::text) AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND metadata->>'interface_message_id' = $2::text) AS audit`,
      DEFAULT_TENANT,
      failedMessageId,
    );
    expect(partialArtifacts[0]).toEqual({ results: 0, timeline: 0, audit: 0 });

    const retry = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'astm_e1394', analyzer_code: ANALYZER_CODE, message: raw });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({
      message_id: failedMessageId,
      status: 'ingested',
      replayed: false,
      specimen_id: rollbackSpecimenId,
    });
    expect(retry.body.data.results).toHaveLength(1);

    const completedReceipt = await prisma.$queryRawUnsafe(
      `SELECT status, error, result_count, specimen_id
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT,
      failedMessageId,
    );
    expect(completedReceipt[0]).toEqual({
      status: 'ingested',
      error: null,
      result_count: 1,
      specimen_id: rollbackSpecimenId,
    });
  });

  test('critical ASTM result atomically binds threshold, alert, task, SLA, and canonical provenance', async () => {
    const thresholdRows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, unit, critical_high, applies_to,
          is_active, source)
       VALUES ($1::uuid, $2, 'B3 critical analyte', 'mmol/L', 5.0000,
               'all', TRUE, 'test')
       RETURNING id`,
      DEFAULT_TENANT,
      CRITICAL_TEST_CODE,
    );
    const thresholdId = Number(thresholdRows[0].id);
    const specimenRows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, accession_number, specimen_type, priority, status,
          collected_at, received_at)
       VALUES ($1::uuid, $2::uuid, $3, 'blood', 'urgent', 'received', NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT,
      patientUid,
      CRITICAL_ACCESSION,
    );
    const criticalSpecimenId = Number(specimenRows[0].id);
    const raw = [
      `H|\\^&|||${ASTM_SENDER}`,
      `O|1|${CRITICAL_ACCESSION}||^^^${CRITICAL_TEST_CODE}|R`,
      `R|1|^^^${CRITICAL_TEST_CODE}|5.8|mmol/L|3.9^5.0|H||F`,
      'L|1|N',
    ].join('\r');

    const response = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'astm_e1394', analyzer_code: ANALYZER_CODE, message: raw });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'ingested',
      replayed: false,
      specimen_id: criticalSpecimenId,
    });
    expect(response.body.data.verdicts).toHaveLength(1);
    expect(response.body.data.verdicts[0]).toMatchObject({
      interface_result_index: 1,
      test_code: CRITICAL_TEST_CODE,
      decision: 'critical',
      critical_threshold_matched: true,
      threshold_assessment: {
        matched: true,
        breached: true,
        threshold_id: thresholdId,
        threshold_test_code: CRITICAL_TEST_CODE,
        threshold_unit: 'mmol/L',
        threshold_applies_to: 'all',
        breached_side: 'high',
      },
    });

    const messageId = Number(response.body.data.message_id);
    const obligation = await prisma.$queryRawUnsafe(
      `SELECT result.id AS result_id,
              result.is_critical,
              alert.id AS alert_id,
              alert.threshold_breached,
              alert.threshold_value::text AS threshold_value,
              alert.acknowledged_at,
              task.id AS task_id,
              task.status AS task_status,
              task.assigned_to_uid,
              task.assigned_to_role,
              task.sla_completion_semantics,
              sla.id AS sla_id,
              sla.rule_code,
              sla.status AS sla_status,
              sla.completed_at,
              message.authenticated_actor_uid,
              message.authenticated_actor_roles,
              message.analyzer_binding_mode,
              message.analyzer_binding_identity,
              message.analyzer_sender_identity
         FROM lab_interface_messages AS message
         JOIN lab_results AS result
           ON result.tenant_id = message.tenant_id
          AND result.interface_message_id = message.id
         JOIN lab_critical_alerts AS alert
           ON alert.tenant_id = result.tenant_id
          AND alert.result_id = result.id
          AND alert.superseded_at IS NULL
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE message.tenant_id = $1::uuid
          AND message.id = $2::int`,
      DEFAULT_TENANT,
      messageId,
    );
    expect(obligation).toHaveLength(1);
    expect(obligation[0]).toMatchObject({
      is_critical: true,
      threshold_breached: 'high',
      threshold_value: '5.0000',
      acknowledged_at: null,
      task_status: 'open',
      sla_completion_semantics: 'acknowledgement',
      rule_code: 'critical_result_ack',
      sla_status: 'active',
      completed_at: null,
      authenticated_actor_uid: TEST_ACTOR_UID,
      authenticated_actor_roles: ['ADMIN'],
      analyzer_binding_mode: 'manual_import_actor',
      analyzer_binding_identity: TEST_ACTOR_UID,
      analyzer_sender_identity: ASTM_SENDER,
    });
    expect(
      obligation[0].assigned_to_uid || obligation[0].assigned_to_role,
    ).toBeTruthy();

    const canonical = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND event_type = 'lab.result_recorded'
             AND source_table = 'lab_results'
             AND source_id = $3::text
             AND payload->>'interface_message_id' = $2::text
             AND payload->'threshold_assessment'->>'threshold_id' = $4::text
             AND payload->>'authenticated_actor_uid' = $5::text
             AND payload->>'analyzer_sender_identity' = $6) AS result_timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND action = 'lab.result_recorded'
             AND resource_table = 'lab_results'
             AND resource_id = $3::text
             AND metadata->>'interface_message_id' = $2::text
             AND metadata->'threshold_assessment'->>'threshold_id' = $4::text
             AND metadata->>'authenticated_actor_uid' = $5::text
             AND metadata->>'analyzer_sender_identity' = $6) AS result_audit,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND event_type = 'lab.analyzer_results_ingested'
             AND source_table = 'lab_interface_messages'
             AND source_id = $2::text) AS aggregate_timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND action = 'lab.analyzer_results_ingested'
             AND resource_table = 'lab_interface_messages'
             AND resource_id = $2::text) AS aggregate_audit`,
      DEFAULT_TENANT,
      messageId,
      Number(obligation[0].result_id),
      thresholdId,
      TEST_ACTOR_UID,
      ASTM_SENDER,
    );
    expect(canonical[0]).toEqual({
      result_timeline: 1,
      result_audit: 1,
      aggregate_timeline: 1,
      aggregate_audit: 1,
    });
  });

  test('corrected ASTM generations retain one exact current obligation across migration reruns', async () => {
    const thresholdRows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, unit, critical_high, applies_to,
          is_active, source)
       VALUES ($1::uuid, $2, 'B3 corrected analyte', 'mmol/L', 5.0000,
               'all', TRUE, 'test')
       RETURNING id`,
      DEFAULT_TENANT,
      CORRECTED_TEST_CODE,
    );
    const thresholdId = Number(thresholdRows[0].id);
    const { bookingId } = await createOrderSource('B3 corrected analyte');
    const specimenRows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, booking_id, accession_number, specimen_type,
          priority, status, collected_at, received_at)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, 'blood', 'urgent',
               'received', NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT,
      patientUid,
      bookingId,
      CORRECTED_ACCESSION,
    );
    const correctedSpecimenId = Number(specimenRows[0].id);
    const raw = [
      `H|\\^&|||${ASTM_SENDER}`,
      `O|1|${CORRECTED_ACCESSION}||^^^${CORRECTED_TEST_CODE}|R`,
      `R|1|^^^${CORRECTED_TEST_CODE}|5.8|mmol/L|3.9^5.0|H||F`,
      'L|1|N',
    ].join('\r');
    const response = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'astm_e1394', analyzer_code: ANALYZER_CODE, message: raw });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'ingested',
      specimen_id: correctedSpecimenId,
      replayed: false,
    });
    const messageId = Number(response.body.data.message_id);
    const resultRows = await prisma.$queryRawUnsafe(
      `SELECT id, booking_id, investigation_id
         FROM lab_results
        WHERE tenant_id = $1::uuid AND interface_message_id = $2::int`,
      DEFAULT_TENANT,
      messageId,
    );
    expect(resultRows).toHaveLength(1);
    expect(Number(resultRows[0].booking_id)).toBe(bookingId);
    expect(resultRows[0].investigation_id).toBeTruthy();
    const resultId = Number(resultRows[0].id);

    let chain = await loadCriticalGenerationChain(resultId);
    expect(chain).toHaveLength(1);
    await acknowledgeAlert(chain[0].id, {
      tenantId: DEFAULT_TENANT,
      acknowledged_by: TEST_ACTOR_UID,
      acknowledged_by_name: 'B3TEST Administrator',
      actorRoles: ['ADMIN'],
      actorRole: 'ADMIN',
      read_back_method: 'phone',
    });
    chain = await loadCriticalGenerationChain(resultId);
    expect(chain[0]).toMatchObject({
      read_back_method: 'phone',
      task_status: 'in_progress',
      sla_status: 'completed',
    });
    expect(chain[0].acknowledged_at).toBeTruthy();
    expect(chain[0].completed_at).toEqual(chain[0].acknowledged_at);
    await rerunAstmMigrationWithoutMutation({ messageId, resultId });

    await prisma.$executeRawUnsafe(
      `UPDATE lab_results
          SET value_text = '7.4', value_numeric = 7.4, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT,
      resultId,
    );
    await signOffResults({
      tenantId: DEFAULT_TENANT,
      signed_off_by: TEST_ACTOR_UID,
      signed_off_by_role: 'ADMIN',
      signed_off_by_name: 'B3TEST Administrator',
      result_ids: [resultId],
      decision: 'corrected',
      booking_id: bookingId,
      patient_uid: patientUid,
    });
    chain = await loadCriticalGenerationChain(resultId);
    expect(chain).toHaveLength(2);
    expect(chain[0].superseded_by_alert_id).toBe(chain[1].id);
    expect(Number(chain[0].value_numeric)).toBe(5.8);
    expect(chain[1]).toMatchObject({
      value_text: '7.4',
      superseded_at: null,
      acknowledged_at: null,
      task_status: 'open',
      sla_status: 'active',
      completed_at: null,
      generation_metadata: {
        kind: 'corrected_result_generation',
        corrected_state: 'critical',
      },
      current_result_value_text: '7.4',
      current_result_is_critical: true,
    });
    expect(Number(chain[1].value_numeric)).toBe(7.4);
    expect(Number(chain[1].current_result_value_numeric)).toBe(7.4);
    const predecessorReceipts = await prisma.$queryRawUnsafe(
      `SELECT receipt.acknowledgement_task_id AS task_id,
              receipt.workflow_sla_instance_id AS sla_id,
              receipt.ack_contract_version,
              sla.metadata ? 'ack_contract_version' AS current_sla_has_ack_version
         FROM lab_critical_alert_acknowledgement_receipts AS receipt
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = receipt.tenant_id
          AND sla.id = receipt.workflow_sla_instance_id
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.alert_id = $2::int`,
      DEFAULT_TENANT,
      Number(chain[0].id),
    );
    expect(predecessorReceipts).toEqual([{
      task_id: Number(chain[0].task_id),
      sla_id: chain[0].sla_id,
      ack_contract_version: 2,
      current_sla_has_ack_version: false,
    }]);
    await rerunAstmMigrationWithoutMutation({ messageId, resultId });
    await expectSplitCurrentTailRejected({ messageId, resultId });

    await prisma.$executeRawUnsafe(
      `UPDATE lab_critical_thresholds
          SET critical_high = 10.0000, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT,
      thresholdId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results
          SET value_text = '4.0', value_numeric = 4.0, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT,
      resultId,
    );
    await signOffResults({
      tenantId: DEFAULT_TENANT,
      signed_off_by: TEST_ACTOR_UID,
      signed_off_by_role: 'ADMIN',
      signed_off_by_name: 'B3TEST Administrator',
      result_ids: [resultId],
      decision: 'amended',
      booking_id: bookingId,
      patient_uid: patientUid,
    });
    chain = await loadCriticalGenerationChain(resultId);
    expect(chain).toHaveLength(3);
    expect(chain[1].superseded_by_alert_id).toBe(chain[2].id);
    expect(chain[2]).toMatchObject({
      value_text: '4.0',
      superseded_at: null,
      acknowledged_at: null,
      task_status: 'open',
      sla_status: 'active',
      completed_at: null,
      generation_metadata: {
        kind: 'corrected_result_generation',
        corrected_state: 'within_active_critical_thresholds',
      },
      current_result_value_text: '4.0',
      current_result_is_critical: false,
    });
    expect(Number(chain[2].value_numeric)).toBe(4);
    expect(Number(chain[2].current_result_value_numeric)).toBe(4);
    await rerunAstmMigrationWithoutMutation({ messageId, resultId });

    await prisma.$executeRawUnsafe(
      `UPDATE lab_critical_thresholds
          SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT,
      thresholdId,
    );
    await signOffResults({
      tenantId: DEFAULT_TENANT,
      signed_off_by: TEST_ACTOR_UID,
      signed_off_by_role: 'ADMIN',
      signed_off_by_name: 'B3TEST Administrator',
      result_ids: [resultId],
      decision: 'corrected',
      booking_id: bookingId,
      patient_uid: patientUid,
    });
    chain = await loadCriticalGenerationChain(resultId);
    expect(chain).toHaveLength(4);
    expect(chain[2].superseded_by_alert_id).toBe(chain[3].id);
    expect(chain[3]).toMatchObject({
      superseded_at: null,
      acknowledged_at: null,
      task_status: 'open',
      sla_status: 'active',
      completed_at: null,
      generation_metadata: {
        kind: 'corrected_result_generation',
        corrected_state: 'threshold_unavailable',
      },
    });
    await rerunAstmMigrationWithoutMutation({ messageId, resultId });

    await acknowledgeAlert(chain[3].id, {
      tenantId: DEFAULT_TENANT,
      acknowledged_by: TEST_ACTOR_UID,
      acknowledged_by_name: 'B3TEST Administrator',
      actorRoles: ['ADMIN'],
      actorRole: 'ADMIN',
    });
    chain = await loadCriticalGenerationChain(resultId);
    expect(chain[3].acknowledged_at).toBeTruthy();
    expect(chain[3].read_back_method).toBeNull();
    expect(chain[3]).toMatchObject({
      task_status: 'in_progress',
      sla_status: 'completed',
    });
    expect(chain[3].completed_at).toEqual(chain[3].acknowledged_at);
    const nullMethodEvidence = await prisma.$queryRawUnsafe(
      `SELECT payload ? 'read_back_method' AS has_read_back_method,
              payload->>'read_back_method' AS read_back_method
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND event_type = 'critical_result.acknowledged'
          AND source_table = 'lab_critical_alerts'
          AND source_id = $2::text`,
      DEFAULT_TENANT,
      String(chain[3].id),
    );
    expect(nullMethodEvidence).toEqual([{
      has_read_back_method: true,
      read_back_method: null,
    }]);
    await rerunAstmMigrationWithoutMutation({ messageId, resultId });
    const receiptCardinality = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS receipt_count,
              COUNT(DISTINCT acknowledgement_task_id)::int AS task_count,
              COUNT(DISTINCT workflow_sla_instance_id)::int AS sla_count,
              MIN(ack_contract_version)::int AS min_contract_version,
              MAX(ack_contract_version)::int AS max_contract_version
         FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid
          AND alert_id = ANY($2::int[])`,
      DEFAULT_TENANT,
      [Number(chain[0].id), Number(chain[3].id)],
    );
    expect(receiptCardinality).toEqual([{
      receipt_count: 2,
      task_count: 2,
      sla_count: 1,
      min_contract_version: 2,
      max_contract_version: 2,
    }]);
  }, 90_000);

  test('unknown accession fails closed but stays replayable in the inbox', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({
        protocol: 'astm_e1394',
        analyzer_code: ANALYZER_CODE,
        message: astmFor('B3TEST-GHOST-1'),
      });
    expect(res.status).toBe(404);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, error FROM lab_interface_messages
        WHERE raw_message LIKE '%B3TEST-GHOST-1%' ORDER BY id DESC LIMIT 1`,
    );
    expect(inbox[0].status).toBe('failed');
    expect(inbox[0].error).toMatch(/No specimen matches/);
  });

  test('bad protocol is rejected without an inbox row', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'fax', message: 'whatever' });
    expect(res.status).toBe(400);
  });

  test('interface inbox list filters by status', async () => {
    const res = await authClient('ADMIN')
      .get('/api/v1/lab/interface/messages')
      .query({ status: 'failed' });
    expect(res.status).toBe(200);
    expect(res.body.data.messages.every((m) => m.status === 'failed')).toBe(true);
  });
});
