// src/routes/pharmacy/inventoryV2Routes.js
//
// Sprint 2 — Pharmacy operational inventory endpoints. Mounted at
// /api/v1/pharmacy/inventory/v2/*. The legacy inventoryRoutes.js
// remains for back-compat (it exposes /categories/list).

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

export const PHARMACY_CONTROLLED_DISPENSE_ROLES = [
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
];

export const PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES = [
  ...inv.CONTROLLED_DISPENSE_WITNESS_ROLES,
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

function requireControlledDispenseApprovalHost(req, res, next) {
  return requireInventoryRole(
    PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES,
    'Clinical witness role required',
  )(req, res, next);
}

export async function resolveWitnessActor(req, tenantId) {
  const employeeId = req.body?.employeeId;
  const password = req.body?.password;
  if (employeeId == null && password == null) {
    return { actorUid: req.user?.uid, requesterUid: null };
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
    return { actorUid: witness.uid, requesterUid: req.user?.uid };
  } finally {
    if (req.body && Object.hasOwn(req.body, 'password')) delete req.body.password;
  }
}

function witnessApprovalIdempotencyBody(req) {
  const body = req.body || {};
  const usesStaffPassword = Object.hasOwn(body, 'employeeId') || Object.hasOwn(body, 'password');
  return {
    credentialMode: usesStaffPassword ? 'staff_password' : 'bearer',
    employeeId: usesStaffPassword
      ? String(body.employeeId || '').trim().toUpperCase() || null
      : null,
    dispense: body.dispense || {},
  };
}

function movementWitnessApprovalIdempotencyBody(req) {
  const body = req.body || {};
  const usesStaffPassword = Object.hasOwn(body, 'employeeId') || Object.hasOwn(body, 'password');
  return {
    credentialMode: usesStaffPassword ? 'staff_password' : 'bearer',
    employeeId: usesStaffPassword
      ? String(body.employeeId || '').trim().toUpperCase() || null
      : null,
    movement: body.movement || {},
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
router.post('/movements', requireInventoryMaintain,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_movement',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath('/movements'),
  }),
  wrap(async (req) => inv.recordMovement({
    ...req.body,
    tenantId: inv.tenantOf(req),
    performed_by: req.user?.uid,
    performed_by_name: req.user?.name || null,
    commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
    requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
  })));

// ── Schedule H/H1/X register ──────────────────────────────────────────
router.post('/movements/witness-approvals', requireInventoryMaintain,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_movement_witness_request',
    retainOnServerError: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath('/movements/witness-approvals'),
  }),
  wrap(async (req) => inv.requestControlledMovementWitnessApproval({
    ...req.body,
    tenantId: inv.tenantOf(req),
    requested_by: req.user?.uid,
  })));

router.post('/controlled-dispense/witness-approvals', requireControlledDispense,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_witness_request',
    retainOnServerError: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath(
      '/controlled-dispense/witness-approvals',
    ),
  }),
  wrap(async (req) => inv.requestControlledDispenseWitnessApproval({
    ...req.body,
    tenantId: inv.tenantOf(req),
    requested_by: req.user?.uid,
  })));

pharmacyInventoryWitnessApprovalRoutes.post('/',
  requireControlledDispenseApprovalHost,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_witness_approval',
    retainOnServerError: true,
    requestBodyForIdempotency: witnessApprovalIdempotencyBody,
    requestPathForIdempotency: inventoryV2ApprovalIdempotencyPath(
      '/controlled-dispense/witness-approvals',
    ),
  }),
  wrap(async (req) => {
    const tenantId = inv.tenantOf(req);
    const actor = await resolveWitnessActor(req, tenantId);
    return inv.approveInventoryDispenseWitnessApproval({
      tenantId,
      approvalId: req.params.id,
      ...actor,
      dispense: req.body.dispense || {},
    });
  }));

pharmacyInventoryMovementWitnessApprovalRoutes.post('/',
  requireControlledDispenseApprovalHost,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_movement_witness_approval',
    retainOnServerError: true,
    requestBodyForIdempotency: movementWitnessApprovalIdempotencyBody,
    requestPathForIdempotency: inventoryV2ApprovalIdempotencyPath(
      '/movements/witness-approvals',
    ),
  }),
  wrap(async (req) => {
    const tenantId = inv.tenantOf(req);
    const actor = await resolveWitnessActor(req, tenantId);
    return inv.approveInventoryMovementWitnessApproval({
      tenantId,
      approvalId: req.params.id,
      ...actor,
      movement: req.body.movement || {},
    });
  }));

router.post('/controlled-dispense', requireControlledDispense,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_controlled_dispense',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: inventoryV2IdempotencyPath('/controlled-dispense'),
  }),
  wrap(async (req) => inv.dispenseControlled({
    ...req.body,
    tenantId: inv.tenantOf(req),
    performed_by: req.user?.uid,
    performed_by_name: req.user?.name || null,
    require_prescription_authority: true,
    commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
    requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
  })));

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
