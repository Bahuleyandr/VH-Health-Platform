import crypto from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { validateCode } from '../terminology/terminologyService.js';
import { orderRequestFromItem, VALID_ORDER_TYPES } from './orderEntryService.js';

export const ORDER_SET_AUTHOR_ROLES = [
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'ADMIN',
  'SUPER_ADMIN',
];

export const ORDER_SET_APPROVER_ROLES = [
  'ADMIN',
  'SUPER_ADMIN',
  'QUALITY_OFFICER',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
  'CONSULTANT',
];

export const ORDER_SET_PHARMACY_REVIEW_ROLES = ['PHARMACY_INCHARGE'];

const normalizeRole = (role) => String(role || '').trim().toUpperCase();
const hasRole = (actor, roles) => roles.includes(normalizeRole(actor?.role));

function requireActor(actor) {
  if (!actor?.uid) {
    throw AppError.unauthorized('Authenticated actor is required');
  }
  return { uid: actor.uid, role: normalizeRole(actor.role) };
}

function requireRole(actor, roles, message) {
  const normalized = requireActor(actor);
  if (!hasRole(normalized, roles)) {
    throw AppError.forbidden(message);
  }
  return normalized;
}

function toJson(value) {
  return JSON.stringify(value ?? {});
}

function normalizeFamilyKey(value, fallback) {
  const raw = String(value || fallback || '').trim().toUpperCase();
  const key = raw.replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!key) throw AppError.badRequest('family_key is required', 'ORDER_SET_INVALID_FAMILY');
  return key;
}

function codeForFamilyVersion(familyKey, version) {
  return `${familyKey}-V${version}-${Date.now()}`.slice(0, 60);
}

async function insertEvent(tx, tenantId, orderSetId, action, actor, note = null, metadata = {}) {
  const normalized = requireActor(actor);
  await tx.$executeRawUnsafe(
    `INSERT INTO order_set_review_events
       (tenant_id, order_set_id, action, actor_uid, actor_role, note, metadata)
     VALUES ($1::uuid, $2::int, $3, $4::uuid, $5, $6, $7::jsonb)`,
    tenantId,
    Number(orderSetId),
    action,
    normalized.uid,
    normalized.role,
    note || null,
    toJson(metadata),
  );
}

async function fetchOrderSet(tx, tenantId, orderSetId, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM clinical_order_sets
      WHERE tenant_id = $1::uuid AND id = $2::int
      ${lock ? 'FOR UPDATE' : ''}`,
    tenantId,
    Number(orderSetId),
  );
  if (!rows[0]) {
    throw AppError.notFound('Order set not found');
  }
  return rows[0];
}

async function fetchItems(tx, tenantId, orderSetId) {
  return tx.$queryRawUnsafe(
    `SELECT *
       FROM clinical_order_set_items
      WHERE tenant_id = $1::uuid AND order_set_id = $2::int
      ORDER BY display_order ASC, id ASC`,
    tenantId,
    Number(orderSetId),
  );
}

async function fetchReviewEvents(tx, tenantId, orderSetIds) {
  if (!orderSetIds.length) return [];
  return tx.$queryRawUnsafe(
    `SELECT *
       FROM order_set_review_events
      WHERE tenant_id = $1::uuid AND order_set_id = ANY($2::int[])
      ORDER BY created_at ASC, id ASC`,
    tenantId,
    orderSetIds.map(Number),
  );
}

function itemHasMedication(item) {
  const kind = String(item.kind || '').toLowerCase();
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  return kind === 'med'
    || kind === 'medication'
    || Boolean(payload.drug || payload.medication_name || payload.medication);
}

async function validateCodings({ conditionCodes = [], items = [] }) {
  const warnings = [];
  for (const code of conditionCodes || []) {
    if (!code) continue;
    try {
      const verdict = await validateCode('ICD10', code);
      if (!verdict.valid) {
        warnings.push({ system: 'ICD10', code, reason: verdict.reason || 'not_validated' });
      }
    } catch (_err) {
      warnings.push({ system: 'ICD10', code, reason: 'validation_unavailable' });
    }
  }

  for (const [index, item] of items.entries()) {
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
    const codings = Array.isArray(payload.codings) ? payload.codings : [];
    for (const coding of codings) {
      if (!coding?.system || !coding?.code) continue;
      try {
        const verdict = await validateCode(coding.system, coding.code);
        if (!verdict.valid) {
          warnings.push({
            item_index: index,
            system: coding.system,
            code: coding.code,
            reason: verdict.reason || 'not_validated',
          });
        }
        } catch (_err) {
          warnings.push({
            item_index: index,
            system: coding.system,
          code: coding.code,
          reason: 'validation_unavailable',
        });
      }
    }
  }
  return warnings;
}

export async function validateOrderSetItems({ title, conditionCodes = [], items = [] }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('Order set requires at least one item', 'ORDER_SET_EMPTY');
  }

  for (const [index, item] of items.entries()) {
    const request = orderRequestFromItem(item, title || 'Order set');
    if (!VALID_ORDER_TYPES.includes(request.order_type)) {
      throw AppError.badRequest(
        `Item ${index + 1} maps to invalid order_type: ${request.order_type}`,
        'ORDER_SET_ITEM_INVALID_TYPE',
      );
    }
    if (!request.details || typeof request.details !== 'object' || Array.isArray(request.details)) {
      throw AppError.badRequest(`Item ${index + 1} requires a payload object`, 'ORDER_SET_ITEM_INVALID_PAYLOAD');
    }
  }

  const warnings = await validateCodings({ conditionCodes, items });
  return {
    warnings,
    requiresPharmacyReview: items.some(itemHasMedication),
  };
}

function shapeOrderSet(row, items = [], events = []) {
  return {
    id: Number(row.id),
    code: row.code,
    family_key: row.family_key,
    version: Number(row.version || 1),
    status: row.status,
    active: row.active === true,
    title: row.title,
    name: row.title,
    specialty: row.specialty,
    category: row.specialty,
    condition_codes: row.condition_codes || [],
    description: row.description ?? null,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    review_note: row.review_note ?? null,
    superseded_by: row.superseded_by ?? null,
    source: row.source || 'authored',
    import_batch_id: row.import_batch_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    requires_pharmacy_review: items.some(itemHasMedication),
    has_pharmacy_review: events.some((event) =>
      event.action === 'approve'
      && event.actor_role === 'PHARMACY_INCHARGE'
      && event.metadata?.review_type === 'pharmacy_second_review'),
    items: items.map((item) => ({
      id: Number(item.id),
      display_order: Number(item.display_order),
      kind: item.kind,
      payload: item.payload,
      default_selected: item.default_selected === true,
      created_at: item.created_at,
    })),
    events: events.map((event) => ({
      id: Number(event.id),
      action: event.action,
      actor_uid: event.actor_uid,
      actor_role: event.actor_role,
      note: event.note,
      metadata: event.metadata || {},
      created_at: event.created_at,
    })),
  };
}

export async function listOrderSetsForStudio({ tenantId, status = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  return setTenantTx(scopedTenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM clinical_order_sets
        WHERE tenant_id = $1::uuid
          AND ($2::text IS NULL OR status = $2::text)
        ORDER BY family_key ASC, version DESC, created_at DESC`,
      scopedTenantId,
      status || null,
    );
    const ids = rows.map((row) => Number(row.id));
    if (!ids.length) return [];
    const items = await tx.$queryRawUnsafe(
      `SELECT *
         FROM clinical_order_set_items
        WHERE tenant_id = $1::uuid AND order_set_id = ANY($2::int[])
        ORDER BY order_set_id ASC, display_order ASC, id ASC`,
      scopedTenantId,
      ids,
    );
    const events = await fetchReviewEvents(tx, scopedTenantId, ids);
    const itemsBySet = new Map();
    const eventsBySet = new Map();
    for (const item of items) {
      const key = Number(item.order_set_id);
      if (!itemsBySet.has(key)) itemsBySet.set(key, []);
      itemsBySet.get(key).push(item);
    }
    for (const event of events) {
      const key = Number(event.order_set_id);
      if (!eventsBySet.has(key)) eventsBySet.set(key, []);
      eventsBySet.get(key).push(event);
    }
    return rows.map((row) => shapeOrderSet(
      row,
      itemsBySet.get(Number(row.id)) || [],
      eventsBySet.get(Number(row.id)) || [],
    ));
  });
}

export async function submitOrderSetForReview({ tenantId, orderSetId, actor, note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_AUTHOR_ROLES, 'Only order-set authors can submit drafts');
  return setTenantTx(scopedTenantId, async (tx) => {
    const set = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (set.status !== 'draft') {
      throw AppError.invalidTransition(set.status, 'in_review', ['draft']);
    }
    const items = await fetchItems(tx, scopedTenantId, set.id);
    const validation = await validateOrderSetItems({
      title: set.title,
      conditionCodes: set.condition_codes,
      items,
    });
    await tx.$executeRawUnsafe(
      `UPDATE clinical_order_sets
          SET status = 'in_review', review_note = $3, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      scopedTenantId,
      Number(set.id),
      note || null,
    );
    await insertEvent(tx, scopedTenantId, set.id, 'submit', normalized, note, {
      warnings: validation.warnings,
      requires_pharmacy_review: validation.requiresPharmacyReview,
    });
    return shapeOrderSet(
      { ...set, status: 'in_review', review_note: note || null },
      items,
      await fetchReviewEvents(tx, scopedTenantId, [set.id]),
    );
  });
}

export async function recordPharmacyReview({ tenantId, orderSetId, actor, note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_PHARMACY_REVIEW_ROLES, 'Only pharmacy in-charge can record the medication-set review');
  return setTenantTx(scopedTenantId, async (tx) => {
    const set = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (set.status !== 'in_review') {
      throw AppError.invalidTransition(set.status, 'pharmacy_review', ['in_review']);
    }
    const items = await fetchItems(tx, scopedTenantId, set.id);
    if (!items.some(itemHasMedication)) {
      throw AppError.badRequest('Pharmacy review is only required for medication-containing order sets');
    }
    await insertEvent(tx, scopedTenantId, set.id, 'approve', normalized, note, {
      review_type: 'pharmacy_second_review',
    });
    return shapeOrderSet(set, items, await fetchReviewEvents(tx, scopedTenantId, [set.id]));
  });
}

export async function approveOrderSet({ tenantId, orderSetId, actor, note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_APPROVER_ROLES, 'Only order-set approvers can approve content');
  return setTenantTx(scopedTenantId, async (tx) => {
    const set = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (set.status !== 'in_review') {
      throw AppError.invalidTransition(set.status, 'approved', ['in_review']);
    }
    if (set.created_by && String(set.created_by) === String(normalized.uid)) {
      throw AppError.forbidden('Order-set authors cannot self-approve their own set', 'ORDER_SET_SELF_APPROVAL_REJECTED');
    }

    const items = await fetchItems(tx, scopedTenantId, set.id);
    const validation = await validateOrderSetItems({
      title: set.title,
      conditionCodes: set.condition_codes,
      items,
    });
    const existingEvents = await fetchReviewEvents(tx, scopedTenantId, [set.id]);
    if (validation.requiresPharmacyReview) {
      const hasSecondReview = existingEvents.some((event) =>
        event.action === 'approve'
        && event.actor_role === 'PHARMACY_INCHARGE'
        && event.metadata?.review_type === 'pharmacy_second_review'
        && String(event.actor_uid) !== String(normalized.uid));
      if (!hasSecondReview) {
        throw AppError.badRequest(
          'Medication-containing order sets require PHARMACY_INCHARGE review before approval',
          'ORDER_SET_PHARMACY_REVIEW_REQUIRED',
        );
      }
    }

    const predecessorRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM clinical_order_sets
        WHERE tenant_id = $1::uuid
          AND family_key = $2
          AND id <> $3::int
          AND status = 'approved'
          AND active = TRUE
        ORDER BY version DESC
        LIMIT 1
        FOR UPDATE`,
      scopedTenantId,
      set.family_key,
      Number(set.id),
    );
    const predecessor = predecessorRows[0] || null;
    if (predecessor) {
      await tx.$executeRawUnsafe(
        `UPDATE clinical_order_sets
            SET status = 'retired', active = FALSE, superseded_by = $3::int, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        scopedTenantId,
        Number(predecessor.id),
        Number(set.id),
      );
      await insertEvent(tx, scopedTenantId, predecessor.id, 'retire', normalized, 'Retired by successor approval', {
        successor_order_set_id: Number(set.id),
      });
    }

    const approvedRows = await tx.$queryRawUnsafe(
      `UPDATE clinical_order_sets
          SET status = 'approved',
              active = TRUE,
              approved_by = $3::uuid,
              approved_at = NOW(),
              review_note = $4,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      scopedTenantId,
      Number(set.id),
      normalized.uid,
      note || null,
    );
    await insertEvent(tx, scopedTenantId, set.id, 'approve', normalized, note, {
      review_type: 'governance_approval',
      warnings: validation.warnings,
      retired_predecessor_id: predecessor ? Number(predecessor.id) : null,
    });
    await insertEvent(tx, scopedTenantId, set.id, 'deploy', normalized, note, {
      family_key: set.family_key,
      version: Number(set.version),
    });
    return shapeOrderSet(approvedRows[0], items, await fetchReviewEvents(tx, scopedTenantId, [set.id]));
  });
}

export async function rejectOrderSet({ tenantId, orderSetId, actor, note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_APPROVER_ROLES, 'Only order-set approvers can reject content');
  return setTenantTx(scopedTenantId, async (tx) => {
    const set = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (set.status !== 'in_review') {
      throw AppError.invalidTransition(set.status, 'draft', ['in_review']);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE clinical_order_sets
          SET status = 'draft', review_note = $3, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      scopedTenantId,
      Number(set.id),
      note || null,
    );
    await insertEvent(tx, scopedTenantId, set.id, 'reject', normalized, note);
    return shapeOrderSet(
      rows[0],
      await fetchItems(tx, scopedTenantId, set.id),
      await fetchReviewEvents(tx, scopedTenantId, [set.id]),
    );
  });
}

export async function retireOrderSet({ tenantId, orderSetId, actor, note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_APPROVER_ROLES, 'Only order-set approvers can retire content');
  return setTenantTx(scopedTenantId, async (tx) => {
    const set = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (set.status === 'retired') return shapeOrderSet(set, await fetchItems(tx, scopedTenantId, set.id));
    const rows = await tx.$queryRawUnsafe(
      `UPDATE clinical_order_sets
          SET status = 'retired', active = FALSE, review_note = $3, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      scopedTenantId,
      Number(set.id),
      note || null,
    );
    await insertEvent(tx, scopedTenantId, set.id, 'retire', normalized, note);
    return shapeOrderSet(
      rows[0],
      await fetchItems(tx, scopedTenantId, set.id),
      await fetchReviewEvents(tx, scopedTenantId, [set.id]),
    );
  });
}

export async function rollbackOrderSet({ tenantId, orderSetId, actor, note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_APPROVER_ROLES, 'Only order-set approvers can roll back content');
  return setTenantTx(scopedTenantId, async (tx) => {
    const current = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (current.status !== 'approved' || current.active !== true) {
      throw AppError.invalidTransition(current.status, 'rollback', ['approved']);
    }
    const predecessorRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM clinical_order_sets
        WHERE tenant_id = $1::uuid
          AND superseded_by = $2::int
          AND status = 'retired'
        ORDER BY version DESC
        LIMIT 1
        FOR UPDATE`,
      scopedTenantId,
      Number(current.id),
    );
    const predecessor = predecessorRows[0];
    if (!predecessor) {
      throw AppError.badRequest('No predecessor is available for rollback', 'ORDER_SET_ROLLBACK_UNAVAILABLE');
    }

    await tx.$executeRawUnsafe(
      `UPDATE clinical_order_sets
          SET status = 'retired', active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      scopedTenantId,
      Number(current.id),
    );
    const restoredRows = await tx.$queryRawUnsafe(
      `UPDATE clinical_order_sets
          SET status = 'approved', active = TRUE, superseded_by = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      scopedTenantId,
      Number(predecessor.id),
    );
    await insertEvent(tx, scopedTenantId, current.id, 'rollback', normalized, note, {
      restored_order_set_id: Number(predecessor.id),
    });
    await insertEvent(tx, scopedTenantId, predecessor.id, 'deploy', normalized, note, {
      rollback_from_order_set_id: Number(current.id),
    });
    return shapeOrderSet(
      restoredRows[0],
      await fetchItems(tx, scopedTenantId, predecessor.id),
      await fetchReviewEvents(tx, scopedTenantId, [predecessor.id]),
    );
  });
}

export async function cloneOrderSetVersion({ tenantId, orderSetId, actor, note: _note = null }) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_AUTHOR_ROLES, 'Only order-set authors can clone versions');
  return setTenantTx(scopedTenantId, async (tx) => {
    const source = await fetchOrderSet(tx, scopedTenantId, orderSetId, { lock: true });
    if (source.status !== 'approved') {
      throw AppError.badRequest('Only approved order sets can be cloned into a new draft version');
    }
    const versionRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
         FROM clinical_order_sets
        WHERE tenant_id = $1::uuid AND family_key = $2`,
      scopedTenantId,
      source.family_key,
    );
    const nextVersion = Number(versionRows[0]?.next_version || Number(source.version || 1) + 1);
    const code = codeForFamilyVersion(source.family_key, nextVersion);
    const createdRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_order_sets
         (code, title, specialty, condition_codes, description, active, created_by,
          tenant_id, family_key, version, status, source)
       VALUES ($1, $2, $3, $4::text[], $5, TRUE, $6::uuid,
               $7::uuid, $8, $9::int, 'draft', 'authored')
       RETURNING *`,
      code,
      source.title,
      source.specialty,
      source.condition_codes || [],
      source.description,
      normalized.uid,
      scopedTenantId,
      source.family_key,
      nextVersion,
    );
    const draft = createdRows[0];
    const sourceItems = await fetchItems(tx, scopedTenantId, source.id);
    for (const item of sourceItems) {
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_order_set_items
           (order_set_id, display_order, kind, payload, default_selected, tenant_id)
         VALUES ($1::int, $2::int, $3, $4::jsonb, $5, $6::uuid)`,
        Number(draft.id),
        Number(item.display_order),
        item.kind,
        toJson(item.payload),
        item.default_selected === true,
        scopedTenantId,
      );
    }
    logger.info(`Order-set draft version cloned: family=${source.family_key} version=${nextVersion} by=${normalized.uid}`);
    const items = await fetchItems(tx, scopedTenantId, draft.id);
    return shapeOrderSet(draft, items, []);
  });
}

function normalizeImportDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw AppError.badRequest('Import document must be a JSON object');
  }
  if (document.format !== 'vh-order-set/1') {
    throw AppError.badRequest('Order-set import format must be vh-order-set/1');
  }
  const familyKey = normalizeFamilyKey(document.family_key, document.title);
  const title = String(document.title || '').trim();
  const specialty = String(document.specialty || '').trim();
  if (!title || !specialty) {
    throw AppError.badRequest('Import document requires title and specialty');
  }

  const phaseGroups = Array.isArray(document.phases)
    ? document.phases.map((phase) => ({
      phase: phase?.phase ?? phase?.label ?? null,
      items: Array.isArray(phase?.items) ? phase.items : [],
    }))
    : [{ phase: document.phase ?? null, items: Array.isArray(document.items) ? document.items : [] }];

  const items = [];
  for (const group of phaseGroups) {
    for (const item of group.items) {
      const payload = item?.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
        ? { ...item.payload }
        : {};
      if (Array.isArray(item?.codings) && item.codings.length > 0) {
        payload.codings = item.codings;
      }
      if (group.phase && !payload.phase) {
        payload.phase = String(group.phase);
      }
      items.push({
        kind: String(item?.kind || '').trim().toLowerCase(),
        display_order: Number(item?.display_order || items.length + 1),
        default_selected: item?.default_selected !== false,
        payload,
      });
    }
  }

  return {
    familyKey,
    title,
    specialty,
    description: document.description ? String(document.description) : null,
    conditionCodes: Array.isArray(document.condition_codes)
      ? document.condition_codes.map(String).filter(Boolean)
      : [],
    items,
  };
}

export async function importOrderSetDocument({
  tenantId,
  document,
  actor,
  dryRun = false,
  sourceFile = null,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const normalized = requireRole(actor, ORDER_SET_AUTHOR_ROLES, 'Only order-set authors can import order-set content');
  const parsed = normalizeImportDocument(document);
  const validation = await validateOrderSetItems({
    title: parsed.title,
    conditionCodes: parsed.conditionCodes,
    items: parsed.items,
  });
  const importKey = crypto
    .createHash('sha256')
    .update(`${scopedTenantId}:${parsed.familyKey}:${sourceFile || parsed.title}`)
    .digest('hex')
    .slice(0, 40);

  if (dryRun) {
    return {
      dry_run: true,
      family_key: parsed.familyKey,
      title: parsed.title,
      row_count: parsed.items.length,
      warnings: validation.warnings,
      requires_pharmacy_review: validation.requiresPharmacyReview,
    };
  }

  return setTenantTx(scopedTenantId, async (tx) => {
    const batchRows = await tx.$queryRawUnsafe(
      `INSERT INTO order_set_import_batches
         (tenant_id, import_key, format, source_file, dry_run, status, row_count,
          imported_count, warning_count, actor_uid, metadata, completed_at)
       VALUES ($1::uuid, $2, 'vh-order-set/1', $3, FALSE, 'completed', $4::int,
               1, $5::int, $6::uuid, $7::jsonb, NOW())
       ON CONFLICT (tenant_id, import_key) DO UPDATE SET
         source_file = EXCLUDED.source_file,
         status = EXCLUDED.status,
         row_count = EXCLUDED.row_count,
         imported_count = EXCLUDED.imported_count,
         warning_count = EXCLUDED.warning_count,
         actor_uid = EXCLUDED.actor_uid,
         metadata = EXCLUDED.metadata,
         completed_at = NOW()
       RETURNING *`,
      scopedTenantId,
      importKey,
      sourceFile,
      parsed.items.length,
      validation.warnings.length,
      normalized.uid,
      toJson({ warnings: validation.warnings }),
    );
    const batch = batchRows[0];

    const existingDraftRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM clinical_order_sets
        WHERE tenant_id = $1::uuid
          AND family_key = $2
          AND status = 'draft'
          AND source = 'imported'
        ORDER BY version DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      scopedTenantId,
      parsed.familyKey,
    );

    let draft;
    if (existingDraftRows[0]) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE clinical_order_sets
            SET title = $3,
                specialty = $4,
                condition_codes = $5::text[],
                description = $6,
                import_batch_id = $7::bigint,
                review_note = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int
          RETURNING *`,
        scopedTenantId,
        Number(existingDraftRows[0].id),
        parsed.title,
        parsed.specialty,
        parsed.conditionCodes,
        parsed.description,
        Number(batch.id),
      );
      draft = rows[0];
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_order_set_items
          WHERE tenant_id = $1::uuid AND order_set_id = $2::int`,
        scopedTenantId,
        Number(draft.id),
      );
    } else {
      const versionRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
           FROM clinical_order_sets
          WHERE tenant_id = $1::uuid AND family_key = $2`,
        scopedTenantId,
        parsed.familyKey,
      );
      const nextVersion = Number(versionRows[0]?.next_version || 1);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_order_sets
           (code, title, specialty, condition_codes, description, active, created_by,
            tenant_id, family_key, version, status, source, import_batch_id)
         VALUES ($1, $2, $3, $4::text[], $5, TRUE, $6::uuid,
                 $7::uuid, $8, $9::int, 'draft', 'imported', $10::bigint)
         RETURNING *`,
        codeForFamilyVersion(parsed.familyKey, nextVersion),
        parsed.title,
        parsed.specialty,
        parsed.conditionCodes,
        parsed.description,
        normalized.uid,
        scopedTenantId,
        parsed.familyKey,
        nextVersion,
        Number(batch.id),
      );
      draft = rows[0];
    }

    for (const [index, item] of parsed.items.entries()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_order_set_items
           (order_set_id, display_order, kind, payload, default_selected, tenant_id)
         VALUES ($1::int, $2::int, $3, $4::jsonb, $5, $6::uuid)`,
        Number(draft.id),
        Number(item.display_order || index + 1),
        item.kind,
        toJson(item.payload),
        item.default_selected === true,
        scopedTenantId,
      );
    }

    const items = await fetchItems(tx, scopedTenantId, draft.id);
    logger.info(`Order-set import landed as draft: family=${parsed.familyKey} set=${draft.id}`);
    return {
      batch,
      order_set: shapeOrderSet(draft, items, await fetchReviewEvents(tx, scopedTenantId, [draft.id])),
      warnings: validation.warnings,
    };
  });
}

export default {
  ORDER_SET_AUTHOR_ROLES,
  ORDER_SET_APPROVER_ROLES,
  ORDER_SET_PHARMACY_REVIEW_ROLES,
  listOrderSetsForStudio,
  submitOrderSetForReview,
  recordPharmacyReview,
  approveOrderSet,
  rejectOrderSet,
  retireOrderSet,
  rollbackOrderSet,
  cloneOrderSetVersion,
  importOrderSetDocument,
  validateOrderSetItems,
};
