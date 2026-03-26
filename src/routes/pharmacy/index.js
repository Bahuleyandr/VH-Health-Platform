import express from 'express';
import logger from '../../logging/logger.js';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';
import adminRoutes from './adminRoutes.js';
import inventoryRoutes from './inventoryRoutes.js';
import medicationRoutes from './medicationRoutes.js';
import orderRoutes from './orderRoutes.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';

const router = express.Router();

logger.info('✅ Enhanced pharmacyRoutes loaded');

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

// Catalog routes (before sub-routers)
wrapAutoRBAC(router, 'pharmacyCatalogRoutes', {
  get: [
    ['/catalog', [], pharmacyOrderController.getCatalog]
  ],
  post: [
    ['/catalog', [], pharmacyOrderController.upsertCatalog]
  ]
});

// Mount sub-routers
router.use('/orders', orderRoutes);
router.use('/medications', medicationRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/admin', adminRoutes);

// Re-route some paths for backward compatibility
router.use('/category', medicationRoutes);
router.use('/search', medicationRoutes);

export default router;