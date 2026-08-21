// routes/infrastructure/index.js
import express from 'express';
import logger from '../../logging/logger.js';
import { requireProductionInfrastructureAdmin } from '../../middleware/infrastructureAccessMiddleware.js';
import debugRoutes from './debugRoutes.js';
import rbacRoutes from './rbacRoutes.js';
import swaggerRoutes from './swaggerRoutes.js';
import versionRoutes from './versionRoutes.js';

const router = express.Router();

// Mount infrastructure sub-routes. The production admin-tier gate is applied
// PER SUB-PATH, never via router.use(gate) or on the app's '/api/v1' prefix
// mount — either of those runs the gate for every /api/v1/* request (Express
// runs mount middleware before knowing whether the router matches) and in
// production that denied the whole API to every non-admin role while dev/test,
// where the gate no-ops, stayed green (dalekdefender 2026-08-21). Any new
// sub-mount added here must carry the gate the same way.
router.use('/debug', requireProductionInfrastructureAdmin, debugRoutes);
router.use('/api-docs', requireProductionInfrastructureAdmin, swaggerRoutes);
router.use('/version', requireProductionInfrastructureAdmin, versionRoutes);
router.use('/rbac', requireProductionInfrastructureAdmin, rbacRoutes);

// Log infrastructure routes initialization
logger.info('✅ Infrastructure routes initialized: /debug, /api-docs, /version, /rbac');

export default router;
