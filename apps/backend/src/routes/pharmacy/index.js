import express from 'express';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import logger from '../../logging/logger.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import adminRoutes from './adminRoutes.js';
import inventoryRoutes from './inventoryRoutes.js';
import inventoryV2Routes from './inventoryV2Routes.js';
import medicationRoutes from './medicationRoutes.js';
import orderRoutes from './orderRoutes.js';
import wardIndentRoutes from './wardIndentRoutes.js';
import counterSaleRoutes from './counterSaleRoutes.js';
import dispenseSubstitutionWitnessRoutes from './dispenseSubstitutionWitnessRoutes.js';
import {
  pharmacyOrderGuard,
  selectOrderPatient,
  selectPatientFromBodyUid,
} from './pharmacyOrderPatientGuards.js';
import { dispenseSubstitutionValidator } from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

logger.info('✅ Enhanced pharmacyRoutes loaded');

// Patient access guards live per-route (see pharmacyOrderPatientGuards.js) —
// the mount-level guard could never resolve a path-only subject.
// D57 dispense: the subject is the patient of the order named in the body.
const guardDispenseByBodyOrder = pharmacyOrderGuard(
  selectOrderPatient((req) => req.body?.order_id ?? req.body?.orderId ?? req.body?.id),
);
// Dispense-substitution requires body.patient_uid (the handler 400s without
// it), so an unresolvable subject refuses instead of falling through.
const guardSubstitutionPatient = pharmacyOrderGuard(selectPatientFromBodyUid, {
  requirePatientContext: true,
});
const canonicalOrderDispenseBody = (req) => {
  const body = { ...(req.body || {}) };
  delete body.order_id;
  delete body.orderId;
  delete body.id;
  return body;
};
const bodyOrderDispenseIdempotency = requireIdempotencyKey({
  required: true,
  durableDomainReceipt: true,
  scope: 'pharmacy-order-dispense',
  retainOnServerError: true,
  requestPathForIdempotency: (req) => {
    const id = req.body?.order_id ?? req.body?.orderId ?? req.body?.id;
    return `/api/v1/pharmacy-orders/orders/${id}/dispense`;
  },
  requestBodyForIdempotency: canonicalOrderDispenseBody,
});
const substitutionDispenseIdempotency = requireIdempotencyKey({
  required: true,
  durableDomainReceipt: true,
  scope: 'pharmacy-dispense-substitution',
  retainOnServerError: true,
  requestPathForIdempotency: '/api/v1/pharmacy-orders/dispense-substitution',
});
const catalogRemovalIdempotency = requireIdempotencyKey({
  required: true,
  durableDomainReceipt: true,
  scope: 'pharmacy-catalog-remove',
  retainOnServerError: true,
  requestPathForIdempotency: (req) => `/api/v1/pharmacy-orders/catalog/${req.params.id}`,
  requestBodyForIdempotency: () => ({}),
});

function dispenseByBodyOrderId(req, res) {
  const id = req.body?.order_id ?? req.body?.orderId ?? req.body?.id;
  req.params.id = id == null ? undefined : String(id);
  return pharmacyOrderController.markCounterDispensed(req, res);
}

// Public test route
wrapRoutesWithValidation(
  router,
  [],
  {
    get: [
      [
        '/test',
        [],
        (req, res) => {
          res.json({ 
            message: 'Enhanced Pharmacy routes working!',
            timestamp: new Date().toLocaleDateString('en-GB'),
            version: '3.0.0-modular',
            features: ['RBAC Protection', 'Role-based Access', 'Comprehensive API', 'Audit Logging', 'Modular Structure']
          });
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// Mount sub-routers
router.use('/orders', orderRoutes);
router.use('/medications', medicationRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/inventory/v2', inventoryV2Routes);
router.use('/admin', adminRoutes);
// IPD ward → pharmacy stores indent workflow. Finding:
// 2026-05-08-inpatient-admission-pharmacy-no-ipd-ward-indent.
router.use('/ward-indents', wardIndentRoutes);
// Walk-in counter point-of-sale (migration 684): FEFO dispense + schedule
// enforcement + billingV2 PHARMACY invoice + cash-drawer-tied payment.
router.use('/counter-sales', counterSaleRoutes);
// Schedule X / narcotic dispense-substitution witness approvals (two-person
// signoff, mirrors the counter-sale + inventory controlled-dispense flows).
// Mounted before wrapAutoRBAC so the router keeps its own role gates.
router.use('/dispense-substitution/witness-approvals', dispenseSubstitutionWitnessRoutes);

// Re-route some paths for backward compatibility
router.use('/category', medicationRoutes);
router.use('/search', medicationRoutes);

// D57: swarm/client documentation advertises POST /api/v1/pharmacy/dispense
// and /api/v1/pharmacy-orders/dispense. Accept order_id in the body and reuse
// the canonical counter-dispense controller.
wrapAutoRBAC(router, 'pharmacyLifecycleRoutes', {
  post: [
    ['/dispense', [guardDispenseByBodyOrder, bodyOrderDispenseIdempotency], dispenseByBodyOrderId],
    ['/dispense-substitution', [
      ...dispenseSubstitutionValidator,
      guardSubstitutionPatient,
      substitutionDispenseIdempotency,
    ], pharmacyOrderController.dispenseSubstitution]
  ]
});

// Catalog routes must be registered after patient sub-routers because wrapAutoRBAC
// installs router-level RBAC middleware for the routes that follow it.
wrapAutoRBAC(router, 'pharmacyCatalogRoutes', {
  get: [
    ['/catalog', [], pharmacyOrderController.getCatalog],
    ['/catalog/:id/alternatives', [], pharmacyOrderController.getCatalogAlternatives],
    ['/catalog/:id/dispensable-batches', [], pharmacyOrderController.getCatalogDispensableBatches]
  ]
});

wrapAutoRBAC(router, 'pharmacyCatalogAdminRoutes', {
  post: [
    ['/catalog', [], pharmacyOrderController.upsertCatalog]
  ],
  delete: [
    ['/catalog/:id', [catalogRemovalIdempotency], pharmacyOrderController.removeCatalog]
  ]
});

export default router;
