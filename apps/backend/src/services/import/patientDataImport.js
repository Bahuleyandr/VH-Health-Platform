// src/services/import/patientDataImport.js
// Imports patient data from FHIR Bundles and C-CDA XML documents.
// Includes deduplication to avoid creating duplicate records on re-import.

import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { fromFhirPatient } from '../fhir/fhirAdapter.js';
import { fhirObservationToVitals } from '../fhir/observationVitalsMapper.js';

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

  const results = {
    imported: 0,
    skipped: 0,
    deduplicated: 0,
    errors: [],
    observationPartitions: [],
  };
  const observationGroups = new Map();
  for (const entry of bundle.entry || []) {
    const resource = entry?.resource;
    const key = fhirVitalSetKey(resource);
    if (!key) continue;
    const group = observationGroups.get(key) || [];
    group.push(resource);
    observationGroups.set(key, group);
  }
  const importedObservationGroups = new Set();

  for (const entry of bundle.entry || []) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) {
      results.skipped++;
      continue;
    }

    let resources = [resource];
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
        case 'Observation': {
          const groupKey = fhirVitalSetKey(resource);
          if (groupKey) {
            if (importedObservationGroups.has(groupKey)) continue;
            importedObservationGroups.add(groupKey);
            resources = observationGroups.get(groupKey) || resources;
          }
          const outcomes = await importObservationSet(resources, importedBy, { tenantId });
          for (const outcome of outcomes) {
            const { resources: outcomeResources, resourceErrors, ...publicOutcome } = outcome;
            results.observationPartitions.push(publicOutcome);
            if (outcome.status === 'imported') results.imported += outcome.resourceCount;
            if (outcome.status === 'deduplicated') results.deduplicated += outcome.resourceCount;
            if (outcome.status === 'skipped') results.skipped += outcome.resourceCount;
            if (outcome.error) {
              for (const failedResource of outcomeResources) {
                const resourceKey = failedResource.id || '(no id)';
                const error = resourceErrors?.get(resourceKey) || outcome.error;
                logger.warn(`FHIR import error for ${failedResource.resourceType}/${resourceKey}: ${error}`);
                results.errors.push({
                  resource: failedResource.resourceType,
                  id: failedResource.id,
                  error,
                  ...(outcome.errorCode ? { code: outcome.errorCode } : {}),
                });
              }
            }
          }
          resources = [];
          break;
        }
        default:
          results.skipped++;
          continue;
      }
      results.imported += resources.length;
    } catch (err) {
      for (const failedResource of resources) {
        logger.warn(`FHIR import error for ${failedResource.resourceType}/${failedResource.id}: ${err.message}`);
        results.errors.push({
          resource: failedResource.resourceType,
          id: failedResource.id,
          error: err.message,
        });
      }
    }
  }

  logger.info(
    `FHIR Bundle import complete: ${results.imported} imported, ${results.deduplicated} deduplicated, `
    + `${results.skipped} skipped, ${results.errors.length} errors`,
  );
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

function fhirVitalSetKey(fhirObservation) {
  if (!fhirObservation || fhirObservation.resourceType !== 'Observation') return null;
  const hasVitalCategory = (fhirObservation.category || []).some((category) => (
    (category?.coding || []).some(({ code }) => code === 'vital-signs')
  ));
  const patientRef = fhirObservation.subject?.reference || '';
  const patientUid = patientRef.startsWith('Patient/')
    ? patientRef.slice('Patient/'.length).toLowerCase()
    : '';
  const observedAt = fhirObservation.effectiveDateTime || fhirObservation.issued;
  if (!hasVitalCategory || !patientUid || !observedAt) return null;
  const parsed = new Date(observedAt);
  const timestampKey = Number.isNaN(parsed.getTime()) ? String(observedAt) : parsed.toISOString();
  return JSON.stringify([patientUid, timestampKey]);
}

function canonicalCoding(codeable) {
  return (Array.isArray(codeable?.coding) ? codeable.coding : [])
    .map((coding) => ({
      system: coding?.system ? String(coding.system).trim() : null,
      version: coding?.version ? String(coding.version).trim() : null,
      code: coding?.code ? String(coding.code).trim() : null,
    }))
    .filter(({ system, code }) => system || code)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalIdentifiers(identifiers) {
  return (Array.isArray(identifiers) ? identifiers : [])
    .map((identifier) => ({
      system: identifier?.system ? String(identifier.system).trim() : null,
      value: identifier?.value ? String(identifier.value).trim() : null,
      use: identifier?.use ? String(identifier.use).trim() : null,
      type: canonicalCoding(identifier?.type),
    }))
    .filter(({ system, value }) => system || value)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalNumber(value) {
  return Number(Number(value).toPrecision(12));
}

function canonicalObservationValues(values, temperatureUnit) {
  return Object.fromEntries([...values.entries()]
    .map(([field, value]) => {
      const canonicalValue = field === 'temperature' && temperatureUnit === 'F'
        ? ((value - 32) * 5) / 9
        : value;
      return [field, canonicalNumber(canonicalValue)];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function prepareFhirVitalObservation(fhirObservation) {
  if (!fhirObservation || fhirObservation.resourceType !== 'Observation') return null;

  const patientRef = fhirObservation.subject?.reference || '';
  const patientUid = patientRef.startsWith('Patient/')
    ? patientRef.slice('Patient/'.length).toLowerCase()
    : '';
  if (!patientUid) throw new Error('Observation missing patient reference');

  const hasVitalCategory = (fhirObservation.category || []).some((category) => (
    (category?.coding || []).some(({ code }) => code === 'vital-signs')
  ));
  if (!hasVitalCategory) {
    logger.info(`Skipped non-vital observation for patient ${patientUid}`);
    return null;
  }

  const sourceTimestamp = fhirObservation.effectiveDateTime || fhirObservation.issued;
  if (!sourceTimestamp) {
    throw AppError.badRequest(
      'FHIR vital Observation must include effectiveDateTime or issued',
      'FHIR_OBSERVATION_TIMESTAMP_REQUIRED',
    );
  }
  const timestamp = new Date(sourceTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw AppError.badRequest(
      'FHIR vital Observation has an invalid effectiveDateTime or issued timestamp',
      'FHIR_OBSERVATION_TIMESTAMP_INVALID',
    );
  }

  const recordedAt = timestamp.toISOString();
  const resourceId = fhirObservation.id == null
    ? null
    : String(fhirObservation.id).trim() || null;
  if (resourceId && resourceId.length > 255) {
    throw AppError.badRequest(
      'FHIR Observation id exceeds the supported 255-character limit',
      'FHIR_OBSERVATION_ID_INVALID',
    );
  }
  const loincCode = fhirObservation.code?.coding?.[0]?.code || '';
  const components = Array.isArray(fhirObservation.component) ? fhirObservation.component : [];
  const mapped = fhirObservationToVitals(fhirObservation);
  const values = new Map(Object.entries(mapped.vitals));
  if (values.size === 0) {
    const codes = mapped.unmapped.length > 0 ? mapped.unmapped.join(', ') : loincCode;
    logger.info(`Skipped observation with unknown LOINC code(s) ${codes} for patient ${patientUid}`);
    return null;
  }

  const fingerprintPayload = {
    resourceId,
    identifiers: canonicalIdentifiers(fhirObservation.identifier),
    patientUid,
    recordedAt,
    rootCoding: canonicalCoding(fhirObservation.code),
    componentCodings: components
      .map((component) => canonicalCoding(component.code))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    mappedLoincCodes: [...mapped.mapped].sort(),
    values: canonicalObservationValues(values, mapped.temperatureUnit),
  };
  // `/import/fhir-bundle` has no authenticated upstream namespace/version
  // contract. A non-empty Observation.id is therefore a tenant+patient
  // logical identity (enforced by migration 656), not a server-scoped one.
  // fullUrl/meta.versionId are intentionally excluded: canonically identical
  // content replays, while changed content under the same id conflicts.
  const resourceFingerprint = `fhir:${crypto.createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex')}`;

  return {
    values,
    patientUid,
    recordedAt,
    resourceFingerprint,
    resourceId,
    loincCodes: mapped.mapped,
    temperatureUnit: mapped.temperatureUnit,
    resource: fhirObservation,
  };
}

function sourceDeviceForObservationSet(observations) {
  const memberFingerprints = observations.map((observation) => observation.resourceFingerprint).sort();
  return `fhir-set:${crypto.createHash('sha256').update(JSON.stringify(memberFingerprints)).digest('hex')}`;
}

class FhirObservationReplay extends Error {
  constructor(reason, matchedSetFingerprint = null) {
    super(reason);
    this.name = 'FhirObservationReplay';
    this.matchedSetFingerprint = matchedSetFingerprint;
  }
}

function observationOutcome(status, resources, details = {}) {
  return {
    status,
    resourceCount: resources.length,
    resourceIds: resources.map(({ id }) => id || null),
    resources,
    ...details,
  };
}

async function claimFhirObservationSet({
  tx,
  tenantId,
  patientUid,
  importedBy,
  recordedAt,
  setFingerprint,
  observations,
}) {
  const observedAt = new Date(recordedAt);
  const claimedSet = await tx.$queryRawUnsafe(
    `INSERT INTO fhir_vital_observation_sets
       (tenant_id, set_fingerprint, patient_uid, observed_at, imported_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::uuid)
     ON CONFLICT (tenant_id, set_fingerprint) DO NOTHING
     RETURNING set_fingerprint`,
    tenantId, setFingerprint, patientUid, observedAt, importedBy,
  );
  if (claimedSet.length === 0) {
    throw new FhirObservationReplay('Exact FHIR Observation set replay', setFingerprint);
  }

  let newResourceReceipts = 0;
  const ordered = [...observations].sort((a, b) => (
    a.resourceFingerprint.localeCompare(b.resourceFingerprint)
  ));
  for (const observation of ordered) {
    let inserted;
    try {
      inserted = await tx.$queryRawUnsafe(
        `INSERT INTO fhir_vital_observation_receipts
           (tenant_id, resource_fingerprint, patient_uid, resource_id, observed_at, loinc_codes)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::timestamptz, $6::text[])
         ON CONFLICT (tenant_id, resource_fingerprint) DO NOTHING
         RETURNING resource_fingerprint`,
        tenantId,
        observation.resourceFingerprint,
        patientUid,
        observation.resourceId,
        observedAt,
        observation.loincCodes,
      );
    } catch (error) {
      const sqlState = error?.meta?.code
        || error?.meta?.driverAdapterError?.cause?.originalCode
        || error?.code;
      if (
        sqlState === '23505'
        && observation.resourceId
      ) {
        throw AppError.conflict(
          `FHIR Observation id ${observation.resourceId} was already imported with different canonical content`,
          'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
        );
      }
      throw error;
    }
    newResourceReceipts += inserted.length;
  }

  const conflictingResourceFingerprints = [];
  for (const observation of ordered) {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO fhir_vital_observation_set_resources
         (tenant_id, set_fingerprint, resource_fingerprint)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (tenant_id, resource_fingerprint) DO NOTHING
       RETURNING resource_fingerprint`,
      tenantId, setFingerprint, observation.resourceFingerprint,
    );
    if (inserted.length === 0) {
      conflictingResourceFingerprints.push(observation.resourceFingerprint);
    }
  }

  if (conflictingResourceFingerprints.length > 0) {
    const owners = await tx.$queryRawUnsafe(
      `SELECT links.set_fingerprint, COUNT(*)::integer AS owned_count
         FROM fhir_vital_observation_set_resources links
         JOIN fhir_vital_observation_sets sets
           ON sets.tenant_id = links.tenant_id
          AND sets.set_fingerprint = links.set_fingerprint
        WHERE links.tenant_id = $1::uuid
          AND links.resource_fingerprint = ANY($2::varchar[])
          AND sets.vitals_chart_id IS NOT NULL
        GROUP BY links.set_fingerprint
        ORDER BY links.set_fingerprint`,
      tenantId, conflictingResourceFingerprints,
    );
    if (
      conflictingResourceFingerprints.length === observations.length
      && owners.length === 1
      && Number(owners[0].owned_count) === observations.length
    ) {
      throw new FhirObservationReplay(
        'FHIR Observation subset already belongs to a committed composite set',
        owners[0].set_fingerprint,
      );
    }
    throw AppError.conflict(
      'FHIR Observation set overlaps a committed composite set and cannot be partially augmented',
      'FHIR_OBSERVATION_SET_OVERLAP',
    );
  }

  return {
    setFingerprint,
    newResourceReceipts,
    reusedResourceReceipts: observations.length - newResourceReceipts,
  };
}

async function findCommittedFhirSet(tenantId, setFingerprint) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT vitals_chart_id
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid
          AND set_fingerprint = $2
          AND vitals_chart_id IS NOT NULL`,
      tenantId, setFingerprint,
    );
    return rows[0] || null;
  });
}

async function importObservationSet(fhirObservations, importedBy, { tenantId = null } = {}) {
  const observations = [];
  const skippedResources = [];
  const resourceErrors = new Map();
  for (const resource of fhirObservations) {
    try {
      const prepared = prepareFhirVitalObservation(resource);
      if (prepared) observations.push(prepared);
      else skippedResources.push(resource);
    } catch (error) {
      resourceErrors.set(resource.id || '(no id)', error.message);
    }
  }

  if (resourceErrors.size > 0) {
    const firstError = resourceErrors.values().next().value;
    for (const resource of fhirObservations) {
      const resourceKey = resource.id || '(no id)';
      if (!resourceErrors.has(resourceKey)) {
        resourceErrors.set(
          resourceKey,
          `FHIR vital set rejected atomically because another same-time Observation is invalid: ${firstError}`,
        );
      }
    }
    return [observationOutcome('error', fhirObservations, {
      error: `FHIR vital set rejected atomically: ${firstError}`,
      resourceErrors,
    })];
  }
  if (observations.length === 0) {
    return [observationOutcome('skipped', skippedResources)];
  }

  const patientUid = observations[0].patientUid;
  const recordedAt = observations[0].recordedAt;
  if (observations.some((observation) => (
    observation.patientUid !== patientUid || observation.recordedAt !== recordedAt
  ))) {
    throw AppError.badRequest('FHIR vital-sign set must reference one patient and one effectiveDateTime');
  }
  const patient = await assertPatientInTenant(patientUid, tenantId);
  const resolvedTenantId = tenantId || patient.tenant_id;

  const values = new Map();
  for (const observation of observations) {
    for (const [field, value] of observation.values) {
      if (values.has(field)) {
        const error = `FHIR Observations at the same timestamp map to the same canonical vital field (${field})`;
        return [observationOutcome('error', fhirObservations, { error })];
      }
      values.set(field, value);
    }
  }

  const setFingerprint = sourceDeviceForObservationSet(observations);
  const payload = {
    patient_uid: patientUid,
    ...Object.fromEntries(values),
    recorded_at: recordedAt,
    recorded_by: importedBy,
    source: 'fhir',
    source_device: setFingerprint,
    tenant_id: resolvedTenantId,
  };
  const temperatureObservation = observations.find(({ values: mappedValues }) => (
    mappedValues.has('temperature')
  ));
  if (temperatureObservation?.temperatureUnit) {
    payload.temperature_unit = temperatureObservation.temperatureUnit;
  }

  const { recordVitals } = await import('../emr/vitalsChartService.js');
  let claimEvidence = null;
  try {
    const result = await recordVitals(payload, {
      beforeWrite: async ({ tx }) => {
        claimEvidence = await claimFhirObservationSet({
          tx,
          tenantId: resolvedTenantId,
          patientUid,
          importedBy,
          recordedAt,
          setFingerprint,
          observations,
        });
        return claimEvidence;
      },
      beforeCommit: async ({ tx, vitals }) => {
        const linked = await tx.$executeRawUnsafe(
          `UPDATE fhir_vital_observation_sets
              SET vitals_chart_id = $3::integer
            WHERE tenant_id = $1::uuid
              AND set_fingerprint = $2
              AND vitals_chart_id IS NULL`,
          resolvedTenantId, setFingerprint, vitals.id,
        );
        if (linked !== 1) {
          throw new Error('FHIR Observation set receipt could not be linked to its vitals row');
        }
      },
    });
    const vitals = result?.vitals || result;
    const outcomes = [observationOutcome('imported', observations.map(({ resource }) => resource), {
      setFingerprint,
      vitalsChartId: vitals.id,
      newResourceReceipts: claimEvidence.newResourceReceipts,
      reusedResourceReceipts: claimEvidence.reusedResourceReceipts,
    })];
    if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
    return outcomes;
  } catch (error) {
    if (error instanceof FhirObservationReplay) {
      logger.info(
        `Skipped duplicate FHIR observation set for patient ${patientUid} (${error.message})`,
      );
      const outcomes = [observationOutcome(
        'deduplicated',
        observations.map(({ resource }) => resource),
        { setFingerprint, matchedSetFingerprint: error.matchedSetFingerprint },
      )];
      if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
      return outcomes;
    }

    const committed = await findCommittedFhirSet(resolvedTenantId, setFingerprint).catch(() => null);
    if (committed) {
      const outcomes = [observationOutcome('imported', observations.map(({ resource }) => resource), {
        setFingerprint,
        vitalsChartId: committed.vitals_chart_id,
        newResourceReceipts: claimEvidence?.newResourceReceipts ?? null,
        reusedResourceReceipts: claimEvidence?.reusedResourceReceipts ?? null,
        error: `FHIR vitals were committed, but post-commit processing failed: ${error.message}`,
      })];
      if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
      return outcomes;
    }
    return [observationOutcome('error', fhirObservations, {
      error: error.message,
      errorCode: error.code || 'FHIR_OBSERVATION_IMPORT_FAILED',
    })];
  }
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
