import { createHash } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

// Postgres int4 / int8 upper bounds. The int4 ceiling on positiveId is
// LOAD-BEARING, not belt-and-braces: every id this helper normalizes is bound
// into an `::int` parameter (`po.id=$2::int` in resolveOrderPharmacyFacility,
// `id=$2::int` in resolvePharmacyFacility, `facility_id=$2::int` in
// assertPharmacyFacilityGrant), so a value that is a safe positive integer but
// above int4 max (e.g. 9999999999) used to reach the bind and raise Postgres
// 22003 'integer out of range' — a plain error with no statusCode, which
// errorHandlerMiddleware answers as a bare 500 with no code. Same rule the repo
// already states at middleware/routePatientAccessGuards.js:38-40 ("an
// out-of-range value ... must become null, never a 22003 from the bind") and
// applies at routes/pharmacy/orderRoutes.js:156 and
// routes/pharmacy/pharmacyOrderPatientGuards.js:63-66.
//
// Held as module-local constants rather than importing the exported
// PG_INT4_MAX from middleware/routePatientAccessGuards.js: that module drags
// the whole PHI access-decision / care-team-enforcement middleware chain in
// behind it, and a service must not take a dependency on middleware. Every
// other service that binds an id does the same (labResultsService.js,
// hl7Transformer.js, marSupplyService.js, facilityAssetService.js, ...).
const PG_INT4_MAX = 2147483647;
const PG_INT8_MAX = 9223372036854775807n;

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= PG_INT4_MAX
    ? parsed
    : null;
}

// ★ Exported because this Set is the SINGLE canonical definition of "a role that
// may hold pharmacy facility custody". assertPharmacyFacilityGrant (:249) tests
// the actor's canonical DB role against it before it will accept any grant, so
// any grant-JOIN elsewhere that lists the actor's facilities must apply the
// identical membership test or it will surface a row that the by-id read then
// 403s on. Consumers import this Set (counterSaleService.js) rather than
// hand-copying the members — a hand copy has nothing pinning it, so a role
// added here would silently diverge. Spread it (`[...FACILITY_OPERATION_ROLES]`)
// when a query needs a text[] bind.
export const FACILITY_OPERATION_ROLES = new Set([
  'PHARMACY_STAFF',
  'PHARMACIST',
  'PHARMACY_INCHARGE',
  'STORES_PURCHASE_INCHARGE',
  'DELIVERY_STAFF',
  'ADMIN',
  'SUPER_ADMIN',
]);
const FACILITY_GRANT_ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(value, field) {
  const normalized = String(value || '').trim();
  if (!UUID_RE.test(normalized)) {
    throw AppError.badRequest(`${field} must be a UUID`, 'PHARMACY_FACILITY_GRANT_INPUT_INVALID');
  }
  return normalized;
}

function requiredReason(value) {
  const normalized = String(value || '').trim();
  if (normalized.length < 10 || normalized.length > 500) {
    throw AppError.badRequest(
      'reason must contain 10 to 500 characters',
      'PHARMACY_FACILITY_GRANT_REASON_REQUIRED',
    );
  }
  return normalized;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function loadGrantAdminTx(tx, tenantId, actorUid, actorRole, { forUpdate = false } = {}) {
  const uid = requiredUuid(actorUid, 'actor_uid');
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
       WHERE tenant_id=$1::uuid AND uid=$2::uuid
         AND is_active=TRUE AND status='active'
         AND is_deleted=FALSE AND merged_into_uid IS NULL
       ${forUpdate ? 'FOR UPDATE' : ''}`,
    tenantId,
    uid,
  );
  const canonicalRole = String(rows[0]?.role || '').trim().toUpperCase();
  if (!rows.length || !FACILITY_GRANT_ADMIN_ROLES.has(canonicalRole)
      || canonicalRole !== String(actorRole || '').trim().toUpperCase()) {
    throw AppError.forbidden(
      'Current tenant administrator authority is required',
      'PHARMACY_FACILITY_GRANT_ADMIN_REQUIRED',
    );
  }
  return { uid, role: canonicalRole };
}

async function authorizeGrantAdminTx(tx, tenantId, actorUid, actorRole) {
  return loadGrantAdminTx(tx, tenantId, actorUid, actorRole);
}

async function lockGrantAdminTx(tx, tenantId, actorUid, actorRole) {
  return loadGrantAdminTx(tx, tenantId, actorUid, actorRole, { forUpdate: true });
}

async function lockGrantCommandTx(tx, tenantId, command) {
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
    `pharmacy-facility-grant-command-v1:${tenantId}:${command.commandKeySha256}`,
  );
}

function commandEvidence(commandKey, payload) {
  const normalizedKey = String(commandKey || '').trim();
  if (!normalizedKey) {
    throw AppError.badRequest(
      'Idempotency-Key is required',
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  const requestPayload = JSON.stringify(payload);
  return {
    commandKeySha256: sha256(normalizedKey),
    requestSha256: sha256(requestPayload),
    requestPayload,
  };
}

async function replayGrantCommandTx(tx, tenantId, command) {
  let rows = await tx.$queryRawUnsafe(
    `SELECT event.request_sha256, event.target_after
       FROM pharmacy_inventory_authority_recovery_events event
      WHERE event.tenant_id=$1::uuid AND event.command_key_sha256=$2
        AND event.event_type='RESOLVED'
        AND event.target_identity->>'entity_type'='staff_facility_grant'
      LIMIT 1`,
    tenantId,
    command.commandKeySha256,
  );
  if (!rows.length) {
    rows = await tx.$queryRawUnsafe(
      `SELECT event.request_sha256, event.evidence->'target_after' AS target_after
         FROM pharmacy_staff_facility_grant_events event
        WHERE event.tenant_id=$1::uuid AND event.command_key_sha256=$2
        LIMIT 1`,
      tenantId,
      command.commandKeySha256,
    );
  }
  if (!rows.length) return null;
  if (rows[0].request_sha256 !== command.requestSha256) {
    throw AppError.conflict(
      'Idempotency-Key is already bound to another facility grant command',
      'IDEMPOTENCY_KEY_REUSED',
    );
  }
  const targetAfter = rows[0].target_after;
  if (!targetAfter || typeof targetAfter !== 'object' || Array.isArray(targetAfter)) {
    throw AppError.conflict(
      'Facility grant command receipt is incomplete and requires recovery',
      'PHARMACY_FACILITY_GRANT_RECEIPT_INCOMPLETE',
    );
  }
  return targetAfter;
}

function grantReceiptSnapshot(grant) {
  if (grant.receipt_snapshot) return grant.receipt_snapshot;
  return {
    id: String(grant.id ?? grant.grant_id),
    facility_id: Number(grant.facility_id),
    staff_uid: String(grant.staff_uid),
    status: grant.status,
    grant_source: grant.grant_source || null,
    grant_reason: grant.grant_reason || null,
    granted_by: grant.granted_by || null,
    granted_at: grant.granted_at || null,
    revoked_by: grant.revoked_by || null,
    revoked_at: grant.revoked_at || null,
    revocation_reason: grant.revocation_reason || null,
    authority_version: Number(grant.authority_version),
    created_at: grant.created_at || null,
    updated_at: grant.updated_at || null,
  };
}

function recoveryReceiptSnapshot(recovery) {
  return {
    id: String(recovery.id),
    entity_type: recovery.entity_type,
    entity_id: String(recovery.entity_id),
    reason_code: recovery.reason_code,
    status: recovery.status,
    resolved_by: recovery.resolved_by || null,
    resolved_at: recovery.resolved_at || null,
    resolution_note: recovery.resolution_note || null,
    authority_snapshot: recovery.authority_snapshot,
    created_at: recovery.created_at,
    updated_at: recovery.updated_at,
  };
}

async function lockGrantRecoveryTx(tx, {
  tenantId,
  staffId,
  recoveryId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, entity_type, entity_id, reason_code, status, resolved_by,
            resolved_at, resolution_note, authority_snapshot, created_at, updated_at
       FROM pharmacy_inventory_authority_recovery_worklist
      WHERE tenant_id=$1::uuid AND entity_type='staff_facility_grant'
        AND entity_id=$2::bigint AND reason_code='STAFF_FACILITY_GRANT_REQUIRED'
        AND ($3::bigint IS NULL OR id=$3::bigint)
        AND ($3::bigint IS NOT NULL OR status='OPEN')
      ORDER BY id
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    Number(staffId),
    recoveryId,
  );
  if (recoveryId != null && !rows.length) {
    throw AppError.conflict(
      'The supplied facility-grant recovery does not match this staff identity',
      'PHARMACY_FACILITY_GRANT_RECOVERY_INVALID',
    );
  }
  if (recoveryId != null && rows[0].status !== 'OPEN') {
    throw AppError.conflict(
      'The supplied facility-grant recovery is not open',
      'PHARMACY_FACILITY_GRANT_RECOVERY_NOT_OPEN',
    );
  }
  return rows[0]?.status === 'OPEN' ? rows[0] : null;
}

export function pharmacyFacilityActorFromRequest(req) {
  return {
    actorUid: req?.user?.uid || null,
    actorRole: req?.user?.role || null,
  };
}

export async function assertPharmacyFacilityGrant(db, {
  tenantId,
  facilityId,
  actorUid,
  actorRole = null,
  forUpdate = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  const fid = positiveId(facilityId);
  const uid = String(actorUid || '').trim();
  if (!fid || !uid) {
    throw AppError.forbidden(
      'An authenticated actor and exact facility are required for pharmacy custody',
      'PHARMACY_FACILITY_GRANT_REQUIRED',
    );
  }
  const actors = await db.$queryRawUnsafe(
    `SELECT actor.id, actor.uid, actor.role, actor.name AS user_name,
            staff.name AS staff_name, staff.id AS staff_id
       FROM users actor
       LEFT JOIN staff
         ON staff.tenant_id=actor.tenant_id AND staff.user_id=actor.uid
        AND staff.is_active=TRUE AND staff.archived=FALSE
       WHERE actor.tenant_id=$1::uuid AND actor.uid=$2::uuid
         AND actor.is_active=TRUE AND actor.status='active'
         AND actor.is_deleted=FALSE AND actor.merged_into_uid IS NULL
       LIMIT 1
       ${forUpdate ? 'FOR UPDATE OF actor' : ''}`,
    tid,
    uid,
  );
  const actor = actors[0];
  const canonicalRole = String(actor?.role || '').trim().toUpperCase();
  if (!actor || !FACILITY_OPERATION_ROLES.has(canonicalRole)
      || (actorRole && canonicalRole !== String(actorRole).trim().toUpperCase())) {
    throw AppError.forbidden(
      'The authenticated actor has no current pharmacy facility authority',
      'PHARMACY_FACILITY_GRANT_REQUIRED',
    );
  }
  const grants = await db.$queryRawUnsafe(
    `SELECT id, granted_at
       FROM pharmacy_staff_facility_grants
       WHERE tenant_id=$1::uuid AND staff_uid=$2::uuid AND facility_id=$3::int
         AND status='active' AND revoked_at IS NULL
       LIMIT 2
       ${forUpdate ? 'FOR UPDATE' : ''}`,
    tid,
    uid,
    fid,
  );
  if (grants.length === 1 && actor.staff_id != null) {
    return {
      actor_id: Number(actor.id),
      actor_uid: uid,
      actor_role: canonicalRole,
      actor_name: actor.staff_name || actor.user_name || null,
      facility_id: fid,
      grant_id: Number(grants[0].id),
      admin_bypass: false,
    };
  }
  throw AppError.forbidden(
    'The actor has no active grant for this pharmacy facility',
    'PHARMACY_FACILITY_GRANT_REQUIRED',
    { facility_id: fid },
  );
}

export function requestedPharmacyFacilityId(req) {
  const raw = req?.body?.facility_id
    ?? req?.query?.facility_id
    ?? req?.get?.('x-facility-id');
  if (raw == null || raw === '') return null;
  const facilityId = positiveId(raw);
  if (!facilityId) {
    throw AppError.badRequest(
      'facility_id must be a positive integer',
      'PHARMACY_FACILITY_INVALID',
    );
  }
  return facilityId;
}

export async function resolvePharmacyFacility(db, {
  tenantId,
  requestedFacilityId = null,
  forUpdate = false,
  requireActorGrant = true,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const facilityId = requestedFacilityId == null ? null : positiveId(requestedFacilityId);
  if (requestedFacilityId != null && !facilityId) {
    throw AppError.badRequest('facility_id must be a positive integer', 'PHARMACY_FACILITY_INVALID');
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT id, facility_code, display_name
      FROM facilities
      WHERE tenant_id = $1::uuid
        AND status = 'active'
        AND ($2::int IS NULL OR id=$2::int)
        AND ($2::int IS NOT NULL OR is_default=TRUE)
      ORDER BY id
      LIMIT 2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    tid,
    facilityId,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      rows.length > 1
        ? 'Multiple active default pharmacy facilities are configured; custody authority is ambiguous'
        : facilityId
        ? 'The requested pharmacy facility is not the authorised default facility'
        : 'No active default pharmacy facility is configured for this tenant',
      'PHARMACY_FACILITY_REQUIRED',
      {
        requested_facility_id: facilityId,
        recovery_action: 'contact_admin_to_configure_one_default_pharmacy_facility',
      },
    );
  }
  const grant = requireActorGrant
    ? await assertPharmacyFacilityGrant(db, {
      tenantId: tid,
      facilityId: Number(rows[0].id),
      actorUid,
      actorRole,
      forUpdate,
    })
    : null;
  return {
    id: Number(rows[0].id),
    facility_code: rows[0].facility_code || null,
    display_name: rows[0].display_name || null,
    actor_authority: grant,
  };
}

export async function resolveOrderPharmacyFacility(db, {
  tenantId,
  orderId,
  requestedFacilityId = null,
  forUpdate = false,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const oid = positiveId(orderId);
  const requested = requestedFacilityId == null ? null : positiveId(requestedFacilityId);
  if (!oid || (requestedFacilityId != null && !requested)) {
    throw AppError.badRequest('Valid order and facility ids are required', 'PHARMACY_FACILITY_INVALID');
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT po.facility_id AS id, facility.facility_code, facility.display_name
       FROM pharmacy_orders po
       JOIN facilities facility
         ON facility.tenant_id=po.tenant_id
        AND facility.id=po.facility_id
        AND facility.status='active'
      WHERE po.tenant_id=$1::uuid AND po.id=$2::int
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF po, facility' : ''}`,
    tid,
    oid,
  );
  if (!rows.length) {
    // ★ 404 BEFORE 409. The JOIN above returns nothing in two very different
    // situations: the order does not exist at all, and the order exists but
    // its facility_id is unset / names a facility that is missing or not
    // 'active'. Reporting both as PHARMACY_ORDER_FACILITY_UNRESOLVED published
    // "unknown resource" as a facility-custody conflict and made the callers'
    // own 404 branches unreachable — every :id lifecycle handler in
    // pharmacyOrderController.js (confirm, preparing, dispatch, counter
    // dispense, unavailable, cancel) consults custody here before it reaches
    // its own not-found branch, so an id naming no row was answered 409.
    //
    // The miss path — and ONLY the miss path — therefore asks whether the order
    // row exists before it classifies the refusal. The happy path is unchanged
    // and costs no extra round trip. A real order whose custody authority is
    // genuinely unresolved still raises the identical 409: it passes this
    // probe and falls through to the throw below.
    //
    // Tenant-scoped by an explicit predicate (never setTenant alone), so an
    // order owned by another tenant reads as "not found" here rather than as a
    // cross-tenant existence disclosure. Under care-team enforcement mode
    // 'enforce' the request never reaches this service: patientAccessGuard
    // already refuses an unresolvable subject with 403
    // PATIENT_CONTEXT_REQUIRED, which is the correct posture there.
    //
    // The refusal is byte-identical to the callers' own terminal branches
    // (AppError.notFound('Order not found'), code NOT_FOUND), so the two are
    // indistinguishable to a client.
    const orderRows = await db.$queryRawUnsafe(
      `SELECT 1 AS present
         FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND id=$2::int
        LIMIT 1`,
      tid,
      oid,
    );
    if (!orderRows.length) {
      throw AppError.notFound('Order not found');
    }
    throw AppError.conflict(
      'The pharmacy order has no active facility custody authority',
      'PHARMACY_ORDER_FACILITY_UNRESOLVED',
      { recovery_action: 'assign_or_reactivate_order_facility' },
    );
  }
  if (requested && Number(rows[0].id) !== requested) {
    throw AppError.conflict(
      'The requested facility does not own this pharmacy order',
      'PHARMACY_ORDER_FACILITY_MISMATCH',
      { requested_facility_id: requested, order_facility_id: Number(rows[0].id) },
    );
  }
  const grant = await assertPharmacyFacilityGrant(db, {
    tenantId: tid,
    facilityId: Number(rows[0].id),
    actorUid,
    actorRole,
    forUpdate,
  });
  return {
    id: Number(rows[0].id),
    facility_code: rows[0].facility_code || null,
    display_name: rows[0].display_name || null,
    actor_authority: grant,
  };
}

export function requireOrderFacility(order) {
  const facilityId = positiveId(order?.facility_id);
  if (!facilityId) {
    throw AppError.conflict(
      'This legacy pharmacy order has no authoritative facility assignment',
      'PHARMACY_ORDER_FACILITY_UNRESOLVED',
      { recovery_action: 'assign_order_facility' },
    );
  }
  return facilityId;
}

export async function listPharmacyFacilityGrants({
  tenantId,
  actorUid,
  actorRole,
  facilityId = null,
  staffUid = null,
  status = 'active',
  limit = 200,
}) {
  const tid = requireTenantId(tenantId);
  const fid = facilityId == null || facilityId === '' ? null : positiveId(facilityId);
  if (facilityId != null && facilityId !== '' && !fid) {
    throw AppError.badRequest(
      'facility_id must be a positive integer',
      'PHARMACY_FACILITY_GRANT_INPUT_INVALID',
    );
  }
  const targetUid = staffUid == null || staffUid === ''
    ? null
    : requiredUuid(staffUid, 'staff_uid');
  const normalizedStatus = String(status || 'active').trim().toLowerCase();
  if (!['active', 'revoked', 'all'].includes(normalizedStatus)) {
    throw AppError.badRequest(
      'status must be active, revoked, or all',
      'PHARMACY_FACILITY_GRANT_INPUT_INVALID',
    );
  }
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  return setTenantTx(tid, async (tx) => {
    await lockGrantAdminTx(tx, tid, actorUid, actorRole);
    return tx.$queryRawUnsafe(
      `SELECT grant_row.id, grant_row.facility_id, facility.facility_code,
              facility.display_name AS facility_name, grant_row.staff_uid,
              COALESCE(staff.name, actor.name) AS staff_name, actor.role AS staff_role,
              grant_row.status, grant_row.grant_source, grant_row.grant_reason,
              grant_row.granted_by, grant_row.granted_at, grant_row.revoked_by,
              grant_row.revoked_at, grant_row.revocation_reason,
              grant_row.authority_version, grant_row.created_at, grant_row.updated_at
         FROM pharmacy_staff_facility_grants grant_row
         JOIN facilities facility
           ON facility.tenant_id=grant_row.tenant_id
          AND facility.id=grant_row.facility_id
         JOIN users actor
           ON actor.tenant_id=grant_row.tenant_id AND actor.uid=grant_row.staff_uid
         LEFT JOIN staff
           ON staff.tenant_id=actor.tenant_id AND staff.user_id=actor.uid
        WHERE grant_row.tenant_id=$1::uuid
          AND ($2::int IS NULL OR grant_row.facility_id=$2::int)
          AND ($3::uuid IS NULL OR grant_row.staff_uid=$3::uuid)
          AND ($4='all' OR grant_row.status=$4)
        ORDER BY grant_row.created_at DESC, grant_row.id DESC
        LIMIT $5::int`,
      tid,
      fid,
      targetUid,
      normalizedStatus,
      boundedLimit,
    );
  });
}

export async function grantPharmacyFacilityAuthority({
  tenantId,
  facilityId,
  staffUid,
  actorUid,
  actorRole,
  reason,
  commandKey,
  recoveryId = null,
}) {
  const tid = requireTenantId(tenantId);
  const fid = positiveId(facilityId);
  if (!fid) {
    throw AppError.badRequest(
      'facility_id must be a positive integer',
      'PHARMACY_FACILITY_GRANT_INPUT_INVALID',
    );
  }
  const targetUid = requiredUuid(staffUid, 'staff_uid');
  const grantReason = requiredReason(reason);
  const normalizedRecoveryId = recoveryId == null || recoveryId === ''
    ? null
    : String(recoveryId).trim();
  // Bound at int8, not merely "digits": recovery ids are bound as `$3::bigint`
  // in lockGrantRecoveryTx, so an unbounded digit string (e.g. 30 nines) would
  // raise the same 22003 the positiveId ceiling above exists to prevent.
  if (normalizedRecoveryId != null && (
    !/^[1-9][0-9]{0,18}$/.test(normalizedRecoveryId)
    || BigInt(normalizedRecoveryId) > PG_INT8_MAX
  )) {
    throw AppError.badRequest(
      'recovery_id must be a positive integer',
      'PHARMACY_FACILITY_GRANT_INPUT_INVALID',
    );
  }
  const command = commandEvidence(commandKey, {
    action: 'grant',
    facility_id: fid,
    staff_uid: targetUid,
    reason: grantReason,
    recovery_id: normalizedRecoveryId,
  });
  return setTenantTx(tid, async (tx) => {
    await authorizeGrantAdminTx(tx, tid, actorUid, actorRole);
    await lockGrantCommandTx(tx, tid, command);
    const admin = await lockGrantAdminTx(tx, tid, actorUid, actorRole);
    const replay = await replayGrantCommandTx(tx, tid, command);
    if (replay) return replay;
    const facilities = await tx.$queryRawUnsafe(
      `SELECT id, facility_code, display_name
         FROM facilities
        WHERE tenant_id=$1::uuid AND id=$2::int AND status='active'
        FOR UPDATE`,
      tid,
      fid,
    );
    if (!facilities.length) {
      throw AppError.conflict(
        'Only an active same-tenant facility can receive a pharmacy grant',
        'PHARMACY_FACILITY_GRANT_FACILITY_INVALID',
      );
    }
    const targets = await tx.$queryRawUnsafe(
      `SELECT actor.uid, actor.role, staff.id AS staff_id,
              COALESCE(staff.name, actor.name) AS staff_name
         FROM users actor
         JOIN staff
           ON staff.tenant_id=actor.tenant_id AND staff.user_id=actor.uid
          AND staff.is_active=TRUE AND staff.archived=FALSE
        WHERE actor.tenant_id=$1::uuid AND actor.uid=$2::uuid
          AND actor.is_active=TRUE AND actor.status='active'
          AND actor.is_deleted=FALSE AND actor.merged_into_uid IS NULL
        FOR UPDATE OF actor, staff`,
      tid,
      targetUid,
    );
    const targetRole = String(targets[0]?.role || '').trim().toUpperCase();
    if (!targets.length || !FACILITY_OPERATION_ROLES.has(targetRole)) {
      throw AppError.conflict(
        'Target staff identity is not eligible for pharmacy facility custody',
        'PHARMACY_FACILITY_GRANT_STAFF_INVALID',
      );
    }
    const recovery = await lockGrantRecoveryTx(tx, {
      tenantId: tid,
      staffId: targets[0].staff_id,
      recoveryId: normalizedRecoveryId,
    });
    const active = await tx.$queryRawUnsafe(
      `SELECT grant_row.id, grant_row.facility_id, grant_row.staff_uid, grant_row.status,
              grant_row.grant_source, grant_row.grant_reason, grant_row.granted_by,
              grant_row.granted_at, grant_row.revoked_by, grant_row.revoked_at,
              grant_row.revocation_reason, grant_row.authority_version,
              grant_row.created_at, grant_row.updated_at,
              jsonb_build_object(
                'id', grant_row.id::text,
                'facility_id', grant_row.facility_id,
                'staff_uid', grant_row.staff_uid,
                'status', grant_row.status,
                'grant_source', grant_row.grant_source,
                'grant_reason', grant_row.grant_reason,
                'granted_by', grant_row.granted_by,
                'granted_at', grant_row.granted_at,
                'revoked_by', grant_row.revoked_by,
                'revoked_at', grant_row.revoked_at,
                'revocation_reason', grant_row.revocation_reason,
                'authority_version', grant_row.authority_version,
                'created_at', grant_row.created_at,
                'updated_at', grant_row.updated_at
              ) AS receipt_snapshot
         FROM pharmacy_staff_facility_grants grant_row
        WHERE grant_row.tenant_id=$1::uuid AND grant_row.facility_id=$2::int
          AND grant_row.staff_uid=$3::uuid
          AND status='active' AND revoked_at IS NULL
        FOR UPDATE`,
      tid,
      fid,
      targetUid,
    );
    if (active.length && !recovery) {
      throw AppError.conflict(
        'Staff already has an active grant for this facility',
        'PHARMACY_FACILITY_GRANT_ALREADY_ACTIVE',
        { grant_id: String(active[0].id) },
      );
    }
    const activeGrantReceipt = active[0] ? grantReceiptSnapshot(active[0]) : null;
    let grant = active[0] ? { ...active[0] } : null;
    if (grant) delete grant.receipt_snapshot;
    let targetAfter = activeGrantReceipt;
    const createdGrant = grant == null;
    if (createdGrant) {
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_staff_facility_grants
           (tenant_id, facility_id, staff_uid, status, grant_source,
            grant_reason, granted_by)
         VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'admin_assignment', $4, $5::uuid)
         RETURNING id, facility_id, staff_uid, status, grant_source, grant_reason,
                   granted_by, granted_at, revoked_by, revoked_at, revocation_reason,
                   authority_version, created_at, updated_at,
                   jsonb_build_object(
                     'id', id::text,
                     'facility_id', facility_id,
                     'staff_uid', staff_uid,
                     'status', status,
                     'grant_source', grant_source,
                     'grant_reason', grant_reason,
                     'granted_by', granted_by,
                     'granted_at', granted_at,
                     'revoked_by', revoked_by,
                     'revoked_at', revoked_at,
                     'revocation_reason', revocation_reason,
                     'authority_version', authority_version,
                     'created_at', created_at,
                     'updated_at', updated_at
                   ) AS receipt_snapshot`,
        tid,
        fid,
        targetUid,
        grantReason,
        admin.uid,
      );
      targetAfter = grantReceiptSnapshot(inserted[0]);
      grant = { ...inserted[0] };
      delete grant.receipt_snapshot;
      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_staff_facility_grant_events
           (tenant_id, grant_id, event_type, actor_uid, reason, authority_version,
            evidence, command_key_sha256, request_sha256, request_payload, contract_version)
         VALUES ($1::uuid, $2::bigint, 'GRANTED', $3::uuid, $4, $5::int,
                 $6::jsonb, $7, $8, $9::jsonb, 1)`,
        tid,
        grant.id,
        admin.uid,
        grantReason,
        Number(grant.authority_version),
        JSON.stringify({
          facility: facilities[0],
          staff_uid: targetUid,
          staff_name: targets[0].staff_name || null,
          staff_role: targetRole,
          target_after: targetAfter,
        }),
        command.commandKeySha256,
        command.requestSha256,
        command.requestPayload,
      );
    }
    if (recovery) {
      await tx.$queryRawUnsafe(
        `SELECT
           set_config('app.pharmacy_recovery_actor_uid', $1, TRUE) AS actor_uid,
           set_config('app.pharmacy_recovery_request_id', $2, TRUE) AS request_id,
           set_config('app.pharmacy_recovery_command_key_sha256', $3, TRUE) AS command_sha,
           set_config('app.pharmacy_recovery_request_sha256', $4, TRUE) AS request_sha,
           set_config('app.pharmacy_recovery_request_payload', $5, TRUE) AS request_payload,
           set_config('app.pharmacy_recovery_resolution_payload', $6, TRUE) AS resolution_payload,
           set_config('app.pharmacy_recovery_target_identity', $7, TRUE) AS target_identity,
           set_config('app.pharmacy_recovery_target_before', $8, TRUE) AS target_before,
           set_config('app.pharmacy_recovery_target_after', $9, TRUE) AS target_after`,
        admin.uid,
        String(commandKey).slice(0, 200),
        command.commandKeySha256,
        command.requestSha256,
        command.requestPayload,
        JSON.stringify({
          action: createdGrant
            ? 'CREATE_EXACT_FACILITY_GRANT'
            : 'CLOSE_WITH_EXISTING_EXACT_FACILITY_GRANT',
          facility_id: fid,
          staff_uid: targetUid,
          recovery_id: String(recovery.id),
        }),
        JSON.stringify({
          entity_type: 'staff_facility_grant',
          recovery_id: String(recovery.id),
          staff_id: String(targets[0].staff_id),
          staff_uid: targetUid,
          grant_id: String(grant.id),
        }),
        JSON.stringify({
          recovery: recoveryReceiptSnapshot(recovery),
          facility: facilities[0],
          staff_id: String(targets[0].staff_id),
          staff_uid: targetUid,
          staff_role: targetRole,
          active_grant: activeGrantReceipt,
        }),
        JSON.stringify(targetAfter),
      );
      const resolved = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_inventory_authority_recovery_worklist
            SET status='RESOLVED', resolved_by=$4::uuid, resolved_at=NOW(),
                resolution_note=$5, updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::bigint
            AND entity_type='staff_facility_grant' AND entity_id=$3::bigint
            AND reason_code='STAFF_FACILITY_GRANT_REQUIRED' AND status='OPEN'
          RETURNING id, entity_type, entity_id, reason_code, status, resolved_by,
                    resolved_at, resolution_note, authority_snapshot, created_at, updated_at`,
        tid,
        String(recovery.id),
        Number(targets[0].staff_id),
        admin.uid,
        createdGrant
          ? 'Explicit active facility grant created by tenant administrator'
          : 'Existing exact active facility grant verified by tenant administrator',
      );
      if (resolved.length !== 1) {
        throw AppError.conflict(
          'Facility-grant recovery changed before resolution',
          'PHARMACY_FACILITY_GRANT_RECOVERY_STATE_CHANGED',
        );
      }
    }
    return targetAfter;
  });
}

export async function revokePharmacyFacilityAuthority({
  tenantId,
  grantId,
  actorUid,
  actorRole,
  reason,
  commandKey,
}) {
  const tid = requireTenantId(tenantId);
  const id = String(grantId ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw AppError.badRequest(
      'grant_id must be a positive integer',
      'PHARMACY_FACILITY_GRANT_INPUT_INVALID',
    );
  }
  const revokeReason = requiredReason(reason);
  const command = commandEvidence(commandKey, {
    action: 'revoke',
    grant_id: id,
    reason: revokeReason,
  });
  return setTenantTx(tid, async (tx) => {
    await authorizeGrantAdminTx(tx, tid, actorUid, actorRole);
    await lockGrantCommandTx(tx, tid, command);
    const admin = await lockGrantAdminTx(tx, tid, actorUid, actorRole);
    const replay = await replayGrantCommandTx(tx, tid, command);
    if (replay) return replay;
    const rows = await tx.$queryRawUnsafe(
      `SELECT grant_row.*, staff.id AS staff_id, actor.role AS staff_role
         FROM pharmacy_staff_facility_grants grant_row
         JOIN users actor
           ON actor.tenant_id=grant_row.tenant_id AND actor.uid=grant_row.staff_uid
         JOIN staff
           ON staff.tenant_id=actor.tenant_id AND staff.user_id=actor.uid
        WHERE grant_row.tenant_id=$1::uuid AND grant_row.id=$2::bigint
        FOR UPDATE OF grant_row, actor, staff`,
      tid,
      id,
    );
    if (!rows.length) throw AppError.notFound('Pharmacy facility grant not found');
    if (rows[0].status !== 'active' || rows[0].revoked_at != null) {
      throw AppError.conflict(
        'Only an active facility grant can be revoked',
        'PHARMACY_FACILITY_GRANT_NOT_ACTIVE',
      );
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_staff_facility_grants
          SET status='revoked', revoked_by=$3::uuid, revoked_at=NOW(),
              revocation_reason=$4, authority_version=authority_version+1,
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::bigint
          AND status='active' AND revoked_at IS NULL
        RETURNING id, facility_id, staff_uid, status, grant_source, grant_reason,
                   granted_by, granted_at, revoked_by, revoked_at, revocation_reason,
                   authority_version, created_at, updated_at,
                   jsonb_build_object(
                     'id', id::text,
                     'facility_id', facility_id,
                     'staff_uid', staff_uid,
                     'status', status,
                     'grant_source', grant_source,
                     'grant_reason', grant_reason,
                     'granted_by', granted_by,
                     'granted_at', granted_at,
                     'revoked_by', revoked_by,
                     'revoked_at', revoked_at,
                     'revocation_reason', revocation_reason,
                     'authority_version', authority_version,
                     'created_at', created_at,
                     'updated_at', updated_at
                   ) AS receipt_snapshot`,
      tid,
      id,
      admin.uid,
      revokeReason,
    );
    if (!updated.length) {
      throw AppError.conflict(
        'Facility grant changed before revocation',
        'PHARMACY_FACILITY_GRANT_STATE_CHANGED',
      );
    }
    const grant = updated[0];
    const targetAfter = grantReceiptSnapshot(grant);
    await tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_staff_facility_grant_events
         (tenant_id, grant_id, event_type, actor_uid, reason, authority_version,
          evidence, command_key_sha256, request_sha256, request_payload, contract_version)
       VALUES ($1::uuid, $2::bigint, 'REVOKED', $3::uuid, $4, $5::int,
               $6::jsonb, $7, $8, $9::jsonb, 1)`,
      tid,
      grant.id,
      admin.uid,
      revokeReason,
      Number(grant.authority_version),
      JSON.stringify({
        facility_id: Number(grant.facility_id),
        staff_uid: grant.staff_uid,
        prior_authority_version: Number(rows[0].authority_version),
        target_after: targetAfter,
      }),
      command.commandKeySha256,
      command.requestSha256,
      command.requestPayload,
    );
    const remaining = await tx.$queryRawUnsafe(
      `SELECT id
         FROM pharmacy_staff_facility_grants
        WHERE tenant_id=$1::uuid AND staff_uid=$2::uuid
          AND status='active' AND revoked_at IS NULL
        LIMIT 1`,
      tid,
      grant.staff_uid,
    );
    if (!remaining.length) {
      const recoverySnapshot = {
        staff_uid: grant.staff_uid,
        role: rows[0].staff_role,
        revoked_grant_id: String(grant.id),
        revoked_facility_id: Number(grant.facility_id),
      };
      const existingRecovery = await tx.$queryRawUnsafe(
        `SELECT id, entity_type, entity_id, reason_code, status, resolved_by,
                resolved_at, resolution_note, authority_snapshot, created_at, updated_at
           FROM pharmacy_inventory_authority_recovery_worklist
          WHERE tenant_id=$1::uuid AND entity_type='staff_facility_grant'
            AND entity_id=$2::bigint
            AND reason_code='STAFF_FACILITY_GRANT_REQUIRED'
          FOR UPDATE`,
        tid,
        Number(rows[0].staff_id),
      );
      if (existingRecovery[0]?.status === 'RESOLVED') {
        const recovery = existingRecovery[0];
        const targetBefore = recoveryReceiptSnapshot(recovery);
        const targetIdentity = {
          recovery_id: String(recovery.id),
          entity_type: recovery.entity_type,
          entity_id: String(recovery.entity_id),
          reason_code: recovery.reason_code,
        };
        await tx.$queryRawUnsafe(
          `SELECT
             set_config('app.pharmacy_recovery_actor_uid', $1, TRUE) AS actor_uid,
             set_config('app.pharmacy_recovery_request_id', $2, TRUE) AS request_id,
             set_config('app.pharmacy_recovery_command_key_sha256', $3, TRUE) AS command_sha,
             set_config('app.pharmacy_recovery_request_sha256', $4, TRUE) AS request_sha,
             set_config('app.pharmacy_recovery_request_payload', $5, TRUE) AS request_payload,
             set_config('app.pharmacy_recovery_resolution_payload', $6, TRUE) AS resolution_payload,
             set_config('app.pharmacy_recovery_target_identity', $7, TRUE) AS target_identity,
             set_config('app.pharmacy_recovery_target_before', $8, TRUE) AS target_before,
             set_config('app.pharmacy_recovery_target_after', $9, TRUE) AS target_after`,
          admin.uid,
          String(commandKey).slice(0, 200),
          sha256(`${command.commandKeySha256}:staff_facility_grant:${recovery.id}:reopen`),
          command.requestSha256,
          command.requestPayload,
          JSON.stringify({
            action: 'REOPEN_STAFF_FACILITY_GRANT_RECOVERY',
            revoked_grant_id: String(grant.id),
            recovery_id: String(recovery.id),
          }),
          JSON.stringify(targetIdentity),
          JSON.stringify(targetBefore),
          JSON.stringify({ captured_by: 'recovery_event_trigger_new_row' }),
        );
      }
      const reopened = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_authority_recovery_worklist
           (tenant_id, entity_type, entity_id, reason_code, authority_snapshot)
         VALUES ($1::uuid, 'staff_facility_grant', $2::bigint,
                 'STAFF_FACILITY_GRANT_REQUIRED', $3::jsonb)
         ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO UPDATE
           SET status='OPEN', resolved_by=NULL, resolved_at=NULL, resolution_note=NULL,
               authority_snapshot=EXCLUDED.authority_snapshot, updated_at=NOW()
         RETURNING to_jsonb(pharmacy_inventory_authority_recovery_worklist) AS target_after`,
        tid,
        Number(rows[0].staff_id),
        JSON.stringify(recoverySnapshot),
      );
      if (!reopened[0]?.target_after?.updated_at) {
        throw AppError.conflict(
          'Facility-grant recovery returned incomplete receipt evidence',
          'PHARMACY_FACILITY_GRANT_RECOVERY_RECEIPT_INCOMPLETE',
        );
      }
    }
    return targetAfter;
  });
}
