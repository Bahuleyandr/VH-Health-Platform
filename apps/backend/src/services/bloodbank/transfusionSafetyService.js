// src/services/bloodbank/transfusionSafetyService.js
//
// Roadmap B5 — the transfusion closed loop around the existing
// bloodBankService request lifecycle:
//
//   register unit → crossmatch pins a SPECIFIC unit to the request →
//   issue (existing) → TWO-PERSON bedside verification (scan unit +
//   wristband, ABO/Rh + expiry verdicts, override audited) → start →
//   complete → structured reaction reporting (hemovigilance).
//
// Every step emits canonical timeline + audit events in-transaction.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

export const TRANSFUSION_REQUIRE_BEDSIDE_VERIFICATION =
  process.env.TRANSFUSION_REQUIRE_BEDSIDE_VERIFICATION !== 'false';

const VALID_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for transfusion operations', 'TRANSFUSION_TENANT_REQUIRED');
  }
  return tenantId;
}

// Red-cell donor compatibility: recipient → acceptable donor groups.
const RBC_COMPATIBLE_DONORS = Object.freeze({
  'O-': ['O-'],
  'O+': ['O-', 'O+'],
  'A-': ['A-', 'O-'],
  'A+': ['A+', 'A-', 'O+', 'O-'],
  'B-': ['B-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'],
  'AB-': ['AB-', 'A-', 'B-', 'O-'],
  'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
});

// Plasma compatibility is inverted (AB = universal plasma donor); Rh is
// not clinically significant for plasma. recipient ABO → donor ABO list.
const PLASMA_COMPATIBLE_DONORS = Object.freeze({
  O: ['O', 'A', 'B', 'AB'],
  A: ['A', 'AB'],
  B: ['B', 'AB'],
  AB: ['AB'],
});

function abo(group) {
  return String(group || '').replace(/[+-]$/, '');
}

/**
 * ABO/Rh compatibility verdict for a unit against a recipient, by
 * component. Pure — exported for unit tests.
 * Returns { compatible, mode } where mode ∈ identical|compatible|caution.
 */
export function checkUnitCompatibility(unitGroup, recipientGroup, component = 'prbc') {
  if (!VALID_GROUPS.includes(unitGroup) || !VALID_GROUPS.includes(recipientGroup)) {
    return { compatible: false, mode: 'unknown_group' };
  }
  if (unitGroup === recipientGroup) return { compatible: true, mode: 'identical' };
  const comp = String(component || 'prbc').toLowerCase();
  if (comp === 'prbc' || comp === 'whole_blood') {
    if (comp === 'whole_blood') return { compatible: false, mode: 'incompatible' }; // identical only
    const ok = (RBC_COMPATIBLE_DONORS[recipientGroup] || []).includes(unitGroup);
    return { compatible: ok, mode: ok ? 'compatible' : 'incompatible' };
  }
  if (comp === 'ffp' || comp === 'cryoprecipitate') {
    const ok = (PLASMA_COMPATIBLE_DONORS[abo(recipientGroup)] || []).includes(abo(unitGroup));
    return { compatible: ok, mode: ok ? 'compatible' : 'incompatible' };
  }
  // Platelets: ABO-identical preferred; mismatched is practiced under
  // pressure → caution (verification surfaces it; clinician may override).
  return { compatible: false, mode: 'caution' };
}

async function emitTransfusionEvent(db, request, eventType, {
  actorUid = null, actorRole = null, summary, payload = {}, beforeStatus = null, afterStatus = null,
}) {
  await recordCanonicalClinicalEvent({
    tenantId: request.tenant_id,
    patientUid: request.patient_uid,
    encounterId: request.encounter_id || null,
    eventType,
    eventStatus: afterStatus || request.status,
    sourceTable: 'blood_requests',
    sourceId: String(request.id),
    resourceType: 'transfusion',
    resourceId: String(request.id),
    actorUid,
    actorRole,
    summary,
    payload: { blood_request_id: request.id, blood_group: request.blood_group, component: request.component, ...payload },
    beforeState: beforeStatus ? { status: beforeStatus } : null,
    afterState: afterStatus ? { status: afterStatus } : null,
    tags: ['transfusion', 'blood-bank'],
    timelineIdempotencyKey: `blood_requests:${request.id}:${eventType}:${Date.now()}`,
    auditIdempotencyKey: `blood_requests:${request.id}:audit:${eventType}:${Date.now()}`,
  }, { db });
}

async function loadRequest(requestId, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, blood_group, component, units, status,
            cross_match_status, crossmatched_unit_id, transfusion_started_at
       FROM blood_requests WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    requestId,
    tenantId,
  );
  return rows[0] || null;
}

export async function registerUnit({
  unitNumber, bloodGroup, component = 'prbc', expiryDate, collectedDate = null,
  volumeMl = null, donorRef = null, sourceBloodBank = null,
} = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const cleanedNumber = (unitNumber || '').trim().toUpperCase();
  if (!cleanedNumber) throw AppError.badRequest('unit_number is required', 'BLOOD_UNIT_NUMBER_REQUIRED');
  if (!VALID_GROUPS.includes(bloodGroup)) {
    throw AppError.badRequest(`blood_group must be one of ${VALID_GROUPS.join(', ')}`, 'BLOOD_UNIT_BAD_GROUP');
  }
  if (!expiryDate) throw AppError.badRequest('expiry_date is required', 'BLOOD_UNIT_EXPIRY_REQUIRED');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO blood_units
       (tenant_id, unit_number, blood_group, component, expiry_date, collected_date, volume_ml,
        donor_ref, source_blood_bank, registered_by)
     VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::int, $8, $9, $10::uuid)
     ON CONFLICT (tenant_id, unit_number) DO UPDATE SET updated_at = NOW()
     RETURNING id, unit_number, blood_group, component, status, expiry_date, created_at`,
    tenantId, cleanedNumber, bloodGroup, String(component).toLowerCase(), expiryDate, collectedDate,
    volumeMl, donorRef, sourceBloodBank, context.actorUid || null,
  );
  return rows[0];
}

export async function listUnits({ status = null, bloodGroup = null, component = null } = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const conditions = ['tenant_id = $1::uuid'];
  const params = [tenantId];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (bloodGroup) { params.push(bloodGroup); conditions.push(`blood_group = $${params.length}`); }
  if (component) { params.push(String(component).toLowerCase()); conditions.push(`component = $${params.length}`); }
  return prisma.$queryRawUnsafe(
    `SELECT id, unit_number, blood_group, component, status, volume_ml, collected_date,
            expiry_date, source_blood_bank, request_id, created_at
       FROM blood_units WHERE ${conditions.join(' AND ')}
      ORDER BY expiry_date ASC, id ASC LIMIT 200`,
    ...params,
  );
}

/**
 * Crossmatch a SPECIFIC unit against a request (replaces the unit-less
 * legacy crossMatch for the closed loop). Incompatible ABO/Rh per the
 * matrix cannot be recorded as compatible without an override reason.
 */
export async function crossmatchUnit(requestId, {
  unitId, result, overrideReason = null,
} = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  if (!['compatible', 'incompatible'].includes(result)) {
    throw AppError.badRequest('result must be compatible|incompatible', 'TRANSFUSION_BAD_CROSSMATCH');
  }
  const request = await loadRequest(requestId, tenantId);
  if (!request) throw AppError.notFound('Blood request not found');
  if (request.status !== 'requested') {
    throw AppError.conflict(`Crossmatch happens at status 'requested' (current: ${request.status})`, 'TRANSFUSION_WRONG_STATUS');
  }
  const units = await prisma.$queryRawUnsafe(
    `SELECT id, unit_number, blood_group, component, status, expiry_date
       FROM blood_units WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    unitId,
    tenantId,
  );
  const unit = units[0];
  if (!unit) throw AppError.notFound('Blood unit not found', 'BLOOD_UNIT_NOT_FOUND');
  if (!['available', 'reserved'].includes(unit.status)) {
    throw AppError.conflict(`Unit ${unit.unit_number} is ${unit.status}`, 'BLOOD_UNIT_UNAVAILABLE');
  }
  if (new Date(unit.expiry_date) < new Date(new Date().toDateString())) {
    throw AppError.conflict(`Unit ${unit.unit_number} expired on ${unit.expiry_date}`, 'BLOOD_UNIT_EXPIRED');
  }

  const verdict = checkUnitCompatibility(unit.blood_group, request.blood_group, request.component);
  if (result === 'compatible' && !verdict.compatible && !(overrideReason || '').trim()) {
    throw AppError.conflict(
      `ABO/Rh matrix marks ${unit.blood_group} ${request.component} ${verdict.mode} for a ${request.blood_group} recipient — recording 'compatible' requires an override reason`,
      'TRANSFUSION_ABO_MATRIX_CONFLICT',
      { matrix_verdict: verdict },
    );
  }

  const isCompatible = result === 'compatible';
  const updated = await setTenantTx(tenantId, async (tx) => {
    const reqRows = await tx.$queryRawUnsafe(
      `UPDATE blood_requests SET
         cross_match_status = $2, cross_matched_by = $3::uuid, cross_matched_at = NOW(),
         status = CASE WHEN $5::boolean THEN 'cross_matched' ELSE status END,
         crossmatched_unit_id = CASE WHEN $5::boolean THEN $4::int ELSE crossmatched_unit_id END,
         updated_at = NOW()
       WHERE id = $1 AND tenant_id = $6::uuid
       RETURNING id, tenant_id, patient_uid, encounter_id, blood_group, component, status, cross_match_status, crossmatched_unit_id`,
      requestId, result, context.actorUid || null, unit.id, isCompatible, tenantId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE blood_units SET
         status = CASE WHEN $2::boolean THEN 'crossmatched' ELSE 'available' END,
         request_id = CASE WHEN $2::boolean THEN $3::int ELSE NULL END,
         updated_at = NOW()
       WHERE id = $1 AND tenant_id = $4::uuid`,
      unit.id, isCompatible, requestId, tenantId,
    );
    await emitTransfusionEvent(tx, reqRows[0], 'transfusion.crossmatched', {
      actorUid: context.actorUid, actorRole: context.actorRole,
      summary: `Crossmatch ${result}: unit ${unit.unit_number} (${unit.blood_group}) for ${request.blood_group} recipient`,
      payload: {
        unit_id: unit.id, unit_number: unit.unit_number, unit_group: unit.blood_group,
        result, matrix_verdict: verdict, override_reason: (overrideReason || '').trim() || null,
      },
      beforeStatus: 'requested',
      afterStatus: reqRows[0].status,
    });
    return reqRows[0];
  });
  return { request: updated, unit: { id: unit.id, unit_number: unit.unit_number }, matrix_verdict: verdict };
}

/**
 * Two-person bedside verification. Each verifier scans the unit number and
 * the patient wristband; the platform computes the verdicts. The second
 * verifier must be a different person.
 */
export async function recordBedsideVerification(requestId, {
  verifierRole, scannedUnitNumber, scannedPatientUid, overrideReason = null,
} = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  if (!['first', 'second'].includes(verifierRole)) {
    throw AppError.badRequest("verifier_role must be 'first' or 'second'", 'TRANSFUSION_BAD_VERIFIER_ROLE');
  }
  if (!context.actorUid) throw AppError.unauthorized('Verifier identity missing');
  const request = await loadRequest(requestId, tenantId);
  if (!request) throw AppError.notFound('Blood request not found');
  if (request.status !== 'issued') {
    throw AppError.conflict(`Bedside verification happens after issue (current: ${request.status})`, 'TRANSFUSION_WRONG_STATUS');
  }
  if (!request.crossmatched_unit_id) {
    throw AppError.conflict('No unit pinned at crossmatch — use the unit-level crossmatch flow', 'TRANSFUSION_NO_UNIT');
  }
  const units = await prisma.$queryRawUnsafe(
    `SELECT id, unit_number, blood_group, component, expiry_date
       FROM blood_units WHERE id = $1 AND tenant_id = $2::uuid`,
    request.crossmatched_unit_id,
    tenantId,
  );
  const unit = units[0];
  if (!unit) throw AppError.conflict('Crossmatched unit record vanished', 'TRANSFUSION_NO_UNIT');

  if (verifierRole === 'second') {
    const first = await prisma.$queryRawUnsafe(
      `SELECT verified_by FROM transfusion_verifications
        WHERE request_id = $1 AND tenant_id = $2::uuid AND verifier_role = 'first'`,
      requestId,
      tenantId,
    );
    if (!first.length) {
      throw AppError.conflict('First verification must be recorded before the second', 'TRANSFUSION_FIRST_VERIFICATION_MISSING');
    }
    if (String(first[0].verified_by) === String(context.actorUid)) {
      throw AppError.conflict('Second verifier must be a different person', 'TRANSFUSION_SAME_VERIFIER');
    }
  }

  const unitMatch = (scannedUnitNumber || '').trim().toUpperCase() === unit.unit_number.toUpperCase();
  const patientMatch = String(scannedPatientUid || '').toLowerCase() === String(request.patient_uid).toLowerCase();
  const compat = checkUnitCompatibility(unit.blood_group, request.blood_group, request.component);
  const expiryOk = new Date(unit.expiry_date) >= new Date(new Date().toDateString());
  const allPassed = unitMatch && patientMatch && compat.compatible && expiryOk;
  const trimmedOverride = (overrideReason || '').trim() || null;

  if (!allPassed && !trimmedOverride) {
    throw AppError.conflict('Bedside verification failed', 'TRANSFUSION_VERIFICATION_FAILED', {
      checks: { unit_match: unitMatch, patient_match: patientMatch, group_compatible: compat.compatible, expiry_ok: expiryOk },
      matrix_verdict: compat,
    });
  }

  const verification = await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transfusion_verifications
         (tenant_id, request_id, unit_id, verifier_role, verified_by, scanned_unit_number,
          scanned_patient_uid, unit_match, patient_match, group_compatible, expiry_ok,
          all_checks_passed, override_reason)
       VALUES ($1::uuid, $2::int, $3::int, $4, $5::uuid, $6, $7::uuid, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (request_id, verifier_role) DO UPDATE SET
         unit_id = EXCLUDED.unit_id, verified_by = EXCLUDED.verified_by,
         scanned_unit_number = EXCLUDED.scanned_unit_number,
         scanned_patient_uid = EXCLUDED.scanned_patient_uid,
         unit_match = EXCLUDED.unit_match, patient_match = EXCLUDED.patient_match,
         group_compatible = EXCLUDED.group_compatible, expiry_ok = EXCLUDED.expiry_ok,
         all_checks_passed = EXCLUDED.all_checks_passed,
         override_reason = EXCLUDED.override_reason, verified_at = NOW()
       RETURNING *`,
      request.tenant_id, requestId, unit.id, verifierRole, context.actorUid,
      (scannedUnitNumber || '').trim().toUpperCase() || null, scannedPatientUid || null,
      unitMatch, patientMatch, compat.compatible, expiryOk, allPassed, trimmedOverride,
    );
    await emitTransfusionEvent(tx, request, 'transfusion.bedside_verified', {
      actorUid: context.actorUid, actorRole: context.actorRole,
      summary: `Bedside verification (${verifierRole}) ${allPassed ? 'passed' : `FAILED — override: ${trimmedOverride}`} for unit ${unit.unit_number}`,
      payload: {
        verifier_role: verifierRole,
        checks: { unit_match: unitMatch, patient_match: patientMatch, group_compatible: compat.compatible, expiry_ok: expiryOk },
        all_checks_passed: allPassed,
        override_reason: trimmedOverride,
        unit_number: unit.unit_number,
      },
    });
    return rows[0];
  });
  return verification;
}

export async function assertBedsideVerified(requestId, { tenantId, legacyOverrideReason = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  if (!TRANSFUSION_REQUIRE_BEDSIDE_VERIFICATION) return { enforced: false };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT verifier_role, all_checks_passed, override_reason
       FROM transfusion_verifications
      WHERE request_id = $1 AND tenant_id = $2::uuid`,
    requestId,
    scopedTenantId,
  );
  const cleared = (role) => rows.some((r) => r.verifier_role === role && (r.all_checks_passed || r.override_reason));
  if (cleared('first') && cleared('second')) return { enforced: true };

  // Unit-less legacy requests (crossmatched without pinning a blood_units
  // row) have nothing to scan — bedside verification is impossible by
  // construction. Those may complete ONLY with an explicit, audited
  // override reason; silent completion stays blocked.
  const reqRows = await prisma.$queryRawUnsafe(
    `SELECT crossmatched_unit_id FROM blood_requests
      WHERE id = $1 AND tenant_id = $2::uuid`,
    requestId,
    scopedTenantId,
  );
  const unitless = reqRows.length > 0 && reqRows[0].crossmatched_unit_id == null;
  const trimmed = (legacyOverrideReason || '').trim();
  if (unitless && trimmed.length >= 10) {
    logger.warn('Transfusion completed via unit-less legacy override (no bedside scan possible)', {
      request_id: requestId, reason: trimmed,
    });
    return { enforced: true, legacy_override: trimmed };
  }

  throw AppError.conflict(
    unitless
      ? 'No unit was pinned at crossmatch, so bedside scanning is impossible — supply verification_override_reason (≥10 chars, audited) or re-crossmatch with a registered unit'
      : 'Two-person bedside verification (scan unit + wristband) is required before transfusion',
    'TRANSFUSION_VERIFICATION_REQUIRED',
    {
      first_done: cleared('first'),
      second_done: cleared('second'),
      unitless_request: unitless,
      verify_endpoint: `/api/v1/blood-bank/${requestId}/verify-bedside`,
    },
  );
}

export async function startTransfusion(requestId, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const request = await loadRequest(requestId, tenantId);
  if (!request) throw AppError.notFound('Blood request not found');
  if (request.status !== 'issued') {
    throw AppError.conflict(`Transfusion starts from 'issued' (current: ${request.status})`, 'TRANSFUSION_WRONG_STATUS');
  }
  await assertBedsideVerified(requestId, { tenantId });

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE blood_requests SET
         transfusion_started_at = NOW(), transfusion_started_by = $2::uuid, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3::uuid
       RETURNING id, tenant_id, patient_uid, encounter_id, blood_group, component, status,
                 crossmatched_unit_id, transfusion_started_at`,
      requestId, context.actorUid || null, tenantId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE blood_units SET status = 'issued', updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid AND status = 'crossmatched'`,
      request.crossmatched_unit_id,
      tenantId,
    );
    await emitTransfusionEvent(tx, rows[0], 'transfusion.started', {
      actorUid: context.actorUid, actorRole: context.actorRole,
      summary: `Transfusion started (request #${requestId})`,
      payload: { unit_id: request.crossmatched_unit_id },
    });
    return rows[0];
  });
}

export async function completeTransfusion(requestId, { notes = null } = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const request = await loadRequest(requestId, tenantId);
  if (!request) throw AppError.notFound('Blood request not found');
  if (request.status !== 'issued') {
    throw AppError.conflict(`Completion happens from 'issued' (current: ${request.status})`, 'TRANSFUSION_WRONG_STATUS');
  }
  await assertBedsideVerified(requestId, { tenantId });
  if (!request.transfusion_started_at) {
    throw AppError.conflict('Start the transfusion before completing it', 'TRANSFUSION_NOT_STARTED');
  }

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE blood_requests SET
         status = 'transfused', transfused_at = NOW(),
         notes = CASE WHEN $2::text IS NOT NULL THEN COALESCE(notes || E'\n', '') || $2::text ELSE notes END,
         updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3::uuid
       RETURNING id, tenant_id, patient_uid, encounter_id, blood_group, component, status, crossmatched_unit_id, transfused_at`,
      requestId, notes, tenantId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE blood_units SET status = 'transfused', updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid`,
      request.crossmatched_unit_id,
      tenantId,
    );
    await emitTransfusionEvent(tx, rows[0], 'transfusion.completed', {
      actorUid: context.actorUid, actorRole: context.actorRole,
      summary: `Transfusion completed (request #${requestId})`,
      payload: { unit_id: request.crossmatched_unit_id },
      beforeStatus: 'issued',
      afterStatus: 'transfused',
    });
    return rows[0];
  });
}

const REACTION_TYPES = ['febrile', 'allergic_mild', 'anaphylaxis', 'acute_hemolytic',
  'delayed_hemolytic', 'taco', 'trali', 'septic', 'hypotensive', 'other'];
const REACTION_SEVERITIES = ['mild', 'moderate', 'severe', 'life_threatening'];

export async function recordReaction(requestId, {
  reactionType, severity, onsetAt = null, symptoms = null, vitals = null,
  intervention = null, transfusionStopped = true, outcome = null,
} = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  if (!REACTION_TYPES.includes(reactionType)) {
    throw AppError.badRequest(`reaction_type must be one of ${REACTION_TYPES.join(', ')}`, 'TRANSFUSION_BAD_REACTION_TYPE');
  }
  if (!REACTION_SEVERITIES.includes(severity)) {
    throw AppError.badRequest(`severity must be one of ${REACTION_SEVERITIES.join(', ')}`, 'TRANSFUSION_BAD_REACTION_SEVERITY');
  }
  const request = await loadRequest(requestId, tenantId);
  if (!request) throw AppError.notFound('Blood request not found');

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transfusion_reactions
         (tenant_id, request_id, unit_id, reaction_type, severity, onset_at, symptoms,
          vitals, intervention, transfusion_stopped, outcome, reported_by)
       VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6::timestamptz, $7, $8::jsonb, $9, $10, $11, $12::uuid)
       RETURNING *`,
      request.tenant_id, requestId, request.crossmatched_unit_id, reactionType, severity,
      onsetAt, symptoms, vitals ? JSON.stringify(vitals) : null, intervention,
      transfusionStopped !== false, outcome, context.actorUid || null,
    );
    await emitTransfusionEvent(tx, request, 'transfusion.reaction_reported', {
      actorUid: context.actorUid, actorRole: context.actorRole,
      summary: `Transfusion reaction reported: ${reactionType} (${severity})`,
      payload: {
        reaction_id: rows[0].id, reaction_type: reactionType, severity,
        transfusion_stopped: transfusionStopped !== false,
        unit_id: request.crossmatched_unit_id,
      },
    });
    logger.warn('Transfusion reaction reported', { request_id: requestId, reactionType, severity });
    return rows[0];
  });
}

export default {
  TRANSFUSION_REQUIRE_BEDSIDE_VERIFICATION,
  checkUnitCompatibility,
  registerUnit,
  listUnits,
  crossmatchUnit,
  recordBedsideVerification,
  assertBedsideVerified,
  startTransfusion,
  completeTransfusion,
  recordReaction,
};
