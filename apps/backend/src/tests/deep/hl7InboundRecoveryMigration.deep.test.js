import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';
import { jest } from '@jest/globals';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
const migrationSql = readFileSync(
  new URL('../../migrations/631_hl7_inbound_recovery.sql', import.meta.url),
  'utf8',
);

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function lengthPrefixedSha256(values) {
  const hash = createHash('sha256');
  for (const value of values) {
    const bytes = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_i03_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i03_failure');
  await client.query('RELEASE SAVEPOINT expected_i03_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

const INSERT_RECEIPT_SQL = `
  WITH typed_i03_receipt AS (SELECT $1::jsonb AS payload)
  INSERT INTO hl7_inbound_recovery_receipts (
    id, tenant_id, recovery_inbox_id, interface_family,
    signing_credential_id, source_partition, generation, source_position,
    source_token, predecessor_token, duplicate_key, message_family,
    message_type, trigger_event, message_control_id_sha256,
    payload_ciphertext, payload_sha256, payload_bytes, source_observed_at,
    source_received_at, clock_evidence, patient_uid,
    visit_identity_sha256, order_identity_sha256, pending_task_id,
    review_role, status, outcome_code, ack_ciphertext, ack_sha256,
    ack_bytes, ack_code, http_status, policy_version, policy_signature,
    retention_policy, retention_until
  ) VALUES (
    ($1->>'id')::bigint,
    ($1->>'tenant_id')::uuid,
    ($1->>'recovery_inbox_id')::uuid,
    $1->>'interface_family',
    ($1->>'signing_credential_id')::integer,
    $1->>'source_partition',
    ($1->>'generation')::integer,
    ($1->>'source_position')::bigint,
    $1->>'source_token',
    $1->>'predecessor_token',
    $1->>'duplicate_key',
    $1->>'message_family',
    $1->>'message_type',
    $1->>'trigger_event',
    $1->>'message_control_id_sha256',
    $1->>'payload_ciphertext',
    $1->>'payload_sha256',
    ($1->>'payload_bytes')::integer,
    ($1->>'source_observed_at')::timestamptz,
    ($1->>'source_received_at')::timestamptz,
    $1->'clock_evidence',
    NULLIF($1->>'patient_uid', '')::uuid,
    NULLIF($1->>'visit_identity_sha256', ''),
    NULLIF($1->>'order_identity_sha256', ''),
    ($1->>'pending_task_id')::integer,
    $1->>'review_role',
    $1->>'status',
    $1->>'outcome_code',
    $1->>'ack_ciphertext',
    $1->>'ack_sha256',
    ($1->>'ack_bytes')::integer,
    $1->>'ack_code',
    ($1->>'http_status')::smallint,
    $1->>'policy_version',
    $1->>'policy_signature',
    $1->>'retention_policy',
    ($1->>'retention_until')::timestamptz
  )
  RETURNING id::text
`;

describeIfDb('migration 631 I03 inbound ADT/ORM recovery', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const mergedPatientUid = randomUUID();
  const otherPatientUid = randomUUID();
  const adminUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const rawRole = `i03_raw_${suffix}`;
  const policyVersion = `i03-policy-${suffix}`;
  const policySignature = sha256(`i03-policy-signature-${suffix}`);
  const retentionPolicy = 'hl7-recovery-2555d';
  const retentionUntil = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
  const observedAt = new Date(Date.now() - 120_000).toISOString();
  const receivedAt = new Date(Date.now() - 60_000).toISOString();
  const clockEvidence = {
    source_clock_id: `sender-clock-${suffix}`,
    synchronized_at: new Date(Date.now() - 180_000).toISOString(),
    maximum_error_ms: 1000,
  };
  let credentialId;
  let otherCredentialId;
  let inactiveCredentialId;
  let wrongKindCredentialId;
  let positive;
  let pending;
  let other;
  let positiveReceipt;
  let pendingReceipt;
  let otherReceipt;
  let driftedInboxId;
  let wrongFamilyInboxId;
  let taskForgeryReceipts;
  let wrongRoleTaskId;
  let offsetId;

  function buildRecovery({
    rowTenantId,
    rowCredentialId,
    messageFamily = 'adt',
    triggerEvent = messageFamily === 'adt' ? 'A01' : 'O01',
    messageControlId,
    position,
    predecessorToken,
    duplicateOverride,
    payloadLabel,
  }) {
    const messageType = messageFamily === 'adt' ? 'ADT' : 'ORM';
    const partition = `i03/credential/${rowCredentialId}/family/${messageFamily}`;
    const payload = `MSH|^~\\&|RAW|${suffix}|VH|TENANT|20260806023000+0530||${messageType}^${triggerEvent}|${messageControlId}|P|2.5\r${payloadLabel}`;
    const payloadHash = sha256(payload);
    const duplicateKey = duplicateOverride || lengthPrefixedSha256([
      'vh-i03-duplicate-v1',
      rowTenantId,
      String(rowCredentialId),
      messageFamily,
      messageType,
      triggerEvent,
      messageControlId,
    ]);
    const sourceToken = lengthPrefixedSha256([
      'vh-i03-source-token-v1',
      rowTenantId,
      partition,
      '1',
      String(position),
      predecessorToken,
      duplicateKey,
      payloadHash,
    ]);
    return {
      tenantId: rowTenantId,
      credentialId: rowCredentialId,
      partition,
      position: String(position),
      predecessorToken,
      sourceToken,
      duplicateKey,
      messageFamily,
      messageType,
      triggerEvent,
      messageControlId,
      messageControlHash: sha256(messageControlId),
      payload,
      payloadHash,
    };
  }

  async function createOffset(recovery, highWaterPosition, highWaterToken,
    cutoffPosition, cutoffToken, {
      interfaceFamily = 'I03',
      consumerKey = `external:${interfaceFamily}`,
    } = {}) {
    const result = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, resume_cutoff_position, resume_cutoff_token,
          recovery_state, policy_version, policy_signature, retention_policy,
          retention_until, historical_cutoff_event_id, backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, $11::text, 'inbound',
          $2::text, $12::text, 1, 'monotonic_position_and_predecessor',
          $3::bigint, $4::text, $3::bigint, $4::text, $5::bigint, $6::text,
          'replaying', $7::text, $8::text, $9::text, $10::timestamptz,
          NULL, NULL)
       RETURNING offset_id::text`,
      [recovery.tenantId, recovery.partition, highWaterPosition, highWaterToken,
        cutoffPosition, cutoffToken, policyVersion, policySignature,
        retentionPolicy, retentionUntil, interfaceFamily, consumerKey],
    );
    return result.rows[0].offset_id;
  }

  async function createInbox(recovery, offsetId, {
    interfaceFamily = 'I03',
    consumerKey = `external:${interfaceFamily}`,
  } = {}) {
    const result = await client.query(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES
         ('external_interface', $1::uuid, $14::text, 1, $2::uuid, NULL,
          $15::text, 'inbound', $3::text, $4::bigint, $5::text, $6::text,
          $7::text, $8::char(64), $9::timestamptz, NOW(), NOW(),
          'recovery_backlog', 'late_pending_only', 'pending', NOW(),
          $10::text, $11::text, $12::text, $13::timestamptz)
       RETURNING inbox_id::text`,
      [recovery.tenantId, offsetId, recovery.partition, recovery.position,
        recovery.sourceToken, recovery.predecessorToken, recovery.duplicateKey,
        recovery.payloadHash, observedAt, policyVersion, policySignature,
        retentionPolicy, retentionUntil, consumerKey, interfaceFamily],
    );
    return result.rows[0].inbox_id;
  }

  async function reserveReceiptId() {
    const result = await client.query(
      `SELECT nextval('hl7_inbound_recovery_receipts_id_seq')::text AS id`,
    );
    return result.rows[0].id;
  }

  async function createTask({ rowTenantId, rowPatientUid, receiptId, inboxId,
    reviewRole, roleOverride = reviewRole,
    relatedResourceType = 'hl7_inbound_recovery_receipt',
    relatedResourceId = String(receiptId), priority = 'high', status = 'open',
    dueAt = null, slaDefinitionId = null, metadataInboxId = inboxId }) {
    const result = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid, related_resource_type,
          related_resource_id, priority, status, assigned_to_uid,
          assigned_to_role, due_at, sla_definition_id,
          workflow_sla_instance_id, sla_completion_semantics, metadata)
       VALUES
         ($1::uuid, 'review', 'External HL7 recovery requires reconciliation',
          $2::uuid, $3::text, $4::text, $5::text, $6::text,
          NULL, $7::text, $8::timestamptz, $9::integer, NULL, 'none',
          jsonb_build_object(
            'contract', 'late_pending_only',
            'interface_family', 'I03',
            'recovery_inbox_id', $10::text,
            'owner_reconciliation_required', true,
            'review_role', $11::text
          ))
       RETURNING id`,
      [rowTenantId, rowPatientUid, relatedResourceType, relatedResourceId,
        priority, status, roleOverride, dueAt, slaDefinitionId,
        metadataInboxId, reviewRole],
    );
    return result.rows[0].id;
  }

  function receiptFor(recovery, receiptId, inboxId, taskId, overrides = {}) {
    const reviewRole = recovery.messageFamily === 'adt' ? 'MEDICAL_RECORDS' : 'DUTY_DOCTOR';
    const outcomeCode = recovery.messageFamily === 'adt'
      ? 'i03_adt_pending_admission_reconciliation'
      : 'i03_orm_pending_order_reconciliation';
    const ack = `MSH|^~\\&|VH|TENANT|RAW|${suffix}|20260806023100+0530||ACK^${recovery.triggerEvent}|ACK-${recovery.messageControlId}|P|2.5\rMSA|AA|${recovery.messageControlId}|Accepted for reconciliation; no live clinical effect`;
    return {
      id: String(receiptId),
      tenant_id: recovery.tenantId,
      recovery_inbox_id: inboxId,
      interface_family: 'I03',
      signing_credential_id: String(recovery.credentialId),
      source_partition: recovery.partition,
      generation: '1',
      source_position: recovery.position,
      source_token: recovery.sourceToken,
      predecessor_token: recovery.predecessorToken,
      duplicate_key: recovery.duplicateKey,
      message_family: recovery.messageFamily,
      message_type: recovery.messageType,
      trigger_event: recovery.triggerEvent,
      message_control_id_sha256: recovery.messageControlHash,
      payload_ciphertext: `enc:v2:${Buffer.from(recovery.payload).toString('base64')}`,
      payload_sha256: recovery.payloadHash,
      payload_bytes: String(Buffer.byteLength(recovery.payload, 'utf8')),
      source_observed_at: observedAt,
      source_received_at: receivedAt,
      clock_evidence: clockEvidence,
      patient_uid: recovery.tenantId === tenantId ? patientUid : otherPatientUid,
      visit_identity_sha256: sha256(`visit-${recovery.messageControlId}`),
      order_identity_sha256: recovery.messageFamily === 'orm'
        ? sha256(`order-${recovery.messageControlId}`) : null,
      pending_task_id: String(taskId),
      review_role: reviewRole,
      status: 'pending_review',
      outcome_code: outcomeCode,
      ack_ciphertext: `enc:v2:${Buffer.from(ack).toString('base64')}`,
      ack_sha256: sha256(ack),
      ack_bytes: String(Buffer.byteLength(ack, 'utf8')),
      ack_code: 'AA',
      http_status: '200',
      policy_version: policyVersion,
      policy_signature: policySignature,
      retention_policy: retentionPolicy,
      retention_until: retentionUntil,
      ...overrides,
    };
  }

  async function setRawContext(context) {
    await client.query(`SET LOCAL ROLE ${rawRole}`);
    if (context === undefined) {
      await client.query('RESET app.current_tenant_id');
    } else {
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
    }
  }

  beforeAll(async () => {
    await client.connect();
    await client.query(
      `CREATE ROLE ${rawRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${rawRole}`);
    await client.query(`GRANT SELECT ON hl7_inbound_recovery_receipts TO ${rawRole}`);
    await client.query(
      `GRANT INSERT (
         id, tenant_id, recovery_inbox_id, interface_family,
         signing_credential_id, source_partition, generation, source_position,
         source_token, predecessor_token, duplicate_key, message_family,
         message_type, trigger_event, message_control_id_sha256,
         payload_ciphertext, payload_sha256, payload_bytes, source_observed_at,
         source_received_at, clock_evidence, patient_uid,
         visit_identity_sha256, order_identity_sha256, pending_task_id,
         review_role, status, outcome_code, ack_ciphertext, ack_sha256,
         ack_bytes, ack_code, http_status, policy_version, policy_signature,
         retention_policy, retention_until
       ) ON hl7_inbound_recovery_receipts TO ${rawRole}`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON SEQUENCE hl7_inbound_recovery_receipts_id_seq TO ${rawRole}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION external_recovery_operability_register_offset(JSONB) TO ${rawRole}`,
    );
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I03 raw tenant'),
              ($2::uuid, $4::text, 'I03 raw other tenant')`,
      [tenantId, otherTenantId, `i03-raw-${suffix}`, `i03-raw-other-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5::text, 'I03 patient', 'PATIENT', true, 'active', NOW()),
         ($2::uuid, $6::uuid, $7::text, 'I03 other patient', 'PATIENT', true, 'active', NOW()),
         ($3::uuid, $4::uuid, $8::text, 'I03 admin', 'ADMIN', true, 'active', NOW()),
         ($9::uuid, $4::uuid, $10::text, 'I03 merged patient', 'PATIENT', true, 'active', NOW())`,
      [patientUid, otherPatientUid, adminUid, tenantId, `91${suffix.slice(0, 10)}`,
        otherTenantId, `92${suffix.slice(0, 10)}`, `93${suffix.slice(0, 10)}`,
        mergedPatientUid, `94${suffix.slice(0, 10)}`],
    );
    await client.query(
      `INSERT INTO patient_merge_requests
         (tenant_id, primary_uid, secondary_uid, status, executed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'executed', NOW())`,
      [tenantId, patientUid, mergedPatientUid],
    );
    const credentials = await client.query(
      `INSERT INTO tenant_interop_secrets
         (tenant_id, kind, sender_identifier, secret_ciphertext, status)
       VALUES
         ($1::uuid, 'hl7_inbound', $3::text, 'enc:v2:raw-active', 'active'),
         ($2::uuid, 'hl7_inbound', $4::text, 'enc:v2:raw-other', 'active'),
         ($1::uuid, 'hl7_inbound', $5::text, 'enc:v2:raw-inactive', 'inactive'),
         ($1::uuid, 'abdm_callback', $6::text, 'enc:v2:raw-wrong-kind', 'active')
       RETURNING id, tenant_id::text, kind, status`,
      [tenantId, otherTenantId, `i03-active-${suffix}`, `i03-other-${suffix}`,
        `i03-inactive-${suffix}`, `i03-wrong-kind-${suffix}`],
    );
    credentialId = credentials.rows.find(row => row.tenant_id === tenantId
      && row.kind === 'hl7_inbound' && row.status === 'active').id;
    otherCredentialId = credentials.rows.find(row => row.tenant_id === otherTenantId).id;
    inactiveCredentialId = credentials.rows.find(row => row.status === 'inactive').id;
    wrongKindCredentialId = credentials.rows.find(row => row.kind === 'abdm_callback').id;

    const initialToken = sha256(`i03-initial-${suffix}`);
    positive = buildRecovery({
      rowTenantId: tenantId,
      rowCredentialId: credentialId,
      messageControlId: `CTRL-${suffix}-1`,
      position: 11,
      predecessorToken: initialToken,
      payloadLabel: `PID|||${patientUid}`,
    });
    pending = buildRecovery({
      rowTenantId: tenantId,
      rowCredentialId: credentialId,
      messageControlId: `CTRL-${suffix}-2`,
      position: 12,
      predecessorToken: positive.sourceToken,
      payloadLabel: `PID|||${patientUid}`,
    });
    other = buildRecovery({
      rowTenantId: otherTenantId,
      rowCredentialId: otherCredentialId,
      messageControlId: `CTRL-${suffix}-OTHER`,
      position: 11,
      predecessorToken: sha256(`i03-other-initial-${suffix}`),
      payloadLabel: `PID|||${otherPatientUid}`,
    });

    offsetId = await createOffset(
      positive, 10, initialToken, 12, pending.sourceToken,
    );
    const positiveInboxId = await createInbox(positive, offsetId);
    const pendingInboxId = await createInbox(pending, offsetId);
    const drifted = buildRecovery({
      rowTenantId: tenantId,
      rowCredentialId: credentialId,
      messageControlId: `CTRL-${suffix}-DRIFTED`,
      position: 99,
      predecessorToken: sha256(`i03-drifted-predecessor-${suffix}`),
      payloadLabel: `PID|||${patientUid}`,
    });
    driftedInboxId = await createInbox(drifted, offsetId);
    const wrongFamily = buildRecovery({
      rowTenantId: tenantId,
      rowCredentialId: credentialId,
      messageControlId: `CTRL-${suffix}-WRONG-FAMILY`,
      position: 1,
      predecessorToken: sha256(`i03-wrong-family-predecessor-${suffix}`),
      payloadLabel: `PID|||${patientUid}`,
    });
    const wrongFamilyOffsetId = await createOffset(
      wrongFamily, 0, wrongFamily.predecessorToken, 1, wrongFamily.sourceToken,
      { interfaceFamily: 'I01', consumerKey: 'external:I01' },
    );
    wrongFamilyInboxId = await createInbox(wrongFamily, wrongFamilyOffsetId, {
      interfaceFamily: 'I01',
      consumerKey: 'external:I01',
    });
    const otherOffsetId = await createOffset(
      other, 10, other.predecessorToken, 11, other.sourceToken,
    );
    const otherInboxId = await createInbox(other, otherOffsetId);

    const positiveReceiptId = await reserveReceiptId();
    const pendingReceiptId = await reserveReceiptId();
    const otherReceiptId = await reserveReceiptId();
    const wrongTaskReceiptId = await reserveReceiptId();
    const positiveTaskId = await createTask({
      rowTenantId: tenantId,
      rowPatientUid: patientUid,
      receiptId: positiveReceiptId,
      inboxId: positiveInboxId,
      reviewRole: 'MEDICAL_RECORDS',
    });
    const pendingTaskId = await createTask({
      rowTenantId: tenantId,
      rowPatientUid: patientUid,
      receiptId: pendingReceiptId,
      inboxId: pendingInboxId,
      reviewRole: 'MEDICAL_RECORDS',
    });
    const otherTaskId = await createTask({
      rowTenantId: otherTenantId,
      rowPatientUid: otherPatientUid,
      receiptId: otherReceiptId,
      inboxId: otherInboxId,
      reviewRole: 'MEDICAL_RECORDS',
    });
    wrongRoleTaskId = await createTask({
      rowTenantId: tenantId,
      rowPatientUid: patientUid,
      receiptId: wrongTaskReceiptId,
      inboxId: pendingInboxId,
      reviewRole: 'MEDICAL_RECORDS',
      roleOverride: 'DUTY_DOCTOR',
    });
    positiveReceipt = receiptFor(
      positive, positiveReceiptId, positiveInboxId, positiveTaskId,
    );
    pendingReceipt = receiptFor(
      pending, pendingReceiptId, pendingInboxId, pendingTaskId,
    );
    otherReceipt = receiptFor(other, otherReceiptId, otherInboxId, otherTaskId);

    taskForgeryReceipts = [];
    const taskForgerySpecs = [
      {
        label: 'cross-tenant',
        rowTenantId: otherTenantId,
        rowPatientUid: otherPatientUid,
      },
      { label: 'unrelated-inbox', metadataInboxId: positiveInboxId },
      { label: 'wrong-resource-type', relatedResourceType: 'admission' },
      { label: 'wrong-resource-id', wrongResourceId: true },
      { label: 'wrong-status', status: 'completed' },
      { label: 'wrong-priority', priority: 'normal' },
      {
        label: 'non-null-sla',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        slaDefinitionId: 2147483000,
      },
    ];
    for (const spec of taskForgerySpecs) {
      const receiptId = await reserveReceiptId();
      const taskId = await createTask({
        rowTenantId: spec.rowTenantId || tenantId,
        rowPatientUid: spec.rowPatientUid || patientUid,
        receiptId,
        inboxId: pendingInboxId,
        reviewRole: 'MEDICAL_RECORDS',
        metadataInboxId: spec.metadataInboxId,
        relatedResourceType: spec.relatedResourceType,
        relatedResourceId: spec.wrongResourceId ? `wrong-${receiptId}` : undefined,
        priority: spec.priority,
        status: spec.status,
        dueAt: spec.dueAt,
        slaDefinitionId: spec.slaDefinitionId,
      });
      taskForgeryReceipts.push({
        label: spec.label,
        receipt: receiptFor(pending, receiptId, pendingInboxId, taskId),
      });
    }

    await setRawContext(tenantId);
    const inserted = await client.query(INSERT_RECEIPT_SQL, [positiveReceipt]);
    expect(inserted.rows).toEqual([{ id: positiveReceiptId }]);
    await client.query('RESET ROLE');
    await client.query(
      `UPDATE pathway_projector_inbox
          SET status = 'handled', outcome_at = NOW(),
              pending_task_id = $3::integer, outcome_code = $4::text
        WHERE tenant_id = $1::uuid AND inbox_id = $2::uuid`,
      [tenantId, positiveInboxId, positiveTaskId,
        'i03_adt_pending_admission_reconciliation'],
    );
    await client.query(
      `UPDATE event_consumer_offsets
          SET high_water_position = 11, high_water_token = $3::text,
              recovery_state = 'replaying', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      [tenantId, offsetId, positive.sourceToken],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP OWNED BY ${rawRole}`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${rawRole}`).catch(() => {});
    await client.end();
  });

  test('extends the canonical BV function and creates one receipt, not a queue or cursor', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('631_hl7_inbound_recovery.sql');
    expect(names[index - 1]).toBe('630_clinical_continuity_incident_packet_provisioning.sql');
    expect(migrationSql).toContain('CREATE TABLE public.hl7_inbound_recovery_receipts');
    expect(migrationSql).not.toContain('CREATE TABLE public.hl7_inbound_recovery_queue');
    expect(migrationSql).not.toContain('CREATE TABLE public.hl7_inbound_recovery_cursor');
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION public.external_recovery_operability_register_offset',
    );
    expect(migrationSql).toContain("'I01', 'I02', 'I03', 'I04'");
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migrationSql).toContain('external_recovery_effect_guard_admission');
    expect(migrationSql).toContain('external_recovery_effect_guard_investigation');
  });

  test('pins tenant metadata, FORCE RLS, and the restrictive policy catalog shape', async () => {
    const relation = await client.query(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE oid = 'public.hl7_inbound_recovery_receipts'::regclass`,
    );
    expect(relation.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });

    const tenantColumn = await client.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'hl7_inbound_recovery_receipts'
          AND column_name = 'tenant_id'`,
    );
    expect(tenantColumn.rows).toEqual([{
      is_nullable: 'NO',
      column_default: null,
    }]);

    const policies = await client.query(
      `SELECT policy.polname,
              policy.polpermissive,
              policy.polcmd,
              pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
              pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
         FROM pg_policy AS policy
        WHERE policy.polrelid = 'public.hl7_inbound_recovery_receipts'::regclass
        ORDER BY policy.polname`,
    );
    expect(policies.rows.map(row => ({
      name: row.polname,
      permissive: row.polpermissive,
      command: row.polcmd,
    }))).toEqual([
      {
        name: 'hl7_inbound_recovery_receipts_explicit_context',
        permissive: false,
        command: '*',
      },
      { name: 'tenant_isolation', permissive: true, command: '*' },
    ]);
    for (const policy of policies.rows) {
      expect(policy.using_expression).toContain('app.current_tenant_id');
      expect(policy.check_expression).toBe(policy.using_expression);
    }
  });

  test('pins receipt uniqueness and composite same-tenant foreign keys in the catalog', async () => {
    const uniqueConstraintNames = [
      'ux_hl7_inbound_recovery_receipts_source_occurrence',
      'ux_hl7_inbound_recovery_receipts_duplicate_key',
      'ux_hl7_inbound_recovery_receipts_task',
    ];
    const uniqueConstraints = await client.query(
      `SELECT constraint_row.conname AS name,
              ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(constraint_row.conkey) WITH ORDINALITY
                    AS constrained_column(attnum, ordinal_position)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = constraint_row.conrelid
                   AND attribute.attnum = constrained_column.attnum
                 ORDER BY constrained_column.ordinal_position
              ) AS local_columns
         FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
                'public.hl7_inbound_recovery_receipts'::regclass
          AND constraint_row.contype = 'u'
          AND constraint_row.conname = ANY($1::text[])
        ORDER BY constraint_row.conname`,
      [uniqueConstraintNames],
    );
    expect(uniqueConstraints.rows).toEqual([
      {
        name: 'ux_hl7_inbound_recovery_receipts_duplicate_key',
        local_columns: ['tenant_id', 'duplicate_key'],
      },
      {
        name: 'ux_hl7_inbound_recovery_receipts_source_occurrence',
        local_columns: [
          'tenant_id',
          'source_partition',
          'generation',
          'source_position',
        ],
      },
      {
        name: 'ux_hl7_inbound_recovery_receipts_task',
        local_columns: ['tenant_id', 'pending_task_id'],
      },
    ]);

    const foreignKeyNames = [
      'fk_hl7_inbound_recovery_receipts_inbox',
      'fk_hl7_inbound_recovery_receipts_credential',
      'fk_hl7_inbound_recovery_receipts_patient',
      'fk_hl7_inbound_recovery_receipts_task',
    ];
    const foreignKeys = await client.query(
      `SELECT constraint_row.conname AS name,
              referenced_namespace.nspname || '.' || referenced_table.relname
                AS referenced_relation,
              ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(constraint_row.conkey) WITH ORDINALITY
                    AS constrained_column(attnum, ordinal_position)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = constraint_row.conrelid
                   AND attribute.attnum = constrained_column.attnum
                 ORDER BY constrained_column.ordinal_position
              ) AS local_columns,
              ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(constraint_row.confkey) WITH ORDINALITY
                    AS referenced_column(attnum, ordinal_position)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = constraint_row.confrelid
                   AND attribute.attnum = referenced_column.attnum
                 ORDER BY referenced_column.ordinal_position
              ) AS referenced_columns
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS referenced_table
           ON referenced_table.oid = constraint_row.confrelid
         JOIN pg_namespace AS referenced_namespace
           ON referenced_namespace.oid = referenced_table.relnamespace
        WHERE constraint_row.conrelid =
                'public.hl7_inbound_recovery_receipts'::regclass
          AND constraint_row.contype = 'f'
          AND constraint_row.conname = ANY($1::text[])
        ORDER BY constraint_row.conname`,
      [foreignKeyNames],
    );
    expect(foreignKeys.rows).toEqual([
      {
        name: 'fk_hl7_inbound_recovery_receipts_credential',
        referenced_relation: 'public.tenant_interop_secrets',
        local_columns: ['tenant_id', 'signing_credential_id'],
        referenced_columns: ['tenant_id', 'id'],
      },
      {
        name: 'fk_hl7_inbound_recovery_receipts_inbox',
        referenced_relation: 'public.pathway_projector_inbox',
        local_columns: ['tenant_id', 'recovery_inbox_id', 'interface_family'],
        referenced_columns: ['tenant_id', 'inbox_id', 'interface_family'],
      },
      {
        name: 'fk_hl7_inbound_recovery_receipts_patient',
        referenced_relation: 'public.users',
        local_columns: ['tenant_id', 'patient_uid'],
        referenced_columns: ['tenant_id', 'uid'],
      },
      {
        name: 'fk_hl7_inbound_recovery_receipts_task',
        referenced_relation: 'public.tasks',
        local_columns: ['tenant_id', 'pending_task_id'],
        referenced_columns: ['tenant_id', 'id'],
      },
    ]);
  });

  test('grants only same-tenant select/column-insert and sequence use', async () => {
    const grants = await client.query(
      `SELECT
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'SELECT') AS can_select,
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'INSERT') AS can_insert,
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'UPDATE') AS can_update,
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'DELETE') AS can_delete,
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'TRUNCATE') AS can_truncate,
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'REFERENCES') AS can_references,
         has_table_privilege($1, 'hl7_inbound_recovery_receipts', 'TRIGGER') AS can_trigger,
         has_column_privilege($1, 'hl7_inbound_recovery_receipts',
                              'tenant_id', 'INSERT') AS can_insert_allowed_column,
         has_column_privilege($1, 'hl7_inbound_recovery_receipts',
                              'recorded_at', 'INSERT') AS can_insert_recorded_at,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'SELECT') AS public_select,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'INSERT') AS public_insert,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'UPDATE') AS public_update,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'DELETE') AS public_delete,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'TRUNCATE') AS public_truncate,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'REFERENCES') AS public_references,
         has_table_privilege('public', 'hl7_inbound_recovery_receipts', 'TRIGGER') AS public_trigger,
         has_any_column_privilege('public', 'hl7_inbound_recovery_receipts', 'SELECT') AS public_column_select,
         has_any_column_privilege('public', 'hl7_inbound_recovery_receipts', 'INSERT') AS public_column_insert,
         has_any_column_privilege('public', 'hl7_inbound_recovery_receipts', 'UPDATE') AS public_column_update,
         has_any_column_privilege('public', 'hl7_inbound_recovery_receipts', 'REFERENCES') AS public_column_references,
         has_sequence_privilege($1, 'hl7_inbound_recovery_receipts_id_seq', 'USAGE') AS sequence_usage,
         has_sequence_privilege($1, 'hl7_inbound_recovery_receipts_id_seq', 'SELECT') AS sequence_select,
         has_sequence_privilege($1, 'hl7_inbound_recovery_receipts_id_seq', 'UPDATE') AS sequence_update,
         has_sequence_privilege('public', 'hl7_inbound_recovery_receipts_id_seq', 'USAGE') AS public_sequence_usage,
         has_sequence_privilege('public', 'hl7_inbound_recovery_receipts_id_seq', 'SELECT') AS public_sequence_select,
         has_sequence_privilege('public', 'hl7_inbound_recovery_receipts_id_seq', 'UPDATE') AS public_sequence_update`,
      [rawRole],
    );
    expect(grants.rows[0]).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      can_references: false,
      can_trigger: false,
      can_insert_allowed_column: true,
      can_insert_recorded_at: false,
      public_select: false,
      public_insert: false,
      public_update: false,
      public_delete: false,
      public_truncate: false,
      public_references: false,
      public_trigger: false,
      public_column_select: false,
      public_column_insert: false,
      public_column_update: false,
      public_column_references: false,
      sequence_usage: true,
      sequence_select: true,
      sequence_update: false,
      public_sequence_usage: false,
      public_sequence_select: false,
      public_sequence_update: false,
    });

    const readonlyPrivileges = await client.query(
      `SELECT has_table_privilege(role.oid,
                                  'hl7_inbound_recovery_receipts',
                                  'SELECT') AS can_select,
              role.rolname
         FROM pg_roles AS role
        WHERE role.rolname IN ('metabase_readonly', 'vhhealth_readonly')
        ORDER BY role.rolname`,
    );
    for (const privilege of readonlyPrivileges.rows) {
      expect(privilege.can_select).toBe(false);
    }

    const runtimePrivileges = await client.query(
      `SELECT role.rolname,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'SELECT') AS can_select,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'INSERT') AS can_insert,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'UPDATE') AS can_update,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'DELETE') AS can_delete,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'TRUNCATE') AS can_truncate,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'REFERENCES') AS can_references,
              has_table_privilege(role.oid, 'hl7_inbound_recovery_receipts', 'TRIGGER') AS can_trigger,
              has_column_privilege(role.oid, 'hl7_inbound_recovery_receipts',
                                   'tenant_id', 'INSERT') AS can_insert_allowed_column,
              has_column_privilege(role.oid, 'hl7_inbound_recovery_receipts',
                                   'recorded_at', 'INSERT') AS can_insert_recorded_at,
              has_sequence_privilege(role.oid, 'hl7_inbound_recovery_receipts_id_seq', 'USAGE') AS sequence_usage,
              has_sequence_privilege(role.oid, 'hl7_inbound_recovery_receipts_id_seq', 'SELECT') AS sequence_select,
              has_sequence_privilege(role.oid, 'hl7_inbound_recovery_receipts_id_seq', 'UPDATE') AS sequence_update,
              has_function_privilege(role.oid,
                'public.hl7_i03_length_prefixed_sha256(text[])', 'EXECUTE') AS can_execute_hash,
              has_function_privilege(role.oid,
                'public.assert_hl7_inbound_recovery_task(uuid,integer,bigint,uuid,uuid,text)',
                'EXECUTE') AS can_execute_task_assertion,
              has_function_privilege(role.oid,
                'public.validate_hl7_inbound_recovery_receipt()', 'EXECUTE') AS can_execute_receipt_trigger,
              has_function_privilege(role.oid,
                'public.validate_hl7_inbound_recovery_convergence()', 'EXECUTE') AS can_execute_convergence_trigger,
              has_function_privilege(role.oid,
                'public.hl7_inbound_recovery_receipt_append_only()', 'EXECUTE') AS can_execute_append_only_trigger
         FROM pg_roles AS role
        WHERE role.rolname IN ('vhhealth_app', 'vhhealth_runtime')
        ORDER BY role.rolname`,
    );
    for (const privilege of runtimePrivileges.rows) {
      expect(privilege).toEqual({
        rolname: privilege.rolname,
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_references: false,
        can_trigger: false,
        can_insert_allowed_column: true,
        can_insert_recorded_at: false,
        sequence_usage: true,
        sequence_select: true,
        sequence_update: false,
        can_execute_hash: false,
        can_execute_task_assertion: false,
        can_execute_receipt_trigger: false,
        can_execute_convergence_trigger: false,
        can_execute_append_only_trigger: false,
      });
    }
  });

  test('allows the raw NOBYPASSRLS role only its exact tenant context', async () => {
    await setRawContext(tenantId);
    const visible = await client.query(
      'SELECT id::text FROM hl7_inbound_recovery_receipts ORDER BY id',
    );
    expect(visible.rows).toEqual([{ id: positiveReceipt.id }]);
    await client.query('RESET ROLE');

    for (const context of [undefined, '', 'bypass',
      '00000000-0000-4000-8000-000000000001', 'not-a-uuid', otherTenantId]) {
      await setRawContext(context);
      const rows = await client.query(
        'SELECT COUNT(*)::integer AS count FROM hl7_inbound_recovery_receipts',
      );
      expect(rows.rows[0].count).toBe(0);
      await expectFailure(client, () => client.query(
        INSERT_RECEIPT_SQL,
        [pendingReceipt],
      ), { code: '42501' });
      await client.query('RESET ROLE');
    }

    await setRawContext(tenantId);
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [otherReceipt],
    ), { code: '42501' });
    await client.query('RESET ROLE');
  });

  test('rejects same-tenant drifted or wrong-family inbox provenance', async () => {
    await setRawContext(tenantId);
    for (const recoveryInboxId of [driftedInboxId, wrongFamilyInboxId]) {
      await expectFailure(client, () => client.query(
        INSERT_RECEIPT_SQL,
        [{ ...pendingReceipt, recovery_inbox_id: recoveryInboxId }],
      ), {
        code: '23514',
        constraint: 'chk_hl7_inbound_recovery_receipt_provenance',
      });
    }
    await client.query('RESET ROLE');
  });

  test('rejects cross-tenant and malformed reconciliation task evidence', async () => {
    await setRawContext(tenantId);
    expect(taskForgeryReceipts.map(forgery => forgery.label)).toEqual([
      'cross-tenant',
      'unrelated-inbox',
      'wrong-resource-type',
      'wrong-resource-id',
      'wrong-status',
      'wrong-priority',
      'non-null-sla',
    ]);
    for (const forgery of taskForgeryReceipts) {
      await expectFailure(client, () => client.query(
        INSERT_RECEIPT_SQL,
        [forgery.receipt],
      ), {
        code: '23514',
        constraint: 'chk_hl7_inbound_recovery_receipt_pending_task',
      });
    }
    await client.query('RESET ROLE');
  });

  test('denies trigger and policy alteration to the canonical raw role', async () => {
    await setRawContext(tenantId);
    await expectFailure(client, () => client.query(
      `ALTER TABLE public.hl7_inbound_recovery_receipts
         DISABLE TRIGGER hl7_inbound_recovery_receipt_append_only`,
    ), { code: '42501' });
    await expectFailure(client, () => client.query(
      `ALTER POLICY hl7_inbound_recovery_receipts_explicit_context
          ON public.hl7_inbound_recovery_receipts
       USING (true)`,
    ), { code: '42501' });
    await client.query('RESET ROLE');

    const protectedObjects = await client.query(
      `SELECT
         (SELECT trigger.tgenabled
            FROM pg_trigger AS trigger
           WHERE trigger.tgrelid = 'public.hl7_inbound_recovery_receipts'::regclass
             AND trigger.tgname = 'hl7_inbound_recovery_receipt_append_only')
           AS trigger_enabled,
         (SELECT policy.polpermissive
            FROM pg_policy AS policy
           WHERE policy.polrelid = 'public.hl7_inbound_recovery_receipts'::regclass
             AND policy.polname =
               'hl7_inbound_recovery_receipts_explicit_context')
           AS policy_permissive`,
    );
    expect(protectedObjects.rows[0]).toEqual({
      trigger_enabled: 'O',
      policy_permissive: false,
    });
  });

  test('rejects a cross-tenant patient link on an otherwise same-tenant receipt', async () => {
    await setRawContext(tenantId);
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, patient_uid: otherPatientUid }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_patient',
    });
    await client.query('RESET ROLE');
  });

  test('rejects forged credential, inbox, task, policy, and payload evidence', async () => {
    await setRawContext(tenantId);
    for (const signingCredentialId of [inactiveCredentialId, wrongKindCredentialId,
      otherCredentialId]) {
      await expectFailure(client, () => client.query(
        INSERT_RECEIPT_SQL,
        [{ ...pendingReceipt, signing_credential_id: String(signingCredentialId) }],
      ), {
        code: '23514',
        constraint: 'chk_hl7_inbound_recovery_receipt_credential',
      });
    }
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, recovery_inbox_id: otherReceipt.recovery_inbox_id }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_provenance',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, pending_task_id: String(wrongRoleTaskId) }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_pending_task',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, policy_signature: sha256('forged-policy') }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_provenance',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, payload_sha256: sha256('forged-payload') }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_provenance',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, ack_sha256: 'A'.repeat(64) }],
    ), { code: '23514', constraint: 'chk_hl7_inbound_recovery_receipts_hashes' });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, payload_ciphertext: pending.payload }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipts_shape',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, ack_ciphertext: 'enc:v1:legacy-ciphertext' }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipts_shape',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{ ...pendingReceipt, patient_uid: mergedPatientUid }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_patient',
    });
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{
        ...pendingReceipt,
        clock_evidence: {
          ...pendingReceipt.clock_evidence,
          source_clock_id: ` sender-clock-${suffix}`,
        },
      }],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipts_clock_evidence',
    });
    await client.query('RESET ROLE');
  });

  test.each([
    {
      field: 'policy_version',
      updateSql: `UPDATE event_consumer_offsets
                     SET policy_version = $3::text
                   WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      value: `${policyVersion}-mismatch`,
    },
    {
      field: 'policy_signature',
      updateSql: `UPDATE event_consumer_offsets
                     SET policy_signature = $3::text
                   WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      value: sha256(`i03-offset-policy-mismatch-${suffix}`),
    },
    {
      field: 'retention_policy',
      updateSql: `UPDATE event_consumer_offsets
                     SET retention_policy = $3::text
                   WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      value: `${retentionPolicy}-mismatch`,
    },
    {
      field: 'retention_until',
      updateSql: `UPDATE event_consumer_offsets
                     SET retention_until = $3::timestamptz
                   WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      value: new Date(Date.parse(retentionUntil) - 60_000).toISOString(),
    },
  ])('rejects canonical offset $field drift', async ({ updateSql, value }) => {
    await client.query('SAVEPOINT canonical_offset_retention_mismatch');
    try {
      const update = await client.query(updateSql, [tenantId, offsetId, value]);
      expect(update.rowCount).toBe(1);
      await setRawContext(tenantId);
      await expectFailure(client, () => client.query(
        INSERT_RECEIPT_SQL,
        [pendingReceipt],
      ), {
        code: '23514',
        constraint: 'chk_hl7_inbound_recovery_receipt_offset',
      });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT canonical_offset_retention_mismatch');
      await client.query('RELEASE SAVEPOINT canonical_offset_retention_mismatch');
      await client.query('RESET ROLE');
    }
  });

  test('keeps duplicate identity permanent while payload SHA remains the fingerprint', async () => {
    await setRawContext(tenantId);
    await expectFailure(client, () => client.query(
      INSERT_RECEIPT_SQL,
      [{
        ...pendingReceipt,
        message_control_id_sha256: positiveReceipt.message_control_id_sha256,
      }],
    ), {
      code: '23505',
      constraint: 'ux_hl7_inbound_recovery_receipts_duplicate_identity',
    });
    await client.query('RESET ROLE');
  });

  test('refuses a receipt that does not atomically terminalize inbox, task, and cursor', async () => {
    await setRawContext(tenantId);
    await expectFailure(client, async () => {
      await client.query(INSERT_RECEIPT_SQL, [pendingReceipt]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    }, {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_convergence',
    });
    await client.query('RESET ROLE');
  });

  test('server-enforces I03 BV partitions and active tenant credentials', async () => {
    const command = {
      tenant_id: tenantId,
      actor_uid: adminUid,
      actor_role: 'ADMIN',
      action_id: randomUUID(),
      offset_id: randomUUID(),
      action: 'register_offset',
      interface_family: 'I03',
      facility_scope: 'tenant',
      direction: 'inbound',
      generation: 1,
    };
    await setRawContext(tenantId);
    const malformed = await expectFailure(client, () => client.query(
      'SELECT external_recovery_operability_register_offset($1::jsonb)',
      [{ ...command, source_partition: 'i03/caller-selected/adt' }],
    ), { code: '23514' });
    expect(malformed.message).toContain('server-derived from a signing credential');
    const inactive = await expectFailure(client, () => client.query(
      'SELECT external_recovery_operability_register_offset($1::jsonb)',
      [{
        ...command,
        source_partition: `i03/credential/${inactiveCredentialId}/family/adt`,
      }],
    ), { code: '23514' });
    expect(inactive.message).toContain('active tenant HL7 signing credential');
    await client.query('RESET ROLE');
  });

  test('is append-only and blocks late admission/investigation writes', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE hl7_inbound_recovery_receipts
          SET status = status
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, positiveReceipt.id],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_append_only',
    });
    await expectFailure(client, () => client.query(
      `DELETE FROM hl7_inbound_recovery_receipts
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, positiveReceipt.id],
    ), {
      code: '23514',
      constraint: 'chk_hl7_inbound_recovery_receipt_append_only',
    });

    await setRawContext(tenantId);
    await expectFailure(client, () => client.query(
      `UPDATE hl7_inbound_recovery_receipts SET status = status
        WHERE id = $1::bigint`,
      [positiveReceipt.id],
    ), { code: '42501' });
    await expectFailure(client, () => client.query(
      'DELETE FROM hl7_inbound_recovery_receipts WHERE id = $1::bigint',
      [positiveReceipt.id],
    ), { code: '42501' });
    await client.query('RESET ROLE');

    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)",
    );
    for (const table of ['admissions', 'investigations']) {
      await expectFailure(client, () => client.query(
        `INSERT INTO ${table} DEFAULT VALUES`,
      ), {
        code: '23514',
        constraint: 'chk_external_recovery_late_effect_guard',
      });
    }
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', '', true)",
    );
  });

  test('credential deactivation cannot rewrite or invalidate retained receipts', async () => {
    await client.query(
      `UPDATE tenant_interop_secrets SET status = 'inactive', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, credentialId],
    );
    const retained = await client.query(
      `SELECT id::text, status FROM hl7_inbound_recovery_receipts
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, positiveReceipt.id],
    );
    expect(retained.rows).toEqual([{
      id: positiveReceipt.id,
      status: 'pending_review',
    }]);
  });
});
