// src/services/oncology/chemoService.js
//
// Roadmap D1 — oncology/chemo foundations.
//
//   * Protocol templates with per-drug dosing (mg/m² or fixed) and
//     lifetime ceilings (anthracyclines).
//   * Treatment plans snapshot height/weight and compute BSA (Mosteller).
//   * Cycle scheduling re-weighs the patient, recomputes BSA, generates
//     one administration row per protocol drug, and BLOCKS any drug whose
//     projected cumulative dose/m² would breach its lifetime ceiling —
//     override requires a reason and is audited.
//   * Administration is two-person verified (different humans — mirrors
//     the B5 transfusion bedside guard) before recording; recording
//     updates chemo_cumulative_doses in the same transaction.
//   * Optional D3 integration: when CHEMO_REQUIRE_ADMIN_PRIVILEGE=true,
//     the administering user must hold an active 'chemo_administration'
//     privilege in the credentialing registry.
//
// Timeline invariant: plan creation, cycle scheduling, verification,
// administration, and withholding all emit canonical timeline + audit
// events in the same transaction as the detail write.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { hasActivePrivilege } from '../staff/credentialingService.js';

// ── pure helpers (unit-tested) ───────────────────────────────────────────

/** Mosteller BSA: sqrt(height_cm × weight_kg / 3600), 2 decimals. */
export function computeBsaMosteller(heightCm, weightKg) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) return null;
  return Math.round(Math.sqrt((h * w) / 3600) * 100) / 100;
}

/** Dose for one protocol drug at a given BSA, before reductions. */
export function computeDose(drug, bsaM2) {
  if (drug.dose_per_m2 !== null && drug.dose_per_m2 !== undefined) {
    const bsa = Number(bsaM2);
    if (!Number.isFinite(bsa) || bsa <= 0) return null;
    return Math.round(Number(drug.dose_per_m2) * bsa * 100) / 100;
  }
  if (drug.fixed_dose !== null && drug.fixed_dose !== undefined) {
    return Math.round(Number(drug.fixed_dose) * 100) / 100;
  }
  return null;
}

/** Apply a percentage dose reduction, 2 decimals. */
export function applyReduction(dose, reductionPct = 0) {
  const d = Number(dose);
  const r = Number(reductionPct) || 0;
  if (!Number.isFinite(d)) return null;
  return Math.round(d * (1 - r / 100) * 100) / 100;
}

/**
 * Project cumulative dose/m² if this administration happens.
 * Returns { projected, ceiling, breached }.
 */
export function projectCumulativePerM2({ existingPerM2 = 0, dosePerM2Planned = 0, ceiling = null }) {
  const projected = Math.round((Number(existingPerM2 || 0) + Number(dosePerM2Planned || 0)) * 100) / 100;
  return {
    projected,
    ceiling: ceiling === null || ceiling === undefined ? null : Number(ceiling),
    breached: ceiling !== null && ceiling !== undefined && projected > Number(ceiling),
  };
}

const REQUIRE_ADMIN_PRIVILEGE = () => String(process.env.CHEMO_REQUIRE_ADMIN_PRIVILEGE || 'false') === 'true';

// ── protocols ────────────────────────────────────────────────────────────

export async function createProtocol({
  code, name, indication = null, cycleLengthDays, totalCycles = 1, reference = null, drugs = [],
}, { actorUid = null } = {}) {
  const trimmedCode = String(code || '').trim().toUpperCase();
  if (!trimmedCode) throw AppError.badRequest('Protocol code is required', 'CHEMO_CODE_REQUIRED');
  if (!name || !String(name).trim()) throw AppError.badRequest('Protocol name is required', 'CHEMO_NAME_REQUIRED');
  const cycleLen = Number(cycleLengthDays);
  if (!Number.isInteger(cycleLen) || cycleLen < 1 || cycleLen > 56) {
    throw AppError.badRequest('cycle_length_days must be 1-56', 'CHEMO_CYCLE_LENGTH_INVALID');
  }
  if (!Array.isArray(drugs) || drugs.length === 0) {
    throw AppError.badRequest('At least one protocol drug is required', 'CHEMO_DRUGS_REQUIRED');
  }
  for (const drug of drugs) {
    if (!drug.drug_name || !String(drug.drug_name).trim()) {
      throw AppError.badRequest('Every protocol drug needs drug_name', 'CHEMO_DRUG_NAME_REQUIRED');
    }
    const perM2 = drug.dose_per_m2 !== undefined && drug.dose_per_m2 !== null;
    const fixed = drug.fixed_dose !== undefined && drug.fixed_dose !== null;
    if (perM2 === fixed) {
      throw AppError.badRequest(`Drug ${drug.drug_name}: exactly one of dose_per_m2 or fixed_dose`, 'CHEMO_DRUG_DOSING_INVALID');
    }
    const days = Array.isArray(drug.days_of_cycle) && drug.days_of_cycle.length ? drug.days_of_cycle : [1];
    if (days.some((day) => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > cycleLen)) {
      throw AppError.badRequest(`Drug ${drug.drug_name}: days_of_cycle must fall within the ${cycleLen}-day cycle`, 'CHEMO_DRUG_DAYS_INVALID');
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const protoRows = await tx.$queryRawUnsafe(
        `INSERT INTO chemo_protocols (code, name, indication, cycle_length_days, total_cycles, reference, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
         RETURNING id, code, name, cycle_length_days, total_cycles, status, created_at`,
        trimmedCode,
        String(name).trim(),
        indication || null,
        cycleLen,
        Number(totalCycles) || 1,
        reference || null,
        actorUid,
      );
      const protocol = protoRows[0];

      let sequence = 1;
      for (const drug of drugs) {
        await tx.$queryRawUnsafe(
          `INSERT INTO chemo_protocol_drugs
             (protocol_id, drug_name, dose_per_m2, fixed_dose, dose_unit, route, days_of_cycle,
              infusion_duration_min, is_vesicant, max_lifetime_dose_per_m2, sequence, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7::int[], $8, $9, $10, $11, $12)`,
          protocol.id,
          String(drug.drug_name).trim(),
          drug.dose_per_m2 !== undefined && drug.dose_per_m2 !== null ? Number(drug.dose_per_m2) : null,
          drug.fixed_dose !== undefined && drug.fixed_dose !== null ? Number(drug.fixed_dose) : null,
          drug.dose_unit || 'mg',
          drug.route || 'IV',
          (Array.isArray(drug.days_of_cycle) && drug.days_of_cycle.length ? drug.days_of_cycle : [1]).map(Number),
          drug.infusion_duration_min ? Number(drug.infusion_duration_min) : null,
          Boolean(drug.is_vesicant),
          drug.max_lifetime_dose_per_m2 !== undefined && drug.max_lifetime_dose_per_m2 !== null
            ? Number(drug.max_lifetime_dose_per_m2) : null,
          sequence,
          drug.notes || null,
        );
        sequence += 1;
      }
      return protocol;
    });
  } catch (err) {
    if (String(err.message).includes('uq_chemo_protocols_code')) {
      throw AppError.conflict(`Protocol code ${trimmedCode} already exists`, 'CHEMO_CODE_TAKEN');
    }
    throw err;
  }
}

export async function activateProtocol(protocolId) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE chemo_protocols SET status = 'active', updated_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING id, code, name, status`,
    Number(protocolId),
  );
  if (!rows.length) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT status FROM chemo_protocols WHERE id = $1`, Number(protocolId),
    );
    if (!existing.length) throw AppError.notFound('Protocol not found', 'CHEMO_PROTOCOL_NOT_FOUND');
    throw AppError.invalidTransition(existing[0].status, 'active', ['draft']);
  }
  return rows[0];
}

export async function getProtocol(protocolId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, code, name, indication, cycle_length_days, total_cycles, status, reference, created_at
     FROM chemo_protocols WHERE id = $1`,
    Number(protocolId),
  );
  if (!rows.length) throw AppError.notFound('Protocol not found', 'CHEMO_PROTOCOL_NOT_FOUND');
  const drugs = await prisma.$queryRawUnsafe(
    `SELECT id, drug_name, dose_per_m2, fixed_dose, dose_unit, route, days_of_cycle,
            infusion_duration_min, is_vesicant, max_lifetime_dose_per_m2, sequence, notes
     FROM chemo_protocol_drugs WHERE protocol_id = $1 ORDER BY sequence`,
    Number(protocolId),
  );
  return { ...rows[0], drugs };
}

export async function listProtocols({ status = null } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE p.status = $1`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT p.id, p.code, p.name, p.indication, p.cycle_length_days, p.total_cycles, p.status,
            (SELECT COUNT(*)::int FROM chemo_protocol_drugs d WHERE d.protocol_id = p.id) AS drug_count
     FROM chemo_protocols p ${where}
     ORDER BY p.code`,
    ...params,
  );
}

// ── treatment plans ──────────────────────────────────────────────────────

async function latestVitals(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT height_cm FROM vitals_chart WHERE patient_uid = $1::uuid AND height_cm IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS height_cm,
       (SELECT weight_kg FROM vitals_chart WHERE patient_uid = $1::uuid AND weight_kg IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS weight_kg`,
    patientUid,
  );
  return rows[0] || { height_cm: null, weight_kg: null };
}

export async function createTreatmentPlan(protocolId, {
  patientUid, indication = null, plannedCycles = null, consentRef = null,
  heightCm = null, weightKg = null, startDate = null,
}, { actorUid = null, actorRole = null } = {}) {
  const protocol = await getProtocol(protocolId);
  if (protocol.status !== 'active') {
    throw AppError.invalidTransition(protocol.status, 'planning against', ['active']);
  }
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'CHEMO_PATIENT_REQUIRED');
  const patient = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users WHERE uid = $1::uuid LIMIT 1`, patientUid,
  );
  if (!patient.length) throw AppError.notFound('Patient not found', 'CHEMO_PATIENT_NOT_FOUND');

  let h = heightCm !== null && heightCm !== undefined ? Number(heightCm) : null;
  let w = weightKg !== null && weightKg !== undefined ? Number(weightKg) : null;
  if (h === null || w === null) {
    const vitals = await latestVitals(patientUid);
    if (h === null && vitals.height_cm !== null) h = Number(vitals.height_cm);
    if (w === null && vitals.weight_kg !== null) w = Number(vitals.weight_kg);
  }
  if (h === null || w === null) {
    throw AppError.badRequest(
      'Height and weight are required for BSA dosing — record vitals or pass height_cm/weight_kg',
      'CHEMO_ANTHROPOMETRY_REQUIRED',
    );
  }
  const bsa = computeBsaMosteller(h, w);
  if (bsa === null || bsa < 0.2 || bsa > 3.5) {
    throw AppError.badRequest(`Computed BSA ${bsa} m² is outside the plausible range`, 'CHEMO_BSA_IMPLAUSIBLE');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO chemo_treatment_plans
           (patient_uid, protocol_id, indication, planned_cycles, consent_ref,
            height_cm, weight_kg, bsa_m2, start_date, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::uuid)
         RETURNING id, patient_uid, protocol_id, planned_cycles, current_cycle, status,
                   height_cm, weight_kg, bsa_m2, bsa_method, start_date, created_at`,
        patientUid,
        protocol.id,
        indication || protocol.indication || null,
        plannedCycles ? Number(plannedCycles) : protocol.total_cycles,
        consentRef || null,
        h,
        w,
        bsa,
        startDate || null,
        actorUid,
      );
      const plan = rows[0];

      await recordCanonicalClinicalEvent({
        patientUid,
        eventType: 'chemo.plan_created',
        sourceTable: 'chemo_treatment_plans',
        sourceId: plan.id,
        actorUid,
        actorRole,
        summary: `Chemo plan created: ${protocol.code} × ${plan.planned_cycles} cycles (BSA ${bsa} m²)`,
        payload: { protocol_id: protocol.id, protocol_code: protocol.code, bsa_m2: bsa, height_cm: h, weight_kg: w },
      }, { db: tx });

      return plan;
    });
  } catch (err) {
    if (String(err.message).includes('uq_chemo_treatment_plans_live')) {
      throw AppError.conflict('Patient already has a live plan on this protocol', 'CHEMO_PLAN_EXISTS');
    }
    throw err;
  }
}

async function getPlan(planId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT p.id, p.patient_uid, p.protocol_id, p.planned_cycles, p.current_cycle, p.status,
            p.height_cm, p.weight_kg, p.bsa_m2, pr.code AS protocol_code, pr.cycle_length_days
     FROM chemo_treatment_plans p
     JOIN chemo_protocols pr ON pr.id = p.protocol_id
     WHERE p.id = $1`,
    Number(planId),
  );
  if (!rows.length) throw AppError.notFound('Treatment plan not found', 'CHEMO_PLAN_NOT_FOUND');
  return rows[0];
}

export async function getPatientCumulative(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT drug_name, total_dose, total_dose_per_m2, dose_unit, administration_count, last_administered_at
     FROM chemo_cumulative_doses
     WHERE patient_uid = $1::uuid
     ORDER BY drug_name`,
    patientUid,
  );
}

// ── cycle scheduling (with cumulative ceiling gate) ──────────────────────

export async function scheduleCycle(planId, {
  cycleNumber, scheduledDate, weightKg = null, doseReductions = {}, ceilingOverrideReason = null,
}, { actorUid = null, actorRole = null } = {}) {
  const plan = await getPlan(planId);
  if (!['planned', 'active'].includes(plan.status)) {
    throw AppError.invalidTransition(plan.status, 'scheduling a cycle', ['planned', 'active']);
  }
  const cycleNo = Number(cycleNumber);
  if (!Number.isInteger(cycleNo) || cycleNo < 1 || cycleNo > plan.planned_cycles) {
    throw AppError.badRequest(`cycle_number must be 1-${plan.planned_cycles}`, 'CHEMO_CYCLE_NUMBER_INVALID');
  }
  if (!scheduledDate) throw AppError.badRequest('scheduled_date is required', 'CHEMO_DATE_REQUIRED');

  // Re-weigh: per-cycle weight from caller, else latest vitals, else plan snapshot.
  let w = weightKg !== null && weightKg !== undefined ? Number(weightKg) : null;
  if (w === null) {
    const vitals = await latestVitals(plan.patient_uid);
    w = vitals.weight_kg !== null ? Number(vitals.weight_kg) : Number(plan.weight_kg);
  }
  const bsa = computeBsaMosteller(Number(plan.height_cm), w);
  if (bsa === null) throw AppError.badRequest('Could not compute BSA for the cycle', 'CHEMO_BSA_FAILED');

  const drugs = await prisma.$queryRawUnsafe(
    `SELECT id, drug_name, dose_per_m2, fixed_dose, dose_unit, route, max_lifetime_dose_per_m2
     FROM chemo_protocol_drugs WHERE protocol_id = $1 ORDER BY sequence`,
    plan.protocol_id,
  );

  // Cumulative ceiling gate (anthracyclines) — evaluated BEFORE anything
  // is written; breaches block the whole cycle unless overridden.
  const breaches = [];
  for (const drug of drugs) {
    if (drug.max_lifetime_dose_per_m2 === null || drug.dose_per_m2 === null) continue;
    const existing = await prisma.$queryRawUnsafe(
      `SELECT total_dose_per_m2 FROM chemo_cumulative_doses
       WHERE patient_uid = $1::uuid AND drug_name = LOWER($2)`,
      plan.patient_uid,
      drug.drug_name,
    );
    const reduction = Number(doseReductions[drug.drug_name] ?? doseReductions[drug.id] ?? 0);
    const plannedPerM2 = applyReduction(Number(drug.dose_per_m2), reduction);
    const projection = projectCumulativePerM2({
      existingPerM2: existing.length ? Number(existing[0].total_dose_per_m2) : 0,
      dosePerM2Planned: plannedPerM2,
      ceiling: Number(drug.max_lifetime_dose_per_m2),
    });
    if (projection.breached) {
      breaches.push({
        drug_name: drug.drug_name,
        projected_per_m2: projection.projected,
        ceiling_per_m2: projection.ceiling,
      });
    }
  }
  const overrideReason = ceilingOverrideReason ? String(ceilingOverrideReason).trim() : null;
  if (breaches.length && !overrideReason) {
    throw AppError.badRequest(
      'Cumulative lifetime dose ceiling would be breached — blocked without ceiling_override_reason',
      'CHEMO_CEILING_BREACH',
      { breaches },
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const cycleRows = await tx.$queryRawUnsafe(
        `INSERT INTO chemo_cycles (plan_id, cycle_number, scheduled_date, weight_kg, bsa_m2, created_by)
         VALUES ($1, $2, $3::date, $4, $5, $6::uuid)
         RETURNING id, plan_id, cycle_number, scheduled_date, status, weight_kg, bsa_m2`,
        plan.id, cycleNo, scheduledDate, w, bsa, actorUid,
      );
      const cycle = cycleRows[0];

      const administrations = [];
      for (const drug of drugs) {
        const reduction = Number(doseReductions[drug.drug_name] ?? doseReductions[drug.id] ?? 0);
        const calculated = computeDose(drug, bsa);
        const finalDose = applyReduction(calculated, reduction);
        const breached = breaches.some((b) => b.drug_name === drug.drug_name);
        const adminRows = await tx.$queryRawUnsafe(
          `INSERT INTO chemo_administrations
             (cycle_id, protocol_drug_id, drug_name, calculated_dose, dose_reduction_pct,
              final_dose, dose_unit, route, ceiling_override_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, drug_name, calculated_dose, dose_reduction_pct, final_dose, dose_unit, route, status, ceiling_override_reason`,
          cycle.id,
          drug.id,
          drug.drug_name,
          calculated,
          reduction,
          finalDose,
          drug.dose_unit,
          drug.route,
          breached ? overrideReason : null,
        );
        administrations.push(adminRows[0]);
      }

      await tx.$queryRawUnsafe(
        `UPDATE chemo_treatment_plans
         SET status = 'active', current_cycle = GREATEST(current_cycle, $2), updated_at = NOW()
         WHERE id = $1`,
        plan.id, cycleNo,
      );

      await recordCanonicalClinicalEvent({
        patientUid: plan.patient_uid,
        eventType: 'chemo.cycle_scheduled',
        sourceTable: 'chemo_cycles',
        sourceId: cycle.id,
        actorUid,
        actorRole,
        summary: `Chemo cycle ${cycleNo}/${plan.planned_cycles} (${plan.protocol_code}) scheduled — BSA ${bsa} m²${breaches.length ? ' — CEILING OVERRIDE' : ''}`,
        payload: {
          plan_id: plan.id, cycle_number: cycleNo, bsa_m2: bsa, weight_kg: w,
          drug_count: administrations.length,
          ceiling_breaches: breaches,
          ceiling_override_reason: breaches.length ? overrideReason : null,
        },
      }, { db: tx });

      return { cycle, administrations, ceiling_breaches: breaches };
    });
  } catch (err) {
    if (String(err.message).includes('uq_chemo_cycles_number')) {
      throw AppError.conflict(`Cycle ${cycleNo} already scheduled for this plan`, 'CHEMO_CYCLE_EXISTS');
    }
    throw err;
  }
}

// ── administration: two-person verification + recording ─────────────────

async function getAdministration(adminId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT a.id, a.cycle_id, a.drug_name, a.final_dose, a.dose_unit, a.route, a.status,
            a.first_verified_by, a.second_verified_by, a.ceiling_override_reason,
            c.plan_id, c.cycle_number, c.bsa_m2, p.patient_uid, pr.code AS protocol_code
     FROM chemo_administrations a
     JOIN chemo_cycles c ON c.id = a.cycle_id
     JOIN chemo_treatment_plans p ON p.id = c.plan_id
     JOIN chemo_protocols pr ON pr.id = p.protocol_id
     WHERE a.id = $1`,
    Number(adminId),
  );
  if (!rows.length) throw AppError.notFound('Chemo administration not found', 'CHEMO_ADMIN_NOT_FOUND');
  return rows[0];
}

export async function verifyAdministration(adminId, {
  verifierRole, scannedPatientUid = null,
}, { actorUid = null, actorRole = null } = {}) {
  if (!['first', 'second'].includes(verifierRole)) {
    throw AppError.badRequest('verifier_role must be first or second', 'CHEMO_VERIFIER_ROLE_INVALID');
  }
  if (!actorUid) throw AppError.unauthorized('Verifier identity required', 'CHEMO_VERIFIER_REQUIRED');

  const admin = await getAdministration(adminId);

  if (scannedPatientUid && String(scannedPatientUid) !== String(admin.patient_uid)) {
    throw AppError.badRequest(
      'Scanned wristband does not match the plan patient — administration blocked',
      'CHEMO_PATIENT_MISMATCH',
    );
  }

  if (verifierRole === 'first') {
    if (admin.status !== 'pending') {
      throw AppError.invalidTransition(admin.status, 'first_verified', ['pending']);
    }
  } else {
    if (admin.status !== 'first_verified') {
      throw AppError.invalidTransition(admin.status, 'double_verified', ['first_verified']);
    }
    // Different-human guard (B5 transfusion pattern).
    if (String(admin.first_verified_by) === String(actorUid)) {
      throw AppError.forbidden('Second verifier must be a different person', 'CHEMO_SAME_VERIFIER');
    }
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      verifierRole === 'first'
        ? `UPDATE chemo_administrations
           SET status = 'first_verified', first_verified_by = $2::uuid, first_verified_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status = 'pending'
           RETURNING id, drug_name, status, first_verified_by, first_verified_at`
        : `UPDATE chemo_administrations
           SET status = 'double_verified', second_verified_by = $2::uuid, second_verified_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status = 'first_verified'
           RETURNING id, drug_name, status, second_verified_by, second_verified_at`,
      admin.id,
      actorUid,
    );
    if (!rows.length) throw AppError.conflict('Administration state changed concurrently', 'CHEMO_ADMIN_RACE');

    await recordCanonicalClinicalEvent({
      patientUid: admin.patient_uid,
      eventType: 'chemo.administration_verified',
      sourceTable: 'chemo_administrations',
      sourceId: admin.id,
      actorUid,
      actorRole,
      summary: `Chemo ${admin.drug_name} ${verifierRole} verification (cycle ${admin.cycle_number}, ${admin.protocol_code})`,
      payload: { verifier_role: verifierRole, cycle_id: admin.cycle_id, drug_name: admin.drug_name },
      idempotencyKey: `chemo-verify-${admin.id}-${verifierRole}`,
    }, { db: tx });

    return rows[0];
  });
}

export async function recordChemoAdministration(adminId, { actorUid = null, actorRole = null } = {}) {
  if (!actorUid) throw AppError.unauthorized('Administering user identity required', 'CHEMO_ADMINISTRATOR_REQUIRED');
  const admin = await getAdministration(adminId);
  if (admin.status !== 'double_verified') {
    throw AppError.invalidTransition(admin.status, 'administered', ['double_verified']);
  }

  if (REQUIRE_ADMIN_PRIVILEGE()) {
    const verdict = await hasActivePrivilege(actorUid, 'chemo_administration');
    if (!verdict?.allowed) {
      throw AppError.forbidden(
        'Administering user does not hold an active chemo_administration privilege (D3 credentialing)',
        'CHEMO_PRIVILEGE_MISSING',
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE chemo_administrations
       SET status = 'administered', administered_by = $2::uuid, administered_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'double_verified'
       RETURNING id, drug_name, final_dose, dose_unit, status, administered_by, administered_at`,
      admin.id,
      actorUid,
    );
    if (!rows.length) throw AppError.conflict('Administration state changed concurrently', 'CHEMO_ADMIN_RACE');
    const recorded = rows[0];

    // Cumulative tracking in the SAME tx — per-m² uses the cycle's BSA.
    const perM2 = admin.bsa_m2 ? Math.round((Number(admin.final_dose) / Number(admin.bsa_m2)) * 100) / 100 : 0;
    await tx.$queryRawUnsafe(
      `INSERT INTO chemo_cumulative_doses
         (patient_uid, drug_name, total_dose, total_dose_per_m2, dose_unit, administration_count, last_administered_at, updated_at)
       VALUES ($1::uuid, LOWER($2), $3, $4, $5, 1, NOW(), NOW())
       ON CONFLICT (patient_uid, drug_name)
       DO UPDATE SET total_dose = chemo_cumulative_doses.total_dose + EXCLUDED.total_dose,
                     total_dose_per_m2 = chemo_cumulative_doses.total_dose_per_m2 + EXCLUDED.total_dose_per_m2,
                     administration_count = chemo_cumulative_doses.administration_count + 1,
                     last_administered_at = NOW(), updated_at = NOW()`,
      admin.patient_uid,
      admin.drug_name,
      Number(admin.final_dose),
      perM2,
      recorded.dose_unit,
    );

    // Cycle flips to administered when every line is administered/withheld.
    await tx.$queryRawUnsafe(
      `UPDATE chemo_cycles SET status = 'administered', updated_at = NOW()
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM chemo_administrations
         WHERE cycle_id = $1 AND status NOT IN ('administered', 'withheld')
       )`,
      admin.cycle_id,
    );

    await recordCanonicalClinicalEvent({
      patientUid: admin.patient_uid,
      eventType: 'chemo.administered',
      sourceTable: 'chemo_administrations',
      sourceId: admin.id,
      actorUid,
      actorRole,
      summary: `Chemo administered: ${admin.drug_name} ${admin.final_dose} ${recorded.dose_unit} (cycle ${admin.cycle_number}, ${admin.protocol_code})`,
      payload: {
        cycle_id: admin.cycle_id, drug_name: admin.drug_name,
        final_dose: Number(admin.final_dose), dose_unit: recorded.dose_unit, dose_per_m2_added: perM2,
      },
    }, { db: tx });

    return recorded;
  });
}

export async function withholdAdministration(adminId, { reason }, { actorUid = null, actorRole = null } = {}) {
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('Withhold reason is required', 'CHEMO_WITHHOLD_REASON_REQUIRED');
  }
  const admin = await getAdministration(adminId);
  if (!['pending', 'first_verified', 'double_verified'].includes(admin.status)) {
    throw AppError.invalidTransition(admin.status, 'withheld', ['pending', 'first_verified', 'double_verified']);
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE chemo_administrations
       SET status = 'withheld', withheld_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'first_verified', 'double_verified')
       RETURNING id, drug_name, status, withheld_reason`,
      admin.id,
      String(reason).trim(),
    );
    if (!rows.length) throw AppError.conflict('Administration state changed concurrently', 'CHEMO_ADMIN_RACE');

    // A withheld line can complete the cycle too (administered/withheld are
    // both terminal states for the cycle-completion check).
    await tx.$queryRawUnsafe(
      `UPDATE chemo_cycles SET status = 'administered', updated_at = NOW()
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM chemo_administrations
         WHERE cycle_id = $1 AND status NOT IN ('administered', 'withheld')
       )`,
      admin.cycle_id,
    );

    await recordCanonicalClinicalEvent({
      patientUid: admin.patient_uid,
      eventType: 'chemo.withheld',
      sourceTable: 'chemo_administrations',
      sourceId: admin.id,
      actorUid,
      actorRole,
      summary: `Chemo ${admin.drug_name} withheld (cycle ${admin.cycle_number}): ${String(reason).trim()}`,
      payload: { cycle_id: admin.cycle_id, drug_name: admin.drug_name, reason: String(reason).trim() },
    }, { db: tx });

    return rows[0];
  });
}

export async function getPlanDetail(planId) {
  const plan = await getPlan(planId);
  const cycles = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.cycle_number, c.scheduled_date, c.status, c.weight_kg, c.bsa_m2,
            COALESCE(json_agg(json_build_object(
              'id', a.id, 'drug_name', a.drug_name, 'final_dose', a.final_dose,
              'dose_unit', a.dose_unit, 'status', a.status
            ) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS administrations
     FROM chemo_cycles c
     LEFT JOIN chemo_administrations a ON a.cycle_id = c.id
     WHERE c.plan_id = $1
     GROUP BY c.id
     ORDER BY c.cycle_number`,
    plan.id,
  );
  const cumulative = await getPatientCumulative(plan.patient_uid);
  return { ...plan, cycles, cumulative };
}

export default {
  computeBsaMosteller,
  computeDose,
  applyReduction,
  projectCumulativePerM2,
  createProtocol,
  activateProtocol,
  getProtocol,
  listProtocols,
  createTreatmentPlan,
  scheduleCycle,
  verifyAdministration,
  recordChemoAdministration,
  withholdAdministration,
  getPatientCumulative,
  getPlanDetail,
};
