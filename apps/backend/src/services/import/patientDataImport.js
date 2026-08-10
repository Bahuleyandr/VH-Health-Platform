// src/services/import/patientDataImport.js
// Imports patient data from FHIR Bundles and C-CDA XML documents.
// Includes deduplication to avoid creating duplicate records on re-import.

import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { fromFhirPatient } from '../fhir/fhirAdapter.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function importedUidOrNew(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : crypto.randomUUID();
}

// =============================================================================
// FHIR BUNDLE IMPORT
// =============================================================================

/**
 * Import a FHIR Bundle into the VH Health database.
 * Supports Patient, Condition, MedicationRequest, and Observation resources.
 * @param {Object} bundle - FHIR Bundle resource
 * @param {string} importedBy - UID of the user performing the import
 * @param {{tenantId?: string|null}} options
 * @returns {Object} Import results with counts and errors
 */
export async function importFhirBundle(bundle, importedBy, { tenantId = null } = {}) {
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
          await importPatient(resource, importedBy, { tenantId });
          break;
        case 'Condition':
          await importCondition(resource, importedBy, { tenantId });
          break;
        case 'MedicationRequest':
          await importMedication(resource, importedBy, { tenantId });
          break;
        case 'Observation':
          await importObservation(resource, importedBy, { tenantId });
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
 * @param {{tenantId?: string|null}} options
 * @returns {Object} Import results
 */
export async function importCCDA(xmlString, importedBy, { tenantId = null } = {}) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('Invalid C-CDA: expected XML string');
  }

  const results = { imported: 0, skipped: 0, errors: [] };

  try {
    // Extract patient demographics
    const patientData = extractCCDAPatient(xmlString);
    if (patientData) {
      await importPatientFromCCDA(patientData, importedBy, { tenantId });
      results.imported++;
    }

    // Extract problems/diagnoses
    const problems = extractCCDASection(xmlString, '11450-4');
    for (const problem of problems) {
      try {
        await importDiagnosisFromCCDA(problem, patientData?.uid, importedBy, { tenantId });
        results.imported++;
      } catch (err) {
        results.errors.push({ resource: 'Problem', error: err.message });
      }
    }

    // Extract medications
    const medications = extractCCDASection(xmlString, '10160-0');
    for (const med of medications) {
      try {
        await importMedicationFromCCDA(med, patientData?.uid, importedBy, { tenantId });
        results.imported++;
      } catch (err) {
        results.errors.push({ resource: 'Medication', error: err.message });
      }
    }

    // Extract allergies
    const allergies = extractCCDASection(xmlString, '48765-2');
    for (const allergy of allergies) {
      try {
        await importAllergyFromCCDA(allergy, patientData?.uid, importedBy, { tenantId });
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

async function findPatientByUid(patientUid, tenantId = null) {
  if (!patientUid) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, phone, tenant_id
       FROM users
      WHERE uid = $1::uuid
        AND role = 'PATIENT'
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      LIMIT 1`,
    patientUid,
    tenantId,
  );
  return rows[0] || null;
}

async function assertPatientInTenant(patientUid, tenantId = null) {
  const patient = await findPatientByUid(patientUid, tenantId);
  if (!patient) {
    throw AppError.forbidden('Imported resource references a patient outside this tenant', 'IMPORT_PATIENT_TENANT_MISMATCH');
  }
  return patient;
}

async function importPatient(fhirPatient, _importedBy, { tenantId = null } = {}) {
  const patient = fromFhirPatient(fhirPatient);
  if (!patient || !patient.phone) {
    throw new Error('Patient must have a phone number');
  }

  // Dedup by phone inside the caller tenant only. If the phone exists in
  // another tenant, do not update that chart from this import.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id
       FROM users
      WHERE phone = $1
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      LIMIT 1`,
    patient.phone,
    tenantId,
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
      await prisma.$queryRawUnsafe(
        `UPDATE users
            SET ${updates.join(', ')}
          WHERE uid = $${idx}::uuid
            AND ($${idx + 1}::uuid IS NULL OR tenant_id = $${idx + 1}::uuid)`,
        ...params, existing[0].uid, tenantId
      );
      logger.info(`Updated existing patient ${existing[0].uid} from FHIR import`);
    }
    return;
  }

  // Create new patient — generate UID
  const uid = importedUidOrNew(patient.uid);
  await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, gender, birthday, address, email, role, is_active, registered_at)
     VALUES ($1, COALESCE($2::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $3, $4, $5, $6, $7, $8, 'PATIENT', true, NOW())`,
    uid, tenantId, patient.phone, patient.name, patient.gender, patient.birthday, patient.address, patient.email
  );
  logger.info(`Created new patient ${uid} from FHIR import`);
}

async function importCondition(fhirCondition, importedBy, { tenantId = null } = {}) {
  if (!fhirCondition || fhirCondition.resourceType !== 'Condition') return;

  const patientRef = fhirCondition.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('Condition missing patient reference');
  await assertPatientInTenant(patientUid, tenantId);

  const description = fhirCondition.code?.text ||
    fhirCondition.code?.coding?.[0]?.display || 'Imported condition';
  const icd10Code = fhirCondition.code?.coding?.find(
    c => c.system === 'http://hl7.org/fhir/sid/icd-10-cm'
  )?.code || null;

  const clinicalStatus = fhirCondition.clinicalStatus?.coding?.[0]?.code || 'active';

  // Dedup: check by patient + icd10 code + description
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM diagnoses
     WHERE patient_uid = $1::uuid
       AND ($4::uuid IS NULL OR tenant_id = $4::uuid)
       AND (
       (icd10_code IS NOT NULL AND icd10_code = $2)
       OR (description = $3)
     ) LIMIT 1`,
    patientUid, icd10Code, description, tenantId
  );

  if (existing.length) {
    logger.info(`Skipped duplicate condition for patient ${patientUid}: ${description}`);
    return;
  }

  await prisma.$queryRawUnsafe(
    `INSERT INTO diagnoses (tenant_id, patient_uid, icd10_code, description, status, onset_date, diagnosed_by, created_at)
     VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $2::uuid, $3, $4, $5, $6, $7, NOW())`,
    
      tenantId,
      patientUid,
      icd10Code,
      description,
      clinicalStatus,
      fhirCondition.onsetDateTime || null,
      importedBy,
    
  );
}

async function importMedication(fhirMedication, importedBy, { tenantId = null } = {}) {
  if (!fhirMedication || fhirMedication.resourceType !== 'MedicationRequest') return;

  const patientRef = fhirMedication.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('MedicationRequest missing patient reference');
  const patient = await assertPatientInTenant(patientUid, tenantId);

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
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM pharmacy_orders
     WHERE uid = $1::uuid
       AND medication = $2
       AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    patientUid, medication, tenantId
  );

  if (existing.length) {
    logger.info(`Skipped duplicate medication for patient ${patientUid}: ${medication}`);
    return;
  }

  await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_orders (tenant_id, uid, phone, medication, order_note, status, prescribed_by, created_at)
     VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $2::uuid, $3, $4, $5, $6, $7, NOW())`,
    tenantId, patientUid, patient.phone || '', medication, note || '', status, importedBy
  );
}

async function importObservation(fhirObservation, importedBy, { tenantId = null } = {}) {
  if (!fhirObservation || fhirObservation.resourceType !== 'Observation') return;

  const patientRef = fhirObservation.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('Observation missing patient reference');
  await assertPatientInTenant(patientUid, tenantId);

  // Only import vital signs
  const category = fhirObservation.category?.[0]?.coding?.[0]?.code;
  if (category !== 'vital-signs') {
    logger.info(`Skipped non-vital observation for patient ${patientUid}`);
    return;
  }

  const loincCode = fhirObservation.code?.coding?.[0]?.code || '';
  const value = fhirObservation.valueQuantity?.value ?? fhirObservation.valueString;
  const recordedAt = fhirObservation.effectiveDateTime || new Date().toISOString();

  if (value === null || value === undefined) return;

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

  // Audit 2026-08-10 R8 — imports must NEVER rewrite charted data in place.
  // The old path did a source-blind ±1-minute dedupe and then UPDATEd the
  // matched row (typically a staff-charted one), with no timeline/audit
  // trail, and its INSERT branch omitted source so imports masqueraded as
  // staff-charted. Dedupe is now idempotency-only: skip when a prior
  // 'fhir'-sourced row already carries this vital in the ±1-minute window
  // (a re-import of the same bundle); anything else — including a
  // staff-charted near-duplicate — gets its own new sourced row.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM vitals_chart
     WHERE patient_uid = $1::uuid
       AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
       AND source = 'fhir'
       AND ${column} IS NOT NULL
       AND recorded_at BETWEEN $2::timestamp - INTERVAL '1 minute' AND $2::timestamp + INTERVAL '1 minute'
     LIMIT 1`,
    patientUid, recordedAt, tenantId
  );

  if (existing.length) {
    logger.info(`Skipped duplicate FHIR ${column} observation for patient ${patientUid} (re-import within dedupe window)`);
    return;
  }

  // Route through the real vitals write path: plausibility gates, canonical
  // timeline + audit events in the same transaction, NEWS2 scoring/escalation
  // and anomaly detection all apply, and the row carries source 'fhir'
  // (recorded_at backdating is exempt for fhir ingest — imported observation
  // timestamps are legitimately old).
  const payload = {
    patient_uid: patientUid,
    [column]: typeof value === 'number' ? value : Number(value),
    recorded_at: recordedAt,
    recorded_by: importedBy,
    source: 'fhir',
    ...(tenantId ? { tenant_id: tenantId } : {}),
  };
  // Temperature unit contract: canonical storage is Celsius; a Fahrenheit
  // valueQuantity must say so or it would be read as °C.
  if (column === 'temperature') {
    const unit = String(fhirObservation.valueQuantity?.unit || fhirObservation.valueQuantity?.code || '').replace(/[[\]]/g, '');
    if (/^deg ?f$|^f$|fahrenheit/i.test(unit)) payload.temperature_unit = 'F';
  }
  const { recordVitals } = await import('../emr/vitalsChartService.js');
  await recordVitals(payload);
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

async function importPatientFromCCDA(patientData, _importedBy, { tenantId = null } = {}) {
  if (!patientData.phone) {
    logger.warn('C-CDA patient has no phone number, skipping patient import');
    return;
  }

  // Dedup by phone inside the caller tenant only.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE phone = $1
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      LIMIT 1`,
    patientData.phone,
    tenantId
  );

  if (existing.length) {
    patientData.uid = existing[0].uid;
    logger.info(`Patient already exists: ${existing[0].uid}`);
    return;
  }

  const uid = importedUidOrNew(patientData.uid);
  patientData.uid = uid;

  await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, gender, birthday, address, role, is_active, registered_at)
     VALUES ($1, COALESCE($2::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $3, $4, $5, $6, $7, 'PATIENT', true, NOW())`,
    uid, tenantId, patientData.phone, patientData.name, patientData.gender, patientData.birthday, patientData.address
  );
  logger.info(`Created new patient ${uid} from C-CDA import`);
}

async function importDiagnosisFromCCDA(problem, patientUid, importedBy, { tenantId = null } = {}) {
  if (!patientUid || !problem.displayName) return;
  await assertPatientInTenant(patientUid, tenantId);

  // Dedup
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM diagnoses
     WHERE patient_uid = $1::uuid
       AND description = $2
       AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
     LIMIT 1`,
    patientUid, problem.displayName, tenantId
  );
  if (existing.length) return;

  await prisma.$queryRawUnsafe(
    `INSERT INTO diagnoses (tenant_id, patient_uid, description, status, diagnosed_by, created_at)
     VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $2::uuid, $3, 'active', $4, NOW())`,
    tenantId, patientUid, problem.displayName, importedBy
  );
}

async function importMedicationFromCCDA(med, patientUid, importedBy, { tenantId = null } = {}) {
  if (!patientUid || !med.displayName) return;
  const patient = await assertPatientInTenant(patientUid, tenantId);

  // Dedup
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM pharmacy_orders
     WHERE uid = $1::uuid
       AND medication = $2
       AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    patientUid, med.displayName, tenantId
  );
  if (existing.length) return;

  await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_orders (tenant_id, uid, phone, medication, order_note, status, prescribed_by, created_at)
     VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $2::uuid, $3, $4, $4, 'PENDING', $5, NOW())`,
    tenantId, patientUid, patient.phone || '', med.displayName, importedBy
  );
}

async function importAllergyFromCCDA(allergy, patientUid, _importedBy, { tenantId = null } = {}) {
  if (!patientUid || !allergy.displayName) return;
  await assertPatientInTenant(patientUid, tenantId);

  // Dedup
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM allergies
     WHERE patient_uid = $1::uuid
       AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
       AND (allergen = $2 OR name = $2)
     LIMIT 1`,
    patientUid, allergy.displayName, tenantId
  );
  if (existing.length) return;

  await prisma.$queryRawUnsafe(
    `INSERT INTO allergies (tenant_id, patient_uid, allergen, name, recorded_at)
     VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $2::uuid, $3, $3, NOW())`,
    tenantId, patientUid, allergy.displayName
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
