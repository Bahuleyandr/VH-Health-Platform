// src/routes/metrics/metricsRoutes.js
// GET /metrics — returns Prometheus exposition format
// Authentication is applied at the app mount before this internal scraper route.

import { Router } from 'express';
import { serializeMetrics } from '../../middleware/prometheusMiddleware.js';
import { serializeReliabilityMetrics } from '../../observability/reliabilityMetrics.js';
import { serializeTeleconsultOpsMetrics } from '../../observability/teleconsultOpsMetrics.js';
import { serializeContinuityMetrics } from '../../observability/continuityMetrics.js';
import {
  serializeWardDowntimePackMetrics,
} from '../../observability/wardDowntimePackMetrics.js';
import { serializeStaffPushFanoutMetrics } from '../../observability/staffPushFanoutMetrics.js';
import { serializeEscalationMetrics } from '../../observability/escalationMetrics.js';
import { serializeInterfaceEngineMetrics } from '../../observability/interfaceEngineMetrics.js';
import { serializeRateLimitPostureMetrics } from '../../observability/rateLimitPostureMetrics.js';
import { serializeSecurityEventMetrics } from '../../observability/securityEventMetrics.js';
import {
  serializeLabCriticalThresholdMetrics,
} from '../../observability/labCriticalThresholdMetrics.js';

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
      + serializeContinuityMetrics()
      + '\n'
      + serializeWardDowntimePackMetrics()
      + '\n'
      + serializeStaffPushFanoutMetrics()
      + '\n'
      + serializeEscalationMetrics()
      + '\n'
      + serializeInterfaceEngineMetrics()
      + '\n'
      + serializeRateLimitPostureMetrics()
      + '\n'
      + serializeSecurityEventMetrics()
      + '\n'
      + serializeLabCriticalThresholdMetrics(),
  );
});

export default router;
