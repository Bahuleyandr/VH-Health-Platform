// src/services/emr/cdsEngine.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

// ===================================================================
// Clinical Decision Support (CDS) Engine
// Pluggable rule engine — each check function is independently callable.
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

// ===================================================================
// checkOrder — Master function
// ===================================================================

/**
 * Master CDS check. Runs all applicable checks for an order.
 * @param {Object} order - { type: 'medication'|'investigation', medication_name?, test_name?, details?, patient_uid, encounter_id? }
 * @param {Object} patientContext - Optional pre-fetched patient data
 * @returns {{ safe: boolean, alerts: Array<{type, severity, title, description, canOverride}> }}
 */
export async function checkOrder(order, patientContext = {}) {
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

    // Persist any critical/warning alerts
    for (const alert of alerts) {
      if (alert.severity === 'critical' || alert.severity === 'warning') {
        try {
          await db.query(
            `INSERT INTO cds_alerts (patient_uid, encounter_id, alert_type, severity, title, description, source_data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [
              order.patient_uid,
              order.encounter_id || null,
              alert.type,
              alert.severity,
              alert.title,
              alert.description,
              JSON.stringify(alert.sourceData || null),
            ]
          );
        } catch (persistErr) {
          logger.error(`Failed to persist CDS alert: ${persistErr.message}`);
        }
      }
    }

    const safe = alerts.every((a) => a.severity === 'info');

    return { safe, alerts };
  } catch (err) {
    logger.error(`CDS checkOrder error: ${err.message}`);
    // Fail open — return safe with a warning that CDS could not complete checks
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

  // Get patient's active medications from MAR and prescriptions
  const { rows: activeMeds } = await db.query(
    `SELECT DISTINCT LOWER(medication_name) AS medication_name
     FROM medication_administrations
     WHERE patient_uid = $1 AND status IN ('scheduled', 'administered')
       AND created_at >= NOW() - INTERVAL '7 days'
     UNION
     SELECT DISTINCT LOWER(medication_name) AS medication_name
     FROM prescriptions
     WHERE patient_uid = $1 AND status = 'active'`,
    [patientUid]
  );

  if (activeMeds.length === 0) return [];

  const activeNames = activeMeds.map((m) => m.medication_name);

  // Check drug_interactions table for each active medication
  for (const activeMed of activeNames) {
    if (activeMed === drugLower) continue; // skip self

    const { rows: interactions } = await db.query(
      `SELECT id, drug_a, drug_b, severity, description, clinical_effect, management
       FROM drug_interactions
       WHERE (LOWER(drug_a) = $1 AND LOWER(drug_b) = $2)
          OR (LOWER(drug_a) = $2 AND LOWER(drug_b) = $1)`,
      [drugLower, activeMed]
    );

    for (const interaction of interactions) {
      const alertSeverity = interaction.severity === 'contraindicated' ? 'critical'
        : interaction.severity === 'severe' ? 'critical'
        : interaction.severity === 'moderate' ? 'warning'
        : 'info';

      alerts.push({
        type: 'drug_interaction',
        severity: alertSeverity,
        title: `Drug interaction: ${medicationName} + ${interaction.drug_a === drugLower ? interaction.drug_b : interaction.drug_a}`,
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

  // Fetch allergies from admissions and health records
  const { rows: admissionAllergies } = await db.query(
    `SELECT allergies FROM admissions
     WHERE patient_uid = $1 AND status = 'admitted'
     ORDER BY admitted_at DESC LIMIT 1`,
    [patientUid]
  );

  const { rows: healthRecordAllergies } = await db.query(
    `SELECT allergies FROM health_records
     WHERE patient_uid = $1 AND allergies IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [patientUid]
  );

  // Combine all allergies into a flat list
  const allergySet = new Set();

  if (admissionAllergies.length > 0 && Array.isArray(admissionAllergies[0].allergies)) {
    for (const a of admissionAllergies[0].allergies) {
      allergySet.add(String(a).toLowerCase().trim());
    }
  }

  if (healthRecordAllergies.length > 0) {
    const hrAllergies = healthRecordAllergies[0].allergies;
    if (Array.isArray(hrAllergies)) {
      for (const a of hrAllergies) {
        allergySet.add(String(a).toLowerCase().trim());
      }
    } else if (typeof hrAllergies === 'string') {
      for (const a of hrAllergies.split(',')) {
        allergySet.add(a.toLowerCase().trim());
      }
    }
  }

  if (allergySet.size === 0) return [];

  // Direct substring match
  for (const allergy of allergySet) {
    if (!allergy) continue;

    if (drugLower.includes(allergy) || allergy.includes(drugLower)) {
      alerts.push({
        type: 'allergy',
        severity: 'critical',
        title: `Allergy alert: Patient allergic to "${allergy}"`,
        description: `The ordered medication "${medicationName}" matches or contains a known allergen "${allergy}". This order should NOT be placed without careful review.`,
        canOverride: true,
        sourceData: { medication: medicationName, allergy, match_type: 'direct' },
      });
    }
  }

  // Drug class cross-reference
  for (const [className, members] of Object.entries(DRUG_CLASS_MAP)) {
    const drugInClass = members.some((m) => drugLower.includes(m) || m.includes(drugLower));
    if (!drugInClass) continue;

    // Check if patient is allergic to any drug in the same class or the class name itself
    for (const allergy of allergySet) {
      const allergyMatchesClass = allergy.includes(className) || className.includes(allergy);
      const allergyMatchesMember = members.some((m) => allergy.includes(m) || m.includes(allergy));

      if (allergyMatchesClass || allergyMatchesMember) {
        // Avoid duplicate if already caught by direct match
        const alreadyCaught = alerts.some((a) => a.sourceData?.allergy === allergy && a.sourceData?.match_type === 'direct');
        if (!alreadyCaught) {
          alerts.push({
            type: 'allergy',
            severity: 'warning',
            title: `Drug class allergy: ${className} class`,
            description: `Patient is allergic to "${allergy}" which belongs to the ${className} drug class. "${medicationName}" is also in this class. Cross-sensitivity is possible.`,
            canOverride: true,
            sourceData: { medication: medicationName, allergy, drug_class: className, match_type: 'class' },
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

    // Check active prescriptions
    const { rows: activePrescriptions } = await db.query(
      `SELECT id, medication_name, dosage, frequency, status, created_at
       FROM prescriptions
       WHERE patient_uid = $1 AND status = 'active'
         AND LOWER(medication_name) = $2`,
      [patientUid, medLower]
    );

    // Check scheduled/recent MAR entries
    const { rows: scheduledMar } = await db.query(
      `SELECT id, medication_name, dose, status, created_at
       FROM medication_administrations
       WHERE patient_uid = $1 AND status = 'scheduled'
         AND LOWER(medication_name) = $2
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [patientUid, medLower]
    );

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

    const { rows: pendingTests } = await db.query(
      `SELECT id, test_name, status, created_at
       FROM investigations
       WHERE patient_uid = $1 AND status IN ('ordered', 'in_progress', 'collected')
         AND LOWER(test_name) = $2`,
      [patientUid, testLower]
    );

    if (pendingTests.length > 0) {
      alerts.push({
        type: 'duplicate_order',
        severity: 'warning',
        title: `Duplicate investigation: ${details.test_name}`,
        description: `Patient already has ${pendingTests.length} pending "${details.test_name}" order(s). Review before ordering again.`,
        canOverride: true,
        sourceData: { pending_tests: pendingTests.map((t) => ({ id: t.id, status: t.status, created_at: t.created_at })) },
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

  const { rows: recentResults } = await db.query(
    `SELECT id, test_name, status, result, created_at
     FROM investigations
     WHERE patient_uid = $1 AND status = 'completed'
       AND LOWER(test_name) = $2
       AND created_at >= NOW() - INTERVAL '48 hours'
     ORDER BY created_at DESC
     LIMIT 5`,
    [patientUid, testLower]
  );

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

  if (isNaN(value)) return [];

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

    // Persist critical lab alerts immediately
    try {
      await db.query(
        `INSERT INTO cds_alerts (patient_uid, encounter_id, alert_type, severity, title, description, source_data, created_at)
         VALUES ($1, $2, 'critical_lab', $3, $4, $5, $6, NOW())`,
        [
          patientUid,
          labResult.encounter_id || null,
          severity,
          title,
          description,
          JSON.stringify(alert.sourceData),
        ]
      );
    } catch (persistErr) {
      logger.error(`Failed to persist critical lab alert: ${persistErr.message}`);
    }
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

  // Fetch active protocols
  const { rows: protocols } = await db.query(
    `SELECT id, name, category, trigger_conditions, recommendations, priority
     FROM clinical_protocols
     WHERE is_active = true
     ORDER BY priority DESC`,
    []
  );

  if (protocols.length === 0) return [];

  // Fetch patient context
  const [admissionResult, diagnosisResult, medicationResult, investigationResult] = await Promise.all([
    db.query(
      `SELECT id, encounter_id, status, admission_type, department, chief_complaint, admitted_at, allergies, code_status
       FROM admissions WHERE patient_uid = $1 AND status = 'admitted' ORDER BY admitted_at DESC LIMIT 1`,
      [patientUid]
    ),
    db.query(
      `SELECT id, icd10_code, description, status, diagnosis_type
       FROM diagnoses WHERE patient_uid = $1 AND status IN ('active', 'chronic') ORDER BY created_at DESC`,
      [patientUid]
    ),
    db.query(
      `SELECT DISTINCT LOWER(medication_name) AS medication_name
       FROM prescriptions WHERE patient_uid = $1 AND status = 'active'`,
      [patientUid]
    ),
    db.query(
      `SELECT DISTINCT LOWER(test_name) AS test_name, status
       FROM investigations WHERE patient_uid = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
      [patientUid]
    ),
  ]);

  const admission = admissionResult.rows[0] || null;
  const diagnoses = diagnosisResult.rows;
  const activeMeds = medicationResult.rows.map((m) => m.medication_name);
  const recentTests = investigationResult.rows;

  // Build a patient context object for protocol matching
  const patientCtx = {
    isAdmitted: !!admission,
    admissionType: admission?.admission_type || null,
    department: admission?.department?.toLowerCase() || null,
    chiefComplaint: admission?.chief_complaint?.toLowerCase() || '',
    daysAdmitted: admission ? Math.ceil((Date.now() - new Date(admission.admitted_at).getTime()) / (1000 * 60 * 60 * 24)) : 0,
    diagnosisCodes: diagnoses.map((d) => d.icd10_code).filter(Boolean),
    diagnosisDescriptions: diagnoses.map((d) => d.description?.toLowerCase()).filter(Boolean),
    activeMedications: activeMeds,
    recentTests: recentTests.map((t) => t.test_name),
    codeStatus: admission?.code_status || null,
  };

  for (const protocol of protocols) {
    const triggered = evaluateProtocolTrigger(protocol.trigger_conditions, patientCtx);
    if (!triggered) continue;

    // Check if recommendations are already met (simple check)
    const recommendations = protocol.recommendations;
    const unmetRecommendations = evaluateUnmetRecommendations(recommendations, patientCtx);

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

      // Persist protocol reminder
      try {
        await db.query(
          `INSERT INTO cds_alerts (patient_uid, encounter_id, alert_type, severity, title, description, source_data, created_at)
           VALUES ($1, $2, 'protocol_reminder', $3, $4, $5, $6, NOW())`,
          [patientUid, encounterId || null, alertSeverity, alert.title, alert.description, JSON.stringify(alert.sourceData)]
        );
      } catch (persistErr) {
        logger.error(`Failed to persist protocol reminder: ${persistErr.message}`);
      }
    }
  }

  return alerts;
}

/**
 * Evaluate whether a protocol's trigger conditions are met.
 * trigger_conditions is a JSON object with optional keys:
 *   { admission_type?, department?, diagnosis_contains?, days_admitted_gte?, code_status? }
 */
function evaluateProtocolTrigger(conditions, ctx) {
  if (!conditions || typeof conditions !== 'object') return false;

  // All specified conditions must match (AND logic)
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
      ctx.diagnosisCodes.some((c) => c.toLowerCase().startsWith(kw.toLowerCase()))
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
 * Returns array of unmet recommendation descriptions.
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
    // Actions are informational — always show as unmet (cannot auto-verify)
    unmet.push(...recommendations.actions);
  }

  return unmet;
}

// ===================================================================
// acknowledgeAlert
// ===================================================================

/**
 * Mark a CDS alert as acknowledged with optional override reason.
 * @param {number} alertId
 * @param {string} acknowledgedBy - UID of the acknowledging clinician
 * @param {string|null} overrideReason
 * @returns {Object} Updated alert row
 */
export async function acknowledgeAlert(alertId, acknowledgedBy, overrideReason = null) {
  if (!alertId || !acknowledgedBy) {
    throw AppError.badRequest('Alert ID and acknowledgedBy are required');
  }

  const { rows: existing } = await db.query(
    `SELECT id, acknowledged FROM cds_alerts WHERE id = $1`,
    [alertId]
  );

  if (existing.length === 0) {
    throw AppError.notFound('CDS alert not found');
  }

  if (existing[0].acknowledged) {
    throw AppError.conflict('Alert is already acknowledged');
  }

  const { rows } = await db.query(
    `UPDATE cds_alerts
     SET acknowledged = true, acknowledged_by = $2, acknowledged_at = NOW(), override_reason = $3
     WHERE id = $1
     RETURNING id, patient_uid, encounter_id, alert_type, severity, title, description,
               source_data, acknowledged, acknowledged_by, acknowledged_at, override_reason, created_at`,
    [alertId, acknowledgedBy, overrideReason || null]
  );

  logger.info(`CDS alert acknowledged: id=${alertId}, by=${acknowledgedBy}, override=${!!overrideReason}`);
  return rows[0];
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

  const { rows } = await db.query(
    `SELECT id, patient_uid, encounter_id, alert_type, severity, title, description,
            source_data, acknowledged, acknowledged_by, acknowledged_at, override_reason, created_at
     FROM cds_alerts
     WHERE patient_uid = $1 AND acknowledged = false
     ORDER BY
       CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       created_at DESC`,
    [patientUid]
  );

  return rows;
}

// ===================================================================
// Protocol management
// ===================================================================

/**
 * List clinical protocols with optional category filter.
 * @param {string|null} category
 * @returns {Array}
 */
export async function listProtocols(category = null) {
  if (category) {
    const { rows } = await db.query(
      `SELECT id, name, category, trigger_conditions, recommendations, priority, is_active, created_at
       FROM clinical_protocols WHERE category = $1 ORDER BY name`,
      [category]
    );
    return rows;
  }

  const { rows } = await db.query(
    `SELECT id, name, category, trigger_conditions, recommendations, priority, is_active, created_at
     FROM clinical_protocols ORDER BY category, name`,
    []
  );
  return rows;
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

  const { rows } = await db.query(
    `INSERT INTO clinical_protocols (name, category, trigger_conditions, recommendations, priority, is_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, name, category, trigger_conditions, recommendations, priority, is_active, created_at`,
    [
      name,
      category,
      JSON.stringify(trigger_conditions),
      JSON.stringify(recommendations),
      priority || 'medium',
      is_active !== false,
    ]
  );

  logger.info(`Clinical protocol created: id=${rows[0].id}, name=${name}, category=${category}`);
  return rows[0];
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
