import express from 'express';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import logger from '../../logging/logger.js';
import adminRoutes from './adminRoutes.js';
import inventoryRoutes from './inventoryRoutes.js';
import inventoryV2Routes from './inventoryV2Routes.js';
import medicationRoutes from './medicationRoutes.js';
import orderRoutes from './orderRoutes.js';
import wardIndentRoutes from './wardIndentRoutes.js';
import { dispenseSubstitutionValidator } from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

logger.info('✅ Enhanced pharmacyRoutes loaded');

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

// Re-route some paths for backward compatibility
router.use('/category', medicationRoutes);
router.use('/search', medicationRoutes);

// D57: swarm/client documentation advertises POST /api/v1/pharmacy/dispense
// and /api/v1/pharmacy-orders/dispense. Accept order_id in the body and reuse
// the canonical counter-dispense controller.
wrapAutoRBAC(router, 'pharmacyLifecycleRoutes', {
  post: [
    ['/dispense', [], dispenseByBodyOrderId],
    ['/dispense-substitution', dispenseSubstitutionValidator, pharmacyOrderController.dispenseSubstitution]
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
    ['/catalog/:id', [], pharmacyOrderController.removeCatalog]
  ]
});

export default router;
