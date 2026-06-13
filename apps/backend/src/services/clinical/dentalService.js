// src/services/clinical/dentalService.js
//
// Roadmap D7 — dental charting depth (greenfield).
//
// Tooth-level longitudinal findings on FDI notation, an odontogram chart
// view, and a procedure workflow that closes the loop: completing a
// procedure auto-resolves the finding it treats. Clinical writes follow
// the canonical timeline invariant (detail + timeline + audit in one tx).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';
const tenantOr = (t) => t || TENANT_FALLBACK;

export const FINDING_TYPES = [
  'caries', 'filling', 'crown', 'bridge_pontic', 'implant', 'missing',
  'root_canal_treated', 'fracture', 'mobility_grade_1', 'mobility_grade_2',
  'mobility_grade_3', 'periapical_lesion', 'impacted', 'attrition',
  'abrasion', 'erosion', 'gingival_recession', 'calculus', 'other',
];
export const SURFACES = [
  'mesial', 'distal', 'occlusal', 'buccal', 'lingual', 'palatal',
  'incisal', 'cervical', 'whole',
];

/**
 * FDI two-digit notation: quadrants 1-4 carry permanent teeth 1-8;
 * quadrants 5-8 carry deciduous teeth 1-5.
 */
export function isValidFdiTooth(tooth) {
  const s = String(tooth ?? '').trim();
  if (!/^[1-8][1-8]$/.test(s)) return false;
  const quadrant = Number(s[0]);
  const position = Number(s[1]);
  return quadrant <= 4 ? position >= 1 && position <= 8 : position >= 1 && position <= 5;
}

async function assertPatient(tenantId, patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid required', 'DENTAL_PATIENT_REQUIRED');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    patientUid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'DENTAL_PATIENT_NOT_FOUND');
}

// ── findings ─────────────────────────────────────────────────────────────

export async function recordToothFinding({
  tenantId, patientUid, toothFdi, surface = null, finding, severity = null, notes = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertPatient(tenantId, patientUid);
  if (!isValidFdiTooth(toothFdi)) {
    throw AppError.badRequest(
      `tooth_fdi "${toothFdi}" is not valid FDI notation (11-48 permanent, 51-85 deciduous)`,
      'DENTAL_FDI_INVALID',
    );
  }
  if (!FINDING_TYPES.includes(finding)) {
    throw AppError.badRequest(`finding must be one of: ${FINDING_TYPES.join(', ')}`, 'DENTAL_FINDING_INVALID');
  }
  if (surface && !SURFACES.includes(surface)) {
    throw AppError.badRequest(`surface must be one of: ${SURFACES.join(', ')}`, 'DENTAL_SURFACE_INVALID');
  }

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dental_tooth_findings
         (patient_uid, tooth_fdi, surface, finding, severity, noted_by, notes, tenant_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8::uuid)
       RETURNING *`,
      patientUid, String(toothFdi).trim(), surface, finding, severity, actorUid, notes,
      tenantOr(tenantId),
    );
    const row = rows[0];

    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid,
      eventType: 'dental.finding_recorded',
      sourceTable: 'dental_tooth_findings',
      sourceId: row.id,
      actorUid,
      actorRole,
      summary: `Dental finding: ${finding} on tooth ${toothFdi}${surface ? ` (${surface})` : ''}`,
      payload: { tooth_fdi: String(toothFdi), surface, finding, severity },
    }, { db: tx });

    return row;
  });
}

export async function resolveFinding(findingId, { tenantId, resolutionNote, procedureId = null }, { actorUid = null, actorRole = null } = {}) {
  if (!procedureId && (!resolutionNote || !String(resolutionNote).trim())) {
    throw AppError.badRequest('resolution_note required for manual resolution', 'DENTAL_RESOLUTION_NOTE_REQUIRED');
  }
  let procedure = null;
  if (procedureId) {
    const procedureRows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid
         FROM dental_procedures
        WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(procedureId),
      tenantOr(tenantId),
    );
    procedure = procedureRows[0] || null;
    if (!procedure) throw AppError.notFound('Procedure not found', 'DENTAL_PROCEDURE_NOT_FOUND');
  }
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE dental_tooth_findings
       SET status = 'resolved', resolved_at = NOW(),
           resolved_by_procedure_id = $2, resolution_note = $3, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $4::uuid AND status = 'active'
       RETURNING *`,
      Number(findingId),
      procedureId ? Number(procedureId) : null,
      resolutionNote ? String(resolutionNote).trim() : null,
      tenantOr(tenantId),
    );
    if (!rows.length) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT status FROM dental_tooth_findings WHERE id = $1 AND tenant_id = $2::uuid`,
        Number(findingId),
        tenantOr(tenantId),
      );
      if (!existing.length) throw AppError.notFound('Finding not found', 'DENTAL_FINDING_NOT_FOUND');
      throw AppError.invalidTransition(existing[0].status, 'resolved', ['active']);
    }
    const row = rows[0];
    if (procedure && String(procedure.patient_uid) !== String(row.patient_uid)) {
      throw AppError.badRequest('Procedure belongs to a different patient', 'DENTAL_PROCEDURE_PATIENT_MISMATCH');
    }

    await recordCanonicalClinicalEvent({
      tenantId: row.tenant_id,
      patientUid: row.patient_uid,
      eventType: 'dental.finding_resolved',
      sourceTable: 'dental_tooth_findings',
      sourceId: row.id,
      actorUid,
      actorRole,
      summary: `Dental finding resolved on tooth ${row.tooth_fdi} (${row.finding})`,
      payload: { tooth_fdi: row.tooth_fdi, finding: row.finding, procedure_id: procedureId },
    }, { db: tx });

    return row;
  });
}

/** Odontogram: per-tooth rollup of active findings + procedure history. */
export async function getChart(patientUid, { tenantId } = {}) {
  await assertPatient(tenantId, patientUid);
  const findings = await prisma.$queryRawUnsafe(
    `SELECT id, tooth_fdi, surface, finding, severity, status, recorded_at, notes
     FROM dental_tooth_findings
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'active'
     ORDER BY tooth_fdi, recorded_at`,
    tenantOr(tenantId),
    patientUid,
  );
  const procedures = await prisma.$queryRawUnsafe(
    `SELECT id, tooth_fdi, surface, procedure_name, procedure_code, status, performed_at
     FROM dental_procedures
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
     ORDER BY created_at DESC
     LIMIT 200`,
    tenantOr(tenantId),
    patientUid,
  );

  const teeth = {};
  for (const f of findings) {
    teeth[f.tooth_fdi] = teeth[f.tooth_fdi] || { findings: [], procedures: [] };
    teeth[f.tooth_fdi].findings.push(f);
  }
  for (const p of procedures) {
    if (!p.tooth_fdi) continue;
    teeth[p.tooth_fdi] = teeth[p.tooth_fdi] || { findings: [], procedures: [] };
    teeth[p.tooth_fdi].procedures.push(p);
  }
  return {
    patient_uid: patientUid,
    teeth,
    active_finding_count: findings.length,
    procedures,
  };
}

// ── procedures ───────────────────────────────────────────────────────────

export async function planProcedure({
  tenantId, patientUid, toothFdi = null, surface = null, findingId = null,
  procedureName, procedureCode = null, anesthesia = null, notes = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertPatient(tenantId, patientUid);
  if (!procedureName || !String(procedureName).trim()) {
    throw AppError.badRequest('procedure_name required', 'DENTAL_PROCEDURE_NAME_REQUIRED');
  }
  if (toothFdi !== null && !isValidFdiTooth(toothFdi)) {
    throw AppError.badRequest(`tooth_fdi "${toothFdi}" is not valid FDI notation`, 'DENTAL_FDI_INVALID');
  }
  if (surface && !SURFACES.includes(surface)) {
    throw AppError.badRequest(`surface must be one of: ${SURFACES.join(', ')}`, 'DENTAL_SURFACE_INVALID');
  }
  if (findingId) {
    const f = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status
         FROM dental_tooth_findings
        WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(findingId),
      tenantOr(tenantId),
    );
    if (!f.length) throw AppError.notFound('Linked finding not found', 'DENTAL_FINDING_NOT_FOUND');
    if (String(f[0].patient_uid) !== String(patientUid)) {
      throw AppError.badRequest('Linked finding belongs to a different patient', 'DENTAL_FINDING_PATIENT_MISMATCH');
    }
    if (f[0].status !== 'active') {
      throw AppError.invalidTransition(f[0].status, 'treating', ['active']);
    }
  }

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dental_procedures
         (patient_uid, tooth_fdi, surface, finding_id, procedure_name, procedure_code,
          anesthesia, notes, created_by, tenant_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::uuid)
       RETURNING *`,
      patientUid,
      toothFdi ? String(toothFdi).trim() : null,
      surface,
      findingId ? Number(findingId) : null,
      String(procedureName).trim(),
      procedureCode || null,
      anesthesia || null,
      notes || null,
      actorUid,
      tenantOr(tenantId),
    );
    const row = rows[0];

    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid,
      eventType: 'dental.procedure_planned',
      sourceTable: 'dental_procedures',
      sourceId: row.id,
      actorUid,
      actorRole,
      summary: `Dental procedure planned: ${row.procedure_name}${row.tooth_fdi ? ` (tooth ${row.tooth_fdi})` : ''}`,
      payload: { tooth_fdi: row.tooth_fdi, procedure_name: row.procedure_name, finding_id: row.finding_id },
    }, { db: tx });

    return row;
  });
}

export async function completeProcedure(procedureId, {
  tenantId, materials = null, anesthesia = null, notes = null,
}, { actorUid = null, actorRole = null } = {}) {
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE dental_procedures
       SET status = 'completed', performed_by = $2::uuid, performed_at = NOW(),
           materials = COALESCE($3, materials), anesthesia = COALESCE($4, anesthesia),
           notes = COALESCE($5, notes), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $6::uuid AND status IN ('planned', 'in_progress')
       RETURNING *`,
      Number(procedureId), actorUid, materials, anesthesia, notes, tenantOr(tenantId),
    );
    if (!rows.length) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT status FROM dental_procedures WHERE id = $1 AND tenant_id = $2::uuid`,
        Number(procedureId),
        tenantOr(tenantId),
      );
      if (!existing.length) throw AppError.notFound('Procedure not found', 'DENTAL_PROCEDURE_NOT_FOUND');
      throw AppError.invalidTransition(existing[0].status, 'completed', ['planned', 'in_progress']);
    }
    const row = rows[0];

    // Close the loop: treating procedure resolves its finding.
    if (row.finding_id) {
      await tx.$queryRawUnsafe(
        `UPDATE dental_tooth_findings
         SET status = 'resolved', resolved_at = NOW(), resolved_by_procedure_id = $2,
             resolution_note = $3, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $4::uuid AND status = 'active'`,
        row.finding_id, row.id, `Treated by ${row.procedure_name}`, tenantOr(tenantId),
      );
    }

    await recordCanonicalClinicalEvent({
      tenantId: row.tenant_id,
      patientUid: row.patient_uid,
      eventType: 'dental.procedure_completed',
      sourceTable: 'dental_procedures',
      sourceId: row.id,
      actorUid,
      actorRole,
      summary: `Dental procedure completed: ${row.procedure_name}${row.tooth_fdi ? ` (tooth ${row.tooth_fdi})` : ''}`,
      payload: {
        tooth_fdi: row.tooth_fdi, procedure_name: row.procedure_name,
        finding_id: row.finding_id, materials: row.materials,
      },
    }, { db: tx });

    return row;
  });
}

export async function cancelProcedure(procedureId, { tenantId, reason }) {
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('Cancellation reason required', 'DENTAL_CANCEL_REASON_REQUIRED');
  }
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE dental_procedures
       SET status = 'cancelled', cancelled_reason = $2, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3::uuid AND status IN ('planned', 'in_progress')
       RETURNING id, status, cancelled_reason`,
      Number(procedureId), String(reason).trim(), tenantOr(tenantId),
    );
    if (!rows.length) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT status FROM dental_procedures WHERE id = $1 AND tenant_id = $2::uuid`,
        Number(procedureId),
        tenantOr(tenantId),
      );
      if (!existing.length) throw AppError.notFound('Procedure not found', 'DENTAL_PROCEDURE_NOT_FOUND');
      throw AppError.invalidTransition(existing[0].status, 'cancelled', ['planned', 'in_progress']);
    }
    return rows[0];
  });
}

export async function listProcedures(patientUid, { tenantId, status = null } = {}) {
  await assertPatient(tenantId, patientUid);
  const params = [tenantOr(tenantId), patientUid];
  let where = 'WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT * FROM dental_procedures ${where} ORDER BY created_at DESC LIMIT 200`,
    ...params,
  );
}

export default {
  isValidFdiTooth,
  recordToothFinding,
  resolveFinding,
  getChart,
  planProcedure,
  completeProcedure,
  cancelProcedure,
  listProcedures,
};
