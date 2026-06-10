// src/services/clinical/ophthalmologyService.js
//
// Roadmap D7 — ophthalmology depth (greenfield).
//
// Per-eye structured exams (visual acuity in Indian-practice notations,
// IOP with method + glaucoma alert at >21 mmHg, segment findings, lens
// grading) and refractions (sphere/cylinder/axis/add) including the
// dispensable final-glasses prescription. Clinical writes follow the
// canonical timeline invariant.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';
const tenantOr = (t) => t || TENANT_FALLBACK;

export const IOP_ALERT_THRESHOLD_MMHG = 21;

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

export async function recordExam({
  tenantId, patientUid, examType = 'comprehensive',
  odIopMmhg = null, osIopMmhg = null, iopMethod = null,
  odAnteriorSegment = null, osAnteriorSegment = null,
  odPosteriorSegment = null, osPosteriorSegment = null,
  odLensStatus = null, osLensStatus = null,
  diagnosis = null, advice = null,
  ...vaInputs
}, { actorUid = null, actorRole = null } = {}) {
  if (!patientUid) throw AppError.badRequest('patient_uid required', 'OPHTHO_PATIENT_REQUIRED');
  const patient = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users WHERE uid = $1::uuid LIMIT 1`, patientUid,
  );
  if (!patient.length) throw AppError.notFound('Patient not found', 'OPHTHO_PATIENT_NOT_FOUND');

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

  return prisma.$transaction(async (tx) => {
    let rows;
    try {
      rows = await tx.$queryRawUnsafe(
        `INSERT INTO ophthalmic_exams
           (patient_uid, exam_type,
            od_va_unaided, os_va_unaided, od_va_pinhole, os_va_pinhole,
            od_va_corrected, os_va_corrected,
            od_iop_mmhg, os_iop_mmhg, iop_method,
            od_anterior_segment, os_anterior_segment,
            od_posterior_segment, os_posterior_segment,
            od_lens_status, os_lens_status,
            diagnosis, advice, examined_by, tenant_id)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8,
                 $9::numeric, $10::numeric, $11,
                 $12, $13, $14, $15, $16, $17,
                 $18, $19, $20::uuid, $21::uuid)
         RETURNING *`,
        patientUid, examType,
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
      eventType: iopAlert ? 'ophtho.exam_recorded_iop_alert' : 'ophtho.exam_recorded',
      sourceTable: 'ophthalmic_exams',
      sourceId: exam.id,
      actorUid,
      actorRole,
      summary: `Ophthalmic ${examType} exam${iopAlert ? ` — IOP ALERT (OD ${odIopMmhg ?? '-'} / OS ${osIopMmhg ?? '-'} mmHg)` : ''}`,
      payload: {
        exam_type: examType,
        od_iop_mmhg: odIopMmhg, os_iop_mmhg: osIopMmhg, iop_method: iopMethod,
        iop_alert: iopAlert,
      },
    }, { db: tx });

    return { ...exam, iop_alert: iopAlert };
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
    `SELECT id, patient_uid FROM ophthalmic_exams WHERE id = $1`, Number(examId),
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
    return rows[0];
  } catch (err) {
    if (String(err.message).includes('uq_ophthalmic_refractions_eye')) {
      throw AppError.conflict(`A ${refractionType} refraction for ${eye} already exists on this exam`, 'OPHTHO_REFRACTION_EXISTS');
    }
    throw err;
  }
}

export async function getPatientHistory(patientUid, { limit = 20 } = {}) {
  if (!patientUid) throw AppError.badRequest('patient_uid required', 'OPHTHO_PATIENT_REQUIRED');
  const lim = Math.min(Number(limit) || 20, 100);
  const exams = await prisma.$queryRawUnsafe(
    `SELECT * FROM ophthalmic_exams
     WHERE patient_uid = $1::uuid
     ORDER BY recorded_at DESC
     LIMIT ${lim}`,
    patientUid,
  );
  const refractions = await prisma.$queryRawUnsafe(
    `SELECT * FROM ophthalmic_refractions
     WHERE patient_uid = $1::uuid
     ORDER BY created_at DESC
     LIMIT ${lim * 2}`,
    patientUid,
  );
  const byExam = {};
  for (const r of refractions) {
    byExam[r.exam_id] = byExam[r.exam_id] || [];
    byExam[r.exam_id].push(r);
  }
  return {
    exams: exams.map((e) => ({ ...e, refractions: byExam[e.id] || [] })),
    latest_glasses: refractions.filter((r) => r.refraction_type === 'final_glasses').slice(0, 2),
  };
}

export default {
  IOP_ALERT_THRESHOLD_MMHG,
  normalizeVaNotation,
  validateRefraction,
  recordExam,
  addRefraction,
  getPatientHistory,
};
