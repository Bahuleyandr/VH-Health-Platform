// Shared harness for the deterministic in-CI journey tests (batch B3.x).
//
// These journey tests REPLACE the retired agent swarm's 11 end-to-end
// journeys (ADR-002: docs/adr/ADR-002-retire-swarm-deterministic-ci-journeys.md;
// the equivalent quality gate is WS3 in docs/S_TIER_ROADMAP.md). Each journey
// drives the REAL Express API surface (supertest) across the relevant roles,
// asserting state-machine transitions, RBAC, and the canonical clinical
// timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md + root CLAUDE.md).
//
// Determinism rules baked in here:
//   * Everything is seeded — no reliance on pre-existing rows or wall-clock
//     time-of-day. Dates are derived from the Postgres hospital clock
//     (current_date in IST) so a test that books "today" agrees with the
//     server's date even across the UTC midnight boundary.
//   * Every fixture id is namespaced with a per-suite + per-run suffix so the
//     suite is rerunnable and isolated from sibling suites sharing the
//     vhhealth_test DB on :55432.
//   * The same default tenant the API stamps on un-scoped JWTs
//     (DEFAULT_TENANT_ID) is used everywhere, so AccessDecisionService
//     relationship lookups (which are tenant-scoped) resolve.
//
// Auth/relationship model (verified against accessDecisionService.js):
//   Clinical-write routes (vitals/notes/orders/encounters) sit behind
//   patientAccessGuard, which requires a relationship between the acting
//   staff member and the patient: care_team | appointment | admission |
//   referral | guardian | break_glass. The two grants journeys lean on:
//     - grantDoctorCareTeam(): an active care-team membership — resource-type
//       agnostic, so it authorises vitals (no appointment binding), notes,
//       and orders for a given doctor/nurse uid.
//     - an active appointment/admission with the doctor assigned — resolved
//       automatically by the guard, no explicit grant needed.
//
// DB: needs Postgres at DATABASE_URL (jest.setup.cjs defaults it to
// 127.0.0.1:55432 / vhhealth_test). When the DB is unreachable the journey
// suites self-skip via describeJourney (mirrors the *.deep.test.js convention).

import request from 'supertest';
import app from '../../app.js';
import prisma from '../../lib/prisma.js';
import { generateTestToken } from '../testClient.js';

export const API_KEY = process.env.API_KEY || 'test-api-key';

// The single-tenant production floor + the value AccessDecisionService falls
// back to for a JWT with no tenant claim (deriveTenantIdFromRequest →
// DEFAULT_TENANT_ID). All seeded patients/appointments/admissions/care-teams
// MUST use this so the relationship checks line up.
export const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

// Canonical clinical event types emitted by the EMR services, keyed by the
// workflow step. Used by assertCanonicalClinicalWrite so each journey asserts
// the exact timeline event the platform promises (not just "some row").
export const CANONICAL_EVENTS = {
  noteCreated: { eventType: 'note.created', sourceTable: 'clinical_notes' },
  noteSigned: { eventType: 'note.signed', sourceTable: 'clinical_notes' },
  vitalsRecorded: { eventType: 'vitals.recorded', sourceTable: 'vitals_chart' },
  ioRecorded: { eventType: 'io.recorded', sourceTable: 'intake_output' },
  orderCreated: { eventType: 'order.created', sourceTable: 'clinical_orders' },
  admissionCreated: { eventType: 'admission.created', sourceTable: 'admissions' },
};

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

// describe wrapper that self-skips when no DB is configured, matching the
// *.deep.test.js convention so the journey suites stay green in DB-less CI legs.
export const describeJourney = DB_CONFIGURED ? describe : describe.skip;

// A short, stable run suffix so reruns + sibling suites never collide on
// globally-unique columns (users.phone, appointments.visit_no, …).
export function runSuffix() {
  return String(Date.now() % 100000).padStart(5, '0');
}

// ----------------------------------------------------------------------------
// HTTP role clients
// ----------------------------------------------------------------------------

// A supertest client bound to a role JWT (API key + Authorization preset),
// matching the mkClient pattern used across the deep tests. deviceType defaults
// to 'desktop' (via generateTestToken) so clinical-write routes don't 403 on
// the phone-mode gate (rejectMobileClinicalWrite).
export function roleClient(role, { uid, id, phone } = {}) {
  const token = generateTestToken(role, {
    ...(uid !== undefined ? { uid } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(phone !== undefined ? { phone } : {}),
  });
  const auth = (req) => req.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return {
    token,
    get: (p) => auth(request(app).get(p)),
    post: (p) => auth(request(app).post(p)),
    put: (p) => auth(request(app).put(p)),
    patch: (p) => auth(request(app).patch(p)),
    delete: (p) => auth(request(app).delete(p)),
  };
}

// ----------------------------------------------------------------------------
// Hospital clock — keep "today" in lockstep with Postgres so date-bounded
// queries (appointment ±30d window, OP-note same-day session) don't drift at
// the UTC midnight boundary. (Phase 0.5 convention in apps/backend/CLAUDE.md.)
// ----------------------------------------------------------------------------

// "Today" in the HOSPITAL clinical tz (Asia/Kolkata) — NOT the DB session tz.
// The local QA cluster runs IST so current_date used to coincide, but CI
// Postgres is UTC: between 18:30 and 24:00 UTC current_date is one day behind
// the IST date that clinical gates compare against (clinicalNotesService
// assertOpenOpAppointmentSession's HOSPITAL_TIME_ZONE date key), which 409'd
// the OPD journeys only in that window.
export async function hospitalToday() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`,
  );
  return rows[0].d; // YYYY-MM-DD in the hospital tz
}

export async function hospitalDateOffset(days) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + ($1 || ' days')::interval)::date::text AS d`,
    String(days),
  );
  return rows[0].d;
}

// ----------------------------------------------------------------------------
// Seeding helpers
// ----------------------------------------------------------------------------

// Insert a user row, returning { id, uid }. Idempotent on uid so reruns that
// skipped cleanup don't crash on the unique constraint.
export async function seedUser({ uid, phone, name, role, gender = null, extraCols = {} }) {
  const cols = ['uid', 'phone', 'name', 'role', 'is_active', 'updated_at'];
  const vals = ['$1::uuid', '$2', '$3', '$4', 'true', 'NOW()'];
  const params = [uid, phone, name, role];
  if (gender) {
    cols.push('gender');
    params.push(gender);
    vals.push(`$${params.length}`);
  }
  for (const [col, value] of Object.entries(extraCols)) {
    cols.push(col);
    params.push(value);
    vals.push(`$${params.length}`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (${cols.join(', ')})
     VALUES (${vals.join(', ')})
     ON CONFLICT (uid) DO UPDATE SET phone = EXCLUDED.phone, name = EXCLUDED.name,
       role = EXCLUDED.role, is_active = true, updated_at = NOW()
     RETURNING id, uid`,
    ...params,
  );
  return rows[0];
}

// Seed a DOCTOR user + a doctors profile row (the appointment picker uses
// doctors; the canonical doctor_id is users.id). Returns
// { userId, uid, profileId }.
export async function seedDoctor({ uid, phone, name, department, specialty = 'General Practitioner' }) {
  const user = await seedUser({ uid, phone, name, role: 'DOCTOR' });
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO doctors
       (user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
     VALUES ($1::int, $2, $3, $4, true, true,
             ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], NOW())
     RETURNING id`,
    user.id, name, department, specialty,
  );
  return { userId: user.id, uid: user.uid, profileId: rows[0].id };
}

// Seed an active treatment consent — admitPatient() gates non-emergency
// admits on this.
export async function seedTreatmentConsent(patientUid) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_consents (patient_uid, consent_type, granted, status)
     VALUES ($1::uuid, 'treatment', true, 'active')`,
    patientUid,
  );
}

// Seed a ward + N available beds, returning { wardId, bedIds }.
export async function seedWardWithBeds({ wardName, bedNumbers }) {
  const wardRows = await prisma.$queryRawUnsafe(
    `INSERT INTO wards
       (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level)
     VALUES ($1, 3, $2, 'blue', 'enhanced')
     RETURNING id`,
    wardName, bedNumbers.length,
  );
  const wardId = wardRows[0].id;
  const bedIds = [];
  for (const bedNumber of bedNumbers) {
    const bedRows = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, status)
       VALUES ($1, $2, $3, 'available') RETURNING id`,
      wardId, wardName, bedNumber,
    );
    bedIds.push(bedRows[0].id);
  }
  return { wardId, bedIds };
}

// Map a staff role to a valid care_team_members.relationship_kind. The members
// unique index keys on (care_team_id, staff_uid, staff_id, relationship_kind),
// so distinct staff on one team must carry distinct kinds — doctors and nurses
// already differ, which is what journeys need.
function relationshipKindForRole(staffRole) {
  const role = String(staffRole || '').toUpperCase();
  if (role.includes('NURS')) return 'nurse';
  if (role.includes('PHARM')) return 'pharmacist';
  if (role.includes('PHYSIO')) return 'physiotherapist';
  return 'attending_doctor';
}

// Grant a staff member (doctor/nurse/…) an active care-team relationship with a
// patient — the resource-type-agnostic key that authorises clinical writes
// through patientAccessGuard. Mirrors the grant used in vitals-deep.test.js but
// reuses ONE longitudinal care_team per patient (the DB enforces a single
// active team per patient/admission/appointment/kind via
// uq_active_care_team_context), adding each staff member as a distinct row.
// Idempotent: safe to call twice for the same staff (member upserts on its
// unique role index).
export async function grantCareTeam({ patientUid, staffUid, staffRole = 'DOCTOR', memberName = 'Journey Staff' }) {
  // Reuse the patient's active longitudinal team if one already exists.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM care_teams
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        AND team_kind = 'longitudinal' AND status IN ('active', 'paused')
        AND admission_id IS NULL AND appointment_id IS NULL
      ORDER BY id DESC LIMIT 1`,
    DEFAULT_TENANT, patientUid,
  );
  let teamId = existing[0]?.id;
  if (!teamId) {
    const teamRows = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'longitudinal', $3, 'active', $4::uuid, NOW())
       RETURNING id`,
      DEFAULT_TENANT, patientUid, `${memberName} care team`, staffUid,
    );
    teamId = teamRows[0].id;
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO care_team_members
       (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
        relationship_kind, break_glass_allowed, status, active_from, created_by, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, $5, $6,
             $7, true, 'active', NOW(), $4::uuid, NOW())
     ON CONFLICT DO NOTHING`,
    DEFAULT_TENANT, teamId, patientUid, staffUid, staffRole, memberName,
    relationshipKindForRole(staffRole),
  );
  return teamId;
}

// ----------------------------------------------------------------------------
// Canonical timeline / audit assertions — the journey-level enforcement of the
// non-negotiable invariant: a successful clinical write persists exactly one
// clinical_timeline_events row + one clinical_audit_events row keyed to the
// detail row.
// ----------------------------------------------------------------------------

export async function timelineEventsFor({ sourceTable, sourceId }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, patient_uid, source_table, source_id
       FROM clinical_timeline_events
      WHERE source_table = $1 AND source_id = $2`,
    sourceTable, String(sourceId),
  );
}

export async function auditEventsFor({ sourceTable, sourceId }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action, patient_uid, resource_table, resource_id
       FROM clinical_audit_events
      WHERE resource_table = $1 AND resource_id = $2`,
    sourceTable, String(sourceId),
  );
}

// Assert the canonical triple for one detail row: >=1 timeline event of the
// expected type and >=1 audit event. (">=1" not "==1" because a single
// workflow step can legitimately emit more than one canonical row — e.g. an
// order that also writes a medication-safety review — but it must never emit
// zero.) Returns the timeline rows for further inspection.
export async function assertCanonicalClinicalWrite({ event, sourceId, patientUid }) {
  const timeline = await timelineEventsFor({ sourceTable: event.sourceTable, sourceId });
  const audit = await auditEventsFor({ sourceTable: event.sourceTable, sourceId });

  const matchingType = timeline.filter((t) => t.event_type === event.eventType);
  expect(matchingType.length).toBeGreaterThanOrEqual(1);
  expect(audit.length).toBeGreaterThanOrEqual(1);
  if (patientUid) {
    expect(String(matchingType[0].patient_uid)).toBe(String(patientUid));
  }
  return timeline;
}

// Assert a row appears in the patient's canonical timeline read endpoint as
// seen by a clinician (the patient-facing story, end to end). Tolerant of
// either the canonical patient timeline shape or the legacy clinical-notes
// timeline aggregation, since journeys read via the EMR timeline alias.
export async function fetchPatientTimeline(client, patientUid) {
  const res = await client.get(`/api/v1/emr/timeline/${patientUid}`);
  return res;
}

// ----------------------------------------------------------------------------
// Cleanup — broad, FK-safe, best-effort. Each journey passes the set of
// patient uids + phones + the per-run department/visit markers it created.
// Ordered children-before-parents so FK constraints don't block teardown.
// ----------------------------------------------------------------------------

export async function cleanupJourney({
  patientUids = [],
  staffUids = [],
  phones = [],
  departments = [],
  wardNames = [],
  bedNumbers = [],
} = {}) {
  const uids = patientUids.filter(Boolean);
  const allUids = [...uids, ...staffUids].filter(Boolean);
  const phoneForms = [...new Set(phones.flatMap((p) => [p, `+91${p}`]).filter(Boolean))];

  const swallow = (promise) => promise.catch(() => {});

  // Resolve int ids for the patients (some detail tables are keyed by int).
  let patientIntIds = [];
  if (uids.length) {
    const rows = await prisma
      .$queryRawUnsafe(`SELECT id FROM users WHERE uid = ANY($1::uuid[])`, uids)
      .catch(() => []);
    patientIntIds = rows.map((r) => r.id);
  }

  // Canonical layer first (FKs point inward; safe to clear by patient_uid).
  if (uids.length) {
    // SLA-linked tasks and workflow_sla_instances are an intentionally immortal
    // pair under plain statements since the care-pathways execution spine
    // (migration 580): tasks hold the composite RESTRICT FK
    // fk_tasks_workflow_sla_tenant onto workflow_sla_instances, while typed
    // tasks (sla_completion_semantics <> 'none') are delete-vetoed by
    // care_pathway_task_sla_completion_receipt_constraint as long as their SLA
    // row survives — deleting either side first fails, so the old bare SLA
    // delete 23503'd and silently leaked every suite's SLA rows and tasks.
    // Journey runs always connect as a DB superuser (jest.setup.cjs default,
    // CI service user), so drop FK/trigger enforcement for exactly one
    // transaction (SET LOCAL is restored at commit) and remove the pair
    // wholesale. Tasks pinned by retained clinical evidence (critical-alert /
    // diagnostic-generation / discharge-handoff rows, all append-only by
    // design) stay in place, and the SLA delete afterwards skips any instance
    // such a survivor still references, so one pinned row can no longer poison
    // the whole statement. On a non-superuser connection the SET LOCAL throws
    // and the block degrades to the old best-effort behaviour.
    const journeyTaskSet = `
      SELECT t.id FROM tasks t
       WHERE (t.patient_uid = ANY($1::uuid[])
              OR t.workflow_sla_instance_id IN (
                   SELECT w.id FROM workflow_sla_instances w
                    WHERE w.patient_uid = ANY($1::uuid[])))
         AND NOT EXISTS (SELECT 1 FROM lab_critical_alerts a
              WHERE a.tenant_id = t.tenant_id AND a.acknowledgement_task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM lab_critical_alert_acknowledgement_receipts r
              WHERE r.tenant_id = t.tenant_id AND r.acknowledgement_task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM diagnostic_result_generations g
              WHERE g.tenant_id = t.tenant_id AND g.critical_acknowledgement_task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM diagnostic_result_actions da
              WHERE da.tenant_id = t.tenant_id AND da.task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM care_pathway_resource_references rr
              WHERE rr.tenant_id = t.tenant_id AND rr.task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM discharge_pending_result_handoffs h
              WHERE h.tenant_id = t.tenant_id AND h.task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM discharge_pending_result_owner_actions oa
              WHERE oa.tenant_id = t.tenant_id AND oa.task_id = t.id)`;
    // The diagnostic result-generation ledger (migrations 589/591) is the same
    // shape one layer up: generations are append-only (delete-vetoed by
    // trigger) and hold plain NO ACTION FKs onto users, clinical_timeline_events
    // and workflow_sla_instances, so one signed lab result used to poison the
    // suite's timeline and users deletes wholesale. Generations still pinned by
    // retained rows this cleanup never touches (critical alerts, discharge
    // pending-result handoffs/owner-actions) are kept, so no surviving evidence
    // ends up pointing at deleted rows.
    const journeyGenerationSet = `
      SELECT g.id FROM diagnostic_result_generations g
       WHERE g.patient_uid = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM lab_critical_alerts a
              WHERE a.tenant_id = g.tenant_id
                AND a.superseded_by_diagnostic_generation_id = g.id)
         AND NOT EXISTS (SELECT 1 FROM discharge_pending_result_handoffs h
              WHERE h.tenant_id = g.tenant_id AND h.resolution_generation_id = g.id)
         AND NOT EXISTS (SELECT 1 FROM discharge_pending_result_owner_actions oa
              WHERE oa.tenant_id = g.tenant_id
                AND (oa.generation_id = g.id OR oa.predecessor_generation_id = g.id))`;
    await swallow(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_actions
          WHERE generation_id IN (${journeyGenerationSet})`, uids);
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_generation_items
          WHERE generation_id IN (${journeyGenerationSet})`, uids);
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_generations
          WHERE id IN (${journeyGenerationSet})`, uids);
      // Replica mode suspends referential actions too, so mimic the ON DELETE
      // CASCADE (task_comments) / SET NULL (approvals) the FKs would have run.
      await tx.$executeRawUnsafe(
        `DELETE FROM task_comments WHERE task_id IN (${journeyTaskSet})`, uids);
      await tx.$executeRawUnsafe(
        `UPDATE approvals SET task_id = NULL WHERE task_id IN (${journeyTaskSet})`, uids);
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks WHERE id IN (${journeyTaskSet})`, uids);
    }));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances w
        WHERE w.patient_uid = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM tasks t
               WHERE t.tenant_id = w.tenant_id AND t.workflow_sla_instance_id = w.id)
          AND NOT EXISTS (SELECT 1 FROM lab_critical_alert_acknowledgement_receipts r
               WHERE r.tenant_id = w.tenant_id AND r.workflow_sla_instance_id = w.id)
          AND NOT EXISTS (SELECT 1 FROM diagnostic_result_generations g
               WHERE g.tenant_id = w.tenant_id AND g.critical_acknowledgement_sla_id = w.id)`,
      uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`, uids));
    // NOTE: clinical_audit_events is an APPEND-ONLY hash chain (migration 282
    // trigger; document-integrity.deep verifies the global per-tenant chain).
    // Deleting mid-chain rows here permanently breaks that chain for every later
    // run, so test audit rows are intentionally NOT deleted — orphaned-by-patient
    // is harmless (prod never deletes audit rows either) and the per-run UID
    // namespacing already prevents cross-run collisions.
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM medication_safety_reviews WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM vitals_chart WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM intake_output WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM news2_scores WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM lab_specimen_status_history WHERE specimen_id IN
         (SELECT id FROM lab_specimens WHERE patient_uid = ANY($1::uuid[]))`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM lab_specimens WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM patient_encounters WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM bed_transfers WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM attendant_passes WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM emergency_visits WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM patient_allergies WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM patient_consents WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM care_team_members WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM care_teams WHERE patient_uid = ANY($1::uuid[])`, uids));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE metadata->>'patient_uid' = ANY($1::text[])`, uids));
  }
  if (patientIntIds.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM clinical_alerts WHERE patient_id = ANY($1::int[])`, patientIntIds));
  }

  // Appointments by department marker and/or patient.
  if (departments.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history
         WHERE appointment_id IN (SELECT id FROM appointments WHERE department = ANY($1::text[]))`,
      departments));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE department = ANY($1::text[])`, departments));
  }
  if (phoneForms.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history
         WHERE appointment_id IN (SELECT id FROM appointments WHERE phone = ANY($1::text[]))`,
      phoneForms));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone = ANY($1::text[])`, phoneForms));
  }
  if (patientIntIds.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history
         WHERE appointment_id IN (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
      patientIntIds));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, patientIntIds));
  }

  // Beds + wards.
  if (bedNumbers.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM beds WHERE bed_number = ANY($1::text[])`, bedNumbers));
  }
  if (wardNames.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM wards WHERE name = ANY($1::text[])`, wardNames));
  }

  // Doctors profiles for the staff we created, then the users themselves.
  if (allUids.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid = ANY($1::uuid[]))`,
      allUids));
  }
  // Sweep any patient rows the walk-in path auto-created on our phones
  // (DEPEND-/UNIDENT- placeholder patients carry our phone in guardian_phone).
  if (phoneForms.length) {
    await swallow(prisma.$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL
        WHERE phone = ANY($1::text[]) OR guardian_phone = ANY($1::text[])`, phoneForms));
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE (phone = ANY($1::text[]) OR guardian_phone = ANY($1::text[]))
         AND role = 'PATIENT'`, phoneForms));
  }
  if (allUids.length) {
    await swallow(prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids));
  }
}

// Resolve a patient's uid from the int id the walk-in response returns.
export async function uidForUserId(userId) {
  const rows = await prisma.$queryRawUnsafe(`SELECT uid FROM users WHERE id = $1::int`, userId);
  return rows[0]?.uid ?? null;
}

export { prisma };
