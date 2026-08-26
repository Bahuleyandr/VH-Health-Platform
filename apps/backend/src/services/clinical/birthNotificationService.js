// src/services/clinical/birthNotificationService.js — G4 (reaudit 2026-08-25)
//
// Birth notification / birth-certificate register (CRS Form 1). Statutory
// symmetry with deathCertificationService: the hospital is a statutory
// notifier of every institutional birth to the local Registrar under the
// Registration of Births and Deaths Act 1969, with a 21-day reporting window.
//
// Status walk for a notification:
//   draft → certified → notified_to_registrar → registered
// or → cancelled (only from draft). A per-tenant Form-1 serial is issued on
// the first `certified` transition (migration 737 birth_notification_serial_counter).
//
// Dark-gate: this register ships dark like every #878-wave feature — env kill
// switch BIRTH_NOTIFICATION_ENABLED AND per-tenant
// tenants.settings.birthNotification.enabled, ANDed, fail closed, both default
// OFF. Same status/code convention as the siblings: env off → 503
// *_NOT_ENABLED; tenant off → 403 *_DISABLED (facilityAssetService precedent).
//
// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// createBirthNotification persists the detail row PLUS one
// clinical_timeline_events row and one clinical_audit_events row in the SAME
// transaction (recordCanonicalClinicalEvent, strict). The timeline subject is
// the newborn's patient_uid when one exists, else the mother's.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function tenantOr(t) { return requireTenantId(t); }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

const STATUS_TRANSITIONS = {
  draft:                 ['certified', 'cancelled'],
  certified:             ['notified_to_registrar'],
  notified_to_registrar: ['registered'],
  registered:            [],
  cancelled:             [],
};

const VALID_SEX = ['male', 'female', 'intersex', 'indeterminate'];
const VALID_PLACES = ['hospital', 'home_transferred_in', 'in_transit', 'other'];
const VALID_OUTCOMES = ['live', 'still_birth'];

/* ─── Dark-ship gate ─────────────────────────────────────────────────────── */

export function isBirthNotificationEnvEnabled() {
  return process.env.BIRTH_NOTIFICATION_ENABLED === 'true';
}

// Dynamic import on purpose (facilityAssetService precedent): keeps
// tenantSettingsService out of this module's static import graph so suites that
// partially mock it keep loading, and the env kill switch is checked first so
// the accessor only loads on a deployment that has opened the gate.
async function getBirthNotificationSettingsLazy(tenantId) {
  const mod = await import('../tenant/tenantSettingsService.js');
  return mod.getBirthNotificationSettings(tenantId);
}

export async function requireBirthNotificationEnabled(tenantId) {
  if (!isBirthNotificationEnvEnabled()) {
    throw new AppError('Birth notification register is not enabled', 503, 'BIRTH_NOTIFICATION_NOT_ENABLED');
  }
  const settings = await getBirthNotificationSettingsLazy(tenantId);
  if (!settings.enabled) {
    throw AppError.forbidden(
      'Birth notification register is not enabled for this tenant',
      'BIRTH_NOTIFICATION_DISABLED',
    );
  }
  return settings;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function cleanText(value, max = null) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeSex(value) {
  const clean = cleanText(value) || 'indeterminate';
  if (!VALID_SEX.includes(clean)) {
    throw AppError.badRequest(`sex must be one of: ${VALID_SEX.join(', ')}`);
  }
  return clean;
}

function normalizeOutcome(value) {
  const clean = cleanText(value) || 'live';
  if (!VALID_OUTCOMES.includes(clean)) {
    throw AppError.badRequest(`outcome must be one of: ${VALID_OUTCOMES.join(', ')}`);
  }
  return clean;
}

function normalizePlace(value) {
  const clean = cleanText(value) || 'hospital';
  if (!VALID_PLACES.includes(clean)) {
    throw AppError.badRequest(`place_of_birth must be one of: ${VALID_PLACES.join(', ')}`);
  }
  return clean;
}

// Validate register content before letting status leave 'draft'. The registrar
// rejects Form 1 without the child sex, a date/time of birth, and a mother.
export function validateForCertification(rec) {
  const errs = [];
  if (!rec.date_of_birth) errs.push('date_of_birth required');
  if (!rec.time_of_birth) errs.push('time_of_birth required');
  if (!rec.mother_patient_uid) errs.push('mother_patient_uid required');
  if (!rec.sex) errs.push('sex required');
  return errs;
}

async function nextSerial(tx, tenantId, year) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO birth_notification_serial_counter (tenant_id, next_serial)
     VALUES ($1::uuid, 2)
     ON CONFLICT (tenant_id)
     DO UPDATE SET next_serial = birth_notification_serial_counter.next_serial + 1
     RETURNING next_serial - 1 AS issued`,
    tenantOr(tenantId),
  );
  const r = unwrap(rows);
  return `BIRTH-${year}-${String(r.issued).padStart(6, '0')}`;
}

// Pull the source maternity records (newborn + delivery + pregnancy/mother) for
// a given newborn_id, all scoped to the tenant. Returns null if absent.
async function loadMaternitySource(tx, tenantId, newbornId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT n.id            AS newborn_id,
            n.birth_order,
            n.birth_datetime,
            n.sex           AS newborn_sex,
            n.birth_weight_g,
            n.gestational_age_weeks,
            n.outcome       AS newborn_outcome,
            n.newborn_patient_uid,
            d.id            AS delivery_id,
            d.delivery_mode,
            d.delivery_datetime,
            p.id            AS pregnancy_id,
            p.patient_uid   AS mother_patient_uid
       FROM maternity_newborns n
       JOIN maternity_deliveries d
         ON d.id = n.delivery_id AND d.tenant_id = n.tenant_id
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id AND p.tenant_id = d.tenant_id
      WHERE n.id = $1::int AND n.tenant_id = $2::uuid`,
    normalizePositiveInt(newbornId, 'newborn_id'),
    tenantOr(tenantId),
  );
  return unwrap(rows) || null;
}

function isMultipleFromOrder(order) {
  return Number(order) > 1;
}

/* ─── Create ─────────────────────────────────────────────────────────────── */

export async function createBirthNotification({ tenantId, ...body }) {
  await requireBirthNotificationEnabled(tenantId);
  const tid = tenantOr(tenantId);

  return setTenantTx(tid, async (tx) => {
    // Source columns default from the maternity records when a newborn_id is
    // supplied; the request body overrides any field the registrar needs to
    // correct. A newborn_id is not mandatory (a transferred-in birth may have
    // no maternity record here), but the child/mother identity must resolve.
    let source = null;
    if (body.newborn_id) {
      source = await loadMaternitySource(tx, tid, body.newborn_id);
      if (!source) throw AppError.notFound('Newborn record not found');
    }

    const dob = body.date_of_birth
      || (source?.birth_datetime ? new Date(source.birth_datetime).toISOString().slice(0, 10) : null);
    const tob = body.time_of_birth
      || (source?.birth_datetime ? new Date(source.birth_datetime).toISOString().slice(11, 19) : null);
    const motherUid = cleanText(body.mother_patient_uid) || source?.mother_patient_uid || null;

    if (!dob) throw AppError.badRequest('date_of_birth required');
    if (!tob) throw AppError.badRequest('time_of_birth required');
    if (!motherUid) throw AppError.badRequest('mother_patient_uid required');

    const sex = normalizeSex(body.sex || source?.newborn_sex);
    const place = normalizePlace(body.place_of_birth);
    const outcome = normalizeOutcome(
      body.outcome
      || (source?.newborn_outcome === 'live' ? 'live'
        : source?.newborn_outcome ? 'still_birth' : 'live'),
    );
    const birthOrder = Number.parseInt(body.birth_order ?? source?.birth_order ?? 1, 10) || 1;

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO birth_notifications
         (tenant_id, newborn_id, delivery_id, pregnancy_id,
          child_name, sex, date_of_birth, time_of_birth, place_of_birth,
          ward_or_unit, birth_weight_g, birth_order, is_multiple_birth,
          delivery_type, gestational_age_weeks, outcome,
          mother_patient_uid, mother_name, mother_age_years, mother_aadhaar_last4,
          mother_education, mother_occupation,
          father_name, father_aadhaar_last4, father_education, father_occupation,
          permanent_address, address_at_birth, informant_name, informant_relation,
          status, notes, created_by)
       VALUES ($1::uuid, $2::int, $3::int, $4::int,
               $5, $6, $7::date, $8::time, $9,
               $10, $11::int, $12::int, $13::boolean,
               $14, $15::numeric, $16,
               $17::uuid, $18, $19::int, $20,
               $21, $22,
               $23, $24, $25, $26,
               $27, $28, $29, $30,
               'draft', $31, $32::uuid)
       RETURNING *`,
      tid,
      source?.newborn_id || (body.newborn_id ? normalizePositiveInt(body.newborn_id, 'newborn_id') : null),
      source?.delivery_id || (body.delivery_id ? normalizePositiveInt(body.delivery_id, 'delivery_id') : null),
      source?.pregnancy_id || (body.pregnancy_id ? normalizePositiveInt(body.pregnancy_id, 'pregnancy_id') : null),
      cleanText(body.child_name, 160),
      sex,
      dob,
      tob,
      place,
      cleanText(body.ward_or_unit, 80),
      body.birth_weight_g ?? source?.birth_weight_g ?? null,
      birthOrder,
      body.is_multiple_birth != null ? Boolean(body.is_multiple_birth) : isMultipleFromOrder(birthOrder),
      cleanText(body.delivery_type || source?.delivery_mode, 30),
      body.gestational_age_weeks ?? source?.gestational_age_weeks ?? null,
      outcome,
      motherUid,
      cleanText(body.mother_name, 160),
      body.mother_age_years ?? null,
      cleanText(body.mother_aadhaar_last4, 8),
      cleanText(body.mother_education, 60),
      cleanText(body.mother_occupation, 80),
      cleanText(body.father_name, 160),
      cleanText(body.father_aadhaar_last4, 8),
      cleanText(body.father_education, 60),
      cleanText(body.father_occupation, 80),
      cleanText(body.permanent_address),
      cleanText(body.address_at_birth),
      cleanText(body.informant_name, 160),
      cleanText(body.informant_relation, 60),
      cleanText(body.notes),
      cleanText(body.created_by) || null,
    );
    const record = unwrap(rows);

    // Canonical clinical timeline invariant: detail row + timeline + audit in
    // the same transaction. Subject is the newborn when one exists, else mother.
    const subjectUid = source?.newborn_patient_uid || motherUid;
    const { recordCanonicalClinicalEvent } = await import('./canonicalClinicalPlatformService.js');
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: subjectUid,
      eventType: 'birth_notification.created',
      eventStatus: 'draft',
      action: 'BIRTH_NOTIFICATION_CREATED',
      resourceTable: 'birth_notifications',
      resourceId: String(record.id),
      actorUid: cleanText(body.created_by) || null,
      actorRole: cleanText(body.actor_role) || null,
      summary: `Birth notification recorded (${sex}, ${outcome})`,
      metadata: {
        newborn_id: record.newborn_id,
        mother_patient_uid: motherUid,
        birth_order: birthOrder,
        outcome,
      },
    }, { db: tx, strict: true });

    return record;
  });
}

/* ─── Reads ──────────────────────────────────────────────────────────────── */

export async function listBirthNotifications({ tenantId, status, from, to, overdue, limit = 100 }) {
  await requireBirthNotificationEnabled(tenantId);
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (from) { args.push(from); conds.push(`date_of_birth >= $${args.length}::date`); }
  if (to) { args.push(to); conds.push(`date_of_birth <= $${args.length}::date`); }
  if (overdue === 'true' || overdue === true) {
    conds.push("notified_to_registrar_at IS NULL AND status <> 'cancelled' AND reporting_due_date < CURRENT_DATE");
  }
  const lim = normalizeLimit(limit);
  const sql = `
    SELECT * FROM birth_notifications
    WHERE ${conds.join(' AND ')}
    ORDER BY date_of_birth DESC, time_of_birth DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function getBirthNotification({ tenantId, id }) {
  await requireBirthNotificationEnabled(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM birth_notifications WHERE id = $1::int AND tenant_id = $2::uuid`,
    normalizePositiveInt(id, 'id'), tenantOr(tenantId));
  const rec = unwrap(rows);
  if (!rec) throw AppError.notFound('Birth notification not found');
  return rec;
}

// CRS Form 1 print payload — the register row reshaped into the prescribed
// Form-1 field grouping for the front-desk print view. No new data; a pure
// projection so the admin/print client renders the statutory form.
export async function printForm1({ tenantId, id }) {
  const rec = await getBirthNotification({ tenantId, id });
  return {
    form: 'CRS_FORM_1_BIRTH_REPORT',
    serial: rec.birth_serial,
    status: rec.status,
    reporting_due_date: rec.reporting_due_date,
    child: {
      name: rec.child_name,
      sex: rec.sex,
      date_of_birth: rec.date_of_birth,
      time_of_birth: rec.time_of_birth,
      place_of_birth: rec.place_of_birth,
      ward_or_unit: rec.ward_or_unit,
      birth_weight_g: rec.birth_weight_g,
      birth_order: rec.birth_order,
      is_multiple_birth: rec.is_multiple_birth,
      delivery_type: rec.delivery_type,
      gestational_age_weeks: rec.gestational_age_weeks,
      outcome: rec.outcome,
    },
    mother: {
      patient_uid: rec.mother_patient_uid,
      name: rec.mother_name,
      age_years: rec.mother_age_years,
      aadhaar_last4: rec.mother_aadhaar_last4,
      education: rec.mother_education,
      occupation: rec.mother_occupation,
    },
    father: {
      name: rec.father_name,
      aadhaar_last4: rec.father_aadhaar_last4,
      education: rec.father_education,
      occupation: rec.father_occupation,
    },
    address: {
      permanent: rec.permanent_address,
      at_birth: rec.address_at_birth,
    },
    informant: {
      name: rec.informant_name,
      relation: rec.informant_relation,
    },
    certification: {
      certified_by_name: rec.certified_by_name,
      certifier_registration_no: rec.certifier_registration_no,
      certified_at: rec.certified_at,
    },
    registration: {
      registrar_office: rec.registrar_office,
      registrar_acknowledgement_no: rec.registrar_acknowledgement_no,
      registration_no: rec.registration_no,
      registered_at: rec.registered_at,
    },
  };
}

/* ─── Transition ─────────────────────────────────────────────────────────── */

export async function transition({
  tenantId, id, to_status,
  certified_by, certifier_name, registration_no,
  registrar_office, registrar_acknowledgement_no,
  registration_number, cancel_reason, actor_role,
}) {
  await requireBirthNotificationEnabled(tenantId);
  const tid = tenantOr(tenantId);
  const recordId = normalizePositiveInt(id, 'id');

  return setTenantTx(tid, async (tx) => {
    const recRows = await tx.$queryRawUnsafe(
      `SELECT * FROM birth_notifications WHERE id = $1::int AND tenant_id = $2::uuid FOR UPDATE`,
      recordId, tid);
    const rec = unwrap(recRows);
    if (!rec) throw AppError.notFound('Birth notification not found');

    const allowed = STATUS_TRANSITIONS[rec.status] || [];
    if (!allowed.includes(to_status)) {
      throw AppError.invalidTransition(rec.status, to_status, allowed);
    }

    let updated;
    if (to_status === 'certified') {
      const errs = validateForCertification(rec);
      if (errs.length > 0) throw AppError.badRequest(`Cannot certify: ${errs.join('; ')}`);
      if (!certified_by || !certifier_name || !registration_no) {
        throw AppError.badRequest('certified_by + certifier_name + registration_no required');
      }
      const year = new Date(rec.date_of_birth).getFullYear();
      const serial = rec.birth_serial || await nextSerial(tx, tid, year);
      const rows = await tx.$queryRawUnsafe(
        `UPDATE birth_notifications
            SET status = 'certified',
                birth_serial = $1,
                certified_by = $2::uuid,
                certified_by_name = $3,
                certifier_registration_no = $4,
                certified_at = NOW(),
                updated_at = NOW()
          WHERE id = $5::int AND tenant_id = $6::uuid
          RETURNING *`,
        serial, cleanText(certified_by), cleanText(certifier_name, 160),
        cleanText(registration_no, 60), recordId, tid);
      updated = unwrap(rows);
    } else if (to_status === 'notified_to_registrar') {
      if (!registrar_office) throw AppError.badRequest('registrar_office required');
      const rows = await tx.$queryRawUnsafe(
        `UPDATE birth_notifications
            SET status = 'notified_to_registrar',
                notified_to_registrar_at = NOW(),
                registrar_office = $1,
                registrar_acknowledgement_no = COALESCE($2, registrar_acknowledgement_no),
                updated_at = NOW()
          WHERE id = $3::int AND tenant_id = $4::uuid
          RETURNING *`,
        cleanText(registrar_office, 160), cleanText(registrar_acknowledgement_no, 60),
        recordId, tid);
      updated = unwrap(rows);
    } else if (to_status === 'registered') {
      if (!registration_number) throw AppError.badRequest('registration_number (birth certificate no.) required');
      const rows = await tx.$queryRawUnsafe(
        `UPDATE birth_notifications
            SET status = 'registered',
                registration_no = $1,
                registered_at = NOW(),
                updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid
          RETURNING *`,
        cleanText(registration_number, 60), recordId, tid);
      updated = unwrap(rows);
    } else if (to_status === 'cancelled') {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE birth_notifications
            SET status = 'cancelled',
                cancel_reason = $1,
                updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid
          RETURNING *`,
        cleanText(cancel_reason), recordId, tid);
      updated = unwrap(rows);
    }

    // Canonical event for the state change (same transaction).
    const subjectUid = updated.mother_patient_uid;
    try {
      const { recordCanonicalClinicalEvent } = await import('./canonicalClinicalPlatformService.js');
      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: subjectUid,
        eventType: `birth_notification.${to_status}`,
        eventStatus: to_status,
        action: `BIRTH_NOTIFICATION_${to_status.toUpperCase()}`,
        resourceTable: 'birth_notifications',
        resourceId: String(recordId),
        actorUid: cleanText(certified_by) || null,
        actorRole: cleanText(actor_role) || null,
        summary: `Birth notification ${to_status}`,
        metadata: { birth_serial: updated.birth_serial, to_status },
      }, { db: tx, strict: true });
    } catch (err) {
      logger.warn(`birthNotification transition canonical event failed for #${recordId}: ${err.message}`);
      throw err;
    }
    return updated;
  });
}

// Overdue radar: notifications past the 21-day window not yet submitted.
export async function overdueRegister({ tenantId, limit = 200 }) {
  await requireBirthNotificationEnabled(tenantId);
  const lim = normalizeLimit(limit, 200, 500);
  return prisma.$queryRawUnsafe(
    `SELECT id, birth_serial, child_name, sex, date_of_birth, reporting_due_date,
            mother_patient_uid, mother_name, status,
            (CURRENT_DATE - reporting_due_date)::int AS days_overdue
       FROM birth_notifications
      WHERE tenant_id = $1::uuid
        AND notified_to_registrar_at IS NULL
        AND status <> 'cancelled'
        AND reporting_due_date < CURRENT_DATE
      ORDER BY reporting_due_date ASC
      LIMIT ${lim}`,
    tenantOr(tenantId));
}

// Pure helpers for unit tests
export const _internal = {
  STATUS_TRANSITIONS, validateForCertification,
  VALID_SEX, VALID_PLACES, VALID_OUTCOMES,
  isMultipleFromOrder,
};
