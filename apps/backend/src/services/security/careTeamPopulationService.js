// src/services/security/careTeamPopulationService.js
//
// CareTeam ABAC — Phase 1 auto-population hooks.
//
// When a relationship between a clinician and a patient is *established* by a
// workflow, we materialise it into the care_team_members table (migration 260)
// so the ABAC engine's care-team relationship check (chain step 5) and the
// shadow-mode audit signal are meaningful — rather than relying solely on the
// fallback authorship/appointment/admission checks.
//
// Phase 1 implements the FIRST hook: admission create → admitting + attending
// doctor (and any explicitly-supplied ward nurses) become active care-team
// members of an `ip` care team for the patient/admission.
//
// Phase 2 adds two more hooks (design ref docs/CARETEAM_ABAC_DESIGN.md §7):
//   #2 appointment booking → consulting/booked doctor onto an `op` care team
//      for the patient/appointment.
//   #3 clinical note / order authorship → the author onto a `longitudinal`
//      care team for the patient.
// These relationships are *already* recognised by the engine's fallback chain
// (appointment / authorship checks), so the hooks mainly upgrade audit
// attribution to `care_team` and make the care-team source non-empty.
//
// CRITICAL: every hook here is BEST-EFFORT / post-commit (repo Phase 1.5
// pattern, see apps/backend/CLAUDE.md). It must NEVER block or fail the
// originating workflow (admission / booking / note / order). Each public
// entrypoint swallows every error and is idempotent (existence-checked team +
// ON CONFLICT-guarded members), so re-running on the same row is a fast no-op
// and a failure is logged, never propagated.
//
// relationship_kind values are constrained by the care_team_members CHECK in
// migration 260 (chk: primary_consultant, attending_doctor, covering_doctor,
// resident, nurse, pharmacist, physiotherapist, billing_counsellor,
// care_coordinator, diagnostics, housekeeping, care_team, other). Where the
// natural semantic label is NOT in that list we pick the closest allowed value
// (NO migration is added):
//   * "consulting_doctor" (appointment booking)  -> 'attending_doctor'
//     (the booked OP doctor is the clinician attending that patient's visit).
//   * "clinical_author"    (note / order author) -> 'care_team'
//     (generic active membership; the author is on the patient's care team by
//      virtue of authoring their chart).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Find the active `ip` care team for this patient + admission, or create one.
 * Idempotent: the SELECT short-circuits when a matching active team already
 * exists (mirrors the partial unique index uq_active_care_team_context without
 * relying on fragile partial-index ON CONFLICT inference).
 *
 * @returns {Promise<number|null>} care_team id, or null on failure.
 */
async function ensureAdmissionCareTeam({
  tenantId, patientUid, admissionId, createdBy,
}) {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM care_teams
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND COALESCE(admission_id, 0) = COALESCE($3::int, 0)
        AND team_kind = 'ip'
        AND status IN ('active', 'paused')
      ORDER BY id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    admissionId,
  );
  if (existing[0]?.id) return existing[0].id;

  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO care_teams (
       tenant_id, patient_uid, admission_id, team_kind, status,
       display_name, created_by, updated_by, created_at, updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3::int, 'ip', 'active', $4, $5::uuid, $5::uuid, NOW(), NOW())
     RETURNING id`,
    tenantId,
    patientUid,
    admissionId,
    'Inpatient care team',
    cleanUuid(createdBy),
  );
  return inserted[0]?.id ?? null;
}

/**
 * Generic ensure-an-active-care-team for the OP / longitudinal hooks.
 * Idempotent: the SELECT short-circuits on a matching active/paused team
 * (mirrors the partial unique index uq_active_care_team_context, which keys on
 * tenant_id, patient_uid, COALESCE(admission_id,0), COALESCE(appointment_id,0),
 * team_kind). admissionId/appointmentId are independent optional context ints.
 *
 * @returns {Promise<number|null>} care_team id, or null on failure.
 */
async function ensureCareTeam({
  tenantId, patientUid, appointmentId = null, teamKind, displayName, createdBy,
}) {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM care_teams
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND COALESCE(admission_id, 0) = 0
        AND COALESCE(appointment_id, 0) = COALESCE($3::int, 0)
        AND team_kind = $4
        AND status IN ('active', 'paused')
      ORDER BY id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    appointmentId,
    teamKind,
  );
  if (existing[0]?.id) return existing[0].id;

  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO care_teams (
       tenant_id, patient_uid, appointment_id, team_kind, status,
       display_name, created_by, updated_by, created_at, updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3::int, $4, 'active', $5, $6::uuid, $6::uuid, NOW(), NOW())
     RETURNING id`,
    tenantId,
    patientUid,
    appointmentId,
    teamKind,
    displayName,
    cleanUuid(createdBy),
  );
  return inserted[0]?.id ?? null;
}

/**
 * Idempotently add one active member to a care team. Uses ON CONFLICT against
 * the partial unique index uq_active_care_team_member_role
 * (care_team_id, COALESCE(staff_uid,...), COALESCE(staff_id,0), relationship_kind)
 * WHERE status='active', so re-adding the same person+role is a no-op.
 *
 * At least one of staffUid / staffId must be present (table CHECK
 * chk_care_team_member_identity). Returns true if an insert was attempted.
 */
async function addCareTeamMember({
  tenantId, careTeamId, patientUid, staffUid, staffId, staffRole, relationshipKind, createdBy,
}) {
  const uid = cleanUuid(staffUid);
  const id = cleanInt(staffId);
  if (!uid && !id) return false;

  await prisma.$executeRawUnsafe(
    `INSERT INTO care_team_members (
       tenant_id, care_team_id, patient_uid, staff_uid, staff_id, staff_role,
       relationship_kind, status, active_from, created_by, updated_by, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2::int, $3::uuid, $4::uuid, $5::int, $6,
       $7, 'active', NOW(), $8::uuid, $8::uuid, NOW(), NOW()
     )
     ON CONFLICT (
       care_team_id,
       COALESCE(staff_uid, '00000000-0000-0000-0000-000000000000'::uuid),
       COALESCE(staff_id, 0),
       relationship_kind
     ) WHERE status = 'active'
     DO NOTHING`,
    tenantId,
    careTeamId,
    patientUid,
    uid,
    id,
    staffRole ?? null,
    relationshipKind,
    cleanUuid(createdBy),
  );
  return true;
}

/**
 * Phase 1 hook: populate the care team for a freshly-created admission.
 *
 * Best-effort & idempotent. Inserts active care_team_members for the admitting
 * doctor (primary_consultant) and attending doctor (attending_doctor), plus any
 * explicitly-supplied ward nurses (relationship_kind 'nurse'). Ward nurses are
 * only added when the caller can supply them — the schema has no reliable
 * admission→nurse assignment link, so admission create supplies none today and
 * the doctors are the load-bearing memberships. This never throws.
 *
 * @param {object} admission - the created admission row (must carry id,
 *   patient_uid, admitting_doctor; optionally attending_doctor, tenant_id).
 * @param {object} [options]
 * @param {string[]} [options.wardNurseUids] - optional staff uids to add as nurses.
 * @param {string} [options.createdBy] - actor uid for audit columns.
 * @returns {Promise<{careTeamId:number|null, membersAttempted:number}>}
 */
export async function populateAdmissionCareTeam(admission, options = {}) {
  const result = { careTeamId: null, membersAttempted: 0 };
  try {
    const tenantId = requireTenantId(admission?.tenant_id || options.tenantId);
    const patientUid = cleanUuid(admission?.patient_uid);
    const admissionId = cleanInt(admission?.id);
    const createdBy = options.createdBy ?? admission?.created_by ?? admission?.admitting_doctor ?? null;

    if (!patientUid || !admissionId) {
      // Nothing to scope a care team to — silently skip (not an error).
      return result;
    }

    const careTeamId = await ensureAdmissionCareTeam({
      tenantId, patientUid, admissionId, createdBy,
    });
    if (!careTeamId) return result;
    result.careTeamId = careTeamId;

    const members = [];
    const admittingUid = cleanUuid(admission?.admitting_doctor);
    if (admittingUid) {
      members.push({
        staffUid: admittingUid,
        staffRole: 'DOCTOR',
        relationshipKind: 'primary_consultant',
      });
    }
    const attendingUid = cleanUuid(admission?.attending_doctor);
    // If attending === admitting, both rows still insert: the unique index keys
    // on relationship_kind, so the same person can legitimately hold both the
    // 'primary_consultant' and 'attending_doctor' roles. The engine matches on
    // staff_uid regardless of role, so this is correct (not a duplicate).
    if (attendingUid) {
      members.push({
        staffUid: attendingUid,
        staffRole: 'DOCTOR',
        relationshipKind: 'attending_doctor',
      });
    }

    const wardNurseUids = Array.isArray(options.wardNurseUids) ? options.wardNurseUids : [];
    for (const nurseUid of wardNurseUids) {
      const uid = cleanUuid(nurseUid);
      if (uid) {
        members.push({
          staffUid: uid,
          staffRole: 'NURSING_STAFF',
          relationshipKind: 'nurse',
        });
      }
    }

    for (const m of members) {
      try {
        const attempted = await addCareTeamMember({
          tenantId,
          careTeamId,
          patientUid,
          staffUid: m.staffUid,
          staffId: m.staffId,
          staffRole: m.staffRole,
          relationshipKind: m.relationshipKind,
          createdBy,
        });
        if (attempted) result.membersAttempted += 1;
      } catch (memberErr) {
        // One bad member must not abort the rest.
        logger.warn('populateAdmissionCareTeam: member insert failed', {
          admissionId,
          relationshipKind: m.relationshipKind,
          error: memberErr?.message,
        });
      }
    }

    logger.info('populateAdmissionCareTeam: care team populated', {
      admissionId,
      careTeamId,
      membersAttempted: result.membersAttempted,
    });
    return result;
  } catch (err) {
    // CRITICAL: never let care-team population break an admission.
    logger.warn('populateAdmissionCareTeam failed (admission stands)', {
      admissionId: admission?.id,
      error: err?.message,
    });
    return result;
  }
}

/**
 * Phase 2 hook #2: populate the care team for a freshly-booked appointment.
 *
 * Best-effort & idempotent. Ensures an active `op` care team for the
 * patient/appointment and adds the consulting (booked) doctor as a member.
 *
 * relationship_kind is 'attending_doctor' — the closest value allowed by the
 * migration-260 CHECK to the natural "consulting_doctor" label (see file
 * header). The engine matches on staff_uid OR staff_id, so supplying either is
 * sufficient; we supply both when available.
 *
 * The appointment row returned by the booking service carries int ids
 * (patient_id, doctor_id) but not the uuids the care_team tables key on, so the
 * caller passes the resolved patientUid + doctorUid/doctorId explicitly (they
 * are already in scope at the booking site). This never throws.
 *
 * @param {object} params
 * @param {object} [params.appointment] - the created appointment row (for id + audit).
 * @param {string} params.tenantId - tenant uuid.
 * @param {string} params.patientUid - patient uuid (resolved by the caller).
 * @param {string} [params.doctorUid] - consulting doctor uuid (preferred match key).
 * @param {number} [params.doctorId] - consulting doctor int id (users.id fallback key).
 * @param {string} [params.doctorRole] - staff_role label (default 'DOCTOR').
 * @param {string} [params.createdBy] - actor uid for audit columns.
 * @returns {Promise<{careTeamId:number|null, membersAttempted:number}>}
 */
export async function populateAppointmentCareTeam(params = {}) {
  const result = { careTeamId: null, membersAttempted: 0 };
  try {
    const tenantId = requireTenantId(params.tenantId || params.appointment?.tenant_id);
    const patientUid = cleanUuid(params.patientUid || params.appointment?.patient_uid);
    const appointmentId = cleanInt(params.appointmentId ?? params.appointment?.id);
    const doctorUid = cleanUuid(params.doctorUid);
    const doctorId = cleanInt(params.doctorId);
    const createdBy = params.createdBy ?? params.appointment?.created_by ?? doctorUid ?? null;

    // Nothing to scope a team to, or no doctor to add → silently skip.
    if (!patientUid) return result;
    if (!doctorUid && !doctorId) return result;

    const careTeamId = await ensureCareTeam({
      tenantId,
      patientUid,
      appointmentId,
      teamKind: 'op',
      displayName: 'Outpatient care team',
      createdBy,
    });
    if (!careTeamId) return result;
    result.careTeamId = careTeamId;

    try {
      const attempted = await addCareTeamMember({
        tenantId,
        careTeamId,
        patientUid,
        staffUid: doctorUid,
        staffId: doctorId,
        staffRole: params.doctorRole || 'DOCTOR',
        relationshipKind: 'attending_doctor',
        createdBy,
      });
      if (attempted) result.membersAttempted += 1;
    } catch (memberErr) {
      logger.warn('populateAppointmentCareTeam: member insert failed', {
        appointmentId,
        error: memberErr?.message,
      });
    }

    logger.info('populateAppointmentCareTeam: care team populated', {
      appointmentId,
      careTeamId,
      membersAttempted: result.membersAttempted,
    });
    return result;
  } catch (err) {
    // CRITICAL: never let care-team population break a booking.
    logger.warn('populateAppointmentCareTeam failed (booking stands)', {
      appointmentId: params.appointmentId ?? params.appointment?.id,
      error: err?.message,
    });
    return result;
  }
}

/**
 * Phase 2 hook #3: populate the care team for a clinical note / order author.
 *
 * Best-effort & idempotent. Ensures an active `longitudinal` care team for the
 * patient and adds the author as a member. Wired into the clinical-note create
 * and clinical-order create paths (post-commit), so the author who documents a
 * patient's chart becomes an explicit, auditable care-team member rather than
 * relying solely on the engine's authorship fallback.
 *
 * relationship_kind is 'care_team' — the closest value allowed by the
 * migration-260 CHECK to the natural "clinical_author" label (see file header);
 * it denotes generic active membership.
 *
 * @param {object} params
 * @param {string} params.tenantId - tenant uuid.
 * @param {string} params.patientUid - patient uuid.
 * @param {string} params.authorUid - author uuid (note author_uid / order ordered_by).
 * @param {string} [params.authorRole] - staff_role label.
 * @param {string} [params.source] - originating path label for logs ('clinical_note'|'clinical_order').
 * @returns {Promise<{careTeamId:number|null, membersAttempted:number}>}
 */
export async function populateAuthorshipCareTeam(params = {}) {
  const result = { careTeamId: null, membersAttempted: 0 };
  try {
    const tenantId = requireTenantId(params.tenantId);
    const patientUid = cleanUuid(params.patientUid);
    const authorUid = cleanUuid(params.authorUid);

    // No patient or no resolvable author uuid → silently skip.
    if (!patientUid || !authorUid) return result;

    const careTeamId = await ensureCareTeam({
      tenantId,
      patientUid,
      appointmentId: null,
      teamKind: 'longitudinal',
      displayName: 'Longitudinal care team',
      createdBy: authorUid,
    });
    if (!careTeamId) return result;
    result.careTeamId = careTeamId;

    try {
      const attempted = await addCareTeamMember({
        tenantId,
        careTeamId,
        patientUid,
        staffUid: authorUid,
        staffId: null,
        staffRole: params.authorRole || null,
        relationshipKind: 'care_team',
        createdBy: authorUid,
      });
      if (attempted) result.membersAttempted += 1;
    } catch (memberErr) {
      logger.warn('populateAuthorshipCareTeam: member insert failed', {
        source: params.source,
        error: memberErr?.message,
      });
    }

    logger.info('populateAuthorshipCareTeam: care team populated', {
      source: params.source,
      careTeamId,
      membersAttempted: result.membersAttempted,
    });
    return result;
  } catch (err) {
    // CRITICAL: never let care-team population break a note/order write.
    logger.warn('populateAuthorshipCareTeam failed (write stands)', {
      source: params.source,
      error: err?.message,
    });
    return result;
  }
}

export default {
  populateAdmissionCareTeam,
  populateAppointmentCareTeam,
  populateAuthorshipCareTeam,
};
