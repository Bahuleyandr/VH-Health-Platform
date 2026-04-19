// src/routes/system/index.js
import express from 'express';
import * as healthController from '../../controllers/system/healthController.js';
import * as systemController from '../../controllers/system/systemController.js';

const router = express.Router();

/**
 * GET  /api/v1/system/settings  — fetch current app settings
 * PUT  /api/v1/system/settings  — update app settings (admin only, auth enforced in app.js)
 * GET  /api/v1/system/status    — system health / status (reuses existing service)
 * GET  /api/v1/system/health    — deep system health check (all services)
 */

router.get('/settings', systemController.getSettings);
router.put('/settings', systemController.updateSettings);
router.get('/status', systemController.getSystemStatus);
router.get('/health', healthController.getSystemHealth);

export default router;
