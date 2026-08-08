// Device-gateway ingest branch — control-id lifecycle + observation
// timestamps (C-M3 / C-L5) and the verify canonical pair (C-L1).
//
// The load-bearing contract: a DEVICE_GATEWAY control-id may only ever be
// answered {duplicate:true, ack:'AA'} when a previous attempt DURABLY
// succeeded (charted) or was definitively suppressed. A failed ingest must
// leave no device_vitals_control_ids row so the gateway's spool retry is
// re-processed instead of silently dropped.

import prisma from '../lib/prisma.js';
import { ingestDeviceVitals, verifyDeviceVitals } from '../services/emr/deviceVitalsService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = 'cafe0c53-0000-4000-8000-0000000000a1';
const PATIENT_RETRY = 'cafe0c53-0000-4000-8000-0000000000b1';
const PATIENT_SUPPRESS = 'cafe0c53-0000-4000-8000-0000000000b2';
const PATIENT_TS_DEVICE = 'cafe0c53-0000-4000-8000-0000000000b3';
const PATIENT_TS_NONE = 'cafe0c53-0000-4000-8000-0000000000b4';
const PATIENT_TS_FUTURE = 'cafe0c53-0000-4000-8000-0000000000b5';
const PATIENT_CONCURRENT = 'cafe0c53-0000-4000-8000-0000000000b6';
const GHOST_PATIENT = 'cafe0c53-0000-4000-8000-00000000dead'; // never created
const GATEWAY_ACTOR = 'cafe0c53-0000-4000-8000-0000000000ac';
const DEVICE_CODE = 'GWCM3-MON-1';

const GW_CONTEXT = { actorRole: 'DEVICE_GATEWAY', actorUid: GATEWAY_ACTOR };

const HOSPITAL_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const hl7Local = (dt) => {
  const parts = Object.fromEntries(
    HOSPITAL_CLOCK.formatToParts(dt)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
};

function oru({ uid, control, hr = '80', obx14 = null, obr7 = null }) {
  return [
    `MSH|^~\\&|${DEVICE_CODE}|ICU||VHHEALTH|20260610120000||ORU^R01|${control}|P|2.5`,
    `PID|1||${uid}||GWCM3^Patient`,
    obr7 ? `OBR|1|||VITALS|||${obr7}` : 'OBR|1|||VITALS',
    `OBX|1|NM|8867-4^Heart rate||${hr}|/min|||||F${obx14 ? `|||${obx14}` : ''}`,
  ].join('\r');
}

async function ingest(message) {
  return ingestDeviceVitals(
    { message, deviceCode: DEVICE_CODE, tenantId: TENANT },
    GW_CONTEXT,
  );
}

async function controlIdRows(controlId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, interface_message_id FROM device_vitals_control_ids
      WHERE tenant_id = $1::uuid AND control_id = $2`,
    TENANT,
    controlId,
  );
}

async function vitalsCount(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM vitals_chart
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND source = 'device'`,
    TENANT,
    patientUid,
  );
  return Number(rows[0].n);
}

async function cleanup() {
  const patients = [
    PATIENT_RETRY, PATIENT_SUPPRESS, PATIENT_TS_DEVICE, PATIENT_TS_NONE, PATIENT_TS_FUTURE,
    PATIENT_CONCURRENT,
  ];
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS test_device_vitals_concurrent_hold ON vitals_chart`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS test_device_vitals_concurrent_hold()`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_interface_messages WHERE raw_message LIKE '%GWCM3%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE source_device = 'GWCM3-MON-1'`,
  ).catch(() => {});
  // Control ids, suppression counters, and sample observations cascade off
  // the registry row.
  await prisma.$executeRawUnsafe(
    `DELETE FROM device_registry WHERE tenant_id = $1::uuid AND device_code = $2`,
    TENANT,
    DEVICE_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, TENANT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM news2_scores WHERE patient_uid = ANY($1::uuid[])`, patients,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`, patients,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`, TENANT,
  ).catch(() => {});
}

d('Device-gateway vitals ingest — control-id lifecycle + timestamps (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'dv-gwcm3', 'DV Gateway CM3')
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    const patients = [
      [PATIENT_RETRY, '+919000053101'],
      [PATIENT_SUPPRESS, '+919000053102'],
      [PATIENT_TS_DEVICE, '+919000053103'],
      [PATIENT_TS_NONE, '+919000053104'],
      [PATIENT_TS_FUTURE, '+919000053105'],
      [PATIENT_CONCURRENT, '+919000053106'],
    ];
    for (const [uid, phone] of patients) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'GWCM3 Patient', 'PATIENT', true, NOW())`,
        uid, TENANT, phone,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO device_registry (tenant_id, device_code, display_name, kind, status)
       VALUES ($1::uuid, $2, 'GWCM3 Test Monitor', 'monitor', 'active')`,
      TENANT, DEVICE_CODE,
    );
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  test('failed ingest does NOT consume the control-id; retry of the SAME control-id succeeds (C-M3)', async () => {
    const controlId = 'GWCM3-CTL-RETRY';

    // Fails AFTER the duplicate check: PID-3 patient does not exist in tenant.
    await expect(ingest(oru({ uid: GHOST_PATIENT, control: controlId })))
      .rejects.toMatchObject({ code: 'DEVICE_VITALS_PATIENT_NOT_FOUND' });

    // The failure left no control-id row behind.
    expect(await controlIdRows(controlId)).toHaveLength(0);
    expect(await vitalsCount(PATIENT_RETRY)).toBe(0);

    // Gateway spool retry: same control-id, corrected message → charts.
    const res = await ingest(oru({ uid: PATIENT_RETRY, control: controlId, hr: '82' }));
    expect(res.duplicate).toBeUndefined();
    expect(res.ack).toBe('AA');
    expect(Number(res.vitals.id)).toBeGreaterThan(0);
    expect(await vitalsCount(PATIENT_RETRY)).toBe(1);

    // Now — and only now — the control-id is consumed, linked to the
    // ingested interface message.
    const consumed = await controlIdRows(controlId);
    expect(consumed).toHaveLength(1);
    expect(Number(consumed[0].interface_message_id)).toBe(Number(res.interface_message_id));
  }, 30000);

  test('successful ingest then same control-id → duplicate, no second vitals row', async () => {
    const redelivered = await ingest(oru({ uid: PATIENT_RETRY, control: 'GWCM3-CTL-RETRY', hr: '82' }));
    expect(redelivered.duplicate).toBe(true);
    expect(redelivered.ack).toBe('AA');
    expect(await vitalsCount(PATIENT_RETRY)).toBe(1);
  }, 30000);

  test('concurrent delivery of one control-id commits exactly one clinical record', async () => {
    const controlId = 'GWCM3-CTL-CONCURRENT';
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION test_device_vitals_concurrent_hold()
       RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN
         IF NEW.patient_uid = 'cafe0c53-0000-4000-8000-0000000000b6'::uuid THEN
           PERFORM pg_sleep(1);
         END IF;
         RETURN NEW;
       END
       $fn$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_device_vitals_concurrent_hold
       BEFORE INSERT ON vitals_chart
       FOR EACH ROW EXECUTE FUNCTION test_device_vitals_concurrent_hold()`,
    );

    let results;
    try {
      results = await Promise.all([
        ingest(oru({ uid: PATIENT_CONCURRENT, control: controlId, hr: '160' })),
        ingest(oru({ uid: PATIENT_CONCURRENT, control: controlId, hr: '160' })),
      ]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_device_vitals_concurrent_hold ON vitals_chart`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS test_device_vitals_concurrent_hold()`,
      );
    }

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ack === 'AA')).toBe(true);
    expect(results.filter((result) => result.duplicate === true)).toHaveLength(1);
    expect(results.filter((result) => result.vitals)).toHaveLength(1);
    expect(await vitalsCount(PATIENT_CONCURRENT)).toBe(1);
    expect(await controlIdRows(controlId)).toHaveLength(1);

    const counts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM news2_scores
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS news2,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND event_type = 'vitals.recorded') AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND resource_table = 'vitals_chart') AS audit,
         (SELECT COUNT(*)::int FROM lab_interface_messages
           WHERE tenant_id = $1::uuid AND raw_message LIKE '%GWCM3-CTL-CONCURRENT%') AS inbox,
         (SELECT COUNT(*)::int FROM device_vital_sample_observations
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND vital_name = 'heart_rate') AS artifact_observations`,
      TENANT,
      PATIENT_CONCURRENT,
    );
    expect(counts[0]).toMatchObject({
      news2: 1,
      timeline: 1,
      audit: 1,
      inbox: 1,
      artifact_observations: 1,
    });
  }, 30000);

  test('suppressed sample consumes the control-id; redelivery dedupes', async () => {
    // First normal sample charts (interval due — nothing prior).
    const first = await ingest(oru({ uid: PATIENT_SUPPRESS, control: 'GWCM3-CTL-SUP1', hr: '80' }));
    expect(first.suppressed).toBeUndefined();
    expect(await vitalsCount(PATIENT_SUPPRESS)).toBe(1);

    // Identical sample inside the charting interval, no NEWS2 delta →
    // definitive suppression. The control-id is consumed anyway.
    const second = await ingest(oru({ uid: PATIENT_SUPPRESS, control: 'GWCM3-CTL-SUP2', hr: '80' }));
    expect(second.suppressed).toBe(true);
    expect(second.reason).toBe('charting_interval');
    expect(await controlIdRows('GWCM3-CTL-SUP2')).toHaveLength(1);
    expect(await vitalsCount(PATIENT_SUPPRESS)).toBe(1);

    // Redelivery of the suppressed sample is answered as a duplicate.
    const redelivered = await ingest(oru({ uid: PATIENT_SUPPRESS, control: 'GWCM3-CTL-SUP2', hr: '80' }));
    expect(redelivered.duplicate).toBe(true);
    expect(await vitalsCount(PATIENT_SUPPRESS)).toBe(1);
  }, 30000);

  test('OBX-14 device time stamps the vitals row (C-L5)', async () => {
    const deviceTime = new Date(Date.now() - 10 * 60 * 1000);
    deviceTime.setMilliseconds(0);
    const res = await ingest(oru({
      uid: PATIENT_TS_DEVICE,
      control: 'GWCM3-CTL-TS1',
      hr: '78',
      obx14: hl7Local(deviceTime),
    }));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT recorded_at FROM vitals_chart WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(res.vitals.id), TENANT,
    );
    const recordedAt = new Date(rows[0].recorded_at);
    expect(Math.abs(recordedAt.getTime() - deviceTime.getTime())).toBeLessThan(1000);

    // Receipt-vs-observation is auditable on the interface message verdicts.
    const msg = await prisma.$queryRawUnsafe(
      `SELECT verdicts FROM lab_interface_messages WHERE id = $1`,
      Number(res.interface_message_id),
    );
    expect(msg[0].verdicts.observed_at_source).toBe('obx14');
    expect(new Date(msg[0].verdicts.observed_at).getTime()).toBe(deviceTime.getTime());
  }, 30000);

  test('ORU without timestamps falls back to receipt time', async () => {
    const before = Date.now();
    const res = await ingest(oru({ uid: PATIENT_TS_NONE, control: 'GWCM3-CTL-TS2', hr: '79' }));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT recorded_at FROM vitals_chart WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(res.vitals.id), TENANT,
    );
    const recordedAt = new Date(rows[0].recorded_at).getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(before - 5000);
    expect(recordedAt).toBeLessThanOrEqual(Date.now() + 5000);

    const msg = await prisma.$queryRawUnsafe(
      `SELECT verdicts FROM lab_interface_messages WHERE id = $1`,
      Number(res.interface_message_id),
    );
    expect(msg[0].verdicts.observed_at_source).toBe('receipt-fallback');
    expect(msg[0].verdicts.observed_at).toBeNull();
  }, 30000);

  test('future OBX-14 (device clock skew) is ignored — receipt time wins', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const before = Date.now();
    const res = await ingest(oru({
      uid: PATIENT_TS_FUTURE,
      control: 'GWCM3-CTL-TS3',
      hr: '81',
      obx14: hl7Local(future),
    }));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT recorded_at FROM vitals_chart WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(res.vitals.id), TENANT,
    );
    const recordedAt = new Date(rows[0].recorded_at).getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(before - 5000);
    expect(recordedAt).toBeLessThanOrEqual(Date.now() + 5000);

    const msg = await prisma.$queryRawUnsafe(
      `SELECT verdicts FROM lab_interface_messages WHERE id = $1`,
      Number(res.interface_message_id),
    );
    expect(msg[0].verdicts.observed_at_source).toBe('receipt-fallback');
  }, 30000);

  test('verifyDeviceVitals writes exactly one timeline + audit pair in one tx (C-L1)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM vitals_chart
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND source = 'device'
        LIMIT 1`,
      TENANT, PATIENT_RETRY,
    );
    const vitalsId = Number(rows[0].id);
    const key = `vitals_chart:${vitalsId}:device_verified`;

    const verified = await verifyDeviceVitals(vitalsId, {
      actorUid: GATEWAY_ACTOR,
      actorRole: 'NURSING_STAFF',
      tenantId: TENANT,
    });
    expect(verified.device_verified).toBe(true);
    expect(Number(verified.id)).toBe(vitalsId);

    const pair = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_timeline_events WHERE idempotency_key = $1) AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events WHERE idempotency_key = $1) AS audit`,
      key,
    );
    expect(pair[0]).toMatchObject({ timeline: 1, audit: 1 });

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, event_status, tags FROM clinical_timeline_events WHERE idempotency_key = $1`,
      key,
    );
    expect(timeline[0].event_type).toBe('vitals.device_verified');
    expect(timeline[0].event_status).toBe('verified');
    expect(timeline[0].tags).toEqual(expect.arrayContaining(['vitals', 'device-synced', 'verified']));

    // Verification is one-shot: the second call is NOT_FOUND and the
    // canonical pair stays exactly one row per table.
    await expect(verifyDeviceVitals(vitalsId, {
      actorUid: GATEWAY_ACTOR,
      actorRole: 'NURSING_STAFF',
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'DEVICE_VITALS_NOT_FOUND' });

    const pairAfter = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_timeline_events WHERE idempotency_key = $1) AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events WHERE idempotency_key = $1) AS audit`,
      key,
    );
    expect(pairAfter[0]).toMatchObject({ timeline: 1, audit: 1 });
  }, 30000);
});
