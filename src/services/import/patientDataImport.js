// src/services/import/patientDataImport.js
// Imports patient data from FHIR Bundles and C-CDA XML documents.
// Includes deduplication to avoid creating duplicate records on re-import.

import db from '../../config/database.js';
import { fromFhirPatient } from '../fhir/fhirAdapter.js';
import logger from '../../logging/logger.js';

// =============================================================================
// FHIR BUNDLE IMPORT
// =============================================================================

/**
 * Import a FHIR Bundle into the VH Health database.
 * Supports Patient, Condition, MedicationRequest, and Observation resources.
 * @param {Object} bundle - FHIR Bundle resource
 * @param {string} importedBy - UID of the user performing the import
 * @returns {Object} Import results with counts and errors
 */
export async function importFhirBundle(bundle, importedBy) {
  if (!bundle || bundle.resourceType !== 'Bundle') {
    throw new Error('Invalid FHIR Bundle: resourceType must be Bundle');
  }

  const results = { imported: 0, skipped: 0, errors: [] };

  for (const entry of bundle.entry || []) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) {
      results.skipped++;
      continue;
    }

    try {
      switch (resource.resourceType) {
        case 'Patient':
          await importPatient(resource, importedBy);
          break;
        case 'Condition':
          await importCondition(resource, importedBy);
          break;
        case 'MedicationRequest':
          await importMedication(resource, importedBy);
          break;
        case 'Observation':
          await importObservation(resource, importedBy);
          break;
        default:
          results.skipped++;
          continue;
      }
      results.imported++;
    } catch (err) {
      logger.warn(`FHIR import error for ${resource.resourceType}/${resource.id}: ${err.message}`);
      results.errors.push({
        resource: resource.resourceType,
        id: resource.id,
        error: err.message,
      });
    }
  }

  logger.info(`FHIR Bundle import complete: ${results.imported} imported, ${results.skipped} skipped, ${results.errors.length} errors`);
  return results;
}

// =============================================================================
// C-CDA IMPORT
// =============================================================================

/**
 * Import a C-CDA XML document into the VH Health database.
 * Extracts patient demographics, problems, medications, and allergies from the XML.
 * @param {string} xmlString - C-CDA XML content
 * @param {string} importedBy - UID of the user performing the import
 * @returns {Object} Import results
 */
export async function importCCDA(xmlString, importedBy) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('Invalid C-CDA: expected XML string');
  }

  const results = { imported: 0, skipped: 0, errors: [] };

  try {
    // Extract patient demographics
    const patientData = extractCCDAPatient(xmlString);
    if (patientData) {
      await importPatientFromCCDA(patientData, importedBy);
      results.imported++;
    }

    // Extract problems/diagnoses
    const problems = extractCCDASection(xmlString, '11450-4');
    for (const problem of problems) {
      try {
        await importDiagnosisFromCCDA(problem, patientData?.uid, importedBy);
        results.imported++;
      } catch (err) {
        results.errors.push({ resource: 'Problem', error: err.message });
      }
    }

    // Extract medications
    const medications = extractCCDASection(xmlString, '10160-0');
    for (const med of medications) {
      try {
        await importMedicationFromCCDA(med, patientData?.uid, importedBy);
        results.imported++;
      } catch (err) {
        results.errors.push({ resource: 'Medication', error: err.message });
      }
    }

    // Extract allergies
    const allergies = extractCCDASection(xmlString, '48765-2');
    for (const allergy of allergies) {
      try {
        await importAllergyFromCCDA(allergy, patientData?.uid, importedBy);
        results.imported++;
      } catch (err) {
        results.errors.push({ resource: 'Allergy', error: err.message });
      }
    }
  } catch (err) {
    logger.error(`C-CDA import failed: ${err.message}`);
    results.errors.push({ resource: 'CDA', error: err.message });
  }

  logger.info(`C-CDA import complete: ${results.imported} imported, ${results.skipped} skipped, ${results.errors.length} errors`);
  return results;
}

// =============================================================================
// FHIR RESOURCE IMPORTERS (with deduplication)
// =============================================================================

async function importPatient(fhirPatient, importedBy) {
  const patient = fromFhirPatient(fhirPatient);
  if (!patient || !patient.phone) {
    throw new Error('Patient must have a phone number');
  }

  // Dedup by phone
  const { rows: existing } = await db.query(
    `SELECT uid FROM users WHERE phone = $1 LIMIT 1`,
    [patient.phone]
  );

  if (existing.length) {
    // Update existing patient with any new data
    const updates = [];
    const params = [];
    let idx = 1;

    if (patient.name) { updates.push(`name = $${idx++}`); params.push(patient.name); }
    if (patient.gender) { updates.push(`gender = $${idx++}`); params.push(patient.gender); }
    if (patient.birthday) { updates.push(`birthday = $${idx++}`); params.push(patient.birthday); }
    if (patient.address) { updates.push(`address = $${idx++}`); params.push(patient.address); }
    if (patient.email) { updates.push(`email = $${idx++}`); params.push(patient.email); }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      await db.query(
        `UPDATE users SET ${updates.join(', ')} WHERE uid = $${idx}`,
        [...params, existing[0].uid]
      );
      logger.info(`Updated existing patient ${existing[0].uid} from FHIR import`);
    }
    return;
  }

  // Create new patient — generate UID
  const uid = `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.query(
    `INSERT INTO users (uid, phone, name, gender, birthday, address, email, role, is_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PATIENT', true, NOW())`,
    [uid, patient.phone, patient.name, patient.gender, patient.birthday, patient.address, patient.email]
  );
  logger.info(`Created new patient ${uid} from FHIR import`);
}

async function importCondition(fhirCondition, importedBy) {
  if (!fhirCondition || fhirCondition.resourceType !== 'Condition') return;

  const patientRef = fhirCondition.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('Condition missing patient reference');

  const description = fhirCondition.code?.text ||
    fhirCondition.code?.coding?.[0]?.display || 'Imported condition';
  const icd10Code = fhirCondition.code?.coding?.find(
    c => c.system === 'http://hl7.org/fhir/sid/icd-10-cm'
  )?.code || null;

  const clinicalStatus = fhirCondition.clinicalStatus?.coding?.[0]?.code || 'active';

  // Dedup: check by patient + icd10 code + description
  const { rows: existing } = await db.query(
    `SELECT id FROM diagnoses
     WHERE patient_uid = $1 AND (
       (icd10_code IS NOT NULL AND icd10_code = $2)
       OR (description = $3)
     ) LIMIT 1`,
    [patientUid, icd10Code, description]
  );

  if (existing.length) {
    logger.info(`Skipped duplicate condition for patient ${patientUid}: ${description}`);
    return;
  }

  await db.query(
    `INSERT INTO diagnoses (patient_uid, icd10_code, description, status, onset_date, diagnosed_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      patientUid,
      icd10Code,
      description,
      clinicalStatus,
      fhirCondition.onsetDateTime || null,
      importedBy,
    ]
  );
}

async function importMedication(fhirMedication, importedBy) {
  if (!fhirMedication || fhirMedication.resourceType !== 'MedicationRequest') return;

  const patientRef = fhirMedication.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('MedicationRequest missing patient reference');

  const medication = fhirMedication.medicationCodeableConcept?.text ||
    fhirMedication.medicationCodeableConcept?.coding?.[0]?.display || 'Imported medication';
  const note = fhirMedication.note?.[0]?.text || null;

  // Map FHIR status back to VH Health
  const statusMap = {
    active: 'PENDING',
    completed: 'DISPENSED',
    cancelled: 'CANCELLED',
    stopped: 'REJECTED',
    'on-hold': 'ON_HOLD',
  };
  const status = statusMap[fhirMedication.status] || 'PENDING';

  // Dedup: check recent orders for same patient + medication text
  const { rows: existing } = await db.query(
    `SELECT id FROM pharmacy_orders
     WHERE uid = $1 AND medication = $2 AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [patientUid, medication]
  );

  if (existing.length) {
    logger.info(`Skipped duplicate medication for patient ${patientUid}: ${medication}`);
    return;
  }

  await db.query(
    `INSERT INTO pharmacy_orders (uid, medication, order_note, status, prescribed_by, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [patientUid, medication, note, status, importedBy]
  );
}

async function importObservation(fhirObservation, importedBy) {
  if (!fhirObservation || fhirObservation.resourceType !== 'Observation') return;

  const patientRef = fhirObservation.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('Observation missing patient reference');

  // Only import vital signs
  const category = fhirObservation.category?.[0]?.coding?.[0]?.code;
  if (category !== 'vital-signs') {
    logger.info(`Skipped non-vital observation for patient ${patientUid}`);
    return;
  }

  const loincCode = fhirObservation.code?.coding?.[0]?.code || '';
  const value = fhirObservation.valueQuantity?.value ?? fhirObservation.valueString;
  const recordedAt = fhirObservation.effectiveDateTime || new Date().toISOString();

  if (value == null) return;

  // Map LOINC to vitals_chart columns
  const columnMap = {
    '8867-4': 'heart_rate',
    '8480-6': 'systolic_bp',
    '8462-4': 'diastolic_bp',
    '8310-5': 'temperature',
    '2708-6': 'spo2',
    '9279-1': 'respiratory_rate',
    '2339-0': 'blood_glucose',
  };

  const column = columnMap[loincCode];
  if (!column) {
    logger.info(`Skipped observation with unknown LOINC code ${loincCode} for patient ${patientUid}`);
    return;
  }

  // Dedup: check for a vitals record within same minute
  const { rows: existing } = await db.query(
    `SELECT id FROM vitals_chart
     WHERE patient_uid = $1 AND recorded_at BETWEEN $2::timestamp - INTERVAL '1 minute' AND $2::timestamp + INTERVAL '1 minute'
     LIMIT 1`,
    [patientUid, recordedAt]
  );

  if (existing.length) {
    // Update existing record with the new vital value
    await db.query(
      `UPDATE vitals_chart SET ${column} = $1 WHERE id = $2`,
      [value, existing[0].id]
    );
    return;
  }

  // Create new vitals record
  await db.query(
    `INSERT INTO vitals_chart (patient_uid, ${column}, recorded_at, recorded_by, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [patientUid, value, recordedAt, importedBy]
  );
}

// =============================================================================
// C-CDA XML EXTRACTORS (simple regex-based parsing)
// =============================================================================

function extractCCDAPatient(xml) {
  try {
    const patient = {};

    // Extract patient ID
    const idMatch = xml.match(/<recordTarget>[\s\S]*?<id\s+root="([^"]+)"[\s\S]*?<\/recordTarget>/);
    if (idMatch) patient.uid = idMatch[1];

    // Extract name
    const nameMatch = xml.match(/<recordTarget>[\s\S]*?<given>([^<]+)<\/given>[\s\S]*?<\/recordTarget>/);
    if (nameMatch) patient.name = unescapeXml(nameMatch[1]);

    // Extract phone
    const phoneMatch = xml.match(/<recordTarget>[\s\S]*?<telecom\s+value="tel:([^"]+)"[\s\S]*?<\/recordTarget>/);
    if (phoneMatch) patient.phone = phoneMatch[1];

    // Extract gender
    const genderMatch = xml.match(/<administrativeGenderCode\s+code="([^"]+)"/);
    if (genderMatch) {
      const genderMap = { M: 'Male', F: 'Female', UN: null };
      patient.gender = genderMap[genderMatch[1]] || null;
    }

    // Extract birthdate
    const birthMatch = xml.match(/<birthTime\s+value="([^"]+)"/);
    if (birthMatch) {
      const val = birthMatch[1];
      if (val.length >= 8) {
        patient.birthday = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
      }
    }

    // Extract address
    const addrMatch = xml.match(/<recordTarget>[\s\S]*?<addr>([^<]*)<\/addr>[\s\S]*?<\/recordTarget>/);
    if (addrMatch) patient.address = unescapeXml(addrMatch[1]);

    return patient.phone || patient.uid ? patient : null;
  } catch (err) {
    logger.warn(`Failed to extract patient from C-CDA: ${err.message}`);
    return null;
  }
}

/**
 * Extract entries from a C-CDA section identified by LOINC code.
 * Returns an array of { code, displayName, text } objects.
 */
function extractCCDASection(xml, loincCode) {
  const entries = [];

  try {
    // Find the section with this LOINC code
    const sectionRegex = new RegExp(
      `<section>[\\s\\S]*?<code\\s+code="${loincCode}"[\\s\\S]*?</section>`,
      'g'
    );
    const sectionMatch = xml.match(sectionRegex);
    if (!sectionMatch) return entries;

    const sectionXml = sectionMatch[0];

    // Extract displayName values from entries
    const displayNameRegex = /displayName="([^"]+)"/g;
    let match;
    const seen = new Set();
    while ((match = displayNameRegex.exec(sectionXml)) !== null) {
      const name = unescapeXml(match[1]);
      // Skip generic/structural display names
      if (name && !seen.has(name) && !isStructuralDisplayName(name)) {
        seen.add(name);
        entries.push({ displayName: name, text: name });
      }
    }

    // Also extract originalText values
    const originalTextRegex = /<originalText>([^<]+)<\/originalText>/g;
    while ((match = originalTextRegex.exec(sectionXml)) !== null) {
      const text = unescapeXml(match[1]);
      if (text && !seen.has(text)) {
        seen.add(text);
        entries.push({ displayName: text, text });
      }
    }
  } catch (err) {
    logger.warn(`Failed to extract C-CDA section ${loincCode}: ${err.message}`);
  }

  return entries;
}

function isStructuralDisplayName(name) {
  const structural = [
    'Problem', 'Medications', 'Allergies', 'Vital Signs', 'Procedures',
    'Results', 'Problem List', 'Assertion',
  ];
  return structural.includes(name);
}

// =============================================================================
// C-CDA RESOURCE IMPORTERS
// =============================================================================

async function importPatientFromCCDA(patientData, importedBy) {
  if (!patientData.phone) {
    logger.warn('C-CDA patient has no phone number, skipping patient import');
    return;
  }

  // Dedup by phone
  const { rows: existing } = await db.query(
    `SELECT uid FROM users WHERE phone = $1 LIMIT 1`,
    [patientData.phone]
  );

  if (existing.length) {
    patientData.uid = existing[0].uid;
    logger.info(`Patient already exists: ${existing[0].uid}`);
    return;
  }

  const uid = `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  patientData.uid = uid;

  await db.query(
    `INSERT INTO users (uid, phone, name, gender, birthday, address, role, is_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'PATIENT', true, NOW())`,
    [uid, patientData.phone, patientData.name, patientData.gender, patientData.birthday, patientData.address]
  );
  logger.info(`Created new patient ${uid} from C-CDA import`);
}

async function importDiagnosisFromCCDA(problem, patientUid, importedBy) {
  if (!patientUid || !problem.displayName) return;

  // Dedup
  const { rows: existing } = await db.query(
    `SELECT id FROM diagnoses WHERE patient_uid = $1 AND description = $2 LIMIT 1`,
    [patientUid, problem.displayName]
  );
  if (existing.length) return;

  await db.query(
    `INSERT INTO diagnoses (patient_uid, description, status, diagnosed_by, created_at)
     VALUES ($1, $2, 'active', $3, NOW())`,
    [patientUid, problem.displayName, importedBy]
  );
}

async function importMedicationFromCCDA(med, patientUid, importedBy) {
  if (!patientUid || !med.displayName) return;

  // Dedup
  const { rows: existing } = await db.query(
    `SELECT id FROM pharmacy_orders WHERE uid = $1 AND medication = $2 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
    [patientUid, med.displayName]
  );
  if (existing.length) return;

  await db.query(
    `INSERT INTO pharmacy_orders (uid, medication, status, prescribed_by, created_at)
     VALUES ($1, $2, 'PENDING', $3, NOW())`,
    [patientUid, med.displayName, importedBy]
  );
}

async function importAllergyFromCCDA(allergy, patientUid, importedBy) {
  if (!patientUid || !allergy.displayName) return;

  // Dedup
  const { rows: existing } = await db.query(
    `SELECT id FROM allergies WHERE patient_uid = $1 AND (allergen = $2 OR name = $2) LIMIT 1`,
    [patientUid, allergy.displayName]
  );
  if (existing.length) return;

  await db.query(
    `INSERT INTO allergies (patient_uid, allergen, name, recorded_at)
     VALUES ($1, $2, $2, NOW())`,
    [patientUid, allergy.displayName]
  );
}

// =============================================================================
// HELPERS
// =============================================================================

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export default { importFhirBundle, importCCDA };
