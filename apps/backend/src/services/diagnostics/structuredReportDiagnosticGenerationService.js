import { randomUUID } from 'node:crypto';

import { isTenantTransactionClient } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { enqueueCriticalResultTask } from '../results/resultsInboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { resolvePathwayTaskOwnerTx } from '../workflow/workflowHumanOwnerService.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import { aggregateItemHashes, sha256ClinicalJson } from './diagnosticClassification.js';

export const STRUCTURED_RESULT_CLASSIFICATIONS = Object.freeze([
  'critical',
  'abnormal',
  'normal',
  'indeterminate',
]);

export const STRUCTURED_ADDENDUM_SIGNIFICANCE = Object.freeze([
  'unchanged',
  'new_finding',
  'worsened',
  'improved',
  'corrected',
]);

const SOURCE_CONFIG = Object.freeze({
  radiology_report: Object.freeze({
    label: 'Radiology',
    initialTable: 'radiology_orders',
    addendumTable: 'radiology_report_addenda',
    episodeType: 'radiology_order',
  }),
  anatomical_pathology_report: Object.freeze({
    label: 'Anatomical pathology',
    initialTable: 'ap_reports',
    addendumTable: 'ap_report_addenda',
    episodeType: 'ap_report',
  }),
});

function requireTx(tx) {
  if (!tx || !isTenantTransactionClient(tx)) {
    throw AppError.internal(
      'Structured diagnostic generation requires a tenant transaction',
      'DIAGNOSTIC_GENERATION_TX_REQUIRED',
    );
  }
  return tx;
}

function requiredText(value, label, max = 255) {
  const text = String(value || '').trim();
  if (!text) {
    throw AppError.badRequest(`${label} is required`, 'DIAGNOSTIC_SOURCE_EVIDENCE_REQUIRED');
  }
  return text.slice(0, max);
}

export function normalizeStructuredResultClassification(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!STRUCTURED_RESULT_CLASSIFICATIONS.includes(normalized)) {
    throw AppError.badRequest(
      `result_classification must be one of: ${STRUCTURED_RESULT_CLASSIFICATIONS.join(', ')}`,
      'DIAGNOSTIC_CLASSIFICATION_REQUIRED',
    );
  }
  return normalized;
}

export function normalizeStructuredClassificationBasis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(
      'classification_basis must be a non-empty structured object',
      'DIAGNOSTIC_CLASSIFICATION_BASIS_REQUIRED',
    );
  }
  const basis = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
  const encoded = JSON.stringify(basis);
  if (Object.keys(basis).length === 0 || Buffer.byteLength(encoded, 'utf8') > 16384) {
    throw AppError.badRequest(
      'classification_basis must be a non-empty structured object no larger than 16 KiB',
      'DIAGNOSTIC_CLASSIFICATION_BASIS_INVALID',
    );
  }
  return Object.freeze(basis);
}

export function normalizeStructuredAddendumSignificance(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!STRUCTURED_ADDENDUM_SIGNIFICANCE.includes(normalized)) {
    throw AppError.badRequest(
      `clinical_significance must be one of: ${STRUCTURED_ADDENDUM_SIGNIFICANCE.join(', ')}`,
      'DIAGNOSTIC_ADDENDUM_SIGNIFICANCE_REQUIRED',
    );
  }
  return normalized;
}

export function normalizeDiagnosticIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'DIAGNOSTIC_IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  return key;
}

function normalizeSourceVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw AppError.conflict(
      'Structured diagnostic generation version is invalid',
      'DIAGNOSTIC_GENERATION_VERSION_INVALID',
    );
  }
  return version;
}

function normalizeSignedAt(value) {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    throw AppError.conflict(
      'Structured diagnostic generation requires signed source evidence',
      'DIAGNOSTIC_SOURCE_VERIFICATION_REQUIRED',
    );
  }
  return date;
}

function normalizeContentHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw AppError.conflict(
      'Structured diagnostic source content hash is invalid',
      'DIAGNOSTIC_SOURCE_HASH_INVALID',
    );
  }
  return hash;
}

async function loadExistingGeneration(tx, tenantId, sourceKind, episodeKey, sourceVersion) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT generation.*,
            COALESCE(
              jsonb_agg(to_jsonb(item) ORDER BY item.source_ordinal)
                FILTER (WHERE item.id IS NOT NULL),
              '[]'::jsonb
            ) AS items
       FROM diagnostic_result_generations AS generation
       LEFT JOIN diagnostic_result_generation_items AS item
         ON item.tenant_id = generation.tenant_id
        AND item.generation_id = generation.id
      WHERE generation.tenant_id = $1::uuid
        AND generation.source_kind = $2::text
        AND generation.source_episode_key = $3::text
        AND generation.source_version = $4::bigint
      GROUP BY generation.id`,
    tenantId,
    sourceKind,
    episodeKey,
    sourceVersion,
  );
  return rows[0] || null;
}

async function createStructuredReportGenerationTx({
  tx,
  tenantId,
  patientUid,
  encounterId = null,
  sourceKind,
  sourceEpisodeKey,
  sourceVersion,
  sourceRowId,
  radiologyOrderId = null,
  radiologyAddendumId = null,
  apReportId = null,
  apAddendumId = null,
  orderingOwnerUid = null,
  signerUid,
  signerRole,
  signedAt,
  resultClassification,
  classificationBasis,
  sourceContentSha256,
  clinicalSignificance = null,
} = {}) {
  const db = requireTx(tx);
  const tid = requireTenantId(tenantId);
  const config = SOURCE_CONFIG[sourceKind];
  if (!config) {
    throw AppError.badRequest('Structured diagnostic source kind is invalid', 'DIAGNOSTIC_SOURCE_INVALID');
  }

  const version = normalizeSourceVersion(sourceVersion);
  const classification = normalizeStructuredResultClassification(resultClassification);
  const basis = normalizeStructuredClassificationBasis(classificationBasis);
  const sourceHash = normalizeContentHash(sourceContentSha256);
  const signed = normalizeSignedAt(signedAt);
  const cleanPatientUid = requiredText(patientUid, 'patient_uid');
  const cleanSignerUid = requiredText(signerUid, 'signer_uid');
  const cleanSignerRole = requiredText(signerRole, 'signer_role', 80);
  const episodeKey = requiredText(sourceEpisodeKey, 'source_episode_key', 160);
  const rowId = requiredText(sourceRowId, 'source_row_id');
  const significance = version === 1
    ? null
    : normalizeStructuredAddendumSignificance(clinicalSignificance);
  const sourceTable = version === 1 ? config.initialTable : config.addendumTable;
  const classificationBasisSha256 = sha256ClinicalJson(basis);
  const itemValueSnapshot = {
    source_content_sha256: sourceHash,
    classification_basis_sha256: classificationBasisSha256,
    clinical_significance: significance,
  };
  const itemSnapshot = {
    source_table: sourceTable,
    source_row_id: rowId,
    source_version: String(version),
    source_ordinal: 1,
    item_code: null,
    item_name: `${config.label} signed report`,
    value_snapshot: itemValueSnapshot,
    normalized_flag: null,
    source_critical: classification === 'critical',
    classification,
  };
  const itemSnapshotSha256 = sha256ClinicalJson(itemSnapshot);
  const snapshotSha256 = aggregateItemHashes([itemSnapshotSha256]);

  const existing = await loadExistingGeneration(db, tid, sourceKind, episodeKey, version);
  if (existing) {
    if (
      String(existing.snapshot_sha256) !== snapshotSha256
      || Number(existing.item_count) !== 1
      || existing.classification !== classification
      || String(existing.signer_uid) !== cleanSignerUid
    ) {
      throw AppError.conflict(
        'Diagnostic generation identity was reused with different content',
        'DIAGNOSTIC_GENERATION_CORRUPTION',
      );
    }
    return Object.freeze({ ...existing, replayed: true });
  }

  const predecessors = await db.$queryRawUnsafe(
    `SELECT id, source_version, signed_at
       FROM diagnostic_result_generations
      WHERE tenant_id = $1::uuid
        AND source_kind = $2::text
        AND source_episode_key = $3::text
      ORDER BY source_version DESC
      LIMIT 1
      FOR SHARE`,
    tid,
    sourceKind,
    episodeKey,
  );
  const predecessor = predecessors[0] || null;
  if (predecessor && Number(predecessor.source_version) >= version) {
    throw AppError.conflict(
      'Diagnostic generation version does not advance its predecessor',
      'DIAGNOSTIC_GENERATION_VERSION_INVALID',
    );
  }
  if ((version === 1) !== !predecessor) {
    throw AppError.conflict(
      'Structured diagnostic generation chain is incomplete',
      'DIAGNOSTIC_GENERATION_PREDECESSOR_REQUIRED',
    );
  }

  const mode = await resolvePathwayModeTx({
    tx: db,
    tenantId: tid,
    pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
  });
  if (
    mode === PATHWAY_MODES.ACTIVE
    && ['critical', 'abnormal', 'indeterminate'].includes(classification)
  ) {
    if (!orderingOwnerUid) {
      throw AppError.conflict(
        'Active actionable structured result requires a named ordering clinician',
        'PATHWAY_NAMED_OWNER_UNAVAILABLE',
      );
    }
    await resolvePathwayTaskOwnerTx({
      tx: db,
      tenantId: tid,
      requestedUid: orderingOwnerUid,
    });
  }

  const generationId = randomUUID();
  let criticalTask = null;
  if (mode === PATHWAY_MODES.ACTIVE && classification === 'critical') {
    criticalTask = await enqueueCriticalResultTask({
      tenantId: tid,
      patientUid: cleanPatientUid,
      source: sourceKind,
      resourceType: 'diagnostic_result_generation',
      resourceId: generationId,
      severity: 'critical',
      title: `Critical ${config.label} result: acknowledgement required`,
      orderingClinicianUid: orderingOwnerUid,
      exactNamedOwner: true,
      extraMetadata: {
        diagnostic_generation_id: generationId,
        diagnostic_source_kind: sourceKind,
        diagnostic_source_version: version,
        predecessor_generation_id: predecessor?.id || null,
      },
      tx: db,
      strict: true,
    });
    if (!criticalTask?.taskId || !criticalTask?.slaInstanceId) {
      throw AppError.internal(
        'Critical structured result acknowledgement could not be materialized',
        'DIAGNOSTIC_CRITICAL_ACK_REQUIRED',
      );
    }
  }

  const eventType = predecessor
    ? 'diagnostic.result.generation_corrected'
    : 'diagnostic.result.generation_signed';
  const canonical = await recordCanonicalClinicalEvent({
    tenantId: tid,
    patientUid: cleanPatientUid,
    encounterId,
    eventType,
    eventSubtype: sourceKind,
    eventStatus: classification,
    sourceTable: 'diagnostic_result_generations',
    sourceId: generationId,
    resourceType: 'diagnostic_result_generation',
    resourceTable: 'diagnostic_result_generations',
    resourceId: generationId,
    actorUid: cleanSignerUid,
    actorRole: cleanSignerRole,
    occurredAt: signed,
    visibleToPatient: false,
    summary: predecessor
      ? `Signed ${config.label} result generation corrected`
      : `Signed ${config.label} result generation recorded`,
    payload: {
      generation_id: generationId,
      source_kind: sourceKind,
      source_episode_key: episodeKey,
      source_version: version,
      classification,
      predecessor_generation_id: predecessor?.id || null,
      clinical_significance: significance,
    },
    afterState: {
      classification,
      source_version: version,
      snapshot_sha256: snapshotSha256,
      item_count: 1,
    },
    tags: ['diagnostics', 'result_generation', sourceKind],
    timelineIdempotencyKey: `diagnostic_result_generations:${generationId}:${eventType}`,
    auditIdempotencyKey: `diagnostic_result_generations:${generationId}:audit:${eventType}`,
  }, { db });
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal(
      'Diagnostic generation canonical evidence is unavailable',
      'DIAGNOSTIC_CANONICAL_EVIDENCE_REQUIRED',
    );
  }

  const inserted = await db.$queryRawUnsafe(
    `INSERT INTO diagnostic_result_generations
       (id, tenant_id, patient_uid, encounter_id, source_kind, source_table,
        source_episode_type, source_episode_key, source_version,
        lab_signoff_id, investigation_id, radiology_order_id, radiology_addendum_id,
        ap_report_id, ap_addendum_id, ordering_owner_uid, owner_source,
        signer_uid, signer_role, signed_at, classification, classification_basis,
        snapshot_sha256, item_count, predecessor_generation_id,
        critical_acknowledgement_task_id, critical_acknowledgement_sla_id,
        canonical_timeline_event_id, canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
        $7::text, $8::text, $9::bigint,
        NULL, NULL, $10::integer, $11::bigint,
        $12::bigint, $13::bigint, $14::uuid, $15::text,
        $16::uuid, $17::text,
        COALESCE(CASE
          WHEN $5::text = 'radiology_report' AND $11::bigint IS NULL THEN (
            SELECT source.classification_signed_at
              FROM radiology_orders AS source
             WHERE source.tenant_id = $2::uuid AND source.id = $10::integer
          )
          WHEN $5::text = 'radiology_report' THEN (
            SELECT source.signed_at
              FROM radiology_report_addenda AS source
             WHERE source.tenant_id = $2::uuid AND source.id = $11::bigint
          )
          WHEN $5::text = 'anatomical_pathology_report' AND $13::bigint IS NULL THEN (
            SELECT source.signed_at
              FROM ap_reports AS source
             WHERE source.tenant_id = $2::uuid AND source.id = $12::bigint
          )
          ELSE (
            SELECT source.addendum_at
              FROM ap_report_addenda AS source
             WHERE source.tenant_id = $2::uuid AND source.id = $13::bigint
          )
        END, $18::timestamptz),
        $19::text, $20::jsonb,
        $21::text, 1, $22::uuid,
        $23::integer, $24::uuid, $25::uuid, $26::uuid)
     RETURNING *`,
    generationId,
    tid,
    cleanPatientUid,
    encounterId,
    sourceKind,
    sourceTable,
    config.episodeType,
    episodeKey,
    version,
    radiologyOrderId,
    radiologyAddendumId,
    apReportId,
    apAddendumId,
    orderingOwnerUid,
    orderingOwnerUid ? 'named_orderer' : 'unnamed_role_queue',
    cleanSignerUid,
    cleanSignerRole,
    signed,
    classification,
    JSON.stringify(basis),
    snapshotSha256,
    predecessor?.id || null,
    criticalTask?.taskId || null,
    criticalTask?.slaInstanceId || null,
    canonical.timeline.id,
    canonical.audit.id,
  );

  await db.$queryRawUnsafe(
    `INSERT INTO diagnostic_result_generation_items
       (tenant_id, patient_uid, generation_id, source_table, source_row_id,
        source_version, source_ordinal, item_code, item_name, value_snapshot,
        normalized_flag, source_critical, classification, item_snapshot_sha256)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
        $6::text, 1, NULL, $7::text, $8::jsonb,
        NULL, $9::boolean, $10::text, $11::text)`,
    tid,
    cleanPatientUid,
    generationId,
    sourceTable,
    rowId,
    String(version),
    itemSnapshot.item_name,
    JSON.stringify(itemValueSnapshot),
    classification === 'critical',
    classification,
    itemSnapshotSha256,
  );

  const event = await publishEvent({
    eventType,
    aggregateType: 'diagnostic_result_generation',
    aggregateId: generationId,
    patientUid: cleanPatientUid,
    tenantId: tid,
    tx: db,
    payload: {
      generation_id: generationId,
      source_kind: sourceKind,
      source_episode_type: config.episodeType,
      source_episode_key: episodeKey,
      source_version: version,
      classification,
      predecessor_generation_id: predecessor?.id || null,
      ordering_owner_uid: orderingOwnerUid,
      owner_source: orderingOwnerUid ? 'named_orderer' : 'unnamed_role_queue',
    },
  });
  if (!event?.id) {
    throw AppError.internal(
      'Diagnostic generation event could not be published',
      'DIAGNOSTIC_EVENT_REQUIRED',
    );
  }

  return Object.freeze({
    ...inserted[0],
    items: [{ ...itemSnapshot, item_snapshot_sha256: itemSnapshotSha256 }],
    event_id: event.id,
    replayed: false,
  });
}

export function createRadiologyDiagnosticGenerationTx(params = {}) {
  return createStructuredReportGenerationTx({ ...params, sourceKind: 'radiology_report' });
}

export function createAnatomicalPathologyDiagnosticGenerationTx(params = {}) {
  return createStructuredReportGenerationTx({
    ...params,
    sourceKind: 'anatomical_pathology_report',
  });
}

export default {
  createRadiologyDiagnosticGenerationTx,
  createAnatomicalPathologyDiagnosticGenerationTx,
  normalizeStructuredResultClassification,
  normalizeStructuredClassificationBasis,
  normalizeStructuredAddendumSignificance,
  normalizeDiagnosticIdempotencyKey,
};
