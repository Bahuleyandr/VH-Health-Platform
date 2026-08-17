import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const ENCOUNTER_ID = randomUUID();
const PATIENT_NAME = `NL13P2 Stroke Patient ${randomUUID().slice(0, 8)}`;
const DOCTOR_NAME = `NL13P2 Stroke Doctor ${randomUUID().slice(0, 8)}`;
const PATIENT_PHONE = `+919880${String(Date.now() % 1_000_000).padStart(6, '0')}`;
const DOCTOR_PHONE = `+919881${String(Date.now() % 1_000_000).padStart(6, '0')}`;
const PRIVILEGE_KEY = `stroke_thrombolysis_${randomUUID().slice(0, 8).replace(/-/g, '')}`;

let previousSettings = null;

function doctor() {
  return authClient('DOCTOR', { uid: DOCTOR_UID, id: 1 });
}

async function settingsRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM stroke_pathway_settings WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => []);
  return rows[0] || null;
}

async function restoreSettings() {
  if (!previousSettings) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM stroke_pathway_settings WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    return;
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO stroke_pathway_settings
       (tenant_id, enabled, enabled_at, enabled_by,
        clock_definition_source, clock_definition_version, clock_definition_attachment_refs,
        nihss_source, nihss_version, nihss_attachment_refs,
        thrombolysis_protocol_source, thrombolysis_protocol_version,
        thrombolysis_protocol_attachment_refs, thrombolysis_approver_privilege_key,
        door_to_ct_target_minutes, door_to_needle_target_minutes,
        acceptance_snapshot, metadata, created_at, updated_at)
     VALUES
       ($1::uuid, $2, $3::timestamptz, $4::uuid,
        $5, $6, $7::jsonb, $8, $9, $10::jsonb,
        $11, $12, $13::jsonb, $14, $15::int, $16::int,
        $17::jsonb, $18::jsonb, COALESCE($19::timestamptz, NOW()), COALESCE($20::timestamptz, NOW()))
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       enabled_at = EXCLUDED.enabled_at,
       enabled_by = EXCLUDED.enabled_by,
       clock_definition_source = EXCLUDED.clock_definition_source,
       clock_definition_version = EXCLUDED.clock_definition_version,
       clock_definition_attachment_refs = EXCLUDED.clock_definition_attachment_refs,
       nihss_source = EXCLUDED.nihss_source,
       nihss_version = EXCLUDED.nihss_version,
       nihss_attachment_refs = EXCLUDED.nihss_attachment_refs,
       thrombolysis_protocol_source = EXCLUDED.thrombolysis_protocol_source,
       thrombolysis_protocol_version = EXCLUDED.thrombolysis_protocol_version,
       thrombolysis_protocol_attachment_refs = EXCLUDED.thrombolysis_protocol_attachment_refs,
       thrombolysis_approver_privilege_key = EXCLUDED.thrombolysis_approver_privilege_key,
       door_to_ct_target_minutes = EXCLUDED.door_to_ct_target_minutes,
       door_to_needle_target_minutes = EXCLUDED.door_to_needle_target_minutes,
       acceptance_snapshot = EXCLUDED.acceptance_snapshot,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at`,
    TENANT_ID,
    previousSettings.enabled,
    previousSettings.enabled_at,
    previousSettings.enabled_by,
    previousSettings.clock_definition_source,
    previousSettings.clock_definition_version,
    JSON.stringify(previousSettings.clock_definition_attachment_refs || []),
    previousSettings.nihss_source,
    previousSettings.nihss_version,
    JSON.stringify(previousSettings.nihss_attachment_refs || []),
    previousSettings.thrombolysis_protocol_source,
    previousSettings.thrombolysis_protocol_version,
    JSON.stringify(previousSettings.thrombolysis_protocol_attachment_refs || []),
    previousSettings.thrombolysis_approver_privilege_key,
    previousSettings.door_to_ct_target_minutes,
    previousSettings.door_to_needle_target_minutes,
    JSON.stringify(previousSettings.acceptance_snapshot || {}),
    JSON.stringify(previousSettings.metadata || {}),
    previousSettings.created_at,
    previousSettings.updated_at,
  ).catch(() => {});
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND source_table = 'stroke_activations'
        AND source_id IN (
          SELECT id::text FROM stroke_activations WHERE patient_uid = $2::uuid
        )`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stroke_pathway_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stroke_thrombolysis_decisions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stroke_nihss_assessments WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stroke_activations WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
    TENANT_ID,
    DOCTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_encounters WHERE id = $1::uuid`,
    ENCOUNTER_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
  ).catch(() => {});
}

d('NL-13 P2 stroke pathway — deep activation to evidence loop', () => {
  beforeAll(async () => {
    previousSettings = await settingsRow();
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, $4::uuid, NOW())`,
      PATIENT_UID,
      PATIENT_PHONE,
      PATIENT_NAME,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'DOCTOR', true, $4::uuid, NOW())`,
      DOCTOR_UID,
      DOCTOR_PHONE,
      DOCTOR_NAME,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_encounters
         (id, tenant_id, patient_uid, encounter_type, status, primary_doctor_uid,
          care_team_uids, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'er', 'open', $4::uuid,
               ARRAY[$4::uuid]::uuid[], $4::uuid, $4::uuid,
               '{"test":"nl13_p2_stroke"}'::jsonb)`,
      ENCOUNTER_ID,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, admitting_doctor, attending_doctor,
          ward, bed_number, status, admitted_at, created_by, updated_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
                'NL13P2 ED', 'STROKE-01', 'admitted', NOW(), $4::uuid, NOW())`,
      TENANT_ID,
      PATIENT_UID,
      ENCOUNTER_ID,
      DOCTOR_UID,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await restoreSettings();
    await prisma.$disconnect().catch(() => {});
  });

  test('records activation, NIHSS, thrombolysis decision, pathway milestones, timeline/audit, and SLA evidence', async () => {
    const settings = await doctor().patch('/api/v1/stroke-pathway/settings').send({
      enabled: true,
      clock_definition_source: 'NL13P2 owner stroke clock SOP',
      clock_definition_version: '2026.07',
      nihss_source: 'NL13P2 owner NIHSS SOP',
      nihss_version: '2026.07',
      thrombolysis_protocol_source: 'NL13P2 owner thrombolysis SOP',
      thrombolysis_protocol_version: '2026.07',
      door_to_ct_target_minutes: 20,
      door_to_needle_target_minutes: 60,
      acceptance_snapshot: { build: 'nl13_p2' },
    });
    expect(settings.status).toBe(200);

    const activationRes = await doctor().post('/api/v1/stroke-pathway/activations').send({
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      activation_source: 'ed_triage',
      last_known_well_at: '2026-07-08T09:15:00.000Z',
      arrived_at: '2026-07-08T09:55:00.000Z',
      door_time_at: '2026-07-08T10:00:00.000Z',
      activated_at: '2026-07-08T10:01:00.000Z',
      team: { neuro: DOCTOR_UID, nurse: DOCTOR_UID },
    });
    expect(activationRes.status).toBe(200);
    const activation = activationRes.body.data;
    expect(activation.radiology_context_tags).toContain('code_stroke');
    expect(activation.radiology_signal_codes).toContain('STROKE_PROTOCOL');

    const nihss = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/nihss`).send({
      item_scores: [
        { item: 'loc', score: 1 },
        { item: 'gaze', score: 0 },
        { item: 'motor_arm_left', score: 3 },
        { item: 'language', score: 2 },
      ],
      signoff_status: 'signed',
      nihss_source: 'NL13P2 owner NIHSS SOP',
      nihss_version: '2026.07',
    });
    expect(nihss.status).toBe(200);
    expect(nihss.body.data.total_score).toBe(6);

    const blockedApproval = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/thrombolysis`).send({
      decision_status: 'approved',
      eligibility_payload: { ownerChecklist: { reviewed: true } },
    });
    expect(blockedApproval.status).toBe(403);
    expect(blockedApproval.body.details?.code || blockedApproval.body.code).toBe('STROKE_THROMBOLYSIS_PRIVILEGE_NOT_CONFIGURED');

    const withheld = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/thrombolysis`).send({
      decision_status: 'withheld',
      eligibility_payload: { ownerChecklist: { reviewed: true } },
      contraindication_payload: { ownerExclusions: ['documented clinician review'] },
      patient_family_documentation: { discussed_with: 'family at bedside' },
      protocol_source: 'NL13P2 owner thrombolysis SOP',
      protocol_version: '2026.07',
    });
    expect(withheld.status).toBe(200);
    expect(withheld.body.data.decision_status).toBe('withheld');

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, status, valid_from, valid_until, created_by)
       VALUES ($1::uuid, $2::uuid, 'privilege', $3, 'active', CURRENT_DATE - INTERVAL '1 day',
               CURRENT_DATE + INTERVAL '90 days', $2::uuid)`,
      TENANT_ID,
      DOCTOR_UID,
      PRIVILEGE_KEY,
    );
    const keyedSettings = await doctor().patch('/api/v1/stroke-pathway/settings').send({
      enabled: true,
      clock_definition_source: 'NL13P2 owner stroke clock SOP',
      clock_definition_version: '2026.07',
      nihss_source: 'NL13P2 owner NIHSS SOP',
      nihss_version: '2026.07',
      thrombolysis_protocol_source: 'NL13P2 owner thrombolysis SOP',
      thrombolysis_protocol_version: '2026.07',
      thrombolysis_approver_privilege_key: PRIVILEGE_KEY,
      door_to_ct_target_minutes: 20,
      door_to_needle_target_minutes: 60,
      acceptance_snapshot: { build: 'nl13_p2', privilege: PRIVILEGE_KEY },
    });
    expect(keyedSettings.status).toBe(200);

    const approved = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/thrombolysis`).send({
      decision_status: 'approved',
      eligibility_payload: { ownerChecklist: { reviewed: true } },
      contraindication_payload: { ownerExclusions: [] },
      dose_payload: { ownerDoseSheetRef: 'r2://stroke-owner/dose-sheet.pdf' },
      patient_family_documentation: { discussed_with: 'family at bedside' },
      protocol_source: 'NL13P2 owner thrombolysis SOP',
      protocol_version: '2026.07',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.data.approver_privilege_key).toBe(PRIVILEGE_KEY);

    const ctStart = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/events`).send({
      event_type: 'ct_start',
      occurred_at: '2026-07-08T10:12:00.000Z',
      event_payload: { radiology: 'code_stroke_ct_head' },
    });
    expect(ctStart.status).toBe(200);

    const treatmentStart = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/events`).send({
      event_type: 'treatment_start',
      occurred_at: '2026-07-08T10:44:00.000Z',
      event_payload: { protocol_owner_ref: 'NL13P2 owner thrombolysis SOP' },
    });
    expect(treatmentStart.status).toBe(200);

    const slas = await prisma.$queryRawUnsafe(
      `SELECT rule_code, status
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'stroke_activations'
          AND source_id = $2
        ORDER BY rule_code`,
      TENANT_ID,
      String(activation.id),
    );
    expect(slas.map((row) => row.rule_code).sort()).toEqual(['stroke_door_to_ct', 'stroke_door_to_needle']);
    expect(slas.every((row) => ['completed', 'breached'].includes(row.status))).toBe(true);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type LIKE 'stroke.%'`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(timeline.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'stroke.activation.created',
      'stroke.nihss.signed',
      'stroke.thrombolysis.decision',
      'stroke.pathway.ct_start',
      'stroke.pathway.treatment_start',
    ]));

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND action LIKE 'stroke.%'`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(audit.length).toBeGreaterThanOrEqual(5);

    const radiologyRegression = await import('../services/ai/radiologyWorklistPrioritizerService.js');
    const priority = radiologyRegression.scorePriority({
      modality: 'CT',
      bodyPart: 'head',
      indication: 'acute stroke, rule out intracranial bleed',
      location: 'ED',
      waitMinutes: 30,
      fragility: {},
      contextTags: ['code_stroke'],
      priorsAvailable: false,
      isStatOverride: false,
    });
    expect(priority.priority_tier).toBe('stat');
    expect(priority.priority_score).toBeGreaterThanOrEqual(120);
  }, 60_000);

  test('cancelling an activation cancels open stroke SLA clocks but never flips a met one (SLA-halves G2)', async () => {
    // Fresh activation: both door-to-CT and door-to-needle clocks arm.
    const activationRes = await doctor().post('/api/v1/stroke-pathway/activations').send({
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      activation_source: 'ed_triage',
      last_known_well_at: '2026-07-09T09:15:00.000Z',
      arrived_at: '2026-07-09T09:55:00.000Z',
      door_time_at: '2026-07-09T10:00:00.000Z',
      activated_at: '2026-07-09T10:01:00.000Z',
    });
    expect(activationRes.status).toBe(200);
    const activation = activationRes.body.data;

    // Meet the CT clock (10:10 is inside the 20-minute target set above).
    const ctStart = await doctor().post(`/api/v1/stroke-pathway/activations/${activation.id}/events`).send({
      event_type: 'ct_start',
      occurred_at: '2026-07-09T10:10:00.000Z',
    });
    expect(ctStart.status).toBe(200);

    // Mimic identified — cancel the activation.
    const cancelRes = await doctor().patch(`/api/v1/stroke-pathway/activations/${activation.id}/status`).send({
      status: 'cancelled',
      notes: 'stroke mimic',
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');

    const slas = await prisma.$queryRawUnsafe(
      `SELECT rule_code, status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'stroke_activations'
          AND source_id = $2
        ORDER BY rule_code`,
      TENANT_ID,
      String(activation.id),
    );
    const byRule = Object.fromEntries(slas.map((row) => [row.rule_code, row]));
    // The met CT clock keeps its completion — cancel never re-touches it.
    expect(byRule.stroke_door_to_ct.status).toBe('completed');
    expect(byRule.stroke_door_to_ct.completed_at).not.toBeNull();
    // The never-met needle clock is cancelled, not left 'active' forever.
    expect(byRule.stroke_door_to_needle.status).toBe('cancelled');
    expect(byRule.stroke_door_to_needle.completed_at).toBeNull();
    expect(byRule.stroke_door_to_needle.metadata.cancel_reason).toBe('stroke mimic');
  }, 60_000);
});
