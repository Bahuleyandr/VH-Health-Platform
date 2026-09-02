// src/services/import/patientDataImport.js
// Imports patient data from FHIR Bundles and C-CDA XML documents.
// Includes deduplication to avoid creating duplicate records on re-import.

import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { deepSanitizeStrings, stripHtml } from '../../utils/sanitize.js';
import {
  lockTenantPatientMergeStability,
  PATIENT_MERGE_STABILITY_TIMEOUT_MS,
} from '../../utils/patientMergeStabilityLock.js';
import { fromFhirPatient } from '../fhir/fhirAdapter.js';
import { fhirObservationToVitals } from '../fhir/observationVitalsMapper.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  buildClinicalImportDocumentAuthority,
  clinicalImportSha256,
  lockClinicalImportDocumentReceiptTx,
  persistClinicalImportDocumentReceiptTx,
} from './clinicalImportReceiptService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLINICAL_IMPORT_ASSERTION_PROMOTION_GATE =
  'CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER';

function clinicalAssertionPromotionRequired(resourceType, resourceId = null) {
  return {
    status: 'failed',
    error: 'External diagnoses and allergies require a governed review and promotion workflow',
    errorCode: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
    errorStatusCode: 409,
    evidence: {
      status: 'HELD_EXTERNAL_AUTHORITY',
      required_authority: CLINICAL_IMPORT_ASSERTION_PROMOTION_GATE,
      resource_type: resourceType,
      resource_id: resourceId,
    },
  };
}
const FHIR_EFFECT_LEASE_SECONDS = 300;
const FHIR_EFFECT_RETRY_BASE_SECONDS = 120;
const FHIR_EFFECT_RETRY_MAX_SECONDS = 3600;
const FHIR_EFFECT_SWEEP_MAX = 100;
const CLINICAL_IMPORT_RESOURCE_SAVEPOINT = 'clinical_import_resource';
const FHIR_OBSERVATION_WRITE_SAVEPOINT = 'fhir_observation_write';
const CLINICAL_IMPORT_SERIALIZABLE_ATTEMPTS = 3;

function clinicalImportSqlState(error) {
  return String(
    error?.meta?.code
      || error?.meta?.driverAdapterError?.cause?.originalCode
      || error?.cause?.code
      || error?.code
      || '',
  );
}

function isRetryableClinicalImportTransactionError(error) {
  return ['40001', '40P01', 'P2034'].includes(clinicalImportSqlState(error));
}

async function waitForClinicalImportRetry(attempt) {
  const delayMs = (attempt * 25) + crypto.randomInt(0, 26);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function beginClinicalImportResourceSavepoint(db) {
  await db.$executeRawUnsafe(`SAVEPOINT ${CLINICAL_IMPORT_RESOURCE_SAVEPOINT}`);
}

async function releaseClinicalImportResourceSavepoint(db) {
  await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${CLINICAL_IMPORT_RESOURCE_SAVEPOINT}`);
}

async function rollbackClinicalImportResourceSavepoint(db) {
  await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${CLINICAL_IMPORT_RESOURCE_SAVEPOINT}`);
  await releaseClinicalImportResourceSavepoint(db);
}

async function beginFhirObservationWriteSavepoint(db) {
  await db.$executeRawUnsafe(`SAVEPOINT ${FHIR_OBSERVATION_WRITE_SAVEPOINT}`);
}

async function releaseFhirObservationWriteSavepoint(db) {
  await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${FHIR_OBSERVATION_WRITE_SAVEPOINT}`);
}

async function rollbackFhirObservationWriteSavepoint(db) {
  await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${FHIR_OBSERVATION_WRITE_SAVEPOINT}`);
  await releaseFhirObservationWriteSavepoint(db);
}

function fhirEffectRetrySeconds(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 1) - 1, 5));
  return Math.min(FHIR_EFFECT_RETRY_BASE_SECONDS * (2 ** exponent), FHIR_EFFECT_RETRY_MAX_SECONDS);
}

function fhirMedicationImportEvidence(fhirMedication, authority) {
  const medication = fhirMedication.medicationCodeableConcept?.text
    || fhirMedication.medicationCodeableConcept?.coding?.[0]?.display
    || 'Imported medication';
  const statusMap = {
    active: 'active',
    completed: 'completed',
    cancelled: 'cancelled',
    stopped: 'stopped',
    'on-hold': 'on-hold',
  };
  const sourceStatus = String(fhirMedication.status || '').trim().toLowerCase() || null;
  const status = statusMap[sourceStatus] || 'unknown';
  const sourceIdentitySha256 = clinicalImportSha256({
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source: 'FHIR_MedicationRequest',
    resourceId: fhirMedication.id,
  });
  const payloadSha256 = clinicalImportSha256({
    medication,
    medicationCodeableConcept: fhirMedication.medicationCodeableConcept || null,
    dosageInstruction: fhirMedication.dosageInstruction || [],
    status,
    sourceStatus,
    authoredOn: fhirMedication.authoredOn || null,
    occurrence: fhirMedication.occurrenceDateTime
      || fhirMedication.occurrencePeriod
      || fhirMedication.occurrenceTiming
      || null,
    note: fhirMedication.note || [],
  });
  return { medication, status, sourceStatus, sourceIdentitySha256, payloadSha256 };
}

function ccdaMedicationImportEvidence(med, authority, lineIndex) {
  const sourceIdentitySha256 = clinicalImportSha256({
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source: 'C-CDA_Medication',
    resource_index: lineIndex,
  });
  const payloadSha256 = clinicalImportSha256({
    medication: med.displayName,
    code: med.code || null,
    code_system: med.codeSystem || null,
    text: med.text || null,
    status: med.status || null,
    effective_start: med.effectiveStart || null,
    effective_end: med.effectiveEnd || null,
  });
  return { sourceIdentitySha256, payloadSha256 };
}

function normalizedSourceAuthor(author, source) {
  if (!author || typeof author !== 'object') return null;
  const reference = String(author.reference || '').trim() || null;
  const display = String(author.display || '').trim() || null;
  const identifierSystem = String(author.identifier?.system || '').trim() || null;
  const identifierValue = String(author.identifier?.value || '').trim() || null;
  if (!reference && !display && !identifierValue) return null;
  return {
    source,
    reference,
    display,
    identifier_system: identifierSystem,
    identifier_value: identifierValue,
  };
}

function fhirSourceAuthorEvidence(bundle) {
  const authors = [];
  const append = (author, source) => {
    const normalized = normalizedSourceAuthor(author, source);
    if (normalized) authors.push(normalized);
  };
  append(bundle?.signature?.who, 'Bundle.signature.who');
  append(bundle?.signature?.onBehalfOf, 'Bundle.signature.onBehalfOf');
  for (const entry of bundle.entry || []) {
    const resource = entry?.resource;
    if (!resource) continue;
    if (resource.resourceType === 'Composition') {
      for (const author of resource.author || []) append(author, 'Composition.author');
      append(resource.custodian, 'Composition.custodian');
    }
    if (resource.resourceType === 'MedicationRequest') {
      append(resource.requester, 'MedicationRequest.requester');
      append(resource.recorder, 'MedicationRequest.recorder');
    }
    if (resource.resourceType === 'Observation') {
      for (const performer of resource.performer || []) append(performer, 'Observation.performer');
    }
  }
  const uniqueAuthors = [...new Map(authors.map((author) => (
    [JSON.stringify(author), author]
  ))).values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    assertion_status: 'asserted_from_source_unverified',
    authors: uniqueAuthors,
  };
}

function ccdaSourceAuthorEvidence(parsed) {
  return {
    assertion_status: 'asserted_from_source_unverified',
    authors: (parsed.authors || []).map((author) => ({
      source: 'ClinicalDocument.author.assignedAuthor',
      reference: null,
      display: author.display || null,
      identifier_system: author.root || null,
      identifier_value: author.extension || null,
    })),
  };
}

function medicationImportReceipt({
  authority,
  importedBy,
  sourceResourceType,
  sourceResourceId = null,
  sourceResourceIndex = null,
  sourceIdentitySha256,
  payloadSha256,
}) {
  return {
    contract_version: 'clinical-import-resource-v1',
    source_system: authority?.sourceSystem || null,
    source_document_id: authority?.sourceDocumentId || null,
    source_facility_id: authority?.sourceFacilityId || null,
    asserted_source_signature_sha256: authority?.sourceSignatureSha256 || null,
    source_payload_sha256: authority?.sourcePayloadSha256 || null,
    source_resource_type: sourceResourceType,
    ...(sourceResourceId == null ? {} : { source_resource_id: sourceResourceId }),
    ...(sourceResourceIndex == null ? {} : { source_resource_index: sourceResourceIndex }),
    source_identity_sha256: sourceIdentitySha256,
    payload_sha256: payloadSha256,
    document_source_identity_sha256: authority?.documentSourceIdentitySha256 || null,
    resource_manifest_sha256: authority?.resourceManifestSha256 || null,
    idempotency_key_sha256: authority?.idempotencyKeySha256 || null,
    imported_by_uid: importedBy,
    actor_role: authority?.actorRole || null,
    ingestion_mode: authority?.ingestionMode || null,
    request_id: authority?.requestId || null,
  };
}

async function recordImportedMedicationCanonicalPair({
  db,
  tenantId,
  patientUid,
  importedBy,
  authority,
  targetId,
  medication,
  status,
  sourceStatus,
  importReceipt,
  importIdentity,
}) {
  return recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    eventType: 'medication.history_imported',
    eventStatus: status,
    sourceTable: 'e_prescriptions',
    sourceId: String(targetId),
    resourceType: 'medication_history',
    resourceId: String(targetId),
    actorUid: importedBy,
    actorRole: authority?.actorRole || 'MEDICAL_RECORDS',
    requestId: authority?.requestId || null,
    summary: `Medication history imported: ${medication}`,
    payload: {
      import_receipt: importReceipt,
      status,
      source_medication_status: sourceStatus,
      verification_status: 'asserted_unverified',
    },
    afterState: {
      lifecycle_status: 'imported_history',
      status,
      source_medication_status: sourceStatus,
      verification_status: 'asserted_unverified',
    },
    tags: ['medication', 'imported-history', 'asserted-unverified'],
    timelineIdempotencyKey: `clinical-import:${tenantId}:${importIdentity}:timeline`,
    auditIdempotencyKey: `clinical-import:${tenantId}:${importIdentity}:audit`,
  }, { db, strict: true });
}

function genericImportResourceManifestEntry({
  authority,
  sourceResourceType,
  sourceResourceId = null,
  sourceResourceIndex,
  sourceKind,
  payload,
  fullUrl = null,
}) {
  return {
    source_resource_type: sourceResourceType,
    source_resource_id: sourceResourceId,
    source_resource_index: sourceResourceIndex,
    source_identity_sha256: clinicalImportSha256({
      contract_version: 'clinical-import-resource-v1',
      source_system: authority?.sourceSystem || null,
      source_document_id: authority?.sourceDocumentId || null,
      source: sourceKind,
      resource_id: sourceResourceId,
      resource_index: sourceResourceIndex,
      full_url: fullUrl,
    }),
    payload_sha256: clinicalImportSha256(payload),
  };
}

function buildFhirImportResourceManifest(bundle, authority) {
  return (bundle.entry || []).map((entry, fallbackIndex) => {
    const sourceResourceIndex = Number.isInteger(entry?.__vhImportSourceIndex)
      ? entry.__vhImportSourceIndex
      : fallbackIndex;
    const resource = entry?.__vhImportSourceResource || entry?.resource || null;
    const sourceResourceType = String(resource?.resourceType || 'Unknown').slice(0, 120);
    const sourceResourceId = resource?.id == null ? null : String(resource.id).slice(0, 255);
    if (resource?.resourceType === 'MedicationRequest') {
      const evidence = fhirMedicationImportEvidence(resource, authority);
      return {
        source_resource_type: sourceResourceType,
        source_resource_id: sourceResourceId,
        source_resource_index: sourceResourceIndex,
        source_identity_sha256: evidence.sourceIdentitySha256,
        payload_sha256: evidence.payloadSha256,
      };
    }
    return genericImportResourceManifestEntry({
      authority,
      sourceResourceType,
      sourceResourceId,
      sourceResourceIndex,
      sourceKind: `FHIR_${sourceResourceType}`,
      payload: resource,
      fullUrl: entry?.fullUrl == null ? null : String(entry.fullUrl),
    });
  }).sort((left, right) => left.source_resource_index - right.source_resource_index);
}

function receiptOutcome(outcome, evidence = {}) {
  const status = typeof outcome === 'string' ? outcome : outcome?.status;
  const normalizedStatus = status === 'error' ? 'failed' : status;
  if (!['imported', 'deduplicated', 'skipped', 'failed'].includes(normalizedStatus)) {
    const error = new Error('Clinical import resource returned an invalid outcome');
    error.code = 'IMPORT_RESOURCE_OUTCOME_INVALID';
    throw error;
  }
  return {
    status: normalizedStatus,
    targetTable: typeof outcome === 'object' ? outcome?.targetTable || null : null,
    targetId: typeof outcome === 'object' ? outcome?.targetId ?? null : null,
    canonicalTimelineEventId: typeof outcome === 'object'
      ? outcome?.canonicalTimelineEventId || null
      : null,
    canonicalAuditEventId: typeof outcome === 'object'
      ? outcome?.canonicalAuditEventId || null
      : null,
    evidence: {
      ...evidence,
      ...(typeof outcome === 'object' && outcome?.evidence ? outcome.evidence : {}),
    },
  };
}

function initialResourceOutcomes(resourceManifest) {
  return resourceManifest.map(() => receiptOutcome('skipped'));
}

function isFatalClinicalImportResourceError(error, resources) {
  if (resources.some((resource) => resource?.resourceType === 'Patient')) return true;
  if ([401, 403].includes(Number(error?.statusCode))) return true;
  const code = String(error?.code || '');
  return [
    'IMPORT_ACTOR_',
    'IMPORT_AUTHORITY_',
    'IMPORT_PATIENT_ACCESS_',
    'IMPORT_PATIENT_IDENTITY_',
    'IMPORT_PATIENT_IDENTIFIER_',
    'IMPORT_PATIENT_TENANT_',
    'IMPORT_PAYLOAD_',
    'IMPORT_RECEIPT_',
    'IMPORT_TARGET_PATIENT_',
    'IMPORT_TENANT_',
  ].some((prefix) => code.startsWith(prefix));
}

function safeClinicalImportResourceFailure(error, fallbackCode, fallbackMessage) {
  const suppliedCode = error instanceof AppError ? String(error.code || '') : '';
  return {
    error: fallbackMessage,
    errorCode: /^[A-Z][A-Z0-9_]{2,119}$/.test(suppliedCode)
      ? suppliedCode
      : fallbackCode,
    errorStatusCode: error instanceof AppError ? Number(error.statusCode) || 500 : 500,
  };
}

function applyCcdaResourceOutcome({
  summary,
  resourceOutcomes,
  receiptIndex,
  resourceType,
  resourceId = null,
  localIndex = null,
  outcome,
}) {
  const normalizedOutcome = receiptOutcome(outcome, {
    error: outcome?.error || null,
    error_code: outcome?.errorCode || null,
    error_status_code: outcome?.errorStatusCode || null,
  });
  resourceOutcomes[receiptIndex] = normalizedOutcome;
  const { status } = normalizedOutcome;
  summary[status] += 1;
  if (status === 'failed') {
    summary.errors.push({
      resource: resourceType,
      id: resourceId,
      ...(localIndex == null ? {} : { index: localIndex }),
      error: outcome.error || 'C-CDA resource requires reconciliation',
      code: outcome.errorCode || 'CCDA_RESOURCE_IMPORT_FAILED',
    });
  }
}

function assertClinicalImportPayloadHash(payload, assertedSha256) {
  const computedSha256 = clinicalImportSha256(payload);
  if (String(assertedSha256 || '').trim().toLowerCase() !== computedSha256) {
    throw AppError.conflict(
      'Clinical import payload hash does not match the supplied document',
      'IMPORT_PAYLOAD_HASH_MISMATCH',
    );
  }
}

function buildCcdaImportResourceManifest(parsed, authority) {
  const records = [];
  const append = (sourceResourceType, payload, localIndex = null) => {
    const sourceResourceIndex = records.length;
    const sourceResourceId = payload?.id || payload?.code || null;
    if (sourceResourceType === 'C-CDA_Medication') {
      const evidence = ccdaMedicationImportEvidence(payload, authority, localIndex);
      records.push({
        kind: 'medication',
        localIndex,
        manifest: {
          source_resource_type: sourceResourceType,
          source_resource_id: sourceResourceId,
          source_resource_index: sourceResourceIndex,
          source_identity_sha256: evidence.sourceIdentitySha256,
          payload_sha256: evidence.payloadSha256,
        },
      });
      return;
    }
    records.push({
      kind: sourceResourceType,
      localIndex,
      manifest: genericImportResourceManifestEntry({
        authority,
        sourceResourceType,
        sourceResourceId,
        sourceResourceIndex,
        sourceKind: sourceResourceType,
        payload,
      }),
    });
  };
  append('C-CDA_Patient', parsed.patient || {});
  parsed.problems.forEach((problem, index) => append('C-CDA_Problem', problem, index));
  parsed.allergies.forEach((allergy, index) => append('C-CDA_Allergy', allergy, index));
  parsed.medications.forEach((medication, index) => append('C-CDA_Medication', medication, index));
  return records;
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

function requiredExternalPatientIdentity(value, field) {
  const sourceValue = String(value || '');
  const normalized = sourceValue.trim();
  if (!normalized || normalized !== sourceValue || normalized.length > 255
    || [...normalized].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 32 || codePoint === 127;
    })) {
    throw AppError.badRequest(
      `${field} cannot be resolved through an external patient identifier`,
      'IMPORT_PATIENT_IDENTIFIER_INVALID',
    );
  }
  return normalized;
}

function uniquePatientIdentityClaims(claims) {
  const unique = new Map();
  for (const claim of claims) {
    const key = JSON.stringify({
      kind: claim.kind,
      value: claim.value,
      issuer: claim.issuer || null,
      issuerRequired: claim.issuerRequired === true,
    });
    if (!unique.has(key)) unique.set(key, claim);
  }
  return [...unique.values()].sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

function clinicalImportPatientIdentityBinding({
  tenantId,
  patientId,
  patientUid,
  patientIdentifierIds,
}) {
  const sortedIds = [...new Set(patientIdentifierIds.map(Number))]
    .sort((left, right) => left - right);
  return {
    patientIdentifierIds: sortedIds,
    patientIdentityBindingSha256: clinicalImportSha256(
      `clinical-import-patient-identity-v1|${tenantId}|${Number(patientId)}`
      + `|${patientUid}|${sortedIds.join(',')}`,
    ),
  };
}

function withoutClinicalImportPatientIdentityBinding(authority) {
  const replayAuthority = { ...authority };
  delete replayAuthority.patientIdentifierIds;
  delete replayAuthority.patientIdentityBindingSha256;
  return replayAuthority;
}

async function resolveExternalPatientIdentityClaimsTx(db, {
  tenantId,
  patientId,
  patientUid,
  claims,
  hasNativeVhUid,
  resourceManifest = [],
}) {
  const normalizedClaims = uniquePatientIdentityClaims(claims);
  const externalClaims = [];
  let hasResolvedNativeVhUid = hasNativeVhUid;
  let priorFhirReceiptBinding = null;
  for (const claim of normalizedClaims) {
    const nativeUid = claim.kind === 'fhir_patient_id'
      && UUID_RE.test(String(claim.value || '').toLowerCase())
      ? String(claim.value).toLowerCase()
      : null;
    if (!nativeUid) {
      externalClaims.push(claim);
      continue;
    }
    let resolvedNativePatient;
    try {
      resolvedNativePatient = await resolveFhirVitalPatientInTenant(nativeUid, tenantId, db);
    } catch (error) {
      if (error?.code !== 'IMPORT_PATIENT_TENANT_MISMATCH') throw error;
      externalClaims.push(claim);
      continue;
    }
    if (String(resolvedNativePatient.uid).toLowerCase() === patientUid) {
      if (priorFhirReceiptBinding == null) {
        const observationOnlyManifest = resourceManifest.length > 0
          && resourceManifest.every((resource) => (
            resource.source_resource_type === 'Observation'
          ));
        const observationResourceIds = [...new Set(resourceManifest
          .filter((resource) => resource.source_resource_type === 'Observation')
          .map((resource) => resource.source_resource_id)
          .filter(Boolean))];
        if (!observationOnlyManifest || observationResourceIds.length !== resourceManifest.length) {
          priorFhirReceiptBinding = false;
        } else {
          const receiptRows = await db.$queryRawUnsafe(
            `SELECT COUNT(DISTINCT resource_id)::integer AS matched_count
               FROM fhir_vital_observation_receipts
              WHERE tenant_id=$1::uuid
                AND patient_uid=$2::uuid
                AND resource_id=ANY($3::text[])`,
            tenantId,
            patientUid,
            observationResourceIds,
          );
          priorFhirReceiptBinding = Number(receiptRows[0]?.matched_count || 0)
            === observationResourceIds.length;
        }
      }
      if (priorFhirReceiptBinding) {
        hasResolvedNativeVhUid = true;
        continue;
      }
    }
    externalClaims.push(claim);
  }
  if (!hasResolvedNativeVhUid && externalClaims.length === 0) {
    throw AppError.conflict(
      'The imported document does not contain an identity bound to the authorised patient',
      'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED',
    );
  }
  const values = [...new Set(externalClaims.map(({ value }) => value))].sort();
  const rows = values.length === 0 ? [] : await db.$queryRawUnsafe(
    `SELECT id, patient_uid, identifier_value, issuer, status, merged_into_uid
       FROM patient_identifiers
      WHERE tenant_id=$1::uuid
        AND identifier_type='external_emr'
        AND status IN ('active', 'merged_into')
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND identifier_value=ANY($2::text[])
      ORDER BY identifier_value, id
      FOR SHARE`,
    tenantId,
    values,
  );
  const rowsByValue = new Map();
  for (const row of rows) {
    const value = String(row.identifier_value);
    if (!rowsByValue.has(value)) rowsByValue.set(value, []);
    rowsByValue.get(value).push(row);
  }
  const patientIdentifierIds = [];
  for (const claim of externalClaims) {
    const matches = (rowsByValue.get(claim.value) || []).filter((row) => (
      !claim.issuerRequired || String(row.issuer || '') === claim.issuer
    ));
    if (matches.length === 0) {
      throw AppError.conflict(
        'An imported patient identity is not bound by an external identifier',
        'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED',
        { identity_kind: claim.kind },
      );
    }
    const resolvedPatientUids = new Set(matches.map((row) => (
      String(row.status) === 'active'
        ? String(row.patient_uid).toLowerCase()
        : String(row.merged_into_uid || '').toLowerCase()
    )));
    if (resolvedPatientUids.size !== 1) {
      throw AppError.conflict(
        'An imported patient identity resolves to multiple patients',
        'IMPORT_PATIENT_IDENTITY_AMBIGUOUS',
        { identity_kind: claim.kind },
      );
    }
    if (!resolvedPatientUids.has(patientUid)) {
      throw AppError.conflict(
        'An imported patient identity belongs to a different patient',
        'IMPORT_PATIENT_IDENTITY_MISMATCH',
        { identity_kind: claim.kind },
      );
    }
    patientIdentifierIds.push(...matches.map(({ id }) => Number(id)));
  }
  if (externalClaims.length > 0 && patientIdentifierIds.length === 0) {
    throw AppError.conflict(
      'The imported patient identity is missing its external identifier binding',
      'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED',
    );
  }
  return clinicalImportPatientIdentityBinding({
    tenantId,
    patientId,
    patientUid,
    patientIdentifierIds,
  });
}

function collectFhirPatientIdentityClaims(bundle, targetPatientUid) {
  const claims = [];
  const acceptedReferences = new Set();
  let hasNativeVhUid = false;
  const patientEntries = (bundle.entry || []).filter(({ resource }) => (
    resource?.resourceType === 'Patient'
  ));
  if (patientEntries.length > 1) {
    throw AppError.conflict(
      'FHIR Bundle must not contain multiple Patient resources',
      'IMPORT_PATIENT_IDENTITY_AMBIGUOUS',
    );
  }
  for (const entry of patientEntries) {
    const resource = entry.resource;
    let entryHasNativeVhUid = false;
    for (const identifier of Array.isArray(resource.identifier) ? resource.identifier : []) {
      const system = String(identifier?.system || '').trim();
      if (system === 'urn:vhhealth:uid') {
        const uid = String(identifier?.value || '').trim().toLowerCase();
        if (!UUID_RE.test(uid) || uid !== targetPatientUid) {
          throw AppError.conflict(
            'FHIR Bundle patient identity does not match the authorised target patient',
            'IMPORT_PATIENT_IDENTITY_MISMATCH',
          );
        }
        hasNativeVhUid = true;
        entryHasNativeVhUid = true;
        continue;
      }
      const value = requiredExternalPatientIdentity(
        identifier?.value,
        'FHIR Patient.identifier.value',
      );
      const issuer = system
        ? requiredExternalPatientIdentity(system, 'FHIR Patient.identifier.system')
        : null;
      claims.push({
        kind: 'fhir_patient_identifier',
        value,
        issuer,
        issuerRequired: Boolean(issuer),
      });
    }
    if (resource.id) {
      const value = requiredExternalPatientIdentity(resource.id, 'FHIR Patient.id');
      acceptedReferences.add(value);
      acceptedReferences.add(`Patient/${value}`);
      if (!entryHasNativeVhUid) {
        claims.push({ kind: 'fhir_patient_id', value });
      }
    }
    if (entry.fullUrl) {
      const value = requiredExternalPatientIdentity(entry.fullUrl, 'FHIR Patient fullUrl');
      acceptedReferences.add(value);
      if (!entryHasNativeVhUid) {
        claims.push({ kind: 'fhir_patient_full_url', value });
      }
    }
    if (!entryHasNativeVhUid && !resource.id && !entry.fullUrl) {
      throw AppError.conflict(
        'FHIR Patient resource is missing a resolvable patient identity',
        'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED',
      );
    }
  }

  const canonicalReference = `Patient/${targetPatientUid}`;
  for (const entry of bundle.entry || []) {
    const resource = entry?.resource;
    if (!resource || resource.resourceType === 'Patient') continue;
    const referenceHolder = resource.subject || resource.patient;
    if (!referenceHolder?.reference) continue;
    const reference = requiredExternalPatientIdentity(
      referenceHolder.reference,
      `${resource.resourceType} patient reference`,
    );
    if (acceptedReferences.has(reference)) continue;
    if ([targetPatientUid, canonicalReference].includes(reference)) {
      hasNativeVhUid = true;
      continue;
    }
    const relativeMatch = /^Patient\/(.+)$/.exec(reference);
    claims.push({
      kind: relativeMatch ? 'fhir_patient_id' : 'fhir_patient_full_url',
      value: requiredExternalPatientIdentity(relativeMatch?.[1] || reference, 'FHIR patient reference'),
    });
    acceptedReferences.add(reference);
  }
  acceptedReferences.add(targetPatientUid);
  acceptedReferences.add(canonicalReference);
  return { claims, acceptedReferences, hasNativeVhUid };
}

function collectCcdaPatientIdentityClaims(parsed, targetPatientUid) {
  const claims = [];
  let hasNativeVhUid = false;
  for (const identifier of parsed.patient?.identifiers || []) {
    const root = String(identifier.root || '').trim();
    const extension = String(identifier.extension || '').trim();
    if (root.toLowerCase() === 'urn:vhhealth:uid') {
      const uid = extension.toLowerCase();
      if (!UUID_RE.test(uid) || uid !== targetPatientUid) {
        throw AppError.conflict(
          'C-CDA recordTarget does not match the authorised target patient',
          'IMPORT_PATIENT_IDENTITY_MISMATCH',
        );
      }
      hasNativeVhUid = true;
      continue;
    }
    const value = requiredExternalPatientIdentity(
      extension || root,
      'C-CDA patientRole.id',
    );
    claims.push({
      kind: 'ccda_patient_role_id',
      value,
      issuer: extension && root ? root : null,
      issuerRequired: Boolean(extension && root),
    });
  }
  return { claims, hasNativeVhUid };
}

function normalizeFhirBundlePatientReferences(bundle, targetPatientUid, acceptedReferences) {
  const canonicalReference = `Patient/${targetPatientUid}`;

  const entries = (bundle.entry || []).map((entry, sourceResourceIndex) => {
    const sourceResource = structuredClone(entry?.resource || null);
    const resource = structuredClone(entry?.resource || null);
    if (!resource) {
      return {
        ...entry,
        resource,
        __vhImportSourceIndex: sourceResourceIndex,
        __vhImportSourceResource: sourceResource,
      };
    }
    if (resource.resourceType === 'Patient') {
      resource.id = targetPatientUid;
      resource.identifier = [
        ...(Array.isArray(resource.identifier) ? resource.identifier.filter((identifier) => (
          identifier?.system !== 'urn:vhhealth:uid'
        )) : []),
        { system: 'urn:vhhealth:uid', value: targetPatientUid },
      ];
      return {
        ...entry,
        resource,
        __vhImportSourceIndex: sourceResourceIndex,
        __vhImportSourceResource: sourceResource,
      };
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
    return {
      ...entry,
      resource,
      __vhImportSourceIndex: sourceResourceIndex,
      __vhImportSourceResource: sourceResource,
    };
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
  if (String(authority?.actorUid || '').toLowerCase() !== String(importedBy || '').toLowerCase()) {
    throw AppError.forbidden(
      'Clinical import actor authority does not match the authenticated importer',
      'IMPORT_ACTOR_AUTHORITY_MISMATCH',
    );
  }
  assertClinicalImportPayloadHash(bundle, authority?.sourcePayloadSha256);
  const authorityWithSourceAuthor = {
    ...authority,
    sourceAuthorEvidence: fhirSourceAuthorEvidence(bundle),
  };
  const resourceManifest = buildFhirImportResourceManifest(bundle, authorityWithSourceAuthor);
  if (typeof authority?.revalidateAccess !== 'function') {
    throw AppError.internal(
      'Clinical import patient access revalidation is unavailable',
      'IMPORT_PATIENT_ACCESS_REVALIDATION_REQUIRED',
    );
  }
  let receiptResult;
  let deferredPostCommitEffects = [];
  for (let attempt = 1; attempt <= CLINICAL_IMPORT_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    const attemptPostCommitEffects = [];
    try {
      receiptResult = await setTenantTx(tid, async (lockTx) => {
        await lockTenantPatientMergeStability(lockTx, tid);
        const accessDecisionEvidence = await authority.revalidateAccess({
          db: lockTx,
          patientId: authority?.patientId,
          patientUid: targetPatientUid,
        });
        const transactionAuthority = {
          ...authorityWithSourceAuthor,
          accessDecisionEvidence,
        };
        const preliminaryReceiptAuthority = buildClinicalImportDocumentAuthority({
          tenantId: tid,
          patientUid: targetPatientUid,
          patientId: authority?.patientId,
          documentFormat: 'fhir_bundle',
          authority: withoutClinicalImportPatientIdentityBinding(transactionAuthority),
          resourceManifest,
        });
        const replay = await lockClinicalImportDocumentReceiptTx(lockTx, preliminaryReceiptAuthority);
        if (replay) return replay.result;
        const identityClaims = collectFhirPatientIdentityClaims(bundle, targetPatientUid);
        const identityBinding = await resolveExternalPatientIdentityClaimsTx(lockTx, {
          tenantId: tid,
          patientId: authority?.patientId,
          patientUid: targetPatientUid,
          claims: identityClaims.claims,
          hasNativeVhUid: identityClaims.hasNativeVhUid,
          resourceManifest,
        });
        const receiptAuthority = buildClinicalImportDocumentAuthority({
          tenantId: tid,
          patientUid: targetPatientUid,
          patientId: authority?.patientId,
          documentFormat: 'fhir_bundle',
          authority: { ...transactionAuthority, ...identityBinding },
          resourceManifest,
        });
        const identityBoundReplay = await lockClinicalImportDocumentReceiptTx(lockTx, receiptAuthority);
        if (identityBoundReplay) return identityBoundReplay.result;
        const normalizedBundle = normalizeFhirBundlePatientReferences(
          bundle,
          targetPatientUid,
          identityClaims.acceptedReferences,
        );
        const { results, resourceOutcomes } = await importFhirBundleWithStablePatientSnapshot(
          normalizedBundle,
          importedBy,
          {
            tenantId: tid,
            authority: {
              ...transactionAuthority,
              ...identityBinding,
              patientUid: targetPatientUid,
              documentSourceIdentitySha256: receiptAuthority.sourceIdentitySha256,
              resourceManifestSha256: receiptAuthority.resourceManifestSha256,
              idempotencyKeySha256: receiptAuthority.idempotencyKeySha256,
            },
            db: lockTx,
            deferPostCommitEffects: (effect) => attemptPostCommitEffects.push(effect),
            beforeFhirVitalWrite,
            resourceManifest,
          },
        );
        return persistClinicalImportDocumentReceiptTx(lockTx, receiptAuthority, {
          result: results,
          resourceOutcomes,
        });
      }, {
        isolationLevel: 'Serializable',
        timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS,
      });
      deferredPostCommitEffects = attemptPostCommitEffects;
      break;
    } catch (error) {
      if (attempt >= CLINICAL_IMPORT_SERIALIZABLE_ATTEMPTS
        || !isRetryableClinicalImportTransactionError(error)) {
        throw error;
      }
      logger.warn('Clinical FHIR import transaction conflicted; retrying from a fresh snapshot', {
        tenantId: tid,
        attempt,
        code: clinicalImportSqlState(error),
      });
      await waitForClinicalImportRetry(attempt);
    }
  }
  for (const effect of deferredPostCommitEffects) await effect();
  if ((receiptResult?.observationPartitions || []).length > 0) {
    receiptResult = await reconcileFhirReceiptReplayEffects(receiptResult, tid);
  }
  return receiptResult;
}

async function reconcileFhirReceiptReplayEffects(result, tenantId) {
  const reconciledResult = structuredClone(result);
  for (const partition of reconciledResult.observationPartitions || []) {
    const effectFingerprint = partition?.matchedSetFingerprint || partition?.setFingerprint;
    if (!effectFingerprint || !['imported', 'deduplicated'].includes(partition.status)) {
      continue;
    }
    try {
      let committed = await findCommittedFhirSet(tenantId, effectFingerprint);
      if (!committed) continue;
      const news2Pending = committed.news2_effects_completed_at == null;
      const anomalyPending = committed.anomaly_effects_completed_at == null;
      let reconciliation = null;
      if (committed.vitals_verified === false) {
        partition.verificationStatus = 'asserted_unverified';
        partition.clinicalEffectsReconciled = false;
        delete partition.error;
        delete partition.errorCode;
        delete partition.errorStatusCode;
        continue;
      }
      if (news2Pending || anomalyPending) {
        reconciliation = await reconcileFhirObservationSetEffects({
          tenantId,
          setFingerprint: effectFingerprint,
          vitalsChartId: committed.vitals_chart_id,
          news2Pending,
          anomalyPending,
        });
        committed = await findCommittedFhirSet(tenantId, effectFingerprint);
      }
      if (committed?.news2_effects_completed_at != null
        && committed?.anomaly_effects_completed_at != null) {
        partition.clinicalEffectsReconciled = (reconciliation?.claimedEffects?.length || 0) > 0;
        delete partition.error;
        delete partition.errorCode;
        delete partition.errorStatusCode;
      } else {
        partition.error = 'FHIR Observation clinical effects remain incomplete';
        partition.errorCode = reconciliation?.pendingEffects.length > 0
          ? 'FHIR_OBSERVATION_EFFECTS_IN_PROGRESS'
          : 'FHIR_OBSERVATION_EFFECTS_RETRY_FAILED';
        partition.errorStatusCode = reconciliation?.pendingEffects.length > 0 ? 409 : 503;
      }
    } catch (error) {
      logger.error('FHIR receipt replay clinical-effect reconciliation failed', {
        tenantId,
        setFingerprint: effectFingerprint,
        error: error.message,
      });
      partition.error = 'FHIR Observation clinical effects could not be restored';
      partition.errorCode = 'FHIR_OBSERVATION_EFFECTS_RETRY_FAILED';
      partition.errorStatusCode = 503;
    }
  }
  return reconciledResult;
}

function applyFhirObservationOutcomes({
  outcomes,
  results,
  resourceOutcomes,
  resourceIndexByResource,
}) {
  for (const observationResult of outcomes) {
    const {
      resources: outcomeResources,
      resourceErrors,
      ...publicOutcome
    } = observationResult;
    results.observationPartitions.push(publicOutcome);
    if (observationResult.status === 'imported') {
      results.imported += observationResult.resourceCount;
    }
    if (observationResult.status === 'deduplicated') {
      results.deduplicated += observationResult.resourceCount;
    }
    if (observationResult.status === 'skipped') {
      results.skipped += observationResult.resourceCount;
    }
    if (['error', 'failed'].includes(observationResult.status)) {
      results.failed += observationResult.resourceCount;
    }
    if (observationResult.error && ['error', 'failed'].includes(observationResult.status)) {
      for (const failedResource of outcomeResources) {
        const resourceKey = failedResource.id || '(no id)';
        const error = resourceErrors?.get(resourceKey) || observationResult.error;
        logger.warn(`FHIR import error for ${failedResource.resourceType}/${resourceKey}: ${error}`);
        results.errors.push({
          resource: failedResource.resourceType,
          id: failedResource.id,
          error,
          ...(observationResult.errorCode ? { code: observationResult.errorCode } : {}),
        });
      }
    }
    for (const outcomeResource of outcomeResources) {
      const outcomeIndex = resourceIndexByResource.get(outcomeResource);
      if (outcomeIndex == null) continue;
      const resourceKey = outcomeResource.id || '(no id)';
      resourceOutcomes[outcomeIndex] = receiptOutcome({
        status: observationResult.status,
        targetTable: ['imported', 'deduplicated'].includes(observationResult.status)
          ? 'vitals_chart'
          : null,
        targetId: ['imported', 'deduplicated'].includes(observationResult.status)
          ? observationResult.vitalsChartId
          : null,
        canonicalTimelineEventId: observationResult.canonicalTimelineEventId || null,
        canonicalAuditEventId: observationResult.canonicalAuditEventId || null,
      }, {
        set_fingerprint: observationResult.setFingerprint || null,
        error: resourceErrors?.get(resourceKey) || observationResult.error || null,
        error_code: observationResult.errorCode || null,
        clinical_effects_reconciled: observationResult.clinicalEffectsReconciled || false,
      });
    }
  }
}

async function importFhirBundleWithStablePatientSnapshot(bundle, importedBy, {
  tenantId,
  authority,
  db,
  deferPostCommitEffects,
  beforeFhirVitalWrite,
  resourceManifest,
}) {

  const results = {
    imported: 0,
    skipped: 0,
    deduplicated: 0,
    failed: 0,
    errors: [],
    observationPartitions: [],
  };
  const resourceOutcomes = initialResourceOutcomes(resourceManifest);
  const resourceIndexByResource = new Map(
    (bundle.entry || []).map((entry, index) => [
      entry?.resource,
      Number.isInteger(entry?.__vhImportSourceIndex) ? entry.__vhImportSourceIndex : index,
    ]),
  );
  const {
    groups: observationGroups,
    groupKeyByResource: observationGroupKeyByResource,
  } = buildExplicitFhirVitalGroups(bundle.entry || []);
  const importedObservationGroups = new Set();
  let implicitObservationGroupsBuilt = false;

  for (const [entryIndex, entry] of (bundle.entry || []).entries()) {
    const resource = entry.resource;
    const sourceResourceIndex = Number.isInteger(entry?.__vhImportSourceIndex)
      ? entry.__vhImportSourceIndex
      : entryIndex;
    if (!resource || !resource.resourceType) {
      results.skipped++;
      resourceOutcomes[sourceResourceIndex] = receiptOutcome('skipped', {
        reason: 'missing_resource_type',
      });
      continue;
    }

    let resources = [resource];
    await beginClinicalImportResourceSavepoint(db);
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
              db,
              groups: observationGroups,
              groupKeyByResource: observationGroupKeyByResource,
            });
            implicitObservationGroupsBuilt = true;
            groupKey = observationGroupKeyByResource.get(resource);
          }
          const group = groupKey ? observationGroups.get(groupKey) : null;
          if (groupKey) {
            if (importedObservationGroups.has(groupKey)) {
              await releaseClinicalImportResourceSavepoint(db);
              continue;
            }
            importedObservationGroups.add(groupKey);
            resources = group?.resources || resources;
          }
          const outcomes = await importObservationSet(resources, importedBy, {
            tenantId,
            db,
            deferPostCommitEffects,
            groupParent: group?.parent || null,
            groupMembers: group?.members || null,
            beforeFhirVitalWrite,
            requiresClinicalVerification: true,
          });
          applyFhirObservationOutcomes({
            outcomes,
            results,
            resourceOutcomes,
            resourceIndexByResource,
          });
          resources = [];
          break;
        }
        default:
          results.skipped++;
          resourceOutcomes[sourceResourceIndex] = receiptOutcome('skipped', {
            reason: 'unsupported_resource_type',
          });
          await releaseClinicalImportResourceSavepoint(db);
          continue;
      }
      const status = typeof outcome === 'string' ? outcome : outcome?.status;
      if (status === 'imported') results.imported += resources.length;
      else if (status === 'deduplicated') results.deduplicated += resources.length;
      else if (status === 'failed') {
        results.failed += resources.length;
        for (const failedResource of resources) {
          results.errors.push({
            resource: failedResource.resourceType,
            id: failedResource.id || null,
            error: outcome.error || 'FHIR resource requires reconciliation',
            code: outcome.errorCode || 'FHIR_RESOURCE_IMPORT_FAILED',
          });
        }
      } else if (resources.length) results.skipped += resources.length;
      if (resources.length) {
        resourceOutcomes[sourceResourceIndex] = receiptOutcome(outcome, {
          error: outcome?.error || null,
          error_code: outcome?.errorCode || null,
          error_status_code: outcome?.errorStatusCode || null,
        });
      }
      await releaseClinicalImportResourceSavepoint(db);
    } catch (err) {
      try {
        await rollbackClinicalImportResourceSavepoint(db);
      } catch (rollbackError) {
        if (isRetryableClinicalImportTransactionError(err)) throw err;
        throw rollbackError;
      }
      if (isRetryableClinicalImportTransactionError(err)) throw err;
      if (isFatalClinicalImportResourceError(err, resources)) throw err;
      const failure = safeClinicalImportResourceFailure(
        err,
        'FHIR_RESOURCE_IMPORT_FAILED',
        'FHIR resource import failed',
      );
      if (resources.length > 0
        && resources.every((resource) => resource?.resourceType === 'Observation')) {
        applyFhirObservationOutcomes({
          outcomes: [observationOutcome('error', resources, {
            error: err instanceof AppError && Number(err.statusCode) < 500
              ? err.message
              : failure.error,
            errorCode: failure.errorCode,
            errorStatusCode: failure.errorStatusCode,
          })],
          results,
          resourceOutcomes,
          resourceIndexByResource,
        });
        continue;
      }
      for (const failedResource of resources) {
        results.failed += 1;
        const failedIndex = resourceIndexByResource.get(failedResource);
        if (failedIndex != null) {
          resourceOutcomes[failedIndex] = receiptOutcome('failed', {
            error: failure.error,
            error_code: failure.errorCode,
            error_status_code: failure.errorStatusCode,
          });
        }
        logger.warn('FHIR resource import failed', {
          resourceType: failedResource.resourceType,
          resourceId: failedResource.id || null,
          error: err.message,
          code: err?.code || null,
        });
        results.errors.push({
          resource: failedResource.resourceType,
          id: failedResource.id,
          error: failure.error,
          code: failure.errorCode,
        });
      }
    }
  }

  logger.info(
    `FHIR Bundle import complete: ${results.imported} imported, ${results.deduplicated} deduplicated, `
    + `${results.skipped} skipped, ${results.failed} failed`,
  );
  return { results, resourceOutcomes };
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
  if (String(authority?.actorUid || '').toLowerCase() !== String(importedBy || '').toLowerCase()) {
    throw AppError.forbidden(
      'Clinical import actor authority does not match the authenticated importer',
      'IMPORT_ACTOR_AUTHORITY_MISMATCH',
    );
  }
  assertClinicalImportPayloadHash(xmlString, authority?.sourcePayloadSha256);
  const parsed = parseCcdaClinicalDocument(xmlString);
  const authorityWithSourceAuthor = {
    ...authority,
    sourceAuthorEvidence: ccdaSourceAuthorEvidence(parsed),
  };
  const resources = buildCcdaImportResourceManifest(parsed, authorityWithSourceAuthor);
  const resourceManifest = resources.map(({ manifest }) => manifest);
  if (typeof authority?.revalidateAccess !== 'function') {
    throw AppError.internal(
      'Clinical import patient access revalidation is unavailable',
      'IMPORT_PATIENT_ACCESS_REVALIDATION_REQUIRED',
    );
  }
  const results = await setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    const accessDecisionEvidence = await authority.revalidateAccess({
      db: tx,
      patientId: authority?.patientId,
      patientUid,
    });
    const transactionAuthority = {
      ...authorityWithSourceAuthor,
      accessDecisionEvidence,
    };
    const preliminaryReceiptAuthority = buildClinicalImportDocumentAuthority({
      tenantId: tid,
      patientUid,
      patientId: authority?.patientId,
      documentFormat: 'ccda',
      authority: withoutClinicalImportPatientIdentityBinding(transactionAuthority),
      resourceManifest,
    });
    const replay = await lockClinicalImportDocumentReceiptTx(tx, preliminaryReceiptAuthority);
    if (replay) return replay.result;
    const identityClaims = collectCcdaPatientIdentityClaims(parsed, patientUid);
    const identityBinding = await resolveExternalPatientIdentityClaimsTx(tx, {
      tenantId: tid,
      patientId: authority?.patientId,
      patientUid,
      claims: identityClaims.claims,
      hasNativeVhUid: identityClaims.hasNativeVhUid,
    });
    const receiptAuthority = buildClinicalImportDocumentAuthority({
      tenantId: tid,
      patientUid,
      patientId: authority?.patientId,
      documentFormat: 'ccda',
      authority: { ...transactionAuthority, ...identityBinding },
      resourceManifest,
    });
    const identityBoundReplay = await lockClinicalImportDocumentReceiptTx(tx, receiptAuthority);
    if (identityBoundReplay) return identityBoundReplay.result;
    const receiptBoundAuthority = {
      ...transactionAuthority,
      ...identityBinding,
      documentSourceIdentitySha256: receiptAuthority.sourceIdentitySha256,
      resourceManifestSha256: receiptAuthority.resourceManifestSha256,
      idempotencyKeySha256: receiptAuthority.idempotencyKeySha256,
    };
    const resourceOutcomes = initialResourceOutcomes(resourceManifest);
    const patientOutcome = await importPatientFromCCDA(parsed.patient, importedBy, {
      tenantId: tid,
      authority: { ...receiptBoundAuthority, patientUid },
      db: tx,
    });
    const outcome = {
      imported: 0,
      skipped: 0,
      deduplicated: 0,
      failed: 0,
      errors: [],
    };
    applyCcdaResourceOutcome({
      summary: outcome,
      resourceOutcomes,
      receiptIndex: 0,
      resourceType: 'C-CDA_Patient',
      outcome: patientOutcome,
    });
    for (let problemIndex = 0; problemIndex < parsed.problems.length; problemIndex += 1) {
      const problemOutcome = await importDiagnosisFromCCDA(
        parsed.problems[problemIndex],
        patientUid,
        importedBy,
        {
        tenantId: tid,
        authority: receiptBoundAuthority,
        db: tx,
        },
      );
      const receiptIndex = 1 + problemIndex;
      applyCcdaResourceOutcome({
        summary: outcome,
        resourceOutcomes,
        receiptIndex,
        resourceType: 'C-CDA_Problem',
        resourceId: parsed.problems[problemIndex].id || parsed.problems[problemIndex].code || null,
        localIndex: problemIndex,
        outcome: problemOutcome,
      });
    }
    const allergyOffset = 1 + parsed.problems.length;
    for (let allergyIndex = 0; allergyIndex < parsed.allergies.length; allergyIndex += 1) {
      const allergyOutcome = await importAllergyFromCCDA(
        parsed.allergies[allergyIndex],
        patientUid,
        importedBy,
        {
        tenantId: tid,
        authority: receiptBoundAuthority,
        db: tx,
        },
      );
      const receiptIndex = allergyOffset + allergyIndex;
      applyCcdaResourceOutcome({
        summary: outcome,
        resourceOutcomes,
        receiptIndex,
        resourceType: 'C-CDA_Allergy',
        resourceId: parsed.allergies[allergyIndex].id || parsed.allergies[allergyIndex].code || null,
        localIndex: allergyIndex,
        outcome: allergyOutcome,
      });
    }
    const medicationOffset = allergyOffset + parsed.allergies.length;
    for (let lineIndex = 0; lineIndex < parsed.medications.length; lineIndex += 1) {
      const medication = parsed.medications[lineIndex];
      await beginClinicalImportResourceSavepoint(tx);
      try {
        const medicationOutcome = await importMedicationFromCCDA(
          medication,
          patientUid,
          importedBy,
          {
            tenantId: tid,
            authority: receiptBoundAuthority,
            db: tx,
            lineIndex,
            sourceResourceIndex: medicationOffset + lineIndex,
          },
        );
        applyCcdaResourceOutcome({
          summary: outcome,
          resourceOutcomes,
          receiptIndex: medicationOffset + lineIndex,
          resourceType: 'C-CDA_Medication',
          resourceId: medication.id || medication.code || null,
          localIndex: lineIndex,
          outcome: medicationOutcome,
        });
        await releaseClinicalImportResourceSavepoint(tx);
      } catch (err) {
        await rollbackClinicalImportResourceSavepoint(tx);
        if (isFatalClinicalImportResourceError(err, [{ resourceType: 'C-CDA_Medication' }])) {
          throw err;
        }
        const failure = safeClinicalImportResourceFailure(
          err,
          'CCDA_MEDICATION_IMPORT_FAILED',
          'C-CDA medication import failed',
        );
        logger.warn('C-CDA medication import failed', {
          medicationId: medication.id || null,
          lineIndex,
          error: err.message,
          code: err?.code || null,
        });
        outcome.failed += 1;
        outcome.errors.push({
          resource: 'C-CDA_Medication',
          id: medication.id || null,
          index: lineIndex,
          error: failure.error,
          code: failure.errorCode,
        });
        resourceOutcomes[medicationOffset + lineIndex] = receiptOutcome('failed', {
          error: failure.error,
          error_code: failure.errorCode,
          error_status_code: failure.errorStatusCode,
        });
      }
    }
    return persistClinicalImportDocumentReceiptTx(tx, receiptAuthority, {
      result: outcome,
      resourceOutcomes,
    });
  }, {
    isolationLevel: 'Serializable',
    timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS,
  });
  logger.info(
    `C-CDA import complete: ${results.imported} imported, ${results.deduplicated} deduplicated, `
    + `${results.skipped} skipped`,
  );
  return results;
}

// =============================================================================
// FHIR RESOURCE IMPORTERS (with deduplication)
// =============================================================================

async function resolveFhirVitalPatientInTenant(patientUid, tenantId = null, db = prisma) {
  const rows = await db.$queryRawUnsafe(
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
  return {
    status: 'deduplicated',
    targetTable: 'users',
    targetId: String(existing[0].id),
  };
}

async function importCondition(fhirCondition) {
  if (!fhirCondition || fhirCondition.resourceType !== 'Condition') return 'skipped';
  return clinicalAssertionPromotionRequired('Condition', fhirCondition.id || null);
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
        AND merged_into_uid IS NULL`,
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

  const evidence = fhirMedicationImportEvidence(fhirMedication, authority);
  const { medication, status, sourceStatus } = evidence;
  const note = fhirMedication.note?.[0]?.text || null;
  const promotedMedication = stripHtml(medication) || 'Imported medication';
  const promotedNote = note == null ? null : stripHtml(note);
  const promotedDosageInstruction = deepSanitizeStrings(
    structuredClone(fhirMedication.dosageInstruction || []),
  );

  // Imported MedicationRequest rows are longitudinal medication history, not
  // actionable pharmacy orders. They stay unlinked until a local clinician
  // creates a governed prescription/order with catalog and facility authority.
  if (!fhirMedication.id) {
    throw AppError.badRequest(
      'MedicationRequest must have a stable source resource id',
      'IMPORT_SOURCE_RESOURCE_ID_REQUIRED',
    );
  }
  const importIdentity = evidence.sourceIdentitySha256;
  const payloadSha256 = evidence.payloadSha256;
  const prescriptionNumber = `IMP-FHIR-${importIdentity.slice(0, 32)}`;
  const importReceipt = medicationImportReceipt({
    authority,
    importedBy,
    sourceResourceType: 'MedicationRequest',
    sourceResourceId: fhirMedication.id,
    sourceIdentitySha256: importIdentity,
    payloadSha256,
  });

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
      || receipt?.payload_sha256 !== payloadSha256
      || receipt?.document_source_identity_sha256 !== authority?.documentSourceIdentitySha256
      || receipt?.resource_manifest_sha256 !== authority?.resourceManifestSha256
      || receipt?.idempotency_key_sha256 !== authority?.idempotencyKeySha256) {
      throw AppError.conflict(
        'MedicationRequest source identity was replayed with different clinical content',
        'IMPORT_SOURCE_IDENTITY_DRIFT',
        { source_resource_id: fhirMedication.id },
      );
    }
    logger.info(`Skipped duplicate medication for patient ${patientUid}: ${promotedMedication}`);
    const canonical = await recordImportedMedicationCanonicalPair({
      db,
      tenantId,
      patientUid,
      importedBy,
      authority,
      targetId: existing[0].id,
      medication: promotedMedication,
      status,
      sourceStatus,
      importReceipt,
      importIdentity,
    });
    return {
      status: 'deduplicated',
      targetTable: 'e_prescriptions',
      targetId: String(existing[0].id),
      canonicalTimelineEventId: canonical.timeline.id,
      canonicalAuditEventId: canonical.audit.id,
    };
  }

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
    promotedMedication,
    JSON.stringify([{
      name: promotedMedication,
      dosage_instruction: promotedDosageInstruction,
      source: 'FHIR_MedicationRequest',
      source_id: fhirMedication.id,
      source_status: sourceStatus,
      verification_status: 'asserted_unverified',
      import_receipt: importReceipt,
    }]),
    promotedNote || `Imported by ${importedBy}`,
    status,
    prescriptionNumber,
  );
  const canonical = await recordImportedMedicationCanonicalPair({
    db,
    tenantId,
    patientUid,
    importedBy,
    authority,
    targetId: inserted[0].id,
    medication: promotedMedication,
    status,
    sourceStatus,
    importReceipt,
    importIdentity,
  });
  return {
    status: 'imported',
    targetTable: 'e_prescriptions',
    targetId: String(inserted[0].id),
    canonicalTimelineEventId: canonical.timeline.id,
    canonicalAuditEventId: canonical.audit.id,
  };
}

async function importAllergyIntolerance(fhirAllergy) {
  if (!fhirAllergy || fhirAllergy.resourceType !== 'AllergyIntolerance') return 'skipped';
  return clinicalAssertionPromotionRequired('AllergyIntolerance', fhirAllergy.id || null);
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
  db = prisma,
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
      patientPromise = resolveFhirVitalPatientInTenant(prepared.patientUid, tenantId, db);
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

async function findCommittedFhirSet(tenantId, setFingerprint, db = null) {
  const find = async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT observation_set.set_fingerprint,
              vitals_chart_id,
              vitals.device_verified AS vitals_verified,
              news2_effects_completed_at,
              anomaly_effects_completed_at,
              news2_effects_claimed_at,
              news2_effects_claim_token,
              news2_effects_attempts,
              news2_effects_next_retry_at,
              anomaly_effects_claimed_at,
              anomaly_effects_claim_token,
              anomaly_effects_attempts,
              anomaly_effects_next_retry_at,
              (SELECT timeline.id
                 FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = observation_set.tenant_id
                  AND timeline.source_table = 'vitals_chart'
                  AND timeline.source_id = observation_set.vitals_chart_id::text
                  AND timeline.event_type = 'vitals.recorded'
                ORDER BY timeline.occurred_at, timeline.id
                LIMIT 1) AS canonical_timeline_event_id,
              (SELECT audit.id
                 FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = observation_set.tenant_id
                  AND audit.resource_table = 'vitals_chart'
                  AND audit.resource_id = observation_set.vitals_chart_id::text
                  AND audit.action = 'vitals.recorded'
                ORDER BY audit.occurred_at, audit.id
                LIMIT 1) AS canonical_audit_event_id
         FROM fhir_vital_observation_sets AS observation_set
         JOIN vitals_chart AS vitals
           ON vitals.tenant_id = observation_set.tenant_id
          AND vitals.id = observation_set.vitals_chart_id
        WHERE observation_set.tenant_id = $1::uuid
          AND observation_set.set_fingerprint = $2
          AND observation_set.vitals_chart_id IS NOT NULL`,
      tenantId, setFingerprint,
    );
    return rows[0] || null;
  };
  return db ? find(db) : setTenantTx(tenantId, find);
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
            AND EXISTS (
              SELECT 1
                FROM vitals_chart AS vitals
               WHERE vitals.tenant_id = fhir_vital_observation_sets.tenant_id
                 AND vitals.id = fhir_vital_observation_sets.vitals_chart_id
                 AND vitals.device_verified IS DISTINCT FROM FALSE
            )
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
            AND EXISTS (
              SELECT 1
                FROM vitals_chart AS vitals
               WHERE vitals.tenant_id = fhir_vital_observation_sets.tenant_id
                 AND vitals.id = fhir_vital_observation_sets.vitals_chart_id
                 AND vitals.device_verified IS DISTINCT FROM FALSE
            )
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
      `SELECT observation_set.set_fingerprint,
              vitals_chart_id,
              vitals.device_verified AS vitals_verified,
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
         FROM fhir_vital_observation_sets AS observation_set
         JOIN vitals_chart AS vitals
           ON vitals.tenant_id = observation_set.tenant_id
          AND vitals.id = observation_set.vitals_chart_id
        WHERE observation_set.tenant_id = $1::uuid
          AND observation_set.set_fingerprint = $2
          AND observation_set.vitals_chart_id = $3::integer`,
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
    verificationPending: claimed.state.vitals_verified === false,
  };
}

export async function reconcileVerifiedFhirVitalEffects({ tenantId, vitalsChartId } = {}) {
  const resolvedVitalsChartId = Number(vitalsChartId);
  if (!Number.isInteger(resolvedVitalsChartId) || resolvedVitalsChartId <= 0) {
    throw AppError.badRequest('vitalsChartId must be a positive integer');
  }
  const rows = await setTenantTx(tenantId, async (tx) => {
    // An explicit clinician retry is a governed recovery signal. Make a
    // previously released claim immediately eligible without stealing a live
    // lease; unattended sweeps continue to honour the normal backoff.
    await tx.$executeRawUnsafe(
      `UPDATE fhir_vital_observation_sets AS observation_set
          SET news2_effects_next_retry_at = CASE
                WHEN news2_effects_completed_at IS NULL
                 AND news2_effects_claimed_at IS NULL THEN NULL
                ELSE news2_effects_next_retry_at END,
              anomaly_effects_next_retry_at = CASE
                WHEN anomaly_effects_completed_at IS NULL
                 AND anomaly_effects_claimed_at IS NULL THEN NULL
                ELSE anomaly_effects_next_retry_at END
         FROM vitals_chart AS vitals
        WHERE observation_set.tenant_id = $1::uuid
          AND observation_set.vitals_chart_id = $2::integer
          AND vitals.tenant_id = observation_set.tenant_id
          AND vitals.id = observation_set.vitals_chart_id
          AND vitals.source = 'fhir'
          AND vitals.device_verified = TRUE`,
      tenantId,
      resolvedVitalsChartId,
    );
    return tx.$queryRawUnsafe(
      `SELECT observation_set.set_fingerprint,
              observation_set.news2_effects_completed_at,
              observation_set.anomaly_effects_completed_at
         FROM fhir_vital_observation_sets AS observation_set
         JOIN vitals_chart AS vitals
           ON vitals.tenant_id = observation_set.tenant_id
          AND vitals.id = observation_set.vitals_chart_id
        WHERE observation_set.tenant_id = $1::uuid
          AND observation_set.vitals_chart_id = $2::integer
          AND vitals.source = 'fhir'
          AND vitals.device_verified = TRUE
        LIMIT 1`,
      tenantId,
      resolvedVitalsChartId,
    );
  });
  const state = rows[0];
  if (!state) {
    throw AppError.notFound(
      'Verified imported FHIR vitals state was not found',
      'FHIR_VITAL_VERIFICATION_STATE_NOT_FOUND',
    );
  }
  const news2Pending = state.news2_effects_completed_at == null;
  const anomalyPending = state.anomaly_effects_completed_at == null;
  if (!news2Pending && !anomalyPending) {
    return { claimedEffects: [], pendingEffects: [], verificationPending: false };
  }
  return reconcileFhirObservationSetEffects({
    tenantId,
    setFingerprint: state.set_fingerprint,
    vitalsChartId: resolvedVitalsChartId,
    news2Pending,
    anomalyPending,
  });
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
    `SELECT observation_set.set_fingerprint, observation_set.vitals_chart_id
       FROM fhir_vital_observation_sets AS observation_set
       JOIN vitals_chart AS vitals
         ON vitals.tenant_id = observation_set.tenant_id
        AND vitals.id = observation_set.vitals_chart_id
      WHERE observation_set.tenant_id = $1::uuid
        AND observation_set.vitals_chart_id IS NOT NULL
        AND vitals.device_verified IS DISTINCT FROM FALSE
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
      ORDER BY observation_set.created_at, observation_set.set_fingerprint
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
  db = null,
  deferPostCommitEffects = null,
  groupParent = null,
  groupMembers = null,
  beforeFhirVitalWrite = null,
  requiresClinicalVerification = false,
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
        await resolveFhirVitalPatientInTenant(observation.patientUid, tenantId, db || prisma),
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
  const initialEffectClaims = requiresClinicalVerification ? null : {
    news2: crypto.randomUUID(),
    anomaly: crypto.randomUUID(),
  };
  if (db) await beginFhirObservationWriteSavepoint(db);
  try {
    const result = await recordVitals(payload, {
      ...(db ? { db, deferPostCommitEffects } : {}),
      requireClinicalVerification: requiresClinicalVerification,
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
                  news2_effects_claimed_at = CASE WHEN $4::uuid IS NULL THEN NULL ELSE clock_timestamp() END,
                  news2_effects_claim_token = $4::uuid,
                  news2_effects_attempts = news2_effects_attempts + CASE WHEN $4::uuid IS NULL THEN 0 ELSE 1 END,
                  news2_effects_next_retry_at = NULL,
                  anomaly_effects_claimed_at = CASE WHEN $5::uuid IS NULL THEN NULL ELSE clock_timestamp() END,
                  anomaly_effects_claim_token = $5::uuid,
                  anomaly_effects_attempts = anomaly_effects_attempts + CASE WHEN $5::uuid IS NULL THEN 0 ELSE 1 END,
                  anomaly_effects_next_retry_at = NULL
            WHERE tenant_id = $1::uuid
              AND set_fingerprint = $2
              AND vitals_chart_id IS NULL`,
          resolvedTenantId,
          setFingerprint,
          vitals.id,
          initialEffectClaims?.news2 ?? null,
          initialEffectClaims?.anomaly ?? null,
        );
        if (linked !== 1) {
          throw new Error('FHIR Observation set receipt could not be linked to its vitals row');
        }
        linkedVitalsChartId = vitals.id;
      },
      onNews2EffectsCompleted: requiresClinicalVerification ? null : async ({ vitals }) => {
        await markFhirObservationEffectCompleted({
          tenantId: resolvedTenantId,
          setFingerprint,
          vitalsChartId: vitals.id,
          effect: 'news2',
          claimToken: initialEffectClaims.news2,
        });
      },
      onClinicalAlertsPersisted: requiresClinicalVerification ? null : async ({ tx, alerts: persistedAlerts }) => {
        await markFhirObservationEffectCompleted({
          tenantId: resolvedTenantId,
          setFingerprint,
          vitalsChartId: linkedVitalsChartId,
          effect: 'anomaly',
          claimToken: initialEffectClaims?.anomaly ?? null,
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
      verificationStatus: requiresClinicalVerification ? 'asserted_unverified' : 'verified',
      newResourceReceipts: claimEvidence.newResourceReceipts,
      reusedResourceReceipts: claimEvidence.reusedResourceReceipts,
          canonicalTimelineEventId: result.canonicalTimelineEventId,
          canonicalAuditEventId: result.canonicalAuditEventId,
    })];
    if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
    if (db) await releaseFhirObservationWriteSavepoint(db);
    return outcomes;
  } catch (error) {
    if (db) {
      try {
        await rollbackFhirObservationWriteSavepoint(db);
      } catch (rollbackError) {
        if (isRetryableClinicalImportTransactionError(error)) throw error;
        throw rollbackError;
      }
    }
    if (isRetryableClinicalImportTransactionError(error)) throw error;
    if (error instanceof FhirObservationReplay) {
      const matchedSetFingerprint = error.matchedSetFingerprint || setFingerprint;
      let committed;
      try {
        committed = await findCommittedFhirSet(resolvedTenantId, matchedSetFingerprint, db);
      } catch (lookupError) {
        if (isRetryableClinicalImportTransactionError(lookupError)) throw lookupError;
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
      if (committed.vitals_verified === false) {
        reconciliationResult = { claimedEffects: [], pendingEffects: ['news2', 'anomaly'], verificationPending: true };
      } else if (news2Pending || anomalyPending) {
        if (db) {
          reconciliationResult = {
            claimedEffects: [],
            pendingEffects: [
              ...(news2Pending ? ['news2'] : []),
              ...(anomalyPending ? ['anomaly'] : []),
            ],
          };
        } else {
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
          verificationStatus: committed.vitals_verified === false ? 'asserted_unverified' : 'verified',
          canonicalTimelineEventId: committed.canonical_timeline_event_id,
          canonicalAuditEventId: committed.canonical_audit_event_id,
        },
      )];
      if (skippedResources.length > 0) outcomes.push(observationOutcome('skipped', skippedResources));
      return outcomes;
    }

    if (db) throw error;

    if (linkedVitalsChartId != null && initialEffectClaims) {
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
      committed = await findCommittedFhirSet(resolvedTenantId, setFingerprint, db);
    } catch (lookupError) {
      if (isRetryableClinicalImportTransactionError(lookupError)) throw lookupError;
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
        canonicalTimelineEventId: committed.canonical_timeline_event_id,
        canonicalAuditEventId: committed.canonical_audit_event_id,
        error: 'FHIR vitals were committed, but clinical effects remain incomplete',
        errorCode: 'FHIR_OBSERVATION_EFFECTS_INCOMPLETE',
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
      errorCode: errorStatusCode >= 500
        ? 'FHIR_OBSERVATION_IMPORT_FAILED'
        : (error.code || 'FHIR_OBSERVATION_IMPORT_FAILED'),
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

function ccdaAssignedAuthorDisplay(assignedAuthor) {
  const personName = ccdaArray(assignedAuthor?.assignedPerson?.name)[0] || {};
  const personDisplay = [
    ...ccdaArray(personName.prefix),
    ...ccdaArray(personName.given),
    ...ccdaArray(personName.family),
    ...ccdaArray(personName.suffix),
  ].map(ccdaText).filter(Boolean).join(' ');
  if (personDisplay) return personDisplay;
  const organizationName = ccdaText(assignedAuthor?.representedOrganization?.name);
  if (organizationName) return organizationName;
  return ccdaText(assignedAuthor?.assignedAuthoringDevice?.manufacturerModelName)
    || ccdaText(assignedAuthor?.assignedAuthoringDevice?.softwareName)
    || null;
}

function extractCcdaSourceAuthors(document) {
  const authors = [];
  for (const author of ccdaArray(document.author)) {
    const assignedAuthors = ccdaArray(author?.assignedAuthor);
    if (assignedAuthors.length !== 1) {
      throw AppError.badRequest(
        'Each C-CDA author must contain exactly one assignedAuthor',
        'CCDA_AUTHOR_IDENTITY_REQUIRED',
      );
    }
    const assignedAuthor = assignedAuthors[0];
    const display = ccdaAssignedAuthorDisplay(assignedAuthor);
    const identifiers = ccdaArray(assignedAuthor?.id).map((identifier) => ({
      root: String(identifier?.['@_root'] || '').trim() || null,
      extension: String(identifier?.['@_extension'] || '').trim() || null,
      display,
    })).filter((identifier) => identifier.root || identifier.extension);
    if (identifiers.length === 0) {
      throw AppError.badRequest(
        'C-CDA assignedAuthor identity is required',
        'CCDA_AUTHOR_IDENTITY_REQUIRED',
      );
    }
    authors.push(...identifiers);
  }
  return [...new Map(authors.map((author) => (
    [JSON.stringify(author), author]
  ))).values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
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
    const validationError = validation && typeof validation === 'object'
      ? validation.err || {}
      : {};
    throw AppError.badRequest('C-CDA XML is malformed', 'CCDA_XML_INVALID', {
      validation_code: String(validationError.code || 'INVALID_XML').slice(0, 80),
      line: Number.isInteger(validationError.line) ? validationError.line : null,
      column: Number.isInteger(validationError.col) ? validationError.col : null,
    });
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
  } catch {
    throw AppError.badRequest('C-CDA XML could not be parsed', 'CCDA_XML_INVALID');
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
  const patientIdentifiers = ccdaArray(patientRole.id).map((identifier) => ({
    root: String(identifier?.['@_root'] || '').trim() || null,
    extension: String(identifier?.['@_extension'] || '').trim() || null,
  })).filter((identifier) => identifier.root || identifier.extension);
  const nativePatientIdentifier = patientIdentifiers.find((identifier) => (
    identifier.root?.toLowerCase() === 'urn:vhhealth:uid'
  ));
  const address = ccdaArray(patientRole.addr)[0] || {};
  return {
    patient: {
      uid: nativePatientIdentifier?.extension || null,
      identifiers: patientIdentifiers,
      name: [given, family].filter(Boolean).join(' ') || null,
      phone: telecom ? telecom.slice(4) : null,
      gender: { M: 'Male', F: 'Female' }[patientNode.administrativeGenderCode?.['@_code']] || null,
      birthday: parseCcdaDate(patientNode.birthTime?.['@_value']),
      address: [address.streetAddressLine, address.city, address.state, address.postalCode]
        .flatMap(ccdaArray).map(ccdaText).filter(Boolean).join(', ') || null,
    },
    authors: extractCcdaSourceAuthors(document),
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
  return {
    status: 'deduplicated',
    targetTable: 'users',
    targetId: String(rows[0].id),
  };
}

async function importDiagnosisFromCCDA(problem, patientUid) {
  if (!patientUid || !problem.displayName) return { status: 'skipped' };
  return clinicalAssertionPromotionRequired(
    'C-CDA_Problem',
    problem.id || problem.code || null,
  );
}

async function importMedicationFromCCDA(med, patientUid, importedBy, {
  tenantId = null,
  authority = null,
  db = prisma,
  lineIndex = null,
  sourceResourceIndex = lineIndex,
} = {}) {
  if (!patientUid || !med.displayName) return { status: 'skipped' };
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
        AND merged_into_uid IS NULL`,
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
  const evidence = ccdaMedicationImportEvidence(med, authority, lineIndex);
  const importIdentity = evidence.sourceIdentitySha256;
  const payloadSha256 = evidence.payloadSha256;
  const promotedMedication = stripHtml(med.displayName) || 'Imported medication';
  const promotedSourceText = med.text == null ? null : stripHtml(med.text);
  const promotedSourceCode = med.code == null ? null : stripHtml(String(med.code));
  const promotedCodeSystem = med.codeSystem == null
    ? null
    : stripHtml(String(med.codeSystem));
  const prescriptionNumber = `IMP-CCDA-${importIdentity.slice(0, 32)}`;
  const sourceStatus = String(med.status || '').trim().toLowerCase() || null;
  const status = ['active', 'completed', 'cancelled', 'canceled', 'stopped', 'on-hold']
    .includes(sourceStatus) ? sourceStatus : 'unknown';
  const importReceipt = medicationImportReceipt({
    authority,
    importedBy,
    sourceResourceType: 'C-CDA_Medication',
    sourceResourceId: med.id || med.code || null,
    sourceResourceIndex,
    sourceIdentitySha256: importIdentity,
    payloadSha256,
  });

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
      || receipt?.payload_sha256 !== payloadSha256
      || receipt?.document_source_identity_sha256 !== authority?.documentSourceIdentitySha256
      || receipt?.resource_manifest_sha256 !== authority?.resourceManifestSha256
      || receipt?.idempotency_key_sha256 !== authority?.idempotencyKeySha256) {
      throw AppError.conflict(
        'C-CDA medication source identity was replayed with different clinical content',
        'IMPORT_SOURCE_IDENTITY_DRIFT',
        { source_resource_index: lineIndex },
      );
    }
    const canonical = await recordImportedMedicationCanonicalPair({
      db,
      tenantId,
      patientUid,
      importedBy,
      authority,
      targetId: existing[0].id,
      medication: promotedMedication,
      status,
      sourceStatus,
      importReceipt,
      importIdentity,
    });
    return {
      status: 'deduplicated',
      targetTable: 'e_prescriptions',
      targetId: String(existing[0].id),
      canonicalTimelineEventId: canonical.timeline.id,
      canonicalAuditEventId: canonical.audit.id,
    };
  }

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
    promotedMedication,
    JSON.stringify([{
      name: promotedMedication,
      source: 'C-CDA_Medication',
      source_text: promotedSourceText,
      source_code: promotedSourceCode,
      source_code_system: promotedCodeSystem,
      source_status: sourceStatus,
      verification_status: 'asserted_unverified',
      effective_start: med.effectiveStart || null,
      effective_end: med.effectiveEnd || null,
      timing_unresolved: status === 'active' && !med.effectiveEnd,
      import_receipt: importReceipt,
    }]),
    promotedSourceText || `Imported by ${importedBy}`,
    prescriptionNumber,
    status,
  );
  const canonical = await recordImportedMedicationCanonicalPair({
    db,
    tenantId,
    patientUid,
    importedBy,
    authority,
    targetId: inserted[0].id,
    medication: promotedMedication,
    status,
    sourceStatus,
    importReceipt,
    importIdentity,
  });
  return {
    status: 'imported',
    targetTable: 'e_prescriptions',
    targetId: String(inserted[0].id),
    canonicalTimelineEventId: canonical.timeline.id,
    canonicalAuditEventId: canonical.audit.id,
  };
}

async function importAllergyFromCCDA(allergy, patientUid) {
  if (!patientUid || !allergy.displayName) return { status: 'skipped' };
  return clinicalAssertionPromotionRequired(
    'C-CDA_Allergy',
    allergy.id || allergy.code || null,
  );
}

export default { importFhirBundle, importCCDA };
