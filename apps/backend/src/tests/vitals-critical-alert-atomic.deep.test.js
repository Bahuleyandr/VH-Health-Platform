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
import { cleanupCriticalVitalFixtures } from './helpers/criticalVitalFixtureCleanup.js';
import { recordVitals } from '../services/emr/vitalsChartService.js';
import { clearResuscitationFlagCache } from '../services/clinical/resuscitationEventService.js';
import { extractSqlState } from '../services/security/schemaMissingGuard.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a7777777-7777-4777-8777-777777770c01';
const PATIENT_PHONE = '9000077001';
const RECORDER_UID = 'a7777777-7777-4777-8777-777777770c02';
const CLEANUP_CONTROL_REASON = 'C2 vitals cleanup boundary control';

async function withResuscitationEnabled(run) {
  const readSettings = () => prisma.$queryRawUnsafe(
    `SELECT to_jsonb(settings) AS snapshot, acceptance_snapshot::text AS acceptance_json
       FROM resuscitation_settings AS settings WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  );
  const before = await readSettings();
  const acceptance = JSON.stringify({ fixture: CLEANUP_CONTROL_REASON });
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO resuscitation_settings (tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot)
       VALUES ($1::uuid, TRUE, NOW(), $2::uuid, $3::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, enabled_at = EXCLUDED.enabled_at,
         enabled_by = EXCLUDED.enabled_by, acceptance_snapshot = EXCLUDED.acceptance_snapshot`,
      TENANT_ID, RECORDER_UID, acceptance,
    );
    clearResuscitationFlagCache();
    return await run();
  } finally {
    try {
      if (before.length) {
        await prisma.$executeRawUnsafe(
          `UPDATE resuscitation_settings AS settings
              SET enabled = prior.enabled, enabled_at = prior.enabled_at,
                  enabled_by = prior.enabled_by, acceptance_snapshot = $3::jsonb
             FROM jsonb_populate_record(NULL::resuscitation_settings, $2::jsonb) AS prior
            WHERE settings.tenant_id = $1::uuid AND prior.tenant_id = settings.tenant_id`,
          TENANT_ID, JSON.stringify(before[0].snapshot), before[0].acceptance_json,
        );
      } else {
        await prisma.$executeRawUnsafe(
          `DELETE FROM resuscitation_settings
            WHERE tenant_id = $1::uuid AND enabled_by = $2::uuid AND acceptance_snapshot = $3::jsonb`,
          TENANT_ID, RECORDER_UID, acceptance,
        );
      }
      expect(await readSettings()).toEqual(before);
    } finally {
      clearResuscitationFlagCache();
    }
  }
}

async function cleanupControls() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM resuscitation_device_links AS link
        USING resuscitation_events AS event
        WHERE link.resuscitation_event_id = event.id
          AND event.tenant_id = $1::uuid
          AND event.patient_uid IN ($2::uuid, $3::uuid)
          AND event.reason = $4 AND event.metadata->>'cleanupTest' = $4
          AND link.tenant_id = event.tenant_id
          AND link.patient_uid IN ($2::uuid, $3::uuid)
          AND link.evidence->>'cleanupTest' = $4`,
      TENANT_ID, PATIENT_UID, RECORDER_UID, CLEANUP_CONTROL_REASON,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM resuscitation_events
        WHERE tenant_id = $1::uuid
          AND patient_uid IN ($2::uuid, $3::uuid)
          AND reason = $4 AND metadata->>'cleanupTest' = $4`,
      TENANT_ID, PATIENT_UID, RECORDER_UID, CLEANUP_CONTROL_REASON,
    );
  });
}

async function insertCleanupControl(patientUid, triggerSource, source, {
  linkPatientUid = patientUid,
  linkKind = 'clinical_alert',
  linkSource = 'vitalSignMonitor',
} = {}) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO resuscitation_events (tenant_id, patient_uid, trigger_source, reason, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
      TENANT_ID, patientUid, triggerSource, CLEANUP_CONTROL_REASON,
      JSON.stringify({ source, cleanupTest: CLEANUP_CONTROL_REASON }),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO resuscitation_device_links
         (tenant_id, resuscitation_event_id, patient_uid, link_kind, evidence)
       SELECT tenant_id, id, $2::uuid, $8, $3::jsonb
         FROM resuscitation_events
        WHERE tenant_id = $1::uuid AND patient_uid = $4::uuid
          AND trigger_source = $5 AND reason = $6
          AND metadata->>'source' = $7 AND metadata->>'cleanupTest' = $6`,
      TENANT_ID, linkPatientUid,
      JSON.stringify({ source: linkSource, cleanupTest: CLEANUP_CONTROL_REASON }),
      patientUid, triggerSource, CLEANUP_CONTROL_REASON, source, linkKind,
    );
  });
}

async function cleanup() {
  await cleanupControls();
  await cleanupCriticalVitalFixtures(prisma, TENANT_ID, [PATIENT_UID]);
  const u = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT_UID);
  if (u.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, u[0].id);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID);
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID);
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID);
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID, RECORDER_UID,
  );
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
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('persists BOTH CRITICAL alerts for a single vitals write (atomic fan-out)', () => withResuscitationEnabled(async () => {
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

    const events = await prisma.$queryRawUnsafe(
      `SELECT id FROM resuscitation_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND trigger_source = 'critical_vital'
          AND metadata->>'source' = 'vitalSignMonitor'`,
      TENANT_ID, PATIENT_UID,
    );
    const links = await prisma.$queryRawUnsafe(
      `SELECT link.id FROM resuscitation_device_links AS link
        JOIN resuscitation_events AS event ON event.id = link.resuscitation_event_id
        WHERE event.tenant_id = $1::uuid AND event.patient_uid = $2::uuid
          AND event.trigger_source = 'critical_vital'
          AND event.metadata->>'source' = 'vitalSignMonitor'
          AND link.tenant_id = event.tenant_id AND link.patient_uid = event.patient_uid`,
      TENANT_ID, PATIENT_UID,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(links.length).toBeGreaterThan(0);

    try {
      await insertCleanupControl(RECORDER_UID, 'critical_vital', 'vitalSignMonitor');
      await insertCleanupControl(PATIENT_UID, 'explicit_staff', 'vitalSignMonitor');
      await insertCleanupControl(PATIENT_UID, 'critical_vital', 'another-source');
      const controlsBefore = await prisma.$queryRawUnsafe(
        `SELECT event.id, link.id AS link_id
           FROM resuscitation_events AS event
           JOIN resuscitation_device_links AS link ON link.resuscitation_event_id = event.id
          WHERE event.tenant_id = $1::uuid AND event.reason = $2
            AND event.patient_uid IN ($3::uuid, $4::uuid)
          ORDER BY event.id, link.id`,
        TENANT_ID, CLEANUP_CONTROL_REASON, PATIENT_UID, RECORDER_UID,
      );
      expect(controlsBefore).toHaveLength(3);
      await expect(cleanupCriticalVitalFixtures(prisma,
        'a7777777-7777-4777-8777-777777770c99', [PATIENT_UID],
      )).resolves.toEqual({ deviceLinks: 0, events: 0 });
      await expect(cleanupCriticalVitalFixtures(prisma, TENANT_ID, [])).resolves.toEqual({ deviceLinks: 0, events: 0 });
      await expect(cleanupCriticalVitalFixtures(prisma, TENANT_ID, [PATIENT_UID])).resolves.toEqual({
        deviceLinks: links.length, events: events.length,
      });
      const controlsAfter = await prisma.$queryRawUnsafe(
        `SELECT event.id, link.id AS link_id
           FROM resuscitation_events AS event
           JOIN resuscitation_device_links AS link ON link.resuscitation_event_id = event.id
          WHERE event.tenant_id = $1::uuid AND event.reason = $2
            AND event.patient_uid IN ($3::uuid, $4::uuid)
          ORDER BY event.id, link.id`,
        TENANT_ID, CLEANUP_CONTROL_REASON, PATIENT_UID, RECORDER_UID,
      );
      expect(controlsAfter).toEqual(controlsBefore);
      await expect(cleanupCriticalVitalFixtures(prisma, TENANT_ID, [PATIENT_UID])).resolves.toEqual({ deviceLinks: 0, events: 0 });
    } finally {
      await cleanupControls();
    }
  }));

  it.each([
    { boundary: 'patient', linkPatientUid: RECORDER_UID, linkKind: 'clinical_alert', linkSource: 'vitalSignMonitor' },
    { boundary: 'kind', linkPatientUid: PATIENT_UID, linkKind: 'monitor', linkSource: 'vitalSignMonitor' },
    { boundary: 'source', linkPatientUid: PATIENT_UID, linkKind: 'clinical_alert', linkSource: 'another-source' },
  ])('rolls back cleanup rather than deleting a child outside its $boundary boundary', async ({ linkPatientUid, linkKind, linkSource }) => {
    try {
      await insertCleanupControl(PATIENT_UID, 'critical_vital', 'vitalSignMonitor', { linkPatientUid, linkKind, linkSource });
      await prisma.$executeRawUnsafe(
        `INSERT INTO resuscitation_device_links
           (tenant_id, resuscitation_event_id, patient_uid, link_kind, evidence)
         SELECT tenant_id, id, patient_uid, 'clinical_alert', $3::jsonb
           FROM resuscitation_events
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
            AND reason = $4 AND metadata->>'cleanupTest' = $4`,
        TENANT_ID, PATIENT_UID,
        JSON.stringify({ source: 'vitalSignMonitor', cleanupTest: CLEANUP_CONTROL_REASON }),
        CLEANUP_CONTROL_REASON,
      );
      const readControls = () => prisma.$queryRawUnsafe(
        `SELECT event.id, link.id AS link_id, link.patient_uid, link.link_kind, link.evidence
           FROM resuscitation_events AS event
           JOIN resuscitation_device_links AS link ON link.resuscitation_event_id = event.id
          WHERE event.tenant_id = $1::uuid AND event.patient_uid = $2::uuid
            AND event.reason = $3 AND event.metadata->>'cleanupTest' = $3
          ORDER BY link.id`,
        TENANT_ID, PATIENT_UID, CLEANUP_CONTROL_REASON,
      );
      const before = await readControls();
      expect(before).toHaveLength(2);
      expect(before.map((row) => row.patient_uid).sort()).toEqual([PATIENT_UID, linkPatientUid].sort());
      let cleanupError;
      try {
        await cleanupCriticalVitalFixtures(prisma, TENANT_ID, [PATIENT_UID]);
      } catch (error) {
        cleanupError = error;
      }
      expect(extractSqlState(cleanupError)).toBe('23503');
      expect(await readControls()).toEqual(before);
    } finally {
      await cleanupControls();
    }
  });
});
