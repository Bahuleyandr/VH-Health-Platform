// src/services/clinical/medicationReconciliationService.js
//
// Roadmap B6 — formal three-point medication reconciliation.
//
// Lifecycle: startReconciliation() snapshots the patient's medication
// sources (home/chronic meds, active prescriptions, inpatient MAR) into
// per-drug items; clinicians decide each item (continue/stop/change/new/
// hold + reason); completeReconciliation() requires every item decided and
// — for discharge recs — emits the take-home list.
//
// Canonical invariant: start/complete write timeline + audit events in the
// same transaction; per-item decisions write clinical_audit_events.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
  recordMedicationSafetyReviews,
} from './canonicalClinicalPlatformService.js';

export const REC_TYPES = Object.freeze(['admission', 'transfer', 'discharge']);
export const ITEM_DECISIONS = Object.freeze(['continue', 'stop', 'change', 'new', 'hold']);

function tenantIdFromContext(context = {}) {
  return context.tenantId || context.tenant_id || null;
}

/**
 * Normalize one medication entry from any source (string or object) into
 * the item shape. Pure — exported for unit tests.
 */
export function normalizeMedicationEntry(entry, source, sourceRef = null) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { medication_name: name, dose: null, frequency: null, route: null, source, source_ref: sourceRef } : null;
  }
  const name = (entry.name || entry.medication_name || entry.drug_name || '').trim();
  if (!name) return null;
  return {
    medication_name: name,
    dose: entry.dose || entry.dosage || entry.strength || null,
    frequency: entry.frequency || entry.freq || entry.timing || null,
    route: entry.route || null,
    source,
    source_ref: sourceRef,
  };
}

/**
 * Merge medication lists, deduping case-insensitively by name and keeping
 * the FIRST occurrence (source priority = caller's ordering). Pure —
 * exported for unit tests.
 */
export function mergeMedicationLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item?.medication_name) continue;
      const key = item.medication_name.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Gather the medication sources a reconciliation starts from.
 * Returns { home, active_prescriptions, inpatient_mar } arrays of items.
 */
export async function gatherMedicationSources(patientUid, { tenantId = null } = {}) {
  const patientParams = tenantId ? [patientUid, tenantId] : [patientUid];
  const userTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const prescriptionTenantFilter = tenantId ? ' AND u.tenant_id = $2::uuid AND ep.tenant_id = $2::uuid' : '';
  const marTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const [patientRows, prescriptionRows, marRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, chronic_medications FROM users WHERE uid = $1::uuid${userTenantFilter} LIMIT 1`,
      ...patientParams,
    ),
    prisma.$queryRawUnsafe(
      `SELECT ep.id,
              COALESCE(NULLIF(TRIM(ep.medication_name), ''), NULLIF(TRIM(med.value->>'name'), ''),
                       NULLIF(TRIM(med.value->>'medication_name'), '')) AS name,
              COALESCE(med.value->>'dose', med.value->>'dosage') AS dose,
              med.value->>'frequency' AS frequency,
              med.value->>'route' AS route
         FROM e_prescriptions ep
         LEFT JOIN LATERAL jsonb_array_elements(COALESCE(ep.medications, '[]'::jsonb)) AS med(value) ON TRUE
         JOIN users u ON u.id = ep.patient_id
        WHERE u.uid = $1::uuid
          ${prescriptionTenantFilter}
          AND LOWER(COALESCE(ep.status, 'active')) IN ('active', 'pharmacy_linked')
          AND (ep.follow_up_date IS NULL OR ep.follow_up_date >= CURRENT_DATE)`,
      ...patientParams,
    ),
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (lower(medication_name)) id, medication_name, dose, route
         FROM medication_administrations
        WHERE patient_uid = $1::uuid
          ${marTenantFilter}
          AND status IN ('scheduled', 'held')
          AND scheduled_time >= NOW() - INTERVAL '7 days'
        ORDER BY lower(medication_name), scheduled_time DESC`,
      ...patientParams,
    ),
  ]);

  const chronic = patientRows[0]?.chronic_medications;
  const chronicList = Array.isArray(chronic) ? chronic
    : (typeof chronic === 'string' && chronic.trim() ? chronic.split(/[,;\n]/) : []);

  return {
    home: chronicList
      .map((entry) => normalizeMedicationEntry(entry, 'home', 'users.chronic_medications'))
      .filter(Boolean),
    active_prescriptions: prescriptionRows
      .map((row) => normalizeMedicationEntry(row, 'active_prescription', `e_prescriptions:${row.id}`))
      .filter(Boolean),
    inpatient_mar: marRows
      .map((row) => normalizeMedicationEntry(row, 'inpatient', `medication_administrations:${row.id}`))
      .filter(Boolean),
  };
}

const REC_COLUMNS = `
  id, tenant_id, patient_uid, patient_id, admission_id, encounter_id, rec_type, status,
  transfer_context, source_lists, notes, started_by, started_at, completed_by, completed_at,
  metadata, created_at, updated_at`;

export async function getReconciliation(recId, { includeItems = true, tenantId = null } = {}) {
  const params = [recId];
  let tenantFilter = '';
  if (tenantId) {
    params.push(tenantId);
    tenantFilter = ` AND tenant_id = $${params.length}::uuid`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${REC_COLUMNS} FROM medication_reconciliations WHERE id = $1::uuid${tenantFilter} LIMIT 1`,
    ...params,
  );
  const rec = rows[0] || null;
  if (!rec || !includeItems) return rec;
  const itemParams = tenantId ? [recId, tenantId] : [recId];
  const itemTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, medication_name, dose, frequency, route, source, source_ref,
            decision, decision_reason, new_instructions,
            changed_dose, changed_route, changed_frequency, safety_review_id,
            decided_by, decided_at
       FROM medication_reconciliation_items
      WHERE reconciliation_id = $1::uuid${itemTenantFilter}
      ORDER BY id`,
    ...itemParams,
  );
  return { ...rec, items };
}

export async function listReconciliations(patientUid, { recType = null, tenantId = null } = {}) {
  const params = [patientUid];
  let where = `patient_uid = $1::uuid`;
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}::uuid`;
  }
  if (recType) {
    if (!REC_TYPES.includes(recType)) {
      throw AppError.badRequest(`rec_type must be one of ${REC_TYPES.join(', ')}`, 'MEDREC_BAD_TYPE');
    }
    params.push(recType);
    where += ` AND rec_type = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT ${REC_COLUMNS},
            (SELECT COUNT(*)::int FROM medication_reconciliation_items i WHERE i.reconciliation_id = medication_reconciliations.id) AS item_count,
            (SELECT COUNT(*)::int FROM medication_reconciliation_items i WHERE i.reconciliation_id = medication_reconciliations.id AND i.decision IS NULL) AS undecided_count
       FROM medication_reconciliations
      WHERE ${where}
      ORDER BY created_at DESC`,
    ...params,
  );
}

export async function startReconciliation({
  patientUid, recType, admissionId = null, encounterId = null, transferContext = null, notes = null,
} = {}, context = {}) {
  if (!REC_TYPES.includes(recType)) {
    throw AppError.badRequest(`rec_type must be one of ${REC_TYPES.join(', ')}`, 'MEDREC_BAD_TYPE');
  }
  const tenantId = tenantIdFromContext(context);
  const patientParams = tenantId ? [patientUid, tenantId] : [patientUid];
  const patientTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const patients = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id FROM users WHERE uid = $1::uuid${patientTenantFilter} AND role = 'PATIENT' LIMIT 1`,
    ...patientParams,
  );
  const patient = patients[0];
  if (!patient) throw AppError.notFound('Patient not found', 'MEDREC_PATIENT_NOT_FOUND');

  const open = await prisma.$queryRawUnsafe(
    `SELECT id FROM medication_reconciliations
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND rec_type = $3
        AND COALESCE(admission_id, 0) = COALESCE($4::int, 0)
        AND status = 'in_progress'
      LIMIT 1`,
    patient.tenant_id, patientUid, recType, admissionId,
  );
  if (open.length > 0) {
    throw AppError.conflict(
      `An in-progress ${recType} reconciliation already exists for this patient`,
      'MEDREC_ALREADY_OPEN',
      { reconciliation_id: open[0].id },
    );
  }

  const sources = await gatherMedicationSources(patientUid, { tenantId: patient.tenant_id });
  // Item ordering encodes source priority per rec type: admission starts
  // from home meds; transfer/discharge start from what is actually running.
  const orderedLists = recType === 'admission'
    ? [sources.home, sources.active_prescriptions, sources.inpatient_mar]
    : [sources.inpatient_mar, sources.active_prescriptions, sources.home];
  const items = mergeMedicationLists(...orderedLists);

  const rec = await prisma.$transaction(async (tx) => {
    const recRows = await tx.$queryRawUnsafe(
      `INSERT INTO medication_reconciliations
         (patient_uid, patient_id, tenant_id, admission_id, encounter_id, rec_type,
          transfer_context, source_lists, notes, started_by)
       VALUES ($1::uuid, $2, COALESCE($3::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
               $4::int, $5::uuid, $6, $7, $8::jsonb, $9, $10::uuid)
       RETURNING ${REC_COLUMNS}`,
      patientUid,
      patient.id,
      patient.tenant_id || null,
      admissionId,
      encounterId,
      recType,
      transferContext,
      JSON.stringify(sources),
      notes,
      context.actorUid || null,
    );
    const created = recRows[0];

    for (const item of items) {
      await tx.$queryRawUnsafe(
        `INSERT INTO medication_reconciliation_items
           (reconciliation_id, tenant_id, medication_name, dose, frequency, route, source, source_ref)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
        created.id,
        created.tenant_id,
        item.medication_name,
        item.dose,
        item.frequency,
        item.route,
        item.source,
        item.source_ref,
      );
    }

    await recordCanonicalClinicalEvent({
      tenantId: created.tenant_id,
      patientUid,
      encounterId,
      eventType: 'medrec.started',
      eventStatus: 'in_progress',
      sourceTable: 'medication_reconciliations',
      sourceId: String(created.id),
      resourceType: 'medication_reconciliation',
      resourceId: String(created.id),
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      summary: `${recType} medication reconciliation started (${items.length} medication(s) on the table)`,
      payload: {
        reconciliation_id: created.id,
        rec_type: recType,
        admission_id: admissionId,
        transfer_context: transferContext,
        item_count: items.length,
        source_counts: {
          home: sources.home.length,
          active_prescriptions: sources.active_prescriptions.length,
          inpatient_mar: sources.inpatient_mar.length,
        },
      },
      afterState: { status: 'in_progress' },
      tags: ['medication', 'med-rec', recType],
      timelineIdempotencyKey: `medication_reconciliations:${created.id}:medrec.started`,
      auditIdempotencyKey: `medication_reconciliations:${created.id}:audit:medrec.started`,
    }, { db: tx });

    return created;
  });

  return getReconciliation(rec.id, { tenantId: patient.tenant_id });
}

/**
 * Build the structured change-detail object for a `change` decision, pulling
 * the "to" side from the explicit changed_* fields and the "from" side from
 * the item's snapshot. Pure — exported for unit tests.
 */
export function buildChangeDetail(item, { changedDose, changedRoute, changedFrequency } = {}) {
  const detail = {};
  const pairs = [
    ['dose', item?.dose ?? null, changedDose],
    ['route', item?.route ?? null, changedRoute],
    ['frequency', item?.frequency ?? null, changedFrequency],
  ];
  for (const [field, from, to] of pairs) {
    if (to != null && String(to).trim() !== '') {
      detail[field] = { from, to: String(to).trim() };
    }
  }
  return detail;
}

export async function decideItem(recId, itemId, {
  decision, reason = null, newInstructions = null,
  changedDose = null, changedRoute = null, changedFrequency = null,
  safetyRationale = null,
} = {}, context = {}) {
  if (!ITEM_DECISIONS.includes(decision)) {
    throw AppError.badRequest(`decision must be one of ${ITEM_DECISIONS.join(', ')}`, 'MEDREC_BAD_DECISION');
  }
  if (['stop', 'change', 'hold'].includes(decision) && !(reason || '').trim()) {
    throw AppError.badRequest(`decision '${decision}' requires a reason`, 'MEDREC_REASON_REQUIRED');
  }
  const hasStructuredChange = [changedDose, changedRoute, changedFrequency]
    .some((v) => v != null && String(v).trim() !== '');
  // A `change` must spell out WHAT changed: either structured dose/route/
  // frequency detail or free-text instructions (or both).
  if (decision === 'change' && !hasStructuredChange && !(newInstructions || '').trim()) {
    throw AppError.badRequest(
      "decision 'change' requires change detail (changed_dose/changed_route/changed_frequency or new_instructions)",
      'MEDREC_CHANGE_DETAIL_REQUIRED',
    );
  }
  // Structured change detail only makes sense on a `change`.
  if (decision !== 'change' && hasStructuredChange) {
    throw AppError.badRequest(
      'changed_dose/changed_route/changed_frequency are only valid for a change decision',
      'MEDREC_CHANGE_DETAIL_UNEXPECTED',
    );
  }
  const rec = await getReconciliation(recId, { includeItems: false, tenantId: tenantIdFromContext(context) });
  if (!rec) throw AppError.notFound('Reconciliation not found', 'MEDREC_NOT_FOUND');
  if (rec.status !== 'in_progress') {
    throw AppError.conflict(`Reconciliation is ${rec.status} — decisions are frozen`, 'MEDREC_NOT_OPEN');
  }

  // Look up the item first so the safety review (recorded BEFORE the row is
  // stamped, to capture its id) can carry the medication name.
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id, medication_name, dose, frequency, route, source
       FROM medication_reconciliation_items
      WHERE id = $1::int AND reconciliation_id = $2::uuid AND tenant_id = $3::uuid
      LIMIT 1`,
    itemId,
    recId,
    rec.tenant_id,
  );
  const existing = existingRows[0];
  if (!existing) throw AppError.notFound('Reconciliation item not found', 'MEDREC_ITEM_NOT_FOUND');

  const changeDetail = decision === 'change'
    ? buildChangeDetail(existing, { changedDose, changedRoute, changedFrequency })
    : {};
  // A medication_safety_reviews row is wired when a stop/change carries a
  // clinical safety rationale (e.g. nephrotoxicity, duplicate therapy,
  // interaction). The reconciliation reason itself is the workflow reason;
  // safetyRationale is the explicit safety-significant justification.
  const wantsSafetyReview = ['stop', 'change'].includes(decision)
    && !!(safetyRationale || '').trim();

  const item = await prisma.$transaction(async (tx) => {
    let safetyReviewId = null;
    if (wantsSafetyReview) {
      const reviews = await recordMedicationSafetyReviews({
        tenantId: rec.tenant_id,
        patientUid: rec.patient_uid,
        patientId: rec.patient_id,
        encounterId: rec.encounter_id,
        actorUid: context.actorUid || null,
        safety: {
          safe: false,
          blockers: [],
          warnings: [{
            type: 'med_rec_change',
            severity: 'medium',
            medication_name: existing.medication_name,
            message: safetyRationale.trim(),
            reconciliation_id: recId,
            decision,
          }],
        },
      }, { db: tx });
      safetyReviewId = reviews[0]?.id || null;
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE medication_reconciliation_items SET
         decision = $3, decision_reason = $4, new_instructions = $5,
         changed_dose = $6, changed_route = $7, changed_frequency = $8,
         safety_review_id = COALESCE($9::uuid, safety_review_id),
         decided_by = $10::uuid, decided_at = NOW(), updated_at = NOW()
       WHERE id = $2::int AND reconciliation_id = $1::uuid
         AND tenant_id = $11::uuid
       RETURNING id, medication_name, dose, frequency, route, source, decision,
                 decision_reason, new_instructions, changed_dose, changed_route,
                 changed_frequency, safety_review_id, decided_by, decided_at`,
      recId,
      itemId,
      decision,
      reason,
      newInstructions,
      decision === 'change' ? changedDose : null,
      decision === 'change' ? changedRoute : null,
      decision === 'change' ? changedFrequency : null,
      safetyReviewId,
      context.actorUid || null,
      rec.tenant_id,
    );
    const updated = updatedRows[0];
    if (!updated) throw AppError.notFound('Reconciliation item not found', 'MEDREC_ITEM_NOT_FOUND');

    await recordClinicalAuditEvent({
      tenantId: rec.tenant_id,
      patientUid: rec.patient_uid,
      encounterId: rec.encounter_id,
      action: 'medrec.item_decided',
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      resourceType: 'medication_reconciliation_item',
      resourceTable: 'medication_reconciliation_items',
      resourceId: String(updated.id),
      afterState: {
        decision,
        reason,
        new_instructions: newInstructions,
        change_detail: changeDetail,
        safety_review_id: safetyReviewId,
      },
      metadata: {
        reconciliation_id: recId,
        rec_type: rec.rec_type,
        medication_name: updated.medication_name,
        safety_review_recorded: !!safetyReviewId,
      },
      idempotencyKey: `medication_reconciliation_items:${updated.id}:decided:${decision}:${Date.now()}`,
    }, { db: tx });

    return updated;
  });

  return { ...item, change_detail: changeDetail };
}

export async function completeReconciliation(recId, context = {}) {
  const rec = await getReconciliation(recId, { tenantId: tenantIdFromContext(context) });
  if (!rec) throw AppError.notFound('Reconciliation not found', 'MEDREC_NOT_FOUND');
  if (rec.status !== 'in_progress') {
    throw AppError.conflict(`Reconciliation is already ${rec.status}`, 'MEDREC_NOT_OPEN');
  }
  const undecided = rec.items.filter((i) => !i.decision);
  if (undecided.length > 0) {
    throw AppError.conflict(
      `${undecided.length} medication(s) still undecided — every drug needs an explicit decision before completion`,
      'MEDREC_UNDECIDED_ITEMS',
      { undecided: undecided.map((i) => ({ id: i.id, medication_name: i.medication_name })) },
    );
  }

  const counts = {};
  for (const item of rec.items) counts[item.decision] = (counts[item.decision] || 0) + 1;
  const takeHomeList = rec.rec_type === 'discharge'
    ? rec.items
      .filter((i) => ['continue', 'change', 'new'].includes(i.decision))
      .map((i) => ({
        medication_name: i.medication_name,
        // For a `change`, the take-home dose/route/frequency is the new
        // ("to") value where supplied, falling back to the source value.
        dose: i.decision === 'change' ? (i.changed_dose ?? i.dose) : i.dose,
        frequency: i.decision === 'change' ? (i.changed_frequency ?? i.frequency) : i.frequency,
        route: i.decision === 'change' ? (i.changed_route ?? i.route) : i.route,
        decision: i.decision,
        instructions: i.new_instructions || null,
        change_detail: i.decision === 'change'
          ? buildChangeDetail(i, {
            changedDose: i.changed_dose,
            changedRoute: i.changed_route,
            changedFrequency: i.changed_frequency,
          })
          : null,
        safety_review_id: i.safety_review_id || null,
      }))
    : null;

  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE medication_reconciliations SET
         status = 'completed', completed_by = $2::uuid, completed_at = NOW(),
         metadata = metadata || $3::jsonb, updated_at = NOW()
       WHERE id = $1::uuid AND status = 'in_progress' AND tenant_id = $4::uuid
       RETURNING ${REC_COLUMNS}`,
      recId,
      context.actorUid || null,
      JSON.stringify({ decision_counts: counts, take_home_list: takeHomeList }),
      rec.tenant_id,
    );
    const row = rows[0];
    if (!row) throw AppError.conflict('Reconciliation was completed concurrently', 'MEDREC_NOT_OPEN');

    await recordCanonicalClinicalEvent({
      tenantId: row.tenant_id,
      patientUid: row.patient_uid,
      encounterId: row.encounter_id,
      eventType: 'medrec.completed',
      eventStatus: 'completed',
      sourceTable: 'medication_reconciliations',
      sourceId: String(row.id),
      resourceType: 'medication_reconciliation',
      resourceId: String(row.id),
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      summary: `${row.rec_type} medication reconciliation completed (${rec.items.length} drug(s): `
        + `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`,
      payload: {
        reconciliation_id: row.id,
        rec_type: row.rec_type,
        decision_counts: counts,
        take_home_list: takeHomeList,
        item_count: rec.items.length,
      },
      beforeState: { status: 'in_progress' },
      afterState: { status: 'completed' },
      tags: ['medication', 'med-rec', row.rec_type],
      timelineIdempotencyKey: `medication_reconciliations:${row.id}:medrec.completed`,
      auditIdempotencyKey: `medication_reconciliations:${row.id}:audit:medrec.completed`,
    }, { db: tx });

    return row;
  });

  logger.info('Medication reconciliation completed', {
    reconciliation_id: recId, rec_type: updated.rec_type, counts,
  });
  return { ...updated, items: rec.items, take_home_list: takeHomeList, decision_counts: counts };
}

export default {
  REC_TYPES,
  ITEM_DECISIONS,
  normalizeMedicationEntry,
  mergeMedicationLists,
  buildChangeDetail,
  gatherMedicationSources,
  getReconciliation,
  listReconciliations,
  startReconciliation,
  decideItem,
  completeReconciliation,
};
