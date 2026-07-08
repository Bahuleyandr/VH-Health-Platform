// src/services/theatre/theatreService.js

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { getCataractBiometryReadiness } from '../clinical/ophthalmologyService.js';
import { assertPrivilegeForGate, isGateEnabled } from '../staff/credentialingService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getOtSterilityWarnings } from '../cssd/cssdService.js';

// Postgres exclusion_violation — raised by migration 319's
// excl_ot_schedules_room_no_overlap when an insert/update would create a
// true room+window double-booking (even via the app `force` override).
const PG_EXCLUSION_VIOLATION = '23P01';

function isExclusionViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === PG_EXCLUSION_VIOLATION
    || /exclusion constraint|excl_ot_schedules_room_no_overlap/i.test(String(err?.message || ''));
}

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
  return requireTenantId(String(value || '').trim());
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

async function createStructuredPreopFromOtReady(schedule, checklist, { completedBy = null, tenantId = null, db = prisma } = {}) {
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist) || checklist.ot_ready !== true) {
    return null;
  }

  const tid = requireTenantId(tenantId || schedule.tenant_id);
  const bloodGlucose = asNumberOrNull(firstDefined(
    checklist.blood_glucose_mg_dl,
    checklist.blood_glucose_value,
    checklist.glucose,
  ));
  const rows = await db.$queryRawUnsafe(
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
      readiness_warnings: Array.isArray(checklist.readiness_warnings) ? checklist.readiness_warnings : [],
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
  // Shared surgical-consent gate. Consent counts as documented when the OT
  // schedule's consent_obtained flag is set, OR the legacy embedded checklist
  // marks consent, OR the structured preop_checklists row is consent_signed.
  // Used both before knife-to-skin (pre_op → in_progress) and at close.
  // `schedule` may be a pre-fetched/locked row to avoid a redundant read.
  async _assertConsentDocumented(scheduleId, tenantId, schedule = null, db = prisma) {
    let row = schedule;
    if (!row) {
      [row] = await db.$queryRawUnsafe(
        `SELECT consent_obtained, pre_op_checklist
           FROM ot_schedules
          WHERE id = $1 AND tenant_id = $2::uuid
          LIMIT 1`,
        scheduleId, tenantOr(tenantId),
      );
      if (!row) throw AppError.notFound('OT schedule not found');
    }

    const [preopChecklist] = await db.$queryRawUnsafe(
      `SELECT consent_signed
         FROM preop_checklists
        WHERE ot_schedule_id = $1 AND tenant_id = $2::uuid
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );

    const legacyChecklist = row.pre_op_checklist
      && typeof row.pre_op_checklist === 'object'
      && !Array.isArray(row.pre_op_checklist)
      ? row.pre_op_checklist
      : {};
    const consentDocumented = row.consent_obtained === true
      || legacyChecklist.consent_signed === true
      || legacyChecklist.consent_obtained === true
      || preopChecklist?.consent_signed === true;
    if (!consentDocumented) {
      throw AppError.badRequest(
        'Surgical consent must be documented before the case starts',
        'SURGICAL_CONSENT_REQUIRED',
        {
          consent_obtained: row.consent_obtained,
          checklist_consent_signed: legacyChecklist.consent_signed ?? null,
          preop_consent_signed: preopChecklist?.consent_signed ?? null,
        },
      );
    }
  }

  async _assertReadyForClosure(scheduleId, tenantId = DEFAULT_TENANT_ID, db = prisma) {
    const [schedule] = await db.$queryRawUnsafe(
      `SELECT surgeon, consent_obtained, pre_op_checklist
         FROM ot_schedules
        WHERE id = $1 AND tenant_id = $2::uuid
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );
    if (!schedule) throw AppError.notFound('OT schedule not found');

    await this._assertConsentDocumented(scheduleId, tenantId, schedule, db);

    const [anesthesia] = await db.$queryRawUnsafe(
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

    const [intraop] = await db.$queryRawUnsafe(
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

    // WHO sign-out gate (audit §3 fix #4). The third WHO phase — the
    // sign-out — is the final count/specimen/equipment-concerns
    // read-aloud before the patient leaves the room. A case must not be
    // marked post_op/completed until sign-out is recorded complete (or an
    // explicit, authorized override is on file), so a retained-object or
    // unresolved-concern close cannot pass silently. Mirrors the time-out
    // gate on incision start.
    const [signOut] = await db.$queryRawUnsafe(
      `SELECT status, override_reason, override_authorized_by
         FROM surgical_safety_checklists
        WHERE ot_schedule_id = $1
          AND tenant_id = $2::uuid
          AND phase = 'sign_out'
        ORDER BY updated_at DESC
        LIMIT 1`,
      scheduleId, tenantOr(tenantId),
    );
    const signOutComplete = signOut?.status === 'complete'
      || (signOut?.status === 'incomplete_with_override'
        && String(signOut?.override_reason || '').trim() !== ''
        && signOut?.override_authorized_by != null);
    if (!signOutComplete) {
      throw AppError.badRequest(
        'Cannot close OT case until the WHO sign-out is completed (or an authorized override is recorded)',
        'WHO_SIGNOUT_REQUIRED',
        { sign_out_status: signOut?.status ?? null },
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
    await assertPrivilegeForGate({
      staffUid: surgeon,
      privilegeName: 'primary_surgeon',
      tenantId,
      gate: 'theatre_booking_surgeon',
      enabled: isGateEnabled('THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE'),
    });

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

    // Canonical clinical write: the case row + a clinical_timeline_events +
    // clinical_audit_events row in ONE tx, so the medico-legal trail exists
    // for the scheduling decision. setTenantTx scopes the tx under RLS.
    let created;
    try {
      created = await setTenantTx(tenantId, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
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
        const schedule = rows[0];
        await recordCanonicalClinicalEvent({
          tenantId,
          patientUid: patient_uid,
          eventType: 'surgery.scheduled',
          eventStatus: 'scheduled',
          sourceTable: 'ot_schedules',
          sourceId: schedule.id,
          resourceType: 'ot_schedule',
          actorUid: data.scheduledBy || data.actorUid || null,
          actorRole: data.actorRole || null,
          summary: `Surgery scheduled: ${procedure_name}${ot_room ? ` in ${ot_room}` : ''} on ${scheduled_date}${scheduled_time ? ` ${scheduled_time}` : ''}`,
          payload: {
            procedure_name,
            procedure_code: procedure_code || null,
            surgeon,
            anesthetist: anesthetist || null,
            ot_room: ot_room || null,
            scheduled_date,
            scheduled_time: scheduled_time || null,
            estimated_duration: estimated_duration || null,
            consent_obtained: schedule.consent_obtained,
          },
        }, { db: tx });
        return schedule;
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw AppError.conflict(
          'OT room is already booked for an overlapping time window',
          'OT_ROOM_DOUBLE_BOOKED',
          { ot_room: ot_room || null, scheduled_date, scheduled_time: scheduled_time || null },
        );
      }
      throw err;
    }

    logger.info('Surgery scheduled', { scheduleId: created.id, procedure_name, surgeon });
    return created;
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

    const schedules = await prisma.$queryRawUnsafe(
      `SELECT ${OT_RETURNING}
       FROM ot_schedules
       WHERE ${conditions.join(' AND ')}
       ORDER BY scheduled_time ASC NULLS LAST, created_at ASC`,
      ...params
    );
    if (!schedules.length) return schedules;

    const warningsBySchedule = await getOtSterilityWarnings({
      tenantId,
      scheduleIds: schedules.map((schedule) => schedule.id),
    });
    return schedules.map((schedule) => ({
      ...schedule,
      cssd_warnings: warningsBySchedule.get(Number(schedule.id)) || [],
    }));
  }

  async updateStatus(id, newStatus, updatedBy, options = {}) {
    const tenantId = tenantOr(options.tenantId || options.tenant_id);
    if (!VALID_STATUSES.includes(newStatus)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const scheduleId = requireIntId(id);

    // Lock-safe status transition (audit §3 fix #2). The whole read → gates →
    // write runs in ONE tenant-scoped transaction; the row is locked with
    // SELECT ... FOR UPDATE and the UPDATE carries an `AND status = <current>`
    // from-state predicate. A concurrent writer that wins the lock and moves
    // the row first makes our UPDATE match 0 rows → 409, instead of two
    // callers both "succeeding" (double-start, or advancing past the WHO
    // time-out gate under concurrency). The canonical timeline + audit event
    // is emitted in the same tx so the medico-legal trail can't desync.
    return setTenantTx(tenantId, async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        `SELECT id, status, patient_uid, consent_obtained, pre_op_checklist
           FROM ot_schedules
          WHERE id = $1 AND tenant_id = $2::uuid
          FOR UPDATE`,
        scheduleId, tenantId);
      if (locked.length === 0) throw AppError.notFound('OT schedule not found');

      const current = locked[0];
      const currentStatus = current.status;
      const allowed = VALID_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(newStatus)) {
        throw AppError.invalidTransition(currentStatus, newStatus, allowed);
      }

      if (currentStatus === 'pre_op' && newStatus === 'in_progress') {
        // Consent gate on knife-to-skin (audit §3 fix #4): surgical consent
        // must be documented before the case starts, not only checked at
        // close. Reuses the same consent sources as the closure gate.
        await this._assertConsentDocumented(scheduleId, tenantId, current, tx);

        const timeOutRows = await tx.$queryRawUnsafe(
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

      // Wave-2 + audit §3 fix #4: gate post_op + completed on signed
      // anaesthesia + intraop notes + correct instrument counts + WHO
      // sign-out. An OT case cannot transition past in_progress until the
      // surgeon's intraop note and the anaesthetist's anaesthesia record are
      // finalized, the closing sponge/sharp/instrument counts are correct,
      // and the WHO sign-out is complete (or authorized override on file).
      if (newStatus === 'post_op' || newStatus === 'completed') {
        await this._assertReadyForClosure(scheduleId, tenantId, tx);
      }

      const result = await tx.$queryRawUnsafe(
        `UPDATE ot_schedules SET status = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid AND status = $4
         RETURNING ${OT_RETURNING}`,
        newStatus, scheduleId, tenantId, currentStatus
      );
      // from-state predicate matched 0 rows → another tx changed status after
      // our FOR UPDATE read (only possible if the lock was released between
      // statements, e.g. a SAVEPOINT abort); treat as a concurrency conflict.
      if (result.length === 0) {
        throw AppError.conflict(
          `OT case is no longer in '${currentStatus}' — status changed concurrently`,
          'OT_STATUS_CONFLICT',
          { expected_from: currentStatus, to: newStatus },
        );
      }

      await recordCanonicalClinicalEvent({
        tenantId,
        patientUid: current.patient_uid,
        eventType: `surgery.${newStatus}`,
        eventStatus: newStatus,
        sourceTable: 'ot_schedules',
        sourceId: scheduleId,
        resourceType: 'ot_schedule',
        actorUid: updatedBy || null,
        actorRole: options.actorRole || null,
        summary: `OT case status ${currentStatus} → ${newStatus}`,
        payload: { from_status: currentStatus, to_status: newStatus },
        beforeState: { status: currentStatus },
        afterState: { status: newStatus },
      }, { db: tx });

      logger.info('OT schedule status updated', { scheduleId: id, from: currentStatus, to: newStatus, updatedBy });
      return result[0];
    });
  }

  async completeChecklist(id, checklist, { tenantId = null, completedBy = null } = {}) {
    const tid = tenantOr(tenantId);
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, status, procedure_name, procedure_code, patient_uid, surgeon
         FROM ot_schedules
        WHERE id = $1 AND tenant_id = $2::uuid`,
      requireIntId(id), tid);
    if (existing.length === 0) throw AppError.notFound('OT schedule not found');
    if (['completed', 'cancelled'].includes(existing[0].status)) {
      throw AppError.badRequest('Cannot update checklist for a completed or cancelled surgery');
    }

    const wantsOtReady = !!(checklist && typeof checklist === 'object' && !Array.isArray(checklist) && checklist.ot_ready === true);
    let readinessWarnings = [];
    let checklistForWrite = checklist;

    assertOtReadySiteMark(checklistForWrite, existing[0]);

    // Diabetic glucose gate: pre-op for any patient with an active
    // diabetes diagnosis must include a documented blood glucose check
    // before ot_ready can flip to true. Avoids the hypo/hyperglycaemia
    // window that an unmonitored fasting diabetic enters under anaesthesia.
    if (wantsOtReady) {
      const checklistMarksDiabetic = checklistForWrite.diabetic_patient === true
        || checklistForWrite.diabetes === true
        || String(checklistForWrite.diabetic_status || '').toLowerCase() === 'diabetic';
      const glucoseChecked = checklistForWrite.blood_glucose_checked === true
        || (checklistForWrite.blood_glucose_mg_dl != null && Number.isFinite(Number(checklistForWrite.blood_glucose_mg_dl)))
        || (checklistForWrite.glucose != null && Number.isFinite(Number(checklistForWrite.glucose)));
      if (!glucoseChecked && (checklistMarksDiabetic || await isDiabeticPatient(existing[0].patient_uid))) {
        throw AppError.badRequest(
          'Cannot set OT-ready for a diabetic patient until a pre-op blood glucose check is documented',
          'DIABETIC_GLUCOSE_CHECK_REQUIRED'
        );
      }
      await assertPrivilegeForGate({
        staffUid: existing[0].surgeon,
        privilegeName: 'primary_surgeon',
        tenantId: tid,
        gate: 'theatre_ot_ready_surgeon',
        enabled: isGateEnabled('THEATRE_REQUIRE_OT_READY_SURGEON_PRIVILEGE'),
      });
      const cataractReadiness = await getCataractBiometryReadiness(existing[0], { tenantId: tid });
      readinessWarnings = cataractReadiness?.warnings || [];
      checklistForWrite = {
        ...checklistForWrite,
        readiness_warnings: readinessWarnings,
      };
    }

    // Canonical clinical write: the checklist update + structured preop row +
    // a clinical_timeline_events + clinical_audit_events row in ONE tx.
    const scheduleId = requireIntId(id);
    return setTenantTx(tid, async (tx) => {
      const result = await tx.$queryRawUnsafe(
        `UPDATE ot_schedules SET pre_op_checklist = $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid
         RETURNING ${OT_RETURNING}`,
        JSON.stringify(checklistForWrite ?? {}), scheduleId, tid
      );

      const preop = await createStructuredPreopFromOtReady(existing[0], checklistForWrite, { tenantId: tid, completedBy, db: tx });
      const row = result[0];
      if (preop?.id) row.pre_op_check_id = preop.id;
      row.readiness_warnings = readinessWarnings;

      const otReady = !!(checklistForWrite && typeof checklistForWrite === 'object' && !Array.isArray(checklistForWrite) && checklistForWrite.ot_ready === true);
      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: existing[0].patient_uid,
        eventType: otReady ? 'surgery.preop_checklist.ot_ready' : 'surgery.preop_checklist.updated',
        eventStatus: otReady ? 'ot_ready' : 'updated',
        sourceTable: 'ot_schedules',
        sourceId: scheduleId,
        resourceType: 'ot_schedule',
        actorUid: completedBy || null,
        summary: otReady
          ? `Pre-op checklist marked OT-ready: ${existing[0].procedure_name}`
          : `Pre-op checklist updated: ${existing[0].procedure_name}`,
        payload: {
          ot_ready: otReady,
          pre_op_check_id: preop?.id || null,
          readiness_warnings: readinessWarnings,
          procedure_name: existing[0].procedure_name,
        },
      }, { db: tx });

      logger.info('Pre-op checklist updated', { scheduleId: id, preopCheckId: preop?.id || null });
      return row;
    });
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
    const scheduleId = requireIntId(id);

    // Lock-safe cancel + canonical clinical write in ONE tenant-scoped tx.
    return setTenantTx(tenantId, async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        `SELECT id, status, patient_uid, procedure_name
           FROM ot_schedules
          WHERE id = $1 AND tenant_id = $2::uuid
          FOR UPDATE`,
        scheduleId, tenantId);
      if (locked.length === 0) throw AppError.notFound('OT schedule not found');
      const current = locked[0];
      if (['completed', 'cancelled'].includes(current.status)) {
        throw AppError.badRequest(`Cannot cancel a surgery that is already ${current.status}`);
      }

      const result = await tx.$queryRawUnsafe(
        `UPDATE ot_schedules SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid AND status = $3
         RETURNING ${OT_RETURNING}`,
        scheduleId, tenantId, current.status
      );
      if (result.length === 0) {
        throw AppError.conflict(
          `OT case is no longer in '${current.status}' — status changed concurrently`,
          'OT_STATUS_CONFLICT',
          { expected_from: current.status, to: 'cancelled' },
        );
      }

      await recordCanonicalClinicalEvent({
        tenantId,
        patientUid: current.patient_uid,
        eventType: 'surgery.cancelled',
        eventStatus: 'cancelled',
        sourceTable: 'ot_schedules',
        sourceId: scheduleId,
        resourceType: 'ot_schedule',
        actorUid: cancelledBy || null,
        actorRole: options.actorRole || null,
        summary: `Surgery cancelled: ${current.procedure_name}`,
        payload: { from_status: current.status, to_status: 'cancelled' },
        beforeState: { status: current.status },
        afterState: { status: 'cancelled' },
      }, { db: tx });

      logger.info('Surgery cancelled', { scheduleId: id, cancelledBy });
      return result[0];
    });
  }
}

export default new TheatreService();
