import crypto from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { encryptField, getKeyId } from '../../utils/fieldEncryption.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { resolveMergedPatientUidSet } from '../clinical/mergedPatientReadUnion.js';
import { extractSqlState } from '../security/schemaMissingGuard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IMPORT_RECEIPT_CONTRACT_VERSION = 1;
const SOURCE_AUTHOR_IDENTITY_AUTHORITY_GATE =
  'CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER';

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value ?? null;
}

export function clinicalImportSha256(value) {
  const material = typeof value === 'string'
    ? value
    : JSON.stringify(stableValue(value));
  return crypto.createHash('sha256').update(material).digest('hex');
}

export async function lockClinicalImportAuthorityGrantTx(tx, {
  tenantId,
  authorityGrantId,
  patientUid,
  sourceFacilityId,
  actorUid,
  sourceSystem,
  documentFormat,
}, {
  unavailableCode = 'IMPORT_AUTHORITY_GRANT_UNAVAILABLE',
  unavailableMessage = 'Clinical import authority grant is unavailable or outside the exact requested scope',
} = {}) {
  let rows;
  try {
    rows = await tx.$queryRawUnsafe(
      `SELECT public.lock_clinical_import_authority_760(
         $1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, $6::text, $7::text
       ) AS owner_evidence_sha256`,
      tenantId,
      authorityGrantId,
      patientUid,
      sourceFacilityId,
      actorUid,
      sourceSystem,
      documentFormat,
    );
  } catch (error) {
    if (extractSqlState(error) !== '42501') throw error;
    throw AppError.forbidden(unavailableMessage, unavailableCode);
  }
  const ownerEvidenceSha256 = String(
    rows[0]?.owner_evidence_sha256 || '',
  ).trim().toLowerCase();
  if (!SHA256_RE.test(ownerEvidenceSha256)) {
    throw AppError.forbidden(unavailableMessage, unavailableCode);
  }
  return ownerEvidenceSha256;
}

function requiredText(value, field, maxLength = 255) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw AppError.badRequest(`${field} is required`, 'IMPORT_RECEIPT_AUTHORITY_REQUIRED');
  }
  return normalized;
}

function exactReceiptMismatch(message, details = {}) {
  throw AppError.conflict(message, 'IMPORT_RECEIPT_REPLAY_MISMATCH', details);
}

function bindClinicalImportAccessDecision(expected, ownerEvidenceSha256) {
  if (!expected.patientIdentityBindingSha256) return;
  const supplied = expected.accessDecisionEvidence || {};
  const patientAccessEvidence = supplied.contract_version === 'clinical-import-access-decision-v1'
    ? (supplied.patient_access || supplied)
    : supplied;
  expected.accessDecisionEvidence = stableValue({
    contract_version: 'clinical-import-access-decision-v1',
    decision: 'allow',
    authority_grant_id: expected.authorityGrantId,
    patient_uid: expected.patientUid,
    actor_uid: expected.actorUid,
    source_facility_id: expected.sourceFacilityId,
    source_system: expected.sourceSystem,
    document_format: expected.documentFormat,
    patient_identity_binding_sha256: expected.patientIdentityBindingSha256,
    owner_evidence_sha256: ownerEvidenceSha256,
    patient_access: patientAccessEvidence,
  });
  expected.accessDecisionEvidenceSha256 = clinicalImportSha256(expected.accessDecisionEvidence);
}

export function buildClinicalImportDocumentAuthority({
  tenantId,
  patientUid,
  patientId,
  documentFormat,
  authority,
  resourceManifest,
}) {
  const normalizedTenantId = String(tenantId || '').trim().toLowerCase();
  const normalizedPatientUid = String(patientUid || '').trim().toLowerCase();
  const normalizedPatientId = Number(patientId ?? authority?.patientId);
  const normalizedFacilityId = Number(authority?.sourceFacilityId);
  const actorUid = String(authority?.actorUid || '').trim().toLowerCase();
  const actorRole = String(authority?.actorRole || '').trim().toUpperCase();
  const sourcePayloadSha256 = String(authority?.sourcePayloadSha256 || '').trim().toLowerCase();
  const sourceSignatureSha256 = String(authority?.sourceSignatureSha256 || '').trim().toLowerCase();
  const sourceSystem = requiredText(authority?.sourceSystem, 'sourceSystem');
  const sourceDocumentId = requiredText(authority?.sourceDocumentId, 'sourceDocumentId');
  const idempotencyKey = requiredText(authority?.idempotencyKey, 'idempotencyKey');
  const ingestionMode = String(authority?.ingestionMode || '').trim().toLowerCase();
  const normalizedFormat = String(documentFormat || '').trim().toLowerCase();
  const authorityGrantId = String(authority?.authorityGrantId || '').trim().toLowerCase();
  const rawDocument = Buffer.isBuffer(authority?.rawDocument)
    ? Buffer.from(authority.rawDocument)
    : null;
  const rawContentType = String(authority?.rawContentType || '').trim().toLowerCase();
  const accessDecisionEvidence = authority?.accessDecisionEvidence;
  const patientAccessEvidence = accessDecisionEvidence?.contract_version
      === 'clinical-import-access-decision-v1'
    ? (accessDecisionEvidence.patient_access || accessDecisionEvidence)
    : accessDecisionEvidence;
  const accessDecision = String(
    patientAccessEvidence?.access_decision || patientAccessEvidence?.decision || '',
  ).trim().toLowerCase();
  const sourceAuthorEvidence = authority?.sourceAuthorEvidence;
  const hasPatientIdentityBinding = authority?.patientIdentifierIds != null
    || authority?.patientIdentityBindingSha256 != null;
  const patientIdentifierIds = Array.isArray(authority?.patientIdentifierIds)
    ? [...new Set(authority.patientIdentifierIds.map(Number))].sort((left, right) => left - right)
    : [];

  if (!UUID_RE.test(normalizedTenantId)
    || !UUID_RE.test(normalizedPatientUid)
    || !UUID_RE.test(actorUid)
    || !Number.isInteger(normalizedPatientId) || normalizedPatientId <= 0
    || !Number.isInteger(normalizedFacilityId) || normalizedFacilityId <= 0
    || actorRole !== 'MEDICAL_RECORDS'
    || !UUID_RE.test(authorityGrantId)
    || ingestionMode !== 'manual_medical_records'
    || !['fhir_bundle', 'ccda'].includes(normalizedFormat)
    || !SHA256_RE.test(sourcePayloadSha256)
    || !SHA256_RE.test(sourceSignatureSha256)
    || !Array.isArray(resourceManifest)
    || resourceManifest.length === 0) {
    throw AppError.forbidden(
      'Manual clinical import receipt authority is incomplete',
      'IMPORT_RECEIPT_AUTHORITY_REQUIRED',
    );
  }
  if (!rawDocument?.length
    || rawDocument.length > 5 * 1024 * 1024
    || !rawContentType
    || !accessDecisionEvidence
    || typeof accessDecisionEvidence !== 'object'
    || Array.isArray(accessDecisionEvidence)
    || !['allow', 'break_glass'].includes(accessDecision)
    || patientAccessEvidence.policy_code !== 'patient.record.upload'
    || !patientAccessEvidence.policy_version
    || !SHA256_RE.test(String(patientAccessEvidence.policy_hash || '').toLowerCase())
    || !sourceAuthorEvidence
    || typeof sourceAuthorEvidence !== 'object'
    || Array.isArray(sourceAuthorEvidence)
    || !Array.isArray(sourceAuthorEvidence.authors)) {
    throw AppError.forbidden(
      'Clinical import custody, access-decision, or source-author evidence is incomplete',
      'IMPORT_RECEIPT_PROVENANCE_REQUIRED',
    );
  }
  const allowedRawContentTypes = normalizedFormat === 'fhir_bundle'
    ? new Set(['application/json', 'application/fhir+json'])
    : new Set(['application/json', 'application/xml', 'text/xml', 'application/hl7-v3+xml']);
  if (!allowedRawContentTypes.has(rawContentType)) {
    throw new AppError(
      'Clinical import Content-Type is not supported',
      415,
      'IMPORT_CONTENT_TYPE_UNSUPPORTED',
    );
  }
  const hasBoundSourceAuthor = sourceAuthorEvidence.authors.some((author) => (
    author
      && typeof author === 'object'
      && (String(author.reference || '').trim()
        || String(author.identifier_value || '').trim())
  ));
  if (!hasBoundSourceAuthor) {
    throw AppError.conflict(
      'Clinical import source author lacks a stable reference or identifier',
      'IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED',
      {
        status: 'HELD_EXTERNAL_AUTHORITY',
        required_authority: SOURCE_AUTHOR_IDENTITY_AUTHORITY_GATE,
      },
    );
  }

  const sourceIdentitySha256 = clinicalImportSha256({
    contract_version: IMPORT_RECEIPT_CONTRACT_VERSION,
    tenant_id: normalizedTenantId,
    source_system: sourceSystem,
    source_document_id: sourceDocumentId,
    document_format: normalizedFormat,
  });
  const normalizedManifest = resourceManifest.map((resource, index) => ({
    source_resource_type: requiredText(resource.source_resource_type, 'source_resource_type', 120),
    source_resource_id: resource.source_resource_id == null
      ? null
      : requiredText(resource.source_resource_id, 'source_resource_id', 255),
    source_resource_index: Number.isInteger(resource.source_resource_index)
      ? resource.source_resource_index
      : index,
    source_identity_sha256: String(resource.source_identity_sha256 || '').toLowerCase(),
    payload_sha256: String(resource.payload_sha256 || '').toLowerCase(),
  }));
  const sourceIndexes = normalizedManifest.map((resource) => resource.source_resource_index);
  if (normalizedManifest.some((resource) => (
    !SHA256_RE.test(resource.source_identity_sha256)
      || !SHA256_RE.test(resource.payload_sha256)
      || resource.source_resource_index < 0
  ))
    || new Set(sourceIndexes).size !== normalizedManifest.length
    || sourceIndexes.some((sourceIndex, index) => sourceIndex !== index)) {
    throw AppError.badRequest(
      'Clinical import resource manifest is incomplete',
      'IMPORT_RESOURCE_MANIFEST_INVALID',
    );
  }
  const rawCorrectionItemId = authority?.correctionItemId;
  const rawCorrectionManifestIndex = authority?.correctionManifestIndex;
  const hasCorrectionItem = rawCorrectionItemId != null
    && String(rawCorrectionItemId).trim() !== '';
  const hasCorrectionManifestIndex = rawCorrectionManifestIndex != null
    && String(rawCorrectionManifestIndex).trim() !== '';
  const correctionItemId = hasCorrectionItem
    ? String(rawCorrectionItemId).trim().toLowerCase()
    : null;
  const correctionManifestIndex = hasCorrectionManifestIndex
    ? Number(rawCorrectionManifestIndex)
    : null;
  if (hasCorrectionItem !== hasCorrectionManifestIndex
    || (hasCorrectionItem && !UUID_RE.test(correctionItemId))
    || (hasCorrectionManifestIndex
      && (!Number.isInteger(correctionManifestIndex)
        || correctionManifestIndex < 0
        || correctionManifestIndex >= normalizedManifest.length))) {
    throw AppError.badRequest(
      'Clinical import correction binding is incomplete or outside the resource manifest',
      'IMPORT_CORRECTION_BINDING_INVALID',
    );
  }
  const rawPayloadCiphertext = encryptField(rawDocument.toString('base64'), {
    tenantId: normalizedTenantId,
  });
  const rawPayloadSha256 = crypto.createHash('sha256').update(rawDocument).digest('hex');
  const normalizedAccessDecisionEvidence = stableValue(accessDecisionEvidence);
  const normalizedSourceAuthorEvidence = stableValue(sourceAuthorEvidence);
  const patientIdentityBindingSha256 = hasPatientIdentityBinding
    ? clinicalImportSha256(
      `clinical-import-patient-identity-v1|${normalizedTenantId}|${normalizedPatientId}`
      + `|${normalizedPatientUid}|${patientIdentifierIds.join(',')}`,
    )
    : null;
  if (hasPatientIdentityBinding
    && (!Array.isArray(authority?.patientIdentifierIds)
      || patientIdentifierIds.some((identifierId) => !Number.isInteger(identifierId) || identifierId <= 0)
      || !SHA256_RE.test(String(authority?.patientIdentityBindingSha256 || '').toLowerCase())
      || String(authority.patientIdentityBindingSha256).toLowerCase() !== patientIdentityBindingSha256)) {
    throw AppError.conflict(
      'Clinical import patient identity binding is invalid',
      'IMPORT_PATIENT_IDENTITY_BINDING_INVALID',
    );
  }

  return {
    contractVersion: IMPORT_RECEIPT_CONTRACT_VERSION,
    tenantId: normalizedTenantId,
    patientUid: normalizedPatientUid,
    patientId: normalizedPatientId,
    sourceFacilityId: normalizedFacilityId,
    authorityGrantId,
    actorUid,
    actorRole,
    ingestionMode,
    documentFormat: normalizedFormat,
    sourceSystem,
    sourceDocumentId,
    sourceSignatureSha256,
    sourcePayloadSha256,
    rawArtifactId: crypto.randomUUID(),
    rawPayloadCiphertext,
    rawPayloadSha256,
    rawPayloadBytes: rawDocument.length,
    rawContentType: rawContentType.slice(0, 160),
    rawEncryptionKeyId: getKeyId(rawPayloadCiphertext),
    rawCanonicalizationVersion: normalizedFormat === 'fhir_bundle'
      ? 'exact-http-body+fhir-canonical-json-v1'
      : (rawContentType.includes('json')
        ? 'exact-http-body+ccda-json-envelope+xml-string-v1'
        : 'exact-http-body+ccda-xml-v1'),
    signatureVerificationStatus: 'asserted_unverified',
    accessDecisionEvidence: normalizedAccessDecisionEvidence,
    accessDecisionEvidenceSha256: clinicalImportSha256(normalizedAccessDecisionEvidence),
    sourceAuthorEvidence: normalizedSourceAuthorEvidence,
    sourceAuthorEvidenceSha256: clinicalImportSha256(normalizedSourceAuthorEvidence),
    patientIdentifierIds: hasPatientIdentityBinding ? patientIdentifierIds : null,
    patientIdentityBindingSha256,
    sourceIdentitySha256,
    idempotencyKeySha256: clinicalImportSha256(idempotencyKey),
    resourceManifest: normalizedManifest,
    resourceManifestSha256: clinicalImportSha256(normalizedManifest),
    correctionItemId,
    correctionManifestIndex,
    correctionOriginalResourceReceiptId: null,
    correctionRetryEventId: null,
    requestId: authority?.requestId ? String(authority.requestId).slice(0, 120) : null,
  };
}

function assertStoredReceiptMatches(receipt, expected, resources, allowedPatientUids) {
  const fields = {
    tenant_id: expected.tenantId,
    authority_grant_id: expected.authorityGrantId,
    source_facility_id: expected.sourceFacilityId,
    actor_uid: expected.actorUid,
    actor_role: expected.actorRole,
    ingestion_mode: expected.ingestionMode,
    document_format: expected.documentFormat,
    source_system: expected.sourceSystem,
    source_document_id: expected.sourceDocumentId,
    asserted_source_signature_sha256: expected.sourceSignatureSha256,
    source_payload_sha256: expected.sourcePayloadSha256,
    source_identity_sha256: expected.sourceIdentitySha256,
    idempotency_key_sha256: expected.idempotencyKeySha256,
    resource_manifest_sha256: expected.resourceManifestSha256,
    raw_payload_sha256: expected.rawPayloadSha256,
    raw_payload_bytes: expected.rawPayloadBytes,
    raw_content_type: expected.rawContentType,
    raw_canonicalization_version: expected.rawCanonicalizationVersion,
    raw_canonical_payload_sha256: expected.sourcePayloadSha256,
    raw_asserted_source_signature_sha256: expected.sourceSignatureSha256,
    raw_signature_verification_status: expected.signatureVerificationStatus,
    contract_version: expected.contractVersion,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (String(receipt[field] ?? '') !== String(value ?? '')) {
      exactReceiptMismatch('Clinical import source or idempotency identity was reused with different authority', {
        mismatch_field: field,
        receipt_id: receipt.id,
      });
    }
  }
  if (!allowedPatientUids.has(String(receipt.patient_uid).toLowerCase())) {
    exactReceiptMismatch('Clinical import source belongs to a different patient identity', {
      receipt_id: receipt.id,
    });
  }
  if (clinicalImportSha256(receipt.source_author_evidence) !== expected.sourceAuthorEvidenceSha256
    || String(receipt.raw_source_author_evidence_sha256 || '')
      !== String(receipt.source_author_evidence_sha256 || '')) {
    exactReceiptMismatch('Clinical import source-author evidence changed on replay', {
      receipt_id: receipt.id,
    });
  }
  const storedManifest = Array.isArray(receipt.resource_manifest) ? receipt.resource_manifest : [];
  if (clinicalImportSha256(storedManifest) !== expected.resourceManifestSha256) {
    exactReceiptMismatch('Clinical import resource manifest changed on replay', {
      receipt_id: receipt.id,
    });
  }
  if (resources.length !== expected.resourceManifest.length) {
    exactReceiptMismatch('Clinical import resource receipt set is incomplete', {
      receipt_id: receipt.id,
    });
  }
  for (let index = 0; index < resources.length; index += 1) {
    const stored = resources[index];
    const manifest = expected.resourceManifest[index];
    if (String(stored.source_resource_type) !== manifest.source_resource_type
      || String(stored.source_resource_id ?? '') !== String(manifest.source_resource_id ?? '')
      || Number(stored.source_resource_index) !== manifest.source_resource_index
      || String(stored.source_identity_sha256) !== manifest.source_identity_sha256
      || String(stored.payload_sha256) !== manifest.payload_sha256) {
      exactReceiptMismatch('Clinical import resource receipt changed on replay', {
        receipt_id: receipt.id,
        source_resource_index: manifest.source_resource_index,
      });
    }
    const isCorrectionResource = expected.correctionItemId != null
      && manifest.source_resource_index === expected.correctionManifestIndex;
    if (String(stored.correction_reconciliation_item_id || '')
        !== String(isCorrectionResource ? expected.correctionItemId : '')
      || (isCorrectionResource
        && (!UUID_RE.test(String(stored.correction_original_resource_receipt_id || ''))
          || !UUID_RE.test(String(stored.correction_retry_event_id || ''))))
      || (!isCorrectionResource
        && (stored.correction_original_resource_receipt_id != null
          || stored.correction_retry_event_id != null))) {
      exactReceiptMismatch('Clinical import correction binding changed on replay', {
        receipt_id: receipt.id,
        source_resource_index: manifest.source_resource_index,
      });
    }
  }
}

async function lockClinicalImportCorrectionTx(tx, expected) {
  if (expected.correctionItemId == null) return;
  const manifest = expected.resourceManifest[expected.correctionManifestIndex];
  const rows = await tx.$queryRawUnsafe(
    `WITH locked_item AS (
       SELECT item.*
         FROM clinical_import_reconciliation_items AS item
        WHERE item.tenant_id=$1::uuid
          AND item.id=$2::uuid
        FOR UPDATE
     )
     SELECT item.id AS reconciliation_item_id,
            item.resource_receipt_id AS original_resource_receipt_id,
            item.patient_uid AS historical_patient_uid,
            item.facility_id,
            original.source_resource_type AS original_resource_type,
            original.source_resource_id AS original_resource_id,
            original.source_resource_index AS original_resource_index,
            source_document.source_system,
            source_document.document_format,
            latest.id AS retry_event_id,
            latest.event_type AS latest_event_type,
            latest.actor_uid AS retry_actor_uid,
            latest.actor_role AS retry_actor_role,
            latest.evidence #>> '{request,authority_grant_id}' AS retry_authority_grant_id,
            public.clinical_import_active_patient_survivor_760(
              item.tenant_id,
              item.patient_uid
            ) AS active_patient_uid
       FROM locked_item AS item
       JOIN clinical_import_resource_receipts AS original
         ON original.tenant_id=item.tenant_id
        AND original.id=item.resource_receipt_id
        AND original.document_receipt_id=item.document_receipt_id
        AND original.patient_uid=item.patient_uid
        AND original.outcome='failed'
       JOIN clinical_import_document_receipts AS source_document
         ON source_document.tenant_id=item.tenant_id
        AND source_document.id=item.document_receipt_id
        AND source_document.patient_uid=item.patient_uid
       JOIN LATERAL (
         SELECT event.id, event.event_type, event.actor_uid, event.actor_role,
                event.evidence
           FROM clinical_import_reconciliation_events AS event
          WHERE event.tenant_id=item.tenant_id
            AND event.reconciliation_item_id=item.id
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
          FOR UPDATE
       ) AS latest ON TRUE`,
    expected.tenantId,
    expected.correctionItemId,
  );
  const binding = rows[0];
  const supplementalResourceMatch = binding
    && String(binding.original_resource_type) === manifest.source_resource_type
    && (binding.original_resource_id == null
      ? Number(binding.original_resource_index) === manifest.source_resource_index
      : String(binding.original_resource_id) === String(manifest.source_resource_id || ''));
  if (!binding
    || binding.latest_event_type !== 'RETRY_REQUESTED'
    || String(binding.active_patient_uid || '').toLowerCase() !== expected.patientUid
    || Number(binding.facility_id) !== expected.sourceFacilityId
    || String(binding.source_system) !== expected.sourceSystem
    || String(binding.document_format) !== expected.documentFormat
    || String(binding.retry_actor_uid).toLowerCase() !== expected.actorUid
    || String(binding.retry_actor_role) !== expected.actorRole
    || String(binding.retry_authority_grant_id || '').toLowerCase()
      !== expected.authorityGrantId
    || !supplementalResourceMatch) {
    throw AppError.conflict(
      'Clinical import correction does not bind the current retry request and authority scope',
      'IMPORT_CORRECTION_BINDING_STALE',
    );
  }
  expected.correctionOriginalResourceReceiptId = String(
    binding.original_resource_receipt_id,
  ).toLowerCase();
  expected.correctionRetryEventId = String(binding.retry_event_id).toLowerCase();
}

export async function lockClinicalImportDocumentReceiptTx(tx, expected) {
  const authorityRows = await tx.$queryRawUnsafe(
    `SELECT patient.id AS patient_id, patient.uid AS patient_uid,
            actor.uid AS actor_uid, actor.role AS actor_role,
            facility.id AS facility_id
       FROM users AS patient
       JOIN users AS actor
         ON actor.tenant_id=patient.tenant_id
        AND actor.uid=$4::uuid
        AND actor.role='MEDICAL_RECORDS'
        AND actor.is_active=TRUE
        AND actor.status='active'
        AND actor.is_deleted=FALSE
        AND actor.merged_into_uid IS NULL
       JOIN facilities AS facility
         ON facility.tenant_id=patient.tenant_id
        AND facility.id=$5::int
        AND facility.status='active'
      WHERE patient.tenant_id=$1::uuid
        AND patient.id=$2::int
        AND patient.uid=$3::uuid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      LIMIT 1`,
    expected.tenantId,
    expected.patientId,
    expected.patientUid,
    expected.actorUid,
    expected.sourceFacilityId,
  );
  if (!authorityRows.length) {
    throw AppError.forbidden(
      'Clinical import patient, actor, or source facility authority is unavailable',
      'IMPORT_RECEIPT_AUTHORITY_UNAVAILABLE',
    );
  }
  const allowedPatientUids = new Set(await resolveMergedPatientUidSet(tx, {
    tenantId: expected.tenantId,
    patientUid: expected.patientUid,
  }));
  const lockIdentities = [
    `source:${expected.sourceIdentitySha256}`,
    `idempotency:${expected.idempotencyKeySha256}`,
    ...(expected.correctionItemId == null
      ? []
      : [`correction:${expected.correctionItemId}`]),
  ].sort();
  for (const lockIdentity of lockIdentities) {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('vh:clinical_import:' || $1::uuid::text || ':' || $2, 755)
       )::text AS lock_acquired`,
      expected.tenantId,
      lockIdentity,
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT document.id, document.tenant_id, document.patient_id, document.patient_uid,
            document.source_facility_id, document.authority_grant_id,
            document.raw_artifact_id, document.patient_identifier_ids,
            document.patient_identity_binding_sha256,
            document.access_decision_evidence,
            document.access_decision_evidence_sha256,
            document.source_author_evidence,
            document.source_author_evidence_sha256,
            document.actor_uid, document.actor_role, document.ingestion_mode,
            document.document_format, document.source_system,
            document.source_document_id,
            document.asserted_source_signature_sha256,
            document.source_payload_sha256, document.source_identity_sha256,
            document.idempotency_key_sha256, document.resource_manifest_sha256,
            document.resource_manifest, document.result, document.status,
            document.request_id, document.canonical_timeline_event_id,
            document.canonical_audit_event_id, document.contract_version,
            document.created_at, raw.raw_payload_sha256,
            raw.raw_payload_bytes, raw.raw_content_type,
            raw.canonicalization_version AS raw_canonicalization_version,
            raw.canonical_payload_sha256 AS raw_canonical_payload_sha256,
            raw.asserted_source_signature_sha256
              AS raw_asserted_source_signature_sha256,
            raw.signature_verification_status
              AS raw_signature_verification_status,
            raw.source_author_evidence_sha256 AS raw_source_author_evidence_sha256
       FROM clinical_import_document_receipts AS document
       JOIN clinical_import_raw_artifacts AS raw
         ON raw.tenant_id=document.tenant_id
        AND raw.id=document.raw_artifact_id
      WHERE document.tenant_id=$1::uuid
        AND (
          (
            document.source_system=$2
            AND document.source_document_id=$3
            AND document.document_format=$4
          )
          OR document.idempotency_key_sha256=$5
        )
      ORDER BY document.created_at, document.id`,
    expected.tenantId,
    expected.sourceSystem,
    expected.sourceDocumentId,
    expected.documentFormat,
    expected.idempotencyKeySha256,
  );
  if (rows.length > 1) {
    exactReceiptMismatch('Clinical import source and idempotency identities belong to different receipts');
  }
  if (!rows.length) {
    const ownerEvidenceSha256 = await lockClinicalImportAuthorityGrantTx(tx, expected);
    bindClinicalImportAccessDecision(expected, ownerEvidenceSha256);
    await lockClinicalImportCorrectionTx(tx, expected);
    return null;
  }
  const receipt = rows[0];
  const resources = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, document_receipt_id, patient_uid,
            source_resource_type, source_resource_id, source_resource_index,
            source_identity_sha256, payload_sha256, outcome,
            target_table, target_id, canonical_timeline_event_id,
            canonical_audit_event_id, evidence,
            correction_reconciliation_item_id,
            correction_original_resource_receipt_id,
            correction_retry_event_id, contract_version, created_at
       FROM clinical_import_resource_receipts
      WHERE tenant_id=$1::uuid
        AND document_receipt_id=$2::uuid
      ORDER BY source_resource_index, id`,
    expected.tenantId,
    receipt.id,
  );
  assertStoredReceiptMatches(receipt, expected, resources, allowedPatientUids);
  return {
    receipt,
    resources,
    result: {
      ...(receipt.result && typeof receipt.result === 'object' ? receipt.result : {}),
      receipt_id: receipt.id,
      replayed: true,
    },
  };
}

function normalizedResourceOutcome(manifest, outcome = {}) {
  const status = String(outcome.status || 'skipped').toLowerCase();
  if (!['imported', 'deduplicated', 'skipped', 'failed'].includes(status)) {
    throw AppError.badRequest('Clinical import resource outcome is invalid', 'IMPORT_RESOURCE_OUTCOME_INVALID');
  }
  const targetTable = outcome.targetTable ? String(outcome.targetTable).slice(0, 120) : null;
  const targetId = outcome.targetId == null ? null : String(outcome.targetId).slice(0, 160);
  if (['imported', 'deduplicated'].includes(status) && (!targetTable || !targetId)) {
    throw AppError.conflict(
      'Imported and deduplicated resources require an immutable target identity',
      'IMPORT_RESOURCE_TARGET_REQUIRED',
    );
  }
  if (['skipped', 'failed'].includes(status) && (targetTable || targetId)) {
    throw AppError.conflict(
      'Skipped and failed resources cannot claim a persisted target',
      'IMPORT_RESOURCE_TARGET_FORBIDDEN',
    );
  }
  return {
    ...manifest,
    id: crypto.randomUUID(),
    status,
    targetTable,
    targetId,
    canonicalTimelineEventId: outcome.canonicalTimelineEventId || null,
    canonicalAuditEventId: outcome.canonicalAuditEventId || null,
    evidence: outcome.evidence && typeof outcome.evidence === 'object' ? outcome.evidence : {},
  };
}

export async function persistClinicalImportDocumentReceiptTx(tx, expected, {
  result,
  resourceOutcomes,
}) {
  if (!Array.isArray(resourceOutcomes)
    || resourceOutcomes.length !== expected.resourceManifest.length) {
    throw AppError.conflict(
      'Clinical import did not produce one receipt outcome per source resource',
      'IMPORT_RESOURCE_RECEIPT_INCOMPLETE',
    );
  }
  if (!Array.isArray(expected.patientIdentifierIds)
    || !SHA256_RE.test(String(expected.patientIdentityBindingSha256 || ''))
    || expected.accessDecisionEvidence?.contract_version
      !== 'clinical-import-access-decision-v1') {
    throw AppError.conflict(
      'Clinical import patient identity and access authority were not finalized',
      'IMPORT_PATIENT_IDENTITY_BINDING_REQUIRED',
    );
  }
  const receiptId = crypto.randomUUID();
  const resources = expected.resourceManifest.map((manifest, index) => (
    normalizedResourceOutcome(manifest, resourceOutcomes[index])
  ));
  if (expected.correctionItemId != null) {
    const correctionResource = resources[expected.correctionManifestIndex];
    if (!correctionResource
      || !['imported', 'deduplicated'].includes(correctionResource.status)
      || !UUID_RE.test(String(expected.correctionOriginalResourceReceiptId || ''))
      || !UUID_RE.test(String(expected.correctionRetryEventId || ''))) {
      throw AppError.conflict(
        'The declared correction resource did not produce a committed replacement receipt',
        'IMPORT_CORRECTION_REPLACEMENT_REQUIRED',
      );
    }
    correctionResource.correctionReconciliationItemId = expected.correctionItemId;
    correctionResource.correctionOriginalResourceReceiptId =
      expected.correctionOriginalResourceReceiptId;
    correctionResource.correctionRetryEventId = expected.correctionRetryEventId;
  }
  const reconciliations = resources
    .filter((resource) => resource.status === 'failed')
    .map((resource) => {
      const itemId = crypto.randomUUID();
      const openedEventId = crypto.randomUUID();
      const reason = String(
        resource.evidence?.error
          || `${resource.source_resource_type} import failed and requires reconciliation`,
      ).trim().slice(0, 1000);
      const idempotencyKeySha256 = clinicalImportSha256(
        `clinical-import-reconciliation-v1:${receiptId}:${resource.id}`,
      );
      return {
        itemId,
        openedEventId,
        resource,
        reason: reason.length >= 10 ? reason : `Import failed: ${reason || 'unknown error'}`,
        idempotencyKeySha256,
      };
    });
  const receiptResult = {
    ...result,
    resource_receipts: resources.map((resource) => ({
      id: resource.id,
      source_resource_type: resource.source_resource_type,
      source_resource_id: resource.source_resource_id,
      source_resource_index: resource.source_resource_index,
      outcome: resource.status,
      target_table: resource.targetTable,
      target_id: resource.targetId,
    })),
    reconciliation_items: reconciliations.map((reconciliation) => ({
      id: reconciliation.itemId,
      resource_receipt_id: reconciliation.resource.id,
      opened_event_id: reconciliation.openedEventId,
      status: 'OPENED',
    })),
    receipt_id: receiptId,
    replayed: false,
  };
  const evidenceHashes = await tx.$queryRawUnsafe(
    `SELECT encode(public.digest($1::jsonb::text, 'sha256'), 'hex')
              AS access_decision_evidence_sha256,
            encode(public.digest($2::jsonb::text, 'sha256'), 'hex')
              AS source_author_evidence_sha256`,
    JSON.stringify(expected.accessDecisionEvidence),
    JSON.stringify(expected.sourceAuthorEvidence),
  );
  const accessDecisionEvidenceSha256 = String(
    evidenceHashes[0]?.access_decision_evidence_sha256 || '',
  );
  const sourceAuthorEvidenceSha256 = String(
    evidenceHashes[0]?.source_author_evidence_sha256 || '',
  );
  if (!SHA256_RE.test(accessDecisionEvidenceSha256)
    || !SHA256_RE.test(sourceAuthorEvidenceSha256)) {
    throw AppError.internal(
      'Clinical import provenance hashes could not be derived',
      'IMPORT_PROVENANCE_HASH_UNAVAILABLE',
    );
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO clinical_import_raw_artifacts
       (id, tenant_id, authority_grant_id, patient_uid, source_facility_id,
        actor_uid, actor_role, source_system, source_document_id, document_format,
        raw_payload_sha256, raw_payload_bytes, raw_content_type,
        raw_payload_ciphertext, encryption_key_id, canonicalization_version,
        canonical_payload_sha256, asserted_source_signature_sha256,
        signature_verification_status, source_author_evidence, recorded_by,
        contract_version)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int,
        $6::uuid, $7, $8, $9, $10, $11, $12::bigint, $13,
        $14, $15, $16, $17, $18, $19, $20::jsonb, $21::uuid, $22::int)`,
    expected.rawArtifactId,
    expected.tenantId,
    expected.authorityGrantId,
    expected.patientUid,
    expected.sourceFacilityId,
    expected.actorUid,
    expected.actorRole,
    expected.sourceSystem,
    expected.sourceDocumentId,
    expected.documentFormat,
    expected.rawPayloadSha256,
    expected.rawPayloadBytes,
    expected.rawContentType,
    expected.rawPayloadCiphertext,
    expected.rawEncryptionKeyId,
    expected.rawCanonicalizationVersion,
    expected.sourcePayloadSha256,
    expected.sourceSignatureSha256,
    expected.signatureVerificationStatus,
    JSON.stringify(expected.sourceAuthorEvidence),
    expected.actorUid,
    expected.contractVersion,
  );
  const receiptPayload = {
    contract_version: expected.contractVersion,
    receipt_id: receiptId,
    ingestion_mode: expected.ingestionMode,
    document_format: expected.documentFormat,
    source_system: expected.sourceSystem,
    source_document_id: expected.sourceDocumentId,
    source_facility_id: expected.sourceFacilityId,
    authority_grant_id: expected.authorityGrantId,
    raw_artifact_id: expected.rawArtifactId,
    raw_payload_sha256: expected.rawPayloadSha256,
    patient_identifier_ids: expected.patientIdentifierIds,
    patient_identity_binding_sha256: expected.patientIdentityBindingSha256,
    access_decision_evidence_sha256: accessDecisionEvidenceSha256,
    source_author_evidence_sha256: sourceAuthorEvidenceSha256,
    asserted_source_signature_sha256: expected.sourceSignatureSha256,
    source_payload_sha256: expected.sourcePayloadSha256,
    source_identity_sha256: expected.sourceIdentitySha256,
    idempotency_key_sha256: expected.idempotencyKeySha256,
    resource_manifest_sha256: expected.resourceManifestSha256,
    result: receiptResult,
  };
  const canonical = await recordCanonicalClinicalEvent({
    tenantId: expected.tenantId,
    patientUid: expected.patientUid,
    eventType: 'clinical_document.imported',
    eventStatus: reconciliations.length ? 'completed_with_errors' : 'completed',
    sourceTable: 'clinical_import_document_receipts',
    sourceId: receiptId,
    resourceType: 'clinical_import_document',
    resourceId: receiptId,
    actorUid: expected.actorUid,
    actorRole: expected.actorRole,
    requestId: expected.requestId,
    summary: `Clinical ${expected.documentFormat} document intake recorded`,
    payload: receiptPayload,
    metadata: receiptPayload,
    afterState: receiptPayload,
    timelineIdempotencyKey: `clinical-import-document:${expected.sourceIdentitySha256}:timeline`,
    auditIdempotencyKey: `clinical-import-document:${expected.sourceIdentitySha256}:audit`,
  }, { db: tx, strict: true });

  await tx.$executeRawUnsafe(
    `INSERT INTO clinical_import_document_receipts
       (id, tenant_id, patient_id, patient_uid, source_facility_id,
        authority_grant_id, raw_artifact_id, patient_identifier_ids,
        patient_identity_binding_sha256, access_decision_evidence,
        source_author_evidence,
        actor_uid, actor_role, ingestion_mode, document_format,
        source_system, source_document_id, asserted_source_signature_sha256,
        source_payload_sha256, source_identity_sha256, idempotency_key_sha256,
        resource_manifest_sha256, resource_manifest, result, status, request_id,
        canonical_timeline_event_id, canonical_audit_event_id, contract_version)
     VALUES
       ($1::uuid, $2::uuid, $3::int, $4::uuid, $5::int,
        $6::uuid, $7::uuid, $8::int[], $9, $10::jsonb, $11::jsonb,
        $12::uuid, $13, $14, $15, $16, $17, $18, $19, $20, $21,
        $22, $23::jsonb, $24::jsonb, $25, $26,
        $27::uuid, $28::uuid, $29::int)`,
    receiptId,
    expected.tenantId,
    expected.patientId,
    expected.patientUid,
    expected.sourceFacilityId,
    expected.authorityGrantId,
    expected.rawArtifactId,
    expected.patientIdentifierIds,
    expected.patientIdentityBindingSha256,
    JSON.stringify(expected.accessDecisionEvidence),
    JSON.stringify(expected.sourceAuthorEvidence),
    expected.actorUid,
    expected.actorRole,
    expected.ingestionMode,
    expected.documentFormat,
    expected.sourceSystem,
    expected.sourceDocumentId,
    expected.sourceSignatureSha256,
    expected.sourcePayloadSha256,
    expected.sourceIdentitySha256,
    expected.idempotencyKeySha256,
    expected.resourceManifestSha256,
    JSON.stringify(expected.resourceManifest),
    JSON.stringify(receiptResult),
    reconciliations.length ? 'completed_with_errors' : 'completed',
    expected.requestId,
    canonical.timeline.id,
    canonical.audit.id,
    expected.contractVersion,
  );

  for (const resource of resources) {
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_import_resource_receipts
         (id, tenant_id, document_receipt_id, patient_uid,
          source_resource_type, source_resource_id, source_resource_index,
          source_identity_sha256, payload_sha256, outcome,
           target_table, target_id, canonical_timeline_event_id,
           canonical_audit_event_id, evidence,
           correction_reconciliation_item_id,
           correction_original_resource_receipt_id,
           correction_retry_event_id, contract_version)
        VALUES
          ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5, $6, $7::int, $8, $9, $10,
           $11, $12, $13::uuid, $14::uuid, $15::jsonb,
           $16::uuid, $17::uuid, $18::uuid, $19::int)`,
      resource.id,
      expected.tenantId,
      receiptId,
      expected.patientUid,
      resource.source_resource_type,
      resource.source_resource_id,
      resource.source_resource_index,
      resource.source_identity_sha256,
      resource.payload_sha256,
      resource.status,
      resource.targetTable,
      resource.targetId,
      resource.canonicalTimelineEventId,
      resource.canonicalAuditEventId,
      JSON.stringify(resource.evidence),
      resource.correctionReconciliationItemId || null,
      resource.correctionOriginalResourceReceiptId || null,
      resource.correctionRetryEventId || null,
      expected.contractVersion,
    );
  }
  for (const reconciliation of reconciliations) {
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_import_reconciliation_items
         (id, tenant_id, resource_receipt_id, document_receipt_id,
          patient_uid, facility_id, owner_actor_uid, owner_actor_role,
          reason, idempotency_key_sha256, contract_version)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5::uuid, $6::int, $7::uuid, $8, $9, $10, $11::int)`,
      reconciliation.itemId,
      expected.tenantId,
      reconciliation.resource.id,
      receiptId,
      expected.patientUid,
      expected.sourceFacilityId,
      expected.actorUid,
      expected.actorRole,
      reconciliation.reason,
      reconciliation.idempotencyKeySha256,
      expected.contractVersion,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_import_reconciliation_events
         (id, tenant_id, reconciliation_item_id, resource_receipt_id,
          document_receipt_id, patient_uid, facility_id, event_type,
          actor_uid, actor_role, reason, predecessor_event_id,
          idempotency_key_sha256, evidence, contract_version)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5::uuid, $6::uuid, $7::int, 'OPENED',
          $8::uuid, $9, $10, NULL, $11, $12::jsonb, $13::int)`,
      reconciliation.openedEventId,
      expected.tenantId,
      reconciliation.itemId,
      reconciliation.resource.id,
      receiptId,
      expected.patientUid,
      expected.sourceFacilityId,
      expected.actorUid,
      expected.actorRole,
      reconciliation.reason,
      reconciliation.idempotencyKeySha256,
      JSON.stringify({
        contract_version: 'clinical-import-reconciliation-opened-v1',
        source_resource_type: reconciliation.resource.source_resource_type,
        source_resource_id: reconciliation.resource.source_resource_id,
        source_resource_index: reconciliation.resource.source_resource_index,
        error: reconciliation.resource.evidence?.error || null,
        error_code: reconciliation.resource.evidence?.error_code || null,
      }),
      expected.contractVersion,
    );
  }
  return receiptResult;
}
