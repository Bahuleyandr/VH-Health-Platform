// Roadmap C5 — ICU monitor vitals ingestion deep round-trip.
//
// Monitor ORU lands as an UNVERIFIED device-sourced vitals row through the
// standard write path (NEWS2 runs), shows on the review queue, a clinician
// verifies it (audited), and failures stay replayable in the interface
// inbox.

import prisma, { setTenant } from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { extractVitalsFromOru } from '../services/emr/deviceVitalsService.js';
import { parseHL7 } from '../services/hl7/hl7Parser.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199917${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;
let vitalsId;

const oruFor = (uid) => [
  'MSH|^~\\&|C5TESTMON|ICU||VHHEALTH|20260610120000||ORU^R01|C5MSG001|P|2.5',
  `PID|1||${uid}||C5TEST^Patient`,
  'OBR|1|||VITALS',
  'OBX|1|NM|8867-4^Heart rate||112|/min|||||F',
  'OBX|2|NM|59408-5^SpO2||91|%|||||F',
  'OBX|3|NM|9279-1^Respiratory rate||26|/min|||||F',
  'OBX|4|NM|8480-6^Systolic BP||92|mmHg|||||F',
].join('\r');

async function cleanup() {
  const patients = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id FROM users WHERE name = 'C5TEST Patient'`,
  ).catch(() => []);
  const patientUids = patients.map((row) => row.uid);
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_interface_messages WHERE raw_message LIKE '%C5TESTMON%'`,
  ).catch(() => {});
  if (patientUids.length) {
    for (const tenantId of new Set(patients.map((row) => row.tenant_id))) {
      await setTenant(tenantId, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE tasks
              SET workflow_sla_instance_id = NULL,
                  sla_completion_semantics = 'none'
            WHERE patient_uid = ANY($1::uuid[])`,
          patientUids,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM tasks WHERE patient_uid = ANY($1::uuid[])`,
          patientUids,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM workflow_sla_instances WHERE patient_uid = ANY($1::uuid[])`,
          patientUids,
        );
      }).catch(() => {});
    }
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
      patientUids,
    ).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
      patientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM news2_scores WHERE patient_uid = ANY($1::uuid[])`,
      patientUids,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE source_device LIKE 'C5TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'C5TEST Patient'`).catch(() => {});
}

d('Device vitals ingestion — deep round-trip (roadmap C5)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'C5TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('extractVitalsFromOru pulls PID-3 uid + OBX observations (pure)', () => {
    const parsed = parseHL7(oruFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    const out = extractVitalsFromOru(parsed);
    expect(out.patientUid).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(out.observations).toHaveLength(4);
    expect(out.observations[0]).toMatchObject({ loinc_code: '8867-4', value_numeric: 112 });
  });

  test('monitor ORU lands as an unverified device vitals row with NEWS2', async () => {
    const res = await authClient('NURSING_STAFF')
      .post('/api/v1/devices/vitals/ingest')
      .send({ message: oruFor(patientUid), device_code: 'C5TEST-MON-1' });
    expect(res.status).toBe(201);
    expect(res.body.data.mapped.sort()).toEqual(['59408-5', '8480-6', '8867-4', '9279-1']);
    vitalsId = Number(res.body.data.vitals.id);
    expect(res.body.data.vitals.source).toBe('device');
    expect(res.body.data.vitals.device_verified).toBe(false);
    // Sick-patient values → NEWS2 should produce a meaningful score object.
    expect(res.body.data.news2).toBeTruthy();

    const row = await prisma.$queryRawUnsafe(
      `SELECT source, source_device, device_verified, heart_rate, spo2 FROM vitals_chart WHERE id = $1`,
      vitalsId,
    );
    expect(row[0]).toMatchObject({ source: 'device', source_device: 'C5TEST-MON-1', device_verified: false });
    expect(Number(row[0].heart_rate)).toBe(112);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT tags, event_status FROM clinical_timeline_events
        WHERE source_table = 'vitals_chart' AND source_id = $1`,
      String(vitalsId),
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline[0].tags).toEqual(expect.arrayContaining(['device-synced', 'unverified']));
    expect(timeline[0].event_status).toBe('unverified');
  });

  test('review queue lists it; clinician verification flips + audits', async () => {
    const queue = await authClient('NURSING_STAFF')
      .get('/api/v1/devices/vitals/unverified')
      .query({ patient_uid: patientUid });
    expect(queue.status).toBe(200);
    expect(queue.body.data.vitals.some((v) => Number(v.id) === vitalsId)).toBe(true);

    const verify = await authClient('NURSING_STAFF').post(`/api/v1/devices/vitals/${vitalsId}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.data.vitals.device_verified).toBe(true);

    const again = await authClient('NURSING_STAFF').post(`/api/v1/devices/vitals/${vitalsId}/verify`);
    expect(again.status).toBe(404); // no longer unverified

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, chain_hash FROM clinical_audit_events
        WHERE action = 'vitals.device_verified' AND resource_id = $1`,
      String(vitalsId),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].chain_hash).toMatch(/^[0-9a-f]{64}$/); // C4 chain covers it

    // Canonical invariant: verification writes the timeline + audit PAIR in
    // the same transaction, keyed by the one-shot idempotency key.
    const pair = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_timeline_events WHERE idempotency_key = $1) AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events WHERE idempotency_key = $1) AS audit`,
      `vitals_chart:${vitalsId}:device_verified`,
    );
    expect(pair[0]).toMatchObject({ timeline: 1, audit: 1 });

    const emptyQueue = await authClient('NURSING_STAFF')
      .get('/api/v1/devices/vitals/unverified')
      .query({ patient_uid: patientUid });
    expect(emptyQueue.body.data.vitals.some((v) => Number(v.id) === vitalsId)).toBe(false);
  });

  test('unknown patient and unmappable payloads fail closed but stay in the inbox', async () => {
    const ghost = await authClient('NURSING_STAFF')
      .post('/api/v1/devices/vitals/ingest')
      .send({ message: oruFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), device_code: 'C5TEST-MON-1' });
    expect(ghost.status).toBe(404);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, error FROM lab_interface_messages
        WHERE message_type = 'ORU^VITALS' AND raw_message LIKE '%bbbbbbbb-bbbb%'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(inbox[0].status).toBe('failed');

    const noPid = await authClient('NURSING_STAFF')
      .post('/api/v1/devices/vitals/ingest')
      .send({ message: 'MSH|^~\\&|C5TESTMON|ICU||VH|20260610||ORU^R01|X|P|2.5\rOBX|1|NM|8867-4^HR||80|/min|||||F' });
    expect(noPid.status).toBe(400);
  });
});
