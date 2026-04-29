import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  decidePolicyDiff,
  generatePolicyDiff,
  listPolicyDiffs,
} from '../../../services/ai/policyRegulationWatcherService.js';
import {
  decideTimelineSnapshot,
  generateTimelineSnapshot,
  listTimelineSnapshots,
} from '../../../services/ai/multimodalPatientTimelineService.js';
import {
  decidePathwayBundleAudit,
  evaluatePathwayBundle,
  listPathwayBundleAudits,
} from '../../../services/ai/pathwayBundleComplianceService.js';
import {
  decideGraphHealthReport,
  evaluateGraphHealth,
  listEdges,
  listGraphHealthReports,
  listNodes,
  upsertEdge,
  upsertNode,
} from '../../../services/ai/clinicalKnowledgeGraphService.js';
import {
  decideAcuityStaffingForecast,
  evaluateAcuityStaffing,
  listAcuityStaffingForecasts,
} from '../../../services/ai/acuityStaffingForecastService.js';
import {
  changeSiteStatus,
  decideFederationRound,
  listFederationRounds,
  listFederationSites,
  recordFederationRound,
  upsertFederationSite,
} from '../../../services/ai/federatedLearningCoordinatorService.js';
import {
  decideVoiceSession,
  evaluateVoiceSession,
  listVoiceSessions,
} from '../../../services/ai/voicePatientAssistantIvrService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Policy Diff / Regulation Watcher
// ---------------------------------------------------------------------------
router.post('/policy-diffs/evaluate', async (req, res, next) => {
  try {
    const result = await generatePolicyDiff({
      req,
      policyKey: req.body?.policy_key,
      policyTitle: req.body?.policy_title || null,
      source: req.body?.source || null,
      previousVersion: req.body?.previous_version || null,
      currentVersion: req.body?.current_version || null,
      effectiveDate: req.body?.effective_date || null,
      previousText: req.body?.previous_text || '',
      currentText: req.body?.current_text || '',
      explicitDiff: req.body?.explicit_diff || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_POLICY_DIFF_GENERATED',
      String(result.diff_id || result.generation_id || 'inline'),
      null,
      {
        diff_id: result.diff_id,
        impact_area: result.impact_area,
        severity: result.severity,
      }
    );
    return success(res, result, 'Policy diff generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/policy-diffs', async (req, res, next) => {
  try {
    const result = await listPolicyDiffs({
      tenantId: req.tenantId,
      policyKey: req.query?.policy_key || null,
      impactArea: req.query?.impact_area || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Policy diffs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/policy-diffs/:id', async (req, res, next) => {
  try {
    const result = await decidePolicyDiff({
      tenantId: req.tenantId,
      diffId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_POLICY_DIFF_DECIDED', String(result.id), null, result);
    return success(res, result, 'Policy diff updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Multimodal Patient Timeline
// ---------------------------------------------------------------------------
router.post('/patient-timeline/generate', async (req, res, next) => {
  try {
    const result = await generateTimelineSnapshot({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id ?? null,
      windowStart: req.body?.window_start || null,
      windowEnd: req.body?.window_end || null,
      events: Array.isArray(req.body?.events) ? req.body.events : [],
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PATIENT_TIMELINE_GENERATED',
      String(result.snapshot_id || result.generation_id || 'inline'),
      null,
      {
        snapshot_id: result.snapshot_id,
        overall_severity: result.overall_severity,
        event_count: result.event_count,
      }
    );
    return success(res, result, 'Patient timeline snapshot generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/patient-timeline/snapshots', async (req, res, next) => {
  try {
    const result = await listTimelineSnapshots({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      overallSeverity: req.query?.overall_severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Patient timeline snapshots retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/patient-timeline/snapshots/:id', async (req, res, next) => {
  try {
    const result = await decideTimelineSnapshot({
      tenantId: req.tenantId,
      snapshotId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PATIENT_TIMELINE_DECIDED', String(result.id), null, result);
    return success(res, result, 'Patient timeline snapshot updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Generalized Pathway Bundle Compliance
// ---------------------------------------------------------------------------
router.post('/pathway-bundles/evaluate', async (req, res, next) => {
  try {
    const result = await evaluatePathwayBundle({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id ?? null,
      pathwayKey: req.body?.pathway_key,
      customSpec: req.body?.custom_spec || null,
      t0Reference: req.body?.t0_reference,
      actions: Array.isArray(req.body?.actions) ? req.body.actions : [],
      context: req.body?.context || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PATHWAY_BUNDLE_EVALUATED',
      String(result.audit_id || result.generation_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        pathway_key: result.pathway_key,
        compliance_pct: result.compliance_pct,
        severity: result.severity,
        recommendation: result.recommendation,
      }
    );
    return success(res, result, 'Pathway bundle evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/pathway-bundles', async (req, res, next) => {
  try {
    const result = await listPathwayBundleAudits({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      pathwayKey: req.query?.pathway_key || null,
      severity: req.query?.severity || null,
      recommendation: req.query?.recommendation || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Pathway bundle audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/pathway-bundles/:id', async (req, res, next) => {
  try {
    const result = await decidePathwayBundleAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PATHWAY_BUNDLE_DECIDED', String(result.id), null, result);
    return success(res, result, 'Pathway bundle audit updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Clinical Knowledge Graph
// ---------------------------------------------------------------------------
router.post('/knowledge-graph/nodes', async (req, res, next) => {
  try {
    const result = await upsertNode({
      tenantId: req.tenantId,
      nodeType: req.body?.node_type,
      nodeKey: req.body?.node_key,
      displayName: req.body?.display_name || null,
      source: req.body?.source || null,
      sourceRef: req.body?.source_ref || null,
      validFrom: req.body?.valid_from || null,
      validTo: req.body?.valid_to || null,
      attributes: req.body?.attributes || {},
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_KG_NODE_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Knowledge graph node upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/knowledge-graph/nodes', async (req, res, next) => {
  try {
    const result = await listNodes({
      tenantId: req.tenantId,
      nodeType: req.query?.node_type || null,
      source: req.query?.source || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Knowledge graph nodes retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/knowledge-graph/edges', async (req, res, next) => {
  try {
    const result = await upsertEdge({
      tenantId: req.tenantId,
      edgeType: req.body?.edge_type,
      fromNodeId: req.body?.from_node_id,
      toNodeId: req.body?.to_node_id,
      source: req.body?.source || null,
      sourceRef: req.body?.source_ref || null,
      validFrom: req.body?.valid_from || null,
      validTo: req.body?.valid_to || null,
      attributes: req.body?.attributes || {},
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_KG_EDGE_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Knowledge graph edge upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/knowledge-graph/edges', async (req, res, next) => {
  try {
    const result = await listEdges({
      tenantId: req.tenantId,
      edgeType: req.query?.edge_type || null,
      fromNodeId: req.query?.from_node_id || null,
      toNodeId: req.query?.to_node_id || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Knowledge graph edges retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/knowledge-graph/health/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateGraphHealth({
      req,
      today: req.body?.today || null,
      stalenessDays: req.body?.staleness_days ?? 365,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KG_HEALTH_EVALUATED',
      String(result.report_id || result.generation_id || 'inline'),
      null,
      {
        report_id: result.report_id,
        overall_health: result.overall_health,
        severity: result.severity,
      }
    );
    return success(res, result, 'Knowledge graph health evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/knowledge-graph/health/reports', async (req, res, next) => {
  try {
    const result = await listGraphHealthReports({
      tenantId: req.tenantId,
      overallHealth: req.query?.overall_health || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Knowledge graph health reports retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/knowledge-graph/health/reports/:id', async (req, res, next) => {
  try {
    const result = await decideGraphHealthReport({
      tenantId: req.tenantId,
      reportId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_KG_HEALTH_DECIDED', String(result.id), null, result);
    return success(res, result, 'Knowledge graph health report updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Acuity-Based Staffing Forecast
// ---------------------------------------------------------------------------
router.post('/acuity-staffing/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateAcuityStaffing({
      req,
      unit: req.body?.unit,
      shiftLabel: req.body?.shift_label || null,
      shiftStart: req.body?.shift_start || null,
      shiftEnd: req.body?.shift_end || null,
      census: req.body?.census || {},
      currentStaff: req.body?.current_staff || {},
      predictedAdmissions: req.body?.predicted_admissions ?? 0,
      predictedDischarges: req.body?.predicted_discharges ?? 0,
      customRatios: req.body?.custom_ratios || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ACUITY_STAFFING_EVALUATED',
      String(result.forecast_id || result.generation_id || 'inline'),
      null,
      {
        forecast_id: result.forecast_id,
        recommendation: result.recommendation,
        severity: result.severity,
      }
    );
    return success(res, result, 'Acuity staffing forecast generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/acuity-staffing/forecasts', async (req, res, next) => {
  try {
    const result = await listAcuityStaffingForecasts({
      tenantId: req.tenantId,
      unit: req.query?.unit || null,
      recommendation: req.query?.recommendation || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Acuity staffing forecasts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/acuity-staffing/forecasts/:id', async (req, res, next) => {
  try {
    const result = await decideAcuityStaffingForecast({
      tenantId: req.tenantId,
      forecastId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ACUITY_STAFFING_DECIDED', String(result.id), null, result);
    return success(res, result, 'Acuity staffing forecast updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Federated Learning / Privacy-Preserving Training Layer
// ---------------------------------------------------------------------------
router.post('/federation/sites', async (req, res, next) => {
  try {
    const result = await upsertFederationSite({
      tenantId: req.tenantId,
      siteKey: req.body?.site_key,
      displayName: req.body?.display_name || null,
      region: req.body?.region || null,
      contact: req.body?.contact || null,
      dpEpsilonBudget: req.body?.dp_epsilon_budget ?? null,
      dpEpsilonSpent: req.body?.dp_epsilon_spent ?? null,
      minCohortSize: req.body?.min_cohort_size ?? null,
      acceptedAggregationMethods: req.body?.accepted_aggregation_methods || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FEDERATION_SITE_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Federation site upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/federation/sites', async (req, res, next) => {
  try {
    const result = await listFederationSites({
      tenantId: req.tenantId,
      siteKey: req.query?.site_key || null,
      status: req.query?.status || null,
      approvalStatus: req.query?.approval_status || null,
      region: req.query?.region || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Federation sites retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/federation/sites/:id/status', async (req, res, next) => {
  try {
    const result = await changeSiteStatus({
      tenantId: req.tenantId,
      siteId: req.params.id,
      status: req.body?.status,
      approvalStatus: req.body?.approval_status || null,
      approvalNote: req.body?.approval_note || null,
      approvedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FEDERATION_SITE_STATUS_CHANGED', String(result.id), null, result);
    return success(res, result, 'Federation site status updated');
  } catch (err) {
    return next(err);
  }
});

router.post('/federation/rounds', async (req, res, next) => {
  try {
    const result = await recordFederationRound({
      req,
      roundKey: req.body?.round_key,
      modelKey: req.body?.model_key,
      aggregationMethod: req.body?.aggregation_method || 'fed_avg',
      startedAt: req.body?.started_at || null,
      endedAt: req.body?.ended_at || null,
      participantSiteCount: req.body?.participant_site_count ?? 0,
      minParticipants: req.body?.min_participants ?? 3,
      totalDpEpsilonSpent: req.body?.total_dp_epsilon_spent ?? 0,
      totalDpEpsilonBudget: req.body?.total_dp_epsilon_budget ?? 10,
      cohortTotalSize: req.body?.cohort_total_size ?? 0,
      cohortMinSiteSize: req.body?.cohort_min_site_size ?? null,
      siteMinFloor: req.body?.site_min_floor ?? 100,
      dataDriftScore: req.body?.data_drift_score ?? null,
      siteParticipation: Array.isArray(req.body?.site_participation) ? req.body.site_participation : [],
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_FEDERATION_ROUND_RECORDED',
      String(result.round_id || result.generation_id || 'inline'),
      null,
      {
        round_id: result.round_id,
        recommendation: result.recommendation,
        severity: result.severity,
      }
    );
    return success(res, result, 'Federation round recorded', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/federation/rounds', async (req, res, next) => {
  try {
    const result = await listFederationRounds({
      tenantId: req.tenantId,
      roundKey: req.query?.round_key || null,
      modelKey: req.query?.model_key || null,
      recommendation: req.query?.recommendation || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Federation rounds retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/federation/rounds/:id', async (req, res, next) => {
  try {
    const result = await decideFederationRound({
      tenantId: req.tenantId,
      roundId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FEDERATION_ROUND_DECIDED', String(result.id), null, result);
    return success(res, result, 'Federation round updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Voice Patient Assistant / IVR
// ---------------------------------------------------------------------------
router.post('/voice-ivr/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateVoiceSession({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id ?? null,
      intent: req.body?.intent,
      channel: req.body?.channel || 'ivr',
      language: req.body?.language || 'en',
      scriptKey: req.body?.script_key || null,
      consentRef: req.body?.consent_ref || null,
      consentFresh: Boolean(req.body?.consent_fresh),
      transcriptText: req.body?.transcript_text || '',
      candidateResponse: req.body?.candidate_response || '',
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_VOICE_IVR_EVALUATED',
      String(result.session_id || result.generation_id || 'inline'),
      null,
      {
        session_id: result.session_id,
        recommendation: result.recommendation,
        severity: result.severity,
      }
    );
    return success(res, result, 'Voice IVR session evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/voice-ivr/sessions', async (req, res, next) => {
  try {
    const result = await listVoiceSessions({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      intent: req.query?.intent || null,
      channel: req.query?.channel || null,
      recommendation: req.query?.recommendation || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Voice IVR sessions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/voice-ivr/sessions/:id', async (req, res, next) => {
  try {
    const result = await decideVoiceSession({
      tenantId: req.tenantId,
      sessionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VOICE_IVR_DECIDED', String(result.id), null, result);
    return success(res, result, 'Voice IVR session updated');
  } catch (err) {
    return next(err);
  }
});

export default router;
