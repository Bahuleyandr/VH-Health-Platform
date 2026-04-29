import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  auditChargeCapture,
  decideChargeCaptureAudit,
  listChargeCaptureAudits,
  predictOtCaseTime,
  scoreNoShowRisk,
} from '../../../services/ai/operationalAiService.js';
import {
  listDeteriorationSnapshots,
  scoreDeterioration,
} from '../../../services/ai/deteriorationEarlyWarningService.js';
import {
  decidePolypharmacyReview,
  listPolypharmacyReviews,
} from '../../../services/ai/polypharmacyAiService.js';
import {
  decideTrialMatch,
  listTrialMatches,
  matchPatientAgainstTrials,
  upsertTrial,
} from '../../../services/ai/trialMatcherService.js';
import {
  listTrialSyncRuns,
  syncTrialsFromPublicRegistry,
} from '../../../services/ai/trialCatalogSyncService.js';
import {
  decideRcaDraft,
  generateRcaDraft,
  listRcaDrafts,
} from '../../../services/ai/rcaDraftService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Batch 4: clinical trials + RCA drafts
// ---------------------------------------------------------------------------
router.post('/trials/catalog', async (req, res, next) => {
  try {
    const trial = await upsertTrial({
      tenantId: req.tenantId,
      nctId: req.body?.nct_id,
      title: req.body?.title,
      phase: req.body?.phase || null,
      conditions: req.body?.conditions || [],
      eligibilitySummary: req.body?.eligibility_summary,
      ageMin: req.body?.age_min ?? null,
      ageMax: req.body?.age_max ?? null,
      gender: req.body?.gender || null,
      location: req.body?.location || null,
      status: req.body?.status || 'recruiting',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRIAL_UPSERTED', String(trial.id), null, trial);
    return success(res, trial, 'Trial upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/trials/sync', async (req, res, next) => {
  try {
    const result = await syncTrialsFromPublicRegistry({
      tenantId: req.tenantId,
      conditions: Array.isArray(req.body?.conditions) ? req.body.conditions : null,
      location: req.body?.location || null,
      maxResults: req.body?.max_results,
      requestedBy: req.user?.uid || null,
      tenantRegion: req.tenant?.region || 'IN',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRIAL_CATALOG_SYNCED', String(result.run_id || 'inline'), null, {
      fetched: result.fetched_count,
      upserted: result.upserted_count,
      status: result.status,
    });
    return success(res, result, 'Trial catalog sync complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/trials/sync', async (req, res, next) => {
  try {
    const result = await listTrialSyncRuns({ tenantId: req.tenantId, limit: req.query.limit });
    return success(res, result, 'Trial sync runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/trials/match/:patientUid', async (req, res, next) => {
  try {
    const result = await matchPatientAgainstTrials({
      tenantId: req.tenantId,
      patientUid: req.params.patientUid,
      admissionId: req.body?.admission_id || null,
      minScore: req.body?.min_score,
      limit: req.body?.limit,
    });
    return success(res, result, 'Trial match complete');
  } catch (err) {
    return next(err);
  }
});

router.get('/trials/matches', async (req, res, next) => {
  try {
    const result = await listTrialMatches({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Trial matches retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/trials/matches/:id', async (req, res, next) => {
  try {
    const decided = await decideTrialMatch({
      tenantId: req.tenantId,
      matchId: req.params.id,
      decision: req.body?.decision,
      decidedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRIAL_MATCH_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Trial match decided');
  } catch (err) {
    return next(err);
  }
});

router.post('/rca/:admissionId', async (req, res, next) => {
  try {
    const draft = await generateRcaDraft({
      req,
      admissionId: req.params.admissionId,
      caseType: req.body?.case_type || 'mortality',
    });
    return success(res, draft, 'RCA draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/rca', async (req, res, next) => {
  try {
    const result = await listRcaDrafts({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'RCA drafts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/rca/:id', async (req, res, next) => {
  try {
    const decided = await decideRcaDraft({
      tenantId: req.tenantId,
      rcaId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_RCA_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'RCA draft decided');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Clinical safety AI (Batch 3): deterioration EW + polypharmacy review
// ---------------------------------------------------------------------------
router.get('/safety/deterioration', async (req, res, next) => {
  try {
    const result = await listDeteriorationSnapshots({
      tenantId: req.tenantId,
      band: req.query.band || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Deterioration snapshots retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/safety/deterioration/:patientUid', async (req, res, next) => {
  try {
    const result = await scoreDeterioration({
      tenantId: req.tenantId,
      patientUid: req.params.patientUid,
      admissionId: req.body?.admission_id || null,
    });
    return success(res, result, 'Deterioration score computed');
  } catch (err) {
    return next(err);
  }
});

router.get('/safety/polypharmacy', async (req, res, next) => {
  try {
    const result = await listPolypharmacyReviews({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Polypharmacy reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/safety/polypharmacy/:id', async (req, res, next) => {
  try {
    const decided = await decidePolypharmacyReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      reviewerNote: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_POLYPHARMACY_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Polypharmacy review decided');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Operational AI (Batch 2): no-show, OT case-time, charge capture
// ---------------------------------------------------------------------------
router.post('/operational/no-show/:appointmentId', async (req, res, next) => {
  try {
    const result = await scoreNoShowRisk({
      tenantId: req.tenantId,
      appointmentId: req.params.appointmentId,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_NO_SHOW_RISK_SCORED',
      String(req.params.appointmentId),
      null,
      {
        appointment_id: result.appointment_id,
        risk_score: result.risk_score,
        band: result.band,
      }
    );
    return success(res, result, 'No-show risk scored');
  } catch (err) {
    return next(err);
  }
});

router.post('/operational/ot/:scheduleId', async (req, res, next) => {
  try {
    const result = await predictOtCaseTime({
      tenantId: req.tenantId,
      scheduleId: req.params.scheduleId,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_OT_CASE_TIME_PREDICTED',
      String(req.params.scheduleId),
      null,
      {
        ot_schedule_id: result.ot_schedule_id,
        predicted_minutes: result.predicted_minutes,
        confidence_pct: result.confidence_pct,
      }
    );
    return success(res, result, 'OT case-time predicted');
  } catch (err) {
    return next(err);
  }
});

router.post('/operational/charge-capture/:admissionId', async (req, res, next) => {
  try {
    const result = await auditChargeCapture({
      tenantId: req.tenantId,
      admissionId: req.params.admissionId,
    });
    return success(res, result, 'Charge capture audit complete');
  } catch (err) {
    return next(err);
  }
});

router.get('/operational/charge-capture', async (req, res, next) => {
  try {
    const result = await listChargeCaptureAudits({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Charge capture audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/operational/charge-capture/:id', async (req, res, next) => {
  try {
    const decided = await decideChargeCaptureAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_CHARGE_CAPTURE_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Charge capture audit decided');
  } catch (err) {
    return next(err);
  }
});

export default router;
