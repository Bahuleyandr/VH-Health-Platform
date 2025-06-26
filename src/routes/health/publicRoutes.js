// src/routes/health/publicRoutes.js
import express from 'express';
import * as systemHealthController from '../../controllers/health/systemHealthController.js';

const router = express.Router();

// Basic service status
router.get('/', systemHealthController.getBasicHealth);

// Comprehensive health check
router.get('/health-check', systemHealthController.getComprehensiveHealth);

// App version info
router.get('/app-version', systemHealthController.getAppVersion);

// System status monitoring
router.get('/system/status', systemHealthController.getSystemStatus);

export default router;