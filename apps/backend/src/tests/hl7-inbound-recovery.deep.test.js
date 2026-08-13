import crypto, { randomUUID } from 'node:crypto';
import express from 'express';
import { Client } from 'pg';
import request from 'supertest';

import prisma, { ensureTenantRlsRuntimeRoleGrants, setTenantTx } from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import {
  I03_RECOVERY_SCHEMA,
  buildI03RecoverySignedPayload,
  enqueueHl7InboundRecovery,
  i03DuplicateKey,
  i03SourceToken,
  loadExactHl7InboundRecoveryAck,
  sha256Utf8,
} from '../services/integrations/externalHl7InboundRecoveryService.js';
import { canonicalCommandFingerprint } from '../services/integrations/externalInterfaceRecoveryService.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import {
  provisionTenantKek,
  resetTenantKekCacheForTesting,
  tenantKeyId,
} from '../services/security/tenantKekProvider.js';
import { encryptField, getKeyId } from '../utils/fieldEncryption.js';
import { getKekProvider } from '../utils/fieldKeyProvider.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from './helpers/externalRecoveryOperabilityTestHelper.js';

// The I03 ingress (live and recovery alike) is authoritative on
// HL7_INBOUND_ENABLED and fails closed when it is not exactly 'true'; declare
// the interface ON to exercise it. The refused-while-off contract lives in
// hl7-inbound-disabled.deep.test.js.
process.env.HL7_INBOUND_ENABLED = 'true';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const OTHER_PATIENT_UID = randomUUID();
const UNKNOWN_PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const RUNTIME_ROLE = `i03_runtime_${SUFFIX}`;
const POLICY = Object.freeze({
  policyVersion: 'c6-1-i03-test-v1',
  policySignature: `i03-test-signature-${SUFFIX}`,
  retentionPolicy: 'hl7-clinical-recovery-730d',
  retentionUntil: '2029-08-06T00:00:00.000Z',
});

function ownerDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/v1/hl7', hl7Routes);
  return app;
}

function messageFor({
  stream,
  family = stream.family,
  trigger = family === 'adt' ? 'A01' : 'O01',
  controlId,
  patientUid = PATIENT_UID,
  occurrence = family === 'adt'
    ? '20260806103045.123456+0530'
    : '20260806103145.654321+0530',
  note = null,
}) {
  const type = family === 'adt' ? `ADT^${trigger}` : 'ORM^O01';
  const segments = [
    `MSH|^~\\&|EXT|SRC|VH|${stream.facility}|${occurrence}||${type}|${controlId}|P|2.5|1042`,
  ];
  if (family === 'adt') segments.push(`EVN|${trigger}|${occurrence}`);
  segments.push(`PID|1||${patientUid}`);
  if (family === 'adt') {
    const pv1 = Array(46).fill('');
    pv1[0] = 'PV1';
    pv1[1] = '1';
    pv1[2] = 'I';
    pv1[3] = 'WARD-3';
    pv1[19] = `VISIT-${controlId}`;
    pv1[44] = occurrence;
    segments.push(pv1.join('|'));
  } else {
    const orc = Array(10).fill('');
    orc[0] = 'ORC';
    orc[1] = 'NW';
    orc[2] = `PLACER-${controlId}`;
    orc[9] = occurrence;
    segments.push(orc.join('|'));
    segments.push(`OBR|1|PLACER-${controlId}|FILLER-${controlId}|CBC^Complete Blood Count`);
  }
  if (note) segments.push(`NTE|1||${note}`);
  return segments.join('\r');
}

function recoveryFor({
  stream,
  message,
  controlId,
  family = stream.family,
  trigger = family === 'adt' ? 'A01' : 'O01',
  sourcePosition = '11',
  predecessorToken = stream.initialToken || 'a'.repeat(64),
  sourceObservedAt = family === 'adt'
    ? '2026-08-06T10:30:45.123456+05:30'
    : '2026-08-06T10:31:45.654321+05:30',
}) {
  const messageType = family === 'adt' ? 'ADT' : 'ORM';
  const messageSha256 = sha256Utf8(message);
  const duplicateKey = i03DuplicateKey({
    tenantId: TENANT_ID,
    signingCredentialId: stream.credential.id,
    messageFamily: family,
    messageType,
    triggerEvent: trigger,
    messageControlId: controlId,
  });
  const recovery = {
    schema: I03_RECOVERY_SCHEMA,
    interface_family: 'I03',
    arrival_class: 'recovery_backlog',
    tenant_id: TENANT_ID,
    signing_credential_id: stream.credential.id,
    offset_id: stream.offset.offset_id,
    source_partition: stream.sourcePartition,
    generation: 1,
    source_position: sourcePosition,
    source_token: '',
    predecessor_token: predecessorToken,
    duplicate_key: duplicateKey,
    message_family: family,
    message_type: messageType,
    trigger_event: trigger,
    message_control_id: controlId,
    message_sha256: messageSha256,
    source_observed_at: sourceObservedAt,
    source_received_at: family === 'adt'
      ? '2026-08-06T10:30:45.123999+05:30'
      : '2026-08-06T10:31:45.654999+05:30',
    clock_evidence: {
      source_clock_id: `i03-${SUFFIX}`,
      synchronized_at: '2026-08-06T10:29:00+05:30',
      maximum_error_ms: 1000,
    },
  };
  recovery.source_token = i03SourceToken({
    tenantId: TENANT_ID,
    sourcePartition: stream.sourcePartition,
    generation: 1,
    sourcePosition,
    predecessorToken,
    duplicateKey,
    messageSha256,
  });
  return recovery;
}

function signedPayloadHeaders(stream, signedPayload, prefix = `i03-${SUFFIX}`) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `${prefix}-${randomUUID()}`;
  const signature = crypto.createHmac('sha256', stream.secret)
    .update(`${timestamp}.${requestId}.${signedPayload}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

function signedHeaders(stream, body, prefix) {
  return signedPayloadHeaders(
    stream,
    buildI03RecoverySignedPayload(body).signedPayload,
    prefix,
  );
}

function uncheckedSignedHeaders(stream, body, prefix) {
  const signedPayload = `${I03_RECOVERY_SCHEMA}\n${sha256Utf8(body.message)}\n${canonicalCommandFingerprint(body.recovery)}`;
  return signedPayloadHeaders(stream, signedPayload, prefix);
}

function liveHeaders(stream, message) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `i03-live-${SUFFIX}-${randomUUID()}`;
  const signature = crypto.createHmac('sha256', stream.secret)
    .update(`${timestamp}.${requestId}.${message}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

async function createStream(label, family = 'adt', {
  marker = true,
  credentialSource = null,
} = {}) {
  const facility = credentialSource?.facility || `I03-${label}-${SUFFIX}`;
  const secret = credentialSource?.secret || `i03-${label}-${SUFFIX}-secret`;
  if (!credentialSource) {
    await upsertInteropSecret({
      tenantId: TENANT_ID,
      kind: 'hl7_inbound',
      senderIdentifier: facility,
      secret,
    });
  }
  const credential = credentialSource?.credential
    || await resolveInteropCredentialSnapshot('hl7_inbound', facility);
  const sourcePartition = `i03/credential/${credential.id}/family/${family}`;
  const initialToken = marker ? sha256Utf8(`i03:${label}:position:10`) : null;
  const offset = await registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: 'I03',
    sourcePartition,
    generation: 1,
    initialPosition: marker ? '10' : null,
    initialToken,
    retainedFromPosition: marker ? '10' : null,
    retainedFromToken: initialToken,
    ...POLICY,
  });
  return Object.freeze({ family, facility, secret, credential, sourcePartition, initialToken, offset });
}

async function forceOffsetState(stream, recoveryState) {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    await client.query(
      `UPDATE event_consumer_offsets
          SET recovery_state = $3::text,
              reconciliation_reason = 'i03_live_fence_state_fixture'
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      [TENANT_ID, stream.offset.offset_id, recoveryState],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function authorize(stream, recovery) {
  return authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId: stream.offset.offset_id,
    interfaceFamily: 'I03',
    resumeCutoffPosition: recovery.source_position,
    resumeCutoffToken: recovery.source_token,
  });
}

async function countStream(stream) {
  const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM pathway_projector_inbox
         WHERE tenant_id = $1::uuid AND scope_kind = 'external_interface'
           AND interface_family = 'I03' AND source_partition = $2::text) AS inboxes,
       (SELECT COUNT(*)::integer FROM hl7_inbound_recovery_receipts
         WHERE tenant_id = $1::uuid AND source_partition = $2::text) AS receipts,
       (SELECT COUNT(*)::integer
          FROM tasks t
          JOIN hl7_inbound_recovery_receipts r
            ON r.tenant_id = t.tenant_id AND r.pending_task_id = t.id
         WHERE r.tenant_id = $1::uuid
           AND r.source_partition = $2::text
           AND t.related_resource_type = 'hl7_inbound_recovery_receipt'
           AND t.metadata ->> 'message_family' = $3::text) AS tasks`,
    TENANT_ID,
    stream.sourcePartition,
    stream.family,
  ));
  return rows[0];
}

async function countOffset(stream) {
  const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
    `SELECT
       COUNT(DISTINCT inbox.inbox_id)::integer AS inboxes,
       COUNT(DISTINCT receipt.id)::integer AS receipts,
       COUNT(DISTINCT task.id)::integer AS tasks
       FROM pathway_projector_inbox AS inbox
       LEFT JOIN hl7_inbound_recovery_receipts AS receipt
         ON receipt.tenant_id = inbox.tenant_id
        AND receipt.recovery_inbox_id = inbox.inbox_id
       LEFT JOIN tasks AS task
         ON task.tenant_id = receipt.tenant_id
        AND task.id = receipt.pending_task_id
      WHERE inbox.tenant_id = $1::uuid AND inbox.offset_id = $2::uuid`,
    TENANT_ID,
    stream.offset.offset_id,
  ));
  return rows[0];
}

async function clinicalCounts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
       (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations,
       (SELECT COUNT(*)::integer
          FROM tasks
         WHERE tenant_id = $1::uuid
           AND related_resource_type = 'hl7_inbound_recovery_receipt'
           AND metadata ->> 'interface_family' = 'I03') AS i03_tasks`,
    TENANT_ID,
  );
  return rows[0];
}

async function lateEffectCounts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
       (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations,
       (SELECT COUNT(*)::integer FROM clinical_timeline_events WHERE tenant_id = $1::uuid) AS timeline,
       (SELECT COUNT(*)::integer FROM clinical_audit_events WHERE tenant_id = $1::uuid) AS audit,
       (SELECT COUNT(*)::integer FROM event_outbox WHERE tenant_id = $1::uuid) AS outbox,
       (SELECT COUNT(*)::integer FROM webhook_deliveries WHERE tenant_id = $1::uuid) AS webhooks,
       (SELECT COUNT(*)::integer FROM notification_outbox WHERE tenant_id = $1::uuid) AS notification_outbox,
       (SELECT COUNT(*)::integer FROM notifications WHERE tenant_id = $1::uuid) AS notifications,
       (SELECT COUNT(*)::integer FROM workflow_sla_instances WHERE tenant_id = $1::uuid) AS slas,
       (SELECT COUNT(*)::integer FROM care_pathway_instances WHERE tenant_id = $1::uuid) AS pathways,
       (SELECT COUNT(*)::integer FROM care_pathway_transition_events WHERE tenant_id = $1::uuid) AS transitions,
       (SELECT COUNT(*)::integer FROM clinical_alerts WHERE tenant_id = $1::uuid) AS clinical_alerts,
       (SELECT COUNT(*)::integer FROM lab_critical_alerts WHERE tenant_id = $1::uuid) AS lab_alerts,
       (SELECT COUNT(*)::integer FROM virtual_ward_escalations WHERE tenant_id = $1::uuid) AS escalations`,
    TENANT_ID,
  );
  return rows[0];
}

describeIfDb('C6.1 I03 inbound HL7 recovery', () => {
  let app;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I03 recovery tenant'),
              ($3::uuid, $4::text, 'I03 other tenant')`,
      TENANT_ID,
      `i03-${SUFFIX}`,
      OTHER_TENANT_ID,
      `i03-other-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text, 'I03 same-tenant patient', 'PATIENT', TRUE, 'active', NOW()),
         ($4::uuid, $5::uuid, $6::text, 'I03 other-tenant patient', 'PATIENT', TRUE, 'active', NOW())`,
      PATIENT_UID,
      TENANT_ID,
      `91${SUFFIX.slice(0, 10)}`,
      OTHER_PATIENT_UID,
      OTHER_TENANT_ID,
      `92${SUFFIX.slice(0, 10)}`,
    );
    await provisionTenantKek(TENANT_ID);
    app = buildApp();
  }, 60_000);

  afterAll(async () => {
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const [sql, params] of [
        [`DELETE FROM hl7_inbound_recovery_receipts WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM tasks WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM event_consumer_offsets WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM external_recovery_operability_actions WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound' AND request_id LIKE $1::text`, [`i03-${SUFFIX}-%`]],
        [`DELETE FROM tenant_interop_secrets WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM admissions WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM investigations WHERE tenant_id = $1::uuid`, [TENANT_ID]],
        [`DELETE FROM users WHERE tenant_id IN ($1::uuid, $2::uuid)`, [TENANT_ID, OTHER_TENANT_ID]],
        [`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, [TENANT_ID, OTHER_TENANT_ID]],
      ]) {
        await client.query(sql, params);
      }
      const runtimeRole = await client.query(
        `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text`,
        [RUNTIME_ROLE],
      );
      if (runtimeRole.rowCount === 1) {
        await client.query(`DROP OWNED BY ${RUNTIME_ROLE}`);
        await client.query(`DROP ROLE ${RUNTIME_ROLE}`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  test('returns the byte-identical stored ACK on exact retry after ready', async () => {
    const stream = await createStream('ack-ready');
    const controlId = `ACK-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS admissions
         FROM admissions
        WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );

    const first = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    const afterFirstEffects = await lateEffectCounts();
    resetTenantKekCacheForTesting();
    getKekProvider().evictKek(tenantKeyId(TENANT_ID));
    const retry = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(first.status);
    expect(first.headers['content-type']).toContain('application/hl7-v2');
    expect(retry.headers['content-type']).toContain('application/hl7-v2');
    expect(first.text).toContain('MSA|AA');
    expect(Buffer.from(retry.text, 'utf8')).toEqual(Buffer.from(first.text, 'utf8'));
    expect(await lateEffectCounts()).toEqual(afterFirstEffects);
    expect(await countStream(stream)).toEqual({ inboxes: 1, receipts: 1, tasks: 1 });
    const evidence = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT o.recovery_state, o.high_water_position::text,
              r.ack_sha256::text, r.ack_bytes, r.ack_code, r.http_status,
              r.payload_ciphertext, r.ack_ciphertext,
              t.workflow_sla_instance_id, t.due_at, t.sla_completion_semantics
         FROM event_consumer_offsets o
         JOIN hl7_inbound_recovery_receipts r
           ON r.tenant_id = o.tenant_id AND r.source_partition = o.source_partition
         JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.pending_task_id
        WHERE o.tenant_id = $1::uuid AND o.offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(evidence[0]).toMatchObject({
      recovery_state: 'ready',
      high_water_position: '11',
      ack_sha256: sha256Utf8(first.text),
      ack_bytes: Buffer.byteLength(first.text, 'utf8'),
      ack_code: 'AA',
      http_status: 200,
      workflow_sla_instance_id: null,
      due_at: null,
      sla_completion_semantics: 'none',
    });
    expect(getKeyId(evidence[0].payload_ciphertext)).toBe(tenantKeyId(TENANT_ID));
    expect(getKeyId(evidence[0].ack_ciphertext)).toBe(tenantKeyId(TENANT_ID));

    const liveControlId = `READY-LIVE-A01-${SUFFIX}`;
    const liveMessage = messageFor({ stream, controlId: liveControlId });
    const live = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(stream, liveMessage))
      .send({ message: liveMessage });
    expect(live.status).toBe(200);
    expect(live.text).toContain('MSA|AA');
    const after = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS admissions
         FROM admissions
        WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    expect(after[0].admissions).toBe(before[0].admissions + 1);
  }, 60_000);

  test('quarantines conflicting signed recovery after ready while preserving exact retry evidence', async () => {
    const stream = await createStream('ready-new-recovery');
    const controlId = `READY-BASE-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);

    const accepted = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');
    const terminalCounts = await countStream(stream);
    const terminalEffects = await lateEffectCounts();

    const newControlId = `READY-NEW-${SUFFIX}`;
    const newMessage = messageFor({ stream, controlId: newControlId });
    const newRecovery = recoveryFor({
      stream,
      message: newMessage,
      controlId: newControlId,
      sourcePosition: '12',
      predecessorToken: recovery.source_token,
    });
    const newBody = { message: newMessage, recovery: newRecovery };
    const newResponse = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, newBody))
      .send(newBody);

    const conflictingMessage = messageFor({
      stream,
      controlId,
      note: 'changed evidence after terminal readiness',
    });
    const conflictingRecovery = recoveryFor({
      stream,
      message: conflictingMessage,
      controlId,
      sourcePosition: '12',
      predecessorToken: recovery.source_token,
    });
    const conflictingBody = { message: conflictingMessage, recovery: conflictingRecovery };
    const conflictingResponse = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, conflictingBody))
      .send(conflictingBody);

    for (const response of [
      newResponse,
      conflictingResponse,
    ]) {
      expect(response.status).toBe(409);
      expect(response.text).toContain('MSA|AE');
      expect(response.text).not.toContain('MSA|AA');
    }
    const exactRetry = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(exactRetry.status).toBe(200);
    expect(Buffer.from(exactRetry.text, 'utf8')).toEqual(Buffer.from(accepted.text, 'utf8'));
    expect(await countStream(stream)).toEqual(terminalCounts);
    expect(await lateEffectCounts()).toEqual(terminalEffects);
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason,
              high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state[0]).toMatchObject({
      recovery_state: 'reconciliation_required_source_gap',
      reconciliation_reason: 'duplicate_or_position_fingerprint_conflict',
      high_water_position: recovery.source_position,
      high_water_token: recovery.source_token,
    });
  }, 60_000);

  test.each([
    [
      'source_received_at',
      'ready',
      'received-at',
      value => ({ ...value, source_received_at: '2026-08-06T10:30:45.124000+05:30' }),
    ],
    [
      'clock_evidence',
      'ready',
      'clock',
      value => ({
        ...value,
        clock_evidence: {
          ...value.clock_evidence,
          maximum_error_ms: value.clock_evidence.maximum_error_ms + 1,
        },
      }),
    ],
    [
      'source_received_at',
      'replaying',
      'received-at-replaying',
      value => ({ ...value, source_received_at: '2026-08-06T10:30:45.124000+05:30' }),
    ],
  ])('quarantines a re-signed exact-message retry with changed %s while %s', async (
    _label,
    initialRecoveryState,
    streamSuffix,
    mutateRecovery,
  ) => {
    const stream = await createStream(`ready-evidence-${streamSuffix}`);
    const controlId = `READY-EVIDENCE-${streamSuffix.toUpperCase()}-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    if (initialRecoveryState === 'replaying') {
      await authorizeExternalRecoveryResume({
        tenantId: TENANT_ID,
        offsetId: stream.offset.offset_id,
        interfaceFamily: 'I03',
        resumeCutoffPosition: '12',
        resumeCutoffToken: sha256Utf8(`future-cutoff-${streamSuffix}`),
      });
    } else {
      await authorize(stream, recovery);
    }
    const accepted = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');
    const beforeConflictState = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(beforeConflictState).toEqual([{ recovery_state: initialRecoveryState }]);
    const terminalCounts = await countStream(stream);
    const terminalEffects = await lateEffectCounts();

    const changedBody = { message, recovery: mutateRecovery(recovery) };
    const changed = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, changedBody))
      .send(changedBody);
    expect(changed.status).toBe(409);
    expect(changed.text).toContain('MSA|AE');
    expect(changed.text).not.toContain('MSA|AA');

    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason,
              high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{
      recovery_state: 'reconciliation_required_source_gap',
      reconciliation_reason: 'exact_retry_evidence_conflict',
      high_water_position: recovery.source_position,
      high_water_token: recovery.source_token,
    }]);

    const exactRetry = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(exactRetry.status).toBe(200);
    expect(Buffer.from(exactRetry.text, 'utf8')).toEqual(Buffer.from(accepted.text, 'utf8'));
    expect(await countStream(stream)).toEqual(terminalCounts);
    expect(await lateEffectCounts()).toEqual(terminalEffects);
  }, 60_000);

  test.each([
    ['the enqueue fast path', 'http'],
    ['the stored-ACK loader', 'loader'],
  ])('closes exact handled retry at %s when recovery_state is retired', async (_label, guardPath) => {
    const stream = await createStream(`retired-${guardPath}`);
    const controlId = `RETIRED-${guardPath.toUpperCase()}-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const accepted = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');
    const terminalCounts = await countStream(stream);
    const terminalEffects = await lateEffectCounts();

    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE event_consumer_offsets
            SET recovery_state = 'retired', intake_retired_at = NULL
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        [TENANT_ID, stream.offset.offset_id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }

    const retiredState = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, (intake_retired_at IS NOT NULL) AS intake_retired
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(retiredState).toEqual([{ recovery_state: 'retired', intake_retired: false }]);

    if (guardPath === 'loader') {
      const inbox = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT inbox_id::text
           FROM pathway_projector_inbox
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
            AND interface_family = 'I03' AND status = 'handled'`,
        TENANT_ID,
        stream.offset.offset_id,
      ));
      await expect(loadExactHl7InboundRecoveryAck({
        tenantId: TENANT_ID,
        recoveryInboxId: inbox[0].inbox_id,
      })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OFFSET_RETIRED' });
    }

    const retry = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(retry.status).toBe(409);
    expect(retry.text).toContain('MSA|AE');
    expect(retry.text).not.toContain('MSA|AA');
    expect(await countStream(stream)).toEqual(terminalCounts);
    expect(await lateEffectCounts()).toEqual(terminalEffects);
    expect(await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, (intake_retired_at IS NOT NULL) AS intake_retired
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ))).toEqual([{ recovery_state: 'retired', intake_retired: false }]);
  }, 60_000);

  test('refuses an exact handled retry when its stored ACK is not tenant-key encrypted', async () => {
    const stream = await createStream('ack-global-kid');
    const controlId = `ACK-GLOBAL-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const first = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(first.status).toBe(200);

    const globalCiphertext = encryptField(first.text, { tenantId: null });
    expect(getKeyId(globalCiphertext)).not.toBe(tenantKeyId(TENANT_ID));
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE hl7_inbound_recovery_receipts
            SET ack_ciphertext = $3::text
          WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
        [TENANT_ID, stream.sourcePartition, globalCiphertext],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }

    const retry = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(retry.status).toBe(409);
    expect(retry.text).toContain('MSA|AE');
    expect(retry.text).not.toContain('MSA|AA');
    expect(await countStream(stream)).toEqual({ inboxes: 1, receipts: 1, tasks: 1 });
  }, 60_000);

  test.each([
    ['payload ciphertext', 'payload_ciphertext = ack_ciphertext'],
    ['payload byte count', 'payload_bytes = payload_bytes + 1'],
    ['MSH-10 hash', "message_control_id_sha256 = repeat('f', 64)"],
    [
      'signing credential id',
      `signing_credential_id = signing_credential_id + 1000000,
       source_partition = 'i03/credential/' || (signing_credential_id + 1000000)::text
         || '/family/' || message_family`,
    ],
  ])('refuses an exact handled retry with corrupted stored %s evidence', async (
    label,
    assignment,
  ) => {
    const stream = await createStream(`retry-corrupt-${label.replaceAll(' ', '-')}`);
    const controlId = `RETRY-CORRUPT-${label.replaceAll(' ', '-').toUpperCase()}-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const accepted = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');
    const terminalEffects = await lateEffectCounts();

    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE hl7_inbound_recovery_receipts
            SET ${assignment}
          WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
        [TENANT_ID, stream.sourcePartition],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }

    const retry = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(retry.status).toBe(409);
    expect(retry.text).toContain('MSA|AE');
    expect(retry.text).not.toContain('MSA|AA');
    expect(await countOffset(stream)).toEqual({ inboxes: 1, receipts: 1, tasks: 1 });
    expect(await lateEffectCounts()).toEqual(terminalEffects);
  }, 60_000);

  test('holds a fresh crash lease, then takes over the same canonical row after expiry', async () => {
    const stream = await createStream('pending');
    const controlId = `PENDING-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const crashedLeaseOwner = randomUUID();
    await enqueueHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: stream.credential,
      leaseOwner: crashedLeaseOwner,
    });

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);

    expect(response.status).toBe(409);
    expect(response.text).toContain('MSA|AE');
    expect(response.text).not.toContain('MSA|AA');
    expect(await countStream(stream)).toEqual({ inboxes: 1, receipts: 0, tasks: 0 });
    let rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT status, attempts, lease_owner::text,
              (lease_expires_at > NOW()) AS lease_active
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
      TENANT_ID,
      stream.sourcePartition,
    ));
    expect(rows).toEqual([{
      status: 'pending',
      attempts: 0,
      lease_owner: crashedLeaseOwner,
      lease_active: true,
    }]);

    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
      TENANT_ID,
      stream.sourcePartition,
    ));
    const takeover = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);
    expect(takeover.status).toBe(200);
    expect(takeover.text).toContain('MSA|AA');
    expect(await countStream(stream)).toEqual({ inboxes: 1, receipts: 1, tasks: 1 });
    rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT i.status, i.attempts, i.lease_owner::text,
              o.high_water_position::text, o.recovery_state
         FROM pathway_projector_inbox AS i
         JOIN event_consumer_offsets AS o
           ON o.tenant_id = i.tenant_id AND o.offset_id = i.offset_id
        WHERE i.tenant_id = $1::uuid AND i.source_partition = $2::text`,
      TENANT_ID,
      stream.sourcePartition,
    ));
    expect(rows).toEqual([{
      status: 'handled',
      attempts: 1,
      lease_owner: null,
      high_water_position: '11',
      recovery_state: 'ready',
    }]);
  }, 60_000);

  test('holds a registered marker absence without inventing a cursor', async () => {
    const stream = await createStream('missing-marker', 'adt', { marker: false });
    const controlId = `MISSING-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId, sourcePosition: '1' });
    const body = { message, recovery };
    const before = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);

    expect(response.status).toBe(409);
    expect(response.text).toContain('MSA|AE');
    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason,
              high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(rows[0]).toEqual({
      recovery_state: 'reconciliation_required_missing_marker',
      reconciliation_reason: 'marker_absent',
      high_water_position: null,
      high_water_token: null,
    });
    const liveControlId = `MISSING-LIVE-${SUFFIX}`;
    const liveMessage = messageFor({ stream, controlId: liveControlId });
    const live = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(stream, liveMessage))
      .send({ message: liveMessage });
    expect(live.status).toBe(409);
    expect(live.text).toContain('MSA|AE');
    const after = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    expect(after).toEqual(before);
  }, 60_000);

  test('fences omitted recovery envelopes while an authorized cursor is replaying', async () => {
    const stream = await createStream('replaying-live-fence');
    const recoveryControlId = `REPLAYING-CUTOFF-${SUFFIX}`;
    const recoveryMessage = messageFor({ stream, controlId: recoveryControlId });
    const recovery = recoveryFor({
      stream,
      message: recoveryMessage,
      controlId: recoveryControlId,
    });
    await authorize(stream, recovery);
    const before = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    const liveControlId = `REPLAYING-LIVE-${SUFFIX}`;
    const liveMessage = messageFor({ stream, controlId: liveControlId });
    const live = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(stream, liveMessage))
      .send({ message: liveMessage });

    expect(live.status).toBe(409);
    expect(live.text).toContain('MSA|AE');
    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{ recovery_state: 'replaying' }]);
    const after = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    expect(after).toEqual(before);
  }, 60_000);

  test.each([
    'reconciliation_required_retention_gap',
    'reconciliation_required_provider_state',
  ])('fences omitted recovery envelopes in %s', async (recoveryState) => {
    const stream = await createStream(recoveryState.replaceAll('_', '-'));
    await forceOffsetState(stream, recoveryState);
    const before = await clinicalCounts();
    const controlId = `${recoveryState.toUpperCase()}-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(stream, message))
      .send({ message });

    expect(response.status).toBe(409);
    expect(response.text).toContain('MSA|AE');
    expect(response.text).not.toContain('MSA|AA');
    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    expect(await clinicalCounts()).toEqual(before);
  }, 60_000);

  test('refuses a valid signed recovery envelope while its marker-present offset is paused', async () => {
    const stream = await createStream('paused-envelope');
    const controlId = `PAUSED-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);

    expect(response.status).toBe(409);
    expect(response.text).toContain('MSA|AE');
    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, high_water_position::text, high_water_token,
              resume_cutoff_position::text, resume_cutoff_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(rows[0]).toEqual({
      recovery_state: 'paused',
      high_water_position: '10',
      high_water_token: stream.initialToken,
      resume_cutoff_position: null,
      resume_cutoff_token: null,
    });
  }, 60_000);

  test('does not turn a paused offset into source-gap reconciliation when changed evidence collides', async () => {
    const stream = await createStream('paused-collision');
    const controlId = `PAUSED-COLLISION-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    await authorize(stream, recovery);
    await enqueueHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: stream.credential,
    });
    await forceOffsetState(stream, 'paused');
    const before = await clinicalCounts();

    const conflictingMessage = messageFor({
      stream,
      controlId,
      note: 'changed evidence while owner pause is active',
    });
    const conflictingRecovery = recoveryFor({
      stream,
      message: conflictingMessage,
      controlId,
    });
    const conflictingBody = { message: conflictingMessage, recovery: conflictingRecovery };
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, conflictingBody))
      .send(conflictingBody);

    expect(response.status).toBe(409);
    expect(response.text).toContain('MSA|AE');
    expect(await countStream(stream)).toEqual({ inboxes: 1, receipts: 0, tasks: 0 });
    expect(await clinicalCounts()).toEqual(before);
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason,
              high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{
      recovery_state: 'paused',
      reconciliation_reason: 'i03_live_fence_state_fixture',
      high_water_position: '10',
      high_water_token: stream.initialToken,
    }]);
  }, 60_000);

  test('fails closed when replaying is forced without an owner-authorized resume cutoff', async () => {
    const stream = await createStream('missing-resume-cutoff');
    const controlId = `MISSING-CUTOFF-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    await forceOffsetState(stream, 'replaying');
    const before = await clinicalCounts();

    await expect(enqueueHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: stream.credential,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_RESUME_CUTOFF_MISSING' });

    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    expect(await clinicalCounts()).toEqual(before);
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, resume_cutoff_position::text, resume_cutoff_token,
              high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{
      recovery_state: 'replaying',
      resume_cutoff_position: null,
      resume_cutoff_token: null,
      high_water_position: '10',
      high_water_token: stream.initialToken,
    }]);
  }, 60_000);

  test('concurrent items beyond the signed cutoff create no inbox and quarantine the offset once', async () => {
    const stream = await createStream('beyond-cutoff-race');
    const cutoffControlId = `CUTOFF-BOUNDARY-${SUFFIX}`;
    const cutoffMessage = messageFor({ stream, controlId: cutoffControlId });
    const cutoffRecovery = recoveryFor({ stream, message: cutoffMessage, controlId: cutoffControlId });
    await authorize(stream, cutoffRecovery);
    const before = await clinicalCounts();
    const contenders = [`BEYOND-A-${SUFFIX}`, `BEYOND-B-${SUFFIX}`].map(controlId => {
      const message = messageFor({ stream, controlId });
      return {
        message,
        recovery: recoveryFor({
          stream,
          message,
          controlId,
          sourcePosition: '12',
          predecessorToken: cutoffRecovery.source_token,
        }),
      };
    });

    const attempts = await Promise.allSettled(contenders.map(command => enqueueHl7InboundRecovery({
      ...command,
      credentialSnapshot: stream.credential,
    })));

    expect(attempts.every(result => result.status === 'rejected')).toBe(true);
    expect(attempts.some(result => result.reason?.code === 'EXTERNAL_RECOVERY_RESUME_CUTOFF_EXCEEDED'))
      .toBe(true);
    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    expect(await clinicalCounts()).toEqual(before);
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason,
              high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{
      recovery_state: 'reconciliation_required_source_gap',
      reconciliation_reason: 'source_position_exceeds_resume_cutoff',
      high_water_position: '10',
      high_water_token: stream.initialToken,
    }]);
  }, 60_000);

  test('rejects a wrong terminal token and holds the cursor below the signed cutoff', async () => {
    const stream = await createStream('wrong-terminal-token');
    const controlId = `WRONG-CUTOFF-TOKEN-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const signedWrongToken = recovery.source_token === 'f'.repeat(64)
      ? 'e'.repeat(64)
      : 'f'.repeat(64);
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: stream.offset.offset_id,
      interfaceFamily: 'I03',
      resumeCutoffPosition: recovery.source_position,
      resumeCutoffToken: signedWrongToken,
    });
    const before = await clinicalCounts();

    await expect(enqueueHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: stream.credential,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_RESUME_CUTOFF_TOKEN_MISMATCH' });

    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    expect(await clinicalCounts()).toEqual(before);
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason,
              high_water_position::text, high_water_token,
              resume_cutoff_position::text, resume_cutoff_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{
      recovery_state: 'reconciliation_required_source_gap',
      reconciliation_reason: 'resume_cutoff_token_mismatch',
      high_water_position: '10',
      high_water_token: stream.initialToken,
      resume_cutoff_position: '11',
      resume_cutoff_token: signedWrongToken,
    }]);
  }, 60_000);

  test('rejects a stale signature after every recovery/clock field or message-byte mutation', async () => {
    const stream = await createStream('stale-signature-matrix');
    const controlId = `STALE-SIGNATURE-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    const headers = signedHeaders(stream, body, `i03-${SUFFIX}-stale`);
    const before = await clinicalCounts();
    const recoveryMutations = [
      ['schema', value => ({ ...value, schema: 'vhhealth.i03.adt-orm-sequence/v2' })],
      ['interface_family', value => ({ ...value, interface_family: 'I04' })],
      ['arrival_class', value => ({ ...value, arrival_class: 'live' })],
      ['tenant_id', value => ({ ...value, tenant_id: OTHER_TENANT_ID })],
      ['signing_credential_id', value => ({ ...value, signing_credential_id: String(Number(value.signing_credential_id) + 1) })],
      ['offset_id', value => ({ ...value, offset_id: randomUUID() })],
      ['source_partition', value => ({ ...value, source_partition: `${value.source_partition}/changed` })],
      ['generation', value => ({ ...value, generation: value.generation + 1 })],
      ['source_position', value => ({ ...value, source_position: '12' })],
      ['source_token', value => ({ ...value, source_token: 'b'.repeat(64) })],
      ['predecessor_token', value => ({ ...value, predecessor_token: 'c'.repeat(64) })],
      ['duplicate_key', value => ({ ...value, duplicate_key: 'd'.repeat(64) })],
      ['message_family', value => ({ ...value, message_family: 'orm' })],
      ['message_type', value => ({ ...value, message_type: 'ORM' })],
      ['trigger_event', value => ({ ...value, trigger_event: 'O01' })],
      ['message_control_id', value => ({ ...value, message_control_id: `${controlId}-CHANGED` })],
      ['message_sha256', value => ({ ...value, message_sha256: 'e'.repeat(64) })],
      ['source_observed_at', value => ({ ...value, source_observed_at: '2026-08-06T10:30:46.123456+05:30' })],
      ['source_received_at', value => ({ ...value, source_received_at: '2026-08-06T10:30:46.123999+05:30' })],
      ['clock_evidence.source_clock_id', value => ({
        ...value,
        clock_evidence: { ...value.clock_evidence, source_clock_id: `${value.clock_evidence.source_clock_id}-changed` },
      })],
      ['clock_evidence.synchronized_at', value => ({
        ...value,
        clock_evidence: { ...value.clock_evidence, synchronized_at: '2026-08-06T10:28:00+05:30' },
      })],
      ['clock_evidence.maximum_error_ms', value => ({
        ...value,
        clock_evidence: { ...value.clock_evidence, maximum_error_ms: value.clock_evidence.maximum_error_ms + 1 },
      })],
    ];
    const cases = recoveryMutations.map(([label, mutate]) => [
      label,
      { message, recovery: mutate(recovery) },
    ]);
    cases.push(['message byte', { message: `${message}\rNTE|1||changed`, recovery }]);

    for (const [, changedBody] of cases) {
      const response = await request(app)
        .post('/api/v1/hl7/receive')
        .set(headers)
        .send(changedBody);
      expect([400, 401, 403]).toContain(response.status);
      expect(response.text).toContain('MSA|AR');
      expect(response.text).not.toContain('MSA|AA');
      expect(response.text).not.toContain('MSA|AE');
    }

    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    const replay = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM interop_replay_guard
        WHERE namespace = 'hl7-inbound'
          AND request_id LIKE $1::text`,
      `${headers['x-hl7-message-id']}:%`,
    );
    expect(replay).toEqual([{ count: 0 }]);
    expect(await clinicalCounts()).toEqual(before);
  }, 60_000);

  test('correct signatures cannot make unknown, cased, or coerced recovery shapes fall through live ingress', async () => {
    const stream = await createStream('signed-invalid-shapes');
    const controlId = `SIGNED-INVALID-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const recovery = recoveryFor({ stream, message, controlId });
    const before = await clinicalCounts();
    const cases = [
      ['top-level unknown', { message, recovery, mode: 'recover' }],
      ['recovery unknown', { message, recovery: { ...recovery, inferred_head: true } }],
      ['clock unknown', {
        message,
        recovery: {
          ...recovery,
          clock_evidence: { ...recovery.clock_evidence, offset_ms: 1 },
        },
      }],
      ['casing alias', {
        message,
        recovery: Object.fromEntries(Object.entries(recovery).map(([key, value]) => (
          key === 'tenant_id' ? ['tenantId', value] : [key, value]
        ))),
      }],
      ['numeric credential', { message, recovery: { ...recovery, signing_credential_id: Number(recovery.signing_credential_id) } }],
      ['leading-zero credential', { message, recovery: { ...recovery, signing_credential_id: `0${recovery.signing_credential_id}` } }],
      ['string generation', { message, recovery: { ...recovery, generation: String(recovery.generation) } }],
      ['numeric position', { message, recovery: { ...recovery, source_position: Number(recovery.source_position) } }],
      ['string clock error', {
        message,
        recovery: {
          ...recovery,
          clock_evidence: {
            ...recovery.clock_evidence,
            maximum_error_ms: String(recovery.clock_evidence.maximum_error_ms),
          },
        },
      }],
      ['uppercase UUID', { message, recovery: { ...recovery, tenant_id: recovery.tenant_id.toUpperCase() } }],
      ['uppercase hash', { message, recovery: { ...recovery, message_sha256: recovery.message_sha256.toUpperCase() } }],
    ];

    for (const [_label, changedBody] of cases) {
      const response = await request(app)
        .post('/api/v1/hl7/receive')
        .set(uncheckedSignedHeaders(stream, changedBody, `i03-${SUFFIX}-invalid`))
        .send(changedBody);
      expect(response.status).toBe(400);
      expect(response.text).toContain('MSA|AR');
      expect(response.text).not.toContain('MSA|AA');
    }

    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    const replay = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM interop_replay_guard
        WHERE namespace = 'hl7-inbound'
          AND request_id LIKE $1::text`,
      `i03-${SUFFIX}-invalid-%`,
    );
    expect(replay).toEqual([{ count: 0 }]);
    expect(await clinicalCounts()).toEqual(before);
  }, 60_000);

  test.each([
    ['unknown offset id', 'offset', 409, 'replaying'],
    ['offset bound to another canonical partition', 'other-partition-offset', 409, 'replaying'],
    ['non-canonical source partition', 'partition', 400, 'replaying'],
    ['wrong generation', 'generation', 409, 'replaying'],
    ['position beyond owner cutoff', 'position', 409, 'reconciliation_required_source_gap'],
    ['wrong predecessor chain', 'predecessor', 409, 'reconciliation_required_source_gap'],
    ['wrong canonical-form source token', 'source-token', 400, 'replaying'],
  ])('rejects correctly signed DB/evidence mismatch: %s', async (
    _label,
    mismatch,
    expectedStatus,
    expectedState,
  ) => {
    const stream = await createStream(`signed-equality-${mismatch}`);
    const controlId = `SIGNED-EQUALITY-${mismatch.toUpperCase()}-${SUFFIX}`;
    const message = messageFor({ stream, controlId });
    const baseline = recoveryFor({ stream, message, controlId });
    await authorize(stream, baseline);
    const before = await clinicalCounts();
    const recovery = { ...baseline };

    if (mismatch === 'offset') recovery.offset_id = randomUUID();
    if (mismatch === 'other-partition-offset') {
      const otherPartition = await createStream(`signed-equality-${mismatch}`, 'orm', {
        credentialSource: stream,
      });
      recovery.offset_id = otherPartition.offset.offset_id;
    }
    if (mismatch === 'partition') {
      recovery.source_partition = `${recovery.source_partition}/changed`;
    }
    if (mismatch === 'generation') recovery.generation = 2;
    if (mismatch === 'position') recovery.source_position = '12';
    if (mismatch === 'predecessor') recovery.predecessor_token = 'b'.repeat(64);
    if (['partition', 'generation', 'position', 'predecessor'].includes(mismatch)) {
      recovery.source_token = i03SourceToken({
        tenantId: recovery.tenant_id,
        sourcePartition: recovery.source_partition,
        generation: recovery.generation,
        sourcePosition: recovery.source_position,
        predecessorToken: recovery.predecessor_token,
        duplicateKey: recovery.duplicate_key,
        messageSha256: recovery.message_sha256,
      });
    }
    if (mismatch === 'source-token') {
      recovery.source_token = recovery.source_token === 'f'.repeat(64)
        ? 'e'.repeat(64)
        : 'f'.repeat(64);
    }
    const body = { message, recovery };

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);

    expect(response.status).toBe(expectedStatus);
    expect(response.text).toContain(expectedStatus === 400 ? 'MSA|AR' : 'MSA|AE');
    expect(response.text).not.toContain('MSA|AA');
    expect(await countStream(stream)).toEqual({ inboxes: 0, receipts: 0, tasks: 0 });
    expect(await clinicalCounts()).toEqual(before);
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, high_water_position::text, high_water_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    expect(state).toEqual([{
      recovery_state: expectedState,
      high_water_position: '10',
      high_water_token: stream.initialToken,
    }]);
  }, 60_000);

  test('one ADT recovery partition fences A01/A02/A03 while ORM remains independent', async () => {
    const stream = await createStream('downgrade-adt');
    const before = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    for (const trigger of ['A01', 'A02', 'A03']) {
      const controlId = `LIVE-${trigger}-${SUFFIX}`;
      const message = messageFor({ stream, family: 'adt', trigger, controlId });
      const response = await request(app)
        .post('/api/v1/hl7/receive')
        .set(liveHeaders(stream, message))
        .send({ message });
      expect(response.status).toBe(409);
      expect(response.text).toContain('MSA|AE');
    }
    const ormControl = `LIVE-ORM-${SUFFIX}`;
    const ormMessage = messageFor({ stream, family: 'orm', controlId: ormControl });
    const ormResponse = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(stream, ormMessage))
      .send({ message: ormMessage });
    expect(ormResponse.status).toBe(200);
    expect(ormResponse.text).toContain('MSA|AA');

    const after = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    expect(after[0]).toEqual({
      admissions: before[0].admissions,
      investigations: before[0].investigations + 1,
    });
  }, 60_000);

  test('holds A03 behind missing A02 while the same credential ORM cursor progresses', async () => {
    const adtStream = await createStream('ordered-shared-credential');
    const ormStream = await createStream('ordered-shared-credential', 'orm', {
      credentialSource: adtStream,
    });
    expect(ormStream.credential.id).toBe(adtStream.credential.id);

    const a01Control = `ORDER-A01-${SUFFIX}`;
    const a01Message = messageFor({ stream: adtStream, trigger: 'A01', controlId: a01Control });
    const a01Recovery = recoveryFor({
      stream: adtStream,
      message: a01Message,
      trigger: 'A01',
      controlId: a01Control,
      sourcePosition: '11',
    });
    const a02Control = `ORDER-A02-${SUFFIX}`;
    const a02Message = messageFor({ stream: adtStream, trigger: 'A02', controlId: a02Control });
    const a02Recovery = recoveryFor({
      stream: adtStream,
      message: a02Message,
      trigger: 'A02',
      controlId: a02Control,
      sourcePosition: '12',
      predecessorToken: a01Recovery.source_token,
    });
    const a03Control = `ORDER-A03-${SUFFIX}`;
    const a03Message = messageFor({ stream: adtStream, trigger: 'A03', controlId: a03Control });
    const a03Recovery = recoveryFor({
      stream: adtStream,
      message: a03Message,
      trigger: 'A03',
      controlId: a03Control,
      sourcePosition: '13',
      predecessorToken: a02Recovery.source_token,
    });
    expect(a03Recovery.predecessor_token).toBe(a02Recovery.source_token);
    await authorize(adtStream, a03Recovery);

    const ormControl = `ORDER-ORM-${SUFFIX}`;
    const ormMessage = messageFor({ stream: ormStream, family: 'orm', controlId: ormControl });
    const ormRecovery = recoveryFor({
      stream: ormStream,
      message: ormMessage,
      controlId: ormControl,
      family: 'orm',
    });
    await authorize(ormStream, ormRecovery);
    const before = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );

    const a01 = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(adtStream, { message: a01Message, recovery: a01Recovery }))
      .send({ message: a01Message, recovery: a01Recovery });
    expect(a01.status).toBe(200);
    expect(a01.text).toContain('MSA|AA');

    const earlyA03 = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(adtStream, { message: a03Message, recovery: a03Recovery }))
      .send({ message: a03Message, recovery: a03Recovery });
    expect(earlyA03.status).toBe(409);
    expect(earlyA03.text).toContain('MSA|AE');

    const liveControlId = `ORDER-LIVE-FENCED-${SUFFIX}`;
    const liveMessage = messageFor({ stream: adtStream, controlId: liveControlId });
    const fencedLive = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(adtStream, liveMessage))
      .send({ message: liveMessage });
    expect(fencedLive.status).toBe(409);
    expect(fencedLive.text).toContain('MSA|AE');

    const orm = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(ormStream, { message: ormMessage, recovery: ormRecovery }))
      .send({ message: ormMessage, recovery: ormRecovery });
    expect(orm.status).toBe(200);
    expect(orm.text).toContain('MSA|AA');

    expect(await countStream(adtStream)).toEqual({ inboxes: 2, receipts: 1, tasks: 1 });
    expect(await countStream(ormStream)).toEqual({ inboxes: 1, receipts: 1, tasks: 1 });
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT source_partition, high_water_position::text,
              high_water_token, recovery_state, reconciliation_reason
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id IN ($2::uuid, $3::uuid)
        ORDER BY source_partition`,
      TENANT_ID,
      adtStream.offset.offset_id,
      ormStream.offset.offset_id,
    ));
    expect(rows).toEqual([
      {
        source_partition: adtStream.sourcePartition,
        high_water_position: '11',
        high_water_token: a01Recovery.source_token,
        recovery_state: 'reconciliation_required_source_gap',
        reconciliation_reason: 'non_contiguous_source_item',
      },
      {
        source_partition: ormStream.sourcePartition,
        high_water_position: '11',
        high_water_token: ormRecovery.source_token,
        recovery_state: 'ready',
        reconciliation_reason: null,
      },
    ]);
    const adtInbox = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT source_position::text, status
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND source_partition = $2::text
        ORDER BY source_position`,
      TENANT_ID,
      adtStream.sourcePartition,
    ));
    expect(adtInbox).toEqual([
      { source_position: '11', status: 'handled' },
      { source_position: '13', status: 'pending' },
    ]);
    const after = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );
    expect(after).toEqual(before);
  }, 60_000);

  test('processes ORM recovery on its independent cursor without creating an investigation', async () => {
    const stream = await createStream('orm-adapter', 'orm');
    const controlId = `RECOVERY-ORM-${SUFFIX}`;
    const message = messageFor({ stream, family: 'orm', controlId });
    const recovery = recoveryFor({ stream, message, controlId, family: 'orm' });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM investigations
        WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(stream, body))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.text).toContain('MSA|AA');
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT r.message_family, r.outcome_code, r.visit_identity_sha256::text,
              r.order_identity_sha256::text, t.assigned_to_role,
              t.workflow_sla_instance_id, t.due_at, t.sla_completion_semantics,
              o.high_water_position::text, o.recovery_state,
              (SELECT COUNT(*)::integer FROM investigations
                WHERE tenant_id = $1::uuid) AS investigations
         FROM hl7_inbound_recovery_receipts r
         JOIN pathway_projector_inbox i
           ON i.tenant_id = r.tenant_id AND i.inbox_id = r.recovery_inbox_id
         JOIN event_consumer_offsets o
           ON o.tenant_id = i.tenant_id AND o.offset_id = i.offset_id
         JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.pending_task_id
        WHERE r.tenant_id = $1::uuid AND r.source_partition = $2::text`,
      TENANT_ID,
      stream.sourcePartition,
    ));
    expect(rows[0]).toMatchObject({
      message_family: 'orm',
      outcome_code: 'i03_orm_pending_order_reconciliation',
      visit_identity_sha256: null,
      order_identity_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      assigned_to_role: 'DUTY_DOCTOR',
      workflow_sla_instance_id: null,
      due_at: null,
      sla_completion_semantics: 'none',
      high_water_position: '11',
      recovery_state: 'ready',
      investigations: before[0].count,
    });

    const liveControlId = `READY-LIVE-ORM-${SUFFIX}`;
    const liveMessage = messageFor({
      stream,
      family: 'orm',
      controlId: liveControlId,
    });
    const live = await request(app)
      .post('/api/v1/hl7/receive')
      .set(liveHeaders(stream, liveMessage))
      .send({ message: liveMessage });
    expect(live.status).toBe(200);
    expect(live.text).toContain('MSA|AA');
    const after = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM investigations
        WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    expect(after[0].count).toBe(before[0].count + 1);
  }, 60_000);

  test('holds MSH-10 reuse and source-position reuse with changed evidence', async () => {
    const duplicateStream = await createStream('duplicate-collision');
    const controlId = `COLLIDE-DUP-${SUFFIX}`;
    const message = messageFor({ stream: duplicateStream, controlId });
    const recovery = recoveryFor({ stream: duplicateStream, message, controlId });
    const changedMessage = messageFor({
      stream: duplicateStream,
      controlId,
      note: 'same control id with changed bytes',
    });
    const changedRecovery = recoveryFor({
      stream: duplicateStream,
      message: changedMessage,
      controlId,
      sourcePosition: '12',
      predecessorToken: recovery.source_token,
    });
    // Keep the offset replaying after position 11 so the collision is evaluated
    // inside the owner-authorized replay window, not after terminal readiness.
    await authorize(duplicateStream, changedRecovery);
    const acceptedBody = { message, recovery };
    const accepted = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(duplicateStream, acceptedBody))
      .send(acceptedBody);
    expect(accepted.status).toBe(200);

    const changedBody = { message: changedMessage, recovery: changedRecovery };
    const duplicateCollision = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(duplicateStream, changedBody))
      .send(changedBody);
    expect(duplicateCollision.status).toBe(409);
    expect(duplicateCollision.text).toContain('MSA|AE');
    expect(await countStream(duplicateStream)).toEqual({ inboxes: 1, receipts: 1, tasks: 1 });

    const positionStream = await createStream('position-collision');
    const firstControl = `COLLIDE-POS-A-${SUFFIX}`;
    const firstMessage = messageFor({ stream: positionStream, controlId: firstControl });
    const firstRecovery = recoveryFor({ stream: positionStream, message: firstMessage, controlId: firstControl });
    await authorize(positionStream, firstRecovery);
    await enqueueHl7InboundRecovery({
      message: firstMessage,
      recovery: firstRecovery,
      credentialSnapshot: positionStream.credential,
    });
    const secondControl = `COLLIDE-POS-B-${SUFFIX}`;
    const secondMessage = messageFor({ stream: positionStream, controlId: secondControl });
    const secondRecovery = recoveryFor({
      stream: positionStream,
      message: secondMessage,
      controlId: secondControl,
    });
    const secondBody = { message: secondMessage, recovery: secondRecovery };
    const positionCollision = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signedHeaders(positionStream, secondBody))
      .send(secondBody);
    expect(positionCollision.status).toBe(409);
    expect(positionCollision.text).toContain('MSA|AE');
    expect(await countStream(positionStream)).toEqual({ inboxes: 1, receipts: 0, tasks: 0 });

    for (const stream of [duplicateStream, positionStream]) {
      const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT recovery_state, reconciliation_reason
           FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        TENANT_ID,
        stream.offset.offset_id,
      ));
      expect(state[0]).toEqual({
        recovery_state: 'reconciliation_required_source_gap',
        reconciliation_reason: 'duplicate_or_position_fingerprint_conflict',
      });
    }
  }, 60_000);

  test('concurrent source-position contenders leave one canonical row and quarantine the offset', async () => {
    const stream = await createStream('concurrent-position-race');
    const controls = [`RACE-A-${SUFFIX}`, `RACE-B-${SUFFIX}`];
    const commands = controls.map(controlId => {
      const message = messageFor({ stream, controlId });
      return {
        message,
        recovery: recoveryFor({ stream, message, controlId }),
      };
    });
    const cutoffControlId = `RACE-CUTOFF-${SUFFIX}`;
    const cutoffMessage = messageFor({ stream, controlId: cutoffControlId });
    const cutoffRecovery = recoveryFor({
      stream,
      message: cutoffMessage,
      controlId: cutoffControlId,
      sourcePosition: '12',
      predecessorToken: commands[0].recovery.source_token,
    });
    await authorize(stream, cutoffRecovery);
    const attempts = await Promise.allSettled(commands.map(command => enqueueHl7InboundRecovery({
      ...command,
      credentialSnapshot: stream.credential,
    })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);

    let state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      stream.offset.offset_id,
    ));
    if (state[0].recovery_state === 'replaying') {
      const winnerIndex = attempts.findIndex(result => result.status === 'fulfilled');
      const contender = commands[winnerIndex === 0 ? 1 : 0];
      await expect(enqueueHl7InboundRecovery({
        ...contender,
        credentialSnapshot: stream.credential,
      })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_IDENTITY_CONFLICT' });
      state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT recovery_state, reconciliation_reason
           FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        TENANT_ID,
        stream.offset.offset_id,
      ));
    }
    expect(state).toEqual([{
      recovery_state: 'reconciliation_required_source_gap',
      reconciliation_reason: 'duplicate_or_position_fingerprint_conflict',
    }]);
    expect(await countStream(stream)).toEqual({ inboxes: 1, receipts: 0, tasks: 0 });
  }, 60_000);

  test.each([
    ['cross-tenant', OTHER_PATIENT_UID, RUNTIME_ROLE],
    ['unresolved', UNKNOWN_PATIENT_UID, null],
  ])('retains %s patient evidence unlinked with zero live clinical mutation', async (
    label,
    patientUid,
    runtimeRole,
  ) => {
    const stream = await createStream(`patient-${label}`);
    const controlId = `PATIENT-${label}-${SUFFIX}`;
    const message = messageFor({ stream, controlId, patientUid });
    const recovery = recoveryFor({ stream, message, controlId });
    const body = { message, recovery };
    await authorize(stream, recovery);
    const before = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations`,
      TENANT_ID,
    );

    if (runtimeRole) {
      const previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = runtimeRole;
      try {
        await ensureTenantRlsRuntimeRoleGrants();
      } finally {
        if (previousRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
        else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
      }
      const posture = await prisma.$queryRawUnsafe(
        `SELECT rolsuper, rolbypassrls
           FROM pg_catalog.pg_roles
          WHERE rolname = $1::text`,
        runtimeRole,
      );
      expect(posture).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }
    const previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    let response;
    let rows;
    try {
      if (runtimeRole) process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = runtimeRole;
      response = await request(app)
        .post('/api/v1/hl7/receive')
        .set(signedHeaders(stream, body))
        .send(body);

      rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT r.patient_uid::text, r.status, r.outcome_code,
                t.status AS task_status, t.assigned_to_role,
                t.workflow_sla_instance_id, t.due_at, t.sla_completion_semantics,
                (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
                (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations
           FROM hl7_inbound_recovery_receipts r
           JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.pending_task_id
          WHERE r.tenant_id = $1::uuid AND r.source_partition = $2::text`,
        TENANT_ID,
        stream.sourcePartition,
      ));
    } finally {
      if (previousRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }

    expect(response.status).toBe(200);
    expect(response.text).toContain('MSA|AA');
    expect(rows[0]).toMatchObject({
      patient_uid: null,
      status: 'pending_review',
      outcome_code: 'i03_adt_pending_admission_reconciliation',
      task_status: 'open',
      assigned_to_role: 'MEDICAL_RECORDS',
      workflow_sla_instance_id: null,
      due_at: null,
      sla_completion_semantics: 'none',
      admissions: before[0].admissions,
      investigations: before[0].investigations,
    });
  }, 60_000);
});
