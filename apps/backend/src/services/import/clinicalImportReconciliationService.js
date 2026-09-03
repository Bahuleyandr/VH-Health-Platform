import crypto from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  lockTenantPatientMergeStability,
  PATIENT_MERGE_STABILITY_TIMEOUT_MS,
} from '../../utils/patientMergeStabilityLock.js';
import {
  clinicalImportSha256,
  lockClinicalImportAuthorityGrantTx,
} from './clinicalImportReceiptService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MEDICAL_RECORDS_ROLE = 'MEDICAL_RECORDS';
const PATIENT_RECORD_UPLOAD_POLICY = 'patient.record.upload';
const OPEN_EVENT_TYPES = new Set(['OPENED', 'RETRY_REQUESTED']);
const ACTION_EVENT_TYPES = new Set(['RETRY_REQUESTED', 'RESOLVED']);
const LIST_LIMIT = 25;
const LIST_SCAN_BATCH_SIZE = 25;
const LIST_SCAN_ROW_LIMIT = 25;
const LIST_SCAN_QUERY_LIMIT = 1;
const LIST_SCAN_TIME_BUDGET_MS = 10_000;
const LIST_TRANSACTION_TIMEOUT_MS = 10_000;
// setTenantTx adds at most two tenant-scope preamble statements before this budget.
const LIST_TOTAL_DB_QUERY_LIMIT = 38;
const WORKLIST_CURSOR_VERSION = 1;
const WORKLIST_CURSOR_KEY_DOMAIN = 'vhhealth:clinical-import-reconciliation-cursor:key:v1';
const SUPERSESSION_AUTHORITY_GATE = 'CLINICAL_IMPORT_SUPERSESSION_OWNER';

function worklistDbBudget(tx) {
  let queryCount = 0;
  const invoke = (method, args) => {
    if (queryCount >= LIST_TOTAL_DB_QUERY_LIMIT) {
      throw AppError.serviceUnavailable(
        'Clinical import reconciliation query budget was exhausted',
        'IMPORT_RECONCILIATION_QUERY_BUDGET_EXHAUSTED',
      );
    }
    queryCount += 1;
    return tx[method](...args);
  };
  return {
    db: {
      $queryRawUnsafe: (...args) => invoke('$queryRawUnsafe', args),
      $executeRawUnsafe: (...args) => invoke('$executeRawUnsafe', args),
    },
  };
}

// The worklist takes exactly one advisory lock: this per-tenant one. A
// fleet-wide slot pool used to sit behind it (4 slots keyed on a constant
// string) and was removed on 2026-09-03: behind this lock, fleet concurrency is
// already bounded by the number of distinct tenants with a scan open, and a
// per-database advisory constant cannot be sized against the per-pod
// connection pools it would be protecting, so its only reachable effect was
// rejecting a healthy tenant for another tenant's slow scan. Reintroduce a
// concurrency guard only for a real high-fanout consumer or measured pool
// pressure, and size it in the process against live pod count and pool size.
// See docs/superpowers/specs/2026-09-03-clinical-import-worklist-concurrency-design.md.
async function acquireTenantWorklistLock(db, tenantId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 760)) AS acquired`,
    `vh:clinical-import-reconciliation-worklist:tenant:${tenantId}`,
  );
  if (rows[0]?.acquired !== true) {
    throw AppError.tooMany(
      'A clinical import reconciliation worklist is already active for this tenant',
      'IMPORT_RECONCILIATION_TENANT_CONCURRENCY_EXHAUSTED',
    );
  }
}

async function applyRemainingStatementTimeout(db, deadlineMs) {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw AppError.serviceUnavailable(
      'Clinical import reconciliation deadline was exhausted',
      'IMPORT_RECONCILIATION_DEADLINE_EXHAUSTED',
    );
  }
  const timeoutMs = Math.max(1, Math.min(3_000, remainingMs));
  await db.$executeRawUnsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
}

function worklistCursorKey() {
  const secret = String(process.env.JWT_SECRET || '');
  if (!secret || (process.env.NODE_ENV === 'production' && secret.length < 32)) {
    throw AppError.internal(
      'Clinical import reconciliation cursor signing is unavailable',
      'IMPORT_RECONCILIATION_CURSOR_SECRET_UNAVAILABLE',
    );
  }
  return crypto.createHmac('sha256', secret)
    .update(WORKLIST_CURSOR_KEY_DOMAIN)
    .digest();
}

function signWorklistCursorPayload(encodedPayload) {
  return crypto.createHmac('sha256', worklistCursorKey())
    .update(encodedPayload)
    .digest('base64url');
}

function decodeWorklistCursor(value, tenantId) {
  if (value == null) {
    return { createdAt: null, itemId: null };
  }
  const token = String(value).trim();
  if (!token || token.length > 512
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw AppError.badRequest(
      'Clinical import reconciliation cursor is invalid',
      'IMPORT_RECONCILIATION_CURSOR_INVALID',
    );
  }
  try {
    const [encodedPayload, suppliedSignature] = token.split('.');
    const expectedSignature = signWorklistCursorPayload(encodedPayload);
    const suppliedSignatureBytes = Buffer.from(suppliedSignature, 'ascii');
    const expectedSignatureBytes = Buffer.from(expectedSignature, 'ascii');
    if (suppliedSignatureBytes.length !== expectedSignatureBytes.length
      || !crypto.timingSafeEqual(suppliedSignatureBytes, expectedSignatureBytes)) {
      throw new TypeError('invalid cursor signature');
    }
    const decodedText = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    if (Buffer.from(decodedText).toString('base64url') !== encodedPayload) {
      throw new TypeError('non-canonical base64url');
    }
    const decoded = JSON.parse(decodedText);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || Object.keys(decoded).join(',') !== 'v,tenant_id,created_at,item_id'
      || JSON.stringify(decoded) !== decodedText
      || decoded.v !== WORKLIST_CURSOR_VERSION
      || decoded.tenant_id !== tenantId
      || typeof decoded.created_at !== 'string') {
      throw new TypeError('invalid cursor object');
    }
    const createdAt = new Date(decoded?.created_at);
    const itemId = requiredUuid(
      decoded?.item_id,
      'cursor.item_id',
      'IMPORT_RECONCILIATION_CURSOR_INVALID',
    );
    if (Number.isNaN(createdAt.getTime())
      || createdAt.toISOString() !== decoded.created_at) {
      throw new TypeError('invalid timestamp');
    }
    return { createdAt: createdAt.toISOString(), itemId };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest(
      'Clinical import reconciliation cursor is invalid',
      'IMPORT_RECONCILIATION_CURSOR_INVALID',
    );
  }
}

function encodeWorklistCursor(row, tenantId) {
  const encodedPayload = Buffer.from(JSON.stringify({
    v: WORKLIST_CURSOR_VERSION,
    tenant_id: tenantId,
    created_at: new Date(row.item_created_at).toISOString(),
    item_id: String(row.id).toLowerCase(),
  })).toString('base64url');
  return `${encodedPayload}.${signWorklistCursorPayload(encodedPayload)}`;
}

function requiredUuid(value, field, code = 'IMPORT_RECONCILIATION_INVALID_REQUEST') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw AppError.badRequest(`${field} must be a UUID`, code);
  }
  return normalized;
}

function requireMedicalRecordsActor(actorUid, actorRole) {
  const uid = requiredUuid(
    actorUid,
    'actorUid',
    'IMPORT_RECONCILIATION_ACTOR_REQUIRED',
  );
  if (String(actorRole || '').trim().toUpperCase() !== MEDICAL_RECORDS_ROLE) {
    throw AppError.forbidden(
      'Clinical import reconciliation is restricted to Medical Records',
      'IMPORT_RECONCILIATION_ROLE_REQUIRED',
    );
  }
  return uid;
}

function requiredReason(value) {
  const reason = String(value || '').trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw AppError.badRequest(
      'A reconciliation reason between 10 and 1000 characters is required',
      'IMPORT_RECONCILIATION_REASON_REQUIRED',
    );
  }
  return reason;
}

function requiredIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 255) {
    throw AppError.badRequest(
      'Idempotency-Key is required and must not exceed 255 characters',
      'IMPORT_RECONCILIATION_IDEMPOTENCY_REQUIRED',
    );
  }
  return key;
}

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

function normalizeAccessDecisionEvidence(evidence, { actorUid, patientUid }) {
  const value = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? evidence
    : {};
  const decision = String(value.access_decision || '').trim().toLowerCase();
  const policyHash = String(value.policy_hash || '').trim().toLowerCase();
  const evidenceActorUid = String(value.actor_uid || '').trim().toLowerCase();
  const evidencePatientUid = String(value.patient_uid || '').trim().toLowerCase();
  if (value.contract_version !== 'clinical-import-reconciliation-access-decision-v1'
    || !['allow', 'break_glass'].includes(decision)
    || value.policy_code !== PATIENT_RECORD_UPLOAD_POLICY
    || !String(value.policy_version || '').trim()
    || !SHA256_RE.test(policyHash)
    || evidenceActorUid !== actorUid
    || evidencePatientUid !== patientUid) {
    throw AppError.forbidden(
      'A current patient record upload access decision is required',
      'IMPORT_RECONCILIATION_PATIENT_ACCESS_REQUIRED',
    );
  }
  return stableValue({
    contract_version: value.contract_version,
    access_decision: decision,
    access_source: value.access_source || null,
    policy_code: value.policy_code,
    policy_version: String(value.policy_version),
    policy_hash: policyHash,
    reason: value.reason || null,
    actor_uid: evidenceActorUid,
    patient_uid: evidencePatientUid,
    care_team_id: value.care_team_id || null,
    break_glass_id: value.break_glass_id || null,
    referral_id: value.referral_id || null,
    appointment_id: value.appointment_id || null,
    admission_id: value.admission_id || null,
    evaluated_at: value.evaluated_at || null,
  });
}

async function requireActiveMedicalRecordsActorTx(tx, tenantId, actorUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT actor.uid
       FROM users AS actor
      WHERE actor.tenant_id=$1::uuid
        AND actor.uid=$2::uuid
        AND actor.role='MEDICAL_RECORDS'
        AND actor.is_active=TRUE
        AND actor.status='active'
        AND actor.is_deleted=FALSE
        AND actor.merged_into_uid IS NULL
      LIMIT 1`,
    tenantId,
    actorUid,
  );
  if (!rows.length) {
    throw AppError.forbidden(
      'The Medical Records actor is unavailable',
      'IMPORT_RECONCILIATION_ACTOR_UNAVAILABLE',
    );
  }
}

async function resolveActivePatientSurvivorTx(tx, tenantId, patientUid) {
  const rows = await tx.$queryRawUnsafe(
    `WITH RECURSIVE patient_chain AS (
       SELECT patient.id, patient.uid, patient.merged_into_uid,
              patient.role, patient.is_active, patient.status, patient.is_deleted,
              ARRAY[patient.uid]::uuid[] AS path, FALSE AS cycle, 0 AS depth
         FROM users AS patient
        WHERE patient.tenant_id=$1::uuid
          AND patient.uid=$2::uuid
          AND patient.role='PATIENT'
       UNION ALL
       SELECT survivor.id, survivor.uid, survivor.merged_into_uid,
              survivor.role, survivor.is_active, survivor.status, survivor.is_deleted,
              chain.path || survivor.uid,
              survivor.uid = ANY(chain.path) AS cycle,
              chain.depth + 1
         FROM patient_chain AS chain
         JOIN users AS survivor
           ON survivor.tenant_id=$1::uuid
          AND survivor.uid=chain.merged_into_uid
          AND survivor.role='PATIENT'
        WHERE chain.cycle=FALSE
          AND chain.depth < 32
     )
     SELECT id, uid, merged_into_uid, role, is_active, status, is_deleted,
            cycle, depth
       FROM patient_chain
      ORDER BY depth`,
    tenantId,
    patientUid,
  );
  if (!rows.length) {
    throw AppError.notFound(
      'Clinical import reconciliation patient is unavailable',
      'IMPORT_RECONCILIATION_PATIENT_NOT_FOUND',
    );
  }
  const survivor = rows[rows.length - 1];
  if (rows.some((row) => row.cycle === true)
    || (Number(survivor.depth) >= 32 && survivor.merged_into_uid)
    || survivor.merged_into_uid
    || survivor.role !== 'PATIENT'
    || survivor.is_active !== true
    || survivor.status !== 'active'
    || survivor.is_deleted === true) {
    throw AppError.conflict(
      'Clinical import reconciliation patient custody cannot be resolved to one active survivor',
      'IMPORT_RECONCILIATION_PATIENT_CUSTODY_INVALID',
    );
  }
  return {
    id: Number(survivor.id),
    uid: String(survivor.uid).toLowerCase(),
  };
}

async function resolveActivePatientSurvivorsTx(tx, tenantId, patientUids) {
  const uniquePatientUids = [...new Set(patientUids.map(uid => String(uid).toLowerCase()))];
  if (!uniquePatientUids.length) return new Map();
  const rows = await tx.$queryRawUnsafe(
    `WITH RECURSIVE patient_chain AS (
       SELECT patient.uid AS origin_uid, patient.id, patient.uid,
              patient.merged_into_uid, patient.role, patient.is_active,
              patient.status, patient.is_deleted,
              ARRAY[patient.uid]::uuid[] AS path, FALSE AS cycle, 0 AS depth
         FROM users AS patient
        WHERE patient.tenant_id=$1::uuid
          AND patient.uid=ANY($2::uuid[])
          AND patient.role='PATIENT'
       UNION ALL
       SELECT chain.origin_uid, survivor.id, survivor.uid,
              survivor.merged_into_uid, survivor.role, survivor.is_active,
              survivor.status, survivor.is_deleted,
              chain.path || survivor.uid,
              survivor.uid = ANY(chain.path) AS cycle,
              chain.depth + 1
         FROM patient_chain AS chain
         JOIN users AS survivor
           ON survivor.tenant_id=$1::uuid
          AND survivor.uid=chain.merged_into_uid
          AND survivor.role='PATIENT'
        WHERE chain.cycle=FALSE
          AND chain.depth < 32
     )
     SELECT origin_uid, id, uid, merged_into_uid, role, is_active, status,
            is_deleted, cycle, depth
       FROM patient_chain
      ORDER BY origin_uid, depth`,
    tenantId,
    uniquePatientUids,
  );
  const chains = new Map(uniquePatientUids.map(uid => [uid, []]));
  for (const row of rows) {
    chains.get(String(row.origin_uid).toLowerCase())?.push(row);
  }
  const survivors = new Map();
  for (const [originUid, chain] of chains) {
    const survivor = chain[chain.length - 1];
    if (!survivor
      || chain.some(row => row.cycle === true)
      || (Number(survivor.depth) >= 32 && survivor.merged_into_uid)
      || survivor.merged_into_uid
      || survivor.role !== 'PATIENT'
      || survivor.is_active !== true
      || survivor.status !== 'active'
      || survivor.is_deleted === true) {
      survivors.set(originUid, null);
    } else {
      survivors.set(originUid, {
        id: Number(survivor.id),
        uid: String(survivor.uid).toLowerCase(),
      });
    }
  }
  return survivors;
}

const ITEM_SELECT = `
  SELECT item.id, item.patient_uid, item.facility_id,
         item.owner_actor_uid, item.owner_actor_role, item.reason AS item_reason,
         item.created_at AS item_created_at,
         resource.id AS resource_receipt_id,
         resource.source_resource_type, resource.source_resource_id,
         resource.source_resource_index, resource.outcome AS resource_outcome,
         resource.evidence ->> 'error_code' AS resource_error_code,
         resource.evidence ->> 'error' AS resource_error,
         document.id AS document_receipt_id,
         document.source_system, document.source_document_id,
         document.document_format, document.source_facility_id,
         latest.id AS latest_event_id, latest.event_type AS latest_event_type,
         latest.actor_uid AS latest_event_actor_uid,
         latest.reason AS latest_event_reason,
         latest.evidence_sha256 AS latest_event_evidence_sha256,
         latest.created_at AS latest_event_created_at
    FROM clinical_import_reconciliation_items AS item
    JOIN clinical_import_resource_receipts AS resource
      ON resource.tenant_id=item.tenant_id
     AND resource.id=item.resource_receipt_id
    JOIN clinical_import_document_receipts AS document
      ON document.tenant_id=item.tenant_id
     AND document.id=item.document_receipt_id
     AND document.patient_uid=item.patient_uid
    JOIN LATERAL (
      SELECT event.id, event.event_type, event.actor_uid, event.reason,
             event.evidence_sha256, event.created_at
        FROM clinical_import_reconciliation_events AS event
       WHERE event.tenant_id=item.tenant_id
         AND event.reconciliation_item_id=item.id
       ORDER BY event.created_at DESC, event.id DESC
       LIMIT 1
    ) AS latest ON TRUE`;

async function loadItemTx(tx, tenantId, itemId) {
  const rows = await tx.$queryRawUnsafe(
    `${ITEM_SELECT}
      WHERE item.tenant_id=$1::uuid
        AND item.id=$2::uuid`,
    tenantId,
    itemId,
  );
  if (!rows.length) {
    throw AppError.notFound(
      'Clinical import reconciliation item was not found',
      'IMPORT_RECONCILIATION_NOT_FOUND',
    );
  }
  return rows[0];
}

function accessContext(row, survivor) {
  return {
    itemId: String(row.id),
    historicalPatientUid: String(row.patient_uid).toLowerCase(),
    activePatientId: survivor.id,
    activePatientUid: survivor.uid,
    facilityId: Number(row.facility_id),
    sourceSystem: String(row.source_system),
    sourceDocumentId: String(row.source_document_id),
    documentFormat: String(row.document_format),
    sourceResourceType: String(row.source_resource_type),
    sourceResourceId: row.source_resource_id == null ? null : String(row.source_resource_id),
  };
}

function publicItem(row, survivor, actorUid) {
  if (!OPEN_EVENT_TYPES.has(String(row.latest_event_type))) {
    throw AppError.conflict(
      'Clinical import reconciliation item is not open',
      'IMPORT_RECONCILIATION_NOT_OPEN',
    );
  }
  return {
    id: String(row.id),
    owned_by_caller: String(row.owner_actor_uid).toLowerCase() === actorUid,
    owner_actor_uid: String(row.owner_actor_uid),
    historical_patient_uid: String(row.patient_uid),
    active_patient_uid: survivor.uid,
    facility_id: Number(row.facility_id),
    reason: String(row.item_reason),
    created_at: row.item_created_at,
    source: {
      document_receipt_id: String(row.document_receipt_id),
      resource_receipt_id: String(row.resource_receipt_id),
      source_system: String(row.source_system),
      source_document_id: String(row.source_document_id),
      document_format: String(row.document_format),
      source_resource_type: String(row.source_resource_type),
      source_resource_id: row.source_resource_id == null ? null : String(row.source_resource_id),
      source_resource_index: Number(row.source_resource_index),
      error_code: row.resource_error_code || null,
      error: row.resource_error || null,
    },
    latest_event: {
      id: String(row.latest_event_id),
      event_type: String(row.latest_event_type),
      actor_uid: String(row.latest_event_actor_uid),
      reason: String(row.latest_event_reason),
      evidence_sha256: String(row.latest_event_evidence_sha256),
      created_at: row.latest_event_created_at,
    },
    held_terminal_action: {
      action: 'SUPERSEDE',
      status: 'HELD_EXTERNAL_AUTHORITY',
      required_authority: SUPERSESSION_AUTHORITY_GATE,
      endpoint: null,
    },
  };
}

function publicEvent(row) {
  if (String(row.event_type) === 'SUPERSEDED') {
    throw AppError.notFound(
      'Clinical import reconciliation event was not found',
      'IMPORT_RECONCILIATION_EVENT_NOT_FOUND',
    );
  }
  return {
    id: String(row.id),
    reconciliation_item_id: String(row.reconciliation_item_id),
    resource_receipt_id: String(row.resource_receipt_id),
    document_receipt_id: String(row.document_receipt_id),
    historical_patient_uid: String(row.patient_uid),
    facility_id: Number(row.facility_id),
    event_type: String(row.event_type),
    actor_uid: String(row.actor_uid),
    actor_role: String(row.actor_role),
    reason: String(row.reason),
    predecessor_event_id: row.predecessor_event_id == null
      ? null
      : String(row.predecessor_event_id),
    replacement_resource_receipt_id: row.replacement_resource_receipt_id == null
      ? null
      : String(row.replacement_resource_receipt_id),
    evidence_sha256: String(row.evidence_sha256),
    created_at: row.created_at,
  };
}

function reconciliationNextAction(eventType, itemId, documentFormat) {
  if (eventType !== 'RETRY_REQUESTED') return null;
  return {
    action: 'MANUAL_RESUBMISSION_REQUIRED',
    import_endpoint: documentFormat === 'ccda'
      ? '/api/v1/documents/import/ccd'
      : '/api/v1/documents/import/fhir-bundle',
    requirements: {
      original_source_document: true,
      new_source_document_id: true,
      new_idempotency_key: true,
      current_authority_grant: true,
      current_patient_access_decision: true,
      correction_item_header: {
        name: 'X-VH-Import-Correction-Item-Id',
        value: itemId,
      },
      correction_manifest_index_header: {
        name: 'X-VH-Import-Correction-Manifest-Index',
        value: 'zero-based replacement resource manifest index',
      },
    },
    after_success: {
      action: 'RESOLVE_WITH_REPLACEMENT_RECEIPT',
      endpoint: `/api/v1/documents/import/reconciliation/${itemId}/resolve`,
      body_field: 'replacement_resource_receipt_id',
    },
    if_no_legitimate_replacement_exists: {
      action: 'OWNER_SUPERSESSION_REVIEW_REQUIRED',
      status: 'HELD_EXTERNAL_AUTHORITY',
      required_authority: SUPERSESSION_AUTHORITY_GATE,
      endpoint: null,
    },
  };
}

export async function getClinicalImportReconciliationActionContext({
  tenantId,
  itemId,
  actorUid,
  actorRole,
}) {
  const tenant = requiredUuid(tenantId, 'tenantId');
  const item = requiredUuid(itemId, 'itemId');
  const actor = requireMedicalRecordsActor(actorUid, actorRole);
  return setTenantTx(tenant, async (tx) => {
    await requireActiveMedicalRecordsActorTx(tx, tenant, actor);
    const row = await loadItemTx(tx, tenant, item);
    const survivor = await resolveActivePatientSurvivorTx(tx, tenant, row.patient_uid);
    return accessContext(row, survivor);
  });
}

export async function assertClinicalImportReconciliationActionAuthority({
  tenantId,
  itemId,
  actorUid,
  actorRole,
  authorityGrantId,
}) {
  const tenant = requiredUuid(tenantId, 'tenantId');
  const item = requiredUuid(itemId, 'itemId');
  const actor = requireMedicalRecordsActor(actorUid, actorRole);
  const grant = requiredUuid(
    authorityGrantId,
    'authorityGrantId',
    'IMPORT_RECONCILIATION_GRANT_REQUIRED',
  );
  return setTenantTx(tenant, async (tx) => {
    await requireActiveMedicalRecordsActorTx(tx, tenant, actor);
    const rows = await tx.$queryRawUnsafe(
      `SELECT item.patient_uid, item.facility_id,
              document.source_system, document.document_format
         FROM clinical_import_reconciliation_items AS item
         JOIN clinical_import_document_receipts AS document
           ON document.tenant_id=item.tenant_id
          AND document.id=item.document_receipt_id
        WHERE item.tenant_id=$1::uuid
          AND item.id=$2::uuid
        LIMIT 1`,
      tenant,
      item,
    );
    if (!rows.length) {
      throw AppError.forbidden(
        'The clinical import authority grant is unavailable or outside the exact current scope',
        'IMPORT_RECONCILIATION_GRANT_UNAVAILABLE',
      );
    }
    const row = rows[0];
    const survivor = await resolveActivePatientSurvivorTx(tx, tenant, row.patient_uid);
    return lockClinicalImportAuthorityGrantTx(tx, {
      tenantId: tenant,
      authorityGrantId: grant,
      patientUid: survivor.uid,
      sourceFacilityId: Number(row.facility_id),
      actorUid: actor,
      sourceSystem: String(row.source_system),
      documentFormat: String(row.document_format),
    }, {
      unavailableCode: 'IMPORT_RECONCILIATION_GRANT_UNAVAILABLE',
      unavailableMessage:
        'The clinical import authority grant is unavailable or outside the exact current scope',
    });
  }, { isolationLevel: 'Serializable' });
}

export async function listClinicalImportReconciliationItems({
  tenantId,
  actorUid,
  actorRole,
  authorizeAccessBatch,
  auditReturnedItems,
  cursor = null,
}) {
  const tenant = requiredUuid(tenantId, 'tenantId');
  const actor = requireMedicalRecordsActor(actorUid, actorRole);
  if (typeof authorizeAccessBatch !== 'function') {
    throw AppError.internal(
      'Clinical import reconciliation access authorizer is unavailable',
      'IMPORT_RECONCILIATION_ACCESS_AUTHORIZER_REQUIRED',
    );
  }
  if (typeof auditReturnedItems !== 'function') {
    throw AppError.internal(
      'Clinical import reconciliation PHI auditor is unavailable',
      'IMPORT_RECONCILIATION_PHI_AUDITOR_REQUIRED',
    );
  }
  const decodedCursor = decodeWorklistCursor(cursor, tenant);
  return setTenantTx(tenant, async (tx) => {
    const budget = worklistDbBudget(tx);
    const db = budget.db;
    const deadlineMs = Date.now() + LIST_SCAN_TIME_BUDGET_MS;
    await applyRemainingStatementTimeout(db, deadlineMs);
    await acquireTenantWorklistLock(db, tenant);
    await requireActiveMedicalRecordsActorTx(db, tenant, actor);
    const authorized = [];
    let scanCursor = decodedCursor;
    let scannedRows = 0;
    let queryCount = 0;
    let lastScannedRow = null;
    let sourceExhausted = false;
    let budgetExhausted = false;
    while (authorized.length < LIST_LIMIT) {
      if (scannedRows >= LIST_SCAN_ROW_LIMIT
        || queryCount >= LIST_SCAN_QUERY_LIMIT
        || Date.now() >= deadlineMs) {
        budgetExhausted = true;
        break;
      }
      const batchLimit = Math.min(
        LIST_SCAN_BATCH_SIZE,
        LIST_SCAN_ROW_LIMIT - scannedRows,
      );
      await applyRemainingStatementTimeout(db, deadlineMs);
      const rows = await db.$queryRawUnsafe(
        `${ITEM_SELECT}
          WHERE item.tenant_id=$1::uuid
            AND latest.event_type IN ('OPENED', 'RETRY_REQUESTED')
            AND (
              $2::timestamptz IS NULL
              OR (item.created_at, item.id) > ($2::timestamptz, $3::uuid)
           )
          ORDER BY item.created_at, item.id
          LIMIT $4::int`,
        tenant,
        scanCursor.createdAt,
        scanCursor.itemId,
        batchLimit,
      );
      queryCount += 1;
      if (rows.length === 0) {
        sourceExhausted = true;
        break;
      }

      await applyRemainingStatementTimeout(db, deadlineMs);
      const survivors = await resolveActivePatientSurvivorsTx(
        db,
        tenant,
        rows.map(row => row.patient_uid),
      );
      const accessEntries = [];
      for (const row of rows) {
        const survivor = survivors.get(String(row.patient_uid).toLowerCase());
        if (survivor) {
          accessEntries.push({
            decisionKey: String(row.id),
            context: accessContext(row, survivor),
          });
        }
      }
      await applyRemainingStatementTimeout(db, deadlineMs);
      const accessDecisions = new Map((await authorizeAccessBatch({
        db,
        entries: accessEntries,
      })).map(decision => [String(decision.decisionKey), decision]));
      if (accessDecisions.size !== accessEntries.length
        || accessEntries.some(entry => !accessDecisions.has(entry.decisionKey))) {
        throw AppError.serviceUnavailable(
          'Clinical import reconciliation access batch returned an incomplete decision set',
          'IMPORT_RECONCILIATION_ACCESS_BATCH_INCOMPLETE',
        );
      }
      let evaluatedInBatch = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const survivor = survivors.get(String(row.patient_uid).toLowerCase());
        if (!survivor) {
          scannedRows += 1;
          evaluatedInBatch += 1;
          lastScannedRow = row;
          continue;
        }
        const decision = accessDecisions.get(String(row.id));
        scannedRows += 1;
        evaluatedInBatch += 1;
        lastScannedRow = row;
        if (decision?.allowed === true) {
          authorized.push({ row, survivor });
          if (authorized.length === LIST_LIMIT) break;
        }
      }
      if (authorized.length === LIST_LIMIT || budgetExhausted) break;
      if (evaluatedInBatch === rows.length && rows.length < batchLimit) {
        sourceExhausted = true;
        break;
      }
      scanCursor = {
        createdAt: new Date(lastScannedRow.item_created_at).toISOString(),
        itemId: String(lastScannedRow.id).toLowerCase(),
      };
    }
    const needsContinuation = lastScannedRow != null
      && !sourceExhausted
      && (budgetExhausted || authorized.length === LIST_LIMIT
        || scannedRows >= LIST_SCAN_ROW_LIMIT
        || queryCount >= LIST_SCAN_QUERY_LIMIT);
    const items = authorized.map(({ row, survivor }) => publicItem(row, survivor, actor));
    await applyRemainingStatementTimeout(db, deadlineMs);
    await auditReturnedItems({ db, items });
    return {
      items,
      nextCursor: needsContinuation ? encodeWorklistCursor(lastScannedRow, tenant) : null,
    };
  }, {
    isolationLevel: 'RepeatableRead',
    timeout: LIST_TRANSACTION_TIMEOUT_MS,
  });
}

async function lockCurrentAuthorityTx(tx, {
  tenantId,
  authorityGrantId,
  patientUid,
  facilityId,
  actorUid,
  sourceSystem,
  documentFormat,
}) {
  return lockClinicalImportAuthorityGrantTx(tx, {
    tenantId,
    authorityGrantId,
    patientUid,
    sourceFacilityId: facilityId,
    actorUid,
    sourceSystem,
    documentFormat,
  }, {
    unavailableCode: 'IMPORT_RECONCILIATION_GRANT_UNAVAILABLE',
    unavailableMessage:
      'The clinical import authority grant is unavailable or outside the exact current scope',
  });
}

async function findIdempotentEventTx(tx, tenantId, idempotencyKeySha256) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT event.id, event.reconciliation_item_id,
            event.resource_receipt_id, event.document_receipt_id,
            event.patient_uid, event.facility_id, event.event_type,
            event.actor_uid, event.actor_role, event.reason,
            event.predecessor_event_id, event.replacement_resource_receipt_id,
            event.idempotency_key_sha256,
            event.evidence, event.evidence_sha256, event.created_at
       FROM clinical_import_reconciliation_events AS event
      WHERE event.tenant_id=$1::uuid
        AND event.idempotency_key_sha256=$2::char(64)
      LIMIT 1`,
    tenantId,
    idempotencyKeySha256,
  );
  return rows[0] || null;
}

function isExactReplay(row, request) {
  const storedRequest = row?.evidence?.request;
  return String(row?.reconciliation_item_id || '').toLowerCase() === request.itemId
    && String(row?.event_type || '') === request.eventType
    && String(row?.actor_uid || '').toLowerCase() === request.actorUid
    && String(row?.actor_role || '') === MEDICAL_RECORDS_ROLE
    && String(row?.reason || '') === request.reason
    && row?.evidence?.contract_version === 'clinical-import-reconciliation-event-v1'
    && storedRequest?.event_type === request.eventType
    && storedRequest?.reason === request.reason
    && String(storedRequest?.authority_grant_id || '').toLowerCase() === request.authorityGrantId
    && String(storedRequest?.replacement_resource_receipt_id || '').toLowerCase()
      === String(request.replacementResourceReceiptId || '').toLowerCase();
}

async function loadReplacementReceiptTx(tx, {
  tenantId,
  receiptId,
  item,
  activePatientUid,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT replacement.id, replacement.document_receipt_id,
            replacement.patient_uid, replacement.source_resource_type,
            replacement.source_resource_id, replacement.source_resource_index,
            replacement.source_identity_sha256, replacement.payload_sha256,
            replacement.outcome, replacement.target_table, replacement.target_id,
             replacement.canonical_timeline_event_id,
             replacement.canonical_audit_event_id,
             replacement.correction_reconciliation_item_id,
             replacement.correction_original_resource_receipt_id,
             replacement.correction_retry_event_id,
             replacement.evidence, replacement.created_at,
            replacement_document.source_system,
            replacement_document.source_document_id,
            replacement_document.document_format,
            replacement_document.source_facility_id,
            replacement_document.canonical_timeline_event_id
              AS document_canonical_timeline_event_id,
            replacement_document.canonical_audit_event_id
              AS document_canonical_audit_event_id
       FROM clinical_import_resource_receipts AS replacement
       JOIN clinical_import_document_receipts AS replacement_document
         ON replacement_document.tenant_id=replacement.tenant_id
        AND replacement_document.id=replacement.document_receipt_id
        AND replacement_document.patient_uid=replacement.patient_uid
      WHERE replacement.tenant_id=$1::uuid
        AND replacement.id=$2::uuid
        AND replacement.outcome IN ('imported', 'deduplicated')`,
    tenantId,
    receiptId,
  );
  if (!rows.length) {
    throw AppError.conflict(
      'Resolution requires a committed imported or deduplicated replacement receipt',
      'IMPORT_RECONCILIATION_REPLACEMENT_REQUIRED',
    );
  }
  const replacement = rows[0];
  if (String(item.latest_event_type) !== 'RETRY_REQUESTED') {
    throw AppError.conflict(
      'Resolution requires a current retry request and its causally bound replacement',
      'IMPORT_RECONCILIATION_RETRY_REQUIRED',
    );
  }
  const replacementBoundary = item.latest_event_created_at;
  if (new Date(replacement.created_at).getTime() <= new Date(replacementBoundary).getTime()) {
    throw AppError.conflict(
      'Replacement receipt predates the reconciliation retry boundary',
      'IMPORT_RECONCILIATION_REPLACEMENT_STALE',
    );
  }
  const sameSourceResource = item.source_resource_id == null
    ? Number(replacement.source_resource_index) === Number(item.source_resource_index)
    : String(replacement.source_resource_id) === String(item.source_resource_id);
  if (String(replacement.correction_reconciliation_item_id).toLowerCase()
      !== String(item.id).toLowerCase()
    || String(replacement.correction_original_resource_receipt_id).toLowerCase()
      !== String(item.resource_receipt_id).toLowerCase()
    || String(replacement.correction_retry_event_id).toLowerCase()
      !== String(item.latest_event_id).toLowerCase()
    || String(replacement.source_resource_type) !== String(item.source_resource_type)
    || !sameSourceResource
    || String(replacement.source_system) !== String(item.source_system)
    || String(replacement.document_format) !== String(item.document_format)
    || Number(replacement.source_facility_id) !== Number(item.facility_id)) {
    throw AppError.conflict(
      'Replacement receipt does not match the failed source resource and authority scope',
      'IMPORT_RECONCILIATION_REPLACEMENT_MISMATCH',
    );
  }
  const replacementSurvivor = await resolveActivePatientSurvivorTx(
    tx,
    tenantId,
    replacement.patient_uid,
  );
  if (replacementSurvivor.uid !== activePatientUid) {
    throw AppError.conflict(
      'Replacement receipt belongs to a different patient custody family',
      'IMPORT_RECONCILIATION_REPLACEMENT_PATIENT_MISMATCH',
    );
  }
  return replacement;
}

async function appendReconciliationEvent({
  tenantId,
  itemId,
  actorUid,
  actorRole,
  reason,
  idempotencyKey,
  authorityGrantId,
  revalidateAccess,
  eventType,
  replacementResourceReceiptId = null,
}) {
  const tenant = requiredUuid(tenantId, 'tenantId');
  const item = requiredUuid(itemId, 'itemId');
  const actor = requireMedicalRecordsActor(actorUid, actorRole);
  const normalizedReason = requiredReason(reason);
  const normalizedKey = requiredIdempotencyKey(idempotencyKey);
  const grant = requiredUuid(
    authorityGrantId,
    'authorityGrantId',
    'IMPORT_RECONCILIATION_GRANT_REQUIRED',
  );
  if (!ACTION_EVENT_TYPES.has(eventType)) {
    throw AppError.badRequest(
      'Unsupported clinical import reconciliation action',
      'IMPORT_RECONCILIATION_ACTION_INVALID',
    );
  }
  const replacementId = eventType === 'RESOLVED'
    ? requiredUuid(
      replacementResourceReceiptId,
      'replacementResourceReceiptId',
      'IMPORT_RECONCILIATION_REPLACEMENT_REQUIRED',
    )
    : null;
  const idempotencyKeySha256 = clinicalImportSha256(normalizedKey);
  if (typeof revalidateAccess !== 'function') {
    throw AppError.internal(
      'Clinical import reconciliation access revalidation is unavailable',
      'IMPORT_RECONCILIATION_ACCESS_REVALIDATION_REQUIRED',
    );
  }
  const request = {
    itemId: item,
    eventType,
    actorUid: actor,
    reason: normalizedReason,
    authorityGrantId: grant,
    replacementResourceReceiptId: replacementId,
  };

  return setTenantTx(tenant, async (tx) => {
    await lockTenantPatientMergeStability(tx, tenant);
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 760))::text
         AS lock_acquired`,
      `vh:clinical_import_reconciliation:${tenant}:${item}`,
    );
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 760))::text
         AS lock_acquired`,
      `vh:clinical_import_reconciliation:idempotency:${tenant}:${idempotencyKeySha256}`,
    );
    const itemRow = await loadItemTx(tx, tenant, item);
    const survivor = await resolveActivePatientSurvivorTx(tx, tenant, itemRow.patient_uid);
    const currentContext = accessContext(itemRow, survivor);
    const accessEvidence = normalizeAccessDecisionEvidence(await revalidateAccess({
      db: tx,
      context: currentContext,
    }), {
      actorUid: actor,
      patientUid: survivor.uid,
    });
    const ownerEvidenceSha256 = await lockCurrentAuthorityTx(tx, {
      tenantId: tenant,
      authorityGrantId: grant,
      patientUid: survivor.uid,
      facilityId: Number(itemRow.facility_id),
      actorUid: actor,
      sourceSystem: String(itemRow.source_system),
      documentFormat: String(itemRow.document_format),
    });

    const existing = await findIdempotentEventTx(tx, tenant, idempotencyKeySha256);
    if (existing) {
      if (!isExactReplay(existing, request)) {
        throw AppError.conflict(
          'Idempotency-Key was already used for a different reconciliation action',
          'IMPORT_RECONCILIATION_IDEMPOTENCY_MISMATCH',
        );
      }
      return {
        event: publicEvent(existing),
        replayed: true,
        next_action: String(itemRow.latest_event_type) === eventType
          ? reconciliationNextAction(eventType, item, itemRow.document_format)
          : null,
      };
    }

    if (!OPEN_EVENT_TYPES.has(String(itemRow.latest_event_type))) {
      throw AppError.conflict(
        'Clinical import reconciliation is already terminal',
        'IMPORT_RECONCILIATION_ALREADY_TERMINAL',
      );
    }
    if (eventType === 'RETRY_REQUESTED') {
      const committedCorrections = await tx.$queryRawUnsafe(
        `SELECT replacement.id
           FROM clinical_import_resource_receipts AS replacement
          WHERE replacement.tenant_id=$1::uuid
            AND replacement.correction_reconciliation_item_id=$2::uuid
          LIMIT 1`,
        tenant,
        item,
      );
      if (committedCorrections.length) {
        throw AppError.conflict(
          'A committed correction receipt must be resolved before another retry can be requested',
          'IMPORT_RECONCILIATION_CORRECTION_PENDING_RESOLUTION',
        );
      }
    }
    let replacement = null;
    if (eventType === 'RESOLVED') {
      replacement = await loadReplacementReceiptTx(tx, {
        tenantId: tenant,
        receiptId: replacementId,
        item: itemRow,
        activePatientUid: survivor.uid,
      });
    }

    const evidence = stableValue({
      contract_version: 'clinical-import-reconciliation-event-v1',
      request: {
        event_type: eventType,
        reason: normalizedReason,
        authority_grant_id: grant,
        replacement_resource_receipt_id: replacementId,
      },
      custody: {
        historical_patient_uid: String(itemRow.patient_uid).toLowerCase(),
        active_survivor_patient_uid: survivor.uid,
      },
      source_authority: {
        authority_grant_id: grant,
        owner_evidence_sha256: ownerEvidenceSha256,
        source_facility_id: Number(itemRow.facility_id),
        source_system: String(itemRow.source_system),
        document_format: String(itemRow.document_format),
      },
      patient_access: accessEvidence,
      replacement_receipt: replacement ? {
        resource_receipt_id: String(replacement.id),
        document_receipt_id: String(replacement.document_receipt_id),
        patient_uid: String(replacement.patient_uid),
        source_system: String(replacement.source_system),
        source_document_id: String(replacement.source_document_id),
        document_format: String(replacement.document_format),
        source_resource_type: String(replacement.source_resource_type),
        source_resource_id: replacement.source_resource_id == null
          ? null
          : String(replacement.source_resource_id),
        source_resource_index: Number(replacement.source_resource_index),
        source_identity_sha256: String(replacement.source_identity_sha256),
        payload_sha256: String(replacement.payload_sha256),
        outcome: String(replacement.outcome),
        target_table: String(replacement.target_table),
        target_id: String(replacement.target_id),
        resource_canonical_timeline_event_id:
          replacement.canonical_timeline_event_id || null,
        resource_canonical_audit_event_id:
          replacement.canonical_audit_event_id || null,
        document_canonical_timeline_event_id:
          replacement.document_canonical_timeline_event_id,
        document_canonical_audit_event_id:
          replacement.document_canonical_audit_event_id,
        receipt_evidence_sha256: clinicalImportSha256(replacement.evidence),
        correction_reconciliation_item_id:
          String(replacement.correction_reconciliation_item_id),
        correction_original_resource_receipt_id:
          String(replacement.correction_original_resource_receipt_id),
        correction_retry_event_id: String(replacement.correction_retry_event_id),
      } : null,
    });
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_import_reconciliation_events
       (tenant_id, reconciliation_item_id, resource_receipt_id,
          document_receipt_id, patient_uid, facility_id, event_type,
          actor_uid, actor_role, reason, predecessor_event_id,
          replacement_resource_receipt_id, idempotency_key_sha256,
          evidence, contract_version)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::int,
          $7::text, $8::uuid, 'MEDICAL_RECORDS', $9::text, $10::uuid,
          $11::uuid, $12::char(64), $13::jsonb, 1)
       RETURNING id, reconciliation_item_id, resource_receipt_id,
                 document_receipt_id, patient_uid, facility_id, event_type,
                 actor_uid, actor_role, reason, predecessor_event_id,
                 replacement_resource_receipt_id, idempotency_key_sha256,
                 evidence, evidence_sha256, created_at`,
      tenant,
      item,
      itemRow.resource_receipt_id,
      itemRow.document_receipt_id,
      itemRow.patient_uid,
      Number(itemRow.facility_id),
      eventType,
      actor,
      normalizedReason,
      itemRow.latest_event_id,
      replacementId,
      idempotencyKeySha256,
      JSON.stringify(evidence),
    );
    return {
      event: publicEvent(inserted[0]),
      replayed: false,
      next_action: reconciliationNextAction(eventType, item, itemRow.document_format),
    };
  }, {
    isolationLevel: 'Serializable',
    timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS,
  });
}

export function requestClinicalImportRetry(input) {
  return appendReconciliationEvent({ ...input, eventType: 'RETRY_REQUESTED' });
}

export function resolveClinicalImportReconciliation(input) {
  return appendReconciliationEvent({ ...input, eventType: 'RESOLVED' });
}

export const __testing__ = {
  isExactReplay,
  normalizeAccessDecisionEvidence,
};

export default {
  getClinicalImportReconciliationActionContext,
  assertClinicalImportReconciliationActionAuthority,
  listClinicalImportReconciliationItems,
  requestClinicalImportRetry,
  resolveClinicalImportReconciliation,
};
