// src/routes/metrics/metricsRoutes.js
// GET /metrics — returns Prometheus exposition format
// No authentication — accessed by Prometheus scraper on internal network

import { Router } from 'express';
import { serializeMetrics } from '../../middleware/prometheusMiddleware.js';
import { serializeReliabilityMetrics } from '../../observability/reliabilityMetrics.js';
import { serializeTeleconsultOpsMetrics } from '../../observability/teleconsultOpsMetrics.js';

const router = Router();

router.get('/', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(
    serializeMetrics()
      + '\n'
      + serializeReliabilityMetrics()
      + '\n'
      + serializeTeleconsultOpsMetrics(),
  );
});

export default router;
