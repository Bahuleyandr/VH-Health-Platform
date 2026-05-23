// src/services/radiology/radiologyService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_MODALITIES = ['xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy'];
const VALID_PRIORITIES = ['routine', 'urgent', 'stat'];

// E-8 — modality + priority aliases. The legacy contract was case-
// sensitive against bare lowercase values, but doctors + downstream
// platforms emit uppercase / abbreviation forms (USG / X-RAY / STAT).
// Coerce here so the API doesn't 400-loop on case-only mismatches.
// Finding: 2026-05-08-dynamic-acute-abdomen-doctor-radiology-order-contract-mismatch.
const MODALITY_ALIASES = {
  usg: 'ultrasound', us: 'ultrasound', sonography: 'ultrasound',
  ekg: 'xray', // pathological — caller meant something else; let validator reject
  'x-ray': 'xray', xr: 'xray',
  mr: 'mri',
  mammo: 'mammography', mg: 'mammography',
  fluoro: 'fluoroscopy',
};
const PRIORITY_ALIASES = {
  emergency: 'stat', emergent: 'stat',
  high: 'urgent',
  normal: 'routine', low: 'routine',
};
function normaliseModality(raw) {
  if (!raw) return raw;
  const k = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (VALID_MODALITIES.includes(k)) return k;
  return MODALITY_ALIASES[k] || k;
}
function normalisePriority(raw) {
  if (!raw) return raw;
  const k = String(raw).trim().toLowerCase();
  if (VALID_PRIORITIES.includes(k)) return k;
  return PRIORITY_ALIASES[k] || k;
}

// Canonical columns for radiology_orders. The real schema has:
// `report (text)`, `report_completed_at`, `radiologist (uuid)`, `notes`.
// It does NOT have `findings`, `impression`, `images`, `reported_by`, `reported_at` —
// an earlier service shape referenced those; we fold findings/impression into the
// `report` text blob and keep `radiologist` as the reporter uuid.
// `report_signed_off_at` + `report_signed_off_by` are the medico-legal
// "this report is final" signal. The sign-off endpoint already writes
// them, but every other read (`getOrderDetail`, `getWorklist`) used to
// project this set WITHOUT the signature columns — so a treating
// doctor reading the report couldn't tell a signed final report from
// an unsigned completed draft. Re-included here so every read surface
// exposes the signature state uniformly.
// Finding: 2026-05-22-dynamic-acute-abdomen-radiologist-31d32cc1.
const RAD_RETURNING = `id, patient_uid, encounter_id, modality, body_part, clinical_indication,
    priority, status, ordered_by, radiologist, report, report_completed_at,
    report_signed_off_at, report_signed_off_by, notes,
    created_at, updated_at`;

function requireIntId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw AppError.badRequest('Invalid id — must be an integer');
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the caller's `encounter_id` to the integer FK
// `radiology_orders.encounter_id` expects. Three shapes accepted:
//   - UUID matching `admissions.encounter_id` → admissions.id (IPD)
//   - Integer (string or number) → passed through
//   - Anything else / null / no admission match → null + warning
// Exported for unit testing of the legacy / IPD / OPD / garbage paths
// without driving the full createOrder pipeline.
export async function resolveEncounterIdForRadiology(rawEncounterId, patientUid) {
  if (rawEncounterId == null || rawEncounterId === '') return null;
  const raw = String(rawEncounterId).trim();
  if (UUID_RE.test(raw)) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM admissions WHERE encounter_id = $1::uuid LIMIT 1`,
        raw,
      );
      if (rows.length) return Number(rows[0].id);
    } catch (e) {
      logger.warn('Radiology order: admissions lookup failed for encounter_id uuid', {
        encounter_id: raw, patient_uid: patientUid, err: e?.message ?? String(e),
      });
      return null;
    }
    logger.warn('Radiology order: encounter_id uuid did not match any admission; storing null', {
      encounter_id: raw, patient_uid: patientUid,
    });
    return null;
  }
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  logger.warn('Radiology order: encounter_id is neither uuid nor integer; storing null', {
    encounter_id: raw, patient_uid: patientUid,
  });
  return null;
}

class RadiologyService {

  async createOrder(data) {
    // E-8 — accept legacy field aliases so a caller emitting the
    // platform-conventional names (clinical_notes, doctor_id) doesn't
    // 400-loop. Same for modality/priority case + abbrev coercion.
    const patient_uid = data.patient_uid;
    const encounter_id = data.encounter_id;
    const body_part = data.body_part;
    const clinical_indication = data.clinical_indication ?? data.clinical_notes ?? null;
    const ordered_by = data.ordered_by ?? data.doctor_id ?? null;
    const notes = data.notes ?? null;
    const modality = normaliseModality(data.modality);
    const priority = normalisePriority(data.priority || 'routine');

    if (!patient_uid || !modality || !body_part || !clinical_indication || !ordered_by) {
      throw AppError.badRequest(
        'Missing required fields: patient_uid, modality, body_part, ' +
        'clinical_indication (or clinical_notes), ordered_by (or doctor_id)',
      );
    }
    if (!VALID_MODALITIES.includes(modality)) {
      throw AppError.badRequest(
        `Invalid modality "${data.modality}". Must be one of: ${VALID_MODALITIES.join(', ')} ` +
        `(aliases accepted: USG/US/sonography, X-ray/XR, MR, mammo/MG, fluoro)`,
      );
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      throw AppError.badRequest(
        `Invalid priority "${data.priority}". Must be one of: ${VALID_PRIORITIES.join(', ')} ` +
        `(aliases accepted: emergency/emergent->stat, high->urgent, normal/low->routine)`,
      );
    }

    // Resolve encounter_id input shape. `radiology_orders.encounter_id` is
    // INTEGER, but callers naturally pass the UUID surfaced on
    // `admissions.encounter_id` (the canonical encounter handle exposed
    // in admission detail). Passing the uuid straight through made
    // Postgres reject it ("invalid input syntax for type integer") and
    // the route returned a generic 500. Resolve uuid → admissions.id so
    // an IPD STAT imaging order saves linked instead of forcing an
    // orphan row (the doctor's only previous workaround). OPD/walk-in
    // (no matching admission) and unparseable input fall back to null
    // with a warning rather than 400-ing the order — the radiology
    // worklist still needs the order in front of the radiologist.
    // Findings: 2026-05-22-inpatient-admission-doctor-7ded987b,
    // 2026-05-22-dynamic-acute-abdomen-doctor-449c93ec,
    // 2026-05-22-inpatient-admission-doctor-a8d4e86f,
    // 2026-05-23-inpatient-admission-doctor-2de6874d / -cdf1c658,
    // 2026-05-23-dynamic-acute-abdomen-doctor-a69c2203.
    const resolvedEncounterId = await resolveEncounterIdForRadiology(encounter_id, patient_uid);

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO radiology_orders
        (patient_uid, encounter_id, modality, body_part, clinical_indication,
         priority, status, ordered_by, notes, created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3, $4, $5, $6, 'ordered', $7::uuid, $8, NOW(), NOW())
       RETURNING ${RAD_RETURNING}`,
      patient_uid, resolvedEncounterId, modality, body_part, clinical_indication,
      priority, ordered_by, notes || null
    );

    logger.info('Radiology order created', { orderId: result[0].id, modality, patient_uid });
    return result[0];
  }

  async getWorklist(filters = {}) {
    const { status, modality, priority } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'created_at'
    });
    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`ro.status = $${params.length}`);
    }
    if (modality) {
      params.push(modality);
      conditions.push(`ro.modality = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      conditions.push(`ro.priority = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM radiology_orders ro ${whereClause}`,
      ...params
    );
    const total = parseInt(countResult[0].count, 10);

    params.push(listQuery.limit);
    params.push(listQuery.offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT ro.id, ro.patient_uid, ro.encounter_id, ro.modality, ro.body_part,
              ro.clinical_indication, ro.priority, ro.status, ro.ordered_by,
              ro.radiologist, ro.report_completed_at,
              ro.report_signed_off_at, ro.report_signed_off_by,
              ro.notes, ro.created_at, ro.updated_at
       FROM radiology_orders ro
       ${whereClause}
       ORDER BY
         CASE ro.priority WHEN 'stat' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
         ro.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination,
    };
  }

  async submitReport(id, data) {
    const { report, findings, impression, reported_by } = data;

    if (!report || !reported_by) {
      throw AppError.badRequest('Missing required fields: report, reported_by');
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, report_signed_off_at FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (existing[0].status === 'cancelled') {
      throw AppError.badRequest('Cannot submit report for a cancelled order');
    }
    // E-8 — signoff lock. Once signed off, the report is immutable
    // (medico-legal record). Caller wanting to amend must use the
    // future addendum path (out of scope here). Finding:
    // 2026-05-08-dynamic-acute-abdomen-radiology-tech-report-overwrite-after-signoff.
    if (existing[0].report_signed_off_at) {
      throw AppError.conflict(
        `Report has been signed off at ${existing[0].report_signed_off_at.toISOString?.() ?? existing[0].report_signed_off_at} — overwrites are not permitted. Issue an addendum instead.`,
        'REPORT_SIGNED_OFF',
      );
    }

    // Compose a full-report blob that captures the structured sections the old
    // API accepted but the DB has no columns for.
    const parts = [];
    if (findings) parts.push(`Findings:\n${findings}`);
    if (impression) parts.push(`Impression:\n${impression}`);
    parts.push(report);
    const fullReport = parts.join('\n\n');

    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders
       SET report = $1, radiologist = $2::uuid, report_completed_at = NOW(),
           status = 'completed', updated_at = NOW()
       WHERE id = $3
       RETURNING ${RAD_RETURNING}`,
      fullReport, reported_by, requireIntId(id)
    );

    logger.info('Radiology report submitted', { orderId: id, reported_by });
    return result[0];
  }

  async getPatientHistory(patientUid, filters = {}) {
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM radiology_orders WHERE patient_uid = $1::uuid`,
      patientUid
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT ${RAD_RETURNING}
       FROM radiology_orders
       WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      patientUid, listQuery.limit, listQuery.offset
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination,
    };
  }

  async getOrderDetail(id) {
    const result = await prisma.$queryRawUnsafe(
      `SELECT ${RAD_RETURNING}
       FROM radiology_orders
       WHERE id = $1`, requireIntId(id));
    if (result.length === 0) throw AppError.notFound('Radiology order not found');
    return result[0];
  }

  // E-8 — acquisition state. The radiology tech marks an order
  // 'acquired' once images are captured + uploaded; the radiologist
  // then reads. Status flow:
  //   ordered -> acquired -> in_progress (radiologist reading) -> completed
  // Tech identity (acquired_by) stays distinct from radiologist
  // identity. Finding:
  // 2026-05-08-dynamic-acute-abdomen-radiology-tech-no-acquisition-state-no-tech-attribution.
  async markAcquired(id, { tech_uid, tech_name }) {
    if (!tech_uid) throw AppError.badRequest('tech_uid is required');
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (existing[0].status === 'cancelled') {
      throw AppError.badRequest('Cannot acquire a cancelled order');
    }
    if (existing[0].status === 'completed') {
      throw AppError.badRequest('Cannot acquire — order is already completed');
    }
    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders
          SET status = 'acquired',
              acquired_at = NOW(),
              acquired_by = $1::uuid,
              acquired_by_name = $2,
              tech_uid = COALESCE(tech_uid, $1::uuid),
              tech_name = COALESCE(tech_name, $2),
              updated_at = NOW()
        WHERE id = $3
        RETURNING ${RAD_RETURNING}, acquired_at, acquired_by, acquired_by_name, tech_uid, tech_name`,
      tech_uid, tech_name || null, requireIntId(id),
    );
    logger.info('Radiology order acquired', { orderId: id, tech_uid });
    return result[0];
  }

  // D50 — Addendum to a signed radiology report. Once a report is
  // signed off, the original blob is medico-legally immutable
  // (submitReport above refuses overwrites). The fix path is an
  // addendum: append a clearly-labelled new section to the report
  // text with the addendum author + timestamp, leaving the original
  // sign-off metadata untouched. Each addendum is also written to
  // audit_logs so the addendum chain can be reconstructed even if a
  // later edit overwrites the text blob.
  // Finding 42f9bdb5.
  async appendReportAddendum(id, { addendum, addendum_by }) {
    if (!addendum || typeof addendum !== 'string' || !addendum.trim()) {
      throw AppError.badRequest('addendum text is required');
    }
    if (!addendum_by) throw AppError.badRequest('addendum_by is required');
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, report, report_signed_off_at
         FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (existing[0].status === 'cancelled') {
      throw AppError.badRequest('Cannot append addendum to a cancelled order');
    }
    if (!existing[0].report_signed_off_at) {
      // Addenda only make sense AFTER sign-off. Before sign-off the
      // caller should just use submitReport to overwrite the draft.
      throw AppError.badRequest(
        'Addendum is for amending a signed report. The report is not signed off yet — use submitReport to revise the draft.',
        'REPORT_NOT_SIGNED_OFF',
      );
    }
    const cleanAddendum = String(addendum).trim();
    const stampedAddendum = `\n\n--- Addendum (${new Date().toISOString()} by ${addendum_by}) ---\n${cleanAddendum}`;
    const baseReport = existing[0].report || '';
    const newReport = `${baseReport}${stampedAddendum}`;

    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders
          SET report = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING ${RAD_RETURNING}`,
      newReport, requireIntId(id),
    );

    // Best-effort audit row — addendum chain reconstruction works even
    // if the report blob is later edited.
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (uid, action, resource, resource_id, metadata, ip_address)
         VALUES ($1::uuid, 'RADIOLOGY_REPORT_ADDENDUM', 'radiology_order', $2, $3::jsonb, NULL)`,
        String(addendum_by), String(id),
        JSON.stringify({
          radiology_order_id: id,
          addendum_text: cleanAddendum.slice(0, 4000),
          appended_at: new Date().toISOString(),
        }),
      );
    } catch (auditErr) {
      logger.warn(`appendReportAddendum: audit log write failed for order=${id}: ${auditErr.message}`);
    }
    logger.info('Radiology report addendum appended', { orderId: id, addendum_by });
    return result[0];
  }

  // E-8 — radiologist sign-off lock. After signoff, the report is
  // medico-legally immutable. submitReport refuses overwrites once
  // report_signed_off_at is set.
  async signOffReport(id, { signed_off_by }) {
    if (!signed_off_by) throw AppError.badRequest('signed_off_by is required');
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, report_completed_at, report_signed_off_at
         FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (!existing[0].report_completed_at) {
      throw AppError.badRequest('Cannot sign off — report has not been submitted yet');
    }
    if (existing[0].report_signed_off_at) {
      throw AppError.conflict('Report is already signed off', 'REPORT_SIGNED_OFF');
    }
    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders
          SET report_signed_off_at = NOW(),
              report_signed_off_by = $1::uuid,
              updated_at = NOW()
        WHERE id = $2
        RETURNING ${RAD_RETURNING}, report_signed_off_at, report_signed_off_by`,
      signed_off_by, requireIntId(id),
    );
    logger.info('Radiology report signed off', { orderId: id, signed_off_by });
    return result[0];
  }

  async cancelOrder(id, cancelledBy) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (existing[0].status === 'completed') {
      throw AppError.badRequest('Cannot cancel a completed order');
    }
    if (existing[0].status === 'cancelled') {
      throw AppError.badRequest('Order is already cancelled');
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1
       RETURNING ${RAD_RETURNING}`,
      requireIntId(id)
    );

    logger.info('Radiology order cancelled', { orderId: id, cancelledBy });
    return result[0];
  }
}

export default new RadiologyService();
