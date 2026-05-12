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
import { generateDischargeSummary } from './dischargeSummaryGenerator.js';
import {
  issueDefaultAttendantPasses,
  expireAttendantPassesForAdmission,
} from '../ipd/ipdSupportService.js';


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
// Mirrors the CHECK on admissions.room_category (migration 177).
const VALID_ROOM_CATEGORIES = ['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care'];

// Columns returned by the pre-batch-55 `RETURNING` clause. Mirrored as
// a Prisma `select` so the public response shape is unchanged.
const ADMISSION_RETURNING_SELECT = {
  id: true,
  encounter_id: true,
  patient_uid: true,
  status: true,
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
};

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

// Compute days-since-admission when actual LOS not persisted
function computeLos(admittedAt, dischargedAt) {
  if (!admittedAt) return null;
  const end = dischargedAt ? new Date(dischargedAt) : new Date();
  return Math.max(1, Math.ceil((end - new Date(admittedAt)) / (1000 * 60 * 60 * 24)));
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
    admission_type = 'elective',
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
  } = data;

  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!admitting_doctor) throw AppError.badRequest('admitting_doctor is required');
  if (!created_by) throw AppError.badRequest('created_by is required');
  if (!VALID_ADMISSION_TYPES.includes(admission_type)) {
    throw AppError.badRequest(`Invalid admission_type: ${admission_type}`);
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
  // consent. Bypass fires only when admission_type='emergency' AND
  // priority='emergent' (matches the admit-without-bed exception
  // criterion from A2). Caller must supply emergency_consent_bypass_reason
  // — the chart needs to record WHY consent was bypassed.
  // Findings:
  //   2026-05-08-emergency-walk-in-admission-emergency-blocked-by-consent
  //   2026-05-08-inpatient-admission-doctor-emergency-admit-blocked-by-treatment-consent.
  const isEmergencyConsentBypassEligible = admission_type === 'emergency' && priority === 'emergent';
  let emergencyBypass = null;
  const consent = await prisma.patient_consents.findFirst({
    where: { patient_uid, consent_type: 'treatment', status: 'active' },
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

  return prisma.$transaction(async (tx) => {
    // Resolve patient_uid → users.id (beds.patient_id is int FK)
    const patientUser = await tx.users.findUnique({
      where: { uid: patient_uid },
      select: { id: true, name: true },
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
        allergies,
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
      },
      select: ADMISSION_RETURNING_SELECT,
    });

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
    }

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
      SELECT id, status, bed_number, bed_type, ward_name FROM beds WHERE id = ${bedId} FOR UPDATE
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

// Default consult types opened at mark-for-discharge. Extend in
// migration data or via configurable seed if more roles need to be
// pinged in future (pharmacist counselling, social worker, etc.).
const DEFAULT_DISCHARGE_CONSULTS = ['dietary', 'physiotherapy'];

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
 *   3. Open default discharge consults (dietary, physiotherapy) so
 *      those roles are pinged. T0→completed_at is the efficiency
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
 * @returns {{ admission: Object, summary: Object|null, consults: Array, finalClaim: Object|null, attending_doctors: Array }}
 */
async function markForDischarge(admissionId, requestedBy) {
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
    const hasInsurance =
      phase1.insurance_info != null
      || (await prisma.insurance_claims.count({
        where: { patient_uid: phase1.patient_uid, status: { not: 'paid' } },
      })) > 0;
    if (hasInsurance) {
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
 * Log a discharge consult as completed. Used by the dietician /
 * physiotherapy / etc. roles to record that they've seen the patient
 * and given the relevant advice. T0 → completed_at is the efficiency
 * marker for each consult type. Architectural item D2.
 */
async function completeDischargeConsult(admissionId, consultType, completedBy, notes = null) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  if (!consultType) throw AppError.badRequest('consultType is required');
  if (!completedBy) throw AppError.badRequest('completedBy is required');

  const updated = await prisma.discharge_consults.update({
    where: { admission_id_consult_type: { admission_id: admissionId, consult_type: consultType } },
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
      metadata: { admission_id: admissionId, consult_type: consultType },
      ip_address: null,
    },
  });

  logger.info(`Discharge consult ${consultType} completed for admission ${admissionId} by ${completedBy}`);
  return updated;
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

async function dischargePatient(admissionId, dischargeData, dischargedBy) {
  const { discharge_type, discharge_summary, override_readiness_gate } = dischargeData || {};

  if (!discharge_type) throw AppError.badRequest('discharge_type is required');
  if (!VALID_DISCHARGE_TYPES.includes(discharge_type)) {
    throw AppError.badRequest(`Invalid discharge_type: ${discharge_type}`);
  }
  if (!dischargedBy) throw AppError.badRequest('dischargedBy is required');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on the admission to serialise concurrent state changes.
    // Pull the discharge-cascade markers + encounter_id so the readiness
    // gate (D2) can check summary-signed / drugs-dispensed without a
    // second query.
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, bed_id, status, admitted_at, encounter_id,
             discharge_initiated_at, summary_signed_at, discharge_drugs_dispensed_at
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    const allowedFrom = VALID_STATUS_TRANSITIONS[admission.status];
    if (!allowedFrom || !allowedFrom.includes('discharged')) {
      throw AppError.invalidTransition(admission.status, 'discharged', allowedFrom || []);
    }

    // Discharge readiness gate. `lama` (left against medical advice) and
    // `expired` (deceased) bypass the gate by definition; planned home
    // discharges must clear (a) discharge_summary present, (b) no
    // unpaid invoice for this admission, (c) no still-pending lab/imaging
    // results. Explicit `override_readiness_gate: true` lets the
    // discharge counter override (with audit). See finding
    // 2026-05-08-tpa-insurance-claim-discharge-no-readiness-gate.
    const READINESS_GATED_TYPES = new Set(['home', 'transfer', 'aor']);
    if (READINESS_GATED_TYPES.has(discharge_type) && override_readiness_gate !== true) {
      const blockers = [];
      // Discharge cascade gates (D2). Require:
      //   - mark-for-discharge already happened (T0 stamped)
      //   - signed summary (T2)
      //   - takeaway drugs dispensed (T3)
      // discharge_summary text in dischargeData is allowed as the
      // legacy free-text path; if the admission has a clinical_notes
      // discharge note that's signed, that satisfies the summary gate.
      if (!admission.discharge_initiated_at) {
        blockers.push({
          type: 'NOT_MARKED_FOR_DISCHARGE',
          message: 'Admission has not been marked for discharge yet. Call POST /admissions/:id/mark-for-discharge first to open the cascade.',
        });
      }
      if (!admission.summary_signed_at) {
        const signedNote = await tx.clinical_notes.findFirst({
          where: {
            encounter_id: admission.encounter_id ?? undefined,
            note_type: 'discharge',
            is_addendum: false,
            is_signed: true,
          },
          select: { id: true },
        });
        if (!signedNote && (!discharge_summary || !String(discharge_summary).trim())) {
          blockers.push({
            type: 'SUMMARY_NOT_SIGNED',
            message: 'Discharge summary must be signed by the doctor before final discharge.',
          });
        }
      }
      if (!admission.discharge_drugs_dispensed_at) {
        blockers.push({
          type: 'DRUGS_NOT_DISPENSED',
          message: 'Discharge takeaway drugs must be dispensed before final discharge. Call POST /admissions/:id/mark-drugs-dispensed when pharmacy hands over.',
        });
      }
      try {
        // Surface ALL non-final v2 invoices that still owe money. The
        // exclude list deliberately omits 'DRAFT' — a DRAFT invoice
        // with positive amount_due means the cashier added charges
        // but never issued + collected, which is itself a billing-
        // close concern at discharge. ISSUED + PARTIAL flow through
        // as obvious unpaid blockers. Findings:
        //   2026-05-10-inpatient-admission-discharge-billing-v2-due-not-in-readiness
        //   2026-05-10-surgical-day-care-discharge-billing-v2-due-not-in-readiness
        const unpaid = await tx.$queryRawUnsafe(
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
      } catch (e) {
        // Billing schema may carry slightly different column names in some
        // deploys. Don't fail the gate on a query error — log and continue
        // with the rest. The override path remains for cases where this
        // query simply can't run.
        logger.warn(`Discharge readiness: invoice check skipped for admission ${admissionId} (${e.message})`);
      }
      try {
        const pendingResults = await tx.$queryRawUnsafe(
          `SELECT id FROM investigations
            WHERE patient_uid = $1::uuid
              AND COALESCE(status, '') NOT IN ('COMPLETED', 'CANCELLED', 'completed', 'cancelled')
              AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
            LIMIT 5`,
          admission.patient_uid,
          admission.admitted_at,
        );
        if (pendingResults.length > 0) {
          blockers.push({
            type: 'PENDING_RESULTS',
            message: `${pendingResults.length} pending lab/imaging result(s) tied to this admission. Review or cancel before discharge.`,
            count: pendingResults.length,
          });
        }
      } catch (e) {
        logger.warn(`Discharge readiness: pending-results check skipped (${e.message})`);
      }

      if (blockers.length > 0) {
        const err = AppError.badRequest('Discharge blocked — readiness gate not met. Pass `override_readiness_gate: true` with a reason in discharge_summary to override.');
        err.code = 'DISCHARGE_NOT_READY';
        err.details = { blockers };
        throw err;
      }
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

        const requester = await tx.users.findUnique({
          where: { uid: dischargedBy },
          select: { id: true, uid: true },
        });
        if (requester) {
          const bedLabel = [bedCheck[0].ward_name, bedCheck[0].bed_number].filter(Boolean).join(' / ')
            || `Bed ${admission.bed_id}`;
          await tx.housekeeping_requests.create({
            data: {
              requester_id: requester.id,
              requester_uid: requester.uid,
              location_text: bedLabel,
              request_type: 'cleaning',
              urgency: 'high',
              description: `Discharge cleaning required for ${bedLabel} after admission #${admission.id}.`,
              status: 'open',
              updated_at: new Date(),
            },
          });
        } else {
          logger.warn(`dischargePatient: housekeeping request skipped; no users row for ${dischargedBy}`);
        }
      }
    }

    // Expire any still-active attendant passes for this admission
    // (architectural item A4 / migration 174). Best-effort — log if it
    // fails but don't fail the discharge.
    try {
      const expired = await expireAttendantPassesForAdmission(tx, admissionId);
      if (expired.count > 0) {
        logger.info(`Expired ${expired.count} attendant pass(es) for admission #${admissionId}`);
      }
    } catch (e) {
      logger.warn(`dischargePatient: attendant-pass expiry failed for admission ${admissionId}: ${e.message}`);
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

    logger.info(`Admission #${admissionId} discharged (${discharge_type}), LOS ${losDays} days`);
    return { ...updated, los_days: losDays };
  });
}

async function transferPatient(admissionId, toWardId, toBedId, reason, transferredBy) {
  if (!toBedId) throw AppError.badRequest('to_bed_id is required');
  if (!transferredBy) throw AppError.badRequest('transferredBy is required');

  return prisma.$transaction(async (tx) => {
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

    // Bed back-linking on transfer. Clear from-bed fully (it's free for
    // the next patient), and snapshot the admission onto the to-bed.
    // Migration 172. Patients freely move between bed categories
    // mid-admission per project decision (2026-05-09); no category gate.
    if (fromBedId) {
      await tx.beds.update({
        where: { id: fromBedId },
        data: {
          status: 'available',
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
    return updated;
  });
}

async function getActiveAdmissions(filters = {}) {
  const { ward, doctor, department, status } = filters;
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'admitted_at'
  });

  const where = {};
  if (status) {
    where.status = status;
  } else {
    where.status = { in: ['admitted', 'transferred'] };
  }
  if (ward) where.ward = ward;
  if (department) where.department = department;
  if (doctor) {
    where.OR = [
      { admitting_doctor: doctor },
      { attending_doctor: doctor },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.admissions.count({ where }),
    prisma.admissions.findMany({
      where,
      select: {
        id: true,
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

  const [patients, beds] = await Promise.all([
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
  ]);

  const patientByUid = new Map(patients.map((p) => [p.uid, p]));
  const bedById = new Map(beds.map((b) => [b.id, b]));

  const admissions = rows.map((row) => {
    const patient = patientByUid.get(row.patient_uid);
    const bed = row.bed_id != null ? bedById.get(row.bed_id) : null;
    return {
      ...row,
      patient_name: patient?.name ?? null,
      patient_phone: patient?.phone ?? null,
      bed_ward_name: bed?.wards?.name ?? null,
    };
  });

  return {
    admissions,
    pagination: buildPagination(total, listQuery.page, listQuery.limit),
  };
}

async function getAdmissionDetail(admissionId, requestContext = {}) {
  const admission = await prisma.admissions.findUnique({
    where: { id: Number(admissionId) },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // Patient + bed/ward + admitting/attending doctor names in parallel.
  // The pre-batch-48 raw SQL joined `staff` on `uid`, but staff has no
  // `uid` (only user_id uuid) — batch 48 fixed that to join `users`,
  // which is what we use here. Doctors are users with role≥DOCTOR; we
  // only need the display name.
  const doctorUids = [admission.admitting_doctor, admission.attending_doctor]
    .filter(Boolean);
  const [patient, bed, doctors] = await Promise.all([
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
  ]);

  const doctorByUid = new Map(doctors.map((d) => [d.uid, d.name]));

  const row = {
    ...admission,
    patient_name: patient?.name ?? null,
    patient_phone: patient?.phone ?? null,
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

  return row;
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

  return rows.map((r) => ({ ...r, los_days: computeLos(r.admitted_at, r.discharged_at) }));
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

export default {
  admitPatient,
  assignBedToAdmission,
  // Discharge cascade (D2): mark → consults → drugs → final discharge.
  markForDischarge,
  completeDischargeConsult,
  markDischargeDrugsDispensed,
  dischargePatient,
  transferPatient,
  getActiveAdmissions,
  getAdmissionDetail,
  getPatientAdmissionHistory,
  updateCodeStatus,
  updateAttendingDoctor,
  getAdmissionStats,
};
