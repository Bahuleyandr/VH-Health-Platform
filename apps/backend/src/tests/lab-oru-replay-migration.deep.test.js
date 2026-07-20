import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../migrations/582_lab_oru_replay_idempotency.sql', import.meta.url),
  'utf8',
);

describeIfDb('migration 582 ORU replay identity', () => {
  let client;
  let schemaName;
  let firstTenantId;
  let secondTenantId;
  let firstActorUid;
  let secondActorUid;

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    schemaName = `oru_mig_${randomUUID().replaceAll('-', '')}`;
    firstTenantId = randomUUID();
    secondTenantId = randomUUID();
    firstActorUid = randomUUID();
    secondActorUid = randomUUID();
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}", public`);
    await client.query(`
      CREATE TABLE tenants (
        id UUID PRIMARY KEY
      );
      CREATE TABLE lab_analyzers (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        analyzer_code VARCHAR(120) NOT NULL,
        UNIQUE (tenant_id, analyzer_code)
      );
      CREATE TABLE users (
        uid UUID NOT NULL,
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        PRIMARY KEY (uid),
        UNIQUE (tenant_id, uid)
      );
      CREATE TABLE lab_results (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        analyzer_id INTEGER,
        performed_by_lab VARCHAR(255),
        hl7_message_id VARCHAR(100),
        hl7_segment_index INTEGER,
        patient_uid UUID,
        booking_id INTEGER,
        investigation_id INTEGER,
        loinc_code TEXT,
        test_code TEXT,
        test_name TEXT,
        raw_obx TEXT,
        panel_id UUID,
        is_critical BOOLEAN NOT NULL DEFAULT false,
        value_text TEXT
      );
      CREATE TABLE workflow_sla_instances (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        rule_code TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE tasks (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        related_resource_type TEXT NOT NULL,
        related_resource_id TEXT NOT NULL,
        workflow_sla_instance_id UUID NOT NULL,
        sla_completion_semantics TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE lab_critical_alerts (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        result_id INTEGER NOT NULL,
        acknowledgement_task_id INTEGER,
        acknowledged_at TIMESTAMPTZ,
        acknowledged_by UUID,
        superseded_at TIMESTAMPTZ
      );
      INSERT INTO tenants (id) VALUES ('${firstTenantId}'::uuid), ('${secondTenantId}'::uuid);
      INSERT INTO users (uid, tenant_id)
      VALUES
        ('${firstActorUid}'::uuid, '${firstTenantId}'::uuid),
        ('${secondActorUid}'::uuid, '${secondTenantId}'::uuid);
      INSERT INTO lab_analyzers (tenant_id, analyzer_code)
      VALUES
        ('${firstTenantId}'::uuid, 'ANALYZER-A'),
        ('${firstTenantId}'::uuid, 'ANALYZER-B'),
        ('${secondTenantId}'::uuid, 'ANALYZER-A')
    `);
  });

  afterEach(async () => {
    if (client && schemaName) {
      await client.query('SET search_path TO public').catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
    }
    await client?.end();
  });

  test('allows cross-sender reuse and rejects only duplicate complete sender-scoped keys', async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
    const claims = await client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message, obx_count,
           authenticated_actor_uid, authenticated_actor_roles,
           sender_binding_mode, sender_binding_identity)
       VALUES
         ($1::uuid, 'ANALYZER-A', 'MSG-1', 'MSH|ANALYZER-A', 1,
           $3::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $3::text),
         ($1::uuid, 'ANALYZER-B', 'MSG-1', 'MSH|ANALYZER-B', 1,
           $3::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $3::text),
         ($2::uuid, 'ANALYZER-A', 'MSG-1', 'MSH|ANALYZER-A', 1,
           $4::uuid, ARRAY['DEVICE_GATEWAY']::text[], 'actor_uid', $4::text)
       RETURNING id, tenant_id, trusted_sender_identity`,
      [firstTenantId, secondTenantId, firstActorUid, secondActorUid],
    );
    const claimId = (tenantId, sender) => claims.rows.find(
      row => row.tenant_id === tenantId && row.trusted_sender_identity === sender,
    ).id;
    const analyzers = await client.query(
      `SELECT id, tenant_id, analyzer_code FROM lab_analyzers`,
    );
    const analyzerId = (tenantId, sender) => analyzers.rows.find(
      row => row.tenant_id === tenantId && row.analyzer_code === sender,
    ).id;

    await client.query(
      `INSERT INTO lab_results
         (tenant_id, analyzer_id, performed_by_lab, hl7_message_id,
          hl7_segment_index, oru_ingest_message_id)
       VALUES
         ($1::uuid, $3::int, 'ANALYZER-A', 'MSG-1', 1, $6::bigint),
         ($1::uuid, $4::int, 'ANALYZER-B', 'MSG-1', 1, $7::bigint),
         ($2::uuid, $5::int, 'ANALYZER-A', 'MSG-1', 1, $8::bigint),
         ($1::uuid, NULL, NULL, NULL, NULL, NULL),
         ($1::uuid, NULL, NULL, NULL, NULL, NULL),
         ($1::uuid, NULL, 'MANUAL-LAB', NULL, NULL, NULL),
         ($1::uuid, NULL, 'MANUAL-LAB', NULL, NULL, NULL)`,
      [
        firstTenantId,
        secondTenantId,
        analyzerId(firstTenantId, 'ANALYZER-A'),
        analyzerId(firstTenantId, 'ANALYZER-B'),
        analyzerId(secondTenantId, 'ANALYZER-A'),
        claimId(firstTenantId, 'ANALYZER-A'),
        claimId(firstTenantId, 'ANALYZER-B'),
        claimId(secondTenantId, 'ANALYZER-A'),
      ],
    );

    await expect(client.query(
      `INSERT INTO lab_results
         (tenant_id, analyzer_id, performed_by_lab, hl7_message_id,
          hl7_segment_index, oru_ingest_message_id)
       VALUES ($1::uuid, $2::int, 'ANALYZER-A', 'MSG-1', 1, $3::bigint)`,
      [
        firstTenantId,
        analyzerId(firstTenantId, 'ANALYZER-A'),
        claimId(firstTenantId, 'ANALYZER-A'),
      ],
    )).rejects.toMatchObject({ code: '23505' });

    await expect(client.query(
      `INSERT INTO lab_results
         (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index)
       VALUES ($1::uuid, NULL, 'MSG-NO-SENDER', 2)`,
      [firstTenantId],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(client.query(
      `UPDATE lab_results
          SET performed_by_lab = 'RENAMED-ANALYZER'
        WHERE tenant_id = $1::uuid
          AND performed_by_lab = 'ANALYZER-A'
          AND hl7_message_id = 'MSG-1'
          AND hl7_segment_index = 1`,
      [firstTenantId],
    )).rejects.toMatchObject({
      code: '23514',
      message: 'HL7 ORU result identity is immutable once assigned',
    });

    await expect(client.query(
      `UPDATE lab_results
          SET value_text = 'updated safely'
        WHERE tenant_id = $1::uuid
          AND performed_by_lab = 'ANALYZER-A'
          AND hl7_message_id = 'MSG-1'
          AND hl7_segment_index = 1`,
      [firstTenantId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  test('fails closed with bounded evidence and preserves every duplicate clinical row', async () => {
    await client.query(
      `INSERT INTO lab_results
         (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index)
       VALUES ($1::uuid, 'ANALYZER-A', 'DUPLICATE-MSG', 7),
              ($1::uuid, 'ANALYZER-A', 'DUPLICATE-MSG', 7)`,
      [firstTenantId],
    );

    let migrationError;
    try {
      await client.query(migrationSql);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({ code: '23505' });
    expect(migrationError.message).toContain(
      'Cannot install ORU replay identity: 1 duplicate lab-result group(s) exist',
    );
    expect(migrationError.detail).toContain(
      `tenant=${firstTenantId} sender=ANALYZER-A message=DUPLICATE-MSG segment=7 rows=2`,
    );
    expect(migrationError.hint).toContain('this migration never deletes clinical data');

    const preserved = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND performed_by_lab = 'ANALYZER-A'
          AND hl7_message_id = 'DUPLICATE-MSG'
          AND hl7_segment_index = 7`,
      [firstTenantId],
    );
    expect(preserved.rows[0].count).toBe(2);

    const index = await client.query(
      `SELECT to_regclass($1) AS name`,
      [`${schemaName}.uq_lab_results_hl7_message_segment`],
    );
    expect(index.rows[0].name).toBeNull();
  });

  test('preflight reports and preserves incomplete legacy replay identities', async () => {
    const inserted = await client.query(
      `INSERT INTO lab_results
         (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index)
       VALUES ($1::uuid, NULL, 'INCOMPLETE-MSG', 9)
       RETURNING id`,
      [firstTenantId],
    );

    let migrationError;
    try {
      await client.query(migrationSql);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({ code: '23514' });
    expect(migrationError.message).toContain(
      'Cannot install ORU replay identity: 1 lab result row(s) have an incomplete replay key',
    );
    expect(migrationError.detail).toContain(
      `id=${inserted.rows[0].id} tenant=${firstTenantId} sender=<null> message=INCOMPLETE-MSG segment=9`,
    );

    const preserved = await client.query(
      `SELECT performed_by_lab, hl7_message_id, hl7_segment_index
         FROM lab_results
        WHERE id = $1::bigint`,
      [inserted.rows[0].id],
    );
    expect(preserved.rows).toEqual([{
      performed_by_lab: null,
      hl7_message_id: 'INCOMPLETE-MSG',
      hl7_segment_index: 9,
    }]);
  });

  test('fails closed when a same-name replay index has the wrong definition', async () => {
    await client.query(
      `CREATE INDEX uq_lab_results_hl7_message_segment ON lab_results (value_text)`,
    );

    await expect(client.query(migrationSql)).rejects.toMatchObject({
      code: '23514',
      message: 'uq_lab_results_hl7_message_segment has an incompatible definition',
    });

    const claimTable = await client.query(
      `SELECT to_regclass($1) AS name`,
      [`${schemaName}.lab_oru_ingest_messages`],
    );
    expect(claimTable.rows[0].name).toBeNull();
  });

  test('permits one exact legacy claim attachment and then forbids detach or rebind', async () => {
    const legacy = await client.query(
      `INSERT INTO lab_results
         (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index, raw_obx)
       VALUES ($1::uuid, 'ANALYZER-A', 'LEGACY-1', 1, 'OBX|1|NM|K^Potassium||4.1')
       RETURNING id`,
      [firstTenantId],
    );
    await client.query(migrationSql);
    const analyzer = await client.query(
      `SELECT id FROM lab_analyzers
        WHERE tenant_id = $1::uuid AND analyzer_code = 'ANALYZER-A'`,
      [firstTenantId],
    );
    const claim = await client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
           obx_count, authenticated_actor_uid, authenticated_actor_roles,
           sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, 'ANALYZER-A', 'LEGACY-1', 'exact legacy message', 1,
                $2::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $2::text)
       RETURNING id`,
      [firstTenantId, firstActorUid],
    );

    await expect(client.query(
      `UPDATE lab_results
          SET analyzer_id = $3::int, oru_ingest_message_id = $4::bigint
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [firstTenantId, legacy.rows[0].id, analyzer.rows[0].id, claim.rows[0].id],
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(client.query(
      `UPDATE lab_results
          SET oru_ingest_message_id = NULL
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [firstTenantId, legacy.rows[0].id],
    )).rejects.toMatchObject({
      code: '23514',
      message: 'HL7 ORU result identity is immutable once assigned',
    });
  });

  test('uses a database-generated raw-message hash and rejects fabricated hash input', async () => {
    await client.query(migrationSql);
    const rawMessage = 'MSH|^~\\&|ANALYZER-A||||||ORU^R01|HASH-1|P|2.5\rOBX|1|NM|K^Potassium||4.1';
    const inserted = await client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
           obx_count, authenticated_actor_uid, authenticated_actor_roles,
           sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, 'ANALYZER-A', 'HASH-1', $2, 1, $3::uuid,
                ARRAY['DEVICE_GATEWAY']::text[], 'actor_uid', $3::text)
       RETURNING raw_message, message_sha256`,
      [firstTenantId, rawMessage, firstActorUid],
    );
    expect(inserted.rows[0]).toEqual({
      raw_message: rawMessage,
      message_sha256: createHash('sha256').update(rawMessage).digest('hex'),
    });

    await expect(client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
          message_sha256, obx_count, authenticated_actor_uid,
           authenticated_actor_roles, sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, 'ANALYZER-A', 'HASH-FAKE', 'different', 'fabricated', 1,
                $2::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $2::text)`,
      [firstTenantId, firstActorUid],
    )).rejects.toMatchObject({ code: '428C9' });
  });

  test('defers completion until every critical result has a distinct current alert/task/SLA binding', async () => {
    await client.query(migrationSql);
    const analyzer = await client.query(
      `SELECT id FROM lab_analyzers
        WHERE tenant_id = $1::uuid AND analyzer_code = 'ANALYZER-A'`,
      [firstTenantId],
    );
    const claim = await client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
           obx_count, authenticated_actor_uid, authenticated_actor_roles,
           sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, 'ANALYZER-A', 'ARTIFACT-1', 'two critical results', 2,
                $2::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $2::text)
       RETURNING id`,
      [firstTenantId, firstActorUid],
    );
    const results = await client.query(
      `INSERT INTO lab_results
         (tenant_id, analyzer_id, performed_by_lab, hl7_message_id,
          hl7_segment_index, oru_ingest_message_id, is_critical)
       VALUES
         ($1::uuid, $2::int, 'ANALYZER-A', 'ARTIFACT-1', 1, $3::bigint, true),
         ($1::uuid, $2::int, 'ANALYZER-A', 'ARTIFACT-1', 2, $3::bigint, true)
       RETURNING id`,
      [firstTenantId, analyzer.rows[0].id, claim.rows[0].id],
    );
    const orderedResults = results.rows.sort((a, b) => Number(a.id) - Number(b.id));
    const firstResultId = orderedResults[0].id;
    const secondResultId = orderedResults[1].id;
    const firstSlaId = randomUUID();
    const secondSlaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status)
       VALUES
         ($1::uuid, $3::uuid, 'critical_result_ack', 'lab_result', $4, 'active'),
         ($2::uuid, $3::uuid, 'critical_result_ack', 'lab_result', $4, 'active')`,
      [firstSlaId, secondSlaId, firstTenantId, String(firstResultId)],
    );
    const tasks = await client.query(
      `INSERT INTO tasks
         (tenant_id, related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, status)
       VALUES
         ($1::uuid, 'lab_result', $2, $3::uuid, 'acknowledgement', 'open'),
         ($1::uuid, 'lab_result', $2, $4::uuid, 'acknowledgement', 'open')
       RETURNING id`,
      [firstTenantId, String(firstResultId), firstSlaId, secondSlaId],
    );
    const alerts = await client.query(
      `INSERT INTO lab_critical_alerts
         (tenant_id, result_id, acknowledgement_task_id)
       VALUES ($1::uuid, $2::int, $3::int), ($1::uuid, $2::int, $4::int)
       RETURNING id`,
      [firstTenantId, firstResultId, tasks.rows[0].id, tasks.rows[1].id],
    );

    await client.query('BEGIN');
    await client.query(
      `UPDATE lab_oru_ingest_messages
          SET status = 'completed', completed_at = NOW(),
              result_ids = $3::int[], critical_result_ids = $3::int[],
              active_critical_result_ids = $3::int[],
              alert_ids = $4::int[], task_ids = $5::int[],
              sla_instance_ids = $6::uuid[]
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [
        firstTenantId,
        claim.rows[0].id,
        [firstResultId, secondResultId],
        alerts.rows.sort((a, b) => Number(a.id) - Number(b.id)).map(row => row.id),
        tasks.rows.sort((a, b) => Number(a.id) - Number(b.id)).map(row => row.id),
        [firstSlaId, secondSlaId],
      ],
    );
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
      message: 'Completed HL7 ORU claim has an incomplete alert/task/SLA binding',
    });

    const preserved = await client.query(
      `SELECT status, completed_at
         FROM lab_oru_ingest_messages
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [firstTenantId, claim.rows[0].id],
    );
    expect(preserved.rows[0]).toMatchObject({ status: 'processing', completed_at: null });
  });

  test('fails closed on whitespace-normalized legacy sender or message identity', async () => {
    const inserted = await client.query(
      `INSERT INTO lab_results
         (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index)
       VALUES ($1::uuid, 'ANALYZER-A ', 'SPACE-1 ', 1)
       RETURNING id`,
      [firstTenantId],
    );

    await expect(client.query(migrationSql)).rejects.toMatchObject({ code: '23514' });
    const preserved = await client.query(
      `SELECT performed_by_lab, hl7_message_id
         FROM lab_results
        WHERE id = $1::int`,
      [inserted.rows[0].id],
    );
    expect(preserved.rows[0]).toEqual({
      performed_by_lab: 'ANALYZER-A ',
      hl7_message_id: 'SPACE-1 ',
    });
  });

  test('rejects a wrong-shape preexisting ORU claim table instead of blessing it', async () => {
    await client.query(`
      CREATE TABLE lab_oru_ingest_messages (
        id BIGINT,
        tenant_id UUID,
        trusted_sender_identity VARCHAR(120),
        message_control_id VARCHAR(100),
        raw_message TEXT,
        message_sha256 TEXT,
        obx_count INTEGER,
        status VARCHAR(20),
        result_ids INTEGER[],
        critical_result_ids INTEGER[],
        active_critical_result_ids INTEGER[],
        closed_critical_result_ids INTEGER[],
        alert_ids INTEGER[],
        task_ids INTEGER[],
        sla_instance_ids UUID[],
        closed_alert_ids INTEGER[],
        closed_task_ids INTEGER[],
        closed_sla_instance_ids UUID[],
        legacy_adoption BOOLEAN,
        authenticated_actor_uid UUID,
        authenticated_actor_roles TEXT[],
        sender_binding_mode VARCHAR(20),
        sender_binding_identity VARCHAR(255),
        completed_at TIMESTAMPTZ(6),
        created_at TIMESTAMPTZ(6),
        updated_at TIMESTAMPTZ(6)
      )
    `);

    await expect(client.query(migrationSql)).rejects.toMatchObject({
      code: '23514',
      message: 'lab_oru_ingest_messages has an incompatible column shape',
    });
  });

  test('rejects a wrong-shape preexisting lab command ledger', async () => {
    await client.query(`
      CREATE TABLE lab_result_ingest_commands (
        id BIGINT,
        tenant_id UUID,
        actor_uid UUID,
        command_scope VARCHAR(30),
        command_key VARCHAR(200),
        request_body_sha256 CHAR(64),
        status VARCHAR(20),
        result_ids INTEGER[],
        panel_id UUID,
        response_data JSONB,
        completed_at TIMESTAMPTZ(6),
        created_at TIMESTAMPTZ(6),
        updated_at TIMESTAMPTZ(6)
      )
    `);

    await expect(client.query(migrationSql)).rejects.toMatchObject({
      code: '23514',
      message: 'lab_result_ingest_commands has an incompatible column shape',
    });
  });

  test('rejects a same-name command tenant foreign key that targets users instead of tenants', async () => {
    await client.query(migrationSql);
    await client.query(`
      ALTER TABLE lab_result_ingest_commands
        DROP CONSTRAINT fk_lab_result_ingest_commands_tenant;
      ALTER TABLE lab_result_ingest_commands
        ADD CONSTRAINT fk_lab_result_ingest_commands_tenant
        FOREIGN KEY (tenant_id) REFERENCES users(uid)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    `);

    await expect(client.query(migrationSql)).rejects.toMatchObject({
      code: '23514',
      message: 'lab_result_ingest_commands has incompatible tenant or actor foreign keys',
    });
  });

  test('is rerunnable and rejects a wrong same-name nonunique index', async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
    await expect(client.query(migrationSql)).resolves.toBeDefined();

    await client.query('DROP INDEX idx_lab_results_ingest_command');
    await client.query('CREATE INDEX idx_lab_results_ingest_command ON lab_results (value_text)');
    await expect(client.query(migrationSql)).rejects.toMatchObject({
      code: '23514',
      message: 'idx_lab_results_ingest_command has an incompatible definition',
    });
  });

  test('rejects hidden claim attachment and freezes completed ORU source identity', async () => {
    await client.query(migrationSql);
    const claim = await client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
          obx_count, authenticated_actor_uid, authenticated_actor_roles,
          sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, 'ANALYZER-A', 'HIDDEN-1', 'raw hidden', 1,
               $2::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $2::text)
       RETURNING id`,
      [firstTenantId, firstActorUid],
    );
    const ordinary = await client.query(
      `INSERT INTO lab_results (tenant_id, value_text) VALUES ($1::uuid, 'ordinary') RETURNING id`,
      [firstTenantId],
    );
    await expect(client.query(
      `UPDATE lab_results SET oru_ingest_message_id = $3::bigint
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [firstTenantId, ordinary.rows[0].id, claim.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });

    const analyzer = await client.query(
      `SELECT id FROM lab_analyzers
        WHERE tenant_id = $1::uuid AND analyzer_code = 'ANALYZER-A'`,
      [firstTenantId],
    );
    const patientUid = randomUUID();
    const result = await client.query(
      `INSERT INTO lab_results
         (tenant_id, analyzer_id, performed_by_lab, hl7_message_id,
          hl7_segment_index, oru_ingest_message_id, patient_uid, raw_obx,
          test_code, test_name, value_text)
       VALUES ($1::uuid, $2::int, 'ANALYZER-A', 'HIDDEN-1', 1, $3::bigint,
               $4::uuid, 'OBX|1', 'K', 'Potassium', '4.1')
       RETURNING id`,
      [firstTenantId, analyzer.rows[0].id, claim.rows[0].id, patientUid],
    );
    await client.query(
      `UPDATE lab_oru_ingest_messages
          SET status = 'completed', completed_at = NOW(), result_ids = $3::int[]
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [firstTenantId, claim.rows[0].id, [result.rows[0].id]],
    );
    await expect(client.query(
      `UPDATE lab_results SET patient_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [firstTenantId, result.rows[0].id, randomUUID()],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = $2::int`,
      [firstTenantId, result.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  test('adopts exact acknowledged legacy evidence and reruns after source deactivation', async () => {
    const patientUid = randomUUID();
    const legacy = await client.query(
      `INSERT INTO lab_results
         (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index,
          patient_uid, raw_obx, test_code, test_name, value_text, is_critical)
       VALUES ($1::uuid, 'ANALYZER-A', 'CLOSED-1', 1, $2::uuid,
               'OBX|1', 'K', 'Potassium', '7.1', true)
       RETURNING id`,
      [firstTenantId, patientUid],
    );
    await client.query(migrationSql);
    const claim = await client.query(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
          obx_count, authenticated_actor_uid, authenticated_actor_roles,
          sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, 'ANALYZER-A', 'CLOSED-1', 'closed legacy', 1,
               $2::uuid, ARRAY['LAB_STAFF']::text[], 'actor_uid', $2::text)
       RETURNING id`,
      [firstTenantId, firstActorUid],
    );
    const analyzer = await client.query(
      `SELECT id FROM lab_analyzers
        WHERE tenant_id = $1::uuid AND analyzer_code = 'ANALYZER-A'`,
      [firstTenantId],
    );
    await client.query(
      `UPDATE lab_results SET analyzer_id = $3::int, oru_ingest_message_id = $4::bigint
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [firstTenantId, legacy.rows[0].id, analyzer.rows[0].id, claim.rows[0].id],
    );
    const ackAt = '2026-07-19T10:30:00.000Z';
    const slaId = randomUUID();
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, status, metadata)
       VALUES ($1::uuid, 'lab_result', $2, $3::uuid, 'acknowledgement',
               'in_progress', jsonb_build_object('acknowledged_at', $4::text,
                                                 'acknowledged_by', $5::text))
       RETURNING id`,
      [firstTenantId, String(legacy.rows[0].id), slaId, ackAt, firstActorUid],
    );
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, completed_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack', 'lab_result', $3,
               'completed', $4::timestamptz,
               jsonb_build_object('completed_via', 'task_ack',
                                  'completed_by_task', $5::int,
                                  'completed_by', $6::text))`,
      [slaId, firstTenantId, String(legacy.rows[0].id), ackAt, task.rows[0].id, firstActorUid],
    );
    const alert = await client.query(
      `INSERT INTO lab_critical_alerts
         (tenant_id, result_id, acknowledgement_task_id, acknowledged_at, acknowledged_by)
       VALUES ($1::uuid, $2::int, $3::int, $4::timestamptz, $5::uuid)
       RETURNING id`,
      [firstTenantId, legacy.rows[0].id, task.rows[0].id, ackAt, firstActorUid],
    );

    await client.query('BEGIN');
    await client.query(
      `UPDATE lab_oru_ingest_messages
          SET status = 'completed', completed_at = NOW(), legacy_adoption = true,
              result_ids = $3::int[], critical_result_ids = $3::int[],
              closed_critical_result_ids = $3::int[],
              closed_alert_ids = $4::int[], closed_task_ids = $5::int[],
              closed_sla_instance_ids = $6::uuid[]
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [
        firstTenantId,
        claim.rows[0].id,
        [legacy.rows[0].id],
        [alert.rows[0].id],
        [task.rows[0].id],
        [slaId],
      ],
    );
    await expect(client.query('COMMIT')).resolves.toBeDefined();
    const counts = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM lab_critical_alerts WHERE result_id = $1::int) AS alerts,
         (SELECT COUNT(*)::int FROM tasks WHERE related_resource_id = $1::text) AS tasks,
         (SELECT COUNT(*)::int FROM workflow_sla_instances WHERE source_id = $1::text) AS slas`,
      [legacy.rows[0].id],
    );
    expect(counts.rows[0]).toEqual({ alerts: 1, tasks: 1, slas: 1 });

    await client.query(`
      ALTER TABLE users
        ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN status TEXT NOT NULL DEFAULT 'active',
        ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE lab_analyzers
        ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    `);
    await client.query(
      `UPDATE users
          SET is_active = false, status = 'inactive', is_deleted = true
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [firstTenantId, firstActorUid],
    );
    await client.query(
      `UPDATE lab_analyzers
          SET status = 'retired'
        WHERE tenant_id = $1::uuid AND analyzer_code = 'ANALYZER-A'`,
      [firstTenantId],
    );

    await expect(client.query(migrationSql)).resolves.toBeDefined();
    const preserved = await client.query(
      `SELECT status, legacy_adoption, result_ids, critical_result_ids,
              active_critical_result_ids, closed_critical_result_ids,
              closed_alert_ids, closed_task_ids, closed_sla_instance_ids
         FROM lab_oru_ingest_messages
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [firstTenantId, claim.rows[0].id],
    );
    expect(preserved.rows[0]).toMatchObject({
      status: 'completed',
      legacy_adoption: true,
      result_ids: [legacy.rows[0].id],
      critical_result_ids: [legacy.rows[0].id],
      active_critical_result_ids: [],
      closed_critical_result_ids: [legacy.rows[0].id],
      closed_alert_ids: [alert.rows[0].id],
      closed_task_ids: [task.rows[0].id],
      closed_sla_instance_ids: [slaId],
    });
  });

  test('requires command-linked results exactly and rejects hidden panel mismatch rows', async () => {
    await client.query(migrationSql);
    const panelId = randomUUID();
    const command = await client.query(
      `INSERT INTO lab_result_ingest_commands
         (tenant_id, actor_uid, command_scope, command_key, request_body_sha256)
       VALUES ($1::uuid, $2::uuid, 'panel_result', 'panel-command-1', $3)
       RETURNING id`,
      [firstTenantId, firstActorUid, 'a'.repeat(64)],
    );
    const results = await client.query(
      `INSERT INTO lab_results (tenant_id, ingest_command_id, panel_id, value_text)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'one'),
              ($1::uuid, $2::bigint, $4::uuid, 'hidden mismatch')
       RETURNING id`,
      [firstTenantId, command.rows[0].id, panelId, randomUUID()],
    );

    await client.query('BEGIN');
    await client.query(
      `UPDATE lab_result_ingest_commands
          SET status = 'completed', completed_at = NOW(), panel_id = $3::uuid,
              result_ids = $4::int[], response_data = '{"ok":true}'::jsonb
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [firstTenantId, command.rows[0].id, panelId, results.rows.map(row => row.id)],
    );
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
      message: 'Completed lab result ingest command has inconsistent panel identity',
    });
  });
});
