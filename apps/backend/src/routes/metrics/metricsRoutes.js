// src/routes/metrics/metricsRoutes.js
// GET /metrics — returns Prometheus exposition format
// No authentication — accessed by Prometheus scraper on internal network

import { Router } from 'express';
import { serializeMetrics } from '../../middleware/prometheusMiddleware.js';

const router = Router();

router.get('/', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(serializeMetrics());
});

export default router;
