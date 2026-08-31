/**
 * Facility / Location / Room / ServiceCatalog service (Phase C1).
 *
 * Manages the four tables added in migration 121:
 *   - facilities         (brick-and-mortar units under a tenant)
 *   - facility_locations (hierarchical zones inside a facility)
 *   - facility_rooms     (rooms under a location; sit between Location
 *                          and the existing `beds` table)
 *   - service_catalog    (first-class catalog of services offered)
 *
 * Decision-support only: nothing here re-points existing FK columns
 * (e.g. ot_schedules.ot_room is a free-text string, not an FK to
 * facility_rooms). Migration to facility-aware FKs lands as a separate
 * task once tenants populate facilities.
 */

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const FACILITY_KINDS = [
  'hospital', 'clinic', 'diagnostic_center', 'pharmacy',
  'tele_hub', 'corporate_office', 'satellite_unit', 'other',
];
export const FACILITY_STATUSES = ['active', 'paused', 'archived'];
export const LOCATION_KINDS = [
  'general', 'opd', 'ipd', 'icu', 'hdu', 'er', 'ot_block',
  'lab', 'radiology', 'pharmacy', 'reception', 'admin',
  'pacu', 'ward', 'isolation', 'bay', 'cabin', 'corridor', 'other',
];
export const LOCATION_STATUSES = ['active', 'paused', 'archived'];
export const ROOM_KINDS = [
  'general', 'private', 'semi_private', 'shared',
  'icu', 'isolation', 'ot', 'consulting', 'examination',
  'procedure', 'recovery', 'storage', 'other',
];
export const ROOM_STATUSES = ['active', 'closed_for_cleaning', 'maintenance', 'archived'];
export const SERVICE_KINDS = [
  'consultation', 'procedure', 'investigation', 'imaging',
  'pharmacy_dispense', 'package', 'room', 'admission',
  'home_visit', 'teleconsult', 'service', 'other',
];
export const SERVICE_STATUSES = ['draft', 'active', 'paused', 'archived'];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeNumber(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

const FACILITY_RETURNING = `id, tenant_id, facility_code, display_name, facility_kind,
  legal_entity_name, registration_number,
  address_line1, address_line2, city, state, country, postal_code,
  timezone, phone, email,
  status, is_default, geo_lat, geo_lng,
  metadata, created_by, created_at, updated_at`;

const FACILITY_SHUTDOWN_RECOVERY_ACTIONS = Object.freeze({
  default_facility_assignment: 'ASSIGN_ANOTHER_ACTIVE_DEFAULT_FACILITY',
  open_pharmacy_orders: 'COMPLETE_CANCEL_OR_REASSIGN_PHARMACY_ORDERS',
  active_inventory_items: 'TRANSFER_OR_DEACTIVATE_INVENTORY_ITEMS',
  active_inventory_batches: 'TRANSFER_EXHAUST_OR_QUARANTINE_INVENTORY_BATCHES',
  nonterminal_purchase_orders: 'CANCEL_CLOSE_OR_REASSIGN_PURCHASE_ORDERS',
  nonterminal_goods_receipts: 'REJECT_ARCHIVE_OR_REASSIGN_GOODS_RECEIPTS',
  active_ward_allocations: 'RELEASE_RECEIVE_RETURN_OR_RECONCILE_WARD_ALLOCATIONS',
  open_ward_indents: 'CANCEL_CLOSE_OR_REASSIGN_WARD_INDENTS',
  active_staff_grants: 'REVOKE_PHARMACY_FACILITY_GRANTS',
  // Cath facility shutdown blockers (migration 753 authority contract).
  open_cath_cases: 'COMPLETE_OR_CANCEL_CATH_CASES',
  unreconciled_cath_usage: 'RECONCILE_OR_GOVERN_CATH_CONSUMABLE_USAGE',
  open_cath_inventory_tasks: 'COMPLETE_CATH_INVENTORY_TASKS',
  open_cath_inventory_slas: 'CLOSE_CATH_INVENTORY_SLAS_WITH_DOMAIN_EVIDENCE',
  open_cath_authority_recoveries: 'RESOLVE_CATH_AUTHORITY_RECOVERY_WORKLIST',
});

function shutdownBlockerDetails(row = {}) {
  const blockers = Object.fromEntries(
    Object.keys(FACILITY_SHUTDOWN_RECOVERY_ACTIONS).map((key) => [key, Number(row[key] || 0)]),
  );
  const recoveryActions = Object.entries(blockers)
    .filter(([, count]) => count > 0)
    .map(([blocker, count]) => ({
      blocker,
      count,
      action: FACILITY_SHUTDOWN_RECOVERY_ACTIONS[blocker],
    }));
  return {
    blockers,
    recovery_actions: recoveryActions,
    total_blocker_count: recoveryActions.reduce((total, item) => total + item.count, 0),
  };
}

async function loadFacilityShutdownBlockersTx(tx, tenantId, facilityId, { isDefault = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int
          FROM pharmacy_orders
         WHERE tenant_id=$1::uuid AND facility_id=$2::int
           AND UPPER(status) NOT IN ('DISPENSED','DELIVERED','UNAVAILABLE','CANCELLED'))
         AS open_pharmacy_orders,
       (SELECT COUNT(*)::int
          FROM pharmacy_inventory_items
         WHERE tenant_id=$1::uuid AND facility_id=$2::int AND status='active')
         AS active_inventory_items,
       (SELECT COUNT(*)::int
          FROM pharmacy_inventory_batches batch
          JOIN pharmacy_inventory_items item
            ON item.tenant_id=batch.tenant_id AND item.id=batch.inventory_item_id
         WHERE batch.tenant_id=$1::uuid
           AND (batch.facility_id=$2::int OR item.facility_id=$2::int)
           AND (batch.status IN ('in_stock','reserved') OR batch.remaining_quantity > 0))
         AS active_inventory_batches,
       (SELECT COUNT(*)::int
          FROM pharmacy_purchase_orders
         WHERE tenant_id=$1::uuid AND facility_id=$2::int
           AND status NOT IN ('cancelled','closed'))
         AS nonterminal_purchase_orders,
       (SELECT COUNT(*)::int
          FROM pharmacy_goods_receipts
         WHERE tenant_id=$1::uuid AND facility_id=$2::int
           AND status NOT IN ('rejected','archived'))
         AS nonterminal_goods_receipts,
       (SELECT COUNT(*)::int
          FROM ward_indent_inventory_allocations allocation
          JOIN ward_indents indent
            ON indent.tenant_id=allocation.tenant_id
           AND indent.id=allocation.ward_indent_id
         WHERE allocation.tenant_id=$1::uuid AND indent.facility_id=$2::int
           AND allocation.status IN ('reserved','partially_issued','issued'))
         AS active_ward_allocations,
       (SELECT COUNT(*)::int
          FROM ward_indents
         WHERE tenant_id=$1::uuid AND facility_id=$2::int
           AND status NOT IN ('rejected','cancelled','closed'))
         AS open_ward_indents,
       (SELECT COUNT(*)::int
          FROM pharmacy_staff_facility_grants
         WHERE tenant_id=$1::uuid AND facility_id=$2::int
           AND status='active' AND revoked_at IS NULL)
         AS active_staff_grants,
       -- Cath facility shutdown blockers (migration 753 authority contract).
       (SELECT COUNT(*)::int
          FROM cath_lab_cases cath_case
         WHERE cath_case.tenant_id=$1::uuid AND cath_case.facility_id=$2::int
           AND cath_case.status NOT IN ('completed','cancelled'))
         AS open_cath_cases,
       (SELECT COUNT(*)::int
          FROM cath_case_consumable_usage usage
         WHERE usage.tenant_id=$1::uuid AND usage.facility_id=$2::int
           AND usage.inventory_decrement_status NOT IN ('decremented','not_applicable'))
         AS unreconciled_cath_usage,
       (SELECT COUNT(*)::int
          FROM tasks task
          JOIN cath_case_consumable_usage usage
            ON usage.tenant_id=task.tenant_id
           AND usage.id::text=task.related_resource_id
         WHERE task.tenant_id=$1::uuid AND usage.facility_id=$2::int
           AND task.related_resource_type='cath_case_consumable_usage'
           AND task.metadata->>'task_contract'='cath_inventory_shortfall_v1'
           AND task.status IN ('open','in_progress','blocked','overdue'))
         AS open_cath_inventory_tasks,
       (SELECT COUNT(*)::int
          FROM workflow_sla_instances sla
          JOIN cath_case_consumable_usage usage
            ON usage.tenant_id=sla.tenant_id AND usage.id::text=sla.source_id
         WHERE sla.tenant_id=$1::uuid AND usage.facility_id=$2::int
           AND sla.rule_code='cath_consumable_inventory_reconciliation'
           AND sla.source_table='cath_case_consumable_usage'
           AND sla.completed_at IS NULL
           AND sla.status IN ('active','breached','escalated'))
         AS open_cath_inventory_slas,
       (SELECT COUNT(*)::int
          FROM pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=$1::uuid
           AND recovery.entity_type IN (
             'cath_consumable_catalog','cath_consumable_usage','cath_lab_case'
           )
           AND recovery.status='OPEN'
           AND (
             recovery.facility_id=$2::int
             OR CASE
                  WHEN recovery.authority_snapshot->>'facility_id' ~ '^[1-9][0-9]*$'
                  THEN (recovery.authority_snapshot->>'facility_id')::int=$2::int
                  ELSE FALSE
                END
             OR CASE
                  WHEN recovery.authority_snapshot->>'case_facility_id' ~ '^[1-9][0-9]*$'
                  THEN (recovery.authority_snapshot->>'case_facility_id')::int=$2::int
                  ELSE FALSE
                END
             OR CASE
                  WHEN recovery.authority_snapshot->>'encounter_facility_id' ~ '^[1-9][0-9]*$'
                  THEN (recovery.authority_snapshot->>'encounter_facility_id')::int=$2::int
                  ELSE FALSE
                END
             OR CASE
                  WHEN recovery.authority_snapshot->>'catalog_facility_id' ~ '^[1-9][0-9]*$'
                  THEN (recovery.authority_snapshot->>'catalog_facility_id')::int=$2::int
                  ELSE FALSE
                END
             OR CASE
                  WHEN recovery.authority_snapshot->>'batch_facility_id' ~ '^[1-9][0-9]*$'
                  THEN (recovery.authority_snapshot->>'batch_facility_id')::int=$2::int
                  ELSE FALSE
                END
             OR CASE
                  WHEN recovery.authority_snapshot->>'inventory_item_facility_id' ~ '^[1-9][0-9]*$'
                  THEN (recovery.authority_snapshot->>'inventory_item_facility_id')::int=$2::int
                  ELSE FALSE
                END
           ))
         AS open_cath_authority_recoveries`,
    tenantId,
    facilityId,
  );
  return shutdownBlockerDetails({
    ...rows[0],
    default_facility_assignment: isDefault ? 1 : 0,
  });
}

async function appendFacilityAuditTx(tx, {
  tenantId,
  actorUid,
  action,
  facility,
  priorFacility = null,
  demotedDefaultFacilityIds = [],
  shutdownEvidence = null,
}) {
  await tx.$queryRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, $3, 'facility', $4::text, $5::jsonb, NOW())
     RETURNING id`,
    tenantId,
    actorUid,
    action,
    String(facility.id),
    JSON.stringify({
      contract: 'facility_lifecycle_v1',
      facility_code: facility.facility_code,
      before: priorFacility ? {
        status: priorFacility.status,
        is_default: priorFacility.is_default,
      } : null,
      after: {
        status: facility.status,
        is_default: facility.is_default,
      },
      demoted_default_facility_ids: demotedDefaultFacilityIds,
      shutdown_evidence: shutdownEvidence,
    }),
  );
}

export async function upsertFacility({
  tenantId = null,
  id = null,
  facilityCode,
  displayName,
  facilityKind = 'hospital',
  legalEntityName = null,
  registrationNumber = null,
  addressLine1 = null,
  addressLine2 = null,
  city = null,
  state = null,
  country = 'IN',
  postalCode = null,
  timezone = 'Asia/Kolkata',
  phone = null,
  email = null,
  status = 'active',
  isDefault = null,
  geoLat = null,
  geoLng = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(facilityCode, 80);
  if (!cleanCode) throw AppError.badRequest('facility_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const requestedDefault = normalizeBoolean(isDefault, null);
  const cleanStatus = normalizeEnum(status, FACILITY_STATUSES, 'status') || 'active';
  if (requestedDefault === true && cleanStatus !== 'active') {
    throw AppError.badRequest(
      'The tenant default facility must be active',
      'FACILITY_DEFAULT_MUST_BE_ACTIVE',
    );
  }
  const actorUid = maybeUuid(createdBy, 'created_by');

  const args = [
    cleanCode, cleanName,
    normalizeEnum(facilityKind, FACILITY_KINDS, 'facility_kind') || 'hospital',
    safeText(legalEntityName, SHORT_MAX),
    safeText(registrationNumber, 120),
    safeText(addressLine1, SHORT_MAX),
    safeText(addressLine2, SHORT_MAX),
    safeText(city, 120),
    safeText(state, 120),
    safeText(country, 80) || 'IN',
    safeText(postalCode, 20),
    safeText(timezone, 60) || 'Asia/Kolkata',
    safeText(phone, 40),
    safeText(email, 255),
    cleanStatus,
    requestedDefault ?? false,
    normalizeNumber(geoLat, 'geo_lat', { min: -90, max: 90 }),
    normalizeNumber(geoLng, 'geo_lng', { min: -180, max: 180 }),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];

  try {
    return await setTenantTx(tid, async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
        `facility-lifecycle:${tid}`,
      );
      const lockedFacilities = await tx.$queryRawUnsafe(
        `SELECT id, facility_code, status, is_default
           FROM facilities
          WHERE tenant_id=$1::uuid
          ORDER BY id
          FOR UPDATE`,
        tid,
      );
      const facId = id ? normalizeId(id, 'facility id') : null;
      const priorFacility = facId == null
        ? null
        : lockedFacilities.find((facility) => Number(facility.id) === facId);
      if (facId != null && !priorFacility) throw AppError.notFound('Facility not found');
      const activeDefaults = lockedFacilities.filter((facility) => (
        facility.status === 'active' && facility.is_default === true
      ));
      if (activeDefaults.length > 1) {
        throw AppError.conflict(
          'Multiple active default facilities require governed recovery before facility changes',
          'FACILITY_DEFAULT_AUTHORITY_AMBIGUOUS',
          {
            active_default_facility_ids: activeDefaults.map((facility) => Number(facility.id)),
            recovery_action: 'RETAIN_EXACTLY_ONE_ACTIVE_DEFAULT_FACILITY',
          },
        );
      }
      const effectiveDefault = requestedDefault ?? (priorFacility?.is_default === true);
      if (priorFacility?.is_default === true
          && requestedDefault === false
          && cleanStatus === 'active') {
        throw AppError.conflict(
          'Assign another active facility as default instead of directly demoting the current default',
          'FACILITY_DEFAULT_REPLACEMENT_REQUIRED',
          {
            facility_id: facId,
            recovery_action: 'ASSIGN_ANOTHER_ACTIVE_DEFAULT_FACILITY',
          },
        );
      }
      const anotherActiveDefault = activeDefaults.some((facility) => Number(facility.id) !== facId);
      const targetWillBeActiveDefault = effectiveDefault && cleanStatus === 'active';
      if (!anotherActiveDefault && !targetWillBeActiveDefault
          && !(priorFacility?.is_default === true && cleanStatus !== 'active')) {
        throw AppError.conflict(
          'Facility changes require exactly one active tenant default',
          'FACILITY_ACTIVE_DEFAULT_REQUIRED',
          {
            facility_id: facId,
            recovery_action: 'ASSIGN_ONE_ACTIVE_DEFAULT_FACILITY',
          },
        );
      }

      let shutdownEvidence = null;
      if (facId != null && cleanStatus !== 'active') {
        shutdownEvidence = await loadFacilityShutdownBlockersTx(tx, tid, facId, {
          isDefault: priorFacility.is_default === true,
        });
        if (shutdownEvidence.total_blocker_count > 0) {
          throw AppError.conflict(
            'Facility deactivation is blocked until every owned workflow and custody record is recovered',
            'FACILITY_DEACTIVATION_BLOCKED',
            {
              facility_id: facId,
              requested_status: cleanStatus,
              ...shutdownEvidence,
            },
          );
        }
      }

      let demotedDefaults = [];
      if (effectiveDefault) {
        demotedDefaults = await tx.$queryRawUnsafe(
          `UPDATE facilities
              SET is_default=false, updated_at=NOW()
            WHERE tenant_id=$1::uuid AND is_default=TRUE
              AND ($2::int IS NULL OR id<>$2::int)
            RETURNING id`,
          tid,
          facId,
        );
      }

      let facility;
      const lifecycleArgs = [...args];
      lifecycleArgs[15] = effectiveDefault;
      if (facId != null) {
        const rows = await tx.$queryRawUnsafe(
          `UPDATE facilities SET
             facility_code = $1, display_name = $2, facility_kind = $3,
             legal_entity_name = $4, registration_number = $5,
             address_line1 = $6, address_line2 = $7, city = $8, state = $9,
             country = $10, postal_code = $11, timezone = $12,
             phone = $13, email = $14, status = $15, is_default = $16,
             geo_lat = $17, geo_lng = $18, metadata = $19::jsonb,
             updated_at = NOW()
           WHERE id = $20 AND tenant_id = $21::uuid
           RETURNING ${FACILITY_RETURNING}`,
          ...lifecycleArgs, facId, tid,
        );
        if (!rows[0]) throw AppError.notFound('Facility not found');
        facility = rows[0];
      } else {
        const rows = await tx.$queryRawUnsafe(
          `INSERT INTO facilities
             (tenant_id, facility_code, display_name, facility_kind,
              legal_entity_name, registration_number,
              address_line1, address_line2, city, state, country, postal_code,
              timezone, phone, email, status, is_default,
              geo_lat, geo_lng, metadata, created_by)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::uuid)
           RETURNING ${FACILITY_RETURNING}`,
          tid, ...lifecycleArgs, actorUid,
        );
        facility = rows[0];
      }
      await appendFacilityAuditTx(tx, {
        tenantId: tid,
        actorUid,
        action: demotedDefaults.length > 0
          ? 'FACILITY_DEFAULT_SWITCHED'
          : (effectiveDefault && priorFacility?.is_default !== true
            ? 'FACILITY_DEFAULT_ASSIGNED'
            : (priorFacility ? 'FACILITY_UPDATED' : 'FACILITY_CREATED')),
        facility,
        priorFacility,
        demotedDefaultFacilityIds: demotedDefaults.map((row) => Number(row.id)),
        shutdownEvidence,
      });
      return facility;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('facility_code already exists for this tenant');
    throw err;
  }
}

export async function listFacilities({
  tenantId = null, status = null, facilityKind = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, FACILITY_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (facilityKind) {
    params.push(normalizeEnum(facilityKind, FACILITY_KINDS, 'facility_kind'));
    filters.push(`facility_kind = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${FACILITY_RETURNING} FROM facilities
       WHERE ${filters.join(' AND ')}
       ORDER BY is_default DESC, display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { facilities: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { facilities: [], count: 0 };
    throw err;
  }
}

export async function getDefaultFacility({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${FACILITY_RETURNING} FROM facilities
       WHERE tenant_id = $1::uuid AND status='active' AND is_default = true
       LIMIT 1`,
      tid,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * Backfill helper: seed one default facility per tenant from
 * `tenants.name`. Idempotent — does nothing if a default already
 * exists. Returns the (created or existing) default row.
 */
export async function seedDefaultFacilityForTenant({
  tenantId = null, fallbackName = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const existing = await getDefaultFacility({ tenantId: tid });
  if (existing) return existing;
  let name = safeText(fallbackName, SHORT_MAX);
  if (!name) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT name FROM tenants WHERE id = $1::uuid LIMIT 1`,
        tid,
      );
      name = rows[0]?.name || null;
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
  }
  if (!name) name = 'Default Facility';
  return upsertFacility({
    tenantId: tid,
    facilityCode: 'DEFAULT',
    displayName: name,
    facilityKind: 'hospital',
    isDefault: true,
    createdBy,
  });
}

// ---------------------------------------------------------------------------
// Facility locations
// ---------------------------------------------------------------------------

const LOCATION_RETURNING = `id, tenant_id, facility_id, parent_id,
  location_code, display_name, location_kind, floor, building,
  status, capacity_hint, metadata, created_by, created_at, updated_at`;

export async function upsertLocation({
  tenantId = null,
  id = null,
  facilityId,
  parentId = null,
  locationCode,
  displayName,
  locationKind = 'general',
  floor = null,
  building = null,
  status = 'active',
  capacityHint = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const facId = normalizeId(facilityId, 'facility_id');
  const cleanCode = safeText(locationCode, 120);
  if (!cleanCode) throw AppError.badRequest('location_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const args = [
    facId, parentId ? normalizeId(parentId, 'parent_id') : null,
    cleanCode, cleanName,
    normalizeEnum(locationKind, LOCATION_KINDS, 'location_kind') || 'general',
    safeText(floor, 40), safeText(building, 120),
    normalizeEnum(status, LOCATION_STATUSES, 'status') || 'active',
    normalizeInt(capacityHint, 'capacity_hint', { min: 0, max: 100000 }),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const locId = normalizeId(id, 'location id');
      if (args[1] === locId) {
        throw AppError.badRequest('parent_id cannot equal id');
      }
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE facility_locations SET
           facility_id = $1, parent_id = $2,
           location_code = $3, display_name = $4, location_kind = $5,
           floor = $6, building = $7, status = $8, capacity_hint = $9,
           metadata = $10::jsonb, updated_at = NOW()
         WHERE id = $11 AND tenant_id = $12::uuid
         RETURNING ${LOCATION_RETURNING}`,
        ...args, locId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Location not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, parent_id, location_code, display_name,
          location_kind, floor, building, status, capacity_hint,
          metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::uuid)
       RETURNING ${LOCATION_RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('location_code already exists in this facility');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid facility_id or parent_id');
    throw err;
  }
}

export async function listLocations({
  tenantId = null, facilityId = null, locationKind = null, status = null,
  parentId = undefined, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (facilityId) {
    params.push(normalizeId(facilityId, 'facility_id'));
    filters.push(`facility_id = $${params.length}`);
  }
  if (locationKind) {
    params.push(normalizeEnum(locationKind, LOCATION_KINDS, 'location_kind'));
    filters.push(`location_kind = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, LOCATION_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (parentId !== undefined) {
    if (parentId === null) {
      filters.push(`parent_id IS NULL`);
    } else {
      params.push(normalizeId(parentId, 'parent_id'));
      filters.push(`parent_id = $${params.length}`);
    }
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${LOCATION_RETURNING} FROM facility_locations
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { locations: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { locations: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Facility rooms
// ---------------------------------------------------------------------------

const ROOM_RETURNING = `id, tenant_id, facility_id, location_id,
  room_code, display_name, room_kind, bed_capacity, floor,
  status, metadata, created_at, updated_at`;

export async function upsertRoom({
  tenantId = null,
  id = null,
  facilityId,
  locationId,
  roomCode,
  displayName,
  roomKind = 'general',
  bedCapacity = null,
  floor = null,
  status = 'active',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const facId = normalizeId(facilityId, 'facility_id');
  const locId = normalizeId(locationId, 'location_id');
  const cleanCode = safeText(roomCode, 120);
  if (!cleanCode) throw AppError.badRequest('room_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const args = [
    facId, locId, cleanCode, cleanName,
    normalizeEnum(roomKind, ROOM_KINDS, 'room_kind') || 'general',
    normalizeInt(bedCapacity, 'bed_capacity', { min: 0, max: 1000 }),
    safeText(floor, 40),
    normalizeEnum(status, ROOM_STATUSES, 'status') || 'active',
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const roomId = normalizeId(id, 'room id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE facility_rooms SET
           facility_id = $1, location_id = $2,
           room_code = $3, display_name = $4, room_kind = $5,
           bed_capacity = $6, floor = $7, status = $8, metadata = $9::jsonb,
           updated_at = NOW()
         WHERE id = $10 AND tenant_id = $11::uuid
         RETURNING ${ROOM_RETURNING}`,
        ...args, roomId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Room not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_rooms
         (tenant_id, facility_id, location_id, room_code, display_name,
          room_kind, bed_capacity, floor, status, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${ROOM_RETURNING}`,
      tid, ...args,
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('room_code already exists in this facility');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid facility_id or location_id');
    throw err;
  }
}

export async function listRooms({
  tenantId = null, facilityId = null, locationId = null,
  roomKind = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (facilityId) {
    params.push(normalizeId(facilityId, 'facility_id'));
    filters.push(`facility_id = $${params.length}`);
  }
  if (locationId) {
    params.push(normalizeId(locationId, 'location_id'));
    filters.push(`location_id = $${params.length}`);
  }
  if (roomKind) {
    params.push(normalizeEnum(roomKind, ROOM_KINDS, 'room_kind'));
    filters.push(`room_kind = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, ROOM_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ROOM_RETURNING} FROM facility_rooms
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { rooms: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { rooms: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Service catalog
// ---------------------------------------------------------------------------

const SERVICE_RETURNING = `id, tenant_id, facility_id, service_code, display_name,
  description, service_kind, specialty, department_id,
  default_duration_minutes, requires_appointment, is_telehealth_eligible,
  default_tariff_item_code, status, metadata, created_by, created_at, updated_at`;

export async function upsertService({
  tenantId = null,
  id = null,
  facilityId = null,
  serviceCode,
  displayName,
  description = null,
  serviceKind = 'service',
  specialty = null,
  departmentId = null,
  defaultDurationMinutes = null,
  requiresAppointment = false,
  isTelehealthEligible = false,
  defaultTariffItemCode = null,
  status = 'active',
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(serviceCode, 120);
  if (!cleanCode) throw AppError.badRequest('service_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const args = [
    facilityId ? normalizeId(facilityId, 'facility_id') : null,
    cleanCode, cleanName, safeText(description),
    normalizeEnum(serviceKind, SERVICE_KINDS, 'service_kind') || 'service',
    safeText(specialty, 120),
    departmentId ? normalizeId(departmentId, 'department_id') : null,
    normalizeInt(defaultDurationMinutes, 'default_duration_minutes', { min: 0, max: 1440 }),
    normalizeBoolean(requiresAppointment, false),
    normalizeBoolean(isTelehealthEligible, false),
    safeText(defaultTariffItemCode, 120),
    normalizeEnum(status, SERVICE_STATUSES, 'status') || 'active',
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const svcId = normalizeId(id, 'service id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE service_catalog SET
           facility_id = $1, service_code = $2, display_name = $3, description = $4,
           service_kind = $5, specialty = $6, department_id = $7,
           default_duration_minutes = $8, requires_appointment = $9,
           is_telehealth_eligible = $10, default_tariff_item_code = $11,
           status = $12, metadata = $13::jsonb, updated_at = NOW()
         WHERE id = $14 AND tenant_id = $15::uuid
         RETURNING ${SERVICE_RETURNING}`,
        ...args, svcId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Service not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO service_catalog
         (tenant_id, facility_id, service_code, display_name, description,
          service_kind, specialty, department_id,
          default_duration_minutes, requires_appointment, is_telehealth_eligible,
          default_tariff_item_code, status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::uuid)
       RETURNING ${SERVICE_RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('service_code already exists for this tenant');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid facility_id');
    throw err;
  }
}

export async function listServices({
  tenantId = null, facilityId = null, serviceKind = null, specialty = null,
  status = null, telehealthEligible = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (facilityId) {
    params.push(normalizeId(facilityId, 'facility_id'));
    filters.push(`facility_id = $${params.length}`);
  }
  if (serviceKind) {
    params.push(normalizeEnum(serviceKind, SERVICE_KINDS, 'service_kind'));
    filters.push(`service_kind = $${params.length}`);
  }
  if (specialty) {
    params.push(safeText(specialty, 120));
    filters.push(`specialty = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, SERVICE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (telehealthEligible !== null) {
    params.push(normalizeBoolean(telehealthEligible));
    filters.push(`is_telehealth_eligible = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SERVICE_RETURNING} FROM service_catalog
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { services: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { services: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  FACILITY_KINDS,
  FACILITY_STATUSES,
  LOCATION_KINDS,
  ROOM_KINDS,
  SERVICE_KINDS,
};

export default {
  upsertFacility,
  listFacilities,
  getDefaultFacility,
  seedDefaultFacilityForTenant,
  upsertLocation,
  listLocations,
  upsertRoom,
  listRooms,
  upsertService,
  listServices,
};
