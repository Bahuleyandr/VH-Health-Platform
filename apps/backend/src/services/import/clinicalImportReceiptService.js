import crypto from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IMPORT_RECEIPT_CONTRACT_VERSION = 1;

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

  if (!UUID_RE.test(normalizedTenantId)
    || !UUID_RE.test(normalizedPatientUid)
    || !UUID_RE.test(actorUid)
    || !Number.isInteger(normalizedPatientId) || normalizedPatientId <= 0
    || !Number.isInteger(normalizedFacilityId) || normalizedFacilityId <= 0
    || actorRole !== 'MEDICAL_RECORDS'
    || ingestionMode !== 'manual_medical_records'
    || !['fhir_bundle', 'ccda'].includes(normalizedFormat)
    || !SHA256_RE.test(sourcePayloadSha256)
    || !SHA256_RE.test(sourceSignatureSha256)
    || !Array.isArray(resourceManifest)) {
    throw AppError.forbidden(
      'Manual clinical import receipt authority is incomplete',
      'IMPORT_RECEIPT_AUTHORITY_REQUIRED',
    );
  }

  const sourceIdentitySha256 = clinicalImportSha256({
    contract_version: IMPORT_RECEIPT_CONTRACT_VERSION,
    tenant_id: normalizedTenantId,
    patient_uid: normalizedPatientUid,
    source_facility_id: normalizedFacilityId,
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
  if (normalizedManifest.some((resource) => (
    !SHA256_RE.test(resource.source_identity_sha256)
      || !SHA256_RE.test(resource.payload_sha256)
      || resource.source_resource_index < 0
  ))) {
    throw AppError.badRequest(
      'Clinical import resource manifest is incomplete',
      'IMPORT_RESOURCE_MANIFEST_INVALID',
    );
  }

  return {
    contractVersion: IMPORT_RECEIPT_CONTRACT_VERSION,
    tenantId: normalizedTenantId,
    patientUid: normalizedPatientUid,
    patientId: normalizedPatientId,
    sourceFacilityId: normalizedFacilityId,
    actorUid,
    actorRole,
    ingestionMode,
    documentFormat: normalizedFormat,
    sourceSystem,
    sourceDocumentId,
    sourceSignatureSha256,
    sourcePayloadSha256,
    sourceIdentitySha256,
    idempotencyKeySha256: clinicalImportSha256(idempotencyKey),
    resourceManifest: normalizedManifest,
    resourceManifestSha256: clinicalImportSha256(normalizedManifest),
    requestId: authority?.requestId ? String(authority.requestId).slice(0, 120) : null,
  };
}

function assertStoredReceiptMatches(receipt, expected, resources) {
  const fields = {
    tenant_id: expected.tenantId,
    patient_id: expected.patientId,
    patient_uid: expected.patientUid,
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
  }
}

export async function lockClinicalImportDocumentReceiptTx(tx, expected) {
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('vh:clinical_import:' || $1::uuid::text || ':' || $2, 755)
     )`,
    expected.tenantId,
    expected.sourceIdentitySha256,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM clinical_import_document_receipts
      WHERE tenant_id=$1::uuid
        AND (
          source_identity_sha256=$2
          OR idempotency_key_sha256=$3
        )
      ORDER BY created_at, id
      FOR UPDATE`,
    expected.tenantId,
    expected.sourceIdentitySha256,
    expected.idempotencyKeySha256,
  );
  if (rows.length > 1) {
    exactReceiptMismatch('Clinical import source and idempotency identities belong to different receipts');
  }
  if (!rows.length) return null;
  const receipt = rows[0];
  const resources = await tx.$queryRawUnsafe(
    `SELECT *
       FROM clinical_import_resource_receipts
      WHERE tenant_id=$1::uuid
        AND document_receipt_id=$2::uuid
      ORDER BY source_resource_index, id`,
    expected.tenantId,
    receipt.id,
  );
  assertStoredReceiptMatches(receipt, expected, resources);
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
  return {
    ...manifest,
    id: crypto.randomUUID(),
    status,
    targetTable: outcome.targetTable ? String(outcome.targetTable).slice(0, 120) : null,
    targetId: outcome.targetId == null ? null : String(outcome.targetId).slice(0, 160),
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
  const receiptId = crypto.randomUUID();
  const resources = expected.resourceManifest.map((manifest, index) => (
    normalizedResourceOutcome(manifest, resourceOutcomes[index])
  ));
  const receiptResult = {
    ...result,
    receipt_id: receiptId,
    replayed: false,
  };
  const receiptPayload = {
    contract_version: expected.contractVersion,
    receipt_id: receiptId,
    ingestion_mode: expected.ingestionMode,
    document_format: expected.documentFormat,
    source_system: expected.sourceSystem,
    source_document_id: expected.sourceDocumentId,
    source_facility_id: expected.sourceFacilityId,
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
    eventStatus: result.errors?.length ? 'completed_with_errors' : 'completed',
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
        actor_uid, actor_role, ingestion_mode, document_format,
        source_system, source_document_id, asserted_source_signature_sha256,
        source_payload_sha256, source_identity_sha256, idempotency_key_sha256,
        resource_manifest_sha256, resource_manifest, result, status, request_id,
        canonical_timeline_event_id, canonical_audit_event_id, contract_version)
     VALUES
       ($1::uuid, $2::uuid, $3::int, $4::uuid, $5::int,
        $6::uuid, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17::jsonb, $18::jsonb, $19, $20,
        $21::uuid, $22::uuid, $23::int)`,
    receiptId,
    expected.tenantId,
    expected.patientId,
    expected.patientUid,
    expected.sourceFacilityId,
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
    result.errors?.length ? 'completed_with_errors' : 'completed',
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
          canonical_audit_event_id, evidence, contract_version)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5, $6, $7::int, $8, $9, $10,
          $11, $12, $13::uuid, $14::uuid, $15::jsonb, $16::int)`,
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
      expected.contractVersion,
    );
  }
  return receiptResult;
}

