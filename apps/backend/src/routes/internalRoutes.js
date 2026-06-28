import express from 'express';
import jwtAuth from '../middleware/jwtMiddleware.js';
import { requireRole } from '../middleware/rbacMiddleware.js';
import {
  performSystemHealthCheck,
  generateSystemDocumentation,
  getSystemStatistics
} from './index.js'; // from your initialized route system

const router = express.Router();

// CAN-044: this router is mounted with validateApiKey only (pre-JWT). The route
// catalogue (/docs) and system statistics (/stats) must NOT be exposed to any
// API-key holder — require a verified ADMIN JWT on top. /health stays
// API-key-only as a minimal liveness probe.
const requireAdminJwt = [jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN')];

// Health check endpoint (API-key only — minimal liveness data)
router.get('/health', (req, res) => {
  const health = performSystemHealthCheck();
  res.status(200).json(health);
});

// Documentation (JSON format) — admin only
router.get('/docs', ...requireAdminJwt, (req, res) => {
  try {
    const docs = generateSystemDocumentation('json');
    res.status(200).json(docs);
  } catch (_err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Stats — admin only
router.get('/stats', ...requireAdminJwt, (req, res) => {
  const stats = getSystemStatistics();
  res.status(200).json(stats);
});

export default router;
