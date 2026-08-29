// src/services/import/patientDataImport.js
// Imports patient data from FHIR Bundles and C-CDA XML documents.
// Includes deduplication to avoid creating duplicate records on re-import.

import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  lockTenantPatientMergeStability,
  PATIENT_MERGE_STABILITY_TIMEOUT_MS,
} from '../../utils/patientMergeStabilityLock.js';
import { fromFhirPatient } from '../fhir/fhirAdapter.js';
import { createFhirAllergyIntolerance } from '../fhir/fhirAllergyIntoleranceService.js';
import { fhirObservationToVitals } from '../fhir/observationVitalsMapper.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FHIR_EFFECT_LEASE_SECONDS = 300;
const FHIR_EFFECT_RETRY_BASE_SECONDS = 120;
const FHIR_EFFECT_RETRY_MAX_SECONDS = 3600;
const FHIR_EFFECT_SWEEP_MAX = 100;
const GOVERNED_IMPORT_CLINICAL_ASSERTION_PROMOTION_ENABLED = false;

function fhirEffectRetrySeconds(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 1) - 1, 5));
  return Math.min(FHIR_EFFECT_RETRY_BASE_SECONDS * (2 ** exponent), FHIR_EFFECT_RETRY_MAX_SECONDS);
}

function stableImportJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableImportJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableImportJson(value[key]);
      return result;
    }, {});
  }
  return value ?? null;
}

function requiredImportTenantId(value) {
  const tenantId = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(tenantId)) {
    throw AppError.forbidden('Clinical import requires explicit tenant authority', 'IMPORT_TENANT_REQUIRED');
  }
  return tenantId;
}

function requiredImportPatientUid(value) {
  const patientUid = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(patientUid)) {
    throw AppError.badRequest(
      'Clinical import requires one explicit target patient UUID',
      'IMPORT_TARGET_PATIENT_REQUIRED',
    );
  }
  return patientUid;
}

function fhirPatientIdentifierUid(resource) {
  const candidate = (resource?.identifier || []).find((identifier) => (
    identifier?.system === 'urn:vhhealth:uid' && UUID_RE.test(String(identifier?.value || ''))
  ));
  return candidate ? String(candidate.value).toLowerCase() : null;
}

function normalizeFhirBundlePatientReferences(bundle, targetPatientUid) {
  const canonicalReference = `Patient/${targetPatientUid}`;
  const acceptedReferences = new Set([canonicalReference, targetPatientUid]);
  for (const entry of bundle.entry || []) {
    const resource = entry?.resource;
    if (resource?.resourceType !== 'Patient') continue;
    const identifierUid = fhirPatientIdentifierUid(resource);
    if (identifierUid && identifierUid !== targetPatientUid) {
      throw AppError.conflict(
        'FHIR Bundle patient identity does not match the authorised target patient',
        'IMPORT_PATIENT_IDENTITY_MISMATCH',
      );
    }
    if (resource.id) {
      acceptedReferences.add(String(resource.id));
      acceptedReferences.add(`Patient/${resource.id}`);
    }
    if (entry.fullUrl) acceptedReferences.add(String(entry.fullUrl));
  }

  const entries = (bundle.entry || []).map((entry) => {
    const resource = structuredClone(entry?.resource || null);
    if (!resource) return { ...entry, resource };
    if (resource.resourceType === 'Patient') {
      resource.id = targetPatientUid;
      resource.identifier = [
        ...(Array.isArray(resource.identifier) ? resource.identifier.filter((identifier) => (
          identifier?.system !== 'urn:vhhealth:uid'
        )) : []),
        { system: 'urn:vhhealth:uid', value: targetPatientUid },
      ];
      return { ...entry, resource };
    }
    const referenceHolder = resource.subject || resource.patient;
    if (referenceHolder?.reference) {
      const reference = String(referenceHolder.reference);
      if (!acceptedReferences.has(reference)) {
        throw AppError.conflict(
          `${resource.resourceType} references a patient outside the authorised import manifest`,
          'IMPORT_RESOURCE_PATIENT_MISMATCH',
          { resource_type: resource.resourceType, resource_id: resource.id || null },
        );
      }
      referenceHolder.reference = canonicalReference;
    } else if (['Condition', 'MedicationRequest', 'AllergyIntolerance', 'Observation']
      .includes(resource.resourceType)) {
      throw AppError.badRequest(
        `${resource.resourceType} is missing its patient reference`,
        'IMPORT_RESOURCE_PATIENT_REQUIRED',
      );
    }
    return { ...entry, resource };
  });
  const priority = { Patient: 0, Condition: 1, MedicationRequest: 1, AllergyIntolerance: 1, Observation: 2 };
  entries.sort((left, right) => (
    (priority[left.resource?.resourceType] ?? 1) - (priority[right.resource?.resourceType] ?? 1)
  ));
  return { ...bundle, entry: entries };
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
export async function importFhirBundle(bundle, importedBy, {
  tenantId = null,
  authority = null,
  beforeFhirVitalWrite = null,
} = {}) {
  if (!bundle || bundle.resourceType !== 'Bundle') {
    throw new Error('Invalid FHIR Bundle: resourceType must be Bundle');
  }

  const tid = requiredImportTenantId(tenantId);
  const targetPatientUid = requiredImportPatientUid(authority?.patientUid);
  const normalizedBundle = normalizeFhirBundlePatientReferences(bundle, targetPatientUid);
  const gatedAssertion = (normalizedBundle.entry || []).find(({ resource }) => (
    resource?.resourceType === 'Condition' || resource?.resourceType === 'AllergyIntolerance'
  ));
  if (gatedAssertion) {
    throw AppError.conflict(
      'External diagnoses and allergies require a governed review and promotion workflow',
      'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      {
        resource_type: gatedAssertion.resource.resourceType,
        resource_id: gatedAssertion.resource.id || null,
      },
    );
  }
  return setTenantTx(tid, async (lockTx) => {
    await lockTenantPatientMergeStability(lockTx, tid);
    return importFhirBundleWithStablePatientSnapshot(normalizedBundle, importedBy, {
      tenantId: tid,
      authority: { ...authority, patientUid: targetPatientUid },
      db: lockTx,
      beforeFhirVitalWrite,
    });
  }, { timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS });
}

async function importFhirBundleWithStablePatientSnapshot(bundle, importedBy, {
  tenantId,
  authority,
  db,
  beforeFhirVitalWrite,
}) {

  const results = {
    imported: 0,
    skipped: 0,
    deduplicated: 0,
    errors: [],
    observationPartitions: [],
  };
  const {
    groups: observationGroups,
    groupKeyByResource: observationGroupKeyByResource,
  } = buildExplicitFhirVitalGroups(bundle.entry || []);
  const importedObservationGroups = new Set();
  let implicitObservationGroupsBuilt = false;

  for (const entry of bundle.entry || []) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) {
      results.skipped++;
      continue;
    }

    let resources = [resource];
    try {
      let outcome = null;
      switch (resource.resourceType) {
        case 'Patient':
          outcome = await importPatient(resource, importedBy, { tenantId, authority, db });
          break;
        case 'Condition':
          outcome = await importCondition(resource, importedBy, { tenantId, authority, db });
          break;
        case 'MedicationRequest':
          outcome = await importMedication(resource, importedBy, { tenantId, authority, db });
          break;
        case 'AllergyIntolerance':
          outcome = await importAllergyIntolerance(resource, importedBy, { tenantId, authority, db });
          break;
        case 'Observation': {
          let groupKey = observationGroupKeyByResource.get(resource);
          if (!groupKey && !implicitObservationGroupsBuilt) {
            await addResolvedImplicitFhirVitalGroups(bundle.entry || [], {
              tenantId,
              groups: observationGroups,
              groupKeyByResource: observationGroupKeyByResource,
            });
            implicitObservationGroupsBuilt = true;
            groupKey = observationGroupKeyByResource.get(resource);
          }
          const group = groupKey ? observationGroups.get(groupKey) : null;
          if (groupKey) {
            if (importedObservationGroups.has(groupKey)) continue;
            importedObservationGroups.add(groupKey);
            resources = group?.resources || resources;
          }
          const outcomes = await importObservationSet(resources, importedBy, {
            tenantId,
            groupParent: group?.parent || null,
            groupMembers: group?.members || null,
            beforeFhirVitalWrite,
          });
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
      if (outcome === 'imported') results.imported += resources.length;
      else if (outcome === 'deduplicated') results.deduplicated += resources.length;
      else if (resources.length) results.skipped += resources.length;
    } catch (err) {
      if (err instanceof AppError || err?.statusCode) throw err;
      for (const failedResource of resources) {
        logger.warn(`FHIR import error for ${failedResource.resourceType}/${failedResource.id}: ${err.message}`);
        results.errors.push({
          resource: failedResource.resourceType,
          id: failedResource.id,
          error: err.message,
          ...(err?.code ? { code: err.code } : {}),
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
export async function importCCDA(xmlString, importedBy, {
  tenantId = null,
  authority = null,
} = {}) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw AppError.badRequest('Invalid C-CDA: expected XML string', 'CCDA_XML_REQUIRED');
  }
  const tid = requiredImportTenantId(tenantId);
  const patientUid = requiredImportPatientUid(authority?.patientUid);
  const parsed = parseCcdaClinicalDocument(xmlString);
  if (parsed.patient?.uid && UUID_RE.test(String(parsed.patient.uid))
    && String(parsed.patient.uid).toLowerCase() !== patientUid) {
    throw AppError.conflict(
      'C-CDA recordTarget does not match the authorised target patient',
      'IMPORT_PATIENT_IDENTITY_MISMATCH',
    );
  }
  const results = await setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    await importPatientFromCCDA(parsed.patient, importedBy, {
      tenantId: tid,
      authority: { ...authority, patientUid },
      db: tx,
    });
    const outcome = { imported: 0, skipped: 0, deduplicated: 1, errors: [] };
    for (const problem of parsed.problems) {
      await importDiagnosisFromCCDA(problem, patientUid, importedBy, {
        tenantId: tid,
        authority,
        db: tx,
      });
    }
    for (const allergy of parsed.allergies) {
      await importAllergyFromCCDA(allergy, patientUid, importedBy, {
        tenantId: tid,
        authority,
        db: tx,
      });
    }
    for (let lineIndex = 0; lineIndex < parsed.medications.length; lineIndex += 1) {
      const medication = parsed.medications[lineIndex];
      const status = await importMedicationFromCCDA(
        medication,
        patientUid,
        importedBy,
        { tenantId: tid, authority, db: tx, lineIndex },
      );
      if (status === 'imported') outcome.imported += 1;
      else if (status === 'deduplicated') outcome.deduplicated += 1;
      else outcome.skipped += 1;
    }
    return outcome;
  }, { timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS });
  logger.info(
    `C-CDA import complete: ${results.imported} imported, ${results.deduplicated} deduplicated, `
    + `${results.skipped} skipped`,
  );
  return results;
}

// =============================================================================
// FHIR RESOURCE IMPORTERS (with deduplication)
// =============================================================================

async function findPatientByUid(patientUid, tenantId = null) {
  if (!patientUid) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, phone, tenant_id
       FROM users
      WHERE uid = $1::uuid
        AND role = 'PATIENT'
        AND is_active=TRUE
        AND status='active'
        AND is_deleted=FALSE
        AND merged_into_uid IS NULL
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

async function resolveFhirVitalPatientInTenant(patientUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH RECURSIVE patient_chain AS (
       SELECT uid, phone, tenant_id, is_active, status, merged_into_uid,
              ARRAY[uid]::uuid[] AS path, 0 AS depth
         FROM users
        WHERE uid = $1::uuid
          AND role = 'PATIENT'
          AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
       UNION ALL
       SELECT successor.uid, successor.phone, successor.tenant_id,
              successor.is_active, successor.status, successor.merged_into_uid,
              chain.path || successor.uid, chain.depth + 1
         FROM patient_chain AS chain
         JOIN users AS successor
           ON successor.tenant_id = chain.tenant_id
          AND successor.uid = chain.merged_into_uid
          AND successor.role = 'PATIENT'
        WHERE chain.depth < 16
          AND NOT successor.uid = ANY(chain.path)
     )
     SELECT uid, phone, tenant_id, is_active, status, merged_into_uid, depth
       FROM patient_chain
      ORDER BY depth DESC
      LIMIT 1`,
    patientUid,
    tenantId,
  );
  const patient = rows[0];
  if (!patient) {
    throw AppError.forbidden(
      'Imported resource references a patient outside this tenant',
      'IMPORT_PATIENT_TENANT_MISMATCH',
    );
  }
  if (patient.merged_into_uid || patient.is_active !== true || patient.status === 'merged') {
    throw AppError.conflict(
      'Imported FHIR vital references an inactive patient identity with no active merge survivor',
      'FHIR_OBSERVATION_PATIENT_INACTIVE',
    );
  }
  return patient;
}

async function importPatient(fhirPatient, _importedBy, {
  tenantId = null,
  authority = null,
  db = prisma,
} = {}) {
  const targetPatientUid = requiredImportPatientUid(authority?.patientUid);
  const patient = fromFhirPatient(fhirPatient);
  if (!patient) {
    throw AppError.badRequest('FHIR Patient resource is invalid', 'IMPORT_PATIENT_INVALID');
  }
  const existing = await db.$queryRawUnsafe(
    `SELECT id, uid, phone, tenant_id
       FROM users
      WHERE tenant_id=$1::uuid
        AND uid=$2::uuid
        AND role='PATIENT'
        AND is_active=TRUE
        AND status='active'
        AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      LIMIT 1`,
    tenantId,
    targetPatientUid,
  );
  if (!existing.length) {
    throw AppError.notFound('Authorised import patient not found', 'IMPORT_TARGET_PATIENT_NOT_FOUND');
  }
  if (patient.phone && String(existing[0].phone || '') !== String(patient.phone)) {
    const collision = await db.$queryRawUnsafe(
      `SELECT uid, role, is_active, status, is_deleted, merged_into_uid
         FROM users
        WHERE tenant_id=$1::uuid AND phone=$2
        ORDER BY id
        LIMIT 2`,
      tenantId,
      patient.phone,
    );
    throw AppError.conflict(
      'FHIR demographics do not match the authorised patient identity',
      collision.length ? 'IMPORT_PATIENT_PHONE_OWNERSHIP_CONFLICT' : 'IMPORT_PATIENT_DEMOGRAPHICS_MISMATCH',
    );
  }
  return 'deduplicated';
}

async function importCondition(fhirCondition, importedBy, {
  tenantId = null,
  authority = null,
  db = prisma,
} = {}) {
  if (!fhirCondition || fhirCondition.resourceType !== 'Condition') return 'skipped';
  if (!GOVERNED_IMPORT_CLINICAL_ASSERTION_PROMOTION_ENABLED
    || authority?.clinicalAssertionPromotion !== 'governed') {
    throw AppError.conflict(
      'External diagnoses require a governed review and promotion workflow',
      'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      { resource_type: 'Condition', resource_id: fhirCondition.id || null },
    );
  }

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
  const existing = await db.$queryRawUnsafe(
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
    return 'deduplicated';
  }

  await db.$queryRawUnsafe(
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
  return 'imported';
}

async function importMedication(fhirMedication, importedBy, {
  tenantId = null,
  authority = null,
  db = prisma,
} = {}) {
  if (!fhirMedication || fhirMedication.resourceType !== 'MedicationRequest') return 'skipped';
  if (!tenantId) {
    throw AppError.forbidden(
      'Medication import requires explicit tenant authority',
      'IMPORT_TENANT_REQUIRED',
    );
  }

  const patientRef = fhirMedication.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  if (!patientUid) throw new Error('MedicationRequest missing patient reference');
  const patientRows = await db.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id=$1::uuid
        AND uid=$2::uuid
        AND role='PATIENT'
        AND is_active=TRUE
        AND status='active'
        AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      FOR UPDATE`,
    tenantId,
    patientUid,
  );
  const patient = patientRows[0];
  if (!patient) {
    throw AppError.forbidden(
      'Imported resource references a patient outside this tenant',
      'IMPORT_PATIENT_TENANT_MISMATCH',
    );
  }

  const medication = fhirMedication.medicationCodeableConcept?.text ||
    fhirMedication.medicationCodeableConcept?.coding?.[0]?.display || 'Imported medication';
  const note = fhirMedication.note?.[0]?.text || null;

  // Imported MedicationRequest rows are longitudinal medication history, not
  // actionable pharmacy orders. They stay unlinked until a local clinician
  // creates a governed prescription/order with catalog and facility authority.
  const statusMap = {
    active: 'active',
    completed: 'completed',
    cancelled: 'cancelled',
    stopped: 'stopped',
    'on-hold': 'on-hold',
  };
  const status = statusMap[fhirMedication.status] || 'unknown';
  if (!fhirMedication.id) {
    throw AppError.badRequest(
      'MedicationRequest must have a stable source resource id',
      'IMPORT_SOURCE_RESOURCE_ID_REQUIRED',
    );
  }
  const sourceIdentityPayload = {
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source: 'FHIR_MedicationRequest',
    patientUid,
    resourceId: fhirMedication.id,
  };
  const importIdentity = crypto.createHash('sha256').update(JSON.stringify(
    stableImportJson(sourceIdentityPayload),
  )).digest('hex');
  const payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(stableImportJson({
    medication,
    medicationCodeableConcept: fhirMedication.medicationCodeableConcept || null,
    dosageInstruction: fhirMedication.dosageInstruction || [],
    status,
    authoredOn: fhirMedication.authoredOn || null,
    occurrence: fhirMedication.occurrenceDateTime
      || fhirMedication.occurrencePeriod
      || fhirMedication.occurrenceTiming
      || null,
    note: fhirMedication.note || [],
  }))).digest('hex');
  const prescriptionNumber = `IMP-FHIR-${importIdentity.slice(0, 32)}`;

  // Stable source identity makes retries deterministic for the lifetime of the
  // imported clinical record, not merely a 24-hour transport window.
  const existing = await db.$queryRawUnsafe(
    `SELECT id, patient_id, patient_uid, lifecycle_status, pharmacy_order_id, medications
       FROM e_prescriptions
      WHERE tenant_id=$1::uuid AND prescription_number=$2
      LIMIT 1`,
    tenantId,
    prescriptionNumber,
  );

  if (existing.length) {
    const receipt = Array.isArray(existing[0].medications)
      ? existing[0].medications[0]?.import_receipt
      : null;
    if (String(existing[0].patient_uid) !== String(patientUid)
      || String(existing[0].lifecycle_status || '').toLowerCase() !== 'imported_history'
      || existing[0].pharmacy_order_id
      || receipt?.source_identity_sha256 !== importIdentity
      || receipt?.payload_sha256 !== payloadSha256) {
      throw AppError.conflict(
        'MedicationRequest source identity was replayed with different clinical content',
        'IMPORT_SOURCE_IDENTITY_DRIFT',
        { source_resource_id: fhirMedication.id },
      );
    }
    logger.info(`Skipped duplicate medication for patient ${patientUid}: ${medication}`);
    return 'deduplicated';
  }

  const importReceipt = {
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source_facility_id: authority?.sourceFacilityId || null,
    asserted_source_signature_sha256: authority?.sourceSignatureSha256 || null,
    source_payload_sha256: authority?.sourcePayloadSha256 || null,
    source_resource_type: 'MedicationRequest',
    source_resource_id: fhirMedication.id,
    source_identity_sha256: importIdentity,
    payload_sha256: payloadSha256,
    imported_by_uid: importedBy,
    actor_role: authority?.actorRole || null,
    ingestion_mode: authority?.ingestionMode || null,
    idempotency_key: authority?.idempotencyKey || null,
    request_id: authority?.requestId || null,
  };

  const inserted = await db.$queryRawUnsafe(
    `INSERT INTO e_prescriptions
       (tenant_id, patient_id, patient_uid, medication_name, medications,
        clinical_notes, notes, status, lifecycle_status, prescription_number,
        pharmacy_opted, created_at, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4, $5::jsonb,
             $6, $6, $7, 'imported_history', $8, FALSE, NOW(), NOW())
     RETURNING id`,
    tenantId,
    Number(patient.id),
    patientUid,
    medication,
    JSON.stringify([{
      name: medication,
      dosage_instruction: fhirMedication.dosageInstruction || [],
      source: 'FHIR_MedicationRequest',
      source_id: fhirMedication.id,
      import_receipt: importReceipt,
    }]),
    note || `Imported by ${importedBy}`,
    status,
    prescriptionNumber,
  );
  await recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    eventType: 'medication.history_imported',
    eventStatus: status,
    sourceTable: 'e_prescriptions',
    sourceId: String(inserted[0].id),
    resourceType: 'medication_history',
    resourceId: String(inserted[0].id),
    actorUid: importedBy,
    actorRole: authority?.actorRole || 'MEDICAL_RECORDS',
    requestId: authority?.requestId || null,
    summary: `Medication history imported: ${medication}`,
    payload: { import_receipt: importReceipt, status },
    afterState: { lifecycle_status: 'imported_history', status },
    timelineIdempotencyKey: `clinical-import:${tenantId}:${importIdentity}:timeline`,
    auditIdempotencyKey: `clinical-import:${tenantId}:${importIdentity}:audit`,
  }, { db, strict: true });
  return 'imported';
}

async function importAllergyIntolerance(fhirAllergy, importedBy, {
  tenantId = null,
  authority = null,
} = {}) {
  if (!fhirAllergy || fhirAllergy.resourceType !== 'AllergyIntolerance') return 'skipped';
  if (!GOVERNED_IMPORT_CLINICAL_ASSERTION_PROMOTION_ENABLED
    || authority?.clinicalAssertionPromotion !== 'governed') {
    throw AppError.conflict(
      'External allergies require a governed review and promotion workflow',
      'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      { resource_type: 'AllergyIntolerance', resource_id: fhirAllergy.id || null },
    );
  }
  const patientRef = fhirAllergy.patient?.reference || fhirAllergy.subject?.reference || '';
  const patientUid = patientRef.replace('Patient/', '');
  await assertPatientInTenant(patientUid, tenantId);
  const lifecycle = String(
    fhirAllergy.clinicalStatus?.coding?.[0]?.code || 'active',
  ).trim().toLowerCase();
  if (lifecycle !== 'active') return 'skipped';
  const allergen = fhirAllergy.code?.text
    || fhirAllergy.code?.coding?.find((coding) => coding?.display)?.display
    || fhirAllergy.code?.coding?.[0]?.code;
  if (!allergen) {
    throw AppError.badRequest(
      'AllergyIntolerance.code needs text or a coded display',
      'FHIR_ALLERGY_NO_CODE',
    );
  }
  const criticality = String(fhirAllergy.criticality || '').toLowerCase();
  const reactionSeverity = String(fhirAllergy.reaction?.[0]?.severity || '').toLowerCase();
  const severity = criticality === 'high' || reactionSeverity === 'severe'
    ? 'SEVERE'
    : reactionSeverity === 'moderate' ? 'MODERATE' : 'MILD';
  const reaction = fhirAllergy.reaction?.[0]?.manifestation?.[0]?.text
    || fhirAllergy.reaction?.[0]?.description
    || null;
  const result = await createFhirAllergyIntolerance({
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
    clinicalStatus: 'active',
    actorUid: importedBy,
    actorRole: authority?.actorRole || 'MEDICAL_RECORDS',
    requestId: authority?.requestId || null,
  });
  return result.created ? 'imported' : 'deduplicated';
}

function isVitalSignsCategoryCoding(coding) {
  const system = String(coding?.system ?? '').trim();
  return coding?.code === 'vital-signs'
    && system === 'http://terminology.hl7.org/CodeSystem/observation-category';
}

function isFhirVitalObservation(resource) {
  return resource?.resourceType === 'Observation'
    && (resource.category || []).some((category) => (
      (category?.coding || []).some(isVitalSignsCategoryCoding)
    ));
}

function parsedObservationReference(reference) {
  if (typeof reference !== 'string' || reference.trim() === '') return null;
  const value = reference.trim();
  const pathMatch = value.match(/(?:^|\/)Observation\/([^/?#]+)(?:\/_history\/([^/?#]+))?(?:[?#]|$)/);
  return {
    value,
    isAbsolute: /^[a-z][a-z0-9+.-]*:/i.test(value),
    id: pathMatch?.[1] || null,
    versionId: pathMatch?.[2] || null,
  };
}

function versionlessObservationUrl(value) {
  return value.replace(/\/_history\/[^/?#]+(?=([?#]|$))/, '');
}

function relativeObservationUrl(reference, parentFullUrl) {
  if (!reference.startsWith('Observation/') || !parentFullUrl) return null;
  try {
    const parentUrl = new URL(parentFullUrl);
    const parentPathMatch = parentUrl.pathname.match(/^(.*\/)(?:Observation\/[^/]+)(?:\/_history\/[^/]+)?$/);
    if (!parentPathMatch) return null;
    return new URL(`${parentPathMatch[1]}${reference}`, parentUrl.origin).toString();
  } catch {
    return null;
  }
}

function resolveBundledObservationReference(reference, parentEntry, observationEntries) {
  const parsed = parsedObservationReference(reference);
  if (!parsed) {
    throw AppError.badRequest(
      'FHIR composite hasMember reference is missing',
      'FHIR_OBSERVATION_COMPOSITE_REFERENCE_INVALID',
    );
  }

  const versionMatches = (entry) => (
    !parsed.versionId || String(entry.resource?.meta?.versionId || '') === parsed.versionId
  );
  const exactValues = new Set([parsed.value]);
  if (parsed.versionId) exactValues.add(versionlessObservationUrl(parsed.value));
  let resolvedRelative = null;
  if (!parsed.isAbsolute) {
    resolvedRelative = relativeObservationUrl(parsed.value, parentEntry?.fullUrl);
    if (resolvedRelative) {
      exactValues.add(resolvedRelative);
      if (parsed.versionId) exactValues.add(versionlessObservationUrl(resolvedRelative));
    }
  }

  const exactMatches = observationEntries.filter((entry) => (
    entry.fullUrl
    && exactValues.has(String(entry.fullUrl).trim())
    && versionMatches(entry)
  ));
  if (exactMatches.length === 1) return exactMatches[0].resource;
  if (exactMatches.length > 1) {
    throw AppError.badRequest(
      `FHIR composite hasMember reference ${parsed.value} is ambiguous in the Bundle`,
      'FHIR_OBSERVATION_COMPOSITE_REFERENCE_AMBIGUOUS',
    );
  }

  if (parsed.isAbsolute || resolvedRelative || !parsed.id) {
    throw AppError.badRequest(
      `FHIR composite hasMember reference ${parsed.value} cannot be resolved in the Bundle`,
      'FHIR_OBSERVATION_COMPOSITE_REFERENCE_UNRESOLVED',
    );
  }

  const logicalMatches = observationEntries.filter((entry) => (
    String(entry.resource?.id || '') === parsed.id && versionMatches(entry)
  ));
  if (logicalMatches.length === 1) return logicalMatches[0].resource;
  if (logicalMatches.length > 1) {
    throw AppError.badRequest(
      `FHIR composite hasMember reference ${parsed.value} is ambiguous in the Bundle`,
      'FHIR_OBSERVATION_COMPOSITE_REFERENCE_AMBIGUOUS',
    );
  }
  throw AppError.badRequest(
    `FHIR composite hasMember reference ${parsed.value} cannot be resolved in the Bundle`,
    'FHIR_OBSERVATION_COMPOSITE_REFERENCE_UNRESOLVED',
  );
}

const SUPPORTED_FHIR_VITAL_PANEL_CODES = new Set(['85353-1', '85354-9']);

function buildExplicitFhirVitalGroups(entries) {
  const observationEntries = entries.filter(({ resource }) => resource?.resourceType === 'Observation');

  const groups = new Map();
  const groupKeyByResource = new Map();
  const groupIdentityOwners = new Map();
  for (const [entryIndex, entry] of entries.entries()) {
    const parent = entry?.resource;
    if (parent?.resourceType !== 'Observation'
      || !Array.isArray(parent.hasMember)
      || parent.hasMember.length === 0) {
      continue;
    }
    const parentIsVital = isFhirVitalObservation(parent);
    const parentLoincCodes = (parent.code?.coding || [])
      .filter(({ system }) => String(system || '').trim() === 'http://loinc.org')
      .map(({ code }) => String(code || '').trim());
    const knownVitalPanel = parentLoincCodes.some((code) => SUPPORTED_FHIR_VITAL_PANEL_CODES.has(code));
    let members;
    if (parentIsVital) {
      members = [...new Set(parent.hasMember.map(({ reference }) => (
        resolveBundledObservationReference(reference, entry, observationEntries)
      )))];
    } else if (knownVitalPanel) {
      throw AppError.badRequest(
        'FHIR Observation with hasMember must declare the vital-signs category before vital import',
        'FHIR_OBSERVATION_COMPOSITE_PARENT_INVALID',
      );
    } else {
      const resolvedMembers = [];
      let resolutionError = null;
      for (const { reference } of parent.hasMember) {
        try {
          resolvedMembers.push(resolveBundledObservationReference(reference, entry, observationEntries));
        } catch (error) {
          resolutionError ||= error;
        }
      }
      if (!resolvedMembers.some(isFhirVitalObservation)) continue;
      if (resolutionError) throw resolutionError;
      throw AppError.badRequest(
        'FHIR Observation grouping vital members must declare the vital-signs category',
        'FHIR_OBSERVATION_COMPOSITE_PARENT_INVALID',
      );
    }
    if (members.includes(parent)) {
      throw AppError.badRequest(
        'FHIR vital composite cannot include itself as a hasMember resource',
        'FHIR_OBSERVATION_COMPOSITE_MEMBER_INVALID',
      );
    }
    if (members.some((member) => !isFhirVitalObservation(member))) {
      throw AppError.badRequest(
        'FHIR vital composite hasMember references a non-vital Observation',
        'FHIR_OBSERVATION_COMPOSITE_MEMBER_INVALID',
      );
    }

    const groupIdentity = entry.fullUrl
      ? `fullUrl:${String(entry.fullUrl).trim()}`
      : parent.id
        ? `id:${String(parent.id).trim()}`
        : `entry:${entryIndex}`;
    if (groupIdentityOwners.has(groupIdentity)) {
      throw AppError.badRequest(
        'FHIR Bundle contains ambiguous duplicate composite Observation authority identifiers',
        'FHIR_OBSERVATION_AMBIGUOUS_COMPOSITE',
      );
    }
    groupIdentityOwners.set(groupIdentity, parent);
    const groupKey = `hasMember:${entryIndex}:${groupIdentity}`;
    for (const member of [parent, ...members]) {
      const priorGroupKey = groupKeyByResource.get(member);
      if (priorGroupKey && priorGroupKey !== groupKey) {
        throw AppError.badRequest(
          'FHIR vital Observation belongs to more than one composite hasMember group',
          'FHIR_OBSERVATION_AMBIGUOUS_COMPOSITE',
        );
      }
      groupKeyByResource.set(member, groupKey);
    }
    groups.set(groupKey, { parent, members, resources: [parent, ...members] });
  }
  return { groups, groupKeyByResource };
}

async function addResolvedImplicitFhirVitalGroups(entries, {
  tenantId,
  groups,
  groupKeyByResource,
}) {
  const patientCache = new Map();
  const candidatesByKey = new Map();

  for (const { resource } of entries) {
    if (resource?.resourceType !== 'Observation' || groupKeyByResource.has(resource)) continue;

    let prepared;
    try {
      prepared = prepareFhirVitalObservation(resource);
    } catch {
      // Keep malformed resources ungrouped so the normal import path reports
      // their resource-specific validation error without hiding valid peers.
      continue;
    }
    if (!prepared) continue;

    let patientPromise = patientCache.get(prepared.patientUid);
    if (!patientPromise) {
      patientPromise = resolveFhirVitalPatientInTenant(prepared.patientUid, tenantId);
      patientCache.set(prepared.patientUid, patientPromise);
    }
    let patient;
    try {
      patient = await patientPromise;
    } catch {
      // The eventual import owns the authoritative tenant/patient error.
      continue;
    }

    const key = `implicit:${patient.uid}:${prepared.recordedAt}`;
    const candidates = candidatesByKey.get(key) || [];
    candidates.push(resource);
    candidatesByKey.set(key, candidates);
  }

  for (const [groupKey, resources] of candidatesByKey) {
    for (const resource of resources) {
      const priorGroupKey = groupKeyByResource.get(resource);
      if (priorGroupKey && priorGroupKey !== groupKey) {
        throw AppError.badRequest(
          'FHIR vital Observation has ambiguous Bundle grouping membership',
          'FHIR_OBSERVATION_AMBIGUOUS_COMPOSITE',
        );
      }
      groupKeyByResource.set(resource, groupKey);
    }
    groups.set(groupKey, { parent: null, members: null, resources });
  }
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

const FHIR_VITAL_INSTANT_RE = /^([1-9]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

function isValidFhirVitalInstant(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(FHIR_VITAL_INSTANT_RE);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
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

export function prepareFhirVitalObservation(fhirObservation, {
  allowGroupAuthority = false,
  requireMappedValue = false,
  requireVitalCategory = false,
  groupMemberFingerprints = [],
} = {}) {
  if (!fhirObservation || fhirObservation.resourceType !== 'Observation') return null;

  const patientRef = fhirObservation.subject?.reference || '';
  const patientUid = patientRef.startsWith('Patient/')
    ? patientRef.slice('Patient/'.length).toLowerCase()
    : '';
  if (!patientUid) throw new Error('Observation missing patient reference');

  const hasVitalCategory = (fhirObservation.category || []).some((category) => (
    (category?.coding || []).some(isVitalSignsCategoryCoding)
  ));
  if (!hasVitalCategory) {
    if (requireVitalCategory) {
      throw AppError.badRequest(
        'FHIR vital Observation must declare the canonical vital-signs category',
        'FHIR_OBSERVATION_CATEGORY_INVALID',
      );
    }
    logger.info(`Skipped non-vital observation for patient ${patientUid}`);
    return null;
  }

  const observationStatus = fhirObservation.status == null
    ? null
    : String(fhirObservation.status).trim();
  if (!['final', 'amended', 'corrected'].includes(observationStatus)) {
    throw AppError.badRequest(
      'FHIR vital Observation status must be final, amended, or corrected before charting',
      'FHIR_OBSERVATION_STATUS_NOT_CHARTABLE',
    );
  }

  const sourceTimestamp = fhirObservation.effectiveDateTime;
  if (!sourceTimestamp) {
    throw AppError.badRequest(
      'FHIR vital Observation must include effectiveDateTime; issued is not physiologic observation time',
      'FHIR_OBSERVATION_TIMESTAMP_REQUIRED',
    );
  }
  if (!isValidFhirVitalInstant(sourceTimestamp)) {
    throw AppError.badRequest(
      'FHIR vital Observation effectiveDateTime must be a full date-time with seconds and a UTC offset',
      'FHIR_OBSERVATION_TIMESTAMP_INVALID',
    );
  }
  const timestamp = new Date(sourceTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw AppError.badRequest(
      'FHIR vital Observation has an invalid effectiveDateTime',
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
  const authorityLoincCodes = canonicalCoding(fhirObservation.code)
    .filter(({ system, code }) => system === 'http://loinc.org' && code)
    .map(({ code }) => code);
  const unsupportedMappedCodes = allowGroupAuthority
    ? mapped.unmappedComponents
    : mapped.unmapped;
  if (unsupportedMappedCodes.length > 0 && (values.size > 0 || allowGroupAuthority)) {
    throw AppError.badRequest(
      `FHIR vital Observation contains unsupported component LOINC code(s): ${unsupportedMappedCodes.join(', ')}`,
      'FHIR_OBSERVATION_PARTIAL_COMPONENT_MAPPING',
    );
  }
  if (allowGroupAuthority) {
    if (!Array.isArray(fhirObservation.hasMember) || fhirObservation.hasMember.length === 0) {
      throw AppError.badRequest(
        'FHIR vital composite authority must declare hasMember references',
        'FHIR_OBSERVATION_COMPOSITE_PARENT_INVALID',
      );
    }
    if (!authorityLoincCodes.some((code) => SUPPORTED_FHIR_VITAL_PANEL_CODES.has(code))) {
      throw AppError.badRequest(
        'FHIR vital composite authority must use a supported LOINC vital panel code',
        'FHIR_OBSERVATION_COMPOSITE_PARENT_INVALID',
      );
    }
  }
  if (values.size === 0) {
    if (allowGroupAuthority) {
      // A supported panel authority may carry no direct measurement value;
      // its hasMember observations provide the clinical values.
    } else if (requireMappedValue) {
      const codes = mapped.unmapped.length > 0 ? mapped.unmapped.join(', ') : loincCode;
      throw AppError.badRequest(
        `FHIR vital composite member has unsupported LOINC code(s): ${codes}`,
        'FHIR_OBSERVATION_COMPOSITE_MEMBER_UNSUPPORTED',
      );
    } else {
      const codes = mapped.unmapped.length > 0 ? mapped.unmapped.join(', ') : loincCode;
      logger.info(`Skipped observation with unknown LOINC code(s) ${codes} for patient ${patientUid}`);
      return null;
    }
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
    mappedLoincCodes: [...(mapped.mapped.length > 0 ? mapped.mapped : authorityLoincCodes)].sort(),
    values: canonicalObservationValues(values, mapped.temperatureUnit),
    ...(allowGroupAuthority ? {
      hasMemberFingerprints: [...groupMemberFingerprints].sort(),
    } : {}),
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
    loincCodes: mapped.mapped.length > 0 ? mapped.mapped : authorityLoincCodes,
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
      `SELECT set_fingerprint,
              vitals_chart_id,
              news2_effects_completed_at,
              anomaly_effects_completed_at,
              news2_effects_claimed_at,
              news2_effects_claim_token,
              news2_effects_attempts,
              news2_effects_next_retry_at,
              anomaly_effects_claimed_at,
              anomaly_effects_claim_token,
              anomaly_effects_attempts,
              anomaly_effects_next_retry_at
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid
          AND set_fingerprint = $2
          AND vitals_chart_id IS NOT NULL`,
      tenantId, setFingerprint,
    );
    return rows[0] || null;
  });
}

async function claimFhirObservationEffects({
  tenantId,
  setFingerprint,
  vitalsChartId,
  news2Pending,
  anomalyPending,
}) {
  const requestedTokens = {
    news2: news2Pending ? crypto.randomUUID() : null,
    anomaly: anomalyPending ? crypto.randomUUID() : null,
  };
  return setTenantTx(tenantId, async (tx) => {
    if (requestedTokens.news2) {
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET news2_effects_claimed_at = clock_timestamp(),
                news2_effects_claim_token = $4::uuid,
                news2_effects_attempts = news2_effects_attempts + 1,
                news2_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = $2
            AND vitals_chart_id = $3::integer
            AND news2_effects_completed_at IS NULL
            AND (news2_effects_next_retry_at IS NULL OR news2_effects_next_retry_at <= clock_timestamp())
            AND (
              news2_effects_claimed_at IS NULL
              OR news2_effects_claimed_at < clock_timestamp() - make_interval(secs => $5::integer)
            )`,
        tenantId,
        setFingerprint,
        vitalsChartId,
        requestedTokens.news2,
        FHIR_EFFECT_LEASE_SECONDS,
      );
    }
    if (requestedTokens.anomaly) {
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET anomaly_effects_claimed_at = clock_timestamp(),
                anomaly_effects_claim_token = $4::uuid,
                anomaly_effects_attempts = anomaly_effects_attempts + 1,
                anomaly_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = $2
            AND vitals_chart_id = $3::integer
            AND anomaly_effects_completed_at IS NULL
            AND (anomaly_effects_next_retry_at IS NULL OR anomaly_effects_next_retry_at <= clock_timestamp())
            AND (
              anomaly_effects_claimed_at IS NULL
              OR anomaly_effects_claimed_at < clock_timestamp() - make_interval(secs => $5::integer)
            )`,
        tenantId,
        setFingerprint,
        vitalsChartId,
        requestedTokens.anomaly,
        FHIR_EFFECT_LEASE_SECONDS,
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT set_fingerprint,
              vitals_chart_id,
              news2_effects_completed_at,
              anomaly_effects_completed_at,
              news2_effects_claimed_at,
              news2_effects_claim_token,
              news2_effects_attempts,
              news2_effects_next_retry_at,
              anomaly_effects_claimed_at,
              anomaly_effects_claim_token,
              anomaly_effects_attempts,
              anomaly_effects_next_retry_at
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid
          AND set_fingerprint = $2
          AND vitals_chart_id = $3::integer`,
      tenantId,
      setFingerprint,
      vitalsChartId,
    );
    const state = rows[0];
    if (!state) {
      throw new Error('Committed FHIR Observation set could not be claimed for reconciliation');
    }
    return {
      state,
      claimTokens: {
        news2: state.news2_effects_claim_token === requestedTokens.news2
          ? requestedTokens.news2
          : null,
        anomaly: state.anomaly_effects_claim_token === requestedTokens.anomaly
          ? requestedTokens.anomaly
          : null,
      },
    };
  });
}

async function releaseFhirObservationEffectClaims({
  tenantId,
  setFingerprint,
  vitalsChartId,
  claimTokens,
  retryAfterSeconds = {},
}) {
  if (!claimTokens?.news2 && !claimTokens?.anomaly) return;
  await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_claimed_at = CASE
                WHEN $4::uuid IS NOT NULL
                  AND news2_effects_completed_at IS NULL
                  AND news2_effects_claim_token = $4::uuid
                THEN NULL ELSE news2_effects_claimed_at END,
              news2_effects_claim_token = CASE
                WHEN $4::uuid IS NOT NULL
                  AND news2_effects_completed_at IS NULL
                  AND news2_effects_claim_token = $4::uuid
                THEN NULL ELSE news2_effects_claim_token END,
              news2_effects_next_retry_at = CASE
                WHEN $4::uuid IS NOT NULL
                  AND news2_effects_completed_at IS NULL
                  AND news2_effects_claim_token = $4::uuid
                THEN clock_timestamp() + make_interval(secs => $6::integer)
                ELSE news2_effects_next_retry_at END,
              anomaly_effects_claimed_at = CASE
                WHEN $5::uuid IS NOT NULL
                  AND anomaly_effects_completed_at IS NULL
                  AND anomaly_effects_claim_token = $5::uuid
                THEN NULL ELSE anomaly_effects_claimed_at END,
              anomaly_effects_claim_token = CASE
                WHEN $5::uuid IS NOT NULL
                  AND anomaly_effects_completed_at IS NULL
                  AND anomaly_effects_claim_token = $5::uuid
                THEN NULL ELSE anomaly_effects_claim_token END,
              anomaly_effects_next_retry_at = CASE
                WHEN $5::uuid IS NOT NULL
                  AND anomaly_effects_completed_at IS NULL
                  AND anomaly_effects_claim_token = $5::uuid
                THEN clock_timestamp() + make_interval(secs => $7::integer)
                ELSE anomaly_effects_next_retry_at END
        WHERE tenant_id = $1::uuid
          AND set_fingerprint = $2
          AND vitals_chart_id = $3::integer`,
      tenantId,
      setFingerprint,
      vitalsChartId,
      claimTokens.news2,
      claimTokens.anomaly,
      Number(retryAfterSeconds.news2 || FHIR_EFFECT_RETRY_BASE_SECONDS),
      Number(retryAfterSeconds.anomaly || FHIR_EFFECT_RETRY_BASE_SECONDS),
    );
  });
}

async function markFhirObservationEffectCompleted({
  tenantId,
  setFingerprint,
  vitalsChartId,
  effect,
  claimToken = null,
  tx = null,
}) {
  const update = async (client) => {
    const claimedSql = effect === 'news2'
      ? `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = clock_timestamp(),
                news2_effects_claimed_at = NULL,
                news2_effects_claim_token = NULL,
                news2_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = $2
            AND vitals_chart_id = $3::integer
            AND news2_effects_completed_at IS NULL
            AND news2_effects_claim_token = $4::uuid`
      : `UPDATE fhir_vital_observation_sets
            SET anomaly_effects_completed_at = clock_timestamp(),
                anomaly_effects_claimed_at = NULL,
                anomaly_effects_claim_token = NULL,
                anomaly_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = $2
            AND vitals_chart_id = $3::integer
            AND anomaly_effects_completed_at IS NULL
            AND anomaly_effects_claim_token = $4::uuid`;
    const unclaimedSql = effect === 'news2'
      ? `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = COALESCE(news2_effects_completed_at, clock_timestamp()),
                news2_effects_claimed_at = NULL,
                news2_effects_claim_token = NULL,
                news2_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = $2
            AND vitals_chart_id = $3::integer`
      : `UPDATE fhir_vital_observation_sets
            SET anomaly_effects_completed_at = COALESCE(anomaly_effects_completed_at, clock_timestamp()),
                anomaly_effects_claimed_at = NULL,
                anomaly_effects_claim_token = NULL,
                anomaly_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = $2
            AND vitals_chart_id = $3::integer`;
    const updated = await client.$executeRawUnsafe(
      claimToken ? claimedSql : unclaimedSql,
      tenantId,
      setFingerprint,
      vitalsChartId,
      ...(claimToken ? [claimToken] : []),
    );
    if (updated !== 1) {
      throw new Error(`FHIR Observation set ${effect} completion could not be recorded`);
    }
  };
  if (tx) return update(tx);
  return setTenantTx(tenantId, update);
}

async function reconcileFhirObservationSetEffects({
  tenantId,
  setFingerprint,
  vitalsChartId,
  news2Pending,
  anomalyPending,
}) {
  const { reconcileRecordedVitalsEffects } = await import('../emr/vitalsChartService.js');
  const claimed = await claimFhirObservationEffects({
    tenantId,
    setFingerprint,
    vitalsChartId,
    news2Pending,
    anomalyPending,
  });
  const ownedNews2 = Boolean(claimed.claimTokens.news2);
  const ownedAnomaly = Boolean(claimed.claimTokens.anomaly);
  let reconciliation = null;
  try {
    if (ownedNews2 || ownedAnomaly) {
      reconciliation = await reconcileRecordedVitalsEffects({
        tenantId,
        vitalsChartId,
        news2Pending: ownedNews2,
        anomalyPending: ownedAnomaly,
        onNews2EffectsCompleted: async ({ vitals }) => {
          await markFhirObservationEffectCompleted({
            tenantId,
            setFingerprint,
            vitalsChartId: vitals.id,
            effect: 'news2',
            claimToken: claimed.claimTokens.news2,
          });
        },
        onClinicalAlertsPersisted: async ({ tx }) => {
          await markFhirObservationEffectCompleted({
            tenantId,
            setFingerprint,
            vitalsChartId,
            effect: 'anomaly',
            claimToken: claimed.claimTokens.anomaly,
            tx,
          });
        },
      });
    }
  } catch (error) {
    await releaseFhirObservationEffectClaims({
      tenantId,
      setFingerprint,
      vitalsChartId,
      claimTokens: claimed.claimTokens,
      retryAfterSeconds: {
        news2: fhirEffectRetrySeconds(claimed.state.news2_effects_attempts),
        anomaly: fhirEffectRetrySeconds(claimed.state.anomaly_effects_attempts),
      },
    }).catch((releaseError) => {
      logger.error('FHIR Observation effect claim release failed', {
        tenantId,
        setFingerprint,
        error: releaseError.message,
      });
    });
    throw error;
  }

  const state = await findCommittedFhirSet(tenantId, setFingerprint);
  if (!state) {
    throw new Error('Committed FHIR Observation set disappeared after reconciliation');
  }
  const pendingEffects = [
    ...(state.news2_effects_completed_at == null ? ['news2'] : []),
    ...(state.anomaly_effects_completed_at == null ? ['anomaly'] : []),
  ];
  return {
    reconciliation,
    claimedEffects: [
      ...(ownedNews2 ? ['news2'] : []),
      ...(ownedAnomaly ? ['anomaly'] : []),
    ],
    pendingEffects,
  };
}

export async function reconcilePendingFhirVitalEffects({ tenantId, limit = 25 } = {}) {
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > FHIR_EFFECT_SWEEP_MAX) {
    throw AppError.badRequest(
      `FHIR vital effect sweep limit must be between 1 and ${FHIR_EFFECT_SWEEP_MAX}`,
      'FHIR_VITAL_EFFECT_SWEEP_LIMIT_INVALID',
    );
  }
  const candidates = await setTenantTx(tenantId, async (tx) => tx.$queryRawUnsafe(
    `SELECT set_fingerprint, vitals_chart_id
       FROM fhir_vital_observation_sets
      WHERE tenant_id = $1::uuid
        AND vitals_chart_id IS NOT NULL
        AND (
          (
            news2_effects_completed_at IS NULL
            AND (news2_effects_next_retry_at IS NULL OR news2_effects_next_retry_at <= clock_timestamp())
            AND (
              news2_effects_claimed_at IS NULL
              OR news2_effects_claimed_at < clock_timestamp() - make_interval(secs => $3::integer)
            )
          )
          OR (
            anomaly_effects_completed_at IS NULL
            AND (anomaly_effects_next_retry_at IS NULL OR anomaly_effects_next_retry_at <= clock_timestamp())
            AND (
              anomaly_effects_claimed_at IS NULL
              OR anomaly_effects_claimed_at < clock_timestamp() - make_interval(secs => $3::integer)
            )
          )
        )
      ORDER BY created_at, set_fingerprint
      LIMIT $2::integer`,
    tenantId,
    boundedLimit,
    FHIR_EFFECT_LEASE_SECONDS,
  ));

  const summary = {
    tenantId,
    scanned: candidates.length,
    claimedEffects: 0,
    completedSets: 0,
    busySets: 0,
    failedSets: 0,
  };
  const failures = [];
  for (const candidate of candidates) {
    try {
      const result = await reconcileFhirObservationSetEffects({
        tenantId,
        setFingerprint: candidate.set_fingerprint,
        vitalsChartId: candidate.vitals_chart_id,
        news2Pending: true,
        anomalyPending: true,
      });
      summary.claimedEffects += result.claimedEffects.length;
      if (result.pendingEffects.length === 0) summary.completedSets += 1;
      else summary.busySets += 1;
    } catch (error) {
      summary.failedSets += 1;
      failures.push({ setFingerprint: candidate.set_fingerprint, error: error.message });
      logger.error('FHIR vital effect recovery failed', {
        tenantId,
        setFingerprint: candidate.set_fingerprint,
        error: error.message,
      });
    }
  }
  if (failures.length > 0) {
    const error = new Error(`FHIR vital effect recovery failed for ${failures.length} set(s)`);
    error.code = 'FHIR_VITAL_EFFECT_SWEEP_FAILED';
    error.summary = summary;
    error.failures = failures;
    throw error;
  }
  if (summary.scanned > 0) logger.info('FHIR vital effect recovery sweep complete', summary);
  return summary;
}

async function importObservationSet(fhirObservations, importedBy, {
  tenantId = null,
  groupParent = null,
  groupMembers = null,
  beforeFhirVitalWrite = null,
} = {}) {
  const observations = [];
  const skippedResources = [];
  const resourceErrors = new Map();
  let resourceErrorCode = null;
  let resourceErrorStatusCode = null;
  const resourcesInPreparationOrder = groupParent
    ? [...fhirObservations.filter((resource) => resource !== groupParent), groupParent]
    : fhirObservations;
  for (const resource of resourcesInPreparationOrder) {
    try {
      const prepared = prepareFhirVitalObservation(resource, {
        allowGroupAuthority: resource === groupParent,
        requireMappedValue: Array.isArray(groupMembers) && groupMembers.includes(resource),
        groupMemberFingerprints: resource === groupParent
          ? observations.map(({ resourceFingerprint }) => resourceFingerprint)
          : [],
      });
      if (prepared) {
        observations.push(prepared);
      }
      else skippedResources.push(resource);
    } catch (error) {
      resourceErrors.set(resource.id || '(no id)', error.message);
      resourceErrorCode ||= error.code || null;
      resourceErrorStatusCode ||= error.statusCode || null;
    }
  }
  observations.sort((left, right) => (
    fhirObservations.indexOf(left.resource) - fhirObservations.indexOf(right.resource)
  ));

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
      ...(resourceErrorCode ? { errorCode: resourceErrorCode } : {}),
      ...(resourceErrorStatusCode ? { errorStatusCode: resourceErrorStatusCode } : {}),
      resourceErrors,
    })];
  }
  if (observations.length === 0) {
    return [observationOutcome('skipped', skippedResources)];
  }

  const recordedAt = observations[0].recordedAt;
  if (observations.some((observation) => observation.recordedAt !== recordedAt)) {
    throw AppError.badRequest('FHIR vital-sign set must reference one patient and one effectiveDateTime');
  }
  const sourcePatientUid = observations[0].patientUid;
  const patientBySourceUid = new Map();
  for (const observation of observations) {
    if (!patientBySourceUid.has(observation.patientUid)) {
      patientBySourceUid.set(
        observation.patientUid,
        await resolveFhirVitalPatientInTenant(observation.patientUid, tenantId),
      );
    }
  }
  const resolvedPatients = [...patientBySourceUid.values()];
  const patient = resolvedPatients[0];
  if (resolvedPatients.some((candidate) => (
    candidate.uid !== patient.uid || candidate.tenant_id !== patient.tenant_id
  ))) {
    throw AppError.badRequest('FHIR vital-sign set must reference one patient and one effectiveDateTime');
  }
  let patientUid = patient.uid;
  const resolvedTenantId = tenantId || patient.tenant_id;
  if (typeof beforeFhirVitalWrite === 'function') {
    await beforeFhirVitalWrite({ sourcePatientUid, resolvedPatientUid: patientUid });
  }

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
  if (values.has('o2_flow_rate')) {
    payload.supplemental_o2 = Number(values.get('o2_flow_rate')) > 0;
  }
  const temperatureObservation = observations.find(({ values: mappedValues }) => (
    mappedValues.has('temperature')
  ));
  if (temperatureObservation?.temperatureUnit) {
    payload.temperature_unit = temperatureObservation.temperatureUnit;
  }

  const { recordVitals } = await import('../emr/vitalsChartService.js');
  let claimEvidence = null;
  let linkedVitalsChartId = null;
  const initialEffectClaims = {
    news2: crypto.randomUUID(),
    anomaly: crypto.randomUUID(),
  };
  try {
    const result = await recordVitals(payload, {
      beforeWrite: async ({ tx, patient: lockedPatient }) => {
        patientUid = lockedPatient.uid;
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
              SET vitals_chart_id = $3::integer,
                  news2_effects_claimed_at = clock_timestamp(),
                  news2_effects_claim_token = $4::uuid,
                  news2_effects_attempts = news2_effects_attempts + 1,
                  news2_effects_next_retry_at = NULL,
                  anomaly_effects_claimed_at = clock_timestamp(),
                  anomaly_effects_claim_token = $5::uuid,
                  anomaly_effects_attempts = anomaly_effects_attempts + 1,
                  anomaly_effects_next_retry_at = NULL
            WHERE tenant_id = $1::uuid
              AND set_fingerprint = $2
              AND vitals_chart_id IS NULL`,
          resolvedTenantId,
          setFingerprint,
          vitals.id,
          initialEffectClaims.news2,
          initialEffectClaims.anomaly,
        );
        if (linked !== 1) {
          throw new Error('FHIR Observation set receipt could not be linked to its vitals row');
        }
        linkedVitalsChartId = vitals.id;
      },
      onNews2EffectsCompleted: async ({ vitals }) => {
        await markFhirObservationEffectCompleted({
          tenantId: resolvedTenantId,
          setFingerprint,
          vitalsChartId: vitals.id,
          effect: 'news2',
          claimToken: initialEffectClaims.news2,
        });
      },
      onClinicalAlertsPersisted: async ({ tx, alerts: persistedAlerts }) => {
        await markFhirObservationEffectCompleted({
          tenantId: resolvedTenantId,
          setFingerprint,
          vitalsChartId: linkedVitalsChartId,
          effect: 'anomaly',
          claimToken: initialEffectClaims.anomaly,
          tx,
        });
        return persistedAlerts;
      },
    });
    const vitals = result?.vitals || result;
    const outcomes = [observationOutcome('imported', observations.map(({ resource }) => resource), {
      setFingerprint,
      vitalsChartId: vitals.id,
      patientUid,
      recordedAt,
      newResourceReceipts: claimEvidence.newResourceReceipts,
      reusedResourceReceipts: claimEvidence.reusedResourceReceipts,
    })];
    if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
    return outcomes;
  } catch (error) {
    if (error instanceof FhirObservationReplay) {
      const matchedSetFingerprint = error.matchedSetFingerprint || setFingerprint;
      let committed;
      try {
        committed = await findCommittedFhirSet(resolvedTenantId, matchedSetFingerprint);
      } catch (lookupError) {
        logger.error('FHIR Observation replay state lookup failed', {
          tenantId: resolvedTenantId,
          setFingerprint: matchedSetFingerprint,
          error: lookupError.message,
        });
        return [observationOutcome('error', fhirObservations, {
          error: 'FHIR Observation recovery state is temporarily unavailable',
          errorCode: 'FHIR_OBSERVATION_RECOVERY_UNAVAILABLE',
          errorStatusCode: 503,
        })];
      }
      if (!committed) {
        return [observationOutcome('error', fhirObservations, {
          error: 'FHIR Observation replay state is incomplete',
          errorCode: 'FHIR_OBSERVATION_REPLAY_UNCOMMITTED',
          errorStatusCode: 500,
        })];
      }

      const news2Pending = committed.news2_effects_completed_at == null;
      const anomalyPending = committed.anomaly_effects_completed_at == null;
      let reconciliationResult = null;
      if (news2Pending || anomalyPending) {
        try {
          reconciliationResult = await reconcileFhirObservationSetEffects({
            tenantId: resolvedTenantId,
            setFingerprint: matchedSetFingerprint,
            vitalsChartId: committed.vitals_chart_id,
            news2Pending,
            anomalyPending,
          });
        } catch (reconcileError) {
          logger.error(
            `FHIR observation replay clinical-effect reconciliation failed for patient ${patientUid}: ${reconcileError.message}`,
          );
          return [observationOutcome('error', fhirObservations, {
            error: 'FHIR Observation clinical effects could not be restored',
            errorCode: 'FHIR_OBSERVATION_EFFECTS_RETRY_FAILED',
            errorStatusCode: 503,
          })];
        }
        if (reconciliationResult.pendingEffects.length > 0) {
          return [observationOutcome('error', fhirObservations, {
            error: `FHIR Observation clinical effects are already being reconciled: ${reconciliationResult.pendingEffects.join(', ')}`,
            errorCode: 'FHIR_OBSERVATION_EFFECTS_IN_PROGRESS',
            errorStatusCode: 409,
          })];
        }
      }
      logger.info(
        `Skipped duplicate FHIR observation set for patient ${patientUid} (${error.message})`,
      );
      const outcomes = [observationOutcome(
        'deduplicated',
        observations.map(({ resource }) => resource),
        {
          setFingerprint,
          matchedSetFingerprint,
          vitalsChartId: committed.vitals_chart_id,
          patientUid,
          recordedAt,
          clinicalEffectsReconciled: reconciliationResult?.claimedEffects.length > 0,
        },
      )];
      if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
      return outcomes;
    }

    if (linkedVitalsChartId != null) {
      await releaseFhirObservationEffectClaims({
        tenantId: resolvedTenantId,
        setFingerprint,
        vitalsChartId: linkedVitalsChartId,
        claimTokens: initialEffectClaims,
      }).catch((releaseError) => {
        logger.error('FHIR Observation initial effect claim release failed', {
          tenantId: resolvedTenantId,
          setFingerprint,
          error: releaseError.message,
        });
      });
    }
    let committed;
    try {
      committed = await findCommittedFhirSet(resolvedTenantId, setFingerprint);
    } catch (lookupError) {
      logger.error('FHIR Observation commit state lookup failed', {
        tenantId: resolvedTenantId,
        setFingerprint,
        error: lookupError.message,
      });
      return [observationOutcome('error', fhirObservations, {
        error: 'FHIR Observation recovery state is temporarily unavailable',
        errorCode: 'FHIR_OBSERVATION_RECOVERY_UNAVAILABLE',
        errorStatusCode: 503,
      })];
    }
    if (committed) {
      const outcomes = [observationOutcome('imported', observations.map(({ resource }) => resource), {
        setFingerprint,
        vitalsChartId: committed.vitals_chart_id,
        patientUid,
        recordedAt,
        newResourceReceipts: claimEvidence?.newResourceReceipts ?? null,
        reusedResourceReceipts: claimEvidence?.reusedResourceReceipts ?? null,
        error: 'FHIR vitals were committed, but clinical effects remain incomplete',
        errorCode: error.code || 'FHIR_OBSERVATION_EFFECTS_INCOMPLETE',
        errorStatusCode: 500,
      })];
      if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
      return outcomes;
    }
    const errorStatusCode = error.statusCode || 500;
    return [observationOutcome('error', fhirObservations, {
      error: errorStatusCode >= 500
        ? 'FHIR Observation ingestion failed'
        : error.message,
      errorCode: error.code || 'FHIR_OBSERVATION_IMPORT_FAILED',
      errorStatusCode,
    })];
  }
}

export async function importFhirVitalObservation(fhirObservation, importedBy, {
  tenantId = null,
  beforeFhirVitalWrite = null,
} = {}) {
  prepareFhirVitalObservation(fhirObservation, {
    requireMappedValue: true,
    requireVitalCategory: true,
  });
  let outcomes;
  try {
    outcomes = await importObservationSet([fhirObservation], importedBy, {
      tenantId,
      beforeFhirVitalWrite,
    });
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500) throw error;
    logger.error('FHIR Observation ingestion failed before a durable outcome was available', {
      tenantId,
      error: error.message,
    });
    throw new AppError(
      'FHIR Observation ingestion is temporarily unavailable',
      503,
      'FHIR_OBSERVATION_RECOVERY_UNAVAILABLE',
    );
  }
  const outcome = outcomes[0];
  if (!outcome || outcome.status === 'skipped') {
    throw AppError.badRequest(
      'FHIR Observation does not contain a supported vital measurement',
      'FHIR_OBSERVATION_UNSUPPORTED',
    );
  }
  if (outcome.error) {
    throw new AppError(
      outcome.error,
      outcome.errorStatusCode || (outcome.status === 'imported' ? 500 : 400),
      outcome.errorCode || 'FHIR_OBSERVATION_IMPORT_FAILED',
    );
  }
  return {
    status: outcome.status,
    deduplicated: outcome.status === 'deduplicated',
    vitalsChartId: outcome.vitalsChartId,
    patientUid: outcome.patientUid,
    recordedAt: outcome.recordedAt,
    setFingerprint: outcome.matchedSetFingerprint || outcome.setFingerprint,
    clinicalEffectsReconciled: outcome.clinicalEffectsReconciled === true,
  };
}

// =============================================================================
// C-CDA XML EXTRACTORS
// =============================================================================

function ccdaArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function ccdaText(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || null;
  if (typeof value === 'object') return String(value['#text'] || value.text || '').trim() || null;
  return null;
}

function collectCcdaNodes(value, key, output = [], depth = 0, count = { value: 0 }) {
  if (depth > 64 || count.value > 100000) {
    throw AppError.badRequest('C-CDA document exceeds structural limits', 'CCDA_STRUCTURE_LIMIT_EXCEEDED');
  }
  if (!value || typeof value !== 'object') return output;
  count.value += 1;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === key) output.push(...ccdaArray(childValue));
    for (const child of ccdaArray(childValue)) {
      collectCcdaNodes(child, key, output, depth + 1, count);
    }
  }
  return output;
}

function firstCcdaNode(value, key) {
  return collectCcdaNodes(value, key)[0] || null;
}

function parseCcdaDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{8}/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function ccdaClinicalEntry(entry, statementKey) {
  const statement = firstCcdaNode(entry, statementKey);
  if (!statement) return null;
  const code = collectCcdaNodes(statement, 'code').find((candidate) => (
    candidate && typeof candidate === 'object'
    && (candidate['@_displayName'] || candidate.originalText || candidate['@_code'])
    && !new Set(['ASSERTION', 'SBADM', 'Problem', 'Medication activity', 'Allergy observation'])
      .has(String(candidate['@_code'] || candidate['@_displayName'] || ''))
  ));
  if (!code) {
    throw AppError.badRequest(
      `C-CDA ${statementKey} entry has no coded clinical identity`,
      'CCDA_ENTRY_IDENTITY_REQUIRED',
    );
  }
  const displayName = String(
    code['@_displayName'] || ccdaText(code.originalText) || code['@_code'] || '',
  ).trim();
  if (!displayName) {
    throw AppError.badRequest('C-CDA clinical entry has an empty identity', 'CCDA_ENTRY_IDENTITY_REQUIRED');
  }
  const status = firstCcdaNode(statement, 'statusCode');
  const effective = firstCcdaNode(statement, 'effectiveTime');
  const low = effective && typeof effective === 'object' ? effective.low : null;
  const high = effective && typeof effective === 'object' ? effective.high : null;
  return {
    code: code['@_code'] || null,
    codeSystem: code['@_codeSystem'] || code['@_codeSystemName'] || null,
    displayName,
    text: ccdaText(code.originalText) || displayName,
    status: status?.['@_code'] || null,
    effectiveStart: parseCcdaDate(effective?.['@_value'] || low?.['@_value']),
    effectiveEnd: parseCcdaDate(high?.['@_value']),
  };
}

function extractStructuredCcdaSection(document, loincCode, statementKey) {
  const sections = collectCcdaNodes(document, 'section').filter((section) => (
    String(section?.code?.['@_code'] || '') === loincCode
  ));
  if (sections.length > 1) {
    throw AppError.badRequest(
      `C-CDA contains multiple ${loincCode} sections`,
      'CCDA_SECTION_AMBIGUOUS',
    );
  }
  if (!sections.length) return [];
  const expectedTemplates = {
    '11450-4': ['2.16.840.1.113883.10.20.22.2.5', '2.16.840.1.113883.10.20.22.2.5.1'],
    '10160-0': ['2.16.840.1.113883.10.20.22.2.1', '2.16.840.1.113883.10.20.22.2.1.1'],
    '48765-2': ['2.16.840.1.113883.10.20.22.2.6', '2.16.840.1.113883.10.20.22.2.6.1'],
  }[loincCode] || [];
  const sectionTemplates = ccdaArray(sections[0].templateId)
    .map((template) => String(template?.['@_root'] || ''));
  if (!sectionTemplates.some((template) => expectedTemplates.includes(template))) {
    throw AppError.badRequest(
      `C-CDA ${loincCode} section is missing its supported template identity`,
      'CCDA_SECTION_TEMPLATE_UNSUPPORTED',
    );
  }
  return ccdaArray(sections[0].entry)
    .map((entry) => ccdaClinicalEntry(entry, statementKey))
    .filter(Boolean);
}

function parseCcdaClinicalDocument(xml) {
  if (Buffer.byteLength(xml, 'utf8') > 5 * 1024 * 1024) {
    throw AppError.badRequest('C-CDA document exceeds the 5 MiB limit', 'CCDA_DOCUMENT_TOO_LARGE');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || xml.includes('\u0000')) {
    throw AppError.badRequest('C-CDA document contains prohibited XML constructs', 'CCDA_XML_UNSAFE');
  }
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw AppError.badRequest('C-CDA XML is malformed', 'CCDA_XML_INVALID', { validation });
  }
  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      processEntities: false,
      allowBooleanAttributes: false,
      trimValues: true,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(xml);
  } catch (err) {
    throw AppError.badRequest('C-CDA XML could not be parsed', 'CCDA_XML_INVALID', {
      parser_error: err.message,
    });
  }
  const document = parsed?.ClinicalDocument;
  if (!document || typeof document !== 'object') {
    throw AppError.badRequest('C-CDA ClinicalDocument root is required', 'CCDA_ROOT_REQUIRED');
  }
  collectCcdaNodes(document, '__structure_probe__');
  const recordTargets = ccdaArray(document.recordTarget);
  if (recordTargets.length !== 1) {
    throw AppError.badRequest('C-CDA must contain exactly one recordTarget', 'CCDA_PATIENT_AMBIGUOUS');
  }
  const patientRole = recordTargets[0]?.patientRole;
  const patientNode = patientRole?.patient;
  if (!patientRole || !patientNode) {
    throw AppError.badRequest('C-CDA recordTarget patient is required', 'CCDA_PATIENT_REQUIRED');
  }
  const name = ccdaArray(patientNode.name)[0] || {};
  const given = ccdaArray(name.given).map(ccdaText).filter(Boolean).join(' ');
  const family = ccdaArray(name.family).map(ccdaText).filter(Boolean).join(' ');
  const telecom = ccdaArray(patientRole.telecom)
    .map((entry) => String(entry?.['@_value'] || ''))
    .find((value) => value.startsWith('tel:'));
  const patientId = ccdaArray(patientRole.id)[0] || {};
  const address = ccdaArray(patientRole.addr)[0] || {};
  return {
    patient: {
      uid: patientId['@_extension'] || patientId['@_root'] || null,
      name: [given, family].filter(Boolean).join(' ') || null,
      phone: telecom ? telecom.slice(4) : null,
      gender: { M: 'Male', F: 'Female' }[patientNode.administrativeGenderCode?.['@_code']] || null,
      birthday: parseCcdaDate(patientNode.birthTime?.['@_value']),
      address: [address.streetAddressLine, address.city, address.state, address.postalCode]
        .flatMap(ccdaArray).map(ccdaText).filter(Boolean).join(', ') || null,
    },
    problems: extractStructuredCcdaSection(document, '11450-4', 'observation'),
    medications: extractStructuredCcdaSection(document, '10160-0', 'substanceAdministration'),
    allergies: extractStructuredCcdaSection(document, '48765-2', 'observation'),
  };
}

// =============================================================================
// C-CDA RESOURCE IMPORTERS
// =============================================================================

async function importPatientFromCCDA(patientData, _importedBy, {
  tenantId = null,
  authority = null,
  db = prisma,
} = {}) {
  const targetPatientUid = requiredImportPatientUid(authority?.patientUid);
  const rows = await db.$queryRawUnsafe(
    `SELECT id, uid, phone
       FROM users
      WHERE tenant_id=$1::uuid
        AND uid=$2::uuid
        AND role='PATIENT'
        AND is_active=TRUE
        AND status='active'
        AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      FOR UPDATE`,
    tenantId,
    targetPatientUid,
  );
  if (!rows.length) {
    throw AppError.notFound('Authorised C-CDA patient not found', 'IMPORT_TARGET_PATIENT_NOT_FOUND');
  }
  if (patientData?.phone && String(patientData.phone) !== String(rows[0].phone || '')) {
    const collision = await db.$queryRawUnsafe(
      `SELECT uid, role, is_active, status, is_deleted, merged_into_uid
         FROM users
        WHERE tenant_id=$1::uuid AND phone=$2
        ORDER BY id
        LIMIT 2`,
      tenantId,
      patientData.phone,
    );
    throw AppError.conflict(
      'C-CDA demographics do not match the authorised patient identity',
      collision.length ? 'IMPORT_PATIENT_PHONE_OWNERSHIP_CONFLICT' : 'IMPORT_PATIENT_DEMOGRAPHICS_MISMATCH',
    );
  }
  return 'deduplicated';
}

async function importDiagnosisFromCCDA(problem, patientUid, importedBy, {
  tenantId = null,
  authority = null,
} = {}) {
  if (!patientUid || !problem.displayName) return;
  if (!GOVERNED_IMPORT_CLINICAL_ASSERTION_PROMOTION_ENABLED
    || authority?.clinicalAssertionPromotion !== 'governed') {
    throw AppError.conflict(
      'External diagnoses require a governed review and promotion workflow',
      'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      { resource_type: 'C-CDA_Problem' },
    );
  }
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

async function importMedicationFromCCDA(med, patientUid, importedBy, {
  tenantId = null,
  authority = null,
  db = prisma,
  lineIndex = null,
} = {}) {
  if (!patientUid || !med.displayName) return 'skipped';
  if (!tenantId) {
    throw AppError.forbidden(
      'Medication import requires explicit tenant authority',
      'IMPORT_TENANT_REQUIRED',
    );
  }
  const patients = await db.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id=$1::uuid
        AND uid=$2::uuid
        AND role='PATIENT'
        AND is_active=TRUE
        AND status='active'
        AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      FOR UPDATE`,
    tenantId,
    patientUid,
  );
  const patient = patients[0];
  if (!patient) {
    throw AppError.forbidden(
      'Imported medication references a patient outside this tenant',
      'IMPORT_PATIENT_TENANT_MISMATCH',
    );
  }
  const sourceIdentityPayload = {
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source: 'C-CDA_Medication',
    patientUid,
    resource_index: lineIndex,
  };
  const importIdentity = crypto.createHash('sha256').update(JSON.stringify(
    stableImportJson(sourceIdentityPayload),
  )).digest('hex');
  const payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(stableImportJson({
    medication: med.displayName,
    code: med.code || null,
    code_system: med.codeSystem || null,
    text: med.text || null,
    status: med.status || null,
    effective_start: med.effectiveStart || null,
    effective_end: med.effectiveEnd || null,
  }))).digest('hex');
  const prescriptionNumber = `IMP-CCDA-${importIdentity.slice(0, 32)}`;

  // Stable history identity prevents duplicate imports without creating an
  // authority-less dispensing workflow.
  const existing = await db.$queryRawUnsafe(
    `SELECT id, patient_uid, lifecycle_status, pharmacy_order_id, medications
       FROM e_prescriptions
      WHERE tenant_id=$1::uuid AND prescription_number=$2
      LIMIT 1`,
    tenantId,
    prescriptionNumber,
  );
  if (existing.length) {
    const receipt = Array.isArray(existing[0].medications)
      ? existing[0].medications[0]?.import_receipt
      : null;
    if (String(existing[0].patient_uid) !== String(patientUid)
      || String(existing[0].lifecycle_status || '').toLowerCase() !== 'imported_history'
      || existing[0].pharmacy_order_id
      || receipt?.source_identity_sha256 !== importIdentity
      || receipt?.payload_sha256 !== payloadSha256) {
      throw AppError.conflict(
        'C-CDA medication source identity was replayed with different clinical content',
        'IMPORT_SOURCE_IDENTITY_DRIFT',
        { source_resource_index: lineIndex },
      );
    }
    return 'deduplicated';
  }

  const sourceStatus = String(med.status || '').trim().toLowerCase();
  const status = ['active', 'completed', 'cancelled', 'canceled', 'stopped', 'on-hold']
    .includes(sourceStatus) ? sourceStatus : 'unknown';
  const importReceipt = {
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source_facility_id: authority?.sourceFacilityId || null,
    asserted_source_signature_sha256: authority?.sourceSignatureSha256 || null,
    source_payload_sha256: authority?.sourcePayloadSha256 || null,
    source_resource_type: 'C-CDA_Medication',
    source_resource_index: lineIndex,
    source_identity_sha256: importIdentity,
    payload_sha256: payloadSha256,
    imported_by_uid: importedBy,
    actor_role: authority?.actorRole || null,
    ingestion_mode: authority?.ingestionMode || null,
    idempotency_key: authority?.idempotencyKey || null,
    request_id: authority?.requestId || null,
  };

  const inserted = await db.$queryRawUnsafe(
    `INSERT INTO e_prescriptions
       (tenant_id, patient_id, patient_uid, medication_name, medications,
        clinical_notes, notes, status, lifecycle_status, prescription_number,
        pharmacy_opted, created_at, updated_at)
      VALUES ($1::uuid, $2::int, $3::uuid, $4, $5::jsonb,
              $6, $6, $8, 'imported_history', $7, FALSE, NOW(), NOW())
     RETURNING id`,
    tenantId,
    Number(patient.id),
    patientUid,
    med.displayName,
    JSON.stringify([{
      name: med.displayName,
      source: 'C-CDA_Medication',
      source_text: med.text || null,
      source_code: med.code || null,
      source_code_system: med.codeSystem || null,
      source_status: status,
      effective_start: med.effectiveStart || null,
      effective_end: med.effectiveEnd || null,
      timing_unresolved: status === 'active' && !med.effectiveEnd,
      import_receipt: importReceipt,
    }]),
    med.text || `Imported by ${importedBy}`,
    prescriptionNumber,
    status,
  );
  await recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    eventType: 'medication.history_imported',
    eventStatus: status,
    sourceTable: 'e_prescriptions',
    sourceId: String(inserted[0].id),
    resourceType: 'medication_history',
    resourceId: String(inserted[0].id),
    actorUid: importedBy,
    actorRole: authority?.actorRole || 'MEDICAL_RECORDS',
    requestId: authority?.requestId || null,
    summary: `Medication history imported: ${med.displayName}`,
    payload: { import_receipt: importReceipt, status },
    afterState: { lifecycle_status: 'imported_history', status },
    timelineIdempotencyKey: `clinical-import:${tenantId}:${importIdentity}:timeline`,
    auditIdempotencyKey: `clinical-import:${tenantId}:${importIdentity}:audit`,
  }, { db, strict: true });
  return 'imported';
}

async function importAllergyFromCCDA(allergy, patientUid, _importedBy, {
  tenantId = null,
  authority = null,
} = {}) {
  if (!patientUid || !allergy.displayName) return;
  if (!GOVERNED_IMPORT_CLINICAL_ASSERTION_PROMOTION_ENABLED
    || authority?.clinicalAssertionPromotion !== 'governed') {
    throw AppError.conflict(
      'External allergies require a governed review and promotion workflow',
      'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      { resource_type: 'C-CDA_Allergy' },
    );
  }
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

export default { importFhirBundle, importCCDA };
