import crypto from 'node:crypto';

import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import { __testing__ as signedRequestTesting } from '../utils/signedRequest.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

const TENANT_ID = 'ca110000-0000-4000-8000-000000000001';
const PATIENT_UID = 'ca110000-0000-4000-8000-000000000002';
const FACILITY = 'CANONICAL-INTEROP-LIVE';
const SECRET = 'canonical-interop-live-secret';
const PHONE = '+919811100002';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/hl7', hl7Routes);
  return app;
}

function signHeaders(message, requestSuffix = crypto.randomUUID()) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `canonical-interop-${requestSuffix}`;
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`${timestamp}.${requestId}.${message}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

function adtMessage(event, controlId, ward, bed, eventTime = '20260813080500+0530') {
  return [
    `MSH|^~\\&|CANONICAL-SENDER|CANONICAL-SITE|VH|${FACILITY}|${eventTime}||ADT^${event}|${controlId}|P|2.5`,
    `EVN|${event}|${eventTime}`,
    `PID|1||${PATIENT_UID}||Canonical Interop Patient||19900101|F|||Addr|||${PHONE}`,
    `PV1|1|I|${ward}^${bed}|||||||||||||||||||||||||||||||||||||||||${eventTime}|${event === 'A03' ? eventTime : ''}`,
  ].join('\r');
}

function ormMessage(controlId, eventTime = '20260813081500+0530') {
  return [
    `MSH|^~\\&|CANONICAL-SENDER|CANONICAL-SITE|VH|${FACILITY}|${eventTime}||ORM^O01|${controlId}|P|2.5`,
    `PID|1||${PATIENT_UID}||Canonical Interop Patient||19900101|F|||Addr|||${PHONE}`,
    `OBR|1|ORDER-${controlId}||CBC^Complete Blood Count|||${eventTime}|||||||||||||||||||O`,
  ].join('\r');
}

async function sendSigned(app, message) {
  return request(app)
    .post('/api/v1/hl7/receive')
    .set(signHeaders(message))
    .send({ message });
}

async function clearVolatileReplayWindow() {
  signedRequestTesting.replayCache.clear();
  await prisma.$executeRawUnsafe(
    `DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound'`,
  );
}

async function cleanup() {
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT timeline_event_id::text, audit_event_id::text
       FROM hl7_inbound_clinical_receipts
      WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => []);
  await prisma.$executeRawUnsafe(
    `DELETE FROM hl7_inbound_clinical_receipts WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  for (const receipt of receipts) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      receipt.audit_event_id,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      receipt.timeline_event_id,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await clearVolatileReplayWindow().catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenant_interop_secrets
      WHERE tenant_id = $1::uuid
        AND kind = 'hl7_inbound'
        AND sender_identifier = $2`,
    TENANT_ID,
    FACILITY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

d('live HL7 canonical clinical commands', () => {
  let app;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'canonical-interop-live', 'Canonical Interop Live')`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Canonical Interop Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID,
      TENANT_ID,
      PHONE,
    );
    await upsertInteropSecret({
      tenantId: TENANT_ID,
      kind: 'hl7_inbound',
      senderIdentifier: FACILITY,
      secret: SECRET,
    });
    const credential = await resolveInteropCredentialSnapshot('hl7_inbound', FACILITY);
    expect(credential.tenant_id).toBe(TENANT_ID);
    app = buildApp();
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  }, 30_000);

  it('commits A01/A02/A03 as one admission mutation, timeline, audit, and durable receipt each', async () => {
    const messages = [
      adtMessage('A01', 'CAN-ADT-001', 'WARD-1', 'BED-1'),
      adtMessage('A02', 'CAN-ADT-002', 'WARD-2', 'BED-9', '20260813081000+0530'),
      adtMessage('A03', 'CAN-ADT-003', 'WARD-2', 'BED-9', '20260813082000+0530'),
    ];

    for (const message of messages) {
      const response = await sendSigned(app, message);
      expect(response.status).toBe(200);
      expect(response.text).toContain('MSA|AA');
    }

    const evidence = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM admissions
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS detail_count,
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND message_type LIKE 'ADT^%') AS receipt_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND event_type IN ('admission.created', 'bed.transferred', 'discharge.completed')) AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND action IN ('admission.created', 'bed.transferred', 'discharge.completed')) AS audit_count,
         (SELECT status FROM admissions
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid LIMIT 1) AS status,
         (SELECT ward FROM admissions
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid LIMIT 1) AS ward`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(evidence[0]).toEqual({
      detail_count: 1,
      receipt_count: 3,
      timeline_count: 3,
      audit_count: 3,
      status: 'DISCHARGED',
      ward: 'WARD-2',
    });

    await clearVolatileReplayWindow();
    for (const message of messages) {
      const duplicate = await sendSigned(app, message);
      expect(duplicate.status).toBe(200);
      expect(duplicate.text).toContain('MSA|AA');
    }

    const afterReplay = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM admissions
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS detail_count,
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND message_type LIKE 'ADT^%') AS receipt_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND event_type IN ('admission.created', 'bed.transferred', 'discharge.completed')) AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND action IN ('admission.created', 'bed.transferred', 'discharge.completed')) AS audit_count`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(afterReplay[0]).toEqual({
      detail_count: 1,
      receipt_count: 3,
      timeline_count: 3,
      audit_count: 3,
    });
  });

  it('commits ORM once and remains idempotent after volatile replay state is evicted', async () => {
    const message = ormMessage('CAN-ORM-001');
    const first = await sendSigned(app, message);
    expect(first.status).toBe(200);
    expect(first.text).toContain('MSA|AA');

    await clearVolatileReplayWindow();
    const duplicate = await sendSigned(app, message);
    expect(duplicate.status).toBe(200);
    expect(duplicate.text).toContain('MSA|AA');

    const evidence = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM investigations
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS detail_count,
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND message_type = 'ORM^O01') AS receipt_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND event_type = 'investigation.ordered') AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND action = 'investigation.ordered') AS audit_count`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(evidence[0]).toEqual({
      detail_count: 1,
      receipt_count: 1,
      timeline_count: 1,
      audit_count: 1,
    });
  });

  it('rejects sender/MSH-10 payload drift without a second clinical effect', async () => {
    const original = ormMessage('CAN-ORM-DRIFT');
    const first = await sendSigned(app, original);
    expect(first.status).toBe(200);

    await clearVolatileReplayWindow();
    const changed = original.replace('CBC^Complete Blood Count', 'CMP^Comprehensive Metabolic Panel');
    const drift = await sendSigned(app, changed);
    expect(drift.status).toBe(409);
    expect(drift.text).toContain('MSA|AE');

    const counts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM investigations
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND test_name LIKE 'CMP%') AS changed_details,
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid AND message_control_id = 'CAN-ORM-DRIFT') AS receipts`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(counts[0]).toEqual({ changed_details: 0, receipts: 1 });
  });
});
