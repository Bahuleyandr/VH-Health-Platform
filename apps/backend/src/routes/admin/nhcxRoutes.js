// src/routes/admin/nhcxRoutes.js

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  dispatchPendingNHCXMessages,
  enqueueCoverageEligibilityCheck,
  enqueuePreauthSubmit,
  getNHCXMessage,
  listNHCXMessages,
  redriveNHCXMessage,
} from '../../services/nhcx/nhcxOutboundDispatcherService.js';

const router = express.Router();

router.get('/messages', async (req, res, next) => {
  try {
    const result = await listNHCXMessages({
      tenantId: req.tenantId,
      status: req.query.status || null,
      cycle: req.query.cycle || null,
      direction: req.query.direction || null,
      limit: req.query.limit,
    });
    return success(res, result, 'NHCX messages retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/messages/:id', async (req, res, next) => {
  try {
    const row = await getNHCXMessage({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'NHCX message retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/eligibility/check', async (req, res, next) => {
  try {
    const result = await enqueueCoverageEligibilityCheck({
      tenantId: req.tenantId,
      policyId: req.body?.policy_id ?? req.body?.policyId,
      admissionId: req.body?.admission_id ?? req.body?.admissionId ?? null,
      hcxApiCallId: req.body?.hcx_api_call_id ?? req.body?.hcxApiCallId,
      hcxCorrelationId: req.body?.hcx_correlation_id ?? req.body?.hcxCorrelationId,
      hcxWorkflowId: req.body?.hcx_workflow_id ?? req.body?.hcxWorkflowId,
    });
    return success(res, result, 'NHCX eligibility request queued', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/preauth/:preauthId/submit', async (req, res, next) => {
  try {
    const result = await enqueuePreauthSubmit({
      tenantId: req.tenantId,
      preauthId: req.params.preauthId,
      hcxApiCallId: req.body?.hcx_api_call_id ?? req.body?.hcxApiCallId,
      hcxCorrelationId: req.body?.hcx_correlation_id ?? req.body?.hcxCorrelationId,
      hcxWorkflowId: req.body?.hcx_workflow_id ?? req.body?.hcxWorkflowId,
    });
    return success(res, result, 'NHCX preauth request queued', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/dispatch-now', async (req, res, next) => {
  try {
    const result = await dispatchPendingNHCXMessages({
      tenantId: req.tenantId,
      batchSize: req.body?.batch_size ?? req.body?.batchSize,
    });
    return success(res, result, 'NHCX dispatch tick complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/messages/:id/redrive', async (req, res, next) => {
  try {
    const row = await redriveNHCXMessage({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'NHCX message redriven', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
