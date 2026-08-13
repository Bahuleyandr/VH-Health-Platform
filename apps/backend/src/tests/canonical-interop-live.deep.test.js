import crypto from 'node:crypto';

import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import {
  __testing__ as hl7ClinicalTesting,
  processHl7InboundClinicalMessage,
} from '../services/hl7/hl7InboundClinicalCommandService.js';
import { __testing__ as signedRequestTesting } from '../utils/signedRequest.js';

// This suite exercises the I03 inbound ingress, which is now authoritative on
// HL7_INBOUND_ENABLED and fails closed when the flag is not exactly 'true'.
// Declaring the interface ON is a precondition of exercising it at all; the
// refused-while-off contract is pinned by hl7-inbound-disabled.deep.test.js.
process.env.HL7_INBOUND_ENABLED = 'true';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

const TENANT_ID = 'ca110000-0000-4000-8000-000000000001';
const PATIENT_UID = 'ca110000-0000-4000-8000-000000000002';
const OTHER_PATIENT_UID = 'ca110000-0000-4000-8000-000000000003';
const STAFF_UID = 'ca110000-0000-4000-8000-000000000004';
const OLDER_ENCOUNTER_ID = 'ca110000-0000-4000-8000-000000000011';
const NEWER_ENCOUNTER_ID = 'ca110000-0000-4000-8000-000000000012';
const OTHER_ENCOUNTER_ID = 'ca110000-0000-4000-8000-000000000013';
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

function adtMessage(
  event,
  controlId,
  ward,
  bed,
  eventTime = '20260813080500+0530',
  {
    visitNumber = `VISIT-${controlId}`,
    patientUid = PATIENT_UID,
    sendingApp = 'CANONICAL-SENDER',
    sendingFacility = 'CANONICAL-SITE',
  } = {},
) {
  const pv1 = Array(46).fill('');
  pv1[0] = 'PV1';
  pv1[1] = '1';
  pv1[2] = 'I';
  pv1[3] = `${ward}^${bed}`;
  pv1[19] = visitNumber || '';
  pv1[44] = eventTime;
  pv1[45] = event === 'A03' ? eventTime : '';
  return [
    `MSH|^~\\&|${sendingApp}|${sendingFacility}|VH|${FACILITY}|${eventTime}||ADT^${event}|${controlId}|P|2.5`,
    `EVN|${event}|${eventTime}`,
    `PID|1||${patientUid}||Canonical Interop Patient||19900101|F|||Addr|||${PHONE}`,
    pv1.join('|'),
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
    `DELETE FROM admissions
      WHERE tenant_id = $1::uuid
        AND patient_uid IN ($2::uuid, $3::uuid, $4::uuid)`,
    TENANT_ID,
    PATIENT_UID,
    OTHER_PATIENT_UID,
    STAFF_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations
      WHERE tenant_id = $1::uuid
        AND patient_uid IN ($2::uuid, $3::uuid)`,
    TENANT_ID,
    PATIENT_UID,
    STAFF_UID,
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
    `DELETE FROM users
      WHERE tenant_id = $1::uuid
        AND uid IN ($2::uuid, $3::uuid, $4::uuid)`,
    TENANT_ID,
    PATIENT_UID,
    OTHER_PATIENT_UID,
    STAFF_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

d('live HL7 canonical clinical commands', () => {
  let app;
  let authenticatedSenderIdentity;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'canonical-interop-live', 'Canonical Interop Live')`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3, 'Canonical Interop Patient', 'PATIENT', true, NOW()),
         ($4::uuid, $2::uuid, '+919811100003', 'Canonical Interop Other Patient', 'PATIENT', true, NOW()),
         ($5::uuid, $2::uuid, '+919811100004', 'Canonical Interop Staff', 'DOCTOR', true, NOW())`,
      PATIENT_UID,
      TENANT_ID,
      PHONE,
      OTHER_PATIENT_UID,
      STAFF_UID,
    );
    await upsertInteropSecret({
      tenantId: TENANT_ID,
      kind: 'hl7_inbound',
      senderIdentifier: FACILITY,
      secret: SECRET,
    });
    const credential = await resolveInteropCredentialSnapshot('hl7_inbound', FACILITY);
    expect(credential.tenant_id).toBe(TENANT_ID);
    authenticatedSenderIdentity = `hl7-inbound-credential:${credential.id}`;
    app = buildApp();
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  }, 30_000);

  it('commits A01/A02/A03 as one admission mutation, timeline, audit, and durable receipt each', async () => {
    const visitNumber = 'CANONICAL-VISIT-001';
    const messages = [
      adtMessage('A01', 'CAN-ADT-001', 'WARD-1', 'BED-1', '20260813080500+0530', { visitNumber }),
      adtMessage('A02', 'CAN-ADT-002', 'WARD-2', 'BED-9', '20260813081000+0530', { visitNumber }),
      adtMessage('A03', 'CAN-ADT-003', 'WARD-2', 'BED-9', '20260813082000+0530', { visitNumber }),
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
    const changed = original
      .replace('CANONICAL-SENDER|CANONICAL-SITE', 'CHANGED-SENDER|CHANGED-SITE')
      .replace('CBC^Complete Blood Count', 'CMP^Comprehensive Metabolic Panel');
    const drift = await sendSigned(app, changed);
    expect(drift.status).toBe(409);
    expect(drift.text).toContain('MSA|AR|CAN-ORM-DRIFT|Message rejected');

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

  it('serializes concurrent duplicates into one detail, timeline, audit, and receipt', async () => {
    const message = ormMessage('CAN-ORM-CONCURRENT');
    const responses = await Promise.all([
      sendSigned(app, message),
      sendSigned(app, message),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(responses.every(response => response.text.includes('MSA|AA'))).toBe(true);

    const [counts] = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM investigations investigation
           JOIN hl7_inbound_clinical_receipts receipt
             ON receipt.detail_table = 'investigations'
            AND receipt.detail_id = investigation.id
          WHERE receipt.tenant_id = $1::uuid
            AND receipt.message_control_id = 'CAN-ORM-CONCURRENT') AS details,
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid
             AND message_control_id = 'CAN-ORM-CONCURRENT') AS receipts,
         (SELECT COUNT(*)::int FROM clinical_timeline_events timeline
           JOIN hl7_inbound_clinical_receipts receipt
             ON receipt.timeline_event_id = timeline.id
          WHERE receipt.tenant_id = $1::uuid
            AND receipt.message_control_id = 'CAN-ORM-CONCURRENT') AS timelines,
         (SELECT COUNT(*)::int FROM clinical_audit_events audit
           JOIN hl7_inbound_clinical_receipts receipt
             ON receipt.audit_event_id = audit.id
          WHERE receipt.tenant_id = $1::uuid
            AND receipt.message_control_id = 'CAN-ORM-CONCURRENT') AS audits`,
      TENANT_ID,
    );
    expect(counts).toEqual({ details: 1, receipts: 1, timelines: 1, audits: 1 });
  });

  it('rejects an active same-tenant staff row at both route and transaction boundaries', async () => {
    const staffMessage = adtMessage(
      'A01',
      'CAN-ADT-STAFF',
      'STAFF-WARD',
      'STAFF-BED',
      '20260813082500+0530',
      { patientUid: STAFF_UID },
    );
    const response = await sendSigned(app, staffMessage);
    expect(response.status).toBe(404);
    expect(response.text).toContain('MSA|AE|CAN-ADT-STAFF');

    await expect(processHl7InboundClinicalMessage({
      tenantId: TENANT_ID,
      patientUid: STAFF_UID,
      patientPhone: '+919811100004',
      senderIdentity: authenticatedSenderIdentity,
      messageControlId: 'CAN-ORM-STAFF-DIRECT',
      messageType: 'ORM^O01',
      message: ormMessage('CAN-ORM-STAFF-DIRECT').replace(PATIENT_UID, STAFF_UID),
      order: { test_name: 'Should Not Exist', status: 'PENDING' },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'HL7_CLINICAL_PATIENT_INVALID',
    });

    const [counts] = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM admissions
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS admissions,
         (SELECT COUNT(*)::int FROM investigations
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS investigations,
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS receipts`,
      TENANT_ID,
      STAFF_UID,
    );
    expect(counts).toEqual({ admissions: 0, investigations: 0, receipts: 0 });
  });

  it('permanently rejects a PV1-19 value that resolves to multiple active admissions', async () => {
    const [{ id: numericId }] = await prisma.$queryRawUnsafe(
      `SELECT nextval(pg_get_serial_sequence('admissions', 'id'))::integer AS id`,
    );
    const visitNumber = String(numericId);
    const migrationSourceKey = hl7ClinicalTesting.visitMigrationSourceKey({
      senderIdentity: authenticatedSenderIdentity,
      visitNumber,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (id, tenant_id, patient_uid, status, ward, bed_number,
          admitted_at, created_at, updated_at)
       VALUES
         ($1, $2::uuid, $3::uuid, 'ADMITTED', 'NUMERIC-WARD', 'NUMERIC-BED',
          NOW(), NOW(), NOW())`,
      numericId,
      TENANT_ID,
      PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, ward, bed_number,
          admitted_at, migration_source_key, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'ADMITTED', 'HASH-WARD', 'HASH-BED',
          NOW(), $3, NOW(), NOW())`,
      TENANT_ID,
      PATIENT_UID,
      migrationSourceKey,
    );

    const response = await sendSigned(app, adtMessage(
      'A02',
      'CAN-ADT-AMBIGUOUS',
      'SHOULD-NOT-WRITE',
      'NO-BED',
      '20260813082700+0530',
      { visitNumber },
    ));
    expect(response.status).toBe(409);
    expect(response.text).toContain('MSA|AR|CAN-ADT-AMBIGUOUS|Message rejected');

    const admissions = await prisma.$queryRawUnsafe(
      `SELECT status, ward, bed_number
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND (id = $2 OR migration_source_key = $3)
        ORDER BY id`,
      TENANT_ID,
      numericId,
      migrationSourceKey,
    );
    expect(admissions).toEqual([
      { status: 'ADMITTED', ward: 'NUMERIC-WARD', bed_number: 'NUMERIC-BED' },
      { status: 'ADMITTED', ward: 'HASH-WARD', bed_number: 'HASH-BED' },
    ]);
  });

  it('targets the exact older PV1-19 visit and permanently rejects unknown or mismatched visits', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, status, ward, bed_number,
          admitted_at, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'ADMITTED', 'OLDER-WARD', 'OLDER-BED',
          '2026-08-11T08:00:00.000Z', '2026-08-11T08:00:00.000Z', NOW()),
         ($1::uuid, $2::uuid, $4::uuid, 'ADMITTED', 'NEWER-WARD', 'NEWER-BED',
          '2026-08-12T08:00:00.000Z', '2026-08-12T08:00:00.000Z', NOW()),
         ($1::uuid, $5::uuid, $6::uuid, 'ADMITTED', 'OTHER-WARD', 'OTHER-BED',
          '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z', NOW())`,
      TENANT_ID,
      PATIENT_UID,
      OLDER_ENCOUNTER_ID,
      NEWER_ENCOUNTER_ID,
      OTHER_PATIENT_UID,
      OTHER_ENCOUNTER_ID,
    );

    const targeted = await sendSigned(app, adtMessage(
      'A02',
      'CAN-ADT-EXACT-OLDER',
      'TARGET-WARD',
      'TARGET-BED',
      '20260813083000+0530',
      { visitNumber: OLDER_ENCOUNTER_ID },
    ));
    expect(targeted.status).toBe(200);
    expect(targeted.text).toContain('MSA|AA|CAN-ADT-EXACT-OLDER|Message accepted');

    const admissions = await prisma.$queryRawUnsafe(
      `SELECT encounter_id::text, status, ward, bed_number
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND encounter_id IN ($2::uuid, $3::uuid)
        ORDER BY encounter_id`,
      TENANT_ID,
      OLDER_ENCOUNTER_ID,
      NEWER_ENCOUNTER_ID,
    );
    expect(admissions).toEqual([
      {
        encounter_id: OLDER_ENCOUNTER_ID,
        status: 'TRANSFERRED',
        ward: 'TARGET-WARD',
        bed_number: 'TARGET-BED',
      },
      {
        encounter_id: NEWER_ENCOUNTER_ID,
        status: 'ADMITTED',
        ward: 'NEWER-WARD',
        bed_number: 'NEWER-BED',
      },
    ]);

    const unknown = await sendSigned(app, adtMessage(
      'A02',
      'CAN-ADT-UNKNOWN-VISIT',
      'SHOULD-NOT-WRITE',
      'NO-BED',
      '20260813083500+0530',
      { visitNumber: 'ca110000-0000-4000-8000-000000000099' },
    ));
    expect(unknown.status).toBe(409);
    expect(unknown.text).toContain('MSA|AR|CAN-ADT-UNKNOWN-VISIT|Message rejected');

    const mismatched = await sendSigned(app, adtMessage(
      'A03',
      'CAN-ADT-MISMATCHED-VISIT',
      'SHOULD-NOT-WRITE',
      'NO-BED',
      '20260813084000+0530',
      { visitNumber: OTHER_ENCOUNTER_ID },
    ));
    expect(mismatched.status).toBe(409);
    expect(mismatched.text).toContain('MSA|AR|CAN-ADT-MISMATCHED-VISIT|Message rejected');

    const rejectedEffects = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM hl7_inbound_clinical_receipts
           WHERE tenant_id = $1::uuid
             AND message_control_id IN (
               'CAN-ADT-UNKNOWN-VISIT', 'CAN-ADT-MISMATCHED-VISIT'
             )) AS receipts,
         (SELECT ward FROM admissions
           WHERE tenant_id = $1::uuid AND encounter_id = $2::uuid) AS other_ward`,
      TENANT_ID,
      OTHER_ENCOUNTER_ID,
    );
    expect(rejectedEffects[0]).toEqual({ receipts: 0, other_ward: 'OTHER-WARD' });
  });
});
