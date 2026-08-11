// src/services/import/patientDataImport.js
// Imports patient data from FHIR Bundles and C-CDA XML documents.
// Includes deduplication to avoid creating duplicate records on re-import.

import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  lockTenantPatientMergeStability,
  PATIENT_MERGE_STABILITY_TIMEOUT_MS,
} from '../../utils/patientMergeStabilityLock.js';
import { fromFhirPatient } from '../fhir/fhirAdapter.js';
import { fhirObservationToVitals } from '../fhir/observationVitalsMapper.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FHIR_EFFECT_LEASE_SECONDS = 300;
const FHIR_EFFECT_RETRY_BASE_SECONDS = 120;
const FHIR_EFFECT_RETRY_MAX_SECONDS = 3600;
const FHIR_EFFECT_SWEEP_MAX = 100;

function fhirEffectRetrySeconds(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 1) - 1, 5));
  return Math.min(FHIR_EFFECT_RETRY_BASE_SECONDS * (2 ** exponent), FHIR_EFFECT_RETRY_MAX_SECONDS);
}

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
export async function importFhirBundle(bundle, importedBy, {
  tenantId = null,
  beforeFhirVitalWrite = null,
} = {}) {
  if (!bundle || bundle.resourceType !== 'Bundle') {
    throw new Error('Invalid FHIR Bundle: resourceType must be Bundle');
  }

  const containsObservations = (bundle.entry || []).some(({ resource }) => (
    resource?.resourceType === 'Observation'
  ));
  if (containsObservations && tenantId) {
    return setTenantTx(tenantId, async (lockTx) => {
      await lockTenantPatientMergeStability(lockTx, tenantId);
      return importFhirBundleWithStablePatientSnapshot(bundle, importedBy, {
        tenantId,
        beforeFhirVitalWrite,
      });
    }, { timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS });
  }

  return importFhirBundleWithStablePatientSnapshot(bundle, importedBy, {
    tenantId,
    beforeFhirVitalWrite,
  });
}

async function importFhirBundleWithStablePatientSnapshot(bundle, importedBy, {
  tenantId,
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
