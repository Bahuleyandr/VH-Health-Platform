// HL7 /receive per-tenant-secret patient-tenant equality (CAN-021).
//
// When the inbound message is authenticated by a PER-TENANT secret (resolved
// from the receiving facility), the named patient MUST belong to that tenant —
// a tenant-A feed cannot write clinical rows into a tenant-B patient. The
// legacy shared-secret path (hl7-receive-tenant-binding) is unaffected.
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import {
  buildI03RecoverySignedPayload,
  i03DuplicateKey,
  i03SourceToken,
  sha256Utf8,
} from '../services/integrations/externalHl7InboundRecoveryService.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';

// The I03 ingress is authoritative on HL7_INBOUND_ENABLED and fails closed
// when it is not exactly 'true'; declare the interface ON to exercise it. The
// refused-while-off contract lives in hl7-inbound-disabled.deep.test.js.
process.env.HL7_INBOUND_ENABLED = 'true';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SECRET = 'hl7-can021-per-tenant-secret';
const FACILITY = 'VHFAC-CAN021';
const TENANT_A = 'c0de0210-0000-4000-8000-00000000a001';
const TENANT_B = 'c0de0210-0000-4000-8000-00000000b001';
const PATIENT_A = 'c0de0210-0000-4000-8000-0000000007a1'; // in tenant A
const PATIENT_B = 'c0de0210-0000-4000-8000-0000000007b1'; // in tenant B
const I03_OFFSET_ID = 'c0de0210-0000-4000-8000-00000000f003';

function buildApp({ apiClientTenantId = null } = {}) {
  const app = express();
  app.use(express.json());
  if (apiClientTenantId) {
    app.use((req, _res, next) => {
      req.apiClientTenantId = apiClientTenantId;
      next();
    });
  }
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

function recoveryAdt(patientUid, controlId) {
  return [
    `MSH|^~\\&|SENDER|SFAC|VH|${FACILITY}|20260806103045+0530||ADT^A01|${controlId}|P|2.5|1042`,
    'EVN|A01|20260806103045+0530',
    `PID|1||${patientUid}`,
    'PV1|1|I|WARD-3',
  ].join('\r');
}

function recoveryEnvelope(message, controlId, credentialId, {
  tenantId = TENANT_A,
  signingCredentialId = credentialId,
} = {}) {
  const sourcePartition = `i03/credential/${signingCredentialId}/family/adt`;
  const messageSha256 = sha256Utf8(message);
  const predecessorToken = 'a'.repeat(64);
  const duplicateKey = i03DuplicateKey({
    tenantId,
    signingCredentialId,
    messageFamily: 'adt',
    messageType: 'ADT',
    triggerEvent: 'A01',
    messageControlId: controlId,
  });
  return {
    schema: 'vhhealth.i03.adt-orm-sequence/v1',
    interface_family: 'I03',
    arrival_class: 'recovery_backlog',
    tenant_id: tenantId,
    signing_credential_id: signingCredentialId,
    offset_id: I03_OFFSET_ID,
    source_partition: sourcePartition,
    generation: 1,
    source_position: '1',
    source_token: i03SourceToken({
      tenantId,
      sourcePartition,
      generation: 1,
      sourcePosition: '1',
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
      source_clock_id: 'can021-ntp',
      synchronized_at: '2026-08-06T10:29:00+05:30',
      maximum_error_ms: 1000,
    },
  };
}

function signRecoveryHeaders({ message, recovery, controlId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `hl7-recovery-${controlId}-${Date.now()}-${Math.random()}`;
  const { signedPayload } = buildI03RecoverySignedPayload({ message, recovery });
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`${timestamp}.${requestId}.${signedPayload}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

function adt(patientUid, controlId) {
  return [
    `MSH|^~\\&|SENDER|SFAC|VH|${FACILITY}|20260101120000||ADT^A01|${controlId}|P|2.5`,
    `PID|1||${patientUid}||HL7 EqTest||19900101|M|||Addr|||+919000210701`,
    'PV1|1|I|WARD-3^^^|||||',
  ].join('\r');
}

async function cleanup() {
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT timeline_event_id::text, audit_event_id::text
       FROM hl7_inbound_clinical_receipts
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A,
    PATIENT_B,
  ).catch(() => []);
  await prisma.$executeRawUnsafe(
    `DELETE FROM hl7_inbound_clinical_receipts
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A,
    PATIENT_B,
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
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid IN ($1::uuid,$2::uuid)`, PATIENT_A, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenant_interop_secrets WHERE sender_identifier = $1`, FACILITY).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT_A, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
}

d('HL7 /receive per-tenant patient equality (CAN-021)', () => {
  let app;
  let credentialSnapshot;
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'hl7-eq-a','HL7 Eq A'),($2::uuid,'hl7-eq-b','HL7 Eq B')
       ON CONFLICT (id) DO NOTHING`, TENANT_A, TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at) VALUES
        ($1::uuid,$3::uuid,'+919000210701','Pat A','PATIENT',true,NOW()),
        ($2::uuid,$4::uuid,'+919000210702','Pat B','PATIENT',true,NOW())`,
      PATIENT_A, PATIENT_B, TENANT_A, TENANT_B);
    // Per-tenant inbound secret: the receiving facility maps to TENANT A.
    await upsertInteropSecret({ tenantId: TENANT_A, kind: 'hl7_inbound', senderIdentifier: FACILITY, secret: SECRET });
    credentialSnapshot = await resolveInteropCredentialSnapshot('hl7_inbound', FACILITY);
    app = buildApp();
  }, 30000);
  afterAll(async () => { await cleanup(); }, 30000);

  it('rejects a tenant-A-authenticated message naming a tenant-B patient', async () => {
    const controlId = `EQB${Date.now()}`;
    const message = adt(PATIENT_B, controlId);
    const res = await request(app).post('/api/v1/hl7/receive').set(signHeaders({ message, controlId })).send({ message });
    expect(res.status).toBe(404);
    expect(res.text).toContain('MSA|AE');
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_B);
    expect(rows[0].n).toBe(0); // nothing written to tenant B
  });

  it('accepts a tenant-A-authenticated message naming a tenant-A patient', async () => {
    const controlId = `EQA${Date.now()}`;
    const message = adt(PATIENT_A, controlId);
    const res = await request(app).post('/api/v1/hl7/receive').set(signHeaders({ message, controlId })).send({ message });
    expect(res.status).toBe(200);
    expect(res.text).toContain('MSA|AA');
    const rows = await prisma.$queryRawUnsafe(`SELECT tenant_id::text AS tenant_id FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_A);
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('rejects a tenant-B DB API credential before consuming tenant-A replay state', async () => {
    const mismatchedApp = buildApp({ apiClientTenantId: TENANT_B });
    const matchingApp = buildApp({ apiClientTenantId: TENANT_A });
    const controlId = `EQKEY${Date.now()}`;
    const message = adt(PATIENT_A, controlId);
    const headers = signHeaders({ message, controlId });
    const sharedReplayRequestId = [
      headers['x-hl7-message-id'],
      headers['x-hl7-timestamp'],
      headers['x-hl7-signature'].replace(/^sha256=/i, ''),
    ].join(':');
    await prisma.$executeRawUnsafe(
      'DELETE FROM admissions WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    const beforeAdmissions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_A,
    );
    const res = await request(mismatchedApp)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message });

    expect(res.status).toBe(401);
    expect(res.text).toContain('MSA|AR');
    const replayRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM interop_replay_guard
        WHERE namespace = 'hl7-inbound'
          AND request_id = $1`,
      sharedReplayRequestId,
    );
    expect(replayRows[0].count).toBe(0);
    const admissions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_A,
    );
    expect(admissions[0].count).toBe(beforeAdmissions[0].count);

    // The denied credential must not poison the process-local replay cache.
    // Reusing the exact signed envelope with the matching credential should
    // still claim replay state and perform the mutation once.
    const accepted = await request(matchingApp)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message });
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');

    const afterAccepted = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM admissions
           WHERE patient_uid = $1::uuid) AS admission_count,
         (SELECT COUNT(*)::int
            FROM interop_replay_guard
           WHERE namespace = 'hl7-inbound'
             AND request_id = $2) AS replay_count`,
      PATIENT_A,
      sharedReplayRequestId,
    );
    expect(afterAccepted[0]).toEqual({ admission_count: 1, replay_count: 1 });
  });

  it.each([
    ['DB API tenant', { apiClientTenantId: TENANT_B }],
    ['signed envelope tenant', { envelopeTenantId: TENANT_B }],
    ['signed credential id', { signingCredentialId: '999999' }],
  ])('rejects a mismatched recovery %s before consuming replay state', async (
    _label,
    mismatch,
  ) => {
    const controlId = `EQREC${Date.now()}${Math.round(Math.random() * 1000)}`;
    const message = recoveryAdt(PATIENT_A, controlId);
    const recovery = recoveryEnvelope(message, controlId, credentialSnapshot.id, {
      tenantId: mismatch.envelopeTenantId || TENANT_A,
      signingCredentialId: mismatch.signingCredentialId || credentialSnapshot.id,
    });
    const headers = signRecoveryHeaders({ message, recovery, controlId });
    const replayRequestId = [
      headers['x-hl7-message-id'],
      headers['x-hl7-timestamp'],
      headers['x-hl7-signature'].replace(/^sha256=/i, ''),
    ].join(':');
    const targetApp = buildApp({ apiClientTenantId: mismatch.apiClientTenantId || null });
    const res = await request(targetApp)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message, recovery });

    expect([401, 403]).toContain(res.status);
    expect(res.text).toContain('MSA|AR');
    const replayRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM interop_replay_guard
        WHERE namespace = 'hl7-inbound' AND request_id = $1::text`,
      replayRequestId,
    );
    expect(replayRows[0].count).toBe(0);
  });

  it('requires an explicit non-empty recovery message id before replay or enqueue', async () => {
    const controlId = `EQRECNOID${Date.now()}`;
    const message = recoveryAdt(PATIENT_A, controlId);
    const recovery = recoveryEnvelope(message, controlId, credentialSnapshot.id);
    const headers = signRecoveryHeaders({ message, recovery, controlId });
    delete headers['x-hl7-message-id'];
    const before = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM interop_replay_guard
           WHERE namespace = 'hl7-inbound') AS replay_count,
         (SELECT COUNT(*)::integer
            FROM pathway_projector_inbox
           WHERE tenant_id = $1::uuid
             AND scope_kind = 'external_interface'
             AND interface_family = 'I03') AS inbox_count`,
      TENANT_A,
    );

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message, recovery });

    expect(res.status).toBe(401);
    expect(res.text).toContain('MSA|AR');
    expect(res.text).not.toContain('HL7_I03_RECOVERY_REQUEST_ID_REQUIRED');
    const after = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM interop_replay_guard
           WHERE namespace = 'hl7-inbound') AS replay_count,
         (SELECT COUNT(*)::integer
            FROM pathway_projector_inbox
           WHERE tenant_id = $1::uuid
             AND scope_kind = 'external_interface'
             AND interface_family = 'I03') AS inbox_count`,
      TENANT_A,
    );
    expect(after).toEqual(before);
  });
});
