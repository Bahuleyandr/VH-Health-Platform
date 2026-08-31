// src/routes/pharmacy/inventoryV2Routes.js
//
// Pharmacy operational inventory endpoints. Mounted at both the canonical
// /api/v1/pharmacy-orders/inventory/v2/* host and the /api/v1/pharmacy alias.
// Generic movement and standalone controlled-dispense routes remain explicit
// 410 tombstones; stock decrements are exposed only through typed workflows.

import { Router } from 'express';
import * as inv from '../../services/pharmacy/inventoryV2Service.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  ADMIN,
  PHARMACY_INCHARGE,
  PHARMACIST,
  PHARMACY_STAFF,
  STORES_PURCHASE_INCHARGE,
  SUPER_ADMIN,
  hasRole,
  normalizeRole,
} from '../../utils/roles.js';
import {
  grantPharmacyFacilityAuthority,
  listPharmacyFacilityGrants,
  revokePharmacyFacilityAuthority,
} from '../../services/pharmacy/pharmacyFacilityAuthorityService.js';
import { StaffAuthService } from '../../services/auth/staffAuthService.js';
import { AppError } from '../../utils/AppError.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';

const router = Router();
export const pharmacyInventoryDisposalWitnessApprovalRoutes = Router({ mergeParams: true });
export const pharmacyInventoryWitnessApprovalRoutes = Router({ mergeParams: true });
export const pharmacyInventoryMovementWitnessApprovalRoutes = Router({ mergeParams: true });
const INVENTORY_V2_CANONICAL_PATH = '/api/v1/pharmacy-orders/inventory/v2';

function inventoryV2IdempotencyPath(suffix) {
  return `${INVENTORY_V2_CANONICAL_PATH}${suffix}`;
}

function inventoryV2ApprovalIdempotencyPath(suffix) {
  return (req) => `${inventoryV2IdempotencyPath(suffix)}/${encodeURIComponent(
    String(req.params.id),
  )}/approve`;
}

export const PHARMACY_INVENTORY_READ_ROLES = [
  ADMIN,
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  PHARMACIST,
  STORES_PURCHASE_INCHARGE,
];

export const PHARMACY_INVENTORY_MAINTAIN_ROLES = [
  ADMIN,
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  PHARMACIST,
  STORES_PURCHASE_INCHARGE,
];

export const PHARMACY_INVENTORY_ADMIN_ROLES = [
  ADMIN,
  PHARMACY_INCHARGE,
  STORES_PURCHASE_INCHARGE,
];

// ADMIN was removed here deliberately: facility custody is an operator
// identity, not a rank. PHARMACIST is an operator identity — it is a member of
// pharmacyFacilityAuthorityService.FACILITY_OPERATION_ROLES, so it can hold the
// ACTIVE facility grant every downstream custody check demands, exactly like
// PHARMACY_STAFF. Dropping it alongside ADMIN was collateral, and it 403s a
// licensed pharmacist out of the dispensing surface. Keep it listed.
export const PHARMACY_CONTROLLED_DISPENSE_ROLES = [
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  PHARMACIST,
];

export const PHARMACY_INVENTORY_DISPOSAL_ROLES = [
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
];

export const PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES = [
  ...inv.CONTROLLED_DISPENSE_WITNESS_ROLES,
];

export const PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES = [
  ...inv.FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES,
];

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Inventory error');
    }
  };
}

function requireInventoryRole(allowedRoles, message) {
  return (req, res, next) => {
    if (!hasRole(req.user, allowedRoles) && !hasRole(req.user?.rawRole, allowedRoles)) {
      return error(res, message, 403);
    }
    return next();
  };
}

function requireInventoryRead(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_READ_ROLES,
    'Pharmacy inventory role required',
  )(req, res, next);
}

function requireInventoryMaintain(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_MAINTAIN_ROLES,
    'Pharmacy inventory maintenance role required',
  )(req, res, next);
}

function requireInventoryAdmin(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_ADMIN_ROLES,
    'Pharmacy incharge or stores/purchase role required',
  )(req, res, next);
}

function requireFacilityGrantAdmin(req, res, next) {
  return requireInventoryRole(
    [ADMIN, SUPER_ADMIN],
    'Tenant administrator role required for pharmacy facility grants',
  )(req, res, next);
}

function requireControlledDispense(req, res, next) {
  return requireInventoryRole(
    PHARMACY_CONTROLLED_DISPENSE_ROLES,
    'Pharmacy dispensing role required',
  )(req, res, next);
}

// ★ Facility custody is held by an operator identity, never by rank. `hasRole`
// grants SUPER_ADMIN every list unconditionally, and the rawRole leg of
// requireInventoryRole re-admits it even after canonicalizeRequestRole has
// flattened the request role to ADMIN — so the disposal gate, which
// deliberately excludes ADMIN, was still letting the rank above ADMIN through
// to a Schedule X destruction it holds no pharmacy facility grant for.
// inventoryV2Service refuses such a performer (INVENTORY_DISPOSAL_PERFORMER_ROLES)
// so nothing could be destroyed, but the gate must not invent the authority in
// the first place. Literal membership only, on both the canonical and the raw
// role.
function hasLiteralInventoryRole(user, allowedRoles) {
  const allowed = allowedRoles.map(normalizeRole).filter(Boolean);
  return [user?.role, user?.rawRole]
    .map(normalizeRole)
    .some((role) => Boolean(role) && allowed.includes(role));
}

function requireInventoryDisposal(req, res, next) {
  if (!hasLiteralInventoryRole(req.user, PHARMACY_INVENTORY_DISPOSAL_ROLES)) {
    return error(res, 'Pharmacy facility custody role required', 403);
  }
  return next();
}

function requireControlledDispenseApprovalHost(req, res, next) {
  return requireInventoryRole(
    PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES,
    'Clinical witness role required',
  )(req, res, next);
}

function requireInventoryDisposalApprovalHost(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES,
    'Pharmacy facility custody witness role required',
  )(req, res, next);
}

export async function resolveWitnessActor(req, tenantId) {
  const employeeId = req.body?.employeeId;
  const password = req.body?.password;
  if (employeeId == null && password == null) {
    return {
      actorUid: req.user?.uid,
      actorRole: req.user?.role || req.user?.rawRole || null,
      requesterUid: null,
    };
  }
  try {
    if (!employeeId || !password) {
      throw AppError.badRequest(
        'Witness employee ID and password are required together',
        'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_REQUIRED',
      );
    }
    const witness = await StaffAuthService.authenticateControlledDispenseWitness({
      employeeId,
      password,
      req,
      tenantId,
    });
    if (String(witness.tenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
      throw AppError.forbidden(
        'Witness authentication tenant mismatch',
        'CONTROLLED_DISPENSE_WITNESS_TENANT_MISMATCH',
      );
    }
    return {
      actorUid: witness.uid,
      actorRole: witness.role || null,
      requesterUid: req.user?.uid,
    };
  } finally {
    if (req.body && Object.hasOwn(req.body, 'password')) delete req.body.password;
  }
}

const INVENTORY_DISPOSAL_INTENT_FIELDS = [
  'facility_id',
  'inventory_item_id',
  'inventory_batch_id',
  'quantity',
  'reason_code',
  'disposition_method',
  'authority_reference',
  'expected_batch_number',
  'expected_lot_number',
  'expected_expiry_date',
  'notes',
];

const INVENTORY_DISPOSAL_CALLER_AUTHORITY_FIELDS = [
  'tenantId',
  'tenant_id',
  'movement_kind',
  'reference_type',
  'reference_id',
  'performed_by',
  'performed_by_name',
  'requested_by',
  'requesterUid',
  'actorUid',
  'actorRole',
  'commandKey',
  'requestFingerprint',
  'performer_role',
  'facility_grant_id',
  'witness',
  'witness_uid',
  'witness_name',
  'witness_role',
  'schedule_class',
  'is_narcotic',
  'catalog_id',
  'supplier_id',
  'storage_location_id',
  'source_batch_status',
  'resulting_batch_status',
  'remaining_quantity_before',
  'remaining_quantity_after',
  'controlled_item',
  'register_required',
  'witness_required',
  'controlled_authority',
  'facility_authority',
  'batch_policy',
  'batch_safety_contract',
  'contract',
  'authoritative_catalog_id',
  'authoritative_batch_id',
  'authoritative_supplier_id',
  'authoritative_storage_location_id',
  'batch_number',
  'lot_number',
  'expiry_date',
  'batch_status',
  'item_status',
  'remaining_quantity',
  'unit_label',
  'receipt',
  'metadata',
];

function assertNoInventoryDisposalCallerAuthority(
  body,
  { allowWitnessApproval = false } = {},
) {
  const source = body && typeof body === 'object' ? body : {};
  const forbidden = INVENTORY_DISPOSAL_CALLER_AUTHORITY_FIELDS.filter((field) => (
    Object.hasOwn(source, field)
    && source[field] !== undefined
    && source[field] !== null
    && source[field] !== ''
  ));
  if (!allowWitnessApproval && Object.hasOwn(source, 'witness_approval_id')) {
    forbidden.push('witness_approval_id');
  }
  if (forbidden.length > 0) {
    throw AppError.badRequest(
      'Inventory disposal identity, authority, movement, and witness are server-derived',
      'INVENTORY_DISPOSAL_CALLER_AUTHORITY_REJECTED',
      { forbidden_fields: forbidden },
    );
  }
}

function inventoryDisposalIntent(body, { includeWitnessApproval = false } = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const intent = Object.fromEntries(
    INVENTORY_DISPOSAL_INTENT_FIELDS.map((field) => [field, source[field]]),
  );
  if (includeWitnessApproval) intent.witness_approval_id = source.witness_approval_id;
  return intent;
}

function disposalWitnessApprovalIdempotencyBody(req) {
  const body = req.body || {};
  const usesStaffPassword = Object.hasOwn(body, 'employeeId') || Object.hasOwn(body, 'password');
  return {
    credentialMode: usesStaffPassword ? 'staff_password' : 'bearer',
    employeeId: usesStaffPassword
      ? String(body.employeeId || '').trim().toUpperCase() || null
      : null,
    disposal: inventoryDisposalIntent(body.disposal),
  };
}

function retiredInventoryMutation(message, code) {
  return async () => {
    throw new AppError(message, 410, code);
  };
}

// ── Drug master / items ───────────────────────────────────────────────
router.get('/items', requireInventoryRead, wrap(async (req) => inv.listItems({
  tenantId: inv.tenantOf(req),
  actorUid: req.user?.uid,
  actorRole: req.user?.role,
  search: req.query.q,
  schedule: req.query.schedule,
  status: req.query.status,
  catalogId: req.query.catalog_id,
  facilityId: req.query.facility_id,
  limit: req.query.limit,
})));

router.post('/items', requireInventoryAdmin, wrap(async (req) => inv.createItem({
  tenantId: inv.tenantOf(req),
  item: req.body,
  actorUid: req.user?.uid,
  actorRole: req.user?.role,
})));

router.get('/facility-grants', requireFacilityGrantAdmin, wrap(async (req) => (
  listPharmacyFacilityGrants({
    tenantId: inv.tenantOf(req),
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    facilityId: req.query.facility_id,
    staffUid: req.query.staff_uid,
    status: req.query.status,
    limit: req.query.limit,
  })
)));

router.post('/facility-grants', requireFacilityGrantAdmin,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_facility_grant_create',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath('/facility-grants'),
  }),
  wrap(async (req) => grantPharmacyFacilityAuthority({
    tenantId: inv.tenantOf(req),
    facilityId: req.body?.facility_id,
    staffUid: req.body?.staff_uid,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    reason: req.body?.reason,
    recoveryId: req.body?.recovery_id,
    commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
  })));

router.post('/facility-grants/:id/revoke', requireFacilityGrantAdmin,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_facility_grant_revoke',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: (req) => inventoryV2IdempotencyPath(
      `/facility-grants/${encodeURIComponent(String(req.params.id))}/revoke`,
    ),
  }),
  wrap(async (req) => revokePharmacyFacilityAuthority({
    tenantId: inv.tenantOf(req),
    grantId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    reason: req.body?.reason,
    commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
  })));

// ── Batches ───────────────────────────────────────────────────────────
router.get('/batches', requireInventoryRead, wrap(async (req) => inv.listBatches({
  tenantId: inv.tenantOf(req),
  actorUid: req.user?.uid,
  actorRole: req.user?.role,
  item_id: req.query.item_id,
  facility_id: req.query.facility_id,
  expiring_in_days: req.query.expiring_in_days,
  status: req.query.status,
  limit: req.query.limit,
})));

router.get('/authority-recovery', requireInventoryAdmin, wrap(async (req) => (
  inv.listAuthorityRecovery({
    tenantId: inv.tenantOf(req),
    status: req.query.status,
    entityType: req.query.entity_type,
    facilityId: req.query.facility_id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    limit: req.query.limit,
  })
)));

router.post('/authority-recovery/:id/resolve', requireInventoryAdmin,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_authority_recovery',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: (req) => inventoryV2IdempotencyPath(
      `/authority-recovery/${encodeURIComponent(String(req.params.id))}/resolve`,
    ),
  }),
  wrap(async (req) => inv.resolveAuthorityRecovery({
    tenantId: inv.tenantOf(req),
    recoveryId: req.params.id,
    resolution: req.body?.resolution || {},
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id || null,
    commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
    requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
    note: req.body?.resolution_note,
  })));

router.get('/ward-allocation-authority-recovery', requireInventoryAdmin, wrap(async (req) => (
  inv.listWardAllocationAuthorityRecovery({
    tenantId: inv.tenantOf(req),
    facilityId: req.query.facility_id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    status: req.query.status,
    limit: req.query.limit,
  })
)));

router.post('/ward-allocation-authority-recovery/:id/resolve', requireInventoryAdmin,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_ward_allocation_authority_recovery',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: (req) => inventoryV2IdempotencyPath(
      `/ward-allocation-authority-recovery/${encodeURIComponent(
        String(req.params.id),
      )}/resolve`,
    ),
  }),
  wrap(async (req) => inv.resolveWardAllocationAuthorityRecovery({
    tenantId: inv.tenantOf(req),
    recoveryId: req.params.id,
    resolution: req.body?.resolution || {},
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id || null,
    commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
    requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
    note: req.body?.resolution_note,
  })));

// ── Stock movements ───────────────────────────────────────────────────
router.post('/disposals', requireInventoryDisposal,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_disposal',
    retainOnServerError: true,
    durableDomainReceipt: true,
    revalidateCompletedReplay: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath('/disposals'),
  }),
  wrap(async (req) => {
    assertNoInventoryDisposalCallerAuthority(req.body, { allowWitnessApproval: true });
    return inv.disposeInventoryBatch({
      ...req.body,
      tenantId: inv.tenantOf(req),
      performed_by: req.user?.uid,
      actorRole: req.user?.role || req.user?.rawRole || null,
      commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
      requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
      requireExistingReceipt: req.idempotencyClaim?.completedReplay === true,
    });
  }));

router.post('/disposals/witness-approvals', requireInventoryDisposal,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_disposal_witness_request',
    retainOnServerError: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath('/disposals/witness-approvals'),
  }),
  wrap(async (req) => {
    assertNoInventoryDisposalCallerAuthority(req.body);
    return inv.requestInventoryDisposalWitnessApproval({
      ...req.body,
      tenantId: inv.tenantOf(req),
      requested_by: req.user?.uid,
      actorRole: req.user?.role || req.user?.rawRole || null,
    });
  }));

pharmacyInventoryDisposalWitnessApprovalRoutes.post('/',
  requireInventoryDisposalApprovalHost,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_disposal_witness_approval',
    retainOnServerError: true,
    requestBodyForIdempotency: disposalWitnessApprovalIdempotencyBody,
    requestPathForIdempotency: inventoryV2ApprovalIdempotencyPath(
      '/disposals/witness-approvals',
    ),
  }),
  wrap(async (req) => {
    try {
      assertNoInventoryDisposalCallerAuthority(req.body);
      assertNoInventoryDisposalCallerAuthority(req.body?.disposal);
      const tenantId = inv.tenantOf(req);
      const usesStaffPassword = Object.hasOwn(req.body || {}, 'employeeId')
        || Object.hasOwn(req.body || {}, 'password');
      await inv.preflightInventoryDisposalWitnessApproval({
        tenantId,
        approvalId: req.params.id,
        requesterUid: usesStaffPassword ? req.user?.uid : null,
        disposal: req.body?.disposal || {},
      });
      const actor = await resolveWitnessActor(req, tenantId);
      return inv.approveInventoryDisposalWitnessApproval({
        tenantId,
        approvalId: req.params.id,
        actorUid: actor.actorUid,
        actorRole: actor.actorRole,
        requesterUid: actor.requesterUid,
        disposal: req.body?.disposal || {},
      });
    } finally {
      if (req.body && Object.hasOwn(req.body, 'password')) delete req.body.password;
    }
  }));

router.post('/movements', requireInventoryMaintain,
  wrap(retiredInventoryMutation(
    'Generic inventory movements are retired; use the governed receipt, return, dispense, or disposal workflow',
    'INVENTORY_GENERIC_MOVEMENT_RETIRED',
  )));

// ── Schedule H/H1/X register ──────────────────────────────────────────
router.post('/movements/witness-approvals', requireInventoryMaintain,
  wrap(retiredInventoryMutation(
    'Generic movement witness approvals are retired with the generic inventory movement endpoint',
    'INVENTORY_GENERIC_MOVEMENT_RETIRED',
  )));

router.post('/controlled-dispense/witness-approvals', requireControlledDispense,
  wrap(retiredInventoryMutation(
    'Standalone controlled dispensing is retired; use a governed pharmacy-order or counter-sale workflow',
    'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
  )));

pharmacyInventoryWitnessApprovalRoutes.post('/',
  requireControlledDispenseApprovalHost,
  wrap(retiredInventoryMutation(
    'Standalone controlled dispensing is retired; use a governed pharmacy-order or counter-sale workflow',
    'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
  )));

pharmacyInventoryMovementWitnessApprovalRoutes.post('/',
  requireControlledDispenseApprovalHost,
  wrap(retiredInventoryMutation(
    'Generic movement witness approvals are retired with the generic inventory movement endpoint',
    'INVENTORY_GENERIC_MOVEMENT_RETIRED',
  )));

router.post('/controlled-dispense', requireControlledDispense,
  wrap(retiredInventoryMutation(
    'Standalone controlled dispensing is retired; use a governed pharmacy-order or counter-sale workflow',
    'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
  )));

router.get('/schedule-register', requireInventoryRead, wrap(async (req) => inv.listScheduleRegister({
  tenantId: inv.tenantOf(req),
  actorUid: req.user?.uid,
  actorRole: req.user?.role,
  facility_id: req.query.facility_id,
  schedule_class: req.query.schedule_class,
  item_id: req.query.item_id,
  date_from: req.query.date_from,
  date_to: req.query.date_to,
  limit: req.query.limit,
})));

// ── Expiry scan ───────────────────────────────────────────────────────
router.post('/run-expiry-scan', requireInventoryAdmin, wrap(async (req) =>
  inv.runExpiryScan({
    tenantId: inv.tenantOf(req),
    facilityId: req.body?.facility_id ?? req.query?.facility_id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  }),
));

router.get('/expiry-alerts', requireInventoryRead, wrap(async (req) => inv.listExpiryAlerts({
  tenantId: inv.tenantOf(req),
  facilityId: req.query.facility_id,
  actorUid: req.user?.uid,
  actorRole: req.user?.role,
  bucket: req.query.bucket,
  limit: req.query.limit,
})));

export default router;
