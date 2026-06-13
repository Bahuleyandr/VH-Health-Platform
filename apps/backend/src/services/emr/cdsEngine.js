// src/services/emr/cdsEngine.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { emitCdsAlertAcknowledged } from '../clinical/canonicalOperationalBridgeService.js';


// ===================================================================
// Clinical Decision Support (CDS) Engine
// Pluggable rule engine — each check function is independently callable.
// Migrated from raw SQL → typed Prisma ORM in batch 56.
// ===================================================================

/**
 * Common drug-class mappings for allergy cross-referencing.
 * Maps a drug class keyword to representative member drugs.
 */
const DRUG_CLASS_MAP = {
  penicillin: ['amoxicillin', 'ampicillin', 'piperacillin', 'penicillin', 'flucloxacillin', 'dicloxacillin', 'nafcillin', 'oxacillin'],
  cephalosporin: ['cephalexin', 'cefazolin', 'ceftriaxone', 'cefuroxime', 'cefixime', 'ceftazidime', 'cefepime', 'cefotaxime'],
  sulfonamide: ['sulfamethoxazole', 'trimethoprim-sulfamethoxazole', 'sulfasalazine', 'sulfadiazine'],
  nsaid: ['ibuprofen', 'naproxen', 'diclofenac', 'indomethacin', 'ketorolac', 'meloxicam', 'piroxicam', 'celecoxib', 'aspirin'],
  opioid: ['morphine', 'codeine', 'tramadol', 'fentanyl', 'oxycodone', 'hydrocodone', 'methadone', 'hydromorphone', 'meperidine'],
  statin: ['atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin', 'lovastatin', 'fluvastatin'],
  ace_inhibitor: ['enalapril', 'lisinopril', 'ramipril', 'captopril', 'perindopril', 'benazepril', 'fosinopril'],
  arb: ['losartan', 'valsartan', 'irbesartan', 'telmisartan', 'candesartan', 'olmesartan'],
  fluoroquinolone: ['ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'ofloxacin', 'norfloxacin'],
  macrolide: ['azithromycin', 'erythromycin', 'clarithromycin'],
  benzodiazepine: ['diazepam', 'lorazepam', 'midazolam', 'alprazolam', 'clonazepam'],
  beta_blocker: ['metoprolol', 'atenolol', 'propranolol', 'carvedilol', 'bisoprolol', 'labetalol'],
  calcium_channel_blocker: ['amlodipine', 'nifedipine', 'diltiazem', 'verapamil'],
  thiazide: ['hydrochlorothiazide', 'chlorthalidone', 'indapamide'],
  aminoglycoside: ['gentamicin', 'tobramycin', 'amikacin', 'streptomycin'],
};

/**
 * Critical lab value ranges. Values outside these trigger immediate alerts.
 */
const CRITICAL_LAB_RANGES = {
  potassium:      { unit: 'mEq/L',  criticalLow: 2.5, low: 3.5, high: 5.0, criticalHigh: 6.5 },
  sodium:         { unit: 'mEq/L',  criticalLow: 120, low: 135, high: 145, criticalHigh: 160 },
  glucose:        { unit: 'mg/dL',  criticalLow: 40,  low: 70,  high: 200, criticalHigh: 500 },
  hemoglobin:     { unit: 'g/dL',   criticalLow: 5.0, low: 10.0, high: 18.0, criticalHigh: 22.0 },
  platelets:      { unit: 'x10^3',  criticalLow: 20,  low: 150,  high: 400, criticalHigh: 1000 },
  creatinine:     { unit: 'mg/dL',  criticalLow: null, low: 0.6, high: 1.2, criticalHigh: 10.0 },
  inr:            { unit: '',       criticalLow: null, low: 0.8, high: 1.2, criticalHigh: 5.0 },
  troponin:       { unit: 'ng/mL',  criticalLow: null, low: 0, high: 0.04, criticalHigh: 2.0 },
  lactate:        { unit: 'mmol/L', criticalLow: null, low: 0.5, high: 2.0, criticalHigh: 4.0 },
  wbc:            { unit: 'x10^3',  criticalLow: 1.0, low: 4.0, high: 11.0, criticalHigh: 30.0 },
  calcium:        { unit: 'mg/dL',  criticalLow: 6.0, low: 8.5, high: 10.5, criticalHigh: 14.0 },
  magnesium:      { unit: 'mg/dL',  criticalLow: 1.0, low: 1.7, high: 2.2, criticalHigh: 4.0 },
  phosphorus:     { unit: 'mg/dL',  criticalLow: 1.0, low: 2.5, high: 4.5, criticalHigh: 8.0 },
  bilirubin:      { unit: 'mg/dL',  criticalLow: null, low: 0.1, high: 1.2, criticalHigh: 15.0 },
  ph:             { unit: '',       criticalLow: 7.1, low: 7.35, high: 7.45, criticalHigh: 7.6 },
  pco2:           { unit: 'mmHg',   criticalLow: 20,  low: 35,  high: 45, criticalHigh: 70 },
  po2:            { unit: 'mmHg',   criticalLow: 40,  low: 80,  high: 100, criticalHigh: null },
};

const SEVERITY_RANK = { critical: 1, warning: 2, info: 3 };

function normalizeAllergy(value) {
  return String(value || '').toLowerCase().trim();
}

// cds_alerts.encounter_id is INT (FK to admissions.id, not a uuid). The
// caller's `order.encounter_id` is sometimes a uuid (admissions.encounter_id)
// — coerce safely so a uuid doesn't crash the typed insert.
function safeEncounterIdInt(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// Resolve users.id (int) from users.uid (uuid). Several legacy WHEREs
// in this file used `(uid = $1 OR patient_id = (SELECT id FROM users WHERE uid = $1))`
// to handle two columns that can index the same patient. Resolve once
// up front, then build the typed `where` with `OR`.
async function resolveUserIdFromUid(patientUid) {
  if (!patientUid) return null;
  const user = await prisma.users.findUnique({
    where: { uid: patientUid },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function persistCdsAlert({ patientUid, encounterId, alertType, severity, title, description, sourceData }) {
  try {
    // Resolve the owning tenant from the patient. cds_alerts carries a
    // tenant_id with a DB DEFAULT of the global default tenant, so a bare
    // create without tenant_id silently writes the alert into the WRONG
    // tenant — fail SAFE instead (skip the write) when it can't be resolved.
    const owner = await prisma.users.findUnique({
      where: { uid: patientUid },
      select: { tenant_id: true },
    });
    const tenantId = owner?.tenant_id ?? null;
    if (!tenantId) {
      logger.error(
        `Skipping CDS alert persist (${alertType}): could not resolve owning tenant for patient_uid=${patientUid}`,
      );
      return;
    }

    // Explicitly stamp tenant_id (resolved above; fail-safe on null) so the
    // alert lands in the owning tenant rather than the cds_alerts DB DEFAULT.
    // This single create is auto-scoped by the prisma proxy under the request's
    // tenant context; kept as a plain create (no interactive setTenantTx tx) so
    // cdsEngine — imported across the clinical layer — does not pull the
    // setTenantTx import graph into ~150 mocked-prisma unit tests.
    await prisma.cds_alerts.create({
      data: {
        patient_uid: patientUid,
        encounter_id: safeEncounterIdInt(encounterId),
        alert_type: alertType,
        severity,
        title,
        description,
        source_data: sourceData ?? null,
        tenant_id: tenantId,
      },
    });
  } catch (persistErr) {
    logger.error(`Failed to persist CDS alert (${alertType}): ${persistErr.message}`);
  }
}

async function getPatientAllergyEntries(patientUid) {
  const patientIntId = await resolveUserIdFromUid(patientUid);

  const [admissionRows, fhirRows, lookupRows] = await Promise.all([
    prisma.admissions.findMany({
      where: {
        patient_uid: patientUid,
        status: 'admitted',
        NOT: { allergies: { isEmpty: true } },
      },
      select: { allergies: true },
    }),
    prisma.allergies.findMany({
      where: {
        patient_uid: patientUid,
        // status is nullable text; default to 'active' if null. Filter
        // out the inactive-equivalent values.
        OR: [
          { status: null },
          { status: { notIn: ['inactive', 'resolved', 'entered-in-error', 'cancelled'] } },
        ],
      },
      select: { allergen: true, name: true, severity: true, reaction: true },
    }),
    prisma.patient_allergies.findMany({
      where: {
        // COALESCE(is_active, true) = true: include null + true.
        OR: [{ is_active: true }, { is_active: null }],
        AND: {
          OR: [
            { patient_uid: patientUid },
            ...(patientIntId != null ? [{ patient_id: patientIntId }] : []),
          ],
        },
      },
      select: { allergy_name: true, severity: true, reaction: true },
    }),
  ]);

  const byName = new Map();

  // admissions.allergies is text[]; unnest in JS. Source 'admissions'
  // does not carry severity/reaction (the original SQL projected NULL).
  for (const adm of admissionRows) {
    for (const allergy of adm.allergies ?? []) {
      const norm = normalizeAllergy(allergy);
      if (!norm || byName.has(norm)) continue;
      byName.set(norm, { allergy: norm, severity: null, reaction: null, source: 'admissions' });
    }
  }

  for (const row of fhirRows) {
    const allergyValue = row.allergen && row.allergen.trim().length > 0 ? row.allergen : row.name;
    const norm = normalizeAllergy(allergyValue);
    if (!norm || byName.has(norm)) continue;
    byName.set(norm, {
      allergy: norm,
      severity: row.severity ?? null,
      reaction: row.reaction ?? null,
      source: 'allergies',
    });
  }

  for (const row of lookupRows) {
    const norm = normalizeAllergy(row.allergy_name);
    if (!norm || byName.has(norm)) continue;
    byName.set(norm, {
      allergy: norm,
      severity: row.severity ?? null,
      reaction: row.reaction ?? null,
      source: 'patient_allergies',
    });
  }

  return [...byName.values()];
}

// ===================================================================
// checkOrder — Master function
// ===================================================================

/**
 * Master CDS check. Runs all applicable checks for an order.
 * @param {Object} order - { type: 'medication'|'investigation', medication_name?, test_name?, details?, patient_uid, encounter_id? }
 * @param {Object} patientContext - Optional pre-fetched patient data
 * @returns {{ safe: boolean, alerts: Array<{type, severity, title, description, canOverride}> }}
 */
export async function checkOrder(order, _patientContext = {}) {
  if (!order || !order.type || !order.patient_uid) {
    throw AppError.badRequest('Order must include type and patient_uid');
  }

  const alerts = [];

  try {
    if (order.type === 'medication' && order.medication_name) {
      const [interactionAlerts, allergyAlerts, duplicateAlerts] = await Promise.all([
        checkDrugInteractions(order.medication_name, order.patient_uid),
        checkAllergies(order.medication_name, order.patient_uid),
        checkDuplicateOrders('medication', { medication_name: order.medication_name }, order.patient_uid),
      ]);
      alerts.push(...interactionAlerts, ...allergyAlerts, ...duplicateAlerts);
    } else if (order.type === 'investigation' && order.test_name) {
      const [duplicateAlerts, recentAlerts] = await Promise.all([
        checkDuplicateOrders('investigation', { test_name: order.test_name }, order.patient_uid),
        checkRecentResults(order.test_name, order.patient_uid),
      ]);
      alerts.push(...duplicateAlerts, ...recentAlerts);
    }

    // Persist any critical/warning alerts.
    for (const alert of alerts) {
      if (alert.severity === 'critical' || alert.severity === 'warning') {
        await persistCdsAlert({
          patientUid: order.patient_uid,
          encounterId: order.encounter_id,
          alertType: alert.type,
          severity: alert.severity,
          title: alert.title,
          description: alert.description,
          sourceData: alert.sourceData,
        });
      }
    }

    const safe = alerts.every((a) => a.severity === 'info');

    return { safe, alerts };
  } catch (err) {
    logger.error(`CDS checkOrder error: ${err.message}`);
    // Fail open — return safe with a warning that CDS could not complete checks.
    return {
      safe: true,
      alerts: [{
        type: 'system_error',
        severity: 'info',
        title: 'CDS check incomplete',
        description: 'Clinical decision support checks could not be fully completed. Please verify manually.',
        canOverride: true,
      }],
    };
  }
}

// ===================================================================
// checkDrugInteractions
// ===================================================================

/**
 * Check for drug-drug interactions between a medication and the patient's active medications.
 * @param {string} medicationName
 * @param {string} patientUid
 * @returns {Array<{type, severity, title, description, canOverride, sourceData}>}
 */
export async function checkDrugInteractions(medicationName, patientUid) {
  if (!medicationName || !patientUid) return [];

  const drugLower = medicationName.toLowerCase().trim();
  const alerts = [];

  // Get patient's active medications from MAR + prescriptions (UNION
  // replaced with two parallel findManys + Set dedup).
  const [marRows, rxRows] = await Promise.all([
    prisma.medication_administrations.findMany({
      where: {
        patient_uid: patientUid,
        status: { in: ['scheduled', 'administered'] },
        created_at: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      select: { medication_name: true },
    }),
    prisma.prescriptions.findMany({
      where: { patient_uid: patientUid, status: 'active' },
      select: { medication_name: true },
    }),
  ]);

  const activeNames = new Set();
  for (const row of marRows) {
    if (row.medication_name) activeNames.add(row.medication_name.toLowerCase());
  }
  for (const row of rxRows) {
    if (row.medication_name) activeNames.add(row.medication_name.toLowerCase());
  }
  if (activeNames.size === 0) return [];

  // Check drug_interactions table for each active medication. We check
  // each pair separately so we can attribute the alert to the active
  // med (matches the pre-ORM loop structure).
  for (const activeMed of activeNames) {
    if (activeMed === drugLower) continue; // skip self

    const interactions = await prisma.drug_interactions.findMany({
      where: {
        OR: [
          {
            AND: [
              { drug_a: { equals: drugLower, mode: 'insensitive' } },
              { drug_b: { equals: activeMed, mode: 'insensitive' } },
            ],
          },
          {
            AND: [
              { drug_a: { equals: activeMed, mode: 'insensitive' } },
              { drug_b: { equals: drugLower, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true, drug_a: true, drug_b: true, severity: true,
        description: true, clinical_effect: true, management: true,
      },
    });

    for (const interaction of interactions) {
      const alertSeverity = interaction.severity === 'contraindicated' ? 'critical'
        : interaction.severity === 'severe' ? 'critical'
          : interaction.severity === 'moderate' ? 'warning'
            : 'info';

      const otherDrug = interaction.drug_a?.toLowerCase() === drugLower
        ? interaction.drug_b : interaction.drug_a;

      alerts.push({
        type: 'drug_interaction',
        severity: alertSeverity,
        title: `Drug interaction: ${medicationName} + ${otherDrug}`,
        description: interaction.description,
        canOverride: interaction.severity !== 'contraindicated',
        sourceData: {
          interaction_id: interaction.id,
          drug_a: interaction.drug_a,
          drug_b: interaction.drug_b,
          severity: interaction.severity,
          clinical_effect: interaction.clinical_effect,
          management: interaction.management,
        },
      });
    }
  }

  return alerts;
}

// ===================================================================
// checkAllergies
// ===================================================================

/**
 * Cross-reference medication against patient allergy list.
 * Uses substring matching and drug class mappings.
 * @param {string} medicationName
 * @param {string} patientUid
 * @returns {Array<{type, severity, title, description, canOverride, sourceData}>}
 */
export async function checkAllergies(medicationName, patientUid) {
  if (!medicationName || !patientUid) return [];

  const drugLower = medicationName.toLowerCase().trim();
  const alerts = [];

  const allergyEntries = await getPatientAllergyEntries(patientUid);
  if (allergyEntries.length === 0) return [];

  // Direct substring match
  for (const entry of allergyEntries) {
    const { allergy } = entry;

    if (drugLower.includes(allergy) || allergy.includes(drugLower)) {
      alerts.push({
        type: 'allergy',
        severity: 'critical',
        title: `Allergy alert: Patient allergic to "${allergy}"`,
        description: `The ordered medication "${medicationName}" matches or contains a known allergen "${allergy}". This order should NOT be placed without careful review.`,
        canOverride: true,
        sourceData: { medication: medicationName, allergy, match_type: 'direct', source: entry.source, reaction: entry.reaction, severity: entry.severity },
      });
    }
  }

  // Drug class cross-reference
  for (const [className, members] of Object.entries(DRUG_CLASS_MAP)) {
    const drugInClass = members.some((m) => drugLower.includes(m) || m.includes(drugLower));
    if (!drugInClass) continue;

    // Check if patient is allergic to any drug in the same class or the class name itself.
    for (const entry of allergyEntries) {
      const { allergy } = entry;
      const allergyMatchesClass = allergy.includes(className) || className.includes(allergy);
      const allergyMatchesMember = members.some((m) => allergy.includes(m) || m.includes(allergy));

      if (allergyMatchesClass || allergyMatchesMember) {
        // Avoid duplicate if already caught by direct match.
        const alreadyCaught = alerts.some((a) => a.sourceData?.allergy === allergy && a.sourceData?.match_type === 'direct');
        if (!alreadyCaught) {
          alerts.push({
            type: 'allergy',
            severity: 'warning',
            title: `Drug class allergy: ${className} class`,
            description: `Patient is allergic to "${allergy}" which belongs to the ${className} drug class. "${medicationName}" is also in this class. Cross-sensitivity is possible.`,
            canOverride: true,
            sourceData: { medication: medicationName, allergy, drug_class: className, match_type: 'class', source: entry.source, reaction: entry.reaction, severity: entry.severity },
          });
        }
      }
    }
  }

  return alerts;
}

// ===================================================================
// checkDuplicateOrders
// ===================================================================

/**
 * Check for active orders of the same type/medication/test.
 * @param {string} orderType - 'medication' or 'investigation'
 * @param {Object} details - { medication_name } or { test_name }
 * @param {string} patientUid
 * @returns {Array<{type, severity, title, description, canOverride, sourceData}>}
 */
export async function checkDuplicateOrders(orderType, details, patientUid) {
  if (!orderType || !patientUid) return [];

  const alerts = [];

  if (orderType === 'medication' && details.medication_name) {
    const medLower = details.medication_name.toLowerCase().trim();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activePrescriptions, scheduledMar] = await Promise.all([
      prisma.prescriptions.findMany({
        where: {
          patient_uid: patientUid,
          status: 'active',
          medication_name: { equals: medLower, mode: 'insensitive' },
        },
        select: { id: true, medication_name: true, dosage: true, frequency: true, status: true, created_at: true },
      }),
      prisma.medication_administrations.findMany({
        where: {
          patient_uid: patientUid,
          status: 'scheduled',
          medication_name: { equals: medLower, mode: 'insensitive' },
          created_at: { gte: oneDayAgo },
        },
        select: { id: true, medication_name: true, dose: true, status: true, created_at: true },
      }),
    ]);

    if (activePrescriptions.length > 0) {
      alerts.push({
        type: 'duplicate_order',
        severity: 'warning',
        title: `Duplicate medication: ${details.medication_name}`,
        description: `Patient already has ${activePrescriptions.length} active prescription(s) for "${details.medication_name}". Review before placing a new order.`,
        canOverride: true,
        sourceData: { existing_prescriptions: activePrescriptions.map((p) => ({ id: p.id, dosage: p.dosage, frequency: p.frequency })) },
      });
    }

    if (scheduledMar.length > 0) {
      alerts.push({
        type: 'duplicate_order',
        severity: 'info',
        title: `Scheduled doses exist: ${details.medication_name}`,
        description: `${scheduledMar.length} dose(s) of "${details.medication_name}" are already scheduled within the last 24 hours.`,
        canOverride: true,
        sourceData: { scheduled_count: scheduledMar.length },
      });
    }
  } else if (orderType === 'investigation' && details.test_name) {
    const testLower = details.test_name.toLowerCase().trim();
    const patientIntId = await resolveUserIdFromUid(patientUid);

    const pendingTests = await prisma.investigations.findMany({
      where: {
        OR: [
          { uid: patientUid },
          ...(patientIntId != null ? [{ patient_id: patientIntId }] : []),
        ],
        status: { in: ['ordered', 'requested', 'in_progress', 'collected', 'ORDERED', 'REQUESTED', 'IN_PROGRESS', 'COLLECTED'] },
        test_name: { equals: testLower, mode: 'insensitive' },
      },
      select: {
        id: true, test_name: true, status: true,
        requested_at: true, updated_at: true, completed_at: true,
      },
    });

    if (pendingTests.length > 0) {
      alerts.push({
        type: 'duplicate_order',
        severity: 'warning',
        title: `Duplicate investigation: ${details.test_name}`,
        description: `Patient already has ${pendingTests.length} pending "${details.test_name}" order(s). Review before ordering again.`,
        canOverride: true,
        sourceData: {
          pending_tests: pendingTests.map((t) => ({
            id: t.id,
            status: t.status,
            // Mirror the SQL COALESCE(requested_at, updated_at, completed_at).
            created_at: t.requested_at ?? t.updated_at ?? t.completed_at,
          })),
        },
      });
    }
  }

  return alerts;
}

// ===================================================================
// checkRecentResults (for investigation orders)
// ===================================================================

/**
 * Check if recent results already exist for the test being ordered.
 * @param {string} testName
 * @param {string} patientUid
 * @returns {Array}
 */
export async function checkRecentResults(testName, patientUid) {
  if (!testName || !patientUid) return [];

  const alerts = [];
  const testLower = testName.toLowerCase().trim();
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const patientIntId = await resolveUserIdFromUid(patientUid);

  // The pre-ORM SQL filtered on COALESCE(completed_at, updated_at, requested_at) >= cutoff
  // and ordered by the same. Prisma can't express coalesced-column predicates, so fetch
  // the broader candidate set and apply the coalesce in JS.
  const candidates = await prisma.investigations.findMany({
    where: {
      OR: [
        { uid: patientUid },
        ...(patientIntId != null ? [{ patient_id: patientIntId }] : []),
      ],
      status: { equals: 'completed', mode: 'insensitive' },
      test_name: { equals: testLower, mode: 'insensitive' },
    },
    select: {
      id: true, test_name: true, status: true, result_file: true,
      requested_at: true, updated_at: true, completed_at: true,
    },
    take: 200, // generous upper bound; we'll filter + sort + cap to 5 in JS
  });

  const recentResults = candidates
    .map((r) => ({
      id: r.id,
      test_name: r.test_name,
      status: r.status,
      result: r.result_file,
      created_at: r.completed_at ?? r.updated_at ?? r.requested_at,
    }))
    .filter((r) => r.created_at && r.created_at >= fortyEightHoursAgo)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5);

  if (recentResults.length > 0) {
    alerts.push({
      type: 'duplicate_order',
      severity: 'info',
      title: `Recent results available: ${testName}`,
      description: `${recentResults.length} result(s) for "${testName}" were completed within the last 48 hours. Review existing results before re-ordering.`,
      canOverride: true,
      sourceData: { recent_results: recentResults.map((r) => ({ id: r.id, created_at: r.created_at })) },
    });
  }

  return alerts;
}

// ===================================================================
// checkCriticalLabValues
// ===================================================================

/**
 * Check if a lab result is in the critical range. Triggers immediate alert.
 * @param {Object} labResult - { test_name, value, unit?, patient_uid, encounter_id? }
 * @param {string} patientUid
 * @returns {Array<{type, severity, title, description, canOverride, sourceData}>}
 */
export async function checkCriticalLabValues(labResult, patientUid) {
  if (!labResult || !labResult.test_name || labResult.value === undefined || labResult.value === null) return [];

  const alerts = [];
  const testKey = labResult.test_name.toLowerCase().trim().replace(/\s+/g, '_');
  const value = parseFloat(labResult.value);

  if (Number.isNaN(value)) return [];

  const range = CRITICAL_LAB_RANGES[testKey];
  if (!range) return [];

  let severity = null;
  let title = null;
  let description = null;

  if (range.criticalLow !== null && value <= range.criticalLow) {
    severity = 'critical';
    title = `CRITICAL LOW: ${labResult.test_name} = ${value} ${range.unit}`;
    description = `Critically low ${labResult.test_name} value (${value} ${range.unit}). Critical low threshold: ${range.criticalLow} ${range.unit}. Immediate clinical action required.`;
  } else if (range.criticalHigh !== null && value >= range.criticalHigh) {
    severity = 'critical';
    title = `CRITICAL HIGH: ${labResult.test_name} = ${value} ${range.unit}`;
    description = `Critically high ${labResult.test_name} value (${value} ${range.unit}). Critical high threshold: ${range.criticalHigh} ${range.unit}. Immediate clinical action required.`;
  } else if (range.low !== null && value < range.low) {
    severity = 'warning';
    title = `LOW: ${labResult.test_name} = ${value} ${range.unit}`;
    description = `Low ${labResult.test_name} value (${value} ${range.unit}). Normal range: ${range.low}-${range.high} ${range.unit}.`;
  } else if (range.high !== null && value > range.high) {
    severity = 'warning';
    title = `HIGH: ${labResult.test_name} = ${value} ${range.unit}`;
    description = `High ${labResult.test_name} value (${value} ${range.unit}). Normal range: ${range.low}-${range.high} ${range.unit}.`;
  }

  if (severity) {
    const alert = {
      type: 'critical_lab',
      severity,
      title,
      description,
      canOverride: false,
      sourceData: { test_name: labResult.test_name, value, unit: range.unit, range },
    };
    alerts.push(alert);

    await persistCdsAlert({
      patientUid,
      encounterId: labResult.encounter_id,
      alertType: 'critical_lab',
      severity,
      title,
      description,
      sourceData: alert.sourceData,
    });
  }

  return alerts;
}

// ===================================================================
// getProtocolReminders
// ===================================================================

/**
 * Check active clinical protocols against patient's current conditions.
 * @param {string} patientUid
 * @param {string} encounterId
 * @returns {Array<{type, severity, title, description, canOverride, sourceData}>}
 */
export async function getProtocolReminders(patientUid, encounterId) {
  if (!patientUid) return [];

  const alerts = [];

  const protocols = await prisma.clinical_protocols.findMany({
    where: { is_active: true },
    select: {
      id: true, name: true, category: true,
      trigger_conditions: true, recommendations: true, priority: true,
    },
    // priority is a varchar (not int), so DESC text sort gets us
    // 'high' < 'medium' < 'low' alphabetically — wrong direction.
    // Apply a JS rank-sort below to match the pre-ORM intent.
  });

  if (protocols.length === 0) return [];

  // Sort high → medium → low by JS rank to match the SQL `ORDER BY priority DESC`
  // intent on a text column with these three values.
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  protocols.sort((a, b) => {
    const aRank = PRIORITY_RANK[a.priority] ?? 99;
    const bRank = PRIORITY_RANK[b.priority] ?? 99;
    return aRank - bRank;
  });

  // Fetch patient context (4 parallel typed queries replacing 4 raw SELECTs).
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const patientIntId = await resolveUserIdFromUid(patientUid);

  const [admissionRows, diagnosisRows, medicationRows, investigationRows] = await Promise.all([
    prisma.admissions.findMany({
      where: { patient_uid: patientUid, status: 'admitted' },
      select: {
        id: true, encounter_id: true, status: true, admission_type: true,
        department: true, chief_complaint: true, admitted_at: true,
        allergies: true, code_status: true,
      },
      orderBy: { admitted_at: 'desc' },
      take: 1,
    }),
    prisma.diagnoses.findMany({
      where: { patient_uid: patientUid, status: { in: ['active', 'chronic'] } },
      select: { id: true, icd10_code: true, description: true, status: true, diagnosis_type: true },
      orderBy: { created_at: 'desc' },
    }),
    prisma.prescriptions.findMany({
      where: { patient_uid: patientUid, status: 'active' },
      select: { medication_name: true },
    }),
    prisma.investigations.findMany({
      where: {
        OR: [
          { uid: patientUid },
          ...(patientIntId != null ? [{ patient_id: patientIntId }] : []),
        ],
      },
      select: {
        test_name: true, status: true,
        requested_at: true, updated_at: true, completed_at: true,
      },
    }),
  ]);

  // Filter recent investigations using coalesced timestamp in JS (mirrors
  // the SQL COALESCE(completed_at, updated_at, requested_at) >= 7d cutoff).
  const recentInvestigations = investigationRows
    .filter((row) => {
      const effective = row.completed_at ?? row.updated_at ?? row.requested_at;
      return effective && effective >= sevenDaysAgo;
    })
    .map((row) => ({
      test_name: row.test_name?.toLowerCase() ?? null,
      status: row.status,
    }));

  // Dedup recent test names (mirrors SQL DISTINCT LOWER(test_name)).
  const recentTestNames = [...new Set(recentInvestigations.map((t) => t.test_name).filter(Boolean))];

  // Dedup active medication names (mirrors SQL DISTINCT LOWER).
  const activeMeds = [...new Set(
    medicationRows.map((m) => m.medication_name?.toLowerCase()).filter(Boolean),
  )];

  const admission = admissionRows[0] || null;

  const patientCtx = {
    isAdmitted: !!admission,
    admissionType: admission?.admission_type || null,
    department: admission?.department?.toLowerCase() || null,
    chiefComplaint: admission?.chief_complaint?.toLowerCase() || '',
    daysAdmitted: admission ? Math.ceil((Date.now() - new Date(admission.admitted_at).getTime()) / (1000 * 60 * 60 * 24)) : 0,
    diagnosisCodes: diagnosisRows.map((d) => d.icd10_code).filter(Boolean),
    diagnosisDescriptions: diagnosisRows.map((d) => d.description?.toLowerCase()).filter(Boolean),
    activeMedications: activeMeds,
    recentTests: recentTestNames,
    codeStatus: admission?.code_status || null,
  };

  for (const protocol of protocols) {
    const triggered = evaluateProtocolTrigger(protocol.trigger_conditions, patientCtx);
    if (!triggered) continue;

    const unmetRecommendations = evaluateUnmetRecommendations(protocol.recommendations, patientCtx);

    if (unmetRecommendations.length > 0) {
      const alertSeverity = protocol.priority === 'high' ? 'warning' : 'info';

      const alert = {
        type: 'protocol_reminder',
        severity: alertSeverity,
        title: `Protocol: ${protocol.name}`,
        description: `Unmet recommendations: ${unmetRecommendations.join('; ')}`,
        canOverride: true,
        sourceData: {
          protocol_id: protocol.id,
          protocol_name: protocol.name,
          category: protocol.category,
          unmet: unmetRecommendations,
        },
      };

      alerts.push(alert);

      await persistCdsAlert({
        patientUid,
        encounterId,
        alertType: 'protocol_reminder',
        severity: alertSeverity,
        title: alert.title,
        description: alert.description,
        sourceData: alert.sourceData,
      });
    }
  }

  return alerts;
}

/**
 * Evaluate whether a protocol's trigger conditions are met.
 * trigger_conditions is a JSON object with optional keys:
 *   { is_admitted?, admission_type?, department?, diagnosis_contains?,
 *     days_admitted_gte?, code_status?, chief_complaint_contains? }
 */
function evaluateProtocolTrigger(conditions, ctx) {
  if (!conditions || typeof conditions !== 'object') return false;

  if (conditions.is_admitted && !ctx.isAdmitted) return false;

  if (conditions.admission_type) {
    if (Array.isArray(conditions.admission_type)) {
      if (!conditions.admission_type.includes(ctx.admissionType)) return false;
    } else if (ctx.admissionType !== conditions.admission_type) return false;
  }

  if (conditions.department) {
    const depts = Array.isArray(conditions.department) ? conditions.department : [conditions.department];
    if (!depts.some((d) => ctx.department?.includes(d.toLowerCase()))) return false;
  }

  if (conditions.diagnosis_contains) {
    const keywords = Array.isArray(conditions.diagnosis_contains) ? conditions.diagnosis_contains : [conditions.diagnosis_contains];
    const hasMatch = keywords.some((kw) =>
      ctx.diagnosisDescriptions.some((d) => d.includes(kw.toLowerCase())) ||
      ctx.diagnosisCodes.some((c) => c.toLowerCase().startsWith(kw.toLowerCase())),
    );
    if (!hasMatch) return false;
  }

  if (conditions.days_admitted_gte && ctx.daysAdmitted < conditions.days_admitted_gte) return false;

  if (conditions.chief_complaint_contains) {
    const keywords = Array.isArray(conditions.chief_complaint_contains) ? conditions.chief_complaint_contains : [conditions.chief_complaint_contains];
    if (!keywords.some((kw) => ctx.chiefComplaint.includes(kw.toLowerCase()))) return false;
  }

  return true;
}

/**
 * Evaluate which protocol recommendations are not yet met.
 * recommendations is a JSON object with optional keys:
 *   { medications?: [string], tests?: [string], actions?: [string] }
 */
function evaluateUnmetRecommendations(recommendations, ctx) {
  if (!recommendations || typeof recommendations !== 'object') return [];

  const unmet = [];

  if (Array.isArray(recommendations.medications)) {
    for (const med of recommendations.medications) {
      const medLower = med.toLowerCase();
      const isOrdered = ctx.activeMedications.some((m) => m.includes(medLower) || medLower.includes(m));
      if (!isOrdered) {
        unmet.push(`Order ${med}`);
      }
    }
  }

  if (Array.isArray(recommendations.tests)) {
    for (const test of recommendations.tests) {
      const testLower = test.toLowerCase();
      const isOrdered = ctx.recentTests.some((t) => t.includes(testLower) || testLower.includes(t));
      if (!isOrdered) {
        unmet.push(`Order ${test}`);
      }
    }
  }

  if (Array.isArray(recommendations.actions)) {
    // Actions are informational — always show as unmet (cannot auto-verify).
    unmet.push(...recommendations.actions);
  }

  return unmet;
}

// ===================================================================
// acknowledgeAlert
// ===================================================================

/**
 * Mark a CDS alert as acknowledged with optional override reason.
 * Wrapped in a transaction so the existence + acknowledged-flag check
 * and the UPDATE are serialised — closes a TOCTOU window the pre-ORM
 * version had between the SELECT and the UPDATE.
 * @param {number} alertId
 * @param {string} acknowledgedBy - UID of the acknowledging clinician
 * @param {string|null} overrideReason
 * @returns {Object} Updated alert row
 */
export async function acknowledgeAlert(alertId, acknowledgedBy, overrideReason = null) {
  if (!alertId || !acknowledgedBy) {
    throw AppError.badRequest('Alert ID and acknowledgedBy are required');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.cds_alerts.findUnique({
      where: { id: Number(alertId) },
      select: { id: true, acknowledged: true, source_data: true },
    });
    if (!existing) {
      throw AppError.notFound('CDS alert not found');
    }
    if (existing.acknowledged) {
      throw AppError.conflict('Alert is already acknowledged');
    }

    // Equivalent of `source_data || jsonb_build_object('override_reason', $3)` —
    // read-mutate-write. Prisma can't express jsonb_build_object directly.
    const baseSource = existing.source_data && typeof existing.source_data === 'object'
      ? existing.source_data : {};
    const nextSource = overrideReason
      ? { ...baseSource, override_reason: overrideReason }
      : baseSource;

    const row = await tx.cds_alerts.update({
      where: { id: Number(alertId) },
      data: {
        acknowledged: true,
        ack_by: acknowledgedBy,
        ack_at: new Date(),
        source_data: nextSource,
      },
      select: {
        id: true, patient_uid: true, encounter_id: true, alert_type: true,
        severity: true, title: true, description: true, source_data: true,
        acknowledged: true, ack_by: true, ack_at: true, created_at: true,
      },
    });

    return row;
  });

  // Public response shape preserved: alias ack_by → acknowledged_by,
  // ack_at → acknowledged_at, surface override_reason from source_data.
  const overrideFromSource = updated.source_data && typeof updated.source_data === 'object'
    ? updated.source_data.override_reason ?? null : null;
  const result = {
    id: updated.id,
    patient_uid: updated.patient_uid,
    encounter_id: updated.encounter_id,
    alert_type: updated.alert_type,
    severity: updated.severity,
    title: updated.title,
    description: updated.description,
    source_data: updated.source_data,
    acknowledged: updated.acknowledged,
    acknowledged_by: updated.ack_by,
    acknowledged_at: updated.ack_at,
    override_reason: overrideFromSource,
    created_at: updated.created_at,
  };

  await emitCdsAlertAcknowledged({
    alert: result,
    actorUid: acknowledgedBy,
    actorRole: 'CLINICAL',
  });

  logger.info(`CDS alert acknowledged: id=${alertId}, by=${acknowledgedBy}, override=${!!overrideReason}`);
  return result;
}

// ===================================================================
// getActiveAlerts
// ===================================================================

/**
 * List unacknowledged alerts for a patient.
 * @param {string} patientUid
 * @returns {Array} Unacknowledged CDS alerts
 */
export async function getActiveAlerts(patientUid) {
  if (!patientUid) {
    throw AppError.badRequest('Patient UID is required');
  }

  const rows = await prisma.cds_alerts.findMany({
    where: { patient_uid: patientUid, acknowledged: false },
    select: {
      id: true, patient_uid: true, encounter_id: true, alert_type: true,
      severity: true, title: true, description: true, source_data: true,
      acknowledged: true, ack_by: true, ack_at: true, created_at: true,
    },
  });

  // Pre-ORM ORDER BY: severity rank (critical → warning → info), then created_at DESC.
  rows.sort((a, b) => {
    const aRank = SEVERITY_RANK[a.severity] ?? 99;
    const bRank = SEVERITY_RANK[b.severity] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return (b.created_at?.getTime?.() ?? 0) - (a.created_at?.getTime?.() ?? 0);
  });

  return rows.map((row) => {
    const overrideFromSource = row.source_data && typeof row.source_data === 'object'
      ? row.source_data.override_reason ?? null : null;
    return {
      id: row.id,
      patient_uid: row.patient_uid,
      encounter_id: row.encounter_id,
      alert_type: row.alert_type,
      severity: row.severity,
      title: row.title,
      description: row.description,
      source_data: row.source_data,
      acknowledged: row.acknowledged,
      acknowledged_by: row.ack_by,
      acknowledged_at: row.ack_at,
      override_reason: overrideFromSource,
      created_at: row.created_at,
    };
  });
}

// ===================================================================
// Protocol management
// ===================================================================

/**
 * List clinical protocols with optional category filter.
 * Pre-batch-56 this surface was broken — the clinical_protocols table
 * didn't exist. Migration 093 added it; the typed call now succeeds.
 * @param {string|null} category
 * @returns {Array}
 */
export async function listProtocols(category = null) {
  return prisma.clinical_protocols.findMany({
    where: category ? { category } : undefined,
    select: {
      id: true, name: true, category: true,
      trigger_conditions: true, recommendations: true,
      priority: true, is_active: true, created_at: true,
    },
    orderBy: category
      ? [{ name: 'asc' }]
      : [{ category: 'asc' }, { name: 'asc' }],
  });
}

/**
 * Create a clinical protocol.
 * @param {Object} data - { name, category, trigger_conditions, recommendations, priority?, is_active? }
 * @returns {Object} Created protocol row
 */
export async function createProtocol(data) {
  const { name, category, trigger_conditions, recommendations, priority, is_active } = data;

  if (!name || !category || !trigger_conditions || !recommendations) {
    throw AppError.badRequest('name, category, trigger_conditions, and recommendations are required');
  }

  const created = await prisma.clinical_protocols.create({
    data: {
      name,
      category,
      trigger_conditions,
      recommendations,
      priority: priority || 'medium',
      is_active: is_active !== false,
    },
    select: {
      id: true, name: true, category: true,
      trigger_conditions: true, recommendations: true,
      priority: true, is_active: true, created_at: true,
    },
  });

  logger.info(`Clinical protocol created: id=${created.id}, name=${name}, category=${category}`);
  return created;
}

export default {
  checkOrder,
  checkDrugInteractions,
  checkAllergies,
  checkDuplicateOrders,
  checkRecentResults,
  checkCriticalLabValues,
  getProtocolReminders,
  acknowledgeAlert,
  getActiveAlerts,
  listProtocols,
  createProtocol,
};
