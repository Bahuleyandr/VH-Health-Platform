// src/services/theatre/theatreService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const VALID_STATUSES = ['scheduled', 'pre_op', 'in_progress', 'post_op', 'completed', 'cancelled'];
const VALID_TRANSITIONS = {
  scheduled: ['pre_op', 'cancelled'],
  pre_op: ['in_progress', 'cancelled'],
  in_progress: ['post_op'],
  post_op: ['completed'],
  completed: [],
  cancelled: [],
};

const OT_RETURNING = `id, patient_uid, encounter_id, surgeon, anesthetist, procedure_name,
    procedure_code, ot_room, scheduled_date, scheduled_time, estimated_duration,
    actual_duration, status, pre_op_checklist, equipment_needed, blood_arranged,
    consent_obtained, post_op_notes, complications, created_at, updated_at`;

function requireIntId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw AppError.badRequest('Invalid id — must be an integer');
  return n;
}

function tenantOr(value) {
  return String(value || '').trim() || DEFAULT_TENANT_ID;
}

async function assertPatientInTenant(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    patientUid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

function normalizeMarkedSide(value) {
  if (value == null) return null;
  const side = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!side) return null;
  if (['right', 'right eye', 'rt', 'r', 'od'].includes(side)) return 'right';
  if (['left', 'left eye', 'lt', 'l', 'os'].includes(side)) return 'left';
  if (['bilateral', 'both', 'both eyes', 'ou'].includes(side)) return 'bilateral';
  return null;
}

function inferProcedureSide(schedule) {
  const text = `${schedule?.procedure_name || ''} ${schedule?.procedure_code || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (/\b(bilateral|both eyes|ou)\b/.test(text)) return 'bilateral';

  const hasRight = /\bright\b|\bright[-_\s]?eye\b|\brt\b|\br\/e\b|\bod\b/.test(text);
  const hasLeft = /\bleft\b|\bleft[-_\s]?eye\b|\blt\b|\bl\/e\b|\bos\b/.test(text);

  if (hasRight && !hasLeft) return 'right';
  if (hasLeft && !hasRight) return 'left';
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y'].includes(text)) return true;
  if (['false', 'no', 'n'].includes(text)) return false;
  return Boolean(value);
}

function asNumberOrNull(value) {
  const candidate = firstDefined(value);
  if (candidate === undefined) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanTimestamp(value) {
  const candidate = firstDefined(value);
  if (candidate === undefined) return null;
  const date = candidate instanceof Date ? candidate : new Date(String(candidate));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function allergySummary(checklist) {
  const summary = firstDefined(checklist.allergies_summary, checklist.allergy_summary);
  if (summary !== undefined) return String(summary);
  if (Array.isArray(checklist.known_allergies) && checklist.known_allergies.length) {
    return checklist.known_allergies.map((item) => String(item).trim()).filter(Boolean).join(', ');
  }
  return null;
}

// Active-diabetic probe for the OT-ready glucose gate. Looks for an
// active ICD-10 E10/E11/E13 diagnosis (type 1, type 2, other DM) or a
// description that mentions diabetes/diabetic. Swallows query errors —
// if the diagnoses table is unavailable, the gate fails open rather
// than blocking a non-diabetic patient.
async function isDiabeticPatient(patientUid) {
  if (!patientUid) return false;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM diagnoses
        WHERE patient_uid = $1::uuid
          AND COALESCE(status, '') NOT IN ('resolved', 'inactive', 'erroneous')
          AND (
            UPPER(COALESCE(icd10_code, '')) LIKE 'E10%'
            OR UPPER(COALESCE(icd10_code, '')) LIKE 'E11%'
            OR UPPER(COALESCE(icd10_code, '')) LIKE 'E13%'
            OR description ILIKE '%diabetes%'
            OR description ILIKE '%diabetic%'
          )
        LIMIT 1`,
      patientUid,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function createStructuredPreopFromOtReady(schedule, checklist, { completedBy = null, tenantId = null } = {}) {
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist) || checklist.ot_ready !== true) {
    return null;
  }

  const tid = tenantId || schedule.tenant_id || DEFAULT_TENANT_ID;
  const bloodGlucose = asNumberOrNull(firstDefined(
    checklist.blood_glucose_mg_dl,
    checklist.blood_glucose_value,
    checklist.glucose,
  ));
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO preop_checklists
       (tenant_id, ot_schedule_id, patient_uid,
        consent_signed, npo_status_confirmed, site_marked,
        allergies_reviewed, allergies_summary,
        blood_glucose_mg_dl, blood_glucose_checked_at,
        eye_drops_given, eye_drops_given_at, eye_drops_notes,
        patient_identity_verified, procedure_verified, anesthesia_consent,
        status, completed_by, completed_at, metadata)
     VALUES ($1::uuid, $2, $3::uuid,
       $4, $5, $6,
       $7, $8,
       $9::numeric, $10::timestamptz,
       $11, $12::timestamptz, $13,
       $14, $15, $16,
       'complete', $17::uuid, NOW(), $18::jsonb)
     ON CONFLICT (tenant_id, ot_schedule_id) DO UPDATE SET
       patient_uid = EXCLUDED.patient_uid,
       consent_signed = EXCLUDED.consent_signed,
       npo_status_confirmed = EXCLUDED.npo_status_confirmed,
       site_marked = EXCLUDED.site_marked,
       allergies_reviewed = EXCLUDED.allergies_reviewed,
       allergies_summary = EXCLUDED.allergies_summary,
       blood_glucose_mg_dl = EXCLUDED.blood_glucose_mg_dl,
       blood_glucose_checked_at = EXCLUDED.blood_glucose_checked_at,
       eye_drops_given = EXCLUDED.eye_drops_given,
       eye_drops_given_at = EXCLUDED.eye_drops_given_at,
       eye_drops_notes = EXCLUDED.eye_drops_notes,
       patient_identity_verified = EXCLUDED.patient_identity_verified,
       procedure_verified = EXCLUDED.procedure_verified,
       anesthesia_consent = EXCLUDED.anesthesia_consent,
       status = EXCLUDED.status,
       completed_by = EXCLUDED.completed_by,
       completed_at = NOW(),
       metadata = preop_checklists.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id`,
    tid,
    schedule.id,
    schedule.patient_uid || null,
    asBool(firstDefined(checklist.consent_signed, checklist.consent_obtained), false),
    asBool(firstDefined(checklist.npo_status_confirmed, checklist.fasting_confirmed), false),
    asBool(checklist.site_marked, false),
    asBool(firstDefined(checklist.allergies_reviewed, checklist.allergy_verified), false),
    allergySummary(checklist),
    bloodGlucose,
    cleanTimestamp(firstDefined(checklist.blood_glucose_checked_at, checklist.glucose_checked_at)),
    asBool(firstDefined(checklist.eye_drops_given, checklist.eye_dilatation_drops), false),
    cleanTimestamp(firstDefined(checklist.eye_drops_given_at, checklist.eye_dilatation_drops_at)),
    firstDefined(checklist.eye_drops_notes, checklist.eye_dilatation_notes) || null,
    asBool(firstDefined(checklist.patient_identity_verified, checklist.identity_verified), false),
    asBool(firstDefined(checklist.procedure_verified, checklist.procedure_confirmed), false),
    asBool(checklist.anesthesia_consent, false),
    completedBy || null,
    JSON.stringify({
      source: 'theatre_ot_ready_checklist',
      legacy_ot_ready: true,
      checklist_keys: Object.keys(checklist).sort(),
    }),
  );
  return rows[0] || null;
}

function assertOtReadySiteMark(checklist, schedule) {
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist) || checklist.ot_ready !== true) return;

  if (checklist.site_marked !== true) {
    throw AppError.badRequest(
      'Cannot set OT-ready until the surgical site mark is confirmed',
      'SURGICAL_SITE_MARK_REQUIRED'
    );
  }

  const expectedSide = inferProcedureSide(schedule);
  if (!expectedSide || expectedSide === 'bilateral') return;

  const markedSide = normalizeMarkedSide(
    checklist.site_marked_eye ?? checklist.site_marked_side ?? checklist.site_marked_laterality
  );
  if (!markedSide) {
    throw AppError.badRequest(
      'Cannot set OT-ready until the marked surgical side is documented',
      'SURGICAL_SITE_SIDE_REQUIRED',
      { expectedSide }
    );
  }
  if (markedSide !== expectedSide) {
    throw AppError.badRequest(
      'Marked surgical side does not match the scheduled procedure',
      'SURGICAL_SITE_SIDE_MISMATCH',
      { expectedSide, markedSide }
    );
  }
}

class TheatreService {
  async _assertReadyForClosure(scheduleId, tenantId = DEFAULT_TENANT_ID) {
    const [schedule] = await prisma.$queryRawUnsafe(
      `SELECT surgeon, consent_obtained, pre_op_checklist
         FROM ot_schedules
        WHERE id = $1 AND tenant_id = $2::uuid
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );
    if (!schedule) throw AppError.notFound('OT schedule not found');

    const [preopChecklist] = await prisma.$queryRawUnsafe(
      `SELECT consent_signed, consent_signed_at, status
         FROM preop_checklists
        WHERE ot_schedule_id = $1 AND tenant_id = $2::uuid
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );

    const legacyChecklist = schedule.pre_op_checklist
      && typeof schedule.pre_op_checklist === 'object'
      && !Array.isArray(schedule.pre_op_checklist)
      ? schedule.pre_op_checklist
      : {};
    const consentDocumented = schedule.consent_obtained === true
      || legacyChecklist.consent_signed === true
      || legacyChecklist.consent_obtained === true
      || preopChecklist?.consent_signed === true;
    if (!consentDocumented) {
      throw AppError.badRequest(
        'Cannot close OT case until surgical consent is documented',
        'SURGICAL_CONSENT_REQUIRED',
        {
          consent_obtained: schedule.consent_obtained,
          checklist_consent_signed: legacyChecklist.consent_signed ?? null,
          preop_consent_signed: preopChecklist?.consent_signed ?? null,
        },
      );
    }

    const [anesthesia] = await prisma.$queryRawUnsafe(
      `SELECT status, finalized_by, finalized_at
         FROM anesthesia_records
        WHERE ot_schedule_id = $1 AND tenant_id = $2::uuid
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );
    if (!anesthesia || anesthesia.status !== 'finalized'
        || !anesthesia.finalized_by || !anesthesia.finalized_at) {
      throw AppError.badRequest(
        'Cannot close OT case until the anaesthesia record is finalized and signed',
        'ANAESTHESIA_FINALIZE_REQUIRED',
      );
    }

    const [intraop] = await prisma.$queryRawUnsafe(
      `SELECT status, finalized_by, finalized_at,
              sponge_count_correct, sharp_count_correct, instrument_count_correct
         FROM intraop_notes
        WHERE ot_schedule_id = $1 AND tenant_id = $2::uuid
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );
    if (!intraop || intraop.status !== 'finalized'
        || !intraop.finalized_by || !intraop.finalized_at) {
      throw AppError.badRequest(
        'Cannot close OT case until the intraop note is finalized and signed by the surgeon',
        'INTRAOP_FINALIZE_REQUIRED',
      );
    }
    if (intraop.sponge_count_correct !== true
        || intraop.sharp_count_correct !== true
        || intraop.instrument_count_correct !== true) {
      throw AppError.badRequest(
        'Cannot close OT case until sponge, sharp, and instrument counts are confirmed correct',
        'INSTRUMENT_COUNTS_REQUIRED',
        {
          sponge_count_correct: intraop.sponge_count_correct,
          sharp_count_correct: intraop.sharp_count_correct,
          instrument_count_correct: intraop.instrument_count_correct,
        },
      );
    }

    const bookedSurgeon = schedule.surgeon ? String(schedule.surgeon).toLowerCase() : null;
    const signedBy = intraop.finalized_by ? String(intraop.finalized_by).toLowerCase() : null;
    if (bookedSurgeon && signedBy && bookedSurgeon !== signedBy) {
      throw AppError.badRequest(
        'Cannot close OT case until the booked surgeon signs the intraop note',
        'BOOKED_SURGEON_SIGNOFF_REQUIRED',
        {
          booked_surgeon: schedule.surgeon,
          finalized_by: intraop.finalized_by,
        },
      );
    }
  }

  async scheduleSurgery(data) {
    const {
      patient_uid, encounter_id, surgeon, anesthetist,
      procedure_name, procedure_code, ot_room, scheduled_date,
      scheduled_time, estimated_duration, equipment_needed = [],
      blood_arranged = false, consent_obtained = false,
      tenantId: rawTenantId,
    } = data;
    const tenantId = tenantOr(rawTenantId || data.tenant_id);

    if (!patient_uid || !surgeon || !procedure_name || !scheduled_date) {
      throw AppError.badRequest('Missing required fields: patient_uid, surgeon, procedure_name, scheduled_date');
    }
    await assertPatientInTenant(tenantId, patient_uid);

    // ot_schedules.encounter_id is INTEGER (legacy HL7 visit_no column),
    // but admissions.encounter_id is UUID. Callers pass the admission's
    // UUID here, which Postgres rejects with a type error → previously
    // surfaced as a generic 500. Accept the UUID form and store NULL
    // until the table is widened to a uuid/int split (matches what
    // vitalsChartService does for the same column collision).
    let encounterIdInt = null;
    if (encounter_id !== null && encounter_id !== undefined && encounter_id !== '') {
      const asInt = Number.parseInt(encounter_id, 10);
      if (Number.isFinite(asInt) && String(asInt) === String(encounter_id).trim()) {
        encounterIdInt = asInt;
      } else if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(encounter_id)) {
        logger.warn('scheduleSurgery: UUID encounter_id passed; ot_schedules.encounter_id is INT — storing NULL', {
          patient_uid, encounter_id,
        });
      } else {
        throw AppError.badRequest('encounter_id must be an integer or a UUID');
      }
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO ot_schedules
        (patient_uid, encounter_id, surgeon, anesthetist, procedure_name, procedure_code,
         ot_room, scheduled_date, scheduled_time, estimated_duration, status,
         equipment_needed, blood_arranged, consent_obtained, tenant_id, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9::time,
         $10, 'scheduled', $11::text[], $12, $13, $14::uuid, NOW(), NOW())
       RETURNING ${OT_RETURNING}`,
      patient_uid, encounterIdInt, surgeon, anesthetist || null,
      procedure_name, procedure_code || null, ot_room || null,
      scheduled_date, scheduled_time || null, estimated_duration || null,
      equipment_needed, blood_arranged, consent_obtained, tenantId
    );

    logger.info('Surgery scheduled', { scheduleId: result[0].id, procedure_name, surgeon });
    return result[0];
  }

  async getTodaySchedule(filters = {}) {
    const { ot_room, status, date } = filters;
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const targetDate = date || new Date().toISOString().split('T')[0];
    const conditions = [`tenant_id = $1::uuid`, `scheduled_date = $2::date`];
    const params = [tenantId, targetDate];

    if (ot_room) {
      params.push(ot_room);
      conditions.push(`ot_room = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    return prisma.$queryRawUnsafe(
      `SELECT ${OT_RETURNING}
       FROM ot_schedules
       WHERE ${conditions.join(' AND ')}
       ORDER BY scheduled_time ASC NULLS LAST, created_at ASC`,
      ...params
    );
  }

  async updateStatus(id, newStatus, updatedBy, options = {}) {
    const tenantId = tenantOr(options.tenantId || options.tenant_id);
    if (!VALID_STATUSES.includes(newStatus)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const scheduleId = requireIntId(id);
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1 AND tenant_id = $2::uuid`,
      scheduleId, tenantId);
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');

    const currentStatus = existing[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw AppError.invalidTransition(currentStatus, newStatus, allowed);
    }

    if (currentStatus === 'pre_op' && newStatus === 'in_progress') {
      const timeOutRows = await prisma.$queryRawUnsafe(
        `SELECT id FROM surgical_safety_checklists
         WHERE ot_schedule_id = $1
           AND tenant_id = $2::uuid
           AND phase = 'time_out'
           AND (
             status = 'complete'
             OR (
               status = 'incomplete_with_override'
               AND NULLIF(TRIM(override_reason), '') IS NOT NULL
               AND override_authorized_by IS NOT NULL
             )
           )
         LIMIT 1`,
        scheduleId, tenantId
      );
      if (timeOutRows.length === 0) {
        throw AppError.badRequest(
          'WHO time-out must be completed before moving an OT case to in_progress',
          'WHO_TIMEOUT_REQUIRED'
        );
      }
    }

    // Wave-2 fix: gate post_op + completed on signed anaesthesia + intraop
    // notes + correct instrument counts. An OT case cannot transition past
    // in_progress until both the surgeon's intraop note and the
    // anaesthetist's anaesthesia record are finalized, and the closing
    // sponge/sharp/instrument counts are correct. Finding:
    // 2026-05-09-surgical-day-care-ot-staff-case-close-no-gate.
    if (newStatus === 'post_op' || newStatus === 'completed') {
      await this._assertReadyForClosure(scheduleId, tenantId);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid
       RETURNING ${OT_RETURNING}`,
      newStatus, scheduleId, tenantId
    );

    logger.info('OT schedule status updated', { scheduleId: id, from: currentStatus, to: newStatus, updatedBy });
    return result[0];
  }

  async completeChecklist(id, checklist, { tenantId = null, completedBy = null } = {}) {
    const tid = tenantOr(tenantId);
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, status, procedure_name, procedure_code, patient_uid
         FROM ot_schedules
        WHERE id = $1 AND tenant_id = $2::uuid`,
      requireIntId(id), tid);
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');
    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest('Cannot update checklist for a completed or cancelled surgery');
    }
    assertOtReadySiteMark(checklist, existing[0]);

    // Diabetic glucose gate: pre-op for any patient with an active
    // diabetes diagnosis must include a documented blood glucose check
    // before ot_ready can flip to true. Avoids the hypo/hyperglycaemia
    // window that an unmonitored fasting diabetic enters under anaesthesia.
    if (checklist && typeof checklist === 'object' && !Array.isArray(checklist) && checklist.ot_ready === true) {
      const checklistMarksDiabetic = checklist.diabetic_patient === true
        || checklist.diabetes === true
        || String(checklist.diabetic_status || '').toLowerCase() === 'diabetic';
      const glucoseChecked = checklist.blood_glucose_checked === true
        || (checklist.blood_glucose_mg_dl != null && Number.isFinite(Number(checklist.blood_glucose_mg_dl)))
        || (checklist.glucose != null && Number.isFinite(Number(checklist.glucose)));
      if (!glucoseChecked && (checklistMarksDiabetic || await isDiabeticPatient(existing[0].patient_uid))) {
        throw AppError.badRequest(
          'Cannot set OT-ready for a diabetic patient until a pre-op blood glucose check is documented',
          'DIABETIC_GLUCOSE_CHECK_REQUIRED'
        );
      }
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET pre_op_checklist = $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid
       RETURNING ${OT_RETURNING}`,
      JSON.stringify(checklist ?? {}), requireIntId(id), tid
    );

    const preop = await createStructuredPreopFromOtReady(existing[0], checklist, { tenantId: tid, completedBy });
    const row = result[0];
    if (preop?.id) row.pre_op_check_id = preop.id;

    logger.info('Pre-op checklist updated', { scheduleId: id, preopCheckId: preop?.id || null });
    return row;
  }

  async getAvailableRooms(date, options = {}) {
    const tenantId = tenantOr(options.tenantId || options.tenant_id);
    if (!date) throw AppError.badRequest('Date is required');

    const bookedResult = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ot_room FROM ot_schedules
       WHERE tenant_id = $1::uuid
         AND scheduled_date = $2::date
         AND status NOT IN ('cancelled', 'completed')
         AND ot_room IS NOT NULL`,
      tenantId, date
    );
    const bookedRooms = bookedResult.map((r) => r.ot_room);

    const scheduleResult = await prisma.$queryRawUnsafe(
      `SELECT ot_room, COUNT(*)::int AS surgery_count,
              ARRAY_AGG(scheduled_time ORDER BY scheduled_time) AS times,
              ARRAY_AGG(status) AS statuses
       FROM ot_schedules
       WHERE tenant_id = $1::uuid
         AND scheduled_date = $2::date
         AND status NOT IN ('cancelled')
         AND ot_room IS NOT NULL
       GROUP BY ot_room
       ORDER BY ot_room`,
      tenantId, date
    );

    return { date, booked_rooms: bookedRooms, room_schedules: scheduleResult };
  }

  async cancelSurgery(id, cancelledBy, options = {}) {
    const tenantId = tenantOr(options.tenantId || options.tenant_id);
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ot_schedules WHERE id = $1 AND tenant_id = $2::uuid`,
      requireIntId(id), tenantId);
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');
    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest(`Cannot cancel a surgery that is already ${existing[0].status}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE ot_schedules SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2::uuid
       RETURNING ${OT_RETURNING}`,
      requireIntId(id), tenantId
    );

    logger.info('Surgery cancelled', { scheduleId: id, cancelledBy });
    return result[0];
  }
}

export default new TheatreService();
