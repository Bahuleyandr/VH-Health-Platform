import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import { listAbnormalResultTriageDrafts } from '../../../services/ai/abnormalResultTriageAdminService.js';
import {
  decideChartCompletionAudit,
  generateChartCompletionAudit,
  listChartCompletionAudits,
} from '../../../services/ai/chartCompletionAuditorService.js';
import {
  decideClinicalTaskCandidate,
  generateClinicalTaskExtraction,
  listClinicalTaskCandidates,
} from '../../../services/ai/clinicalTaskExtractorService.js';
import { generateAdmissionAiDraft } from '../../../services/ai/clinicalAiWorkflowService.js';
import {
  decideInfectionControlAudit,
  generateInfectionControlAudit,
  listInfectionControlAudits,
} from '../../../services/ai/infectionControlSentinelService.js';
import {
  decideAntimicrobialStewardshipReview,
  generateAntimicrobialStewardshipReview,
  listAntimicrobialStewardshipReviews,
} from '../../../services/ai/antimicrobialStewardshipService.js';
import {
  decideTeachBackSession,
  generateTeachBackSession,
  listTeachBackSessions,
  submitTeachBackAnswers,
} from '../../../services/ai/patientTeachBackService.js';
import {
  decideSepsisBundleAudit,
  generateSepsisBundleAudit,
  listSepsisBundleAudits,
} from '../../../services/ai/sepsisBundleSentinelService.js';
import {
  decideConsentPhiPolicyAudit,
  listConsentPhiPolicyAudits,
  runConsentPhiPolicyScan,
} from '../../../services/ai/consentPhiPolicySentinelService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Chart completion auditor
// ---------------------------------------------------------------------------
router.post('/chart-completion/audits', async (req, res, next) => {
  try {
    const result = await generateChartCompletionAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_CHART_COMPLETION_AUDIT_GENERATED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        completion_score: result.draft?.completion_score,
        risk_band: result.draft?.risk_band,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Chart completion audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/chart-completion/audits', async (req, res, next) => {
  try {
    const result = await listChartCompletionAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Chart completion audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/chart-completion/audits/:id', async (req, res, next) => {
  try {
    const result = await decideChartCompletionAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_CHART_COMPLETION_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Chart completion audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Clinical task extractor
// ---------------------------------------------------------------------------
router.post('/tasks/extract', async (req, res, next) => {
  try {
    const result = await generateClinicalTaskExtraction({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TASKS_EXTRACTED',
      String(result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        generation_id: result.generation_id,
        review_id: result.review_id,
        admission_id: req.body?.admission_id,
        task_count: result.task_count,
        safety_flag_count: result.safety_flags?.length || 0,
        no_auto_assign: true,
      }
    );
    return success(res, result, 'Clinical task extraction generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/tasks', async (req, res, next) => {
  try {
    const result = await listClinicalTaskCandidates({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      priority: req.query?.priority || null,
      ownerRole: req.query?.owner_role || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Clinical task candidates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/tasks/:id', async (req, res, next) => {
  try {
    const result = await decideClinicalTaskCandidate({
      tenantId: req.tenantId,
      taskId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TASK_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Clinical task candidate reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Abnormal result triage worklist
// ---------------------------------------------------------------------------
router.post('/abnormal-results/triage', async (req, res, next) => {
  try {
    const result = await generateAdmissionAiDraft(
      req.body?.admission_id,
      'abnormal_result_triage',
      req.user?.uid || null,
      req
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ABNORMAL_RESULT_TRIAGE_GENERATED',
      String(result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        admission_id: req.body?.admission_id || null,
        generation_id: result.generation_id || null,
        urgent_count: result.draft?.urgent_items?.length || 0,
        watch_count: result.draft?.watch_items?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Abnormal result triage draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/abnormal-results/triage', async (req, res, next) => {
  try {
    const result = await listAbnormalResultTriageDrafts({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      urgencyBand: req.query?.urgency_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Abnormal result triage drafts retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Infection control sentinel
// ---------------------------------------------------------------------------
router.post('/infection-control/audits', async (req, res, next) => {
  try {
    const result = await generateInfectionControlAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_INFECTION_CONTROL_AUDIT_GENERATED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        risk_score: result.draft?.risk_score,
        risk_band: result.draft?.risk_band,
        signal_count: result.draft?.signals?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Infection-control audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/infection-control/audits', async (req, res, next) => {
  try {
    const result = await listInfectionControlAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Infection-control audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/infection-control/audits/:id', async (req, res, next) => {
  try {
    const result = await decideInfectionControlAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_INFECTION_CONTROL_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Infection-control audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Antimicrobial stewardship assistant
// ---------------------------------------------------------------------------
router.post('/antimicrobial-stewardship/reviews', async (req, res, next) => {
  try {
    const result = await generateAntimicrobialStewardshipReview({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ANTIMICROBIAL_STEWARDSHIP_REVIEW_GENERATED',
      String(result.review_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        stewardship_score: result.draft?.stewardship_score,
        risk_band: result.draft?.risk_band,
        flag_count: result.draft?.flags?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Antimicrobial stewardship review generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/antimicrobial-stewardship/reviews', async (req, res, next) => {
  try {
    const result = await listAntimicrobialStewardshipReviews({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Antimicrobial stewardship reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/antimicrobial-stewardship/reviews/:id', async (req, res, next) => {
  try {
    const result = await decideAntimicrobialStewardshipReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ANTIMICROBIAL_STEWARDSHIP_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Antimicrobial stewardship review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Patient teach-back / comprehension AI
// ---------------------------------------------------------------------------
router.post('/teach-back/sessions', async (req, res, next) => {
  try {
    const result = await generateTeachBackSession({
      req,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      sourceGenerationId: req.body?.source_generation_id || null,
      language: req.body?.language || 'en',
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TEACH_BACK_SESSION_GENERATED',
      String(result.session_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        session_id: result.session_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        language: result.language,
        comprehension_score: result.draft?.comprehension_score,
        question_count: result.draft?.questions?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Patient teach-back session generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/teach-back/sessions/:id/answers', async (req, res, next) => {
  try {
    const result = await submitTeachBackAnswers({
      req,
      sessionId: req.params.id,
      answers: req.body?.answers || [],
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TEACH_BACK_ANSWERS_SUBMITTED',
      String(result.id),
      null,
      {
        session_id: result.id,
        status: result.status,
        comprehension_score: result.comprehension_score,
        misunderstanding_count: Array.isArray(result.misunderstanding_flags) ? result.misunderstanding_flags.length : 0,
      }
    );
    return success(res, result, 'Patient teach-back answers recorded');
  } catch (err) {
    return next(err);
  }
});

router.get('/teach-back/sessions', async (req, res, next) => {
  try {
    const result = await listTeachBackSessions({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      status: req.query?.status || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Patient teach-back sessions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/teach-back/sessions/:id', async (req, res, next) => {
  try {
    const result = await decideTeachBackSession({
      tenantId: req.tenantId,
      sessionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TEACH_BACK_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Patient teach-back session updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Sepsis bundle sentinel
// ---------------------------------------------------------------------------
router.post('/sepsis-bundle/audits', async (req, res, next) => {
  try {
    const result = await generateSepsisBundleAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SEPSIS_BUNDLE_AUDIT_GENERATED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        risk_score: result.draft?.risk_score,
        risk_band: result.draft?.risk_band,
        criterion_count: result.draft?.criteria?.length || 0,
        bundle_gap_count: result.draft?.bundle_gaps?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Sepsis bundle audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/sepsis-bundle/audits', async (req, res, next) => {
  try {
    const result = await listSepsisBundleAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Sepsis bundle audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/sepsis-bundle/audits/:id', async (req, res, next) => {
  try {
    const result = await decideSepsisBundleAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SEPSIS_BUNDLE_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Sepsis bundle audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Consent & PHI policy sentinel
// ---------------------------------------------------------------------------
router.post('/privacy-sentinel/scans', async (req, res, next) => {
  try {
    const result = await runConsentPhiPolicyScan({
      req,
      generationId: req.body?.generation_id || null,
      windowDays: req.body?.window_days || 7,
      limit: req.body?.limit || 100,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIVACY_SENTINEL_SCAN_COMPLETED',
      String(req.body?.generation_id || req.tenantId || 'tenant'),
      null,
      {
        generation_id: req.body?.generation_id || null,
        window_days: req.body?.window_days || 7,
        summary: result.summary,
      }
    );
    return success(res, result, 'Privacy sentinel scan completed', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/privacy-sentinel/audits', async (req, res, next) => {
  try {
    const result = await listConsentPhiPolicyAudits({
      tenantId: req.tenantId,
      riskBand: req.query?.risk_band || null,
      decision: req.query?.decision || null,
      moduleKey: req.query?.module_key || null,
      patientUid: req.query?.patient_uid || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Privacy sentinel audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/privacy-sentinel/audits/:id', async (req, res, next) => {
  try {
    const result = await decideConsentPhiPolicyAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIVACY_SENTINEL_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Privacy sentinel audit reviewed');
  } catch (err) {
    return next(err);
  }
});

export default router;
