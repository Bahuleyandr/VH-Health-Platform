// C-2 (audit 2026-06-18) — clinical-safety: atomic CRITICAL vitals alert
// persistence.
//
// Defect: clinical_alerts were INSERTed in a loop of separate auto-committing
// statements and the caller downgraded a failure to logger.warn + a 200, so a
// second simultaneous CRITICAL vital could be silently dropped.
//
// This deep test proves a vitals write carrying TWO CRITICAL vitals persists
// BOTH clinical_alerts rows (atomic fan-out) through the real recordVitals path.
// (The forced-persistence-failure-surfaces-as-error case is covered by the unit
// test src/tests/unit/vitalSignMonitorAtomicPersist.test.js, which can fault the
// transaction deterministically.)
//
// Self-isolating fixtures.

import prisma from '../lib/prisma.js';
import { recordVitals } from '../services/emr/vitalsChartService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a7777777-7777-4777-8777-777777770c01';
const PATIENT_PHONE = '9000077001';
const RECORDER_UID = 'a7777777-7777-4777-8777-777777770c02';

async function cleanup() {
  const u = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT_UID);
  if (u.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, u[0].id).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID, RECORDER_UID,
  ).catch(() => {});
}

describe('C-2 vitals CRITICAL alert persistence — atomic (deep)', () => {
  let patientId;

  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C2 Vitals Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    patientId = p[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C2 Vitals Recorder', 'DOCTOR', true, $3::uuid, NOW())`,
      RECORDER_UID, '9000077002', TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('persists BOTH CRITICAL alerts for a single vitals write (atomic fan-out)', async () => {
    // heart_rate 190 -> >= adult critical_max 180 -> CRITICAL
    // spo2 80        -> <= adult critical_min 85  -> CRITICAL
    const result = await recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      heart_rate: 190,
      spo2: 80,
      tenant_id: TENANT_ID,
    });

    // The service returns the generated alerts.
    const criticalAlerts = (result.alerts || []).filter((a) => a.severity === 'CRITICAL');
    expect(criticalAlerts.length).toBe(2);

    // Both rows are durably persisted in clinical_alerts.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT vital_name, severity FROM clinical_alerts
        WHERE patient_id = $1 AND alert_type = 'VITAL_ANOMALY' AND severity = 'CRITICAL'
        ORDER BY vital_name`,
      patientId,
    );
    expect(rows.length).toBe(2);
    const vitalNames = rows.map((r) => r.vital_name).sort();
    expect(vitalNames).toEqual(['heart_rate', 'oxygen_saturation']);

    // The alert rows carry the patient's tenant (scoped INSERT, not literal-only).
    const tenantRows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT tenant_id::text AS tenant_id FROM clinical_alerts WHERE patient_id = $1`,
      patientId,
    );
    expect(tenantRows.map((r) => r.tenant_id)).toContain(TENANT_ID);
  });
});
