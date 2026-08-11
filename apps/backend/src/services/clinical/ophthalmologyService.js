// src/services/clinical/ophthalmologyService.js
//
// Roadmap D7 — ophthalmology depth (greenfield).
//
// Per-eye structured exams (visual acuity in Indian-practice notations,
// IOP with method + glaucoma alert at >21 mmHg, segment findings, lens
// grading) and refractions (sphere/cylinder/axis/add) including the
// dispensable final-glasses prescription. Clinical writes follow the
// canonical timeline invariant.

import PDFDocument from 'pdfkit';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const tenantOr = (t) => requireTenantId(t);

export const IOP_ALERT_THRESHOLD_MMHG = 21;
const VALID_EYES = new Set(['od', 'os']);
const VALID_ATTACHMENT_EYES = new Set(['od', 'os', 'ou']);
const VALID_IMAGE_TYPES = new Set(['fundus', 'oct', 'visual_field', 'slit_lamp', 'biometry_scan', 'other']);

// Snellen metric (6/x), counting fingers at distance, hand movements,
// perception of light, no PL, and near (N) notation.
const VA_PATTERN = /^(6\/(60|36|24|18|12|9|6|5|4)|[1-5]\/60|CF( ?\d(\.\d)?m?)?|HM|PL|NPL|N\d{1,2})$/i;

/** Validate a visual-acuity notation; returns the normalized string or null. */
export function normalizeVaNotation(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().toUpperCase();
  return VA_PATTERN.test(s) ? s : undefined; // undefined = invalid
}

export function validateRefraction({ sphere, cylinder = null, axis = null, addPower = null }) {
  const errors = [];
  const sph = Number(sphere);
  if (!Number.isFinite(sph) || sph < -30 || sph > 30) errors.push('sphere must be between -30 and +30 D');
  if (cylinder !== null && cylinder !== undefined) {
    const cyl = Number(cylinder);
    if (!Number.isFinite(cyl) || cyl < -10 || cyl > 10) errors.push('cylinder must be between -10 and +10 D');
    if (cyl !== 0 && (axis === null || axis === undefined)) errors.push('axis is required when cylinder is non-zero');
  }
  if (axis !== null && axis !== undefined) {
    const ax = Number(axis);
    if (!Number.isInteger(ax) || ax < 0 || ax > 180) errors.push('axis must be an integer 0-180');
  }
  if (addPower !== null && addPower !== undefined) {
    const add = Number(addPower);
    if (!Number.isFinite(add) || add < 0 || add > 4) errors.push('add must be between 0 and +4 D');
  }
  return errors;
}

const VA_FIELDS = [
  ['odVaUnaided', 'od_va_unaided'], ['osVaUnaided', 'os_va_unaided'],
  ['odVaPinhole', 'od_va_pinhole'], ['osVaPinhole', 'os_va_pinhole'],
  ['odVaCorrected', 'od_va_corrected'], ['osVaCorrected', 'os_va_corrected'],
];

function normalizeWire(value) {
  if (value == null) return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalizeWire);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeWire(item)]));
  }
  return value;
}

function intOrNull(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'OPHTHO_ID_INVALID');
  }
  return n;
}

function numberOrNull(value, field, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${field} is required`, 'OPHTHO_NUMERIC_REQUIRED');
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw AppError.badRequest(`${field} must be between ${min} and ${max}`, 'OPHTHO_NUMERIC_INVALID');
  }
  return n;
}

function cleanEye(value, { allowOu = false } = {}) {
  const eye = String(value || '').trim().toLowerCase();
  const allowed = allowOu ? VALID_ATTACHMENT_EYES : VALID_EYES;
  if (!allowed.has(eye)) {
    throw AppError.badRequest(allowOu ? 'eye must be od, os, or ou' : 'eye must be od or os', 'OPHTHO_EYE_INVALID');
  }
  return eye;
}

function assertSafeStorageKey(storageKey) {
  const key = String(storageKey || '').trim();
  if (!key || key.includes('\0') || key.includes('..') || key.startsWith('/') || key.startsWith('\\')) {
    throw AppError.badRequest('storage_key must be a validated upload key', 'OPHTHO_STORAGE_KEY_INVALID');
  }
  return key;
}

async function assertPatient(tenantId, patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid required', 'OPHTHO_PATIENT_REQUIRED');
  const patient = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    patientUid,
  );
  if (!patient.length) throw AppError.notFound('Patient not found', 'OPHTHO_PATIENT_NOT_FOUND');
}

async function assertAppointmentLink(tenantId, patientUid, appointmentId) {
  const id = intOrNull(appointmentId, 'appointment_id');
  if (id === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
      WHERE a.tenant_id = $1::uuid
        AND a.id = $2
        AND u.uid = $3::uuid
      LIMIT 1`,
    tenantOr(tenantId),
    id,
    patientUid,
  );
  if (!rows.length) {
    throw AppError.badRequest('appointment_id does not belong to this patient', 'OPHTHO_APPOINTMENT_MISMATCH');
  }
  return id;
}

async function assertEncounterLink(tenantId, patientUid, encounterId) {
  if (encounterId === null || encounterId === undefined || encounterId === '') return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM patient_encounters
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND patient_uid = $3::uuid
      LIMIT 1`,
    tenantOr(tenantId),
    encounterId,
    patientUid,
  );
  if (!rows.length) {
    throw AppError.badRequest('encounter_id does not belong to this patient', 'OPHTHO_ENCOUNTER_MISMATCH');
  }
  return encounterId;
}

async function getExamOrThrow(examId, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, appointment_id
       FROM ophthalmic_exams
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    Number(examId),
    tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Exam not found', 'OPHTHO_EXAM_NOT_FOUND');
  return rows[0];
}

export async function recordExam({
  tenantId, patientUid, examType = 'comprehensive',
  encounterId = null, appointmentId = null,
  odIopMmhg = null, osIopMmhg = null, iopMethod = null,
  odAnteriorSegment = null, osAnteriorSegment = null,
  odPosteriorSegment = null, osPosteriorSegment = null,
  odLensStatus = null, osLensStatus = null,
  diagnosis = null, advice = null,
  ...vaInputs
}, { actorUid = null, actorRole = null } = {}) {
  await assertPatient(tenantId, patientUid);
  const linkedAppointmentId = await assertAppointmentLink(tenantId, patientUid, appointmentId);
  const linkedEncounterId = await assertEncounterLink(tenantId, patientUid, encounterId);

  // Validate every supplied VA notation.
  const va = {};
  for (const [inputKey, column] of VA_FIELDS) {
    const normalized = normalizeVaNotation(vaInputs[inputKey]);
    if (normalized === undefined) {
      throw AppError.badRequest(
        `${column} "${vaInputs[inputKey]}" is not a recognised acuity notation (6/x, CF, HM, PL, NPL, Nx)`,
        'OPHTHO_VA_INVALID',
      );
    }
    va[column] = normalized;
  }

  for (const [label, value] of [['od_iop_mmhg', odIopMmhg], ['os_iop_mmhg', osIopMmhg]]) {
    if (value !== null && value !== undefined) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 80) {
        throw AppError.badRequest(`${label} must be 0-80 mmHg`, 'OPHTHO_IOP_INVALID');
      }
    }
  }
  if ((odIopMmhg !== null || osIopMmhg !== null) && iopMethod === null) {
    throw AppError.badRequest('iop_method is required when recording IOP (gat, nct, icare, schiotz)', 'OPHTHO_IOP_METHOD_REQUIRED');
  }

  const iopAlert = (odIopMmhg !== null && Number(odIopMmhg) > IOP_ALERT_THRESHOLD_MMHG)
    || (osIopMmhg !== null && Number(osIopMmhg) > IOP_ALERT_THRESHOLD_MMHG);

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    let rows;
    try {
      rows = await tx.$queryRawUnsafe(
        `INSERT INTO ophthalmic_exams
           (patient_uid, encounter_id, appointment_id, exam_type,
            od_va_unaided, os_va_unaided, od_va_pinhole, os_va_pinhole,
            od_va_corrected, os_va_corrected,
            od_iop_mmhg, os_iop_mmhg, iop_method,
            od_anterior_segment, os_anterior_segment,
            od_posterior_segment, os_posterior_segment,
            od_lens_status, os_lens_status,
            diagnosis, advice, examined_by, tenant_id)
         VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6, $7, $8, $9, $10,
                 $11::numeric, $12::numeric, $13,
                 $14, $15, $16, $17, $18, $19,
                 $20, $21, $22::uuid, $23::uuid)
         RETURNING *`,
        patientUid, linkedEncounterId, linkedAppointmentId, examType,
        va.od_va_unaided, va.os_va_unaided, va.od_va_pinhole, va.os_va_pinhole,
        va.od_va_corrected, va.os_va_corrected,
        odIopMmhg !== null && odIopMmhg !== undefined ? Number(odIopMmhg) : null,
        osIopMmhg !== null && osIopMmhg !== undefined ? Number(osIopMmhg) : null,
        iopMethod,
        odAnteriorSegment, osAnteriorSegment, odPosteriorSegment, osPosteriorSegment,
        odLensStatus, osLensStatus,
        diagnosis, advice, actorUid, tenantOr(tenantId),
      );
    } catch (err) {
      const msg = String(err.message);
      if (msg.includes('chk_ophthalmic_exams_type')) {
        throw AppError.badRequest('Unknown exam_type', 'OPHTHO_EXAM_TYPE_INVALID');
      }
      if (msg.includes('chk_ophthalmic_exams_iop_method')) {
        throw AppError.badRequest('iop_method must be gat, nct, icare, or schiotz', 'OPHTHO_IOP_METHOD_INVALID');
      }
      if (msg.includes('chk_ophthalmic_exams_lens')) {
        throw AppError.badRequest('Unknown lens status grading', 'OPHTHO_LENS_STATUS_INVALID');
      }
      throw err;
    }
    const exam = rows[0];

    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid,
      encounterId: linkedEncounterId,
      eventType: iopAlert ? 'ophtho.exam_recorded_iop_alert' : 'ophtho.exam_recorded',
      sourceTable: 'ophthalmic_exams',
      sourceId: exam.id,
      actorUid,
      actorRole,
      summary: `Ophthalmic ${examType} exam${iopAlert ? ` — IOP ALERT (OD ${odIopMmhg ?? '-'} / OS ${osIopMmhg ?? '-'} mmHg)` : ''}`,
      payload: {
        exam_type: examType,
        encounter_id: linkedEncounterId,
        appointment_id: linkedAppointmentId,
        od_iop_mmhg: odIopMmhg, os_iop_mmhg: osIopMmhg, iop_method: iopMethod,
        iop_alert: iopAlert,
      },
    }, { db: tx });

    return normalizeWire({ ...exam, iop_alert: iopAlert });
  });
}

export async function addRefraction(examId, {
  tenantId, eye, refractionType = 'manifest',
  sphere, cylinder = null, axis = null, addPower = null, vaWithCorrection = null,
}, { actorUid = null } = {}) {
  if (!['od', 'os'].includes(String(eye || '').toLowerCase())) {
    throw AppError.badRequest('eye must be od or os', 'OPHTHO_EYE_INVALID');
  }
  if (!['manifest', 'cycloplegic', 'final_glasses'].includes(refractionType)) {
    throw AppError.badRequest('refraction_type must be manifest, cycloplegic, or final_glasses', 'OPHTHO_REFRACTION_TYPE_INVALID');
  }
  const errors = validateRefraction({ sphere, cylinder, axis, addPower });
  if (errors.length) {
    throw AppError.badRequest('Refraction failed validation', 'OPHTHO_REFRACTION_INVALID', { errors });
  }
  const vaNorm = normalizeVaNotation(vaWithCorrection);
  if (vaNorm === undefined) {
    throw AppError.badRequest(`va_with_correction "${vaWithCorrection}" is not a recognised acuity notation`, 'OPHTHO_VA_INVALID');
  }

  const exams = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid
       FROM ophthalmic_exams
      WHERE id = $1 AND tenant_id = $2::uuid`,
    Number(examId),
    tenantOr(tenantId),
  );
  if (!exams.length) throw AppError.notFound('Exam not found', 'OPHTHO_EXAM_NOT_FOUND');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO ophthalmic_refractions
         (exam_id, patient_uid, eye, refraction_type, sphere, cylinder, axis, add_power,
          va_with_correction, recorded_by, tenant_id)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11::uuid)
       RETURNING *`,
      exams[0].id, exams[0].patient_uid, String(eye).toLowerCase(), refractionType,
      Number(sphere),
      cylinder !== null && cylinder !== undefined ? Number(cylinder) : null,
      axis !== null && axis !== undefined ? Number(axis) : null,
      addPower !== null && addPower !== undefined ? Number(addPower) : null,
      vaNorm, actorUid, tenantOr(tenantId),
    );
    return normalizeWire(rows[0]);
  } catch (err) {
    if (String(err.message).includes('uq_ophthalmic_refractions_eye')) {
      throw AppError.conflict(`A ${refractionType} refraction for ${eye} already exists on this exam`, 'OPHTHO_REFRACTION_EXISTS');
    }
    throw err;
  }
}

export async function getPatientHistory(patientUid, { tenantId, limit = 20 } = {}) {
  await assertPatient(tenantId, patientUid);
  const lim = Math.min(Number(limit) || 20, 100);
  const exams = await prisma.$queryRawUnsafe(
    `SELECT * FROM ophthalmic_exams
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
     ORDER BY recorded_at DESC
     LIMIT ${lim}`,
    tenantOr(tenantId),
    patientUid,
  );
  const refractions = await prisma.$queryRawUnsafe(
    `SELECT * FROM ophthalmic_refractions
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
     ORDER BY created_at DESC
     LIMIT ${lim * 2}`,
    tenantOr(tenantId),
    patientUid,
  );
  const biometries = await prisma.$queryRawUnsafe(
    `SELECT * FROM ophthalmic_biometry
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
     ORDER BY recorded_at DESC
     LIMIT ${lim * 2}`,
    tenantOr(tenantId),
    patientUid,
  );
  const attachments = await prisma.$queryRawUnsafe(
    `SELECT * FROM ophthalmic_imaging_attachments
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
     ORDER BY uploaded_at DESC
     LIMIT ${lim * 3}`,
    tenantOr(tenantId),
    patientUid,
  );
  const byExam = {};
  for (const r of refractions) {
    byExam[r.exam_id] = byExam[r.exam_id] || [];
    byExam[r.exam_id].push(r);
  }
  const biometryByExam = {};
  for (const b of biometries) {
    biometryByExam[b.exam_id] = biometryByExam[b.exam_id] || [];
    biometryByExam[b.exam_id].push(b);
  }
  const attachmentsByExam = {};
  for (const a of attachments) {
    attachmentsByExam[a.exam_id] = attachmentsByExam[a.exam_id] || [];
    attachmentsByExam[a.exam_id].push(a);
  }
  return normalizeWire({
    exams: exams.map((e) => ({
      ...e,
      refractions: byExam[e.id] || [],
      biometries: biometryByExam[e.id] || [],
      imaging_attachments: attachmentsByExam[e.id] || [],
    })),
    latest_glasses: refractions.filter((r) => r.refraction_type === 'final_glasses').slice(0, 2),
  });
}

export async function recordBiometry(examId, {
  tenantId, eye, k1Diopters = null, k1Axis = null, k2Diopters = null, k2Axis = null,
  axialLengthMm, anteriorChamberDepthMm = null, lensThicknessMm = null,
  whiteToWhiteMm = null, targetRefraction = null, iolFormula = null,
  selectedIolPower = null, selectedIolModel = null, calculationReference = null,
  notes = null, metadata = {},
}, { actorUid = null, actorRole = null } = {}) {
  const exam = await getExamOrThrow(examId, tenantId);
  const clean = {
    eye: cleanEye(eye),
    k1Diopters: numberOrNull(k1Diopters, 'k1_diopters', { min: 30, max: 60 }),
    k1Axis: numberOrNull(k1Axis, 'k1_axis', { min: 0, max: 180 }),
    k2Diopters: numberOrNull(k2Diopters, 'k2_diopters', { min: 30, max: 60 }),
    k2Axis: numberOrNull(k2Axis, 'k2_axis', { min: 0, max: 180 }),
    axialLengthMm: numberOrNull(axialLengthMm, 'axial_length_mm', { min: 15, max: 40, required: true }),
    anteriorChamberDepthMm: numberOrNull(anteriorChamberDepthMm, 'anterior_chamber_depth_mm', { min: 1, max: 8 }),
    lensThicknessMm: numberOrNull(lensThicknessMm, 'lens_thickness_mm', { min: 1, max: 8 }),
    whiteToWhiteMm: numberOrNull(whiteToWhiteMm, 'white_to_white_mm', { min: 8, max: 16 }),
    targetRefraction: numberOrNull(targetRefraction, 'target_refraction', { min: -30, max: 30 }),
    selectedIolPower: numberOrNull(selectedIolPower, 'selected_iol_power', { min: -10, max: 60 }),
  };

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO ophthalmic_biometry
         (tenant_id, exam_id, patient_uid, encounter_id, appointment_id, eye,
          k1_diopters, k1_axis, k2_diopters, k2_axis, axial_length_mm,
          anterior_chamber_depth_mm, lens_thickness_mm, white_to_white_mm,
          target_refraction, iol_formula, selected_iol_power, selected_iol_model,
          calculation_reference, notes, recorded_by, metadata, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::int, $6,
               $7::numeric, $8::int, $9::numeric, $10::int, $11::numeric,
               $12::numeric, $13::numeric, $14::numeric,
               $15::numeric, $16, $17::numeric, $18,
               $19, $20, $21::uuid, $22::jsonb, NOW())
       ON CONFLICT (tenant_id, exam_id, eye) DO UPDATE SET
         k1_diopters = EXCLUDED.k1_diopters,
         k1_axis = EXCLUDED.k1_axis,
         k2_diopters = EXCLUDED.k2_diopters,
         k2_axis = EXCLUDED.k2_axis,
         axial_length_mm = EXCLUDED.axial_length_mm,
         anterior_chamber_depth_mm = EXCLUDED.anterior_chamber_depth_mm,
         lens_thickness_mm = EXCLUDED.lens_thickness_mm,
         white_to_white_mm = EXCLUDED.white_to_white_mm,
         target_refraction = EXCLUDED.target_refraction,
         iol_formula = EXCLUDED.iol_formula,
         selected_iol_power = EXCLUDED.selected_iol_power,
         selected_iol_model = EXCLUDED.selected_iol_model,
         calculation_reference = EXCLUDED.calculation_reference,
         notes = EXCLUDED.notes,
         recorded_by = EXCLUDED.recorded_by,
         recorded_at = NOW(),
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      tenantOr(tenantId), exam.id, exam.patient_uid, exam.encounter_id || null, exam.appointment_id || null, clean.eye,
      clean.k1Diopters, clean.k1Axis, clean.k2Diopters, clean.k2Axis, clean.axialLengthMm,
      clean.anteriorChamberDepthMm, clean.lensThicknessMm, clean.whiteToWhiteMm,
      clean.targetRefraction, iolFormula || null, clean.selectedIolPower, selectedIolModel || null,
      calculationReference || null, notes || null, actorUid, JSON.stringify(metadata || {}),
    );
    const biometry = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid: exam.patient_uid,
      encounterId: exam.encounter_id || null,
      eventType: 'ophtho.biometry_recorded',
      sourceTable: 'ophthalmic_biometry',
      sourceId: biometry.id,
      actorUid,
      actorRole,
      summary: `Ophthalmic biometry recorded (${clean.eye.toUpperCase()})`,
      payload: {
        exam_id: exam.id,
        eye: clean.eye,
        axial_length_mm: clean.axialLengthMm,
        selected_iol_power: clean.selectedIolPower,
        iol_formula: iolFormula || null,
      },
    }, { db: tx });
    return normalizeWire(biometry);
  });
}

export async function attachImaging(examId, {
  tenantId, eye = null, imageType = 'other', storageKey, storageUrl = null,
  mimeType, fileSize = null, sha256Hash = null, capturedAt = null, metadata = {},
}, { actorUid = null, actorRole = null } = {}) {
  const exam = await getExamOrThrow(examId, tenantId);
  const cleanImageType = String(imageType || 'other').trim().toLowerCase();
  if (!VALID_IMAGE_TYPES.has(cleanImageType)) {
    throw AppError.badRequest('image_type is not supported', 'OPHTHO_IMAGE_TYPE_INVALID');
  }
  const cleanMime = String(mimeType || '').trim().toLowerCase();
  if (!cleanMime || !/^(image\/|application\/pdf$)/.test(cleanMime)) {
    throw AppError.badRequest('mime_type must be an image type or PDF', 'OPHTHO_IMAGE_MIME_INVALID');
  }
  const cleanSize = numberOrNull(fileSize, 'file_size', { min: 1, max: 1024 * 1024 * 200 });
  const cleanSha = sha256Hash ? String(sha256Hash).trim().toLowerCase() : null;
  if (cleanSha && !/^[a-f0-9]{64}$/.test(cleanSha)) {
    throw AppError.badRequest('sha256_hash must be a 64-character hex digest', 'OPHTHO_IMAGE_HASH_INVALID');
  }

  try {
    return await setTenantTx(tenantOr(tenantId), async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ophthalmic_imaging_attachments
           (tenant_id, exam_id, patient_uid, eye, image_type, storage_key,
            storage_url, mime_type, file_size, sha256_hash, captured_at,
            uploaded_by, metadata)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6,
                 $7, $8, $9::int, $10, $11::timestamptz,
                 $12::uuid, $13::jsonb)
         RETURNING *`,
        tenantOr(tenantId), exam.id, exam.patient_uid,
        eye == null || eye === '' ? null : cleanEye(eye, { allowOu: true }),
        cleanImageType,
        assertSafeStorageKey(storageKey),
        storageUrl || null,
        cleanMime,
        cleanSize,
        cleanSha,
        capturedAt || null,
        actorUid,
        JSON.stringify(metadata || {}),
      );
      const attachment = rows[0];
      await recordCanonicalClinicalEvent({
        tenantId: tenantOr(tenantId),
        patientUid: exam.patient_uid,
        encounterId: exam.encounter_id || null,
        eventType: 'ophtho.imaging_attached',
        sourceTable: 'ophthalmic_imaging_attachments',
        sourceId: attachment.id,
        actorUid,
        actorRole,
        summary: `Ophthalmic imaging attached (${cleanImageType.replaceAll('_', ' ')})`,
        payload: {
          exam_id: exam.id,
          image_type: cleanImageType,
          eye: attachment.eye,
          storage_key: attachment.storage_key,
        },
      }, { db: tx });
      return normalizeWire(attachment);
    });
  } catch (err) {
    if (String(err.message).includes('uq_ophthalmic_imaging_storage_key')) {
      throw AppError.conflict('This imaging attachment is already linked', 'OPHTHO_IMAGE_EXISTS');
    }
    throw err;
  }
}

export async function generateSpectaclesPrescriptionPdf(examId, { tenantId } = {}) {
  const exam = await getExamOrThrow(examId, tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT r.*, u.name AS patient_name
       FROM ophthalmic_refractions r
       JOIN users u ON u.uid = r.patient_uid
      WHERE r.tenant_id = $1::uuid
        AND r.exam_id = $2
        AND r.refraction_type = 'final_glasses'
      ORDER BY r.eye`,
    tenantOr(tenantId),
    Number(examId),
  );
  if (!rows.length) throw AppError.notFound('Final glasses refraction not found', 'OPHTHO_GLASSES_NOT_FOUND');
  const refractions = normalizeWire(rows);
  const patientName = refractions[0]?.patient_name || exam.patient_uid;
  const buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(18).text('Spectacles Prescription', { underline: true });
    doc.moveDown(0.5).fontSize(11).text(`Patient: ${patientName}`);
    doc.text(`Patient UID: ${exam.patient_uid}`);
    doc.text(`Exam ID: ${exam.id}`);
    doc.moveDown();
    doc.fontSize(10).text('Eye        Sphere     Cylinder     Axis     Add     VA', { continued: false });
    doc.moveTo(42, doc.y + 2).lineTo(540, doc.y + 2).stroke();
    doc.moveDown(0.4);
    for (const r of refractions) {
      doc.text(
        `${String(r.eye || '').toUpperCase().padEnd(10)}${String(r.sphere ?? '').padEnd(11)}${String(r.cylinder ?? '-').padEnd(13)}${String(r.axis ?? '-').padEnd(9)}${String(r.add_power ?? '-').padEnd(8)}${r.va_with_correction ?? '-'}`,
      );
    }
    doc.moveDown();
    doc.fontSize(9).text('Recorded prescription only. Dispensing and clinical counselling remain clinician/optician responsibilities.');
    doc.end();
  });
  return {
    buffer,
    content_type: 'application/pdf',
    filename: `ophthalmology-spectacles-rx-${exam.id}.pdf`,
  };
}

function cataractProcedure(schedule = {}) {
  const text = `${schedule.procedure_code || ''} ${schedule.procedure_name || ''}`.toLowerCase();
  return /\bcataract\b|phaco|iol|cat-?/.test(text);
}

function expectedEyesForSchedule(schedule = {}) {
  const text = `${schedule.procedure_code || ''} ${schedule.procedure_name || ''}`.toLowerCase();
  if (/\b(bilateral|both eyes|ou)\b/.test(text)) return ['od', 'os'];
  const right = /\bright\b|\bright[-_\s]?eye\b|\brt\b|\br\/e\b|\bod\b/.test(text);
  const left = /\bleft\b|\bleft[-_\s]?eye\b|\blt\b|\bl\/e\b|\bos\b/.test(text);
  if (right && !left) return ['od'];
  if (left && !right) return ['os'];
  return ['od', 'os'];
}

export async function getCataractBiometryReadiness(schedule = {}, { tenantId, db = prisma } = {}) {
  if (!cataractProcedure(schedule)) {
    return { applies: false, ready: true, warnings: [] };
  }
  const expectedEyes = expectedEyesForSchedule(schedule);
  const rows = await db.$queryRawUnsafe(
    `SELECT eye, MAX(recorded_at) AS recorded_at
       FROM ophthalmic_biometry
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
      GROUP BY eye`,
    tenantOr(tenantId || schedule.tenant_id),
    schedule.patient_uid,
  );
  const presentEyes = new Set(rows.map((row) => row.eye));
  const missingEyes = expectedEyes.filter((eye) => !presentEyes.has(eye));
  if (!missingEyes.length) {
    return { applies: true, ready: true, expected_eyes: expectedEyes, present_eyes: [...presentEyes], warnings: [] };
  }
  return {
    applies: true,
    ready: false,
    expected_eyes: expectedEyes,
    present_eyes: [...presentEyes],
    warnings: [{
      code: 'CATARACT_BIOMETRY_MISSING',
      severity: 'warning',
      message: 'Biometry is not recorded for the cataract eye before OT-ready.',
      missing_eyes: missingEyes,
    }],
  };
}

export default {
  IOP_ALERT_THRESHOLD_MMHG,
  normalizeVaNotation,
  validateRefraction,
  recordExam,
  addRefraction,
  getPatientHistory,
  recordBiometry,
  attachImaging,
  generateSpectaclesPrescriptionPdf,
  getCataractBiometryReadiness,
};
