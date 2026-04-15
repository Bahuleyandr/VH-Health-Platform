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

// Min / recommended app versions for each client. Consumed by the Flutter
// apps at boot to render an upgrade blocker when below min.
router.get('/client-requirements', systemHealthController.getClientRequirements);

// System status monitoring
router.get('/system/status', systemHealthController.getSystemStatus);

export default router;