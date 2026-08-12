// Audit 2026-08-10 — NEWS2 nursing-path escalation parity (real Postgres,
// nothing mocked).
//
// A NEWS2 of 8 charted through POST /nursing-assessments previously rendered
// "emergency" band text but raised NO tracked escalation task, while the SAME
// score through the vitals path produced an assigned, acknowledgement-tracked,
// SLA-clocked results-inbox task. recordAssessment now drives the same
// escalateNews2 post-commit, on the 'nursing_assessment' resource slot (the
// assessment id space is distinct from news2_scores ids, so sharing the
// 'news2_score' slot could collide dedup with an unrelated score's task).
//
// Mirrors news2EscalationRecipient.deep.test.js (default tenant, DUTY-role
// fallback). Self-skips without a DB.

import prisma from '../lib/prisma.js';
import {
  recordAssessment,
  scoreNews2,
} from '../services/clinical/nursingAssessmentService.js';
import { isNews2EscalationFresh } from '../services/clinical/news2Service.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001'; // literal default tenant
const PATIENT = '00000000-0000-4000-8000-0000000ae511';
const NURSE = '00000000-0000-4000-8000-0000000ae512';

async function exec(sql, ...p) {
  return prisma.$executeRawUnsafe(sql, ...p);
}
async function query(sql, ...p) {
  const r = await prisma.$queryRawUnsafe(sql, ...p);
  return Array.isArray(r) ? r : [];
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, PATIENT);
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid`,
      PATIENT,
    );
  }).catch(() => {});
  // Append-only guarded tables — test-DB role is a superuser (accepted escape).
  await exec(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM nursing_assessments WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT, NURSE).catch(() => {});
}

d('NEWS2 via nursing assessment escalates like the vitals path (audit 2026-08-10)', () => {
  beforeAll(async () => {
    await cleanup();
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990444555', 'NA Escalation Patient', 'PATIENT', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, TENANT,
    );
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990444556', 'NA Escalation Nurse', 'NURSING_STAFF', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      NURSE, TENANT,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  it('a NEWS2 of 8 produces an assigned, ack-tracked task on the nursing_assessment slot', async () => {
    // RR 26 → 3, SpO2 90 (scale 1) → 3, supp O2 → 2 = 8.
    const saved = await recordAssessment({
      tenantId: TENANT,
      patient_uid: PATIENT,
      assessment_kind: 'news2',
      inputs: { rr: 26, spo2: 90, supplemental_o2: true, spo2_scale: 1 },
      assessed_by: NURSE,
    });
    expect(saved.band).toBeNull();
    expect(Number(saved.total_score)).toBe(8);
    expect(saved.partial_score).toBe(true);
    expect(saved.missing_params).toEqual(expect.arrayContaining([
      'temperature',
      'systolic_bp',
      'heart_rate',
      'consciousness',
    ]));
    expect(scoreNews2(saved.inputs)).toMatchObject({
      band: null,
      partial: true,
      risk_band_available: false,
    });
    expect(saved.assessed_at).toBeTruthy();
    expect(isNews2EscalationFresh(saved.assessed_at)).toBe(true);

    const tasks = await query(
      `SELECT id, assigned_to_uid, assigned_to_role, workflow_sla_instance_id
         FROM tasks
        WHERE patient_uid = $1::uuid
          AND related_resource_type = 'nursing_assessment'
          AND related_resource_id = $2::text`,
      PATIENT, String(saved.id),
    );
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    // Deliverable recipient: explicit assignee or the DUTY-role fallback.
    expect(tasks.some((t) => t.assigned_to_uid != null || t.assigned_to_role != null)).toBe(true);
    // SLA-backed action → workflow_sla_instances row (canonical invariant).
    expect(tasks.some((t) => t.workflow_sla_instance_id != null)).toBe(true);
  });
});
