import { randomUUID } from 'node:crypto';

import { isTenantTransactionClient } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  aggregateItemHashes,
  classifySignedLabEpisode,
  classifySignedLabItem,
  sha256ClinicalJson,
} from './diagnosticClassification.js';

function requireTx(tx) {
  if (!tx || !isTenantTransactionClient(tx)) {
    throw AppError.internal(
      'Diagnostic generation requires a tenant transaction',
      'DIAGNOSTIC_GENERATION_TX_REQUIRED',
    );
  }
  return tx;
}

function boundedText(value, max, fallback = null) {
  const text = value == null ? '' : String(value).trim();
  return text ? text.slice(0, max) : fallback;
}

function labItemSnapshot(row) {
  return {
    value_text: row.value_text == null ? null : String(row.value_text),
    value_numeric: row.value_numeric == null ? null : String(row.value_numeric),
    unit: row.unit == null ? null : String(row.unit),
    reference_range: row.reference_range == null ? null : String(row.reference_range),
    reference_range_low: row.reference_range_low == null
      ? null
      : String(row.reference_range_low),
    reference_range_high: row.reference_range_high == null
      ? null
      : String(row.reference_range_high),
  };
}

function normalizeLabItems(rows, signoffId) {
  return rows.map((row, index) => {
    const valueSnapshot = labItemSnapshot(row);
    const classification = classifySignedLabItem(row);
    const snapshot = {
      source_table: 'lab_results',
      source_row_id: String(row.id),
      source_version: String(signoffId),
      source_ordinal: index + 1,
      item_code: boundedText(row.loinc_code || row.test_code, 120),
      item_name: boundedText(row.test_name, 240, 'Unnamed laboratory result'),
      value_snapshot: valueSnapshot,
      normalized_flag: boundedText(row.abnormal_flag, 20)?.toUpperCase() || null,
      source_critical: row.is_critical === true,
      classification,
    };
    return Object.freeze({
      ...snapshot,
      item_snapshot_sha256: sha256ClinicalJson(snapshot),
    });
  });
}

const UNSUPPORTED_SHARED_TYPES = new Set([
  'RADIOLOGY',
  'PATHOLOGY',
  'ANATOMICAL_PATHOLOGY',
  'ANATOMICAL PATHOLOGY',
  'AP',
]);
const MAX_SHARED_RESULT_ITEMS = 100;

function sharedItemClassification(item) {
  if (item?.is_critical === true || item?.critical === true || item?.panic === true) {
    return 'critical';
  }
  const flag = String(item?.abnormal_flag ?? item?.flag ?? '').trim().toUpperCase();
  if (['LL', 'HH', 'AA', 'CRITICAL', 'PANIC'].includes(flag)) return 'critical';
  if (['L', 'H', 'A', 'ABNORMAL'].includes(flag)) return 'abnormal';
  if (['N', 'NORMAL'].includes(flag)) return 'normal';
  return 'indeterminate';
}

function flattenSharedItems(value, path = [], output = []) {
  if (output.length > MAX_SHARED_RESULT_ITEMS || value == null || typeof value !== 'object') {
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => flattenSharedItems(child, [...path, String(index)], output));
    return output;
  }
  if (Object.hasOwn(value, 'value') || Object.hasOwn(value, 'result')) {
    output.push({ value, path });
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') flattenSharedItems(child, [...path, key], output);
  }
  return output;
}

function normalizeSharedItems(investigation) {
  const leaves = flattenSharedItems(investigation.results);
  if (leaves.length > MAX_SHARED_RESULT_ITEMS) {
    throw AppError.conflict(
      `Shared investigation contains more than ${MAX_SHARED_RESULT_ITEMS} result items`,
      'DIAGNOSTIC_RESULT_ITEM_LIMIT_EXCEEDED',
    );
  }
  const candidates = leaves.length > 0
    ? leaves
    : [{ value: { result: investigation.results }, path: [investigation.test_name || 'Result'] }];
  return candidates.map(({ value, path }, index) => {
    const classification = sharedItemClassification(value);
    const snapshot = {
      source_table: 'investigations',
      source_row_id: String(investigation.id),
      source_version: String(investigation.result_version),
      source_ordinal: index + 1,
      item_code: boundedText(value.code || value.test_code, 120),
      item_name: boundedText(
        value.name || value.test_name || value.analyte || value.parameter || path.at(-1),
        240,
        boundedText(investigation.test_name, 240, 'Investigation result'),
      ),
      value_snapshot: {
        value: value.value ?? value.result ?? null,
        unit: value.unit ?? null,
        reference_range: value.normal_range ?? value.reference_range ?? null,
      },
      normalized_flag: boundedText(value.abnormal_flag ?? value.flag, 20)?.toUpperCase() || null,
      source_critical: value.is_critical === true || value.critical === true || value.panic === true,
      classification,
    };
    return Object.freeze({ ...snapshot, item_snapshot_sha256: sha256ClinicalJson(snapshot) });
  });
}

function aggregateClassifications(items) {
  const values = items.map((item) => item.classification);
  if (values.includes('critical')) return 'critical';
  if (values.includes('abnormal')) return 'abnormal';
  return values.length > 0 && values.every((value) => value === 'normal')
    ? 'normal'
    : 'indeterminate';
}

async function resolveLabEpisodeOwner(tx, tenantId, episode) {
  if (episode.type !== 'investigation') {
    return { orderingOwnerUid: null, ownerSource: 'unnamed_role_queue' };
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT investigation.requested_by,
            owner.uid AS owner_uid
       FROM investigations AS investigation
       LEFT JOIN users AS owner
         ON owner.tenant_id = investigation.tenant_id
        AND owner.uid = investigation.requested_by
      WHERE investigation.tenant_id = $1::uuid
        AND investigation.id = $2::int
      LIMIT 1
      FOR SHARE OF investigation`,
    tenantId,
    Number(episode.id),
  );
  const source = rows[0];
  if (!source) {
    throw AppError.conflict(
      'Diagnostic source investigation is unavailable',
      'DIAGNOSTIC_SOURCE_UNAVAILABLE',
    );
  }
  if (source.requested_by && !source.owner_uid) {
    throw AppError.conflict(
      'Named diagnostic owner is outside the source tenant',
      'DIAGNOSTIC_NAMED_OWNER_INVALID',
    );
  }
  return source.requested_by
    ? { orderingOwnerUid: source.requested_by, ownerSource: 'named_orderer' }
    : { orderingOwnerUid: null, ownerSource: 'unnamed_role_queue' };
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

export async function createLabDiagnosticGenerationTx({
  tx,
  tenantId,
  patientUid,
  episode,
  signoff,
  signerRole,
  panelRows,
} = {}) {
  const db = requireTx(tx);
  const tid = requireTenantId(tenantId);
  if (!episode || !['investigation', 'booking'].includes(episode.type)) {
    throw AppError.badRequest('Diagnostic source episode is invalid', 'DIAGNOSTIC_EPISODE_INVALID');
  }
  const signoffId = Number(signoff?.id);
  if (!Number.isSafeInteger(signoffId) || signoffId <= 0) {
    throw AppError.badRequest('Diagnostic source sign-off is invalid', 'DIAGNOSTIC_SIGNOFF_INVALID');
  }
  if (!Array.isArray(panelRows) || panelRows.length === 0) {
    throw AppError.conflict('Diagnostic generation cannot be empty', 'DIAGNOSTIC_GENERATION_EMPTY');
  }
  const items = normalizeLabItems(panelRows, signoffId);
  const snapshotSha256 = aggregateItemHashes(items.map((item) => item.item_snapshot_sha256));
  const classification = classifySignedLabEpisode(panelRows);
  const sourceKind = 'lab_panel';
  const sourceEpisodeKey = String(episode.key);
  const existing = await loadExistingGeneration(
    db,
    tid,
    sourceKind,
    sourceEpisodeKey,
    signoffId,
  );
  if (existing) {
    if (
      String(existing.snapshot_sha256) !== snapshotSha256
      || Number(existing.item_count) !== items.length
      || existing.classification !== classification
    ) {
      throw AppError.conflict(
        'Diagnostic generation identity was reused with different content',
        'DIAGNOSTIC_GENERATION_CORRUPTION',
      );
    }
    return Object.freeze({ ...existing, replayed: true });
  }

  const owner = await resolveLabEpisodeOwner(db, tid, episode);
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
    sourceEpisodeKey,
  );
  const predecessor = predecessors[0] || null;
  if (predecessor && Number(predecessor.source_version) >= signoffId) {
    throw AppError.conflict(
      'Diagnostic generation version does not advance its predecessor',
      'DIAGNOSTIC_GENERATION_VERSION_INVALID',
    );
  }

  const generationId = randomUUID();
  const eventType = predecessor
    ? 'diagnostic.result.generation_corrected'
    : 'diagnostic.result.generation_signed';
  const canonical = await recordCanonicalClinicalEvent({
    tenantId: tid,
    patientUid,
    eventType,
    eventSubtype: 'diagnostic_result_generation',
    eventStatus: classification,
    sourceTable: 'diagnostic_result_generations',
    sourceId: generationId,
    resourceType: 'diagnostic_result_generation',
    resourceId: generationId,
    actorUid: signoff.signed_off_by,
    actorRole: signerRole,
    occurredAt: signoff.signed_at,
    visibleToPatient: false,
    summary: predecessor
      ? 'Signed diagnostic result generation corrected'
      : 'Signed diagnostic result generation recorded',
    payload: {
      generation_id: generationId,
      source_kind: sourceKind,
      source_episode_key: sourceEpisodeKey,
      source_version: signoffId,
      classification,
      predecessor_generation_id: predecessor?.id || null,
    },
    afterState: {
      classification,
      source_version: signoffId,
      snapshot_sha256: snapshotSha256,
      item_count: items.length,
    },
    tags: ['diagnostics', 'result_generation'],
    timelineIdempotencyKey: `diagnostic_result_generations:${generationId}:${eventType}`,
    auditIdempotencyKey: `diagnostic_result_generations:${generationId}:audit:${eventType}`,
  }, { db });
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal(
      'Diagnostic generation canonical evidence is unavailable',
      'DIAGNOSTIC_CANONICAL_EVIDENCE_REQUIRED',
    );
  }

  const classificationBasis = {
    algorithm: 'signed_structured_lab_flags.v1',
    critical_items: items.filter((item) => item.classification === 'critical').length,
    abnormal_items: items.filter((item) => item.classification === 'abnormal').length,
    normal_items: items.filter((item) => item.classification === 'normal').length,
    indeterminate_items: items.filter((item) => item.classification === 'indeterminate').length,
  };
  const inserted = await db.$queryRawUnsafe(
    `INSERT INTO diagnostic_result_generations
       (id, tenant_id, patient_uid, source_kind, source_table,
        source_episode_type, source_episode_key, source_version,
        lab_signoff_id, investigation_id, ordering_owner_uid, owner_source,
        signer_uid, signer_role, signed_at, classification,
        classification_basis, snapshot_sha256, item_count,
        predecessor_generation_id, canonical_timeline_event_id,
        canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::text, 'lab_pathologist_signoffs',
         $5::text, $6::text, $7::bigint,
         $7::integer, $8::integer, $9::uuid, $10::text,
         $11::uuid, $12::text,
         (SELECT signed_at
            FROM lab_pathologist_signoffs
           WHERE tenant_id = $2::uuid AND id = $7::integer),
         $13::text, $14::jsonb, $15::text, $16::integer,
         $17::uuid, $18::uuid, $19::uuid)
     RETURNING *`,
    generationId,
    tid,
    patientUid,
    sourceKind,
    episode.type,
    sourceEpisodeKey,
    signoffId,
    episode.type === 'investigation' ? Number(episode.id) : null,
    owner.orderingOwnerUid,
    owner.ownerSource,
    signoff.signed_off_by,
    signerRole,
    classification,
    JSON.stringify(classificationBasis),
    snapshotSha256,
    items.length,
    predecessor?.id || null,
    canonical.timeline.id,
    canonical.audit.id,
  );

  for (const item of items) {
    await db.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_generation_items
         (tenant_id, patient_uid, generation_id, source_table, source_row_id,
          source_version, source_ordinal, item_code, item_name, value_snapshot,
          normalized_flag, source_critical, classification, item_snapshot_sha256)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
          $6::text, $7::integer, $8::text, $9::text, $10::jsonb,
          $11::text, $12::boolean, $13::text, $14::text)`,
      tid,
      patientUid,
      generationId,
      item.source_table,
      item.source_row_id,
      item.source_version,
      item.source_ordinal,
      item.item_code,
      item.item_name,
      JSON.stringify(item.value_snapshot),
      item.normalized_flag,
      item.source_critical,
      item.classification,
      item.item_snapshot_sha256,
    );
  }

  const event = await publishEvent({
    eventType,
    aggregateType: 'diagnostic_result_generation',
    aggregateId: generationId,
    patientUid,
    tenantId: tid,
    tx: db,
    payload: {
      generation_id: generationId,
      source_kind: sourceKind,
      source_episode_type: episode.type,
      source_episode_key: sourceEpisodeKey,
      source_version: signoffId,
      classification,
      predecessor_generation_id: predecessor?.id || null,
      ordering_owner_uid: owner.orderingOwnerUid,
      owner_source: owner.ownerSource,
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
    items,
    event_id: event.id,
    replayed: false,
  });
}

export async function createSharedInvestigationGenerationTx({
  tx,
  tenantId,
  investigation,
  signerRole,
} = {}) {
  const db = requireTx(tx);
  const tid = requireTenantId(tenantId);
  const investigationId = Number(investigation?.id);
  const sourceVersion = Number(investigation?.result_version);
  if (!Number.isSafeInteger(investigationId) || investigationId <= 0) {
    throw AppError.badRequest('Investigation source is invalid', 'DIAGNOSTIC_SOURCE_INVALID');
  }
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion <= 0) {
    throw AppError.conflict(
      'Investigation result version is invalid',
      'DIAGNOSTIC_GENERATION_VERSION_INVALID',
    );
  }
  const sourceType = String(investigation.test_type || '').trim().toUpperCase();
  if (UNSUPPORTED_SHARED_TYPES.has(sourceType)) {
    throw AppError.conflict(
      'This investigation type requires its structured radiology/AP generation adapter',
      'DIAGNOSTIC_SOURCE_ADAPTER_UNREGISTERED',
    );
  }
  const linkedLabRows = await db.$queryRawUnsafe(
    `SELECT 1
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND investigation_id = $2::int
      LIMIT 1`,
    tid,
    investigationId,
  );
  if (linkedLabRows.length > 0) {
    throw AppError.conflict(
      'Structured lab results must use the pathologist sign-off generation adapter',
      'DIAGNOSTIC_SOURCE_ADAPTER_CONFLICT',
    );
  }
  if (!investigation.patient_uid || !investigation.verified_by || !investigation.verified_at) {
    throw AppError.conflict(
      'Shared investigation generation requires patient and source-verification evidence',
      'DIAGNOSTIC_SOURCE_VERIFICATION_REQUIRED',
    );
  }

  const items = normalizeSharedItems(investigation);
  const classification = aggregateClassifications(items);
  const snapshotSha256 = aggregateItemHashes(items.map((item) => item.item_snapshot_sha256));
  const sourceKind = 'shared_investigation';
  const sourceEpisodeKey = `investigation:${investigationId}`;
  const existing = await loadExistingGeneration(
    db,
    tid,
    sourceKind,
    sourceEpisodeKey,
    sourceVersion,
  );
  if (existing) {
    if (
      String(existing.snapshot_sha256) !== snapshotSha256
      || Number(existing.item_count) !== items.length
      || existing.classification !== classification
    ) {
      throw AppError.conflict(
        'Diagnostic generation identity was reused with different content',
        'DIAGNOSTIC_GENERATION_CORRUPTION',
      );
    }
    return Object.freeze({ ...existing, replayed: true });
  }

  const ownerRows = investigation.requested_by
    ? await db.$queryRawUnsafe(
      `SELECT uid
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
        LIMIT 1`,
      tid,
      investigation.requested_by,
    )
    : [];
  if (investigation.requested_by && !ownerRows[0]?.uid) {
    throw AppError.conflict(
      'Named diagnostic owner is outside the source tenant',
      'DIAGNOSTIC_NAMED_OWNER_INVALID',
    );
  }
  const orderingOwnerUid = investigation.requested_by || null;
  const ownerSource = orderingOwnerUid ? 'named_orderer' : 'unnamed_role_queue';
  const predecessors = await db.$queryRawUnsafe(
    `SELECT id, source_version
       FROM diagnostic_result_generations
      WHERE tenant_id = $1::uuid
        AND source_kind = $2::text
        AND source_episode_key = $3::text
      ORDER BY source_version DESC
      LIMIT 1
      FOR SHARE`,
    tid,
    sourceKind,
    sourceEpisodeKey,
  );
  const predecessor = predecessors[0] || null;
  if (predecessor && Number(predecessor.source_version) >= sourceVersion) {
    throw AppError.conflict(
      'Diagnostic generation version does not advance its predecessor',
      'DIAGNOSTIC_GENERATION_VERSION_INVALID',
    );
  }

  const generationId = randomUUID();
  const eventType = predecessor
    ? 'diagnostic.result.generation_corrected'
    : 'diagnostic.result.generation_signed';
  const canonical = await recordCanonicalClinicalEvent({
    tenantId: tid,
    patientUid: investigation.patient_uid,
    eventType,
    eventSubtype: 'diagnostic_result_generation',
    eventStatus: classification,
    sourceTable: 'diagnostic_result_generations',
    sourceId: generationId,
    resourceType: 'diagnostic_result_generation',
    resourceId: generationId,
    actorUid: investigation.verified_by,
    actorRole: signerRole,
    occurredAt: investigation.verified_at,
    visibleToPatient: false,
    summary: predecessor
      ? 'Signed shared investigation generation corrected'
      : 'Signed shared investigation generation recorded',
    payload: {
      generation_id: generationId,
      source_kind: sourceKind,
      source_episode_key: sourceEpisodeKey,
      source_version: sourceVersion,
      classification,
      predecessor_generation_id: predecessor?.id || null,
    },
    afterState: {
      classification,
      source_version: sourceVersion,
      snapshot_sha256: snapshotSha256,
      item_count: items.length,
    },
    tags: ['diagnostics', 'result_generation'],
    timelineIdempotencyKey: `diagnostic_result_generations:${generationId}:${eventType}`,
    auditIdempotencyKey: `diagnostic_result_generations:${generationId}:audit:${eventType}`,
  }, { db });
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal(
      'Diagnostic generation canonical evidence is unavailable',
      'DIAGNOSTIC_CANONICAL_EVIDENCE_REQUIRED',
    );
  }

  const classificationBasis = {
    algorithm: 'signed_structured_shared_flags.v1',
    critical_items: items.filter((item) => item.classification === 'critical').length,
    abnormal_items: items.filter((item) => item.classification === 'abnormal').length,
    normal_items: items.filter((item) => item.classification === 'normal').length,
    indeterminate_items: items.filter((item) => item.classification === 'indeterminate').length,
    release_supported: false,
  };
  const inserted = await db.$queryRawUnsafe(
    `INSERT INTO diagnostic_result_generations
       (id, tenant_id, patient_uid, source_kind, source_table,
        source_episode_type, source_episode_key, source_version,
        lab_signoff_id, investigation_id, ordering_owner_uid, owner_source,
        signer_uid, signer_role, signed_at, classification,
        classification_basis, snapshot_sha256, item_count,
        predecessor_generation_id, canonical_timeline_event_id,
        canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::text, 'investigations',
        'investigation', $5::text, $6::bigint,
        NULL, $7::integer, $8::uuid, $9::text,
        $10::uuid, $11::text, $12::timestamptz, $13::text,
        $14::jsonb, $15::text, $16::integer,
        $17::uuid, $18::uuid, $19::uuid)
     RETURNING *`,
    generationId,
    tid,
    investigation.patient_uid,
    sourceKind,
    sourceEpisodeKey,
    sourceVersion,
    investigationId,
    orderingOwnerUid,
    ownerSource,
    investigation.verified_by,
    signerRole,
    investigation.verified_at,
    classification,
    JSON.stringify(classificationBasis),
    snapshotSha256,
    items.length,
    predecessor?.id || null,
    canonical.timeline.id,
    canonical.audit.id,
  );
  for (const item of items) {
    await db.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_generation_items
         (tenant_id, patient_uid, generation_id, source_table, source_row_id,
          source_version, source_ordinal, item_code, item_name, value_snapshot,
          normalized_flag, source_critical, classification, item_snapshot_sha256)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
          $6::text, $7::integer, $8::text, $9::text, $10::jsonb,
          $11::text, $12::boolean, $13::text, $14::text)`,
      tid,
      investigation.patient_uid,
      generationId,
      item.source_table,
      item.source_row_id,
      item.source_version,
      item.source_ordinal,
      item.item_code,
      item.item_name,
      JSON.stringify(item.value_snapshot),
      item.normalized_flag,
      item.source_critical,
      item.classification,
      item.item_snapshot_sha256,
    );
  }
  const event = await publishEvent({
    eventType,
    aggregateType: 'diagnostic_result_generation',
    aggregateId: generationId,
    patientUid: investigation.patient_uid,
    tenantId: tid,
    tx: db,
    payload: {
      generation_id: generationId,
      source_kind: sourceKind,
      source_episode_type: 'investigation',
      source_episode_key: sourceEpisodeKey,
      source_version: sourceVersion,
      classification,
      predecessor_generation_id: predecessor?.id || null,
      ordering_owner_uid: orderingOwnerUid,
      owner_source: ownerSource,
    },
  });
  if (!event?.id) {
    throw AppError.internal(
      'Diagnostic generation event could not be published',
      'DIAGNOSTIC_EVENT_REQUIRED',
    );
  }
  return Object.freeze({ ...inserted[0], items, event_id: event.id, replayed: false });
}

export default {
  createLabDiagnosticGenerationTx,
  createSharedInvestigationGenerationTx,
};
