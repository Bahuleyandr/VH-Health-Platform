// src/routes/system/index.js
import express from 'express';
import { validationResult, body } from 'express-validator';
import * as healthController from '../../controllers/system/healthController.js';
import * as systemController from '../../controllers/system/systemController.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

/**
 * GET  /api/v1/system/settings  — fetch current app settings
 * PUT  /api/v1/system/settings  — update app settings (admin only, auth enforced in app.js)
 * GET  /api/v1/system/status    — system health / status (reuses existing service)
 * GET  /api/v1/system/health    — deep system health check (all services)
 */

router.get('/settings', systemController.getSettings);
router.put('/settings', body('settings').exists().withMessage('settings is required').isObject().withMessage('settings must be an object'), validate, systemController.updateSettings);
router.get('/status', systemController.getSystemStatus);
router.get('/health', healthController.getSystemHealth);

export default router;
