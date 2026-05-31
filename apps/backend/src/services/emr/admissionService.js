// src/services/emr/admissionService.js
// ADT (Admission/Discharge/Transfer) service — typed Prisma ORM.
// Batch 55: migrated from raw `dbTx.query` / `prisma.$queryRawUnsafe`
// to typed Prisma. The only remaining raw-SQL sites are the
// `SELECT ... FOR UPDATE` row locks inside transactions, which Prisma's
// typed surface still can't express; everything else (audit_logs,
// admissions/beds/bed_transfers/patient_consents CRUD, stats) is now
// going through the typed client.
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import {
  generateDischargeSummary,
  getLatestDischargeSummary,
  saveDischargeSummary,
} from './dischargeSummaryGenerator.js';
import {
  canEditDischargeSummary,
  canSignDischargeSummary,
} from '../../utils/roleHelpers.js';
import {
  issueDefaultAttendantPasses,
  expireAttendantPassesForAdmission,
  relocateActiveAttendantPasses,
  createWardIndentForClinicalMedicationOrder,
} from '../ipd/ipdSupportService.js';
import { createClaim as createTpaClaim, createPreauth } from '../insurance/claimsService.js';
import {
  ensureHospitalNumber,
  getHospitalNumberMap,
} from '../patient/patientIdentifierService.js';
import { createBedCleaningRequest } from '../staff/housekeepingTaskDispatchService.js';
import {
  ACTIVE_ADMISSION_STATUSES,
  applyInpatientAdmissionScope,
  MINIMIZED_INPATIENT_PAYLOAD_ROLES,
  resolveInpatientAdmissionScope,
} from './inpatientScopeService.js';


const VALID_STATUS_TRANSITIONS = {
  admitted: ['transferred', 'discharged', 'lama', 'expired'],
  transferred: ['admitted', 'discharged', 'lama', 'expired'],
};

// `day_care` covers same-day surgical (cataract, dialysis-access creation,
// minor laparoscopic, etc.) — admit in morning, discharge same evening.
// Previously had to be miscoded as `elective`, breaking package billing
// and the day-care discharge template. See finding
// 2026-05-08-surgical-day-care-admission-no-day-care-type.
const VALID_ADMISSION_TYPES = ['elective', 'emergency', 'transfer_in', 'day_care'];
const VALID_PRIORITIES = ['routine', 'urgent', 'emergent'];
const VALID_CODE_STATUSES = ['full_code', 'dnr', 'dni', 'comfort_care'];
const VALID_DISCHARGE_TYPES = ['home', 'transfer', 'lama', 'expired', 'aor'];
const READINESS_GATED_DISCHARGE_TYPES = new Set(['home', 'transfer', 'aor']);
// Mirrors the CHECK on admissions.room_category (migration 177).
const VALID_ROOM_CATEGORIES = ['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care'];
const ACTIVE_ER_ORDER_STATUSES = ['ordered', 'verified', 'in_progress'];

function shouldMinimizeInpatientPayload(role) {
  return MINIMIZED_INPATIENT_PAYLOAD_ROLES.has(normalizeRole(role));
}

function minimizeAdmissionPayload(row) {
  return {
    ...row,
    patient_uid: null,
    patient_name: 'Occupied',
    patient_phone: null,
    patient_hospital_number: null,
    hospital_number: null,
    patient_gender: null,
    patient_email: null,
    patient_birthday: null,
    chief_complaint: null,
    admitting_diagnosis: null,
    allergies: [],
    admitting_doctor: null,
    attending_doctor: null,
    admitting_doctor_name: null,
    attending_doctor_name: null,
  };
}

// Columns returned by the pre-batch-55 `RETURNING` clause. Mirrored as
// a Prisma `select` so the public response shape is unchanged.
const ADMISSION_RETURNING_SELECT = {
  id: true,
  tenant_id: true,
  encounter_id: true,
  patient_uid: true,
  status: true,
  // admission_type surfaced so Phase 1.5 post-commit branching (e.g.
  // auto-create day-care OT schedule) doesn't need an extra round trip.
  admission_type: true,
  admitting_doctor: true,
  ward: true,
  bed_id: true,
  bed_number: true,
  attending_doctor: true,
  admitted_at: true,
  discharged_at: true,
  code_status: true,
  created_at: true,
  updated_at: true,
  // ER linkage (migration 170). Surfaced so the admissions detail/list
  // payloads can render "Admitted from ER #..." continuity context.
  from_er_visit_id: true,
  er_arrival_at: true,
  // Agreed room category (migration 177). Surfaced everywhere so
  // billing / TPA / patient-app UIs can read directly off the
  // admission row.
  room_category: true,
  // Emergency consent bypass (migration 182). Surfaced so the
  // post-stabilisation consent-capture worklist can render the flag
  // without an extra fetch.
  emergency_consent_bypass_at: true,
  emergency_consent_bypass_by: true,
  emergency_consent_bypass_reason: true,
  // Wave-4B-1 (migrations 203 + 207) — structured insurance + package links.
  policy_id: true,
  package_id: true,
  package_code: true,
  package_estimated_cost_minor: true,
  // Stage-5 (migration 228) — govt-scheme eligibility flag (CMCHIS /
  // Ayushman Bharat). Surfaced so the admission detail/list payloads and
  // the insurance-counsellor worklist can read it off the row directly.
  govt_scheme: true,
  govt_scheme_status: true,
  // Rounding cadence (migration 229) — surfaced so the ward-round queue
  // and discharge/handover payloads can read when the patient is next due.
  next_review_at: true,
  // Re-admission continuity link (migration 230). Surfaced so the
  // admissions detail/list payloads can render the prior-discharge
  // continuity context.
  prior_admission_id: true,
};

// Doctor-role allowlist for admitting / attending validation. CONSULTANT
// is the canonical attending role; JUNIOR_DOCTOR may admit under
// supervision; ANAESTHETIST shows up as `attending_doctor` on
// surgical/day-care admissions where the anaesthesia team is the
// running primary. ADMIN/SUPER_ADMIN are excluded — neither can carry
// clinical responsibility for the chart.
const ADMISSION_DOCTOR_ROLES = new Set([
  'DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'ANAESTHETIST',
]);

// Validate that a UUID supplied as `admitting_doctor` or `attending_doctor`
// names an active clinical-role user. Without this, the API silently
// accepts any uuid (a patient/HR user, or a typo'd uuid that points
// nowhere) and stamps it on the admission row — breaking the ward
// roundup queue, the discharge-summary signer lookup, and TPA preauth
// (treating-doctor declaration). Finding:
//   2026-05-22-inpatient-admission-receptionist-06e43c24 / -7523da24.
// Roleless validation (`admitting_doctor` only) returns the canonical
// users.id so callers can stamp it on dependent rows (preauth, etc).
async function assertDoctorUid(uid, fieldLabel) {
  if (uid === undefined || uid === null || uid === '') return null;
  const uidStr = String(uid).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uidStr)) {
    throw AppError.badRequest(
      `${fieldLabel} must be a valid uuid (got "${uidStr.slice(0, 64)}")`,
      'INVALID_DOCTOR_UID',
    );
  }
  const row = await prisma.users.findUnique({
    where: { uid: uidStr },
    select: { id: true, role: true, is_active: true },
  });
  if (!row) {
    throw AppError.badRequest(
      `${fieldLabel} ${uidStr} does not match any user`,
      'DOCTOR_UID_NOT_FOUND',
    );
  }
  if (row.is_active === false) {
    throw AppError.badRequest(
      `${fieldLabel} ${uidStr} is inactive`,
      'DOCTOR_UID_INACTIVE',
    );
  }
  const role = String(row.role || '').toUpperCase();
  if (!ADMISSION_DOCTOR_ROLES.has(role)) {
    throw AppError.badRequest(
      `${fieldLabel} ${uidStr} has role "${role}" — must be a clinical doctor role ` +
        `(one of ${[...ADMISSION_DOCTOR_ROLES].join(', ')})`,
      'DOCTOR_UID_ROLE_INVALID',
    );
  }
  return { id: row.id, role };
}

// Map ESI/ATS triage acuity onto admissions.priority. Used when the admit
// caller didn't pass `priority` explicitly but did link an ER visit.
// Conservative mapping: anything resus/level-1/level-2 → emergent;
// level-3 / "urgent" → urgent; everything else → routine.
function mapTriagePriorityToAdmissionPriority(triagePriority) {
  if (!triagePriority) return null;
  const t = String(triagePriority).toLowerCase();
  if (['esi_1', 'esi_2', 'ats_1', 'ats_2', 'resus', 'emergent'].includes(t)) {
    return 'emergent';
  }
  if (['esi_3', 'ats_3', 'urgent'].includes(t)) {
    return 'urgent';
  }
  return 'routine';
}

async function carryActiveErOrdersToAdmission(tx, {
  erVisit,
  admission,
  patientUid,
  createdBy,
}) {
  if (!erVisit?.encounter_id || !admission?.encounter_id) return [];

  const carried = await tx.$queryRawUnsafe(
    `UPDATE clinical_orders
        SET encounter_id = $1::uuid,
            updated_at = NOW()
      WHERE patient_uid = $2::uuid
        AND encounter_id = $3::uuid
        AND COALESCE(status, 'ordered') = ANY($4::text[])
      RETURNING id, order_number, encounter_id, patient_uid, order_type,
                priority, details, status, ordered_by, verified_by,
                verified_at, start_date, end_date, notes, route,
                created_at, updated_at`,
    admission.encounter_id,
    patientUid,
    erVisit.encounter_id,
    ACTIVE_ER_ORDER_STATUSES,
  );

  if (!carried.length) return carried;

  await tx.audit_logs.create({
    data: {
      uid: createdBy,
      action: 'ER_ORDERS_CARRIED_TO_ADMISSION',
      resource: 'admission',
      resource_id: String(admission.id),
      metadata: {
        patient_uid: patientUid,
        admission_id: admission.id,
        from_er_visit_id: erVisit.id,
        from_er_encounter_id: erVisit.encounter_id,
        admission_encounter_id: admission.encounter_id,
        carried_order_ids: carried.map((order) => order.id),
        carried_order_numbers: carried.map((order) => order.order_number).filter(Boolean),
      },
      ip_address: null,
    },
  });

  return carried;
}

// Compute days-since-admission when actual LOS not persisted
function computeLos(admittedAt, dischargedAt) {
  if (!admittedAt) return null;
  const end = dischargedAt ? new Date(dischargedAt) : new Date();
  return Math.max(1, Math.ceil((end - new Date(admittedAt)) / (1000 * 60 * 60 * 24)));
}

function formatIpNumber(admissionId, admittedAt = null) {
  const id = Number.parseInt(admissionId, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const year = admittedAt ? new Date(admittedAt).getFullYear() : new Date().getFullYear();
  return `IP-${year}-${String(id).padStart(5, '0')}`;
}

async function admitPatient(data) {
  const {
    patient_uid,
    admitting_doctor,
    attending_doctor,
    department,
    ward,
    bed_id,
    chief_complaint: chiefComplaintArg,
    admitting_diagnosis,
    admission_type: admissionTypeArg = 'elective',
    priority: priorityArg,
    insurance_info,
    emergency_contact,
    allergies = [],
    code_status = 'full_code',
    expected_los_days,
    created_by,
    // ER linkage. When set, the admission is treated as a continuation of
    // the named ER visit — chief_complaint / priority / attending doctor
    // carry over from the ER chart unless the caller passed explicit
    // values, and the ER visit is closed (disposition='admitted',
    // departure_at=NOW()) in the same transaction. Migration 170. See
    // finding 2026-05-08-emergency-walk-in-doctor-admit-no-er-visit-linkage.
    from_er_visit_id,
    // Agreed room category at admit time (migration 177). Drives
    // tariff + TPA pre-auth, independent of the actually-assigned bed.
    // Falls back to the joined bed's bed_type when omitted. See finding
    // 2026-05-08-inpatient-admission-admission-no-semiprivate-room-category.
    room_category: roomCategoryArg,
    // Wave-4B-1 — structured links to the chosen insurance policy and
    // surgical/day-care package. Migrations 203 + 204. See findings:
    //   2026-05-09-tpa-insurance-claim-admission-insurance-policy-no-insurer-master
    //   2026-05-10-surgical-day-care-admission-package-not-linked
    policy_id: policyIdArg,
    package_id: packageIdArg,
    package_code: packageCodeArg,
    package_estimated_cost_minor: packageEstimatedCostMinorArg,
    // Stage-5 — govt-scheme eligibility flag (CMCHIS / Ayushman Bharat).
    // A rural / low-income patient flagged here at the admission counter
    // gets routed to the insurance counsellor instead of being silently
    // admitted as cash-paying. Migration 228. Finding:
    //   2026-05-09-inpatient-admission-admission-no-cmchis-flag-no-tamil-consent.
    govt_scheme,
    govt_scheme_status,
    // Optional rounding cadence at admit time (migration 229). Most
    // admits set this later via PUT /:id/next-review, after orders.
    next_review_at,
    // TPA fields passed as raw strings (no policy_id yet). Used for
    // policy_number → policy_id auto-resolution and preauth auto-draft.
    // Finding: 2026-05-21-tpa-insurance-claim-admission-cea3771d.
    policy_number,
    estimated_cost,
    tenant_id,
    // OPD→IPD advice handoff. The advise-admission bridge stamps
    // appointments.advised_for_admission_at and that flag is the SOLE
    // source for the admission counter's worklist
    // (GET /appointments?advised_for_admission=true). When the counter
    // then admits the patient, the originating advice must be marked
    // fulfilled so the patient drops out of the advice queue — otherwise
    // they stay stuck "advised to admit" forever. There is no
    // admission_advices table in this schema (the advice lives on the
    // appointment row), so the link IS the source appointment id. The
    // admit body may carry it as `admission_advice_id` (the staff app /
    // swarm probe both use this name) or `appointment_id`; either resolves
    // to the appointment whose advice flag we clear. Optional — when
    // absent we fall back to clearing every still-open advised appointment
    // for this patient. Finding:
    //   2026-05-21-inpatient-admission-receptionist-5e965972.
    admission_advice_id,
    appointment_id: appointmentIdArg,
  } = data;

  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!admitting_doctor) throw AppError.badRequest('admitting_doctor is required');
  if (!created_by) throw AppError.badRequest('created_by is required');

  // Reject non-existent or non-clinical doctor UIDs before we lock the
  // bed / mint the encounter / fire downstream best-effort writes. Both
  // columns are uuid in the schema (admissions.admitting_doctor,
  // .attending_doctor), but no FK enforces they reference an actual
  // doctor; without this guard a typo'd uuid or a patient/HR user uid
  // would be stamped on the admission and silently surface on the ward
  // roundup queue + the discharge summary signer lookup. Attending is
  // optional (carry-over from ER); admitting is required. Findings:
  //   2026-05-22-inpatient-admission-receptionist-06e43c24
  //   2026-05-22-inpatient-admission-receptionist-7523da24.
  await assertDoctorUid(admitting_doctor, 'admitting_doctor');
  if (attending_doctor) {
    await assertDoctorUid(attending_doctor, 'attending_doctor');
  }
  // Normalise admission_type case + common synonyms so callers passing
  // DAY_CARE / DAYCARE / Day-Care / daycare don't crash with
  // 'Invalid admission_type'. The admin walk-in dialog and external API
  // consumers send mixed forms; the storage value stays lowercase
  // snake_case per the enum. Finding:
  //   POST /api/v1/emr/admit admission_type enum is case-/spelling-inconsistent
  //   (only lowercase day_care accepted; DAYCARE/DAY_CARE/SCHEDULED rejected).
  let admission_type = String(admissionTypeArg || 'elective')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (admission_type === 'daycare') admission_type = 'day_care';
  if (admission_type === 'scheduled') admission_type = 'elective';
  if (admission_type === 'er' || admission_type === 'ed') admission_type = 'emergency';
  if (admission_type === 'transfer' || admission_type === 'transferin') admission_type = 'transfer_in';
  if (!VALID_ADMISSION_TYPES.includes(admission_type)) {
    throw AppError.badRequest(
      `Invalid admission_type: ${admission_type} (accepted: ${VALID_ADMISSION_TYPES.join(', ')})`,
    );
  }
  if (priorityArg !== undefined && priorityArg !== null && !VALID_PRIORITIES.includes(priorityArg)) {
    throw AppError.badRequest(`Invalid priority: ${priorityArg}`);
  }
  if (!VALID_CODE_STATUSES.includes(code_status)) {
    throw AppError.badRequest(`Invalid code_status: ${code_status}`);
  }
  if (roomCategoryArg !== undefined && roomCategoryArg !== null && roomCategoryArg !== '' &&
      !VALID_ROOM_CATEGORIES.includes(roomCategoryArg)) {
    throw AppError.badRequest(`Invalid room_category: ${roomCategoryArg}. Must be one of: ${VALID_ROOM_CATEGORIES.join(', ')}`);
  }

  // Stage-5 — govt-scheme eligibility (migration 228). Both columns are
  // optional and nullable; validate the status enum when supplied so the
  // insurance-counsellor worklist filter stays meaningful. When a scheme
  // name is given without a status, default to pending_verification so it
  // still surfaces on the counsellor's queue.
  const VALID_GOVT_SCHEME_STATUSES = ['eligible', 'pending_verification', 'enrolled', 'not_eligible'];
  const resolvedGovtScheme = govt_scheme ? String(govt_scheme).trim().slice(0, 60) : null;
  let resolvedGovtSchemeStatus = null;
  if (govt_scheme_status !== undefined && govt_scheme_status !== null && govt_scheme_status !== '') {
    const s = String(govt_scheme_status).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!VALID_GOVT_SCHEME_STATUSES.includes(s)) {
      throw AppError.badRequest(
        `Invalid govt_scheme_status: ${govt_scheme_status}. Must be one of: ${VALID_GOVT_SCHEME_STATUSES.join(', ')}`,
      );
    }
    resolvedGovtSchemeStatus = s;
  } else if (resolvedGovtScheme) {
    resolvedGovtSchemeStatus = 'pending_verification';
  }

  // OPD→IPD advice handoff. Resolve the optional source-advice appointment
  // id from either alias up front so a malformed value fails clean (400)
  // rather than as an opaque error later. The clear itself runs in Phase
  // 1.5 (best-effort, post-commit) so closing the advice loop can never
  // roll back a clinically-successful admission. Finding:
  //   2026-05-21-inpatient-admission-receptionist-5e965972.
  let adviceAppointmentId = null;
  const adviceRef = admission_advice_id ?? appointmentIdArg;
  if (adviceRef !== undefined && adviceRef !== null && adviceRef !== '') {
    const parsed = Number.parseInt(adviceRef, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw AppError.badRequest('admission_advice_id must be a positive integer (the advised appointment id)');
    }
    adviceAppointmentId = parsed;
  }

  // Optional review-after timestamp (migration 229). Validate up front so
  // a malformed value fails clean instead of as an opaque Prisma error.
  let nextReviewAt = null;
  if (next_review_at !== undefined && next_review_at !== null && next_review_at !== '') {
    nextReviewAt = new Date(next_review_at);
    if (Number.isNaN(nextReviewAt.getTime())) {
      throw AppError.badRequest('next_review_at must be a valid timestamp (ISO 8601)');
    }
  }

  // ER-linkage validation. Resolve the ER visit up-front so we can also
  // use it to fill in chief_complaint / priority / attending_doctor if
  // the caller left them empty.
  let erVisit = null;
  if (from_er_visit_id !== undefined && from_er_visit_id !== null && from_er_visit_id !== '') {
    const erVisitId = Number.parseInt(from_er_visit_id, 10);
    if (!Number.isInteger(erVisitId) || erVisitId <= 0) {
      throw AppError.badRequest('from_er_visit_id must be a positive integer');
    }
    erVisit = await prisma.emergency_visits.findUnique({
      where: { id: erVisitId },
      select: {
        id: true,
        patient_uid: true,
        status: true,
        disposition: true,
        encounter_id: true,
        chief_complaint: true,
        triage_priority: true,
        attending_doctor_uid: true,
        arrival_at: true,
      },
    });
    if (!erVisit) throw AppError.notFound('Linked ER visit not found');
    if (erVisit.patient_uid && erVisit.patient_uid !== patient_uid) {
      throw AppError.badRequest('ER visit patient_uid does not match this admission');
    }
    const TERMINAL_DISPOSITIONS = new Set(['admitted', 'discharged', 'lama', 'expired']);
    if (erVisit.disposition && TERMINAL_DISPOSITIONS.has(erVisit.disposition)) {
      throw AppError.conflict(
        `ER visit ${erVisit.id} is already ${erVisit.disposition} — cannot re-admit from a closed encounter`,
      );
    }
  }

  // Carry-over: explicit caller values win; otherwise inherit from the ER
  // chart. ER bed is intentionally NOT carried — ER and ward bed pools
  // are separate by project decision (2026-05-09).
  const chief_complaint = chiefComplaintArg ?? erVisit?.chief_complaint ?? null;
  if (!chief_complaint) {
    throw AppError.badRequest('chief_complaint is required (and was not present on the linked ER visit)');
  }
  const priority = priorityArg
    ?? mapTriagePriorityToAdmissionPriority(erVisit?.triage_priority)
    ?? 'routine';
  if (!VALID_PRIORITIES.includes(priority)) {
    throw AppError.badRequest(`Invalid priority: ${priority}`);
  }
  const resolvedAttendingDoctor = attending_doctor ?? erVisit?.attending_doctor_uid ?? null;
  const erArrivalAt = erVisit?.arrival_at ?? null;

  // Bed-allocation gate (migration 171). Strict-with-emergency-exception:
  // an admission MUST have a bed_id, except for emergency admits with
  // emergent priority where bed allocation may lag behind clinical
  // urgency. Day-care admissions always require a bed AND that bed must
  // be in the day_care pool (beds.bed_type='day_care'). See finding
  // 2026-05-08-emergency-walk-in-doctor-admit-without-bed-allowed.
  const isEmergencyExceptionEligible = admission_type === 'emergency' && priority === 'emergent';
  const bedlessAdmit = bed_id === undefined || bed_id === null;
  if (bedlessAdmit && !isEmergencyExceptionEligible) {
    throw AppError.badRequest(
      `bed_id is required for ${admission_type} admissions. Bedless admit is only allowed for admission_type='emergency' with priority='emergent'.`,
    );
  }
  if (admission_type === 'day_care' && bedlessAdmit) {
    throw AppError.badRequest('Day-care admissions require a bed_id at admit time (no emergency bedless exception).');
  }

  // Resolve room_category. Caller-supplied wins; otherwise fall back to
  // the joined bed.bed_type (when a bed is assigned and its type is in
  // the valid set), otherwise null. Day-care admissions get 'day_care'
  // as a final fallback so billing always has a category. Migration 177.
  let resolvedRoomCategory = roomCategoryArg && roomCategoryArg !== '' ? roomCategoryArg : null;
  if (!resolvedRoomCategory && bed_id) {
    const bedRow = await prisma.beds.findUnique({
      where: { id: Number(bed_id) },
      select: { bed_type: true },
    });
    if (bedRow?.bed_type && VALID_ROOM_CATEGORIES.includes(bedRow.bed_type)) {
      resolvedRoomCategory = bedRow.bed_type;
    }
  }
  if (!resolvedRoomCategory && admission_type === 'day_care') {
    resolvedRoomCategory = 'day_care';
  }

  // E-4 — ICU tier RBAC. Admitting to an ICU/CCU bed requires a higher
  // privilege tier than general-ward admission. Caller's role is passed
  // via data.actor_role (admit endpoint forwards req.user.role). The
  // standard NURSING_STAFF (ward nurse) cannot allocate ICU beds; only
  // ICU_NURSE / DOCTOR / ADMIN tiers can. See finding:
  // 2026-05-08-emergency-walk-in-admission-no-icu-rbac-tier.
  const isIcuTarget = resolvedRoomCategory === 'icu';
  if (isIcuTarget) {
    const ICU_ALLOCATE_ROLES = new Set([
      'DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR',
      'ADMIN', 'SUPER_ADMIN',
      'ICU_NURSE', 'ICU_INCHARGE',
    ]);
    const actorRole = data.actor_role || data.created_by_role || null;
    if (actorRole && !ICU_ALLOCATE_ROLES.has(actorRole)) {
      throw AppError.forbidden(
        `ICU bed allocation requires DOCTOR / ICU_NURSE / ADMIN tier (got role=${actorRole})`,
        'ICU_TIER_REQUIRED',
      );
    }
  }

  // B-4 — emergency consent bypass (migration 182). Implied-consent
  // doctrine permits life-saving admission without prior written
  // consent. Bypass fires for any admission_type='emergency', regardless
  // of priority — an urgent NSTEMI (troponin+, ESI-2/3) qualifies just
  // as a resus-level emergent case does. The bedless-admit exception
  // (isEmergencyExceptionEligible) stays restricted to emergent+bedless
  // as a separate operational gate. Caller may supply
  // emergency_consent_bypass_reason; a sensible default is recorded when
  // omitted so the chart always shows why consent was bypassed.
  // Findings:
  //   2026-05-08-emergency-walk-in-admission-emergency-blocked-by-consent
  //   2026-05-08-inpatient-admission-doctor-emergency-admit-blocked-by-treatment-consent
  //   2026-05-08-emergency-walk-in-doctor-admit-consent-blocks-emergency.
  const isEmergencyConsentBypassEligible = admission_type === 'emergency';
  let emergencyBypass = null;
  // Consent gate. An active `treatment` consent satisfies it outright. A
  // `procedure` consent — captured at the pre-op OPD visit for a
  // scheduled day-care / surgical patient — also satisfies it, provided
  // it was granted within the carry-over window, so the patient isn't
  // made to re-consent at the admission counter on the morning of
  // surgery. Finding:
  //   2026-05-09-surgical-day-care-admission-consent-no-preop-carryover.
  const PREOP_CONSENT_CARRYOVER_DAYS = 30;
  const preopConsentWindowStart = new Date(
    Date.now() - PREOP_CONSENT_CARRYOVER_DAYS * 24 * 60 * 60 * 1000,
  );
  const consent = await prisma.patient_consents.findFirst({
    where: {
      patient_uid,
      status: 'active',
      OR: [
        { consent_type: 'treatment' },
        { consent_type: 'procedure', granted_at: { gte: preopConsentWindowStart } },
      ],
    },
    select: { id: true },
  });
  if (!consent) {
    if (!isEmergencyConsentBypassEligible) {
      throw AppError.forbidden('Active treatment consent required before admission', 'CONSENT_REQUIRED');
    }
    const reason = data.emergency_consent_bypass_reason
      || 'Implied consent — emergent clinical condition; written consent to be captured post-stabilisation';
    emergencyBypass = {
      at: new Date(),
      by: data.emergency_consent_bypass_by || created_by,
      reason,
    };
    logger.warn(
      `Emergency consent bypass fired for admission of patient_uid=${patient_uid} ` +
      `by=${emergencyBypass.by} reason="${reason.slice(0, 80)}"`,
    );
  }

  const existingAdmission = await prisma.admissions.findFirst({
    where: { patient_uid, status: { in: ['admitted', 'transferred'] } },
    select: { id: true },
  });
  if (existingAdmission) {
    throw AppError.conflict('Patient already has an active admission');
  }

  // Re-admission continuity (migration 230). If this patient was
  // discharged from a prior admission within the last 7 days, link the
  // new admission to it so the discharge desk and clinicians can pull
  // the recent summary, medication changes, and unresolved follow-up.
  // Pre-flight on plain `prisma` (Phase 0) — outside the transaction.
  // 'discharged' and 'lama' both mean the patient left and may return;
  // 'expired' is excluded. See finding
  // 2026-05-10-surgical-day-care-discharge-readmit-continuity-unlinked.
  const READMISSION_WINDOW_DAYS = 7;
  const priorDischarge = await prisma.admissions.findFirst({
    where: {
      patient_uid,
      status: { in: ['discharged', 'lama'] },
      discharged_at: {
        gte: new Date(Date.now() - READMISSION_WINDOW_DAYS * 86400000),
      },
    },
    orderBy: { discharged_at: 'desc' },
    select: { id: true },
  });
  const priorAdmissionId = priorDischarge?.id ?? null;

  // Wave-4B-1 — resolve policy / package references against their masters
  // up front so the transaction doesn't have to roundtrip. Both are
  // optional; an unmatched code returns null and is treated as not-linked.
  let resolvedPolicyId = null;
  if (policyIdArg !== undefined && policyIdArg !== null && policyIdArg !== '') {
    const policyIdInt = Number(policyIdArg);
    if (!Number.isInteger(policyIdInt) || policyIdInt <= 0) {
      throw AppError.badRequest('policy_id must be a positive integer');
    }
    const policy = await prisma.insurance_policies.findUnique({
      where: { id: policyIdInt },
      select: { id: true, patient_uid: true },
    });
    if (!policy) throw AppError.badRequest(`policy_id ${policyIdInt} not found`);
    if (policy.patient_uid !== patient_uid) {
      throw AppError.badRequest('policy_id belongs to a different patient');
    }
    resolvedPolicyId = policy.id;
  }

  // Fallback: if caller sent raw policy_number instead of policy_id
  // (e.g. the TPA admission desk form or walk-in kiosk), resolve the
  // most recent matching policy for this patient so policy_id is linked
  // at admit time without requiring a separate PUT /:id/policy call.
  if (!resolvedPolicyId && policy_number) {
    const policyByNum = await prisma.insurance_policies.findFirst({
      where: { patient_uid, policy_number: String(policy_number) },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (policyByNum) resolvedPolicyId = policyByNum.id;
  }

  let resolvedPackageId = null;
  let resolvedPackageCode = packageCodeArg ?? null;
  let resolvedPackageEstMinor = packageEstimatedCostMinorArg != null
    ? BigInt(packageEstimatedCostMinorArg)
    : null;
  if (packageIdArg !== undefined && packageIdArg !== null && packageIdArg !== '') {
    const packageIdInt = Number(packageIdArg);
    if (!Number.isInteger(packageIdInt) || packageIdInt <= 0) {
      throw AppError.badRequest('package_id must be a positive integer');
    }
    const pkg = await prisma.packages.findUnique({
      where: { id: packageIdInt },
      select: { id: true, package_code: true, fixed_price_minor: true, status: true },
    });
    if (!pkg) throw AppError.badRequest(`package_id ${packageIdInt} not found`);
    if (pkg.status !== 'active') {
      throw AppError.badRequest(`package_id ${packageIdInt} is not active (status=${pkg.status})`);
    }
    resolvedPackageId = pkg.id;
    resolvedPackageCode = resolvedPackageCode ?? pkg.package_code ?? null;
    resolvedPackageEstMinor = resolvedPackageEstMinor ?? pkg.fixed_price_minor ?? null;
  } else if (packageCodeArg) {
    // Allow code-only resolution against the default tenant master.
    const pkg = await prisma.packages.findFirst({
      where: { package_code: String(packageCodeArg), status: 'active' },
      select: { id: true, package_code: true, fixed_price_minor: true },
    });
    if (pkg) {
      resolvedPackageId = pkg.id;
      resolvedPackageCode = pkg.package_code;
      resolvedPackageEstMinor = resolvedPackageEstMinor ?? pkg.fixed_price_minor ?? null;
    }
  }

  // Phase 0 — inherit OPD-captured allergies when the admit call doesn't
  // re-supply them, so converting an OPD record to IPD doesn't silently drop
  // a safety-critical allergy from the chart / prescribing / TPA packet.
  // Mirrors the walk-in registration's allergy resolution: structured
  // patient_allergies UNION the free-text users.allergies column. Best-effort
  // — a lookup failure must never block the admission (defaults to []).
  // Finding: 2026-05-20-tpa-insurance-claim-admission-29d13399.
  let admissionAllergies = Array.isArray(allergies) ? allergies : [];
  if (admissionAllergies.length === 0) {
    try {
      const inherited = await prisma.$queryRawUnsafe(
        `WITH patient_row AS (
           SELECT id, uid, allergies FROM users WHERE uid = $1::uuid LIMIT 1
         ),
         structured AS (
           SELECT allergy_name, severity
             FROM patient_allergies pa
             JOIN patient_row p ON (pa.patient_id = p.id OR pa.patient_uid = p.uid)
            WHERE COALESCE(pa.is_active, TRUE) = TRUE
         ),
         profile AS (
           SELECT trim(value) AS allergy_name, NULL::text AS severity
             FROM patient_row p,
                  regexp_split_to_table(COALESCE(p.allergies, ''), ',') AS value
            WHERE trim(value) <> ''
         )
         SELECT DISTINCT allergy_name, severity
           FROM (SELECT * FROM structured UNION ALL SELECT * FROM profile) a
          ORDER BY allergy_name`,
        patient_uid,
      );
      // admissions.allergies is a text[] column — store allergen names as strings.
      const names = inherited.map((a) => a.allergy_name).filter(Boolean);
      if (names.length) admissionAllergies = names;
    } catch (err) {
      logger.warn(`admitPatient: allergy inheritance failed for patient_uid=${patient_uid}: ${err.message}`);
    }
  }

  let carriedErOrders = [];

  const admission = await prisma.$transaction(async (tx) => {
    // Resolve patient_uid → users.id (beds.patient_id is int FK)
    const patientUser = await tx.users.findUnique({
      where: { uid: patient_uid },
      select: { id: true, name: true, phone: true },
    });
    if (!patientUser) throw AppError.notFound('Patient not found');
    const patientIntId = patientUser.id;
    const patientName = patientUser.name;

    const admission = await tx.admissions.create({
      data: {
        patient_uid,
        admitting_doctor,
        attending_doctor: resolvedAttendingDoctor,
        department: department ?? null,
        ward: ward ?? null,
        bed_id: bed_id ?? null,
        chief_complaint,
        admitting_diagnosis: admitting_diagnosis ?? null,
        admission_type,
        status: 'admitted',
        priority,
        insurance_info: insurance_info ?? null,
        emergency_contact: emergency_contact ?? null,
        allergies: admissionAllergies,
        code_status,
        expected_los_days: expected_los_days ?? null,
        created_by,
        admitted_at: new Date(),
        // ER linkage (migration 170). Both stay null on non-ER admissions.
        from_er_visit_id: erVisit?.id ?? null,
        er_arrival_at: erArrivalAt,
        // Bed-allocation tracker (migration 171). Stamped only when the
        // emergency exception fires; cleared (left as historical) once a
        // bed is assigned via assignBedToAdmission.
        bed_pending_since: bedlessAdmit ? new Date() : null,
        // Agreed room category (migration 177). Drives tariff + TPA pre-auth.
        room_category: resolvedRoomCategory,
        // B-4 — emergency consent bypass tracking (migration 182).
        emergency_consent_bypass_at: emergencyBypass?.at ?? null,
        emergency_consent_bypass_by: emergencyBypass?.by ?? null,
        emergency_consent_bypass_reason: emergencyBypass?.reason ?? null,
        // Wave-4B-1 (migrations 203 + 207) — structured insurance + package links.
        policy_id: resolvedPolicyId,
        package_id: resolvedPackageId,
        package_code: resolvedPackageCode,
        package_estimated_cost_minor: resolvedPackageEstMinor,
        // Stage-5 — govt-scheme eligibility flag (migration 228).
        govt_scheme: resolvedGovtScheme,
        govt_scheme_status: resolvedGovtSchemeStatus,
        // Optional rounding cadence at admit time (migration 229).
        next_review_at: nextReviewAt,
        // Re-admission continuity link (migration 230). Null unless a
        // prior discharge for this patient falls within the 7-day window.
        prior_admission_id: priorAdmissionId,
      },
      select: ADMISSION_RETURNING_SELECT,
    });
    admission.ip_number = formatIpNumber(admission.id, admission.admitted_at);

    // B-4 — audit row when consent was bypassed. The admissions row
    // itself records WHEN/WHO/WHY, but a separate audit_log entry
    // makes the bypass visible in compliance dashboards.
    if (emergencyBypass) {
      await tx.audit_logs.create({
        data: {
          uid: emergencyBypass.by,
          action: 'EMERGENCY_CONSENT_BYPASS',
          resource: 'admissions',
          resource_id: String(admission.id),
          metadata: {
            patient_uid,
            admission_id: admission.id,
            admission_type,
            priority,
            reason: emergencyBypass.reason,
          },
          ip_address: null,
        },
      });
    }

    // Close the ER chart on successful admission. Single open clinical
    // encounter, even though billing stays separate (ER + ward have
    // distinct price tiers). See finding
    // 2026-05-08-emergency-walk-in-doctor-admit-no-er-visit-linkage.
    if (erVisit) {
      await tx.emergency_visits.update({
        where: { id: erVisit.id },
        data: {
          disposition: 'admitted',
          disposition_at: new Date(),
          departure_at: new Date(),
          status: erVisit.status === 'arriving' ? erVisit.status : 'in_treatment',
          updated_at: new Date(),
        },
      });

      carriedErOrders = await carryActiveErOrdersToAdmission(tx, {
        erVisit,
        admission,
        patientUid: patient_uid,
        createdBy: created_by,
      });
    }

    if (bed_id) {
      // FOR UPDATE lock on the bed row to serialise concurrent admits.
      // Prisma typed methods can't issue row locks, so we keep the SELECT
      // raw inside the transaction; the subsequent UPDATE is typed.
      const bedRows = await tx.$queryRaw`
        SELECT id, status, bed_number, bed_type FROM beds WHERE id = ${bed_id} FOR UPDATE
      `;
      if (!bedRows.length) throw AppError.notFound('Bed not found');
      if (bedRows[0].status !== 'available') {
        throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`);
      }
      // Bed-pool match (migration 171). Day-care admissions must allocate
      // a bed from the day_care pool; conversely a day_care bay can only
      // host a day_care admission. Other bed_types stay loose for now
      // (general/icu/private/etc. can mix until a tighter pool model lands).
      if (admission_type === 'day_care' && bedRows[0].bed_type !== 'day_care') {
        throw AppError.badRequest(`Day-care admission requires a day_care bed; bed ${bedRows[0].bed_number} is ${bedRows[0].bed_type ?? 'general'}.`);
      }
      if (bedRows[0].bed_type === 'day_care' && admission_type !== 'day_care') {
        throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is in the day_care pool; ${admission_type} admissions cannot allocate it.`);
      }

      // Bed back-linking. Migration 172. expected_discharge computed from
      // admitted_at + expected_los_days where available. See finding
      // 2026-05-08-inpatient-admission-admission-bed-not-back-linked.
      const expectedDischarge = expected_los_days
        ? new Date(Date.now() + expected_los_days * 86400000)
        : null;
      await tx.beds.update({
        where: { id: bed_id },
        data: {
          status: 'occupied',
          patient_id: patientIntId,
          patient_name: patientName,
          patient_uid,
          admission_id: admission.id,
          admitted_at: new Date(),
          assigned_at: new Date(),
          expected_discharge: expectedDischarge,
          updated_at: new Date(),
        },
      });

      await tx.bed_transfers.create({
        data: {
          patient_uid,
          admission_id: admission.id,
          from_bed_id: null,
          to_bed_id: bed_id,
          reason: 'Admission',
          transferred_by: created_by,
        },
      });

      // Denormalise the allocated bed_number onto the admission row so the
      // admission detail + printable summary surface the physical bed
      // without an extra beds join. The admission.create above fires BEFORE
      // the bed FOR-UPDATE lookup, so bed_number isn't known at insert
      // time; the column is on `admissions` (migration baseline) and is
      // already in ADMISSION_RETURNING_SELECT — it just never got
      // populated. Back-fill here and mirror it onto the in-memory
      // `admission` so the post-tx return shape matches the DB.
      // Findings: 2026-05-22-tpa-insurance-claim-admission-c52e8649,
      //           2026-05-23-emergency-walk-in-admission-b92372d9.
      await tx.admissions.update({
        where: { id: admission.id },
        data: { bed_number: bedRows[0].bed_number, updated_at: new Date() },
      });
      admission.bed_number = bedRows[0].bed_number;
    }

    admission.patient_name = patientName;
    admission.patient_phone = patientUser.phone ?? null;

    await tx.audit_logs.create({
      data: {
        uid: created_by,
        action: 'ADMIT_PATIENT',
        resource: 'admission',
        resource_id: String(admission.id),
        metadata: {
          patient_uid, admission_type, priority, department, ward, bed_id,
          from_er_visit_id: erVisit?.id ?? null,
          er_chief_complaint_inherited: erVisit && !chiefComplaintArg ? true : false,
          er_attending_doctor_inherited: erVisit && !attending_doctor ? true : false,
        },
        ip_address: null,
      },
    });

    if (erVisit) {
      logger.info(`Patient ${patient_uid} admitted from ER visit #${erVisit.id} — admission #${admission.id}, encounter ${admission.encounter_id}`);
    } else if (bedlessAdmit) {
      logger.warn(`Patient ${patient_uid} admitted bedless (emergency exception) — admission #${admission.id}; allocate a bed via /admissions/:id/assign-bed`);
    } else {
      logger.info(`Patient ${patient_uid} admitted — admission #${admission.id}, encounter ${admission.encounter_id}`);
    }

    // Auto-issue 2 attendant passes (architectural item A4 / migration
    // 174). Per project decision 2026-05-09. Pass color snapshotted
    // from the ward at issue. Best-effort — if pass issuance fails,
    // log a warning but don't fail the whole admission.
    try {
      // Look up the ward row by name (ward is a string here, not a FK
      // on admissions). Best-effort — returns null if ward isn't found
      // or wasn't specified, which is fine — pass issuance falls back
      // to default color/screening.
      const wardRow = ward
        ? await tx.wards.findFirst({
            where: { name: ward },
            select: { id: true, name: true },
          })
        : null;
      const passes = await issueDefaultAttendantPasses(tx, {
        admissionId: admission.id,
        patientUid: patient_uid,
        patientName,
        wardId: wardRow?.id ?? null,
        wardName: wardRow?.name ?? ward ?? null,
        issuedBy: created_by,
      });
      logger.info(`Issued ${passes.length} attendant passes for admission #${admission.id}`);
    } catch (e) {
      logger.warn(`admitPatient: attendant-pass issuance failed for admission ${admission.id}: ${e.message}`);
    }

    return admission;
  });

  try {
    const hospitalNumber = await ensureHospitalNumber({
      tenantId: admission.tenant_id || tenant_id || null,
      patientUid: patient_uid,
      createdBy: created_by,
    });
    admission.patient_hospital_number = hospitalNumber;
    admission.hospital_number = hospitalNumber;
  } catch (e) {
    logger.warn(`admitPatient: hospital-number ensure failed for patient ${patient_uid}: ${e.message}`);
  }

  if (carriedErOrders.length) {
    logger.info(
      `admitPatient: carried ${carriedErOrders.length} active ER order(s) ` +
      `from visit #${erVisit?.id} into admission #${admission.id}`,
    );
    for (const order of carriedErOrders) {
      if (order.order_type !== 'medication') continue;
      try {
        await createWardIndentForClinicalMedicationOrder(order);
      } catch (e) {
        logger.warn(`admitPatient: ER medication order indent failed for order ${order.id}: ${e.message}`);
      }
    }
  }

  // Phase 1.5: day-care surgical OT auto-schedule. A day_care admission
  // linked to a surgical package (DC-CATARACT-PHACO, DC-LAP-CHOLE, etc.)
  // implicitly requires an ot_schedules row — without one the bedside
  // nurse can't open the OT board, can't fill the WHO time-out checklist,
  // and same-day discharge stalls. Pre-fix, the nurse had to POST
  // /api/v1/theatre/schedule with the admission details hand-copied
  // before pre-op work could begin. Finding:
  //   2026-05-15-surgical-day-care-nurse-6df19b4a.
  //
  // Runs OUTSIDE the admit tx so a failure here cannot roll back the
  // admission (bed allocation, attendant passes, etc.). Best-effort, log
  // on failure — the manual /theatre/schedule route stays available as
  // the fallback path.
  if (admission.admission_type === 'day_care' && admission.package_code) {
    try {
      await maybeAutoCreateDayCareOtSchedule(admission);
    } catch (e) {
      logger.warn(`admitPatient: day-care OT auto-schedule failed for admission ${admission.id}: ${e.message}`);
    }
  }

  // Phase 1.5: close the OPD→IPD advice loop. The advise-admission bridge
  // (POST /appointments/:id/advise-admission) only stamps
  // appointments.advised_for_admission_at/by/note, and the admission
  // counter's worklist (GET /appointments?advised_for_admission=true)
  // filters purely on that timestamp being non-null. Nothing previously
  // cleared it once the patient was actually admitted, so an admitted OPD
  // patient stayed stuck in the advised-for-admission queue indefinitely.
  // Mark the originating advice fulfilled by nulling the flag columns so
  // the patient drops out of the queue. Scope: the explicit source
  // appointment when the admit carried admission_advice_id/appointment_id
  // (verified to belong to this patient), otherwise every still-open
  // advised appointment for this patient. Best-effort, post-commit — a
  // failure here is logged but must never roll back the admission.
  // Finding: 2026-05-21-inpatient-admission-receptionist-5e965972.
  try {
    let cleared = [];
    if (adviceAppointmentId !== null) {
      // Explicit link. Clear only this appointment, and only if it both
      // belongs to this patient and is currently flagged — so a stale or
      // mismatched id is a no-op rather than wrongly closing someone
      // else's advice.
      cleared = await prisma.$queryRawUnsafe(
        `UPDATE appointments a
            SET advised_for_admission_at = NULL,
                advised_for_admission_by = NULL,
                advised_for_admission_note = NULL,
                updated_at = NOW()
           FROM users u
          WHERE a.id = $1
            AND a.patient_id = u.id
            AND u.uid = $2::uuid
            AND a.advised_for_admission_at IS NOT NULL
        RETURNING a.id`,
        adviceAppointmentId,
        patient_uid,
      );
    } else {
      // No explicit link — clear any still-open advised appointment(s) for
      // this patient. Keyed off users.uid → appointments.patient_id.
      cleared = await prisma.$queryRawUnsafe(
        `UPDATE appointments a
            SET advised_for_admission_at = NULL,
                advised_for_admission_by = NULL,
                advised_for_admission_note = NULL,
                updated_at = NOW()
           FROM users u
          WHERE a.patient_id = u.id
            AND u.uid = $1::uuid
            AND a.advised_for_admission_at IS NOT NULL
        RETURNING a.id`,
        patient_uid,
      );
    }
    if (cleared.length) {
      const clearedIds = cleared.map((r) => r.id);
      logger.info(
        `admitPatient: closed admission-advice for ${clearedIds.length} appointment(s) ` +
        `[${clearedIds.join(', ')}] on admission #${admission.id} (patient ${patient_uid})`,
      );
      // Audit the fulfillment so compliance can reconstruct that this
      // admission consumed the OPD advice. Best-effort, fire-and-forget.
      await prisma.audit_logs.create({
        data: {
          uid: created_by,
          action: 'ADMISSION_ADVICE_FULFILLED',
          resource: 'admission',
          resource_id: String(admission.id),
          metadata: {
            patient_uid,
            admission_id: admission.id,
            cleared_appointment_ids: clearedIds,
            via: adviceAppointmentId !== null ? 'explicit_appointment_id' : 'patient_match',
          },
          ip_address: null,
        },
      }).catch(() => {});
    } else if (adviceAppointmentId !== null) {
      logger.warn(
        `admitPatient: admission_advice_id=${adviceAppointmentId} did not match an open advised ` +
        `appointment for patient ${patient_uid} on admission #${admission.id} — nothing to close`,
      );
    }
  } catch (e) {
    logger.warn(`admitPatient: advice-queue close failed for admission ${admission.id}: ${e.message}`);
  }

  // Phase 1.5: TPA pre-auth auto-draft. When the admission has a linked
  // insurance policy and enough clinical info, open a draft pre-auth so
  // the insurance desk can submit it without a second manual step. The
  // clerk was previously forced to switch to POST /insurance/preauth and
  // re-enter policy_id + admission_id by hand, risking SLA miss.
  // Best-effort — failure cannot roll back the admission.
  // Finding: 2026-05-21-tpa-insurance-claim-admission-cea3771d.
  if (resolvedPolicyId && admitting_diagnosis && tenant_id) {
    const costForPreauth = estimated_cost
      ? Number(estimated_cost)
      : (resolvedPackageEstMinor ? Number(resolvedPackageEstMinor) / 100 : null);
    if (costForPreauth && costForPreauth > 0) {
      try {
        const requestType = admission_type === 'emergency' ? 'emergency' : 'planned';
        await createPreauth({
          tenantId: tenant_id,
          policy_id: resolvedPolicyId,
          patient_uid,
          admission_id: admission.id,
          request_type: requestType,
          primary_diagnosis: admitting_diagnosis,
          expected_cost: costForPreauth,
          expected_los_days: expected_los_days ?? null,
          treating_doctor_uid: admitting_doctor,
          created_by,
        });
        logger.info(`admitPatient: preauth draft auto-created for admission ${admission.id}, policy_id=${resolvedPolicyId}`);
      } catch (e) {
        logger.warn(`admitPatient: preauth auto-create failed for admission ${admission.id}: ${e.message}`);
      }
    }
  }

  return admission;
}

// Per finding 2026-05-15-surgical-day-care-nurse-6df19b4a. Spawn an
// ot_schedules row when a day-care admission lands with a surgical
// package code. Idempotent: if an active schedule already exists for
// this admission's patient + procedure today, no new row is created.
//
// Gated on package_code prefix 'DC-' so non-surgical day-care admissions
// (chemo, dialysis, transfusion) don't get a spurious OT booking — the
// nurse on those wards never opens the OT board.
async function maybeAutoCreateDayCareOtSchedule(admission) {
  if (!admission?.package_code || !admission.package_code.toUpperCase().startsWith('DC-')) {
    return null;
  }
  const surgeon = admission.attending_doctor || admission.admitting_doctor;
  if (!surgeon) {
    logger.info(`maybeAutoCreateDayCareOtSchedule: admission ${admission.id} has no attending/admitting doctor — skipping OT auto-schedule`);
    return null;
  }
  // Look up the package's display name + procedure code. The package
  // is in the same tenant the admission already filtered to, so no
  // additional tenant gate is needed beyond the strict package_code +
  // status='active' lookup.
  const pkgRow = await prisma.packages.findFirst({
    where: { package_code: admission.package_code, status: 'active' },
    select: { display_name: true, base_procedure_code: true },
  });
  const procedureName = pkgRow?.display_name || admission.package_code;
  const procedureCode = pkgRow?.base_procedure_code || null;

  // Idempotency probe: an OT schedule for this patient + procedure today
  // means a prior call (or a manual POST /theatre/schedule from the
  // nurse) already covered it. Don't double-book.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM ot_schedules
      WHERE patient_uid = $1::uuid
        AND procedure_name = $2
        AND scheduled_date = CURRENT_DATE
        AND COALESCE(status, '') NOT IN ('cancelled')
      LIMIT 1`,
    admission.patient_uid,
    procedureName,
  );
  if (existing.length > 0) {
    logger.info(`maybeAutoCreateDayCareOtSchedule: admission ${admission.id} already has OT schedule ${existing[0].id} — skipping`);
    return existing[0];
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ot_schedules
       (patient_uid, surgeon, procedure_name, procedure_code,
        scheduled_date, status, blood_arranged, consent_obtained,
        created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_DATE,
             'scheduled', false, false, NOW(), NOW())
     RETURNING id`,
    admission.patient_uid,
    surgeon,
    procedureName,
    procedureCode,
  );
  logger.info(`maybeAutoCreateDayCareOtSchedule: created OT schedule ${rows[0].id} for admission ${admission.id} (${procedureName})`);
  return rows[0];
}

/**
 * Assign a bed to an admission that was created bedless under the
 * emergency exception. Writes a bed_transfers row (from_bed_id=null →
 * to_bed_id=N) so the audit trail captures when the bed actually
 * arrived. The admission's bed_pending_since stays as a historical
 * anchor — query (NOW() - bed_pending_since) on bed_transfers.created_at
 * minus admissions.bed_pending_since to get the door-to-bed metric.
 *
 * Migration 171. See finding
 * 2026-05-08-emergency-walk-in-doctor-admit-without-bed-allowed.
 *
 * @param {number} admissionId
 * @param {number} bedId
 * @param {string} assignedBy  uid of the staff member allocating the bed
 * @returns {Object} updated admission
 */
async function assignBedToAdmission(admissionId, bedId, assignedBy) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  if (!bedId) throw AppError.badRequest('bedId is required');
  if (!assignedBy) throw AppError.badRequest('assignedBy is required');

  return prisma.$transaction(async (tx) => {
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, status, bed_id, admission_type, ward, bed_pending_since
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    const admission = admRows[0];
    if (admission.status !== 'admitted') {
      throw AppError.badRequest(`Cannot assign bed — admission is ${admission.status}, not admitted`);
    }
    if (admission.bed_id) {
      throw AppError.conflict(`Admission already has bed ${admission.bed_id} — use /admissions/:id/transfer to move beds`);
    }

    const bedRows = await tx.$queryRaw`
      SELECT id, status, bed_number, bed_type, ward_id, ward_name FROM beds WHERE id = ${bedId} FOR UPDATE
    `;
    if (!bedRows.length) throw AppError.notFound('Bed not found');
    if (bedRows[0].status !== 'available') {
      throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`);
    }
    if (admission.admission_type === 'day_care' && bedRows[0].bed_type !== 'day_care') {
      throw AppError.badRequest(`Day-care admission requires a day_care bed; bed ${bedRows[0].bed_number} is ${bedRows[0].bed_type ?? 'general'}.`);
    }
    if (bedRows[0].bed_type === 'day_care' && admission.admission_type !== 'day_care') {
      throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is in the day_care pool; ${admission.admission_type} admissions cannot allocate it.`);
    }

    const patientUser = await tx.users.findUnique({
      where: { uid: admission.patient_uid },
      select: { id: true, name: true },
    });

    // Pull expected_los_days off the admission so we can populate
    // beds.expected_discharge here too. Migration 172.
    const admDetail = await tx.admissions.findUnique({
      where: { id: admissionId },
      select: { expected_los_days: true, admitted_at: true },
    });
    const expectedDischarge = admDetail?.expected_los_days
      ? new Date((admDetail.admitted_at?.getTime() ?? Date.now()) + admDetail.expected_los_days * 86400000)
      : null;

    await tx.beds.update({
      where: { id: bedId },
      data: {
        status: 'occupied',
        patient_id: patientUser?.id ?? null,
        patient_name: patientUser?.name ?? null,
        patient_uid: admission.patient_uid,
        admission_id: admissionId,
        admitted_at: new Date(),
        assigned_at: new Date(),
        expected_discharge: expectedDischarge,
        updated_at: new Date(),
      },
    });

    const updatedAdmission = await tx.admissions.update({
      where: { id: admissionId },
      data: {
        bed_id: bedId,
        bed_number: bedRows[0].bed_number,
        ward: bedRows[0].ward_name ?? admission.ward,
        updated_at: new Date(),
        // bed_pending_since deliberately preserved as the historical
        // anchor for SLA reports.
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.bed_transfers.create({
      data: {
        patient_uid: admission.patient_uid,
        admission_id: admissionId,
        from_bed_id: null,
        to_bed_id: bedId,
        reason: 'Bed allocated to bedless emergency admission',
        transferred_by: assignedBy,
      },
    });

    await relocateActiveAttendantPasses(tx, {
      admissionId,
      wardId: bedRows[0].ward_id ?? null,
      wardName: bedRows[0].ward_name ?? admission.ward ?? null,
    });

    await tx.audit_logs.create({
      data: {
        uid: assignedBy,
        action: 'ASSIGN_BED_TO_ADMISSION',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          bed_id: bedId,
          bed_number: bedRows[0].bed_number,
          bed_type: bedRows[0].bed_type,
          bed_pending_since: admission.bed_pending_since,
          door_to_bed_minutes: admission.bed_pending_since
            ? Math.round((Date.now() - new Date(admission.bed_pending_since).getTime()) / 60000)
            : null,
        },
        ip_address: null,
      },
    });

    logger.info(`Bed ${bedRows[0].bed_number} (id=${bedId}) assigned to admission #${admissionId} (was bedless since ${admission.bed_pending_since})`);
    return updatedAdmission;
  });
}

// Default work items opened at mark-for-discharge. Final discharge is
// blocked until these are completed, so the bedside "Discharge" action
// starts the real hospital pathway instead of silently freeing the bed.
const DEFAULT_DISCHARGE_CONSULTS = [
  'dietary',
  'family_counselling',
  'pharmacy',
  'physiotherapy',
  'billing',
];

const DISCHARGE_WORK_ITEM_META = {
  dietary: {
    label: 'Dietary review',
    owner_label: 'Dietitian',
    completion_label: 'Dietary advice finished',
    roles: ['DIETITIAN', 'DIETARY_STAFF'],
  },
  family_counselling: {
    label: 'Family counselling',
    owner_label: 'Family counselling',
    completion_label: 'Family counselling finished',
    roles: ['IPD_COUNSELLOR', 'COUNSELLOR', 'SOCIAL_WORKER', 'CARE_COORDINATOR'],
  },
  pharmacy: {
    label: 'Pharmacy handover',
    owner_label: 'Pharmacy',
    completion_label: 'Discharge drugs handed over',
    roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST'],
  },
  physiotherapy: {
    label: 'Physiotherapy review',
    owner_label: 'Physiotherapist',
    completion_label: 'Physiotherapy advice finished',
    roles: ['PHYSIOTHERAPIST'],
  },
  billing: {
    label: 'Billing clearance',
    owner_label: 'Billing',
    completion_label: 'Final bill reconciled',
    roles: ['BILLING_STAFF', 'BILLING_INCHARGE', 'FINANCE_INCHARGE', 'INSURANCE_COORDINATOR'],
  },
};

const DISCHARGE_WORK_ITEM_OVERRIDE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function normalizeConsultType(consultType) {
  return String(consultType || '').trim().toLowerCase();
}

function getWorkItemMeta(consultType) {
  return DISCHARGE_WORK_ITEM_META[normalizeConsultType(consultType)] || {
    label: String(consultType || 'Discharge task').replace(/_/g, ' '),
    owner_label: 'Hospital team',
    completion_label: 'Task finished',
    roles: [],
  };
}

function canCompleteDischargeWorkItem(consultType, role) {
  const normalizedRole = normalizeRole(role);
  if (DISCHARGE_WORK_ITEM_OVERRIDE_ROLES.has(normalizedRole)) return true;
  const meta = getWorkItemMeta(consultType);
  return meta.roles.includes(normalizedRole);
}

/**
 * Compute the attending-doctors snapshot from clinical_notes authored
 * during the admission. Each round / progress note records its author,
 * so the doctors who actually saw the patient are the union of those
 * authors. Returns a JSON-serializable array of:
 *   { uid, name, designation, first_seen_at, last_seen_at, note_count }
 *
 * Best-effort: if the notes table is empty or join fails, returns an
 * empty array so the discharge cascade doesn't block on it.
 */
async function buildAttendingDoctorsSnapshot(encounterId) {
  if (!encounterId) return [];
  try {
    const rows = await prisma.$queryRaw`
      SELECT cn.author_uid AS uid,
             u.name AS name,
             d.specialty AS designation,
             MIN(cn.created_at) AS first_seen_at,
             MAX(cn.created_at) AS last_seen_at,
             COUNT(cn.id)::int AS note_count
        FROM clinical_notes cn
        LEFT JOIN users u ON u.uid = cn.author_uid
        LEFT JOIN doctors d ON d.user_id = u.id
       WHERE cn.encounter_id = ${encounterId}
         AND cn.author_uid IS NOT NULL
         AND cn.author_role IN ('DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT')
       GROUP BY cn.author_uid, u.name, d.specialty
       ORDER BY MIN(cn.created_at) ASC
    `;
    return rows.map((r) => ({
      uid: r.uid,
      name: r.name ?? null,
      designation: r.designation ?? null,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      note_count: r.note_count,
    }));
  } catch (err) {
    logger.warn(`buildAttendingDoctorsSnapshot failed for encounter=${encounterId}: ${err.message}`);
    return [];
  }
}

async function ensureDefaultDischargeConsults(admissionId, requestedBy = null, existingAdmission = null) {
  const admission = existingAdmission || await prisma.admissions.findUnique({
    where: { id: Number(admissionId) },
    select: {
      id: true,
      patient_uid: true,
      discharge_initiated_at: true,
    },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  if (!admission.discharge_initiated_at) return [];

  const now = new Date();
  return Promise.all(
    DEFAULT_DISCHARGE_CONSULTS.map((consultType) =>
      prisma.discharge_consults.upsert({
        where: {
          admission_id_consult_type: {
            admission_id: Number(admissionId),
            consult_type: consultType,
          },
        },
        create: {
          admission_id: Number(admissionId),
          patient_uid: admission.patient_uid,
          consult_type: consultType,
          requested_at: now,
          requested_by: requestedBy,
        },
        update: {},
      }),
    ),
  );
}

async function assertBillingReadyForCompletion(admissionId) {
  const finalizedRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c
       FROM billing_invoices
      WHERE admission_id = $1::int
        AND status IN ('ISSUED', 'PARTIAL', 'PAID')`,
    Number(admissionId),
  );
  if ((finalizedRows[0]?.c ?? 0) === 0) {
    throw AppError.badRequest(
      'Billing clearance cannot be finished until a finalized IPD invoice exists.',
      'DISCHARGE_BILLING_INVOICE_REQUIRED',
    );
  }

  const unpaid = await prisma.$queryRawUnsafe(
    `SELECT id,
            COALESCE(invoice_number, 'DRAFT-' || id::text) AS invoice_number,
            status,
            amount_due AS balance
       FROM billing_invoices
      WHERE admission_id = $1::int
        AND COALESCE(status, '') NOT IN ('PAID', 'VOID', 'paid', 'written_off', 'cancelled')
        AND COALESCE(amount_due, 0) > 0
      ORDER BY id
      LIMIT 5`,
    Number(admissionId),
  );
  if (unpaid.length > 0) {
    throw AppError.badRequest(
      `Billing clearance cannot be finished while invoice balance is pending: ${unpaid
        .map((i) => `${i.invoice_number} [${i.status}]`)
        .join(', ')}.`,
      'DISCHARGE_BILLING_BALANCE_PENDING',
    );
  }
}

async function assertPharmacyReadyForCompletion(admissionId) {
  const admission = await prisma.admissions.findUnique({
    where: { id: Number(admissionId) },
    select: { discharge_drugs_dispensed_at: true },
  });
  if (!admission?.discharge_drugs_dispensed_at) {
    throw AppError.badRequest(
      'Pharmacy handover cannot be finished until discharge drugs are marked dispensed.',
      'DISCHARGE_DRUGS_NOT_DISPENSED',
    );
  }
}

async function listDischargeWorkItems(admissionId, actorRole = null) {
  await ensureDefaultDischargeConsults(admissionId);
  const rows = await prisma.discharge_consults.findMany({
    where: { admission_id: Number(admissionId) },
    orderBy: [{ requested_at: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => {
    const meta = getWorkItemMeta(row.consult_type);
    return {
      ...row,
      label: meta.label,
      owner_label: meta.owner_label,
      completion_label: meta.completion_label,
      required_roles: meta.roles,
      status: row.completed_at ? 'completed' : 'pending',
      actor_can_complete: canCompleteDischargeWorkItem(row.consult_type, actorRole) && !row.completed_at,
    };
  });
}

/**
 * Mark an admission for discharge. This is the FIRST step of the
 * discharge cascade. The actual dischargePatient (T4 = patient left
 * the hospital) happens later via the existing /discharge endpoint
 * once the summary is signed and drugs are dispensed.
 *
 * Atomic side effects (single transaction):
 *   1. Stamp admissions.discharge_initiated_at (T0)
 *   2. Stamp admissions.billing_closed_at (soft freeze — no new items
 *      should be added; cashier UI shows "billing closed")
 *   3. Open default discharge work items (dietary, family counselling,
 *      pharmacy, physiotherapy, billing) so those roles are pinged.
 *      T0→completed_at is the efficiency
 *      marker for each consult.
 *   4. If admission has insurance_info or any active insurance_claim
 *      for this patient, open a placeholder final claim
 *      (stage='final', amount=0; TPA desk fills in actual amount
 *      from the closed bill).
 *   5. Audit log entry.
 *
 * After the transaction commits, generateDischargeSummary is invoked
 * to produce the draft summary. The attending_doctors_snapshot is
 * stitched into the saved clinical_notes content as a separate update
 * so the snapshot reflects every doctor who entered notes during the
 * admission, not just the admitting consultant.
 *
 * Per project decision 2026-05-09. Architectural item D2.
 *
 * @param {number} admissionId
 * @param {string} requestedBy uid of the staff member marking discharge
 * @param {string|null} requestedByRole role of the staff member marking discharge
 * @returns {{ admission: Object, summary: Object|null, consults: Array, finalClaim: Object|null, attending_doctors: Array }}
 */
async function markForDischarge(admissionId, requestedBy, requestedByRole = null) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  if (!requestedBy) throw AppError.badRequest('requestedBy is required');

  // Phase 1: tx-bounded state changes (stamp markers, open consults).
  // The TPA final-claim placeholder used to live here too, wrapped in
  // an inner try/catch. That pattern was unsafe — any Prisma error
  // inside the tx callback (FK violation, unique conflict, validation)
  // leaves the underlying Postgres transaction in an aborted state.
  // The inner catch swallows the JS exception, but the next `tx.X.Y()`
  // call inside the same `$transaction` block then fails with
  // "current transaction is aborted, commands ignored until end of
  // transaction block" — surfacing as a generic 500. Findings:
  //   2026-05-10-tpa-insurance-claim-discharge-cascade-500
  //   2026-05-10-inpatient-admission-discharge-mark-for-discharge-500
  // The final-claim opening is best-effort by design (TPA desk
  // ultimately fills the amount once the bill closes), so it now runs
  // OUTSIDE the transaction after Phase 1 commits.
  const phase1 = await prisma.$transaction(async (tx) => {
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, status, encounter_id, insurance_info,
             discharge_initiated_at, billing_closed_at
        FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    const admission = admRows[0];

    if (!['admitted', 'transferred'].includes(admission.status)) {
      throw AppError.badRequest(`Cannot mark for discharge — admission is ${admission.status}`);
    }
    if (admission.discharge_initiated_at) {
      throw AppError.conflict(`Admission already marked for discharge at ${admission.discharge_initiated_at.toISOString?.() ?? admission.discharge_initiated_at}`);
    }

    const now = new Date();
    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: {
        discharge_initiated_at: now,
        billing_closed_at: now,
        updated_at: now,
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    // Open default consults — one per consult_type. UNIQUE
    // (admission_id, consult_type) prevents duplicates if this
    // function is somehow called twice.
    const consults = await Promise.all(
      DEFAULT_DISCHARGE_CONSULTS.map((consultType) =>
        tx.discharge_consults.upsert({
          where: { admission_id_consult_type: { admission_id: admissionId, consult_type: consultType } },
          create: {
            admission_id: admissionId,
            patient_uid: admission.patient_uid,
            consult_type: consultType,
            requested_at: now,
            requested_by: requestedBy,
          },
          update: {},
        }),
      ),
    );

    await tx.audit_logs.create({
      data: {
        uid: requestedBy,
        action: 'MARK_FOR_DISCHARGE',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          patient_uid: admission.patient_uid,
          consults_opened: consults.map((c) => c.consult_type),
          billing_closed_at: now.toISOString(),
        },
        ip_address: null,
      },
    });

    return {
      admission: updated,
      encounter_id: admission.encounter_id,
      patient_uid: admission.patient_uid,
      insurance_info: admission.insurance_info,
      consults,
      now,
    };
  });

  // Phase 1.5: TPA final-claim placeholder — runs OUTSIDE the
  // transaction so a failure here can't poison the cascade. Best-
  // effort: if the lookup finds no parent claim or the insert fails,
  // log + continue with finalClaim=null. The TPA desk can still open
  // the final claim manually.
  let finalClaim = null;
  try {
    const existingTpaFinal = await prisma.$queryRawUnsafe(
      `SELECT *
         FROM tpa_claims
        WHERE admission_id = $1::int
          AND stage = 'final'
          AND status <> 'cancelled'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      Number(admissionId),
    );
    if (existingTpaFinal.length) {
      finalClaim = existingTpaFinal[0];
    }

    if (!finalClaim) {
      const activePreauthRows = await prisma.$queryRawUnsafe(
        `SELECT id, tenant_id, policy_id, patient_uid, admission_id,
                request_type, parent_preauth_id, status
           FROM insurance_preauth
          WHERE admission_id = $1::int
            AND status NOT IN ('cancelled','lapsed','denied')
          ORDER BY
            CASE WHEN status IN ('approved','partially_approved') THEN 0 ELSE 1 END,
            CASE WHEN request_type = 'enhancement' THEN 0 ELSE 1 END,
            created_at DESC,
            id DESC
          LIMIT 1`,
        Number(admissionId),
      );
      const activePreauth = activePreauthRows[0];
      if (activePreauth) {
        const invoiceRows = await prisma.$queryRawUnsafe(
          `SELECT id, total_amount
             FROM billing_invoices
            WHERE admission_id = $1::int
              AND patient_uid = $2::uuid
              AND status IN ('ISSUED','PARTIAL','PAID')
            ORDER BY issued_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
            LIMIT 1`,
          Number(admissionId),
          activePreauth.patient_uid,
        );
        const invoice = invoiceRows[0];
        const totalBilled = Number(invoice?.total_amount ?? 0);
        if (invoice && totalBilled > 0) {
          finalClaim = await createTpaClaim({
            tenantId: activePreauth.tenant_id,
            policy_id: activePreauth.policy_id,
            preauth_id: activePreauth.id,
            invoice_id: invoice.id,
            patient_uid: activePreauth.patient_uid,
            admission_id: Number(admissionId),
            claim_type: 'cashless',
            total_billed: totalBilled,
            claimed_amount: totalBilled,
            notes: 'Prepared automatically when discharge was initiated',
            created_by: requestedBy,
            stage: 'final',
          });
        } else {
          logger.warn(
            `markForDischarge: active TPA preauth found for admission ${admissionId} but no bill total; skipping final claim`,
          );
        }
      }
    }

    const hasInsurance =
      finalClaim != null ||
      phase1.insurance_info != null
      || (await prisma.insurance_claims.count({
        where: { patient_uid: phase1.patient_uid, status: { not: 'paid' } },
      })) > 0;
    if (hasInsurance && !finalClaim) {
      const parent = await prisma.insurance_claims.findFirst({
        where: {
          patient_uid: phase1.patient_uid,
          stage: { in: ['preauth', 'enhancement'] },
        },
        orderBy: [{ submitted_at: 'desc' }],
      });
      if (parent) {
        const existingFinal = await prisma.insurance_claims.count({
          where: { parent_claim_id: parent.id, stage: 'final' },
        });
        const finalNumber = `${parent.claim_number}-F${existingFinal + 1}`;
        finalClaim = await prisma.insurance_claims.create({
          data: {
            claim_number: finalNumber,
            patient_uid: parent.patient_uid,
            invoice_id: parent.invoice_id,
            insurance_provider: parent.insurance_provider,
            policy_number: parent.policy_number,
            claim_amount: 0, // placeholder — TPA desk updates with consolidated bill total
            status: 'submitted',
            stage: 'final',
            parent_claim_id: parent.id,
            documents: {
              final: {
                opened_by: requestedBy,
                opened_at: phase1.now.toISOString(),
                trigger: 'discharge_initiated',
              },
            },
            submitted_at: phase1.now,
            updated_at: phase1.now,
          },
        });
      } else {
        logger.warn(
          `markForDischarge: insurance flagged but no parent claim found for patient ${phase1.patient_uid}; skipping final claim`,
        );
      }
    }
  } catch (e) {
    logger.warn(`markForDischarge: final claim creation failed (continuing): ${e.message}`);
  }

  // Phase 2: generate the draft summary (outside the txn — LLM call).
  // If this fails, T0 is already stamped + consults opened — the doctor
  // can manually generate via the existing /discharge-summary/generate
  // endpoint. We surface the failure in the response so the caller knows
  // the cascade partially succeeded.
  let summary = null;
  let attendingDoctors = [];
  try {
    summary = await generateDischargeSummary(admissionId, requestedBy, null);
    await saveDischargeSummary(
      admissionId,
      summary,
      requestedBy,
      normalizeRole(requestedByRole) || 'SYSTEM',
    );
    attendingDoctors = await buildAttendingDoctorsSnapshot(phase1.encounter_id);

    // Stitch the attending-doctors snapshot into the just-created
    // clinical_notes draft so the summary header reflects every doctor
    // who saw the patient. Best-effort — if the find fails, the
    // snapshot is still on the response and can be re-applied later.
    if (attendingDoctors.length > 0) {
      const note = await prisma.clinical_notes.findFirst({
        where: { encounter_id: phase1.encounter_id, note_type: 'discharge', is_addendum: false },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
        select: { id: true, content: true, is_signed: true },
      });
      if (note && !note.is_signed) {
        const baseContent = (note.content && typeof note.content === 'object' && !Array.isArray(note.content))
          ? note.content
          : {};
        await prisma.clinical_notes.update({
          where: { id: note.id },
          data: {
            content: { ...baseContent, attending_doctors_snapshot: attendingDoctors },
            updated_at: new Date(),
          },
        });
      }
    }
  } catch (err) {
    logger.warn(`markForDischarge: draft summary generation failed for admission=${admissionId}: ${err.message}`);
  }

  logPhiAccess({
    userId: requestedBy,
    patientId: phase1.patient_uid,
    recordType: 'admission',
    action: 'MARK_FOR_DISCHARGE',
  });

  logger.info(`Admission ${admissionId} marked for discharge by ${requestedBy} — consults: ${phase1.consults.map((c) => c.consult_type).join(', ')}, final claim: ${finalClaim?.claim_number ?? 'none'}`);

  return {
    admission: phase1.admission,
    summary,
    consults: phase1.consults,
    finalClaim,
    attending_doctors: attendingDoctors,
  };
}

/**
 * Log a discharge consult as completed. Used by dietician, family
 * counselling, pharmacy, physiotherapy, billing, etc. roles to record
 * that they've finished their discharge hand-off for the patient.
 * T0 → completed_at is the efficiency marker for each consult type.
 * Architectural item D2.
 */
async function completeDischargeConsult(admissionId, consultType, completedBy, notes = null, options = {}) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  const normalizedConsultType = normalizeConsultType(consultType);
  if (!normalizedConsultType) throw AppError.badRequest('consultType is required');
  if (!completedBy) throw AppError.badRequest('completedBy is required');

  if (options.role && !canCompleteDischargeWorkItem(normalizedConsultType, options.role)) {
    throw AppError.forbidden(
      `${getWorkItemMeta(normalizedConsultType).owner_label} role is required to finish this discharge work item`,
      'DISCHARGE_WORK_ITEM_ROLE_REQUIRED',
    );
  }

  await ensureDefaultDischargeConsults(admissionId);
  if (normalizedConsultType === 'billing') {
    await assertBillingReadyForCompletion(admissionId);
  }
  if (normalizedConsultType === 'pharmacy') {
    await assertPharmacyReadyForCompletion(admissionId);
  }

  const existing = await prisma.discharge_consults.findUnique({
    where: {
      admission_id_consult_type: {
        admission_id: Number(admissionId),
        consult_type: normalizedConsultType,
      },
    },
  });
  if (!existing) {
    throw AppError.notFound(`Discharge work item not found: ${normalizedConsultType}`);
  }
  if (existing.completed_at) {
    return existing;
  }

  const updated = await prisma.discharge_consults.update({
    where: {
      admission_id_consult_type: {
        admission_id: Number(admissionId),
        consult_type: normalizedConsultType,
      },
    },
    data: {
      completed_at: new Date(),
      completed_by: completedBy,
      notes: notes ?? null,
      updated_at: new Date(),
    },
  });

  await prisma.audit_logs.create({
    data: {
      uid: completedBy,
      action: 'COMPLETE_DISCHARGE_CONSULT',
      resource: 'discharge_consult',
      resource_id: String(updated.id),
      metadata: { admission_id: admissionId, consult_type: normalizedConsultType },
      ip_address: null,
    },
  });

  logger.info(`Discharge consult ${normalizedConsultType} completed for admission ${admissionId} by ${completedBy}`);
  return updated;
}

async function hasDischargeMedicationEvidence(admission) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT EXISTS (
        SELECT 1
          FROM e_prescriptions ep
          JOIN pharmacy_orders po ON po.id = ep.pharmacy_order_id
         WHERE ep.admission_id = $1::int
           AND ep.patient_uid = $2::uuid
           AND po.dispensed_at IS NOT NULL
           AND po.dispensed_by IS NOT NULL
           AND LOWER(po.status) IN ('dispensed', 'delivered')
           AND (
             $3::timestamptz IS NULL
             OR po.dispensed_at >= $3::timestamptz
           )
      ) OR EXISTS (
        SELECT 1
          FROM clinical_ai_workflow_runs wr
         WHERE wr.admission_id = $1::int
           AND wr.patient_uid = $2::uuid
           AND (
             wr.module_key = 'medication_reconciliation'
             OR wr.workflow_key = 'medication_reconciliation'
             OR wr.workflow_key = 'discharge_summary_compose'
           )
           AND wr.status IN ('completed', 'complete', 'finalized', 'reviewed')
      ) OR EXISTS (
        SELECT 1
          FROM admissions a
         WHERE a.id = $1::int
           AND a.patient_uid = $2::uuid
           AND a.discharge_summary IS NOT NULL
           AND (
             a.discharge_summary ? 'medication_reconciliation'
             OR a.discharge_summary ? 'med_rec'
             OR a.discharge_summary ? 'medications_on_discharge'
           )
      ) AS has_evidence`,
    admission.id,
    admission.patient_uid,
    admission.discharge_initiated_at,
  );
  return rows[0]?.has_evidence === true;
}

/**
 * Stamp admissions.discharge_drugs_dispensed_at = T3. Called by the
 * pharmacy module when discharge takeaway drugs are dispensed.
 * Architectural item D2.
 *
 * Defensive shape: pre-flight the admission lookup so a missing row
 * surfaces as 404 instead of P2025-from-update → 500; require the
 * discharge cascade to be open (T0 stamped) so the marker can't be
 * stamped on an admission that never entered the cascade; idempotent
 * on the timestamp so pharmacy retries from flaky tablets don't 500;
 * audit-log is best-effort so a malformed actor uid doesn't tank the
 * pharmacy hand-off. Findings:
 *   2026-05-10-inpatient-admission-discharge-drugs-dispensed-500
 *   2026-05-10-surgical-day-care-discharge-mark-drugs-dispensed-500
 */
async function markDischargeDrugsDispensed(admissionId, dispensedBy) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  if (!dispensedBy) throw AppError.badRequest('dispensedBy is required');

  const existing = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: {
      id: true,
      patient_uid: true,
      status: true,
      discharge_initiated_at: true,
      discharge_drugs_dispensed_at: true,
    },
  });
  if (!existing) {
    throw AppError.notFound(`Admission ${admissionId} not found`);
  }
  if (!existing.discharge_initiated_at) {
    throw AppError.badRequest(
      `Admission ${admissionId} is not in the discharge cascade. ` +
      'Call POST /admissions/:id/mark-for-discharge first to stamp T0.',
    );
  }

  // Idempotent — pharmacy retries shouldn't re-stamp or re-audit.
  if (existing.discharge_drugs_dispensed_at) {
    const current = await prisma.admissions.findUnique({
      where: { id: admissionId },
      select: ADMISSION_RETURNING_SELECT,
    });
    logger.info(
      `markDischargeDrugsDispensed: admission ${admissionId} already stamped at ${existing.discharge_drugs_dispensed_at.toISOString?.() ?? existing.discharge_drugs_dispensed_at}; returning current state`,
    );
    return current;
  }

  if (!await hasDischargeMedicationEvidence(existing)) {
    throw AppError.badRequest(
      'Discharge drugs cannot be marked dispensed until linked pharmacy dispense or medication-reconciliation evidence exists',
      'DISCHARGE_DRUG_EVIDENCE_REQUIRED',
    );
  }

  const updated = await prisma.admissions.update({
    where: { id: admissionId },
    data: { discharge_drugs_dispensed_at: new Date(), updated_at: new Date() },
    select: ADMISSION_RETURNING_SELECT,
  });

  try {
    await prisma.audit_logs.create({
      data: {
        uid: dispensedBy,
        action: 'MARK_DISCHARGE_DRUGS_DISPENSED',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: { dispensed_at: new Date().toISOString() },
        ip_address: null,
      },
    });
  } catch (auditErr) {
    logger.warn(
      `markDischargeDrugsDispensed: audit log skipped for admission ${admissionId} (${auditErr.message})`,
    );
  }

  logger.info(`Discharge drugs dispensed for admission ${admissionId} by ${dispensedBy}`);
  return updated;
}

function normalizeDischargeType(value = 'home') {
  const normalized = String(value || 'home').trim().toLowerCase();
  if (!VALID_DISCHARGE_TYPES.includes(normalized)) {
    throw AppError.badRequest(`Invalid discharge_type: ${normalized}`);
  }
  return normalized;
}

function buildDischargeReadinessChecklist(blockers, { gated, transitionAllowed }) {
  const blockerTypes = new Set(blockers.map((blocker) => blocker.type));
  const clear = (type) => !blockerTypes.has(type);
  return {
    status_transition_allowed: transitionAllowed,
    gated_discharge_type: gated,
    marked_for_discharge: !gated || clear('NOT_MARKED_FOR_DISCHARGE'),
    discharge_summary_signed: !gated || clear('SUMMARY_NOT_SIGNED'),
    discharge_work_items_completed: !gated || clear('DISCHARGE_CONSULTS_PENDING'),
    discharge_drugs_dispensed: !gated || clear('DRUGS_NOT_DISPENSED'),
    finalized_invoice_exists: !gated || clear('NO_INVOICE'),
    invoice_balance_clear: !gated || clear('UNPAID_INVOICE'),
    investigations_resolved: !gated || clear('PENDING_RESULTS'),
    radiology_resolved: !gated || clear('PENDING_RADIOLOGY'),
    follow_up_booked: !gated || clear('FOLLOWUP_NOT_BOOKED'),
  };
}

async function getDischargeReadiness(admissionId, options = {}) {
  const dischargeType = normalizeDischargeType(options.discharge_type ?? options.dischargeType ?? 'home');
  const dischargeSummary = options.discharge_summary ?? options.dischargeSummary ?? null;
  const admissionPre = options.admissionPre || await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: {
      id: true, patient_uid: true, status: true, encounter_id: true,
      admitted_at: true,
      discharge_initiated_at: true, summary_signed_at: true,
      discharge_drugs_dispensed_at: true,
      billing_closed_at: true,
    },
  });
  if (!admissionPre) throw AppError.notFound('Admission not found');
  if (admissionPre.discharge_initiated_at) {
    await ensureDefaultDischargeConsults(admissionId, null, admissionPre);
  }

  const allowedFromPre = VALID_STATUS_TRANSITIONS[admissionPre.status] || [];
  const transitionAllowed = allowedFromPre.includes('discharged');
  const gated = READINESS_GATED_DISCHARGE_TYPES.has(dischargeType);
  const blockers = [];

  if (!transitionAllowed) {
    blockers.push({
      type: 'INVALID_STATE_TRANSITION',
      message: `Admission is ${admissionPre.status}; final discharge is not allowed from this state.`,
      from: admissionPre.status,
      allowed: allowedFromPre,
    });
  }

  if (gated) {
    // Discharge cascade gates (D2). Require:
    //   - mark-for-discharge already happened (T0 stamped)
    //   - signed summary (T2)
    //   - takeaway drugs dispensed (T3)
    // discharge_summary text in dischargeData is allowed as the
    // legacy free-text path; if the admission has a clinical_notes
    // discharge note that's signed, that satisfies the summary gate.
    if (!admissionPre.discharge_initiated_at) {
      blockers.push({
        type: 'NOT_MARKED_FOR_DISCHARGE',
        message: 'Admission has not been marked for discharge yet. Call POST /admissions/:id/mark-for-discharge first to open the cascade.',
      });
    }
    if (!admissionPre.summary_signed_at) {
      const signedNote = await prisma.clinical_notes.findFirst({
        where: {
          encounter_id: admissionPre.encounter_id ?? undefined,
          note_type: 'discharge',
          is_addendum: false,
          is_signed: true,
        },
        select: { id: true },
      });
      if (!signedNote && (!dischargeSummary || !String(dischargeSummary).trim())) {
        blockers.push({
          type: 'SUMMARY_NOT_SIGNED',
          message: 'Discharge summary must be signed by the doctor before final discharge.',
        });
      }
    }
    if (!admissionPre.discharge_drugs_dispensed_at) {
      blockers.push({
        type: 'DRUGS_NOT_DISPENSED',
        message: 'Discharge takeaway drugs must be dispensed before final discharge. Call POST /admissions/:id/mark-drugs-dispensed when pharmacy hands over.',
      });
    }

    const pendingConsults = await prisma.discharge_consults.findMany({
      where: {
        admission_id: admissionId,
        completed_at: null,
      },
      select: {
        id: true,
        consult_type: true,
        requested_at: true,
      },
      orderBy: [{ requested_at: 'asc' }, { id: 'asc' }],
    });
    if (pendingConsults.length > 0) {
      blockers.push({
        type: 'DISCHARGE_CONSULTS_PENDING',
        message: `Pending discharge work item(s): ${pendingConsults
          .map((c) => String(c.consult_type).replace(/_/g, ' '))
          .join(', ')}.`,
        consults: pendingConsults,
      });
    }

    // Phase 0 readiness probes — these run on plain prisma (not in a tx),
    // so failures bubble as 500. We intentionally do NOT swallow query
    // errors: a schema-drift or column-rename in any of these tables
    // would have silently no-op'd the entire safety gate (finding
    // 2026-05-09-inpatient-admission-discharge-pending-results-gate-silently-skipped),
    // letting a patient be discharged with active investigations,
    // unpaid invoices, or no invoice at all. Fail loud -> fix the drift.

    // No-invoice gate (finding 2026-05-09-inpatient-admission-discharge-no-invoice-bypass,
    // tightened by 2026-05-22-inpatient-admission-discharge-d670b613).
    const finalizedRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c
         FROM billing_invoices
        WHERE admission_id = $1::int
          AND status IN ('ISSUED', 'PARTIAL', 'PAID')`,
      admissionId,
    );
    if ((finalizedRows[0]?.c ?? 0) === 0) {
      blockers.push({
        type: 'NO_INVOICE',
        message: 'No finalized invoice exists for this admission. Issue + collect (or zero out) at least one IPD invoice before discharge. Closing billing alone does not satisfy this - a finalized invoice is required.',
      });
    }

    const unpaid = await prisma.$queryRawUnsafe(
      `SELECT id,
              COALESCE(invoice_number, 'DRAFT-' || id::text) AS invoice_number,
              status,
              amount_due AS balance
         FROM billing_invoices
        WHERE admission_id = $1::int
          AND COALESCE(status, '') NOT IN ('PAID', 'VOID', 'paid', 'written_off', 'cancelled')
          AND COALESCE(amount_due, 0) > 0
        ORDER BY id
        LIMIT 5`,
      admissionId,
    );
    if (unpaid.length > 0) {
      blockers.push({
        type: 'UNPAID_INVOICE',
        message: `Outstanding invoice(s) on this admission: ${unpaid
          .map((i) => `${i.invoice_number} [${i.status}] (₹${i.balance})`)
          .join(', ')}.`,
        invoices: unpaid,
      });
    }

    const pendingResults = await prisma.$queryRawUnsafe(
      `SELECT id FROM investigations
        WHERE patient_uid = $1::uuid
          AND COALESCE(status, '') NOT IN ('COMPLETED', 'CANCELLED', 'completed', 'cancelled')
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        LIMIT 5`,
      admissionPre.patient_uid,
      admissionPre.admitted_at,
    );
    if (pendingResults.length > 0) {
      blockers.push({
        type: 'PENDING_RESULTS',
        message: `${pendingResults.length} pending lab/imaging result(s) tied to this admission. Review or cancel before discharge.`,
        count: pendingResults.length,
      });
    }

    const pendingRadiology = await prisma.radiology_orders.findMany({
      where: {
        patient_uid: admissionPre.patient_uid,
        status: { notIn: ['completed', 'cancelled', 'reported', 'signed_off'] },
        created_at: admissionPre.admitted_at ? { gte: admissionPre.admitted_at } : undefined,
      },
      select: { id: true, modality: true, body_part: true, status: true },
      take: 5,
    });
    if (pendingRadiology.length > 0) {
      blockers.push({
        type: 'PENDING_RADIOLOGY',
        message: `${pendingRadiology.length} pending radiology order(s) (${pendingRadiology
          .map((r) => `${r.modality} ${r.body_part || ''} [${r.status}]`.trim())
          .join(', ')}). Resolve or cancel before discharge.`,
        count: pendingRadiology.length,
        orders: pendingRadiology,
      });
    }

    try {
      const followupRows = await prisma.$queryRawUnsafe(
        `SELECT id, due_at, appointment_id, status
           FROM follow_up_plans
          WHERE patient_uid = $1::uuid
            AND status IN ('open', 'scheduled')
            AND ($2::int IS NULL OR encounter_id IS NULL OR encounter_id = $2::int)
            AND ($3::timestamptz IS NULL OR COALESCE(due_at, created_at) >= $3::timestamptz)
          LIMIT 1`,
        admissionPre.patient_uid,
        Number.isFinite(admissionPre.encounter_id) ? admissionPre.encounter_id : null,
        admissionPre.admitted_at ? new Date(admissionPre.admitted_at).toISOString() : null,
      );
      if (followupRows.length === 0) {
        blockers.push({
          type: 'FOLLOWUP_NOT_BOOKED',
          message: 'Final discharge requires a booked follow-up plan (e.g., POD1 review) for this admission. Create one via POST /admin/follow-ups before final discharge.',
        });
      }
    } catch (e) {
      logger.warn(`Discharge readiness: follow-up check skipped (${e.message})`);
    }
  }

  const checklist = buildDischargeReadinessChecklist(blockers, { gated, transitionAllowed });
  return {
    admission_id: admissionPre.id,
    patient_uid: admissionPre.patient_uid,
    encounter_id: admissionPre.encounter_id,
    discharge_type: dischargeType,
    admission_status: admissionPre.status,
    gated,
    transition_allowed: transitionAllowed,
    ready: transitionAllowed && blockers.length === 0,
    checklist,
    blockers,
    blocker_count: blockers.length,
    rules_authoritative: true,
  };
}

async function getDischargeHub(admissionId, actor = {}) {
  const actorRole = normalizeRole(actor.role);
  const admission = await getAdmissionDetail(admissionId, {
    userId: actor.uid,
    userRole: actorRole,
  });

  const summary = await getLatestDischargeSummary(admissionId);
  const workItems = admission.discharge_initiated_at
    ? await listDischargeWorkItems(admissionId, actorRole)
    : [];
  const readiness = await getDischargeReadiness(admissionId, {
    discharge_summary: summary?.content || null,
  });

  const aiMetadata = summary?.ai_metadata || null;
  const aiStatus = !summary
    ? 'schema_unavailable'
    : aiMetadata?.used_ai === true
      ? 'ai_draft'
      : aiMetadata?.fallback_reason
        ? 'fallback'
        : 'rules_draft';

  return {
    admission,
    discharge_initiated: Boolean(admission.discharge_initiated_at),
    work_items: workItems,
    work_item_counts: {
      total: workItems.length,
      completed: workItems.filter((item) => item.completed_at).length,
      pending: workItems.filter((item) => !item.completed_at).length,
    },
    summary: summary
      ? {
          ...summary,
          ai_status: aiStatus,
          ai_label: aiStatus === 'ai_draft'
            ? 'AI draft - doctor review required'
            : aiStatus === 'fallback'
              ? 'Fallback draft - AI unavailable'
              : 'Rules draft - doctor review required',
          source_citation_count: summary.source_citations?.length || 0,
          safety_flag_count: summary.safety_flags?.length || 0,
        }
      : {
          source: null,
          content: null,
          is_signed: false,
          ai_status: aiStatus,
          ai_label: 'No discharge summary draft yet',
          source_citation_count: 0,
          safety_flag_count: 0,
        },
    readiness,
    actor: {
      uid: actor.uid || null,
      role: actorRole || null,
      can_edit_summary: canEditDischargeSummary(actorRole) || actorRole === 'SUPER_ADMIN',
      can_sign_summary: canSignDischargeSummary(actorRole) || actorRole === 'SUPER_ADMIN',
      can_mark_drugs_dispensed: canCompleteDischargeWorkItem('pharmacy', actorRole),
      can_complete_any_work_item: DEFAULT_DISCHARGE_CONSULTS.some((type) =>
        canCompleteDischargeWorkItem(type, actorRole)),
    },
  };
}

async function listDischargeHubAdmissions(actor = {}) {
  const rows = await prisma.admissions.findMany({
    where: {
      discharge_initiated_at: { not: null },
      status: { in: ['admitted', 'transferred'] },
    },
    select: {
      id: true,
      discharge_initiated_at: true,
    },
    orderBy: [
      { discharge_initiated_at: 'asc' },
      { id: 'asc' },
    ],
    take: 100,
  });

  const admissions = await Promise.all(
    rows.map((row) => getDischargeHub(row.id, actor)),
  );

  return {
    admissions,
    count: admissions.length,
  };
}

async function dischargePatient(admissionId, dischargeData, dischargedBy) {
  const { discharge_type, discharge_summary } = dischargeData || {};

  if (!discharge_type) throw AppError.badRequest('discharge_type is required');
  if (!VALID_DISCHARGE_TYPES.includes(discharge_type)) {
    throw AppError.badRequest(`Invalid discharge_type: ${discharge_type}`);
  }
  if (!dischargedBy) throw AppError.badRequest('dischargedBy is required');

  // Pre-flight: load admission state outside any tx. The readiness
  // gate's optional billing/investigations probes used to live INSIDE
  // the $transaction wrapped in try/catch — that pattern poisons the
  // underlying Postgres tx on any inner failure. JS catches the
  // exception, but the tx is now aborted, and the next `tx.*` call
  // inside the same block fails with "current transaction is aborted"
  // → generic 500. Findings:
  //   2026-05-10-inpatient-admission-discharge-final-discharge-500-bed-not-vacated
  //   2026-05-10-surgical-day-care-discharge-final-discharge-500-leaves-bed-occupied
  // The atomic state changes still happen under a FOR UPDATE lock in
  // Phase 1 below; the pre-flight read just feeds the gate.
  const admissionPre = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: {
      id: true, patient_uid: true, status: true, encounter_id: true,
      admitted_at: true,
      discharge_initiated_at: true, summary_signed_at: true,
      discharge_drugs_dispensed_at: true,
      billing_closed_at: true,
    },
  });
  if (!admissionPre) throw AppError.notFound('Admission not found');

  const allowedFromPre = VALID_STATUS_TRANSITIONS[admissionPre.status];
  if (!allowedFromPre || !allowedFromPre.includes('discharged')) {
    throw AppError.invalidTransition(admissionPre.status, 'discharged', allowedFromPre || []);
  }

  // Discharge readiness gate. `lama` (left against medical advice) and
  // `expired` (deceased) bypass the gate by definition; planned home
  // discharges must clear (a) discharge_summary present, (b) no
  // unpaid invoice for this admission, (c) no still-pending lab/imaging
  // results. Explicit `override_readiness_gate: true` lets the
  // discharge counter must complete the checklist before the bed can
  // move to housekeeping. See finding
  // 2026-05-08-tpa-insurance-claim-discharge-no-readiness-gate.
  if (READINESS_GATED_DISCHARGE_TYPES.has(discharge_type)) {
    const readiness = await getDischargeReadiness(admissionId, {
      admissionPre,
      discharge_type,
      discharge_summary,
    });

    if (readiness.blockers.length > 0) {
      const err = AppError.badRequest('Discharge blocked — readiness gate not met. Complete the required discharge work before final discharge.');
      err.code = 'DISCHARGE_NOT_READY';
      err.details = { blockers: readiness.blockers, checklist: readiness.checklist };
      throw err;
    }
  }

  // Phase 1: atomic state changes — flip admission to discharged,
  // vacate the bed (status → cleaning + clear back-links), record the
  // bed transfer audit row, queue the housekeeping ticket, stamp
  // audit_logs. Everything here must succeed or roll back together.
  const phase1 = await prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on the admission to serialise concurrent state changes.
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, bed_id, status, admitted_at
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    const allowedFrom = VALID_STATUS_TRANSITIONS[admission.status];
    if (!allowedFrom || !allowedFrom.includes('discharged')) {
      throw AppError.invalidTransition(admission.status, 'discharged', allowedFrom || []);
    }

    const losDays = computeLos(admission.admitted_at, new Date());
    const targetStatus = discharge_type === 'lama' ? 'lama'
      : discharge_type === 'expired' ? 'expired'
      : 'discharged';

    const updated = await tx.admissions.update({
      where: { id: admission.id },
      data: {
        status: targetStatus,
        discharged_at: new Date(),
        discharge_type,
        discharge_summary: discharge_summary ?? null,
        updated_at: new Date(),
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    let bedTurnover = null;
    if (admission.bed_id) {
      // FOR UPDATE lock on the bed row before handing it to housekeeping.
      const bedCheck = await tx.$queryRaw`
        SELECT id, status, bed_number, ward_name FROM beds WHERE id = ${admission.bed_id} FOR UPDATE
      `;
      if (bedCheck.length && bedCheck[0].status === 'occupied') {
        // Clear ALL denormalized back-link fields on the bed so the
        // bed-board view shows a bed awaiting turnover. Migration 172.
        await tx.beds.update({
          where: { id: admission.bed_id },
          data: {
            status: 'cleaning',
            patient_id: null,
            patient_name: null,
            patient_uid: null,
            admission_id: null,
            admitted_at: null,
            expected_discharge: null,
            updated_at: new Date(),
          },
        });

        await tx.bed_transfers.create({
          data: {
            patient_uid: admission.patient_uid,
            admission_id: admission.id,
            // Pre-batch-55 raw SQL stored from_bed_id == to_bed_id == admission.bed_id
            // for discharge transfers; preserved here so audit history matches.
            from_bed_id: admission.bed_id,
            to_bed_id: admission.bed_id,
            reason: 'Discharge',
            transferred_by: dischargedBy,
          },
        });

        bedTurnover = {
          bed_id: admission.bed_id,
          bed_number: bedCheck[0].bed_number,
          ward_name: bedCheck[0].ward_name,
        };
      }
    }

    await tx.audit_logs.create({
      data: {
        uid: dischargedBy,
        action: 'DISCHARGE_PATIENT',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          discharge_type, los_days: losDays, patient_uid: admission.patient_uid,
        },
        ip_address: null,
      },
    });

    return { updated, losDays, bedTurnover };
  });

  // Phase 1.5: best-effort downstream side effects — housekeeping
  // turnover ticket + attendant-pass expiry. These run OUTSIDE the tx
  // so a failure here cannot leave the discharge tx aborted. Each is
  // wrapped in its own try/catch, log-on-failure.
  //
  // Housekeeping ticket: bed is already flipped to `cleaning` in
  // Phase 1, so the bed-board view shows it as awaiting turnover. The
  // explicit `housekeeping_requests` row is the work item the cleaning
  // staff app + admin dashboard query (mounted at /api/v1/housekeeping
  // — see 3b5ed06e). Pre-fix this row was created INSIDE the tx, so
  // any tx-poison upstream rolled it back along with the bed flip and
  // the cleaning team saw nothing. Finding:
  //   2026-05-09-inpatient-admission-housekeeping-no-ticket-on-discharge.
  if (phase1.bedTurnover) {
    try {
      const { bed_id, bed_number, ward_name } = phase1.bedTurnover;
      const bedLabel = [ward_name, bed_number].filter(Boolean).join(' / ')
        || `Bed ${bed_id}`;
      await createBedCleaningRequest({
        bedId: bed_id,
        requesterUid: dischargedBy,
        trigger: 'final_discharge',
        urgency: 'high',
        description: `Discharge cleaning required for ${bedLabel} after admission #${admissionId}. bed_id=${bed_id}.`,
      });
    } catch (e) {
      logger.warn(`dischargePatient: housekeeping request failed for admission ${admissionId} (continuing): ${e.message}`);
    }
  }

  try {
    const expired = await expireAttendantPassesForAdmission(prisma, admissionId);
    if (expired.count > 0) {
      logger.info(`Expired ${expired.count} attendant pass(es) for admission #${admissionId}`);
    }
  } catch (e) {
    logger.warn(`dischargePatient: attendant-pass expiry failed for admission ${admissionId}: ${e.message}`);
  }

  logger.info(`Admission #${admissionId} discharged (${discharge_type}), LOS ${phase1.losDays} days`);
  return { ...phase1.updated, los_days: phase1.losDays };
}

async function transferPatient(admissionId, toWardId, toBedId, reason, transferredBy) {
  if (!toBedId) throw AppError.badRequest('to_bed_id is required');
  if (!transferredBy) throw AppError.badRequest('transferredBy is required');

  const phase1 = await prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on the admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, bed_id, ward, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    if (!['admitted', 'transferred'].includes(admission.status)) {
      throw AppError.badRequest(`Cannot transfer admission in status: ${admission.status}`);
    }

    const fromBedId = admission.bed_id;

    // FOR UPDATE OF b — lock target bed only (not the joined ward row).
    // The original raw SQL used a LEFT JOIN to fetch the ward name; replaced
    // here with a typed lock-then-include via two queries so the join can be
    // expressed via Prisma.
    const targetBedLocked = await tx.$queryRaw`
      SELECT id, status, bed_number FROM beds WHERE id = ${toBedId} FOR UPDATE
    `;
    if (!targetBedLocked.length) throw AppError.notFound('Target bed not found');
    if (targetBedLocked[0].status !== 'available') {
      throw AppError.badRequest(`Target bed ${targetBedLocked[0].bed_number} is not available (current status: ${targetBedLocked[0].status})`);
    }

    const targetBed = await tx.beds.findUnique({
      where: { id: toBedId },
      select: {
        id: true,
        bed_number: true,
        wards: { select: { name: true } },
      },
    });
    const targetBedNumber = targetBed?.bed_number ?? targetBedLocked[0].bed_number;
    const targetWardName = targetBed?.wards?.name ?? null;

    // Resolve patient int id for beds FK
    const patientUser = await tx.users.findUnique({
      where: { uid: admission.patient_uid },
      select: { id: true, name: true },
    });
    const patientIntId = patientUser?.id ?? null;
    const patientName = patientUser?.name ?? null;

    // Bed back-linking on transfer. Clear from-bed fully and send it
    // through housekeeping before it can be allocated again, then
    // snapshot the admission onto the to-bed.
    // Migration 172. Patients freely move between bed categories
    // mid-admission per project decision (2026-05-09); no category gate.
    if (fromBedId) {
      await tx.beds.update({
        where: { id: fromBedId },
        data: {
          status: 'cleaning',
          patient_id: null,
          patient_name: null,
          patient_uid: null,
          admission_id: null,
          admitted_at: null,
          expected_discharge: null,
          updated_at: new Date(),
        },
      });
    }

    // Pull expected_los_days off the admission so the new bed reflects it.
    const admDetail = await tx.admissions.findUnique({
      where: { id: admissionId },
      select: { expected_los_days: true, admitted_at: true },
    });
    const expectedDischarge = admDetail?.expected_los_days
      ? new Date((admDetail.admitted_at?.getTime() ?? Date.now()) + admDetail.expected_los_days * 86400000)
      : null;

    await tx.beds.update({
      where: { id: toBedId },
      data: {
        status: 'occupied',
        patient_id: patientIntId,
        patient_name: patientName,
        patient_uid: admission.patient_uid,
        admission_id: admissionId,
        admitted_at: new Date(),
        assigned_at: new Date(),
        expected_discharge: expectedDischarge,
        updated_at: new Date(),
      },
    });

    await tx.bed_transfers.create({
      data: {
        patient_uid: admission.patient_uid,
        admission_id: admissionId,
        from_bed_id: fromBedId ?? null,
        to_bed_id: toBedId,
        reason: reason || 'Transfer',
        transferred_by: transferredBy,
      },
    });

    const newWard = toWardId || targetWardName || admission.ward;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: {
        bed_id: toBedId,
        ward: newWard,
        bed_number: targetBedNumber,
        status: 'transferred',
        updated_at: new Date(),
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: transferredBy,
        action: 'TRANSFER_PATIENT',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          from_bed_id: fromBedId, to_bed_id: toBedId, to_ward: newWard, reason,
          patient_uid: admission.patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} transferred: bed ${fromBedId} -> ${toBedId}`);
    return {
      updated,
      bedTurnover: fromBedId ? { bed_id: fromBedId } : null,
    };
  });

  if (phase1.bedTurnover) {
    try {
      await createBedCleaningRequest({
        bedId: phase1.bedTurnover.bed_id,
        requesterUid: transferredBy,
        trigger: 'bed_transfer',
        urgency: 'high',
        description: `Transfer cleaning required after admission #${admissionId} moved to bed ${toBedId}. bed_id=${phase1.bedTurnover.bed_id}.`,
      });
    } catch (e) {
      logger.warn(`transferPatient: housekeeping request failed for admission ${admissionId} (continuing): ${e.message}`);
    }
  }

  return phase1.updated;
}

async function getActiveAdmissions(filters = {}, actor = {}) {
  const { ward, doctor, department, status, review_due } = filters;
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'admitted_at'
  });

  const where = {};
  if (status) {
    where.status = status;
  } else {
    where.status = { in: ACTIVE_ADMISSION_STATUSES };
  }
  if (ward) where.ward = ward;
  if (department) where.department = department;
  if (doctor) {
    where.OR = [
      { admitting_doctor: doctor },
      { attending_doctor: doctor },
    ];
  }
  // Ward-round queue: only admissions whose review time has arrived
  // (next_review_at <= now). Prisma's `lte` already excludes NULLs, so
  // admissions with no review set are left out. Finding
  // 2026-05-08-inpatient-admission-doctor-no-review-after.
  if (review_due === true || review_due === 'true') {
    where.next_review_at = { lte: new Date() };
  }

  const inpatientScope = await resolveInpatientAdmissionScope({ actor, filters });
  const scopedWhere = applyInpatientAdmissionScope(where, inpatientScope.where);

  const [total, rows] = await Promise.all([
    prisma.admissions.count({ where: scopedWhere }),
    prisma.admissions.findMany({
      where: scopedWhere,
      select: {
        id: true,
        tenant_id: true,
        encounter_id: true,
        patient_uid: true,
        admitting_doctor: true,
        attending_doctor: true,
        department: true,
        ward: true,
        bed_id: true,
        bed_number: true,
        chief_complaint: true,
        admitting_diagnosis: true,
        admission_type: true,
        status: true,
        priority: true,
        code_status: true,
        allergies: true,
        admitted_at: true,
        expected_los_days: true,
        next_review_at: true,
      },
      orderBy: { admitted_at: 'desc' },
      take: listQuery.limit,
      skip: listQuery.offset,
    }),
  ]);

  // Enrich with users (patient name/phone) + beds.wards (bed_ward_name) in
  // bulk — avoids the N+1 you'd get with per-row Prisma includes when the
  // FK isn't declared (admissions has no relation to users in the schema).
  const patientUids = Array.from(new Set(rows.map((r) => r.patient_uid).filter(Boolean)));
  const bedIds = Array.from(new Set(rows.map((r) => r.bed_id).filter((id) => id != null)));

  const [patients, beds, hospitalNumbers] = await Promise.all([
    patientUids.length
      ? prisma.users.findMany({
          where: { uid: { in: patientUids } },
          select: { uid: true, name: true, phone: true },
        })
      : [],
    bedIds.length
      ? prisma.beds.findMany({
          where: { id: { in: bedIds } },
          select: { id: true, wards: { select: { name: true } } },
        })
      : [],
    getHospitalNumberMap({ patientUids }),
  ]);

  const patientByUid = new Map(patients.map((p) => [p.uid, p]));
  const bedById = new Map(beds.map((b) => [b.id, b]));

  const minimizePayload = shouldMinimizeInpatientPayload(actor.role);
  const admissions = rows.map((row) => {
    const patient = patientByUid.get(row.patient_uid);
    const bed = row.bed_id != null ? bedById.get(row.bed_id) : null;
    const payload = {
      ...row,
      patient_name: patient?.name ?? null,
      patient_phone: patient?.phone ?? null,
      patient_hospital_number: hospitalNumbers.get(row.patient_uid) ?? null,
      hospital_number: hospitalNumbers.get(row.patient_uid) ?? null,
      bed_ward_name: bed?.wards?.name ?? null,
    };
    return minimizePayload ? minimizeAdmissionPayload(payload) : payload;
  });

  return {
    admissions,
    pagination: buildPagination(total, listQuery.page, listQuery.limit),
    scope: inpatientScope.scope,
  };
}

async function getAdmissionDetail(admissionId, requestContext = {}) {
  const admission = await prisma.admissions.findUnique({
    where: { id: Number(admissionId) },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  if (requestContext.userRole) {
    const inpatientScope = await resolveInpatientAdmissionScope({
      actor: {
        uid: requestContext.userId,
        id: requestContext.actorId,
        role: requestContext.userRole,
        tenantId: requestContext.tenantId || admission.tenant_id,
      },
      filters: { tenantId: requestContext.tenantId || admission.tenant_id },
    });
    const visibleCount = await prisma.admissions.count({
      where: applyInpatientAdmissionScope({ id: Number(admissionId) }, inpatientScope.where),
    });
    if (visibleCount < 1) {
      throw AppError.notFound('Admission not found');
    }
  }

  // Patient + bed/ward + admitting/attending doctor names in parallel.
  // The pre-batch-48 raw SQL joined `staff` on `uid`, but staff has no
  // `uid` (only user_id uuid) — batch 48 fixed that to join `users`,
  // which is what we use here. Doctors are users with role≥DOCTOR; we
  // only need the display name.
  const doctorUids = [admission.admitting_doctor, admission.attending_doctor]
    .filter(Boolean);
  const [patient, bed, doctors, priorAdmission, hospitalNumbers] = await Promise.all([
    admission.patient_uid
      ? prisma.users.findUnique({
          where: { uid: admission.patient_uid },
          select: { name: true, phone: true, gender: true, email: true, birthday: true },
        })
      : null,
    admission.bed_id != null
      ? prisma.beds.findUnique({
          where: { id: admission.bed_id },
          select: { wards: { select: { name: true } } },
        })
      : null,
    doctorUids.length
      ? prisma.users.findMany({
          where: { uid: { in: doctorUids } },
          select: { uid: true, name: true },
        })
      : [],
    // Re-admission continuity (migration 230). When this admission is
    // linked to a prior discharge, surface enough of that admission for
    // the discharge desk / clinicians to see the continuity context.
    admission.prior_admission_id != null
      ? prisma.admissions.findUnique({
          where: { id: admission.prior_admission_id },
          select: {
            id: true,
            encounter_id: true,
            admitted_at: true,
            discharged_at: true,
            discharge_type: true,
            discharge_disposition: true,
            admitting_diagnosis: true,
          },
        })
      : null,
    admission.patient_uid
      ? getHospitalNumberMap({
          tenantId: admission.tenant_id,
          patientUids: [admission.patient_uid],
        })
      : Promise.resolve(new Map()),
  ]);

  const doctorByUid = new Map(doctors.map((d) => [d.uid, d.name]));

  const row = {
    ...admission,
    patient_name: patient?.name ?? null,
    patient_phone: patient?.phone ?? null,
    patient_hospital_number: hospitalNumbers.get(admission.patient_uid) ?? null,
    hospital_number: hospitalNumbers.get(admission.patient_uid) ?? null,
    patient_gender: patient?.gender ?? null,
    patient_email: patient?.email ?? null,
    patient_birthday: patient?.birthday ?? null,
    bed_ward_name: bed?.wards?.name ?? null,
    admitting_doctor_name: admission.admitting_doctor
      ? doctorByUid.get(admission.admitting_doctor) ?? null
      : null,
    attending_doctor_name: admission.attending_doctor
      ? doctorByUid.get(admission.attending_doctor) ?? null
      : null,
  };
  row.los_days = computeLos(row.admitted_at, row.discharged_at);
  // Re-admission continuity (migration 230). prior_admission_id is
  // already on `row` via the spread; attach the resolved prior-admission
  // summary (with its own los_days) when the link is set.
  row.prior_admission = priorAdmission
    ? {
        ...priorAdmission,
        los_days: computeLos(priorAdmission.admitted_at, priorAdmission.discharged_at),
      }
    : null;

  if (requestContext.userId) {
    logPhiAccess({
      userId: requestContext.userId,
      userRole: requestContext.userRole,
      patientId: row.patient_uid,
      recordType: 'admission_detail',
      action: 'VIEW',
      ip: requestContext.ip,
      requestId: requestContext.requestId,
    });
  }

  return shouldMinimizeInpatientPayload(requestContext.userRole)
    ? minimizeAdmissionPayload(row)
    : row;
}

const CASE_SHEET_TEXT_FIELDS = [
  'chief_complaints',
  'history_of_presenting_illness',
  'past_history',
  'past_medical_surgical_history',
  'personal_history',
  'menstrual_pregnancy_history',
  'family_history',
  'allergies',
  'cvs',
  'rs',
  'pa',
  'cns',
  'provisional_diagnosis',
];

const CASE_SHEET_VITAL_FIELDS = [
  'pulse_rate',
  'bp',
  'spo2',
  'cbg',
  'weight',
  'temperature',
];

function normalizeCaseSheet(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const vitals = source.vitals && typeof source.vitals === 'object' && !Array.isArray(source.vitals)
    ? source.vitals
    : {};
  const content = {};

  CASE_SHEET_TEXT_FIELDS.forEach((field) => {
    content[field] = String(source[field] ?? '').trim();
  });

  content.vitals = {};
  CASE_SHEET_VITAL_FIELDS.forEach((field) => {
    content.vitals[field] = String(vitals[field] ?? source[field] ?? '').trim();
  });

  content.updated_at = new Date().toISOString();
  return content;
}

function hasCaseSheetValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return String(value ?? '').trim().length > 0;
}

function caseSheetText(value) {
  return String(value ?? '').trim();
}

function caseSheetContentFromNote(note) {
  return note?.content && typeof note.content === 'object' && !Array.isArray(note.content)
    ? note.content
    : {};
}

function collectCaseSheetChangedFields(previousContent, nextContent) {
  const changed = [];
  CASE_SHEET_TEXT_FIELDS.forEach((field) => {
    const before = caseSheetText(previousContent[field]);
    const after = caseSheetText(nextContent[field]);
    if (before !== after) changed.push({ field, before, after });
  });

  const previousVitals = previousContent.vitals
    && typeof previousContent.vitals === 'object'
    && !Array.isArray(previousContent.vitals)
    ? previousContent.vitals
    : {};
  const nextVitals = nextContent.vitals
    && typeof nextContent.vitals === 'object'
    && !Array.isArray(nextContent.vitals)
    ? nextContent.vitals
    : {};
  CASE_SHEET_VITAL_FIELDS.forEach((field) => {
    const before = caseSheetText(previousVitals[field] ?? previousContent[field]);
    const after = caseSheetText(nextVitals[field] ?? nextContent[field]);
    if (before !== after) changed.push({ field: `vitals.${field}`, before, after });
  });
  return changed;
}

function shouldRouteCaseSheetText(admissionValue, previousCaseSheetValue, nextCaseSheetValue) {
  if (!hasCaseSheetValue(nextCaseSheetValue)) return false;
  if (!hasCaseSheetValue(admissionValue)) return true;
  return hasCaseSheetValue(previousCaseSheetValue)
    && caseSheetText(admissionValue) === caseSheetText(previousCaseSheetValue)
    && caseSheetText(admissionValue) !== caseSheetText(nextCaseSheetValue);
}

function splitCaseSheetAllergies(value) {
  return caseSheetText(value)
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameStringList(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => caseSheetText(item) === caseSheetText(b[index]));
}

function shouldRouteCaseSheetList(admissionValue, previousCaseSheetValue, nextCaseSheetValue) {
  if (!nextCaseSheetValue.length) return false;
  if (!hasCaseSheetValue(admissionValue)) return true;
  const previous = splitCaseSheetAllergies(previousCaseSheetValue);
  return previous.length > 0
    && sameStringList(admissionValue, previous)
    && !sameStringList(admissionValue, nextCaseSheetValue);
}

async function getAdmissionCaseSheet(admissionId, actor = {}) {
  const admission = await getAdmissionDetail(admissionId, {
    userId: actor.uid,
    userRole: actor.role,
  });
  const note = admission.encounter_id
    ? await prisma.clinical_notes.findFirst({
        where: {
          encounter_id: admission.encounter_id,
          note_type: 'case_sheet',
          is_addendum: false,
        },
        select: {
          id: true,
          title: true,
          content: true,
          version: true,
          author_uid: true,
          author_role: true,
          created_at: true,
          updated_at: true,
        },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      })
    : null;

  return {
    admission,
    case_sheet: note
      ? {
          note_id: note.id,
          title: note.title,
          content: note.content && typeof note.content === 'object' && !Array.isArray(note.content)
            ? note.content
            : {},
          version: note.version,
          author_uid: note.author_uid,
          author_role: note.author_role,
          created_at: note.created_at,
          updated_at: note.updated_at,
        }
      : null,
  };
}

async function saveAdmissionCaseSheet(admissionId, caseSheet, savedBy, savedByRole) {
  if (!savedBy) throw AppError.badRequest('savedBy is required');
  if (!savedByRole) throw AppError.badRequest('savedByRole is required');
  const content = normalizeCaseSheet(caseSheet);
  return prisma.$transaction(async (tx) => {
    const admission = await tx.admissions.findUnique({
      where: { id: Number(admissionId) },
      select: {
        id: true,
        encounter_id: true,
        patient_uid: true,
        status: true,
        chief_complaint: true,
        admitting_diagnosis: true,
        allergies: true,
      },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    const existing = admission.encounter_id
      ? await tx.clinical_notes.findFirst({
          where: {
            encounter_id: admission.encounter_id,
            note_type: 'case_sheet',
            is_addendum: false,
          },
          select: { id: true, content: true },
          orderBy: [{ version: 'desc' }, { id: 'desc' }],
        })
      : null;

    const previousContent = caseSheetContentFromNote(existing);
    const noteData = {
      content,
      author_uid: savedBy,
      author_role: savedByRole,
      updated_at: new Date(),
    };

    let result;
    if (existing) {
      const updated = await tx.clinical_notes.update({
        where: { id: existing.id },
        data: {
          ...noteData,
          version: { increment: 1 },
        },
        select: { id: true, version: true },
      });
      result = { note_id: updated.id, version: updated.version, action: 'updated' };
    } else {
      const created = await tx.clinical_notes.create({
        data: {
          encounter_id: admission.encounter_id,
          patient_uid: admission.patient_uid,
          author_uid: savedBy,
          author_role: savedByRole,
          note_type: 'case_sheet',
          title: 'In-hospital admission case sheet',
          content,
          version: 1,
          is_addendum: false,
          is_signed: false,
        },
        select: { id: true, version: true },
      });
      result = { note_id: created.id, version: created.version, action: 'created' };
    }

    const admissionUpdate = { updated_at: new Date() };
    const admissionRoutedFields = {};
    if (shouldRouteCaseSheetText(
      admission.chief_complaint,
      previousContent.chief_complaints,
      content.chief_complaints,
    )) {
      admissionUpdate.chief_complaint = content.chief_complaints;
      admissionRoutedFields.chief_complaint = {
        before: admission.chief_complaint ?? null,
        after: content.chief_complaints,
        mode: hasCaseSheetValue(admission.chief_complaint) ? 'synced_from_case_sheet' : 'seeded_from_case_sheet',
      };
    }
    if (shouldRouteCaseSheetText(
      admission.admitting_diagnosis,
      previousContent.provisional_diagnosis,
      content.provisional_diagnosis,
    )) {
      admissionUpdate.admitting_diagnosis = content.provisional_diagnosis;
      admissionRoutedFields.admitting_diagnosis = {
        before: admission.admitting_diagnosis ?? null,
        after: content.provisional_diagnosis,
        mode: hasCaseSheetValue(admission.admitting_diagnosis) ? 'synced_from_case_sheet' : 'seeded_from_case_sheet',
      };
    }
    const caseAllergies = splitCaseSheetAllergies(content.allergies);
    if (shouldRouteCaseSheetList(admission.allergies, previousContent.allergies, caseAllergies)) {
      admissionUpdate.allergies = caseAllergies;
      admissionRoutedFields.allergies = {
        before: admission.allergies ?? [],
        after: caseAllergies,
        mode: hasCaseSheetValue(admission.allergies) ? 'synced_from_case_sheet' : 'seeded_from_case_sheet',
      };
    }

    if (Object.keys(admissionUpdate).length > 1) {
      await tx.admissions.update({
        where: { id: Number(admissionId) },
        data: admissionUpdate,
        select: { id: true },
      });
    }

    const changedFields = collectCaseSheetChangedFields(previousContent, content);
    await tx.audit_logs.create({
      data: {
        uid: savedBy,
        role: savedByRole,
        action: 'SAVE_ADMISSION_CASE_SHEET',
        resource: 'admission_case_sheet',
        resource_id: String(result.note_id),
        subject_uid: admission.patient_uid,
        metadata: {
          admission_id: Number(admissionId),
          patient_uid: admission.patient_uid,
          note_action: result.action,
          version: result.version,
          changed_fields: changedFields,
          admission_routed_fields: admissionRoutedFields,
          bed_board_sync_policy: 'seed_then_follow_until_manually_edited',
          bed_board_manual_override_detected: {
            chief_complaint: hasCaseSheetValue(admission.chief_complaint)
              && hasCaseSheetValue(previousContent.chief_complaints)
              && caseSheetText(admission.chief_complaint) !== caseSheetText(previousContent.chief_complaints),
            admitting_diagnosis: hasCaseSheetValue(admission.admitting_diagnosis)
              && hasCaseSheetValue(previousContent.provisional_diagnosis)
              && caseSheetText(admission.admitting_diagnosis) !== caseSheetText(previousContent.provisional_diagnosis),
            allergies: hasCaseSheetValue(admission.allergies)
              && splitCaseSheetAllergies(previousContent.allergies).length > 0
              && !sameStringList(admission.allergies, splitCaseSheetAllergies(previousContent.allergies)),
          },
        },
        ip_address: null,
      },
    });

    return {
      ...result,
      admission_routed_fields: admissionRoutedFields,
      case_sheet: content,
    };
  });
}

async function getPatientAdmissionHistory(patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');

  const rows = await prisma.admissions.findMany({
    where: { patient_uid: patientUid },
    select: {
      id: true,
      encounter_id: true,
      admitting_doctor: true,
      attending_doctor: true,
      department: true,
      ward: true,
      bed_id: true,
      bed_number: true,
      chief_complaint: true,
      admitting_diagnosis: true,
      admission_type: true,
      status: true,
      priority: true,
      code_status: true,
      admitted_at: true,
      discharged_at: true,
      discharge_type: true,
      expected_los_days: true,
    },
    orderBy: { admitted_at: 'desc' },
  });

  return rows.map((r) => ({
    ...r,
    ip_number: formatIpNumber(r.id, r.admitted_at),
    los_days: computeLos(r.admitted_at, r.discharged_at),
  }));
}

async function updateCodeStatus(admissionId, codeStatus, updatedBy) {
  if (!VALID_CODE_STATUSES.includes(codeStatus)) {
    throw AppError.badRequest(`Invalid code_status: ${codeStatus}`);
  }
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, code_status, patient_uid, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update code status for a non-active admission');
    }

    const previousStatus = admRows[0].code_status;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: { code_status: codeStatus, updated_at: new Date() },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: updatedBy,
        action: 'UPDATE_CODE_STATUS',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          previous: previousStatus, new: codeStatus, patient_uid: admRows[0].patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} code status changed: ${previousStatus} -> ${codeStatus}`);
    return updated;
  });
}

async function updateAttendingDoctor(admissionId, doctorUid, updatedBy) {
  if (!doctorUid) throw AppError.badRequest('doctor_uid is required');
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  // Same clinical-role gate as the admit path. Without this PATCH
  // /admissions/:id/attending-doctor silently replaces a real
  // attending uid with any uuid — even a patient or HR user — and the
  // discharge-summary signer lookup picks up the bad uid. Finding:
  //   2026-05-22-inpatient-admission-receptionist-06e43c24.
  await assertDoctorUid(doctorUid, 'doctor_uid');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, attending_doctor, patient_uid, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update attending doctor for a non-active admission');
    }

    const previousDoctor = admRows[0].attending_doctor;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: { attending_doctor: doctorUid, updated_at: new Date() },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: updatedBy,
        action: 'UPDATE_ATTENDING_DOCTOR',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          previous_doctor: previousDoctor, new_doctor: doctorUid, patient_uid: admRows[0].patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} attending doctor changed: ${previousDoctor} -> ${doctorUid}`);
    return updated;
  });
}

// Set (or clear) the next ward-round review time on an admission
// (migration 229). The inpatient-admission journey asks the consultant
// to "set review-after" once orders are in — this is the persist path,
// surfaced via PUT /emr/admission/:id/next-review. Pass null to clear.
// Finding 2026-05-08-inpatient-admission-doctor-no-review-after.
async function updateNextReviewAt(admissionId, nextReviewAt, updatedBy) {
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  // null / '' clears the review; anything else must parse to a real date.
  let parsed = null;
  if (nextReviewAt !== undefined && nextReviewAt !== null && nextReviewAt !== '') {
    parsed = new Date(nextReviewAt);
    if (Number.isNaN(parsed.getTime())) {
      throw AppError.badRequest('next_review_at must be a valid timestamp (ISO 8601), or null to clear');
    }
  }

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, next_review_at, patient_uid, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot set a review time for a non-active admission');
    }

    const previous = admRows[0].next_review_at;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: { next_review_at: parsed, updated_at: new Date() },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: updatedBy,
        action: 'UPDATE_NEXT_REVIEW_AT',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          previous: previous ? new Date(previous).toISOString() : null,
          new: parsed ? parsed.toISOString() : null,
          patient_uid: admRows[0].patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} next review set: ${previous ? new Date(previous).toISOString() : 'none'} -> ${parsed ? parsed.toISOString() : 'cleared'}`);
    return updated;
  });
}

async function getAdmissionStats(dateFrom, dateTo) {
  // Date filter for admissions.admitted_at — preserved bounds: [dateFrom, dateTo].
  const admittedAtFilter = {};
  if (dateFrom) admittedAtFilter.gte = new Date(dateFrom);
  if (dateTo) admittedAtFilter.lte = new Date(dateTo);
  const adWhere = Object.keys(admittedAtFilter).length
    ? { admitted_at: admittedAtFilter }
    : {};
  const dischargeWhere = Object.keys(admittedAtFilter).length
    ? { admitted_at: admittedAtFilter, discharge_type: { not: null } }
    : { discharge_type: { not: null } };

  // One scan to compute total/discharged/admitted/transferred counts and
  // avg LOS — Prisma aggregate can't do COUNT FILTER (...) so reduce in JS.
  const [allAdmissions, dischargeGroups, typeGroups, totalBeds, occupiedBeds] = await Promise.all([
    prisma.admissions.findMany({
      where: adWhere,
      select: { status: true, admitted_at: true, discharged_at: true },
    }),
    prisma.admissions.groupBy({
      by: ['discharge_type'],
      where: dischargeWhere,
      _count: { _all: true },
    }),
    prisma.admissions.groupBy({
      by: ['admission_type'],
      where: adWhere,
      _count: { _all: true },
    }),
    prisma.beds.count(),
    prisma.beds.count({ where: { status: 'occupied' } }),
  ]);

  let totalAdmissions = 0;
  let totalDischarged = 0;
  let currentlyAdmitted = 0;
  let currentlyTransferred = 0;
  const losDaysSamples = [];
  for (const a of allAdmissions) {
    totalAdmissions += 1;
    if (['discharged', 'lama', 'expired'].includes(a.status)) totalDischarged += 1;
    if (a.status === 'admitted') currentlyAdmitted += 1;
    if (a.status === 'transferred') currentlyTransferred += 1;
    if (a.discharged_at && a.admitted_at) {
      // Mirror the pre-batch-55 SQL: GREATEST(1, CEIL(epoch / 86400.0)).
      const epochSec = (new Date(a.discharged_at) - new Date(a.admitted_at)) / 1000;
      losDaysSamples.push(Math.max(1, Math.ceil(epochSec / 86400)));
    }
  }
  const avgLosDays = losDaysSamples.length
    ? Math.round((losDaysSamples.reduce((s, v) => s + v, 0) / losDaysSamples.length) * 10) / 10
    : null;

  // Discharge-type breakdown sorted by count desc, drop nulls (the WHERE
  // clause already excludes them but groupBy can still surface a null bucket
  // for empty result sets).
  const dischargeTypeBreakdown = dischargeGroups
    .filter((g) => g.discharge_type != null)
    .map((g) => ({ discharge_type: g.discharge_type, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const admissionTypeBreakdown = typeGroups
    .map((g) => ({ admission_type: g.admission_type, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const occupancyRate = totalBeds > 0
    ? Math.round((occupiedBeds / totalBeds) * 100 * 100) / 100
    : 0;

  return {
    total_admissions: totalAdmissions,
    total_discharged: totalDischarged,
    avg_los_days: avgLosDays,
    currently_admitted: currentlyAdmitted,
    currently_transferred: currentlyTransferred,
    occupancy_rate: occupancyRate,
    total_beds: totalBeds,
    occupied_beds: occupiedBeds,
    discharge_type_breakdown: dischargeTypeBreakdown,
    admission_type_breakdown: admissionTypeBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers used by the /emr/admit route's backwards-compat shim
// (Wave 4B-2). They resolve the staff app's free-text patient_query and
// bed string into the canonical {patient_uid, bed_id} pair before
// calling admitPatient. Kept here (not in the route) so other admission
// flows can reuse them if/when needed.
// ---------------------------------------------------------------------------

async function findPatientByPhoneOrName({ phone, name, tenantId = null }) {
  if (phone) {
    const last10 = String(phone).replace(/\D/g, '').slice(-10);
    return prisma.$queryRawUnsafe(
      `SELECT uid, id, name, phone
         FROM users
        WHERE role = 'PATIENT'
          AND ($4::uuid IS NULL OR tenant_id = $4::uuid)
          AND (
            phone = $1
            OR phone = $2
            OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $3
          )
        LIMIT 2`,
      String(phone),
      `+91${last10}`,
      `%${last10}`,
      tenantId,
    );
  }
  if (name) {
    const q = String(name).trim();
    return prisma.$queryRawUnsafe(
      `SELECT u.uid, u.id, u.name, u.phone
         FROM users u
         LEFT JOIN LATERAL (
           SELECT pi.identifier_value
             FROM patient_identifiers pi
            WHERE pi.tenant_id = u.tenant_id
              AND pi.patient_uid = u.uid
              AND pi.identifier_type IN ('mrn', 'uhid')
              AND pi.status = 'active'
            ORDER BY pi.is_primary DESC,
                     CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                     pi.created_at ASC
            LIMIT 1
         ) hn ON TRUE
        WHERE u.role = 'PATIENT'
          AND ($3::uuid IS NULL OR u.tenant_id = $3::uuid)
          AND (
            u.name ILIKE $1
            OR LOWER(COALESCE(hn.identifier_value, '')) = LOWER($2)
            OR LOWER('VH-' || LPAD(u.id::text, 6, '0')) = LOWER($2)
            OR LOWER(COALESCE(hn.identifier_value, '')) LIKE LOWER($1)
            OR LOWER('VH-' || LPAD(u.id::text, 6, '0')) LIKE LOWER($1)
          )
        ORDER BY CASE
          WHEN LOWER(COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0'))) = LOWER($2) THEN 0
          ELSE 1
        END,
        u.name ASC
        LIMIT 2`,
      `%${q}%`,
      q,
      tenantId,
    );
  }
  return [];
}

async function findBedByLabel(bedLabel, wardLabel = null) {
  if (!bedLabel) return null;
  const trimmed = String(bedLabel).trim();
  // Try exact `bed_number` match first; fall back to ILIKE so
  // "ICU-12" matches "ICU-12" but tolerates suffixes / prefixes.
  const params = [trimmed];
  let where = `bed_number = $1`;
  if (wardLabel && String(wardLabel).trim()) {
    params.push(String(wardLabel).trim());
    where += ` AND ward_name ILIKE $${params.length}`;
  }
  let rows = await prisma.$queryRawUnsafe(
    `SELECT id, bed_number, ward_name, status FROM beds WHERE ${where} LIMIT 2`,
    ...params,
  );
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) return null; // ambiguous

  const ilikeParams = [`%${trimmed}%`];
  let ilikeWhere = `bed_number ILIKE $1`;
  if (wardLabel && String(wardLabel).trim()) {
    ilikeParams.push(`%${String(wardLabel).trim()}%`);
    ilikeWhere += ` AND ward_name ILIKE $${ilikeParams.length}`;
  }
  rows = await prisma.$queryRawUnsafe(
    `SELECT id, bed_number, ward_name, status FROM beds WHERE ${ilikeWhere} LIMIT 2`,
    ...ilikeParams,
  );
  if (rows.length === 1) return rows[0];
  return null;
}

function formatWardLabel(row) {
  const rawName = String(row?.name || '').trim();
  if (!rawName) return '';
  const normalized = rawName.replace(/\s+/g, ' ');
  const floorMap = {
    I: '1',
    II: '2',
    III: '3',
    IV: '4',
    V: '5',
    VI: '6',
  };
  const blockMatch = normalized.match(/^([AB])\s+Block\s+-\s+Floor\s+([IVX]+|\d+)$/i);
  if (blockMatch) {
    const block = blockMatch[1].toUpperCase();
    const floor = floorMap[blockMatch[2].toUpperCase()] || blockMatch[2];
    return `Block ${block} Floor ${floor}`;
  }
  const icuMatch = normalized.match(/^([AB])\s+Block\s+-\s+ICU$/i);
  if (icuMatch) return `Block ${icuMatch[1].toUpperCase()} ICU`;
  return rawName;
}

async function listAdmissionWardOptions() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT w.id, w.name, w.floor, w.total_beds,
           COUNT(b.id)::int AS bed_count,
           COUNT(b.id) FILTER (WHERE b.status = 'available')::int AS available_count,
           COUNT(b.id) FILTER (WHERE b.status = 'occupied')::int AS occupied_count
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id
     GROUP BY w.id, w.name, w.floor, w.total_beds
     ORDER BY
       CASE
         WHEN w.name ILIKE 'A Block%' THEN 1
         WHEN w.name ILIKE 'B Block%' THEN 2
         WHEN w.name ILIKE '%ICU%' THEN 3
         WHEN w.name ILIKE '%ER%' THEN 4
         WHEN w.name ILIKE '%Day%' THEN 5
         ELSE 9
       END,
       w.floor NULLS LAST,
       w.name ASC
  `);

  const options = rows.map((row) => ({
    id: row.id,
    name: row.name,
    label: formatWardLabel(row),
    floor: row.floor,
    total_beds: row.total_beds ?? row.bed_count ?? 0,
    bed_count: row.bed_count ?? 0,
    available_count: row.available_count ?? 0,
    occupied_count: row.occupied_count ?? 0,
    source: 'wards',
  }));

  const hasLabel = (needle) => options.some((option) =>
    String(option.label || option.name || '').toLowerCase().includes(needle)
  );
  if (!hasLabel('icu')) {
    options.push({ id: null, name: 'ICU', label: 'ICU', source: 'fallback' });
  }
  if (!hasLabel('er')) {
    options.push({ id: null, name: 'ER', label: 'ER', source: 'fallback' });
  }
  if (!hasLabel('day')) {
    options.push({ id: null, name: 'Day Care', label: 'Day Care', source: 'fallback' });
  }

  return options;
}

async function listAdmissionBedOptions({ wardId = null, wardLabel = null } = {}) {
  const conditions = [
    "b.status = 'available'",
    'b.patient_uid IS NULL',
    'b.patient_id IS NULL',
    'b.patient_name IS NULL',
    'b.admission_id IS NULL',
    `NOT EXISTS (
      SELECT 1 FROM admissions a
       WHERE a.bed_id = b.id
         AND a.discharged_at IS NULL
    )`,
  ];
  const params = [];
  let idx = 1;

  const parsedWardId = Number.parseInt(wardId, 10);
  if (Number.isFinite(parsedWardId) && parsedWardId > 0) {
    conditions.push(`b.ward_id = $${idx}`);
    params.push(parsedWardId);
    idx++;
  } else {
    const label = String(wardLabel || '').trim();
    const lower = label.toLowerCase();
    if (lower.includes('icu')) {
      conditions.push(`(
        COALESCE(b.ward_name, w.name, '') ILIKE '%icu%'
        OR b.bed_type ILIKE '%icu%'
      )`);
    } else if (lower === 'er' || lower.includes('emergency')) {
      conditions.push(`(
        COALESCE(b.ward_name, w.name, '') ILIKE '% emergency%'
        OR COALESCE(b.ward_name, w.name, '') ILIKE 'emergency%'
        OR b.bed_type IN ('er', 'emergency', 'emergency_room')
      )`);
    } else if (lower.includes('day')) {
      conditions.push(`(
        COALESCE(b.ward_name, w.name, '') ILIKE '%day%'
        OR b.bed_type ILIKE '%day%'
      )`);
    } else if (label) {
      conditions.push(`(
        LOWER(COALESCE(b.ward_name, w.name, '')) = LOWER($${idx})
        OR LOWER(w.name) = LOWER($${idx})
      )`);
      params.push(label);
      idx++;
    }
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT b.id, b.bed_number, b.ward_id, COALESCE(b.ward_name, w.name) AS ward_name,
            b.floor, b.bed_type, b.status, b.notes
       FROM beds b
       LEFT JOIN wards w ON w.id = b.ward_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(b.ward_name, w.name) NULLS LAST, b.bed_number`,
    ...params,
  );

  return rows.map((row) => ({
    id: row.id,
    bed_number: row.bed_number,
    ward_id: row.ward_id,
    ward_name: row.ward_name,
    floor: row.floor,
    bed_type: row.bed_type,
    status: row.status,
    notes: row.notes,
  }));
}

async function lookupAdmissionPatientByPhone({ phone, tenantId = null }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8) {
    throw AppError.badRequest('phone must contain at least 8 digits');
  }

  const matches = await findPatientByPhoneOrName({ phone: digits, tenantId });
  if (matches.length > 1) {
    return {
      lookup_state: 'multiple_matches',
      patient: null,
      matches,
      prior_admissions: [],
      count: matches.length,
      message: 'More than one patient matched this number. Select the patient from lookup.',
    };
  }

  if (!matches.length) {
    return {
      lookup_state: 'new_patient',
      patient: null,
      prior_admissions: [],
      count: 0,
      last_ip_number: null,
      next_ip_number_hint: 'Generated when admission is created',
    };
  }

  const patient = matches[0];
  const hospitalNumber = await ensureHospitalNumber({
    tenantId,
    patientUid: patient.uid,
  });
  const history = await getPatientAdmissionHistory(patient.uid);
  const lastAdmission = history[0] || null;

  return {
    lookup_state: history.length ? 'returning_ip_patient' : 'known_patient_no_prior_ip',
    patient: {
      id: patient.id,
      uid: patient.uid,
      name: patient.name,
      phone: patient.phone,
      hospital_number: hospitalNumber,
    },
    prior_admissions: history,
    count: history.length,
    last_ip_number: lastAdmission?.ip_number || null,
    last_admission: lastAdmission,
    next_ip_number_hint: 'Generated when admission is created',
  };
}

async function createCounterAdmissionPatient({
  phone,
  name,
  tenantId = null,
  createdBy = null,
}) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8) {
    throw AppError.badRequest('patient_phone must contain at least 8 digits for a new admission patient');
  }
  const patientName = String(name || '').trim();
  if (!patientName) {
    throw AppError.badRequest('patient_name is required for a new admission patient');
  }
  const tid = tenantId || null;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, registered_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'PATIENT', true,
             COALESCE($3::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
             NOW(), NOW())
     RETURNING id, uid, name, phone, tenant_id`,
    digits,
    patientName,
    tid,
  );
  const patient = rows[0];
  const hospitalNumber = await ensureHospitalNumber({
    tenantId: patient.tenant_id || tenantId,
    patientUid: patient.uid,
    createdBy,
  });
  return { ...patient, hospital_number: hospitalNumber };
}

async function ensureCounterTreatmentConsent({ patientUid, grantedBy = null }) {
  if (!patientUid) return null;
  const existing = await prisma.patient_consents.findFirst({
    where: {
      patient_uid: patientUid,
      consent_type: 'treatment',
      status: 'active',
    },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.patient_consents.create({
    data: {
      patient_uid: patientUid,
      consent_type: 'treatment',
      granted: true,
      status: 'active',
      granted_at: new Date(),
      granted_by: grantedBy,
      notes: 'Captured at reception admission counter',
    },
    select: { id: true },
  });
}

export default {
  admitPatient,
  assignBedToAdmission,
  // Discharge cascade (D2): mark → consults → drugs → final discharge.
  markForDischarge,
  completeDischargeConsult,
  markDischargeDrugsDispensed,
  getDischargeReadiness,
  getDischargeHub,
  listDischargeHubAdmissions,
  canCompleteDischargeWorkItem,
  getAdmissionCaseSheet,
  saveAdmissionCaseSheet,
  dischargePatient,
  transferPatient,
  getActiveAdmissions,
  getAdmissionDetail,
  getPatientAdmissionHistory,
  updateCodeStatus,
  updateAttendingDoctor,
  updateNextReviewAt,
  getAdmissionStats,
  listAdmissionWardOptions,
  listAdmissionBedOptions,
  lookupAdmissionPatientByPhone,
  createCounterAdmissionPatient,
  ensureCounterTreatmentConsent,
  // Wave 4B-2 — staff-app admit-sheet shim helpers.
  findPatientByPhoneOrName,
  findBedByLabel,
};
