import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  decideSyntheticCase,
  generateAndPersistSyntheticCase,
  listSyntheticCases,
} from '../../../services/ai/syntheticCaseGeneratorService.js';
import {
  decideTrainingModule,
  generateTrainingModule,
  listTrainingModules,
} from '../../../services/ai/trainingSimulationCoachService.js';
import {
  changeModelStage,
  decideEvalRun,
  listEvalRuns,
  listModelRegistry,
  recordEvalRun,
  upsertModelRegistry,
} from '../../../services/ai/modelRegistryWorkbenchService.js';
import {
  decideProcurementOpportunity,
  evaluateProcurementOpportunity,
  listProcurementOpportunities,
} from '../../../services/ai/procurementNegotiationService.js';
import {
  decideExplainabilityReport,
  evaluateExplainability,
  listExplainabilityReports,
} from '../../../services/ai/aiExplainabilityDashboardService.js';
import {
  changeAgentStage,
  decideAgentHealthReport,
  listAgentHealthReports,
  listAgentRegistry,
  recordAgentHealth,
  upsertAgentRegistry,
} from '../../../services/ai/aiAgentLifecycleService.js';
import {
  decideCommandSnapshot,
  evaluateCommandSnapshot,
  listCommandSnapshots,
} from '../../../services/ai/hospitalCommandCenterService.js';
import {
  createLabelingTask,
  decideAnnotation,
  getTaskWithAnnotations,
  listAnnotations,
  listLabelingTasks,
  submitAnnotation,
} from '../../../services/ai/datasetLabelingStudioService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Synthetic Clinical Case Generator
// ---------------------------------------------------------------------------
router.post('/synthetic-cases/generate', async (req, res, next) => {
  try {
    const result = await generateAndPersistSyntheticCase({
      req,
      pathway: req.body?.pathway,
      complexity: req.body?.complexity || 'standard',
      seed: req.body?.seed || null,
      intendedUse: req.body?.intended_use || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SYNTHETIC_CASE_GENERATED',
      String(result.case_id || result.generation_id || 'inline'),
      null,
      {
        case_id: result.case_id,
        pathway: result.pathway,
        complexity: result.complexity,
      }
    );
    return success(res, result, 'Synthetic case generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/synthetic-cases', async (req, res, next) => {
  try {
    const result = await listSyntheticCases({
      tenantId: req.tenantId,
      pathway: req.query?.pathway || null,
      complexity: req.query?.complexity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Synthetic cases retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/synthetic-cases/:id', async (req, res, next) => {
  try {
    const result = await decideSyntheticCase({
      tenantId: req.tenantId,
      caseId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_SYNTHETIC_CASE_DECIDED', String(result.id), null, result);
    return success(res, result, 'Synthetic case updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Training and Simulation Coach
// ---------------------------------------------------------------------------
router.post('/training/modules/generate', async (req, res, next) => {
  try {
    const result = await generateTrainingModule({
      req,
      title: req.body?.title,
      caseType: req.body?.case_type,
      incidentCategory: req.body?.incident_category || null,
      severity: req.body?.severity || 'low',
      summary: req.body?.summary || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TRAINING_MODULE_GENERATED',
      String(result.module_id || result.generation_id || 'inline'),
      null,
      {
        module_id: result.module_id,
        case_type: result.case_type,
        severity: result.severity,
        risk_band: result.risk_band,
      }
    );
    return success(res, result, 'Training module generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/training/modules', async (req, res, next) => {
  try {
    const result = await listTrainingModules({
      tenantId: req.tenantId,
      caseType: req.query?.case_type || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Training modules retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/training/modules/:id', async (req, res, next) => {
  try {
    const result = await decideTrainingModule({
      tenantId: req.tenantId,
      moduleId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRAINING_MODULE_DECIDED', String(result.id), null, result);
    return success(res, result, 'Training module updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Model Registry and Evaluation Workbench
// ---------------------------------------------------------------------------
router.post('/model-registry', async (req, res, next) => {
  try {
    const result = await upsertModelRegistry({
      tenantId: req.tenantId,
      modelKey: req.body?.model_key,
      version: req.body?.version,
      provider: req.body?.provider || null,
      purpose: req.body?.purpose || null,
      owner: req.body?.owner || null,
      parentVersion: req.body?.parent_version || null,
      lineage: req.body?.lineage || {},
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_MODEL_REGISTRY_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Model registry entry upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/model-registry', async (req, res, next) => {
  try {
    const result = await listModelRegistry({
      tenantId: req.tenantId,
      modelKey: req.query?.model_key || null,
      stage: req.query?.stage || null,
      approvalStatus: req.query?.approval_status || null,
      owner: req.query?.owner || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Model registry retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/model-registry/:id/stage', async (req, res, next) => {
  try {
    const result = await changeModelStage({
      tenantId: req.tenantId,
      registryId: req.params.id,
      stage: req.body?.stage,
      approvalStatus: req.body?.approval_status || null,
      approvalNote: req.body?.approval_note || null,
      approvedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_MODEL_STAGE_CHANGED', String(result.id), null, result);
    return success(res, result, 'Model stage updated');
  } catch (err) {
    return next(err);
  }
});

router.post('/model-registry/eval-runs', async (req, res, next) => {
  try {
    const metadata = { ...(req.body?.metadata || {}) };
    if (req.body?.module_key) metadata.module_key = req.body.module_key;
    if (req.body?.provider) metadata.provider = req.body.provider;
    if (req.body?.model) metadata.model = req.body.model;
    const result = await recordEvalRun({
      req,
      modelKey: req.body?.model_key,
      version: req.body?.version,
      suite: req.body?.suite,
      sampleCount: req.body?.sample_count ?? 0,
      passCount: req.body?.pass_count ?? 0,
      failCount: req.body?.fail_count ?? 0,
      accuracy: req.body?.accuracy ?? null,
      f1Score: req.body?.f1_score ?? null,
      avgLatencyMs: req.body?.avg_latency_ms ?? null,
      fallbackRatePct: req.body?.fallback_rate_pct ?? null,
      safetyFlagRatePct: req.body?.safety_flag_rate_pct ?? null,
      driftScore: req.body?.drift_score ?? null,
      baselineMetrics: req.body?.baseline_metrics || null,
      metadata,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_MODEL_EVAL_RECORDED',
      String(result.run_id || result.generation_id || 'inline'),
      null,
      {
        run_id: result.run_id,
        recommendation: result.recommendation,
        severity: result.severity,
      }
    );
    return success(res, result, 'Model eval run recorded', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/model-registry/eval-runs', async (req, res, next) => {
  try {
    const result = await listEvalRuns({
      tenantId: req.tenantId,
      modelKey: req.query?.model_key || null,
      version: req.query?.version || null,
      recommendation: req.query?.recommendation || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Model eval runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/model-registry/eval-runs/:id', async (req, res, next) => {
  try {
    const result = await decideEvalRun({
      tenantId: req.tenantId,
      runId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_MODEL_EVAL_DECIDED', String(result.id), null, result);
    return success(res, result, 'Model eval run updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Procurement Negotiation Assistant
// ---------------------------------------------------------------------------
router.post('/procurement/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateProcurementOpportunity({
      req,
      itemSku: req.body?.item_sku,
      itemName: req.body?.item_name,
      category: req.body?.category || null,
      vendorName: req.body?.vendor_name || null,
      currentUnitPrice: req.body?.current_unit_price,
      historicalAvgPrice: req.body?.historical_avg_price ?? 0,
      historicalMinPrice: req.body?.historical_min_price ?? null,
      quotedAlternativePrice: req.body?.quoted_alternative_price ?? null,
      annualVolume: req.body?.annual_volume ?? 0,
      vendorCountForCategory: req.body?.vendor_count_for_category ?? 1,
      contractTenureMonths: req.body?.contract_tenure_months ?? null,
      contractEndDate: req.body?.contract_end_date || null,
      today: req.body?.today || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PROCUREMENT_EVALUATED',
      String(result.opportunity_id || result.generation_id || 'inline'),
      null,
      {
        opportunity_id: result.opportunity_id,
        opportunity_category: result.opportunity_category,
        severity: result.severity,
      }
    );
    return success(res, result, 'Procurement opportunity generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/procurement/opportunities', async (req, res, next) => {
  try {
    const result = await listProcurementOpportunities({
      tenantId: req.tenantId,
      itemSku: req.query?.item_sku || null,
      category: req.query?.category || null,
      vendorName: req.query?.vendor_name || null,
      opportunityCategory: req.query?.opportunity_category || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Procurement opportunities retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/procurement/opportunities/:id', async (req, res, next) => {
  try {
    const result = await decideProcurementOpportunity({
      tenantId: req.tenantId,
      opportunityId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PROCUREMENT_DECIDED', String(result.id), null, result);
    return success(res, result, 'Procurement opportunity updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// AI Explainability Dashboard
// ---------------------------------------------------------------------------
router.post('/explainability/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateExplainability({
      req,
      sourceGenerationId: req.body?.source_generation_id || null,
      moduleKey: req.body?.module_key || null,
      patientUid: req.body?.patient_uid || null,
      draftText: req.body?.draft_text,
      citations: Array.isArray(req.body?.citations) ? req.body.citations : [],
      contextText: req.body?.context_text || '',
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_EXPLAINABILITY_EVALUATED',
      String(result.report_id || result.generation_id || 'inline'),
      null,
      {
        report_id: result.report_id,
        trust_band: result.trust_band,
        severity: result.severity,
      }
    );
    return success(res, result, 'Explainability report generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/explainability/reports', async (req, res, next) => {
  try {
    const result = await listExplainabilityReports({
      tenantId: req.tenantId,
      moduleKey: req.query?.module_key || null,
      trustBand: req.query?.trust_band || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Explainability reports retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/explainability/reports/:id', async (req, res, next) => {
  try {
    const result = await decideExplainabilityReport({
      tenantId: req.tenantId,
      reportId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_EXPLAINABILITY_DECIDED', String(result.id), null, result);
    return success(res, result, 'Explainability report updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// AI Agent Lifecycle Manager
// ---------------------------------------------------------------------------
router.post('/agent-registry', async (req, res, next) => {
  try {
    const result = await upsertAgentRegistry({
      tenantId: req.tenantId,
      agentKey: req.body?.agent_key,
      displayName: req.body?.display_name || null,
      owner: req.body?.owner || null,
      purpose: req.body?.purpose || null,
      scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : [],
      permittedActions: Array.isArray(req.body?.permitted_actions) ? req.body.permitted_actions : [],
      expiryDate: req.body?.expiry_date || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_AGENT_REGISTRY_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Agent registry upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/agent-registry', async (req, res, next) => {
  try {
    const result = await listAgentRegistry({
      tenantId: req.tenantId,
      agentKey: req.query?.agent_key || null,
      stage: req.query?.stage || null,
      approvalStatus: req.query?.approval_status || null,
      owner: req.query?.owner || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Agent registry retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/agent-registry/:id/stage', async (req, res, next) => {
  try {
    const result = await changeAgentStage({
      tenantId: req.tenantId,
      registryId: req.params.id,
      stage: req.body?.stage,
      approvalStatus: req.body?.approval_status || null,
      approvalNote: req.body?.approval_note || null,
      approvedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_AGENT_STAGE_CHANGED', String(result.id), null, result);
    return success(res, result, 'Agent stage updated');
  } catch (err) {
    return next(err);
  }
});

router.post('/agent-registry/health-reports', async (req, res, next) => {
  try {
    const result = await recordAgentHealth({
      req,
      agentKey: req.body?.agent_key,
      invocationCount: req.body?.invocation_count ?? 0,
      successCount: req.body?.success_count ?? 0,
      errorCount: req.body?.error_count ?? 0,
      avgLatencyMs: req.body?.avg_latency_ms ?? null,
      permissionMismatchCount: req.body?.permission_mismatch_count ?? 0,
      lastSeenAt: req.body?.last_seen_at || null,
      today: req.body?.today || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_AGENT_HEALTH_RECORDED',
      String(result.report_id || result.generation_id || 'inline'),
      null,
      {
        report_id: result.report_id,
        recommendation: result.recommendation,
        severity: result.severity,
      }
    );
    return success(res, result, 'Agent health report recorded', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/agent-registry/health-reports', async (req, res, next) => {
  try {
    const result = await listAgentHealthReports({
      tenantId: req.tenantId,
      agentKey: req.query?.agent_key || null,
      recommendation: req.query?.recommendation || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Agent health reports retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/agent-registry/health-reports/:id', async (req, res, next) => {
  try {
    const result = await decideAgentHealthReport({
      tenantId: req.tenantId,
      reportId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_AGENT_HEALTH_DECIDED', String(result.id), null, result);
    return success(res, result, 'Agent health report updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Hospital Command Center
// ---------------------------------------------------------------------------
router.post('/command-center/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateCommandSnapshot({
      req,
      bed: req.body?.bed || {},
      ed: req.body?.ed || {},
      ot: req.body?.ot || {},
      housekeeping: req.body?.housekeeping || {},
      radiology: req.body?.radiology || {},
      pharmacy: req.body?.pharmacy || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_COMMAND_CENTER_EVALUATED',
      String(result.snapshot_id || result.generation_id || 'inline'),
      null,
      {
        snapshot_id: result.snapshot_id,
        command_status: result.command_status,
        overall_score: result.overall_score,
      }
    );
    return success(res, result, 'Command center snapshot generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/command-center/snapshots', async (req, res, next) => {
  try {
    const result = await listCommandSnapshots({
      tenantId: req.tenantId,
      commandStatus: req.query?.command_status || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Command center snapshots retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/command-center/snapshots/:id', async (req, res, next) => {
  try {
    const result = await decideCommandSnapshot({
      tenantId: req.tenantId,
      snapshotId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_COMMAND_CENTER_DECIDED', String(result.id), null, result);
    return success(res, result, 'Command center snapshot updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Dataset Labeling Studio
// ---------------------------------------------------------------------------
router.post('/labeling/tasks', async (req, res, next) => {
  try {
    const result = await createLabelingTask({
      tenantId: req.tenantId,
      datasetKey: req.body?.dataset_key,
      taskType: req.body?.task_type,
      itemKey: req.body?.item_key,
      inputRefType: req.body?.input_ref_type || null,
      inputRefId: req.body?.input_ref_id || null,
      requiredLabelers: req.body?.required_labelers ?? 2,
      difficulty: req.body?.difficulty || 'standard',
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_LABELING_TASK_CREATED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Labeling task upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/labeling/tasks', async (req, res, next) => {
  try {
    const result = await listLabelingTasks({
      tenantId: req.tenantId,
      datasetKey: req.query?.dataset_key || null,
      taskType: req.query?.task_type || null,
      status: req.query?.status || null,
      agreement: req.query?.agreement || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Labeling tasks retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/labeling/tasks/:id', async (req, res, next) => {
  try {
    const result = await getTaskWithAnnotations({
      tenantId: req.tenantId,
      taskId: req.params.id,
    });
    return success(res, result, 'Labeling task retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/labeling/annotations', async (req, res, next) => {
  try {
    const result = await submitAnnotation({
      req,
      taskId: req.body?.task_id,
      label: req.body?.label,
      labelerUid: req.body?.labeler_uid || req.user?.uid || null,
      confidenceScore: req.body?.confidence_score ?? null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_LABELING_ANNOTATION_SUBMITTED',
      String(result.annotation_id || result.generation_id || 'inline'),
      null,
      {
        annotation_id: result.annotation_id,
        task_id: result.task_id,
      }
    );
    return success(res, result, 'Labeling annotation submitted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/labeling/annotations', async (req, res, next) => {
  try {
    const result = await listAnnotations({
      tenantId: req.tenantId,
      taskId: req.query?.task_id || null,
      labelerUid: req.query?.labeler_uid || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Labeling annotations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/labeling/annotations/:id', async (req, res, next) => {
  try {
    const result = await decideAnnotation({
      tenantId: req.tenantId,
      annotationId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_LABELING_ANNOTATION_DECIDED', String(result?.annotation?.id || 'inline'), null, result);
    return success(res, result, 'Labeling annotation updated');
  } catch (err) {
    return next(err);
  }
});

export default router;
