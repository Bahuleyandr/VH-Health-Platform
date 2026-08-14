// C-4 (interop) — HL7 /receive inbound tenant binding.
//
// loadHl7Patient resolved the patient by uid with NO tenant scope, then wrote
// admissions / investigations / lab-results on plain prisma (GUC unset). Under
// RLS that means the write lands via the permissive branch and the tenant_id
// column DEFAULT (literal default tenant) can stamp a NON-default patient's
// clinical row into the WRONG tenant — cross-tenant clinical-integrity injection
// under one shared HL7_INBOUND_SHARED_SECRET.
//
// The fix scopes the resolve + every write under the patient's own tenant via
// setTenant(tenant, …). Guard-now / retire-later (2026-08-06): the shared
// secret is further confined to DEFAULT-tenant patients — a non-default
// patient is refused outright (per-tenant secrets are the sanctioned
// multi-tenant route). This proves the fallback still works for the default
// tenant, refuses foreign tenants, and that the legacy HMAC-only ORU writer is
// rejected without creating a partial result; analyzer results must use the
// authenticated lab-ingest contract.
//
// Needs the test Postgres. Self-skips when unconfigured.

import crypto from 'crypto';
import express from 'express';
import { Client } from 'pg';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import {
  I03_RECOVERY_SCHEMA,
  buildI03RecoverySignedPayload,
  i03DuplicateKey,
  i03SourceToken,
  sha256Utf8,
} from '../services/integrations/externalHl7InboundRecoveryService.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { registerExternalRecoveryOffset } from './helpers/externalRecoveryOperabilityTestHelper.js';
import { enableHl7InboundForTest } from './helpers/hl7InboundTestEnv.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
// The I03 ingress is authoritative on HL7_INBOUND_ENABLED and fails closed
// when it is not exactly 'true'; declare the interface ON to exercise it. The
// refused-while-off contract lives in hl7-inbound-disabled.deep.test.js.
// The helper supplies HL7_INBOUND_SHARED_SECRET with the flag — validateEnv
// requires the pair, and a test that splits them exits the worker outright.
// beforeAll below overwrites the secret with this suite's own legacy value.
enableHl7InboundForTest();

const DB_CONFIGURED = !!databaseUrl;
const d = DB_CONFIGURED ? describe : describe.skip;

const SECRET = 'hl7-tenant-binding-test-secret';
const TENANT_B = 'b7100000-0000-4000-8000-00000000b001';
const TENANT_SLUG = 'hl7-tenant-binding-b';
const PATIENT_UID = 'b7100000-0000-4000-8000-0000000007b1';
const PATIENT_PHONE = '+919000070701';
// A second patient in the platform DEFAULT tenant — the only population the
// legacy shared-secret fallback may still write for (guard-now / retire-later).
const DEFAULT_PATIENT_UID = 'b7100000-0000-4000-8000-0000000007d1';
const DEFAULT_PATIENT_PHONE = '+919000070702';

function ownerDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function cleanupEnrolledOffset(offsetId) {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    const auditRows = await client.query(
      `SELECT clinical_audit_event_id::text
         FROM external_recovery_operability_actions
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      [TENANT_B, offsetId],
    );
    await client.query(
      `DELETE FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      [TENANT_B, offsetId],
    );
    await client.query(
      `DELETE FROM external_recovery_operability_actions
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      [TENANT_B, offsetId],
    );
    for (const row of auditRows.rows) {
      await client.query(
        `DELETE FROM clinical_audit_events
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [TENANT_B, row.clinical_audit_event_id],
      );
    }
    await client.query(
      `DELETE FROM tenant_interop_secrets
        WHERE tenant_id = $1::uuid
          AND kind = 'hl7_inbound'
          AND sender_identifier = 'VHFAC'`,
      [TENANT_B],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/hl7', hl7Routes);
  return app;
}

function signHeaders({ message, controlId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `hl7-${controlId}-${Date.now()}`;
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`${timestamp}.${requestId}.${message}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

function buildRecoveryRequest(controlId) {
  const occurrence = '20260806103045+0530';
  const message = [
    `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|${occurrence}||ADT^A01|${controlId}|P|2.5|1042`,
    `EVN|A01|${occurrence}`,
    `PID|1||${PATIENT_UID}||HL7 Tenant Patient||19900101|M|||Addr|||${PATIENT_PHONE}`,
    'PV1|1|I|WARD-3',
  ].join('\r');
  const signingCredentialId = '999999';
  const tenantId = TENANT_B;
  const sourcePartition = `i03/credential/${signingCredentialId}/family/adt`;
  const predecessorToken = 'a'.repeat(64);
  const sourcePosition = '11';
  const generation = 1;
  const messageSha256 = sha256Utf8(message);
  const duplicateKey = i03DuplicateKey({
    tenantId,
    signingCredentialId,
    messageFamily: 'adt',
    messageType: 'ADT',
    triggerEvent: 'A01',
    messageControlId: controlId,
  });
  const recovery = {
    schema: I03_RECOVERY_SCHEMA,
    interface_family: 'I03',
    arrival_class: 'recovery_backlog',
    tenant_id: tenantId,
    signing_credential_id: signingCredentialId,
    offset_id: 'b7100000-0000-4000-8000-00000000f003',
    source_partition: sourcePartition,
    generation,
    source_position: sourcePosition,
    source_token: i03SourceToken({
      tenantId,
      sourcePartition,
      generation,
      sourcePosition,
      predecessorToken,
      duplicateKey,
      messageSha256,
    }),
    predecessor_token: predecessorToken,
    duplicate_key: duplicateKey,
    message_family: 'adt',
    message_type: 'ADT',
    trigger_event: 'A01',
    message_control_id: controlId,
    message_sha256: messageSha256,
    source_observed_at: '2026-08-06T10:30:45+05:30',
    source_received_at: '2026-08-06T10:30:45.500+05:30',
    clock_evidence: {
      source_clock_id: 'env-only-fixture',
      synchronized_at: '2026-08-06T10:29:00+05:30',
      maximum_error_ms: 1000,
    },
  };
  return { message, recovery };
}

async function cleanup() {
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT timeline_event_id::text, audit_event_id::text
       FROM hl7_inbound_clinical_receipts
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DEFAULT_PATIENT_UID,
  ).catch(() => []);
  await prisma.$executeRawUnsafe(
    `DELETE FROM hl7_inbound_clinical_receipts
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DEFAULT_PATIENT_UID,
  ).catch(() => {});
  for (const receipt of receipts) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE id = $1::uuid`,
      receipt.audit_event_id,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE id = $1::uuid`,
      receipt.timeline_event_id,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, DEFAULT_PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid OR phone = $2`, DEFAULT_PATIENT_UID, DEFAULT_PATIENT_PHONE).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenant_interop_secrets
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND kind = 'hl7_inbound'
        AND sender_identifier = 'VHFAC'`,
    DEFAULT_TENANT_ID,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B).catch(() => {});
}

d('HL7 /receive tenant binding (C-4)', () => {
  let app;
  let prevSecret;

  beforeAll(async () => {
    prevSecret = process.env.HL7_INBOUND_SHARED_SECRET;
    process.env.HL7_INBOUND_SHARED_SECRET = SECRET;
    await cleanup();
    // A dedicated NON-default tenant for this test.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'HL7 Tenant Binding B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, TENANT_SLUG,
    );
    // Patient lives in that NON-default tenant.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'HL7 Tenant Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID, TENANT_B, PATIENT_PHONE,
    );
    // A patient in the platform DEFAULT tenant (the legacy shared-secret
    // fallback keeps working for this population only).
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'HL7 Default Tenant Patient', 'PATIENT', true, NOW())`,
      DEFAULT_PATIENT_UID, DEFAULT_TENANT_ID, DEFAULT_PATIENT_PHONE,
    );
    app = buildApp();
  }, 30000);

  afterAll(async () => {
    await cleanup();
    if (prevSecret === undefined) delete process.env.HL7_INBOUND_SHARED_SECRET;
    else process.env.HL7_INBOUND_SHARED_SECRET = prevSecret;
    // prisma.$disconnect() is handled by the global jest teardown.
  }, 30000);

  test('legacy env-backed ADT remains live for a DEFAULT-tenant patient with no I03 enrollment', async () => {
    const enrollment = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM event_consumer_offsets AS offset_row
         JOIN tenant_interop_secrets AS credential
           ON credential.tenant_id = offset_row.tenant_id
          AND offset_row.source_partition =
              'i03/credential/' || credential.id::text || '/family/adt'
        WHERE offset_row.interface_family = 'I03'
          AND offset_row.intake_retired_at IS NULL
          AND credential.kind = 'hl7_inbound'
          AND credential.sender_identifier = 'VHFAC'`,
    );
    expect(enrollment).toEqual([{ count: 0 }]);
    const controlId = `ADTDEF${Date.now()}`;
    const message = [
      `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|20260101120000||ADT^A01|${controlId}|P|2.5`,
      `PID|1||${DEFAULT_PATIENT_UID}||HL7 Default Tenant Patient||19900101|M|||Addr|||${DEFAULT_PATIENT_PHONE}`,
      'PV1|1|I|WARD-3^^^|||||',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.text).toContain('MSA|AA');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, status FROM admissions WHERE patient_uid = $1::uuid`,
      DEFAULT_PATIENT_UID,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
  });

  test('guard-now (2026-08-06): the shared secret refuses a NON-default-tenant patient before any write', async () => {
    // Previously the single env-wide secret authenticated messages for ANY
    // tenant's patients (the write landed in the patient's own tenant). The
    // guard confines the legacy fallback to the DEFAULT tenant: a non-default
    // patient is refused with the same "not registered" AE as an unknown
    // patient (no tenant oracle) and nothing is written anywhere.
    const controlId = `ADTB${Date.now()}`;
    const message = [
      `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|20260101120000||ADT^A01|${controlId}|P|2.5`,
      `PID|1||${PATIENT_UID}||HL7 Tenant Patient||19900101|M|||Addr|||${PATIENT_PHONE}`,
      'PV1|1|I|WARD-3^^^|||||',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(404);
    expect(res.text).toContain('MSA|AE');
    expect(res.text).toContain('Patient is not registered at this facility');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  test.each([
    ['inactive', 409, 'AE', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_interop_secrets
            SET status = 'inactive'
          WHERE tenant_id = $1::uuid
            AND kind = 'hl7_inbound'
            AND sender_identifier = 'VHFAC'`,
        TENANT_B,
      );
    }],
    ['unreadable', 500, 'AR', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_interop_secrets
            SET status = 'active', secret_ciphertext = 'enc:v2:not-readable'
          WHERE tenant_id = $1::uuid
            AND kind = 'hl7_inbound'
            AND sender_identifier = 'VHFAC'`,
        TENANT_B,
      );
    }],
  ])('env fallback cannot bypass an enrolled I03 offset with an %s credential row', async (
    _label,
    expectedStatus,
    expectedAck,
    makeUnavailable,
  ) => {
    const row = await upsertInteropSecret({
      tenantId: TENANT_B,
      kind: 'hl7_inbound',
      senderIdentifier: 'VHFAC',
      secret: `db-only-${Date.now()}`,
    });
    const credential = await resolveInteropCredentialSnapshot('hl7_inbound', 'VHFAC');
    expect(credential.id).toBe(String(row.id));
    const sourcePartition = `i03/credential/${credential.id}/family/adt`;
    const offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_B,
      interfaceFamily: 'I03',
      sourcePartition,
      initialPosition: '10',
      initialToken: 'a'.repeat(64),
      retainedFromPosition: '10',
      retainedFromToken: 'a'.repeat(64),
      policyVersion: 'c6-1-i03-env-fence-v1',
      policySignature: `env-fence-${Date.now()}`,
      retentionPolicy: 'hl7-clinical-recovery-730d',
      retentionUntil: '2029-08-06T00:00:00.000Z',
    });
    try {
      await makeUnavailable();
      const controlId = `ENVFENCE${Date.now()}`;
      const message = [
        `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|20260101120000||ADT^A01|${controlId}|P|2.5`,
        `PID|1||${PATIENT_UID}||HL7 Tenant Patient||19900101|M|||Addr|||${PATIENT_PHONE}`,
        'PV1|1|I|WARD-3^^^|||||',
      ].join('\r');
      const before = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count FROM admissions WHERE patient_uid = $1::uuid`,
        PATIENT_UID,
      );
      const response = await request(app)
        .post('/api/v1/hl7/receive')
        .set(signHeaders({ message, controlId }))
        .send({ message });

      expect(response.status).toBe(expectedStatus);
      expect(response.text).toContain(`MSA|${expectedAck}`);
      expect(response.text).not.toContain('MSA|AA');
      const after = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count FROM admissions WHERE patient_uid = $1::uuid`,
        PATIENT_UID,
      );
      expect(after).toEqual(before);
    } finally {
      await cleanupEnrolledOffset(offset.offset_id);
    }
  }, 60_000);

  test('ORU^R01 is rejected without a legacy investigation/result write', async () => {
    const controlId = `ORU${Date.now()}`;
    const message = [
      `MSH|^~\\&|LAB|LFAC|VH|VHFAC|20260101130000||ORU^R01|${controlId}|P|2.5`,
      `PID|1||${PATIENT_UID}||HL7 Tenant Patient||19900101|M|||Addr|||${PATIENT_PHONE}`,
      'OBR|1||ORDER-1|CBC^Complete Blood Count|||20260101130000',
      'OBX|1|NM|718-7^Hemoglobin||13.5|g/dL|13-17|N|||F',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.text).toContain('MSA|AE');
    expect(res.text).toContain('Use authenticated lab ORU ingestion');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, status FROM investigations WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(rows).toHaveLength(0);
  });

  test('environment-only legacy secret cannot authenticate I03 recovery', async () => {
    const controlId = `I03ENV${Date.now()}`;
    const body = buildRecoveryRequest(controlId);
    const { signedPayload } = buildI03RecoverySignedPayload(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = `hl7-${controlId}-${Date.now()}`;
    const signature = crypto.createHmac('sha256', SECRET)
      .update(`${timestamp}.${requestId}.${signedPayload}`)
      .digest('hex');
    const beforeAdmissions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set({
        'x-hl7-signature': `sha256=${signature}`,
        'x-hl7-timestamp': String(timestamp),
        'x-hl7-message-id': requestId,
      })
      .send(body);

    expect(res.status).toBe(401);
    expect(res.text).toContain('MSA|AR');
    expect(res.text).not.toContain('HL7_I03_RECOVERY_CREDENTIAL_REQUIRED');

    const afterAdmissions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(afterAdmissions).toEqual(beforeAdmissions);
    const replayRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM interop_replay_guard
        WHERE namespace = 'hl7-inbound'
          AND request_id = $1::text`,
      [requestId, timestamp, signature].join(':'),
    );
    expect(replayRows[0].count).toBe(0);
  });

  test('an unknown patient is rejected with an HL7 AE (not written to any tenant)', async () => {
    const controlId = `ADT404${Date.now()}`;
    const unknownUid = 'b7100000-0000-4000-8000-000000000404';
    const message = [
      `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|20260101120000||ADT^A01|${controlId}|P|2.5`,
      `PID|1||${unknownUid}||No Such Patient||19900101|M`,
      'PV1|1|I|WARD-1^^^|||||',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(404);
    expect(res.text).toContain('MSA|AE');
  });
});
