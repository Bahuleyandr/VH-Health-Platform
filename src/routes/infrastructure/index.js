// routes/infrastructure/index.js
import express from 'express';
import debugRoutes from './debugRoutes.js';
import swaggerRoutes from './swaggerRoutes.js';
import versionRoutes from './versionRoutes.js';
import rbacRoutes from './rbacRoutes.js';
import logger from '../../logging/logger.js';

const router = express.Router();

// Mount infrastructure sub-routes
router.use('/debug', debugRoutes);
router.use('/api-docs', swaggerRoutes);
router.use('/version', versionRoutes);
router.use('/rbac', rbacRoutes);

// Log infrastructure routes initialization
logger.info('✅ Infrastructure routes initialized: /debug, /api-docs, /version, /rbac');

export default router;