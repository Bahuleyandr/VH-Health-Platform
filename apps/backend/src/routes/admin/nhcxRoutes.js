// src/routes/admin/nhcxRoutes.js

import express from 'express';

import { error, success } from '../../utils/responseHelper.js';
import { canReviewNHCXPaymentNotice } from '../../utils/roleHelpers.js';
import {
  dispatchPendingNHCXMessages,
  enqueueClaimStatusCheck,
  enqueueClaimSubmit,
  enqueueCommunicationResponse,
  enqueueCoverageEligibilityCheck,
  enqueuePreauthSubmit,
  getNHCXMessage,
  listNHCXMessages,
  redriveNHCXMessage,
} from '../../services/nhcx/nhcxOutboundDispatcherService.js';
import { getCommunicationWorkbench } from '../../services/nhcx/nhcxCommunicationService.js';
import {
  approvePaymentNoticeReview,
  getPaymentNoticeReview,
  listPaymentNoticeReviews,
  rejectPaymentNoticeReview,
} from '../../services/nhcx/nhcxPaymentNoticeService.js';
import {
  claimStrandedInboundNHCXMessage,
} from '../../services/integrations/externalNhcxRecoveryService.js';

const router = express.Router();

function requirePaymentNoticeFinanceRole(req, res, next) {
  const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
  if (!canReviewNHCXPaymentNotice(role)) {
    return error(res, 'Finance review role required', 403, { safe: true });
  }
  return next();
}

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

router.get('/payment-notices', requirePaymentNoticeFinanceRole, async (req, res, next) => {
  try {
    const result = await listPaymentNoticeReviews({
      tenantId: req.tenantId,
      status: req.query.status || 'manual_review',
      limit: req.query.limit,
    });
    return success(res, result, 'NHCX payment notices retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/payment-notices/:id', requirePaymentNoticeFinanceRole, async (req, res, next) => {
  try {
    const result = await getPaymentNoticeReview({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, result, 'NHCX payment notice retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/payment-notices/:id/approve', requirePaymentNoticeFinanceRole, async (req, res, next) => {
  try {
    const result = await approvePaymentNoticeReview({
      tenantId: req.tenantId,
      id: req.params.id,
      reviewerUid: req.user?.uid ?? null,
      draftOverrides: req.body || {},
    });
    return success(res, result, 'NHCX payment notice approved', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/payment-notices/:id/reject', requirePaymentNoticeFinanceRole, async (req, res, next) => {
  try {
    const result = await rejectPaymentNoticeReview({
      tenantId: req.tenantId,
      id: req.params.id,
      reviewerUid: req.user?.uid ?? null,
      reason: req.body?.reason,
    });
    return success(res, result, 'NHCX payment notice rejected', 201);
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

router.post('/claim/:claimId/submit', async (req, res, next) => {
  try {
    const result = await enqueueClaimSubmit({
      tenantId: req.tenantId,
      claimId: req.params.claimId,
      documentIds: req.body?.document_ids ?? req.body?.documentIds ?? null,
      submittedBy: req.body?.submitted_by ?? req.body?.submittedBy ?? req.user?.uid ?? null,
      hcxApiCallId: req.body?.hcx_api_call_id ?? req.body?.hcxApiCallId,
      hcxCorrelationId: req.body?.hcx_correlation_id ?? req.body?.hcxCorrelationId,
      hcxWorkflowId: req.body?.hcx_workflow_id ?? req.body?.hcxWorkflowId,
    });
    return success(res, result, 'NHCX claim request queued', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/claim/:claimId/status', async (req, res, next) => {
  try {
    const result = await enqueueClaimStatusCheck({
      tenantId: req.tenantId,
      claimId: req.params.claimId,
      hcxApiCallId: req.body?.hcx_api_call_id ?? req.body?.hcxApiCallId,
      hcxCorrelationId: req.body?.hcx_correlation_id ?? req.body?.hcxCorrelationId,
      hcxWorkflowId: req.body?.hcx_workflow_id ?? req.body?.hcxWorkflowId,
    });
    return success(res, result, 'NHCX claim status check queued', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/communication/workbench', async (req, res, next) => {
  try {
    const result = await getCommunicationWorkbench({
      tenantId: req.tenantId,
      claimId: req.query.claim_id ?? req.query.claimId ?? null,
      preauthId: req.query.preauth_id ?? req.query.preauthId ?? null,
    });
    return success(res, result, 'NHCX communication workbench retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/communication/:correspondenceId/respond', async (req, res, next) => {
  try {
    const result = await enqueueCommunicationResponse({
      tenantId: req.tenantId,
      inboundCorrespondenceId: req.params.correspondenceId,
      responseText: req.body?.response_text ?? req.body?.responseText,
      documentIds: req.body?.document_ids ?? req.body?.documentIds ?? [],
      recordedBy: req.user?.uid ?? null,
      hcxApiCallId: req.body?.hcx_api_call_id ?? req.body?.hcxApiCallId,
      hcxCorrelationId: req.body?.hcx_correlation_id ?? req.body?.hcxCorrelationId,
      hcxWorkflowId: req.body?.hcx_workflow_id ?? req.body?.hcxWorkflowId,
    });
    return success(res, result, 'NHCX communication response queued', 201);
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

router.post('/messages/:id/claim-stranded-inbound', async (req, res, next) => {
  try {
    const result = await claimStrandedInboundNHCXMessage({
      tenantId: req.tenantId,
      messageId: req.params.id,
      actorUid: req.user?.uid,
      ownerReason: req.body?.owner_reason ?? req.body?.ownerReason,
      ownerDisposition: req.body?.owner_disposition ?? req.body?.ownerDisposition,
    });
    return success(res, result, 'NHCX inbound callback claimed for owner review', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
