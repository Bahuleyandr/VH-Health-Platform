// src/services/facility/facilityAssetService.js
//
// General (non-biomedical) facility asset register (migration 704).
// Furniture, HVAC, electrical/plumbing plant, IT equipment, generators,
// vehicles, kitchen/laundry machinery, safety and infrastructure assets.
// Biomedical devices stay in clinical_ai_biomed_devices + the 394-396 CMMS —
// the category vocabulary here deliberately excludes biomedical classes.
//
// Master-data shape follows referralFacilityService (680); the mutation shape
// follows the biomed CMMS work-order idiom: every status/location/custodian/
// condition transition locks the master row (FOR UPDATE) and appends one
// facility_asset_events row IN THE SAME setTenantTx transaction. The events
// table is append-only by convention — this service never UPDATEs or DELETEs
// event rows.
//
// Operational master data, NOT clinical: no clinical_timeline_events /
// clinical_audit_events obligation (no patient linkage). Routes write ordinary
// audit_logs rows via logAudit.
//
// The Prisma client may not model these tables in older checkouts, so access
// is raw SQL through the hardened prisma singleton with explicit
// `tenant_id = $N::uuid` predicates everywhere (dev/QA/CI run with the RLS GUC
// unset — scoping must be provable, PR #684 house rule).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { stripHtml } from '../../utils/sanitize.js';
import { requireTenantId } from '../tenant/tenantService.js';

/* ─── Dark-ship gate ─────────────────────────────────────────────────────── */
// The register ships dark like every other #878-wave feature: env kill switch
// AND per-tenant tenants.settings.facilityAssets.enabled flag, ANDed, fail
// closed, both default OFF. Same status/code convention as the siblings:
// env off → 503 *_NOT_ENABLED (ABDM_NOT_ENABLED precedent), tenant off →
// 403 *_DISABLED (AMBULANCE_GPS_TRACKING_DISABLED precedent).

export function isFacilityAssetsEnvEnabled() {
  return process.env.FACILITY_ASSETS_ENABLED === 'true';
}

// Dynamic import on purpose (drugKbLinkService/labCodeMappingService
// precedent): keeps tenantSettingsService out of this module's STATIC import
// graph so suites that partially mock it keep loading. The env kill switch is
// checked first, so the accessor only ever loads on a deployment that has
// opened the gate — and a gated call fails closed either way.
async function getFacilityAssetsSettingsLazy(tenantId) {
  const mod = await import('../tenant/tenantSettingsService.js');
  return mod.getFacilityAssetsSettings(tenantId);
}

export async function requireFacilityAssetsEnabled(tenantId) {
  if (!isFacilityAssetsEnvEnabled()) {
    throw new AppError('Facility asset register is not enabled', 503, 'FACILITY_ASSETS_NOT_ENABLED');
  }
  const settings = await getFacilityAssetsSettingsLazy(tenantId);
  if (!settings.enabled) {
    throw AppError.forbidden(
      'Facility asset register is not enabled for this tenant',
      'FACILITY_ASSETS_DISABLED',
    );
  }
  return settings;
}

export const FACILITY_ASSET_CATEGORIES = Object.freeze([
  'furniture', 'hvac', 'electrical', 'plumbing', 'it_equipment',
  'generator', 'vehicle', 'kitchen', 'laundry', 'safety',
  'infrastructure', 'other',
]);

export const FACILITY_ASSET_CONDITIONS = Object.freeze(['good', 'fair', 'poor']);

export const FACILITY_ASSET_STATUSES = Object.freeze([
  'active', 'under_repair', 'condemned', 'disposed',
]);

// active ⇄ under_repair; active|under_repair → condemned → disposed;
// direct disposal from active/under_repair allowed (loss/theft write-off).
// `disposed` is terminal.
export const FACILITY_ASSET_TRANSITIONS = Object.freeze({
  active: Object.freeze(['under_repair', 'condemned', 'disposed']),
  under_repair: Object.freeze(['active', 'condemned', 'disposed']),
  condemned: Object.freeze(['disposed']),
  disposed: Object.freeze([]),
});

const TRANSITION_EVENT_TYPES = Object.freeze({
  under_repair: 'repair_opened',
  condemned: 'condemned',
  disposed: 'disposed',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function badRequest(message) {
  return AppError.badRequest(message, 'FACILITY_ASSET_INVALID');
}

function cleanText(value, max) {
  const text = stripHtml(String(value ?? '')).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeAssetTag(value) {
  const tag = cleanText(value, 64);
  if (!tag) throw badRequest('assetTag is required');
  return tag;
}

function normalizeName(value) {
  const name = cleanText(value, 200);
  if (!name) throw badRequest('name is required');
  return name;
}

function normalizeCategory(value) {
  const category = String(value ?? 'other').trim().toLowerCase();
  if (!FACILITY_ASSET_CATEGORIES.includes(category)) {
    throw badRequest(`category must be one of: ${FACILITY_ASSET_CATEGORIES.join(', ')}`);
  }
  return category;
}

function normalizeCondition(value) {
  const condition = String(value ?? 'good').trim().toLowerCase();
  if (!FACILITY_ASSET_CONDITIONS.includes(condition)) {
    throw badRequest(`condition must be one of: ${FACILITY_ASSET_CONDITIONS.join(', ')}`);
  }
  return condition;
}

function normalizeUuid(value, field) {
  if (value == null || value === '') return null;
  const uuid = String(value).trim();
  if (!UUID_RE.test(uuid)) throw badRequest(`${field} must be a UUID`);
  return uuid;
}

function normalizeDate(value, field) {
  if (value == null || value === '') return null;
  const date = String(value).trim().slice(0, 10);
  if (!DATE_RE.test(date)) throw badRequest(`${field} must be YYYY-MM-DD`);
  return date;
}

function normalizeCost(value, field = 'purchaseCost') {
  if (value == null || value === '') return null;
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0 || cost > 9_999_999_999.99) {
    throw badRequest(`${field} must be a non-negative number`);
  }
  return Math.round(cost * 100) / 100;
}

function assetId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > POSTGRES_INTEGER_MAX) {
    throw badRequest('assetId must be a positive 32-bit integer');
  }
  return id;
}

function normalizeExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1 || version > POSTGRES_INTEGER_MAX) {
    throw badRequest('expectedVersion must be a positive 32-bit integer');
  }
  return version;
}

function paginationInteger(value, {
  field, defaultValue, min, max,
}) {
  const parsed = value == null || value === '' ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizePayload(payload = {}, existing = null) {
  const nullableValue = (key) => (
    Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : existing?.[key]
  );
  return {
    assetTag: normalizeAssetTag(payload.assetTag ?? existing?.assetTag),
    name: normalizeName(payload.name ?? existing?.name),
    category: normalizeCategory(payload.category ?? existing?.category),
    description: cleanText(nullableValue('description'), 4000),
    locationDepartment: cleanText(nullableValue('locationDepartment'), 120),
    locationRoom: cleanText(nullableValue('locationRoom'), 120),
    custodianUid: normalizeUuid(nullableValue('custodianUid'), 'custodianUid'),
    vendor: cleanText(nullableValue('vendor'), 160),
    purchaseDate: normalizeDate(nullableValue('purchaseDate'), 'purchaseDate'),
    purchaseCost: normalizeCost(nullableValue('purchaseCost')),
    warrantyUntil: normalizeDate(nullableValue('warrantyUntil'), 'warrantyUntil'),
    condition: normalizeCondition(payload.condition ?? existing?.condition),
  };
}

const ASSET_COLUMNS = `id, tenant_id, asset_tag, name, category, description,
       location_department, location_room, custodian_uid, vendor,
       purchase_date::text AS purchase_date, purchase_cost::text AS purchase_cost,
       warranty_until::text AS warranty_until, condition, status, version,
       disposal_reason, disposed_at, disposed_by,
       created_by, updated_by, created_at, updated_at`;

const EVENT_COLUMNS = `id::int AS id, asset_id, asset_tag_snapshot, asset_name_snapshot,
       event_type, from_status, to_status, details, notes, actor_uid, actor_role,
       occurred_at, created_at`;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

export function toAsset(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    assetTag: row.asset_tag,
    name: row.name,
    category: row.category,
    description: row.description ?? null,
    locationDepartment: row.location_department ?? null,
    locationRoom: row.location_room ?? null,
    custodianUid: row.custodian_uid ?? null,
    vendor: row.vendor ?? null,
    purchaseDate: row.purchase_date ?? null,
    purchaseCost: row.purchase_cost == null ? null : Number(row.purchase_cost),
    warrantyUntil: row.warranty_until ?? null,
    condition: row.condition,
    status: row.status,
    version: Number(row.version),
    disposalReason: row.disposal_reason ?? null,
    disposedAt: toIso(row.disposed_at),
    disposedBy: row.disposed_by ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toAssetEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    assetId: row.asset_id == null ? null : Number(row.asset_id),
    assetTag: row.asset_tag_snapshot,
    assetName: row.asset_name_snapshot,
    eventType: row.event_type,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status ?? null,
    details: row.details ?? {},
    notes: row.notes ?? null,
    actorUid: row.actor_uid ?? null,
    actorRole: row.actor_role ?? null,
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
  };
}

function rethrowDuplicateTag(err) {
  if (err?.meta?.code === '23505' || /ux_facility_assets_tenant_tag/.test(String(err?.message))) {
    throw AppError.conflict(
      'An asset with this tag already exists',
      'FACILITY_ASSET_TAG_EXISTS',
    );
  }
  throw err;
}

function rethrowWriteConstraint(err) {
  const constraint = err?.constraint ?? err?.meta?.constraint ?? '';
  if (constraint === 'fk_facility_assets_custodian'
      || /fk_facility_assets_custodian/.test(String(err?.message))) {
    throw AppError.unprocessable(
      'custodianUid must identify an active staff user in the asset tenant',
      'FACILITY_ASSET_CUSTODIAN_INVALID',
    );
  }
  rethrowDuplicateTag(err);
}

function staleWrite(expectedVersion, currentVersion) {
  return AppError.conflict(
    'Facility asset changed since it was loaded',
    'FACILITY_ASSET_STALE_WRITE',
    { expectedVersion, currentVersion },
  );
}

async function assertCustodianInTenantTx(tx, tenantId, custodianUid) {
  if (!custodianUid) return;
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active IS TRUE
        AND role <> 'PATIENT'
      LIMIT 1`,
    tenantId,
    custodianUid,
  );
  if (!rows[0]) {
    throw AppError.unprocessable(
      'custodianUid must identify an active staff user in the asset tenant',
      'FACILITY_ASSET_CUSTODIAN_INVALID',
    );
  }
}

export async function listFacilityAssetCustodians(tenantId, { q = '', limit = 500 } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const query = String(q ?? '').trim().toLowerCase();
  const safeLimit = paginationInteger(limit, {
    field: 'limit', defaultValue: 500, min: 1, max: 500,
  });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, name, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active IS TRUE
        AND role <> 'PATIENT'
        AND ($2::text = '' OR LOWER(name) LIKE '%' || $2::text || '%')
      ORDER BY name ASC, uid ASC
      LIMIT $3::int`,
    scopedTenantId,
    query,
    safeLimit,
  );
  return {
    custodians: rows.map((row) => ({
      uid: row.uid,
      name: row.name,
      role: row.role,
    })),
    limit: safeLimit,
  };
}

async function insertEventTx(tx, tenantId, asset, {
  eventType,
  fromStatus = null,
  toStatus = null,
  details = {},
  notes = null,
  actorUid = null,
  actorRole = null,
}) {
  await tx.$queryRawUnsafe(
    `INSERT INTO facility_asset_events (
       tenant_id, asset_id, asset_tag_snapshot, asset_name_snapshot,
       event_type, from_status, to_status, details, notes, actor_uid, actor_role
     )
     VALUES ($1::uuid, $2::int, $3::text, $4::text, $5::text, $6::text,
             $7::text, $8::jsonb, $9::text, $10::uuid, $11::text)`,
    tenantId,
    Number(asset.id),
    asset.asset_tag ?? asset.assetTag,
    asset.name,
    eventType,
    fromStatus,
    toStatus,
    JSON.stringify(details ?? {}),
    notes,
    actorUid,
    actorRole ? String(actorRole).slice(0, 60) : null,
  );
}

async function lockAssetTx(tx, tenantId, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${ASSET_COLUMNS}
       FROM facility_assets
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    assetId(id),
  );
  if (!rows[0]) {
    throw AppError.notFound('Facility asset not found', 'FACILITY_ASSET_NOT_FOUND');
  }
  return rows[0];
}

/* ─── CRUD ───────────────────────────────────────────────────────────────── */

export async function listFacilityAssets(tenantId, {
  q = '', status = '', category = '', custodianUid = null, limit = 200, offset = 0,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const query = String(q ?? '').trim().toLowerCase();
  const statusFilter = String(status ?? '').trim().toLowerCase();
  if (statusFilter && !FACILITY_ASSET_STATUSES.includes(statusFilter)) {
    throw badRequest(`status must be one of: ${FACILITY_ASSET_STATUSES.join(', ')}`);
  }
  const categoryFilter = String(category ?? '').trim().toLowerCase();
  if (categoryFilter && !FACILITY_ASSET_CATEGORIES.includes(categoryFilter)) {
    throw badRequest(`category must be one of: ${FACILITY_ASSET_CATEGORIES.join(', ')}`);
  }
  const custodian = normalizeUuid(custodianUid, 'custodianUid');
  const safeLimit = paginationInteger(limit, {
    field: 'limit', defaultValue: 200, min: 1, max: 500,
  });
  const safeOffset = paginationInteger(offset, {
    field: 'offset', defaultValue: 0, min: 0, max: POSTGRES_INTEGER_MAX,
  });
  const rows = await prisma.$queryRawUnsafe(
    `WITH filtered AS (
       SELECT ${ASSET_COLUMNS}
         FROM facility_assets
        WHERE tenant_id = $1::uuid
          AND ($2::text = '' OR status = $2::text)
          AND ($3::text = '' OR category = $3::text)
          AND ($4::uuid IS NULL OR custodian_uid = $4::uuid)
          AND (
            $5::text = ''
            OR LOWER(asset_tag) LIKE '%' || $5::text || '%'
            OR LOWER(name) LIKE '%' || $5::text || '%'
            OR LOWER(COALESCE(location_department, '')) LIKE '%' || $5::text || '%'
            OR LOWER(COALESCE(location_room, '')) LIKE '%' || $5::text || '%'
          )
     ), page AS (
       SELECT *
         FROM filtered
        ORDER BY status ASC, name ASC, id ASC
        LIMIT $6::int OFFSET $7::int
     )
     SELECT page.*, totals.total_count
       FROM (SELECT COUNT(*)::int AS total_count FROM filtered) AS totals
       LEFT JOIN page ON TRUE
      ORDER BY page.status ASC NULLS LAST, page.name ASC NULLS LAST, page.id ASC NULLS LAST`,
    scopedTenantId,
    statusFilter,
    categoryFilter,
    custodian,
    query,
    safeLimit,
    safeOffset,
  );
  const assets = rows.filter((row) => row.id != null).map(toAsset);
  return {
    assets,
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

export async function getFacilityAsset(tenantId, id, { eventLimit = 20 } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${ASSET_COLUMNS}
       FROM facility_assets
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    scopedTenantId,
    assetId(id),
  );
  const asset = toAsset(rows[0]);
  if (!asset) {
    throw AppError.notFound('Facility asset not found', 'FACILITY_ASSET_NOT_FOUND');
  }
  const events = await listFacilityAssetEvents(scopedTenantId, asset.id, { limit: eventLimit });
  return { ...asset, events: events.events };
}

export async function listFacilityAssetEvents(tenantId, id, { limit = 50, offset = 0 } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const safeLimit = paginationInteger(limit, {
    field: 'limit', defaultValue: 50, min: 1, max: 200,
  });
  const safeOffset = paginationInteger(offset, {
    field: 'offset', defaultValue: 0, min: 0, max: POSTGRES_INTEGER_MAX,
  });
  const rows = await prisma.$queryRawUnsafe(
    `WITH filtered AS (
       SELECT ${EVENT_COLUMNS}
         FROM facility_asset_events
        WHERE tenant_id = $1::uuid AND asset_id = $2::int
     ), page AS (
       SELECT *
         FROM filtered
        ORDER BY occurred_at DESC, id DESC
        LIMIT $3::int OFFSET $4::int
     )
     SELECT page.*, totals.total_count
       FROM (SELECT COUNT(*)::int AS total_count FROM filtered) AS totals
       LEFT JOIN page ON TRUE
      ORDER BY page.occurred_at DESC NULLS LAST, page.id DESC NULLS LAST`,
    scopedTenantId,
    assetId(id),
    safeLimit,
    safeOffset,
  );
  return {
    events: rows.filter((row) => row.id != null).map(toAssetEvent),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

export async function createFacilityAsset(tenantId, payload = {}, {
  actorUid = null, actorRole = null,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const next = normalizePayload(payload);
  try {
    return await setTenantTx(scopedTenantId, async (tx) => {
      await assertCustodianInTenantTx(tx, scopedTenantId, next.custodianUid);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO facility_assets (
           tenant_id, asset_tag, name, category, description,
           location_department, location_room, custodian_uid, vendor,
           purchase_date, purchase_cost, warranty_until, condition,
           created_by, updated_by
         )
         VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
                 $7::text, $8::uuid, $9::text, $10::date, $11::numeric,
                 $12::date, $13::text, $14::uuid, $14::uuid)
         RETURNING ${ASSET_COLUMNS}`,
        scopedTenantId,
        next.assetTag,
        next.name,
        next.category,
        next.description,
        next.locationDepartment,
        next.locationRoom,
        next.custodianUid,
        next.vendor,
        next.purchaseDate,
        next.purchaseCost,
        next.warrantyUntil,
        next.condition,
        actorUid,
      );
      const created = rows[0];
      await insertEventTx(tx, scopedTenantId, created, {
        eventType: 'created',
        details: {
          category: next.category,
          location_department: next.locationDepartment,
          location_room: next.locationRoom,
          custodian_uid: next.custodianUid,
          condition: next.condition,
        },
        actorUid,
        actorRole,
      });
      return toAsset(created);
    });
  } catch (err) {
    rethrowWriteConstraint(err);
  }
}

/**
 * Updates master fields (never status — use transitionFacilityAssetStatus).
 * Emits one event row per changed field group in the SAME transaction:
 * moved (location), custodian_assigned, condition_changed, and a generic
 * `updated` when any other master field changed.
 */
export async function updateFacilityAsset(tenantId, id, payload = {}, {
  actorUid = null, actorRole = null,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  if (payload.status !== undefined) {
    throw badRequest('status cannot be changed here — use the status transition endpoint');
  }
  const expectedVersion = normalizeExpectedVersion(payload.expectedVersion);
  try {
    return await setTenantTx(scopedTenantId, async (tx) => {
      const currentRow = await lockAssetTx(tx, scopedTenantId, id);
      const current = toAsset(currentRow);
      if (current.status === 'disposed') {
        throw AppError.conflict(
          'A disposed asset can no longer be edited',
          'FACILITY_ASSET_DISPOSED',
        );
      }
      if (current.version !== expectedVersion) {
        throw staleWrite(expectedVersion, current.version);
      }
      const next = normalizePayload(payload, current);
      if (next.custodianUid !== current.custodianUid) {
        await assertCustodianInTenantTx(tx, scopedTenantId, next.custodianUid);
      }

      const rows = await tx.$queryRawUnsafe(
        `UPDATE facility_assets
            SET asset_tag = $3::text, name = $4::text, category = $5::text,
                description = $6::text, location_department = $7::text,
                location_room = $8::text, custodian_uid = $9::uuid,
                vendor = $10::text, purchase_date = $11::date,
                purchase_cost = $12::numeric, warranty_until = $13::date,
                condition = $14::text, updated_by = $15::uuid,
                version = version + 1, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int AND version = $16::int
          RETURNING ${ASSET_COLUMNS}`,
        scopedTenantId,
        current.id,
        next.assetTag,
        next.name,
        next.category,
        next.description,
        next.locationDepartment,
        next.locationRoom,
        next.custodianUid,
        next.vendor,
        next.purchaseDate,
        next.purchaseCost,
        next.warrantyUntil,
        next.condition,
        actorUid,
        expectedVersion,
      );
      const updated = rows[0];
      if (!updated) {
        throw staleWrite(expectedVersion, current.version);
      }

      const moved = next.locationDepartment !== current.locationDepartment
        || next.locationRoom !== current.locationRoom;
      const custodianChanged = next.custodianUid !== current.custodianUid;
      const conditionChanged = next.condition !== current.condition;
      const otherChanged = next.assetTag !== current.assetTag
        || next.name !== current.name
        || next.category !== current.category
        || next.description !== current.description
        || next.vendor !== current.vendor
        || next.purchaseDate !== current.purchaseDate
        || next.purchaseCost !== current.purchaseCost
        || next.warrantyUntil !== current.warrantyUntil;
      const notes = cleanText(payload.notes, 1000);

      if (moved) {
        await insertEventTx(tx, scopedTenantId, updated, {
          eventType: 'moved',
          details: {
            from_location: {
              department: current.locationDepartment,
              room: current.locationRoom,
            },
            to_location: {
              department: next.locationDepartment,
              room: next.locationRoom,
            },
          },
          notes,
          actorUid,
          actorRole,
        });
      }
      if (custodianChanged) {
        await insertEventTx(tx, scopedTenantId, updated, {
          eventType: 'custodian_assigned',
          details: {
            from_custodian_uid: current.custodianUid,
            to_custodian_uid: next.custodianUid,
          },
          notes,
          actorUid,
          actorRole,
        });
      }
      if (conditionChanged) {
        await insertEventTx(tx, scopedTenantId, updated, {
          eventType: 'condition_changed',
          details: {
            from_condition: current.condition,
            to_condition: next.condition,
          },
          notes,
          actorUid,
          actorRole,
        });
      }
      if (otherChanged || (!moved && !custodianChanged && !conditionChanged)) {
        await insertEventTx(tx, scopedTenantId, updated, {
          eventType: 'updated',
          details: {},
          notes,
          actorUid,
          actorRole,
        });
      }
      return toAsset(updated);
    });
  } catch (err) {
    rethrowWriteConstraint(err);
  }
}

/**
 * Status transition with guard. `disposed` requires a reason (the 704 CHECK
 * chk_facility_asset_disposal_evidence enforces reason/at/by at the DB layer;
 * this surfaces a clean 422 instead of a constraint error). Disposal stamps
 * the evidence columns; disposed is terminal.
 */
export async function transitionFacilityAssetStatus(tenantId, id, {
  toStatus, reason = null, notes = null, expectedVersion,
} = {}, { actorUid = null, actorRole = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const expected = normalizeExpectedVersion(expectedVersion);
  const target = String(toStatus ?? '').trim().toLowerCase();
  if (!FACILITY_ASSET_STATUSES.includes(target)) {
    throw badRequest(`toStatus must be one of: ${FACILITY_ASSET_STATUSES.join(', ')}`);
  }
  const cleanReason = cleanText(reason, 500);
  const cleanNotes = cleanText(notes, 1000);
  if (target === 'disposed') {
    if (!cleanReason) {
      throw new AppError(
        'Disposal requires a reason',
        422,
        'FACILITY_ASSET_DISPOSAL_REASON_REQUIRED',
      );
    }
    if (!actorUid) {
      throw new AppError(
        'Disposal requires an identified actor',
        422,
        'FACILITY_ASSET_DISPOSAL_ACTOR_REQUIRED',
      );
    }
  }

  return setTenantTx(scopedTenantId, async (tx) => {
    const currentRow = await lockAssetTx(tx, scopedTenantId, id);
    const currentVersion = Number(currentRow.version);
    if (currentVersion !== expected) {
      throw staleWrite(expected, currentVersion);
    }
    const fromStatus = currentRow.status;
    const allowed = FACILITY_ASSET_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(target)) {
      throw AppError.invalidTransition(fromStatus, target, allowed);
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE facility_assets
          SET status = $3::text,
              disposal_reason = $4::text,
              disposed_at = CASE WHEN $3::text = 'disposed' THEN NOW() ELSE NULL END,
              disposed_by = $5::uuid,
              updated_by = $6::uuid,
              version = version + 1,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int AND version = $7::int
        RETURNING ${ASSET_COLUMNS}`,
      scopedTenantId,
      Number(currentRow.id),
      target,
      target === 'disposed' ? cleanReason : null,
      target === 'disposed' ? actorUid : null,
      actorUid,
      expected,
    );
    const updated = rows[0];
    if (!updated) {
      throw staleWrite(expected, currentVersion);
    }

    const eventType = fromStatus === 'under_repair' && target === 'active'
      ? 'repair_closed'
      : (TRANSITION_EVENT_TYPES[target] ?? 'status_changed');
    await insertEventTx(tx, scopedTenantId, updated, {
      eventType,
      fromStatus,
      toStatus: target,
      details: cleanReason ? { reason: cleanReason } : {},
      notes: cleanNotes,
      actorUid,
      actorRole,
    });
    return toAsset(updated);
  });
}

/**
 * Records a maintenance action (no status change). Rejected on disposed
 * assets.
 */
export async function recordFacilityAssetMaintenance(tenantId, id, {
  notes = null, cost = null, vendor = null,
} = {}, { actorUid = null, actorRole = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  await requireFacilityAssetsEnabled(scopedTenantId);
  const cleanNotes = cleanText(notes, 1000);
  if (!cleanNotes) throw badRequest('notes describing the maintenance action are required');
  const cleanVendor = cleanText(vendor, 160);
  const cleanCost = normalizeCost(cost, 'cost');

  return setTenantTx(scopedTenantId, async (tx) => {
    const currentRow = await lockAssetTx(tx, scopedTenantId, id);
    if (currentRow.status === 'disposed') {
      throw AppError.conflict(
        'A disposed asset can no longer receive maintenance',
        'FACILITY_ASSET_DISPOSED',
      );
    }
    await insertEventTx(tx, scopedTenantId, currentRow, {
      eventType: 'maintenance',
      details: {
        ...(cleanCost != null ? { cost: cleanCost } : {}),
        ...(cleanVendor ? { vendor: cleanVendor } : {}),
      },
      notes: cleanNotes,
      actorUid,
      actorRole,
    });
    const events = await listEventsTx(tx, scopedTenantId, Number(currentRow.id), 1);
    return { asset: toAsset(currentRow), event: events[0] ?? null };
  });
}

async function listEventsTx(tx, tenantId, id, limit) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${EVENT_COLUMNS}
       FROM facility_asset_events
      WHERE tenant_id = $1::uuid AND asset_id = $2::int
      ORDER BY occurred_at DESC, id DESC
      LIMIT $3::int`,
    tenantId,
    id,
    limit,
  );
  return rows.map(toAssetEvent);
}

export default {
  FACILITY_ASSET_CATEGORIES,
  FACILITY_ASSET_CONDITIONS,
  FACILITY_ASSET_STATUSES,
  FACILITY_ASSET_TRANSITIONS,
  isFacilityAssetsEnvEnabled,
  requireFacilityAssetsEnabled,
  listFacilityAssets,
  listFacilityAssetCustodians,
  getFacilityAsset,
  listFacilityAssetEvents,
  createFacilityAsset,
  updateFacilityAsset,
  transitionFacilityAssetStatus,
  recordFacilityAssetMaintenance,
};
