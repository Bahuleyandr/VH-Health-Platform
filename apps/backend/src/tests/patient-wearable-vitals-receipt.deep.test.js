import prisma from '../lib/prisma.js';
import { recordPatientWearableVital } from '../services/health/patientWearableVitalsService.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '85400000-0000-4000-8000-000000000001';
const SAMPLE_ID = 'HEART_RATE:pr854-deep-receipt';

async function cleanup() {
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND source_table = 'patient_vitals'`,
    TENANT,
    PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND resource_table = 'patient_vitals'`,
    TENANT,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_vitals
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND source = 'health_connect'
        AND source_record_id = $3`,
    TENANT,
    PATIENT_UID,
    SAMPLE_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM users WHERE uid = $1::uuid',
    PATIENT_UID,
  ).catch(() => {});
}

function write(heartRate = 72) {
  return recordPatientWearableVital({
    tenantId: TENANT,
    patientUid: PATIENT_UID,
    actorRole: 'PATIENT',
    heartRate,
    source: 'health_connect',
    sourceRecordId: SAMPLE_ID,
    recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
  });
}

d('patient wearable vital durable receipts', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '9854854001', 'PR 854 Receipt Patient',
          'PATIENT', true, NOW())`,
      PATIENT_UID,
      TENANT,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('a concurrent replay creates one detail row and one canonical timeline/audit pair', async () => {
    const results = await Promise.all([write(), write()]);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map(result => String(result.row.id))).size).toBe(1);

    const detail = await prisma.$queryRawUnsafe(
      `SELECT id::text AS id, heart_rate, recorded_at, recorded_at_source,
              source_record_hash
         FROM patient_vitals
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND source = 'health_connect'
          AND source_record_id = $3`,
      TENANT,
      PATIENT_UID,
      SAMPLE_ID,
    );
    expect(detail).toHaveLength(1);
    expect(detail[0].heart_rate).toBe(72);
    expect(detail[0].recorded_at.toISOString()).toBe('2026-08-11T02:59:00.000Z');
    expect(detail[0].recorded_at_source.toISOString()).toBe('2026-08-11T02:59:00.000Z');
    expect(detail[0].source_record_hash).toMatch(/^[0-9a-f]{64}$/);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, event_subtype, event_status, payload, tags
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'patient_vitals'
          AND source_id = $2`,
      TENANT,
      detail[0].id,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_type: 'vitals.recorded',
      event_subtype: 'wearable',
      event_status: 'unverified',
      payload: expect.objectContaining({
        patient_generated: true,
        device_synced: true,
        device_verified: false,
      }),
      tags: expect.arrayContaining(['vitals', 'patient-generated', 'device-synced', 'unverified']),
    });

    const audit = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND resource_table = 'patient_vitals'
          AND resource_id = $2`,
      TENANT,
      detail[0].id,
    );
    expect(audit).toHaveLength(1);
  });

  test('the same sample identifier cannot be reused with changed clinical data', async () => {
    await write();
    await expect(write(73)).rejects.toMatchObject({
      statusCode: 409,
      code: 'WEARABLE_VITAL_RECEIPT_MISMATCH',
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT heart_rate
         FROM patient_vitals
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND source = 'health_connect'
          AND source_record_id = $3`,
      TENANT,
      PATIENT_UID,
      SAMPLE_ID,
    );
    expect(rows).toEqual([{ heart_rate: 72 }]);
  });
});
