import express from 'express';
import investigationRoutes from './investigationRoutes.js';
import adminRoutes from './adminRoutes.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

console.log('✅ Enhanced investigationRoutes loaded with full RBAC protection');

// Public test route
wrapRoutesWithValidation(
  router,
  [],
  {
    get: [
      [
        '/test',
        (req, res) => {
          success(res, {
            message: 'Investigation routes working!',
            timestamp: new Date().toISOString(),
            version: '3.0.0-modular',
            security: 'RBAC-protected'
          }, 'Investigation system operational');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// Mount sub-routers
router.use('/', investigationRoutes);
router.use('/stats', adminRoutes);

export default router;