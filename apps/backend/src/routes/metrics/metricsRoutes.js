// src/routes/metrics/metricsRoutes.js
// GET /metrics — returns Prometheus exposition format
// Authentication is applied at the app mount before this internal scraper route.

import { Router } from 'express';
import { serializeMetrics } from '../../middleware/prometheusMiddleware.js';
import { serializeReliabilityMetrics } from '../../observability/reliabilityMetrics.js';
import { serializeTeleconsultOpsMetrics } from '../../observability/teleconsultOpsMetrics.js';
import { serializeContinuityMetrics } from '../../observability/continuityMetrics.js';

const router = Router();

router.get('/', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(
    serializeMetrics()
      + '\n'
      + serializeReliabilityMetrics()
      + '\n'
      + serializeTeleconsultOpsMetrics()
      + '\n'
      + serializeContinuityMetrics(),
  );
});

export default router;
