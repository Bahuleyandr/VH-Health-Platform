// Care-team CONTEXT SHAPES — the single definition of which `care_teams` row
// shapes the patient-access engine is able to honour.
//
// WHY THIS FILE EXISTS
// -------------------
// `accessDecisionService.findCareTeamRelationship` matches a care team through
// exactly three mutually-exclusive branches:
//
//   1. context-free  — appointment_id IS NULL AND admission_id IS NULL,
//                      and team_kind is 'longitudinal'. Governed by the team's
//                      own status window.
//   2. appointment   — appointment_id IS NOT NULL AND admission_id IS NULL,
//                      valid only while the appointment is inside the bounded
//                      30-day clinical follow-up window and not cancelled.
//   3. admission     — admission_id IS NOT NULL AND appointment_id IS NULL,
//                      valid only while the admission is admitted/transferred.
//
// Every other shape matches NO branch, so it confers no access at all. The
// `care_teams` CHECK constraint (migration 260) is much looser than that: it
// permits any of nine `team_kind` values in any combination of episode ids. A
// row can therefore be accepted by the database, returned 201 by the admin
// care-team API, appear in listings — and grant nothing, with no signal to the
// operator who created it to unblock a clinician.
//
// That silent gap is a clinical-safety hazard in the under-granting direction:
// the clinician cannot open the chart, while the audit trail shows an active
// care team that says they should be able to. Rather than widen the engine
// (which would re-open the stale-episode authority hole that the engine's
// three-branch shape deliberately closes), the write path refuses to persist a
// shape the engine cannot honour. Read and write now agree by construction, and
// `careTeamContextShapesAgreeWithEngine` in the unit tests pins them together.
//
// Two shapes are rejected:
//   * CONTEXT-FREE, NON-LONGITUDINAL (e.g. team_kind 'op' with no episode).
//     Documented in docs/CARETEAM_ABAC_DESIGN.md as "Only an explicit
//     longitudinal team can be context-free", and reported by
//     scripts/audit-care-team-enforcement-readiness.mjs as the enforce-readiness
//     blocker MALFORMED_CONTEXT_FREE_CARE_TEAM.
//   * DUAL-CONTEXT (both admission_id and appointment_id set). Ambiguous: there
//     is no principled answer to which episode's validity window governs the
//     team, and guessing one would silently extend authority from the other.

/** The three shapes the access engine can match. */
export const CARE_TEAM_CONTEXT_SHAPES = Object.freeze({
  LONGITUDINAL: 'longitudinal',
  APPOINTMENT: 'appointment',
  ADMISSION: 'admission',
});

/** The only `team_kind` an episode-free care team may carry. */
export const CONTEXT_FREE_TEAM_KIND = 'longitudinal';

/** Rejection codes surfaced to API clients. */
export const CARE_TEAM_SHAPE_REJECTIONS = Object.freeze({
  CONTEXT_FREE_REQUIRES_LONGITUDINAL: 'CARE_TEAM_CONTEXT_FREE_REQUIRES_LONGITUDINAL',
  AMBIGUOUS_EPISODE_CONTEXT: 'CARE_TEAM_AMBIGUOUS_EPISODE_CONTEXT',
});

/**
 * Mirror of the SQL's `LOWER(BTRIM(COALESCE(ct.team_kind, '')))`.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTeamKind(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

/**
 * Mirror of the SQL's `IS NULL` / `IS NOT NULL` test on an episode id column.
 * Anything that would land as SQL NULL counts as absent.
 * @param {unknown} value
 * @returns {boolean}
 */
function episodeIdPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Classify a prospective (or existing) care-team row against the shapes the
 * patient-access engine can honour.
 *
 * Pure: no I/O, safe to call from a validator, a migration audit, or a test.
 *
 * @param {object} row
 * @param {unknown} [row.teamKind]      - `care_teams.team_kind`.
 * @param {unknown} [row.admissionId]   - `care_teams.admission_id`.
 * @param {unknown} [row.appointmentId] - `care_teams.appointment_id`.
 * @returns {{honourable: boolean, shape: string|null, code: string|null, reason: string|null}}
 */
export function classifyCareTeamContextShape({
  teamKind = null,
  admissionId = null,
  appointmentId = null,
} = {}) {
  const kind = normalizeTeamKind(teamKind);
  const hasAdmission = episodeIdPresent(admissionId);
  const hasAppointment = episodeIdPresent(appointmentId);

  if (hasAdmission && hasAppointment) {
    return {
      honourable: false,
      shape: null,
      code: CARE_TEAM_SHAPE_REJECTIONS.AMBIGUOUS_EPISODE_CONTEXT,
      reason: 'A care team may be scoped to an admission or an appointment, not both — '
        + 'the access engine cannot decide which episode governs its validity.',
    };
  }

  if (hasAdmission) {
    return {
      honourable: true,
      shape: CARE_TEAM_CONTEXT_SHAPES.ADMISSION,
      code: null,
      reason: null,
    };
  }

  if (hasAppointment) {
    return {
      honourable: true,
      shape: CARE_TEAM_CONTEXT_SHAPES.APPOINTMENT,
      code: null,
      reason: null,
    };
  }

  if (kind === CONTEXT_FREE_TEAM_KIND) {
    return {
      honourable: true,
      shape: CARE_TEAM_CONTEXT_SHAPES.LONGITUDINAL,
      code: null,
      reason: null,
    };
  }

  return {
    honourable: false,
    shape: null,
    code: CARE_TEAM_SHAPE_REJECTIONS.CONTEXT_FREE_REQUIRES_LONGITUDINAL,
    reason: `A care team with no admission_id and no appointment_id must be '${CONTEXT_FREE_TEAM_KIND}'`
      + ` (received '${kind || '(empty)'}'). Scope an episode team to its admission or appointment,`
      + ' or record it as a longitudinal team.',
  };
}

export default classifyCareTeamContextShape;
