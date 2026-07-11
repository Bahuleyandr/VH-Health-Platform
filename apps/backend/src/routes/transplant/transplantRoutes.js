import express from 'express';
import logger from '../../logging/logger.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import {
  createProgram,
  createCandidate,
  recordWaitlistStatus,
  createDonorReferral,
  createMatchReview,
  createCommitteeReview,
  createImmunosuppressionPlan,
  createNottoExport,
  releaseNottoExport,
  getDashboard,
} from '../../services/transplant/transplantProgramService.js';
import { isTransplantProgramEnabled } from '../../services/transplant/transplantProgramFeatureService.js';

const router = express.Router();

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Transplant ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => req?.user?.tenantId || req?.tenant?.id || null;

router.get('/settings', async (req, res) => {
  try {
    const enabled = await isTransplantProgramEnabled(tenantOf(req));
    return success(res, { settings: { enabled } }, 'Transplant program settings');
  } catch (err) {
    return handleFailure(res, err, 'read settings');
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await getDashboard({ tenantId: tenantOf(req), limit: req.query.limit });
    return success(res, { dashboard }, 'Transplant dashboard');
  } catch (err) {
    return handleFailure(res, err, 'read dashboard');
  }
});

router.post('/programs', async (req, res) => {
  try {
    const program = await createProgram({
      tenantId: tenantOf(req),
      organ: req.body.organ,
      serviceLine: req.body.service_line,
      site: req.body.site,
      programOwnerUid: req.body.program_owner_uid || null,
      programOwnerRole: req.body.program_owner_role || null,
      status: req.body.status || 'draft',
      nottoEvidenceOwnerUid: req.body.notto_evidence_owner_uid || null,
      nottoEvidenceOwnerRole: req.body.notto_evidence_owner_role || null,
      nottoEvidenceReference: req.body.notto_evidence_reference || null,
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { program }, 'Transplant program created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create program');
  }
});

router.post('/programs/:programId/candidates', async (req, res) => {
  try {
    const candidate = await createCandidate(req.params.programId, {
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      diagnosis: req.body.diagnosis,
      requiredOrgans: req.body.required_organs,
      listingEvaluationStatus: req.body.listing_evaluation_status || 'evaluation',
      committeeStatus: req.body.committee_status || 'pending',
      contraindicationsSummary: req.body.contraindications_summary || null,
      relatedCarePlanId: req.body.related_care_plan_id || null,
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { candidate }, 'Transplant candidate created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create candidate');
  }
});

router.post('/candidates/:candidateId/waitlist-status', async (req, res) => {
  try {
    const status = await recordWaitlistStatus(req.params.candidateId, {
      tenantId: tenantOf(req),
      status: req.body.status,
      reason: req.body.reason || null,
      committeeReviewId: req.body.committee_review_id || null,
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { status }, 'Transplant waitlist status recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record waitlist status');
  }
});

router.post('/candidates/:candidateId/committee-reviews', async (req, res) => {
  try {
    const review = await createCommitteeReview({
      tenantId: tenantOf(req),
      programId: req.body.program_id,
      candidateId: req.params.candidateId,
      reviewDate: req.body.review_date || null,
      attendees: req.body.attendees || [],
      quorumPolicyReference: req.body.quorum_policy_reference,
      decision: req.body.decision || 'pending',
      recommendations: req.body.recommendations || null,
      deferralReason: req.body.deferral_reason || null,
      affectsCandidate: req.body.affects_candidate !== false,
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { review }, 'Transplant committee review recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record committee review');
  }
});

router.post('/donor-referrals', async (req, res) => {
  try {
    const referral = await createDonorReferral({
      tenantId: tenantOf(req),
      programId: req.body.program_id,
      donorType: req.body.donor_type,
      source: req.body.source,
      relationCategory: req.body.relation_category || null,
      screeningSummary: req.body.screening_summary || null,
      documents: req.body.documents || [],
      status: req.body.status || 'received',
      auditRegister: req.body.audit_register || {},
    }, ctx(req));
    return success(res, { referral }, 'Transplant donor referral recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record donor referral');
  }
});

router.post('/match-reviews', async (req, res) => {
  try {
    const review = await createMatchReview({
      tenantId: tenantOf(req),
      candidateId: req.body.candidate_id,
      donorReferralId: req.body.donor_referral_id,
      compatibilitySummary: req.body.compatibility_summary,
      crossmatchDocuments: req.body.crossmatch_documents || [],
      chainOfCustody: req.body.chain_of_custody || {},
      riskFlags: req.body.risk_flags || [],
      decision: req.body.decision || 'pending',
      decisionReason: req.body.decision_reason || null,
    }, ctx(req));
    return success(res, { review }, 'Transplant match review recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record match review');
  }
});

router.post('/candidates/:candidateId/immunosuppression-plans', async (req, res) => {
  try {
    const plan = await createImmunosuppressionPlan(req.params.candidateId, {
      tenantId: tenantOf(req),
      regimenSummary: req.body.regimen_summary,
      monitoringPlan: req.body.monitoring_plan,
      prescribingOwnerUid: req.body.prescribing_owner_uid,
      downstreamMedicationLinks: req.body.downstream_medication_links || [],
      status: req.body.status || 'draft',
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { plan }, 'Transplant immunosuppression plan recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record immunosuppression plan');
  }
});

router.post('/notto-exports', async (req, res) => {
  try {
    const exportRow = await createNottoExport({
      tenantId: tenantOf(req),
      programId: req.body.program_id,
      candidateId: req.body.candidate_id || null,
      packageMetadata: req.body.package_metadata || {},
      ownerReviewedStatus: req.body.owner_reviewed_status || 'draft',
      ownerReviewedBy: req.body.owner_reviewed_by || null,
      ownerReviewedAt: req.body.owner_reviewed_at || null,
      uploadReferenceId: req.body.upload_reference_id || null,
      auditEvidence: req.body.audit_evidence || {},
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { export: exportRow }, 'Transplant NOTTO export created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create NOTTO export');
  }
});

router.post('/notto-exports/:exportId/release', async (req, res) => {
  try {
    const exportRow = await releaseNottoExport(req.params.exportId, {
      tenantId: tenantOf(req),
      uploadReferenceId: req.body.upload_reference_id,
      auditEvidence: req.body.audit_evidence,
    }, ctx(req));
    return success(res, { export: exportRow }, 'Transplant NOTTO export released');
  } catch (err) {
    return handleFailure(res, err, 'release NOTTO export');
  }
});

export default router;
