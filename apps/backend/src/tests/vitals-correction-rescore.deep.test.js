// Audit 2026-08-10 R4 + R5 — real-Postgres pins:
//
//   R5: peri-arrest / neonatal truth is chartable end-to-end. HR 15 during a
//   code and a preterm-neonate SBP 45 were previously hard-400s at the
//   plausibility gate (floors HR 20 / SBP 40); they now record AND score
//   (NEWS2 red parameter), while garbage (negative, HR 900) still rejects.
//   Migration 651 relaxes migration 648's ICU flowsheet CHECK to match.
//
//   R4: correcting a NEWS2-input field re-scores from the corrected values.
//   A corrected SpO2 98→88 must append a NEW news2_scores row linked to the
//   vitals row (vitals_chart_id), stamp the stale score's superseded_by_id,
//   and raise the deterioration escalation the original reassuring score
//   never did. The vitals.corrected canonical timeline + audit events remain.
//
// Self-skips without a DB (same pattern as news2EscalationRecipient.deep).

import prisma from '../lib/prisma.js';
import { recordVitals, correctVitals } from '../services/emr/vitalsChartService.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001'; // literal default tenant
const PATIENT = '00000000-0000-4000-8000-0000000c4e51';
const NURSE = '00000000-0000-4000-8000-0000000c4e52';

async function exec(sql, ...p) {
  return prisma.$executeRawUnsafe(sql, ...p);
}
async function query(sql, ...p) {
  const r = await prisma.$queryRawUnsafe(sql, ...p);
  return Array.isArray(r) ? r : [];
}

async function cleanup() {
  const patientRows = await query(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT);
  const patientId = patientRows[0]?.id ?? null;
  await exec(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  if (patientId != null) {
    await exec(`DELETE FROM clinical_alerts WHERE patient_id = $1::int`, patientId).catch(() => {});
  }
  await exec(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  // Append-only guarded tables — the test-DB role is a superuser (the
  // guard's accepted escape hatch), same as the sibling canonical deep tests.
  await exec(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM audit_logs WHERE uid = $1::uuid AND action = 'CORRECT_VITALS'`, NURSE).catch(() => {});
  await exec(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT, NURSE).catch(() => {});
}

d('R5/R4 — plausibility floors + correction re-score (real Postgres)', () => {
  beforeAll(async () => {
    await cleanup();
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990222333', 'Rescore Test Patient', 'PATIENT', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, TENANT,
    );
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990222334', 'Rescore Test Nurse', 'NURSING_STAFF', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      NURSE, TENANT,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('R5: HR 15 during an arrest is accepted and scored as a NEWS2 red parameter', async () => {
    const result = await recordVitals({
      patient_uid: PATIENT,
      recorded_by: NURSE,
      heart_rate: 15,
    });
    expect(result.vitals.id).toBeTruthy();
    expect(Number(result.vitals.heart_rate)).toBe(15);
    // HR <= 40 scores 3 — the reading is scored, not rejected.
    expect(result.news2).toBeTruthy();
    expect(Number(result.news2.total_score)).toBeGreaterThanOrEqual(3);
  });

  it('R5: preterm-neonate SBP 45 is accepted; garbage still rejects', async () => {
    const ok = await recordVitals({
      patient_uid: PATIENT,
      recorded_by: NURSE,
      systolic_bp: 45,
      diastolic_bp: 18,
    });
    expect(ok.vitals.id).toBeTruthy();

    await expect(recordVitals({
      patient_uid: PATIENT, recorded_by: NURSE, heart_rate: 900,
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(recordVitals({
      patient_uid: PATIENT, recorded_by: NURSE, systolic_bp: -5,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('R5: migration 651 relaxed the ICU flowsheet DB CHECK to the new floors', async () => {
    const rows = await query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'chk_icu_flowsheet_vitals_plausible'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/hr >= 0/);
    expect(rows[0].def).toMatch(/sbp >= 0/);
    expect(rows[0].def).toMatch(/dbp >= 0/);
    expect(rows[0].def).toMatch(/hr <= 300/);
  });

  it('R4: correcting SpO2 98→88 re-scores, supersedes the stale score, and escalates', async () => {
    const recorded = await recordVitals({
      patient_uid: PATIENT,
      recorded_by: NURSE,
      spo2: 98,
      respiratory_rate: 16,
    });
    const vitalsId = recorded.vitals.id;
    expect(recorded.news2).toBeTruthy();
    const originalScoreId = recorded.news2.id;
    expect(Number(recorded.news2.total_score)).toBe(0);
    // The score is linked to its source vitals row (migration 652).
    expect(recorded.news2.vitals_chart_id).toBe(vitalsId);
    // SpO2-only + RR is a partial set — the marker is persisted.
    expect(recorded.news2.partial_score).toBe(true);
    expect(recorded.news2.missing_params).toEqual(
      expect.arrayContaining(['temperature', 'systolic_bp', 'heart_rate', 'consciousness']),
    );

    const corrected = await correctVitals(vitalsId, {
      corrected_by: NURSE,
      tenantId: TENANT,
      spo2: 88,
    });
    expect(Number(corrected.spo2)).toBe(88);

    // A NEW score row exists for the corrected values; the original is
    // stamped superseded_by_id → the replacement (visible chain, no edit).
    const scores = await query(
      `SELECT id, total_score, superseded_by_id, vitals_chart_id
         FROM news2_scores WHERE vitals_chart_id = $1::int ORDER BY id`,
      vitalsId,
    );
    expect(scores).toHaveLength(2);
    const [original, replacement] = scores;
    expect(original.id).toBe(originalScoreId);
    expect(original.superseded_by_id).toBe(replacement.id);
    expect(replacement.superseded_by_id).toBeNull();
    // SpO2 88 on scale 1 → 3 (+ RR 16 → 0): the stale reassuring 0 is replaced.
    expect(Number(replacement.total_score)).toBe(3);

    // The re-scored red parameter raises the tracked escalation the original
    // reassuring score never did.
    const tasks = await query(
      `SELECT id FROM tasks
        WHERE patient_uid = $1::uuid
          AND related_resource_type = 'news2_score'
          AND related_resource_id = $2::text`,
      PATIENT, String(replacement.id),
    );
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // The correction's canonical timeline + audit pair is intact.
    const timeline = await query(
      `SELECT id FROM clinical_timeline_events
        WHERE source_table = 'vitals_chart' AND source_id = $1::text
          AND event_type = 'vitals.corrected'`,
      String(vitalsId),
    );
    expect(timeline).toHaveLength(1);
    const audit = await query(
      `SELECT id FROM clinical_audit_events
        WHERE resource_table = 'vitals_chart' AND resource_id = $1::text
          AND action = 'vitals.corrected'`,
      String(vitalsId),
    );
    expect(audit).toHaveLength(1);
  });

  it('R4: clearing the final scorable input retires the stale score without fabricating a zero', async () => {
    const recorded = await recordVitals({
      patient_uid: PATIENT,
      recorded_by: NURSE,
      spo2: 98,
    });
    const vitalsId = recorded.vitals.id;
    const originalScoreId = recorded.news2.id;

    await correctVitals(vitalsId, {
      corrected_by: NURSE,
      tenantId: TENANT,
      spo2: null,
    });

    const scores = await query(
      `SELECT id, superseded_by_id, superseded_at
         FROM news2_scores WHERE vitals_chart_id = $1::int ORDER BY id`,
      vitalsId,
    );
    expect(scores).toHaveLength(1);
    expect(scores[0].id).toBe(originalScoreId);
    expect(scores[0].superseded_by_id).toBeNull();
    expect(scores[0].superseded_at).not.toBeNull();
  });
});
