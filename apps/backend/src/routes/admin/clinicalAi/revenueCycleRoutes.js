import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  decideAppealLetter,
  generateAppealLetter,
  listAppealLetters,
  recordAppealPayerResponse,
  submitAppealLetter,
} from '../../../services/ai/appealLetterGeneratorService.js';
import {
  computeAiRoiMetrics,
  getLatestAiRoiSnapshot,
  listAiRoiSnapshots,
  saveAiRoiSnapshot,
} from '../../../services/ai/aiRoiDashboardService.js';
import {
  decidePayerVarianceReview,
  evaluateClaimVariance,
  listPayerContracts,
  listPayerVarianceReviews,
  upsertPayerContract,
} from '../../../services/ai/payerContractVarianceService.js';
import {
  generatePriorAuthorization,
  listPriorAuthorizations,
  recordPayerDecision,
  submitPriorAuthorization,
} from '../../../services/ai/priorAuthorizationService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Batch 5: prior authorization
// ---------------------------------------------------------------------------
router.post('/prior-auth', async (req, res, next) => {
  try {
    const result = await generatePriorAuthorization({
      req,
      admissionId: req.body?.admission_id,
      payerName: req.body?.payer_name,
      policyNumber: req.body?.policy_number || null,
      procedureCode: req.body?.procedure_code,
      procedureDescription: req.body?.procedure_description || null,
      requestedServiceType: req.body?.requested_service_type || 'inpatient_procedure',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PRIOR_AUTH_GENERATED', String(result.prior_auth_id || 'inline'), null, {
      payer: req.body?.payer_name,
      procedure: req.body?.procedure_code,
    });
    return success(res, result, 'Prior authorization packet generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/prior-auth', async (req, res, next) => {
  try {
    const result = await listPriorAuthorizations({
      tenantId: req.tenantId,
      status: req.query.status || null,
      reviewerDecision: req.query.reviewer_decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Prior auth requests retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/prior-auth/:id/submit', async (req, res, next) => {
  try {
    const submitted = await submitPriorAuthorization({
      tenantId: req.tenantId,
      tenantRegion: req.tenant?.region || null,
      priorAuthId: req.params.id,
      submittedBy: req.user?.uid || null,
      payerReferenceId: req.body?.payer_reference_id || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PRIOR_AUTH_SUBMITTED', String(submitted.id), null, submitted);
    return success(res, submitted, 'Prior auth submitted to payer');
  } catch (err) {
    return next(err);
  }
});

router.patch('/prior-auth/:id/payer-decision', async (req, res, next) => {
  try {
    const decided = await recordPayerDecision({
      tenantId: req.tenantId,
      priorAuthId: req.params.id,
      decision: req.body?.decision,
      reason: req.body?.reason || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PRIOR_AUTH_PAYER_DECISION', String(decided.id), null, decided);
    return success(res, decided, 'Payer decision recorded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Appeal letter generator for denied claims
// ---------------------------------------------------------------------------
router.post('/appeal-letters', async (req, res, next) => {
  try {
    const result = await generateAppealLetter({
      req,
      claimId: req.body?.claim_id,
      denialReason: req.body?.denial_reason || null,
      denialCode: req.body?.denial_code || null,
      appealType: req.body?.appeal_type || 'first_level',
      admissionId: req.body?.admission_id || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_APPEAL_LETTER_GENERATED',
      String(result.appeal_id || result.generation_id || req.body?.claim_id || 'inline'),
      null,
      {
        appeal_id: result.appeal_id,
        generation_id: result.generation_id,
        claim_id: req.body?.claim_id,
        classification: result.classification?.classification,
        appeal_type: result.draft?.appeal_type,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Appeal letter draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/appeal-letters', async (req, res, next) => {
  try {
    const result = await listAppealLetters({
      tenantId: req.tenantId,
      claimId: req.query?.claim_id || null,
      patientUid: req.query?.patient_uid || null,
      appealStatus: req.query?.appeal_status || null,
      decision: req.query?.decision || null,
      classification: req.query?.classification || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Appeal letters retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/appeal-letters/:id', async (req, res, next) => {
  try {
    const result = await decideAppealLetter({
      tenantId: req.tenantId,
      appealId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_APPEAL_LETTER_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Appeal letter review recorded');
  } catch (err) {
    return next(err);
  }
});

router.post('/appeal-letters/:id/submit', async (req, res, next) => {
  try {
    const result = await submitAppealLetter({
      tenantId: req.tenantId,
      appealId: req.params.id,
      submittedBy: req.user?.uid || null,
      payerReferenceId: req.body?.payer_reference_id || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_APPEAL_LETTER_SUBMITTED', String(result.id), null, result);
    return success(res, result, 'Appeal letter submitted');
  } catch (err) {
    return next(err);
  }
});

router.post('/appeal-letters/:id/payer-response', async (req, res, next) => {
  try {
    const result = await recordAppealPayerResponse({
      tenantId: req.tenantId,
      appealId: req.params.id,
      status: req.body?.status,
      response: req.body?.response || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_APPEAL_LETTER_PAYER_RESPONSE', String(result.id), null, result);
    return success(res, result, 'Appeal letter payer response recorded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// AI ROI dashboard
// ---------------------------------------------------------------------------
router.get('/roi', async (req, res, next) => {
  try {
    const metrics = await computeAiRoiMetrics({
      tenantId: req.tenantId,
      periodDays: req.query?.period_days,
    });
    return success(res, metrics, 'AI ROI metrics computed');
  } catch (err) {
    return next(err);
  }
});

router.post('/roi/snapshots', async (req, res, next) => {
  try {
    const metrics = await computeAiRoiMetrics({
      tenantId: req.tenantId,
      periodDays: req.body?.period_days,
    });
    const snapshot = await saveAiRoiSnapshot({
      tenantId: req.tenantId,
      metrics,
      moduleKey: req.body?.module_key || 'ALL',
      computedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ROI_SNAPSHOT_RECORDED',
      String(snapshot?.id || 'inline'),
      null,
      {
        snapshot_id: snapshot?.id,
        period_days: metrics.period_days,
        generation_count: metrics.generation_count,
        accepted_count: metrics.accepted_count,
        time_saved_minutes: metrics.time_saved_minutes,
      }
    );
    return success(res, { snapshot, metrics }, 'AI ROI snapshot saved', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/roi/snapshots', async (req, res, next) => {
  try {
    const result = await listAiRoiSnapshots({
      tenantId: req.tenantId,
      moduleKey: req.query?.module_key || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'AI ROI snapshots retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/roi/snapshots/latest', async (req, res, next) => {
  try {
    const snapshot = await getLatestAiRoiSnapshot({
      tenantId: req.tenantId,
      moduleKey: req.query?.module_key || 'ALL',
    });
    return success(res, { snapshot }, 'Latest AI ROI snapshot retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Payer contract variance / underpayment AI
// ---------------------------------------------------------------------------
router.post('/payer-contracts', async (req, res, next) => {
  try {
    const result = await upsertPayerContract({
      tenantId: req.tenantId,
      payerName: req.body?.payer_name,
      payerCode: req.body?.payer_code || null,
      procedureCode: req.body?.procedure_code,
      procedureDescription: req.body?.procedure_description || null,
      expectedRateMinor: req.body?.expected_rate_minor,
      currencyCode: req.body?.currency_code || 'INR',
      tolerancePct: req.body?.tolerance_pct,
      effectiveStartDate: req.body?.effective_start_date || null,
      effectiveEndDate: req.body?.effective_end_date || null,
      contractReference: req.body?.contract_reference || null,
      notes: req.body?.notes || null,
      active: req.body?.active !== undefined ? Boolean(req.body.active) : true,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PAYER_CONTRACT_UPSERTED',
      String(result?.id || req.body?.procedure_code || 'inline'),
      null,
      result
    );
    return success(res, result, 'Payer contract upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/payer-contracts', async (req, res, next) => {
  try {
    const result = await listPayerContracts({
      tenantId: req.tenantId,
      payerName: req.query?.payer_name || null,
      procedureCode: req.query?.procedure_code || null,
      active: req.query?.active === undefined ? null : req.query.active !== 'false',
      limit: req.query?.limit,
    });
    return success(res, result, 'Payer contracts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/payer-variance/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateClaimVariance({
      req,
      claimId: req.body?.claim_id,
      procedureCode: req.body?.procedure_code || null,
      tolerancePctOverride: req.body?.tolerance_pct,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PAYER_VARIANCE_EVALUATED',
      String(result.review_id || result.generation_id || req.body?.claim_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        claim_id: req.body?.claim_id,
        variance_category: result.draft?.variance_category,
        variance_band: result.draft?.variance_band,
      }
    );
    return success(res, result, 'Payer variance evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/payer-variance/reviews', async (req, res, next) => {
  try {
    const result = await listPayerVarianceReviews({
      tenantId: req.tenantId,
      claimId: req.query?.claim_id || null,
      decision: req.query?.decision || null,
      category: req.query?.category || null,
      band: req.query?.band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Payer variance reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/payer-variance/reviews/:id', async (req, res, next) => {
  try {
    const result = await decidePayerVarianceReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PAYER_VARIANCE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Payer variance review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Coding-suggestion batch (admin trigger for the nightly sweep). Generates
// review-gated coding suggestions only — nothing is ever auto-applied to
// claims or the record; every suggestion lands as a pending
// clinical_ai_reviews item for the coding team. The clinical_coding_assist
// module gate applies inside the service (disabled module → no-op summary).
// ---------------------------------------------------------------------------
router.post('/coding-batch/run-sweep', async (req, res, next) => {
  try {
    const { runCodingSuggestionBatch } = await import('../../../services/ai/codingBatchSuggestionService.js');
    const result = await runCodingSuggestionBatch({
      tenantId: req.tenantId,
      limit: req.body?.limit,
      lookbackDays: req.body?.lookback_days,
      triggeredBy: req.user?.uid || null,
      source: 'admin',
    });
    // Literal module key (not the service's exported constant) so the batch
    // service stays a lazy import on this route module.
    await logClinicalAiAudit(req, 'CLINICAL_AI_CODING_BATCH_RUN', 'clinical_coding_assist', null, {
      candidates: result.candidates,
      suggested: result.suggested,
      review_items: result.review_items,
      skipped: result.skipped.length,
      stopped_reason: result.stopped_reason,
    });
    return success(res, result, 'Coding suggestion batch completed');
  } catch (err) {
    return next(err);
  }
});

export default router;
