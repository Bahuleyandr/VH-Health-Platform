import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  decideBedTurnoverPrediction,
  evaluateBedTurnover,
  listBedTurnoverPredictions,
} from '../../../services/ai/housekeepingBedTurnoverService.js';
import {
  decideMaintenancePrediction,
  evaluateDeviceMaintenanceRisk,
  listBiomedDevices,
  listMaintenancePredictions,
  upsertBiomedDevice,
} from '../../../services/ai/biomedDeviceMaintenanceService.js';
import {
  decideSecurityAnomaly,
  listSecurityAnomalies,
  recordAnomaly,
} from '../../../services/ai/cybersecurityAnomalyService.js';
import {
  decidePgxAdvisory,
  generatePgxAdvisory,
  listPatientGenotypes,
  listPgxAdvisories,
  upsertPatientGenotype,
} from '../../../services/ai/pharmacogenomicsService.js';
import {
  decideRadiologyReportReview,
  evaluateRadiologyReport,
  listRadiologyReportReviews,
} from '../../../services/ai/radiologyReportQaService.js';
import {
  decideWorklistPriority,
  evaluateWorklistStudy,
  listWorklistPriorities,
} from '../../../services/ai/radiologyWorklistPrioritizerService.js';
import {
  decideOtBlockSuggestion,
  evaluateOtBlock,
  listOtBlockSuggestions,
} from '../../../services/ai/otBlockSchedulingService.js';
import {
  decideInventoryAlert,
  evaluateInventoryItem,
  listInventoryAlerts,
} from '../../../services/ai/inventoryIntelligenceService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Housekeeping / bed turnover optimizer
// ---------------------------------------------------------------------------
router.post('/bed-turnover/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateBedTurnover({
      req,
      bedId: req.body?.bed_id ?? null,
      ward: req.body?.ward ?? null,
      roomNumber: req.body?.room_number ?? null,
      previousAdmissionId: req.body?.previous_admission_id ?? null,
      currentStatus: req.body?.current_status ?? 'discharged_pending_clean',
      priorDiagnoses: req.body?.prior_diagnoses || [],
      isolationPrecautions: req.body?.isolation_precautions || [],
      hadSurgicalProcedure: Boolean(req.body?.had_surgical_procedure),
      mrsaStatus: req.body?.mrsa_status ?? null,
      dischargeTime: req.body?.discharge_time ?? null,
      bedDemand: req.body?.bed_demand ?? 'normal',
      staffingLoad: req.body?.staffing_load ?? 'normal',
      hasPrivateBathroom: req.body?.has_private_bathroom ?? true,
      isEdDoorway: Boolean(req.body?.is_ed_doorway),
      isIsolationWard: Boolean(req.body?.is_isolation_ward),
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_BED_TURNOVER_PREDICTED',
      String(result.prediction_id || result.generation_id || 'inline'),
      null,
      {
        prediction_id: result.prediction_id,
        priority_band: result.draft?.priority_band,
        cleaning_level: result.draft?.required_cleaning_level,
      }
    );
    return success(res, result, 'Bed turnover predicted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/bed-turnover/predictions', async (req, res, next) => {
  try {
    const result = await listBedTurnoverPredictions({
      tenantId: req.tenantId,
      ward: req.query?.ward || null,
      bedId: req.query?.bed_id || null,
      priorityBand: req.query?.priority_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Bed turnover predictions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/bed-turnover/predictions/:id', async (req, res, next) => {
  try {
    const result = await decideBedTurnoverPrediction({
      tenantId: req.tenantId,
      predictionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_BED_TURNOVER_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Bed turnover prediction updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Biomedical device maintenance predictor
// ---------------------------------------------------------------------------
router.post('/biomed-devices', async (req, res, next) => {
  try {
    const result = await upsertBiomedDevice({
      tenantId: req.tenantId,
      deviceCode: req.body?.device_code,
      deviceType: req.body?.device_type,
      manufacturer: req.body?.manufacturer || null,
      model: req.body?.model || null,
      serialNumber: req.body?.serial_number || null,
      location: req.body?.location || null,
      installedAt: req.body?.installed_at || null,
      warrantyExpiresOn: req.body?.warranty_expires_on || null,
      lastPreventiveMaintenanceAt: req.body?.last_preventive_maintenance_at || null,
      nextScheduledMaintenanceAt: req.body?.next_scheduled_maintenance_at || null,
      usageHours: req.body?.usage_hours ?? 0,
      faultEventsLast90d: req.body?.fault_events_last_90d ?? 0,
      mtbfHours: req.body?.mean_time_between_failures_hours ?? null,
      status: req.body?.status || 'in_service',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_BIOMED_DEVICE_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Biomedical device upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/biomed-devices', async (req, res, next) => {
  try {
    const result = await listBiomedDevices({
      tenantId: req.tenantId,
      deviceType: req.query?.device_type || null,
      status: req.query?.status || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Biomedical devices retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/biomed-devices/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateDeviceMaintenanceRisk({
      req,
      deviceId: req.body?.device_id || null,
      deviceCode: req.body?.device_code || null,
      overrideInputs: req.body?.override_inputs || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_BIOMED_DEVICE_MAINTENANCE_PREDICTED',
      String(result.prediction_id || result.generation_id || 'inline'),
      null,
      {
        prediction_id: result.prediction_id,
        risk_band: result.draft?.risk_band,
      }
    );
    return success(res, result, 'Biomedical device maintenance risk evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/biomed-devices/predictions', async (req, res, next) => {
  try {
    const result = await listMaintenancePredictions({
      tenantId: req.tenantId,
      deviceId: req.query?.device_id || null,
      deviceCode: req.query?.device_code || null,
      riskBand: req.query?.risk_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Biomedical device predictions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/biomed-devices/predictions/:id', async (req, res, next) => {
  try {
    const result = await decideMaintenancePrediction({
      tenantId: req.tenantId,
      predictionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_BIOMED_DEVICE_MAINTENANCE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Biomedical device prediction updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Cybersecurity anomaly detector
// ---------------------------------------------------------------------------
router.post('/security-anomalies/record', async (req, res, next) => {
  try {
    const result = await recordAnomaly({
      req,
      subjectType: req.body?.subject_type,
      subjectId: req.body?.subject_id || null,
      inputs: req.body?.inputs || {},
      context: req.body?.context || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SECURITY_ANOMALY_RECORDED',
      String(result.anomaly_id || result.generation_id || 'inline'),
      null,
      {
        anomaly_id: result.anomaly_id,
        anomaly_category: result.draft?.anomaly_category,
        severity: result.draft?.severity,
      }
    );
    return success(res, result, 'Security anomaly recorded', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/security-anomalies', async (req, res, next) => {
  try {
    const result = await listSecurityAnomalies({
      tenantId: req.tenantId,
      subjectType: req.query?.subject_type || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Security anomalies retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/security-anomalies/:id', async (req, res, next) => {
  try {
    const result = await decideSecurityAnomaly({
      tenantId: req.tenantId,
      anomalyId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_SECURITY_ANOMALY_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Security anomaly updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Pharmacogenomics / PGx support
// ---------------------------------------------------------------------------
router.post('/pgx/genotypes', async (req, res, next) => {
  try {
    const result = await upsertPatientGenotype({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      gene: req.body?.gene,
      phenotype: req.body?.phenotype,
      genotypeDetail: req.body?.genotype_detail || null,
      source: req.body?.source || null,
      sourceReportId: req.body?.source_report_id || null,
      testedAt: req.body?.tested_at || null,
      verified: Boolean(req.body?.verified),
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PGX_GENOTYPE_UPSERTED', String(result?.id || 'inline'), null, result);
    return success(res, result, 'Patient genotype upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/pgx/genotypes', async (req, res, next) => {
  try {
    const result = await listPatientGenotypes({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      gene: req.query?.gene || null,
    });
    return success(res, result, 'Patient genotypes retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/pgx/advisories/evaluate', async (req, res, next) => {
  try {
    const result = await generatePgxAdvisory({
      req,
      patientUid: req.body?.patient_uid,
      medicationName: req.body?.medication_name,
      prescriptionId: req.body?.prescription_id || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PGX_ADVISORY_GENERATED',
      String(result.advisory_id || result.generation_id || 'inline'),
      null,
      {
        advisory_id: result.advisory_id,
        advisory_category: result.draft?.advisory_category,
        severity: result.draft?.severity,
      }
    );
    return success(res, result, 'PGx advisory generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/pgx/advisories', async (req, res, next) => {
  try {
    const result = await listPgxAdvisories({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      advisoryCategory: req.query?.advisory_category || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'PGx advisories retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/pgx/advisories/:id', async (req, res, next) => {
  try {
    const result = await decidePgxAdvisory({
      tenantId: req.tenantId,
      advisoryId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PGX_ADVISORY_REVIEWED', String(result.id), null, result);
    return success(res, result, 'PGx advisory updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Radiology Report QA / Discrepancy Assistant
// ---------------------------------------------------------------------------
router.post('/radiology/report-qa/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateRadiologyReport({
      req,
      patientUid: req.body?.patient_uid || null,
      studyId: req.body?.study_id || null,
      accessionNumber: req.body?.accession_number || null,
      modality: req.body?.modality || null,
      bodyPart: req.body?.body_part || null,
      indication: req.body?.indication || null,
      reportText: req.body?.report_text,
      reportStatus: req.body?.report_status || 'draft',
      priorsAvailable: Boolean(req.body?.priors_available),
      isCritical: Boolean(req.body?.is_critical),
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_RADIOLOGY_REPORT_QA_EVALUATED',
      String(result.review_id || result.generation_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        overall_severity: result.overall_severity,
        discrepancy_count: result.discrepancy_count,
      }
    );
    return success(res, result, 'Radiology report QA evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/radiology/report-qa', async (req, res, next) => {
  try {
    const result = await listRadiologyReportReviews({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      modality: req.query?.modality || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Radiology report QA reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/radiology/report-qa/:id', async (req, res, next) => {
  try {
    const result = await decideRadiologyReportReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_RADIOLOGY_REPORT_QA_DECIDED', String(result.id), null, result);
    return success(res, result, 'Radiology report QA review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Radiology Worklist Prioritizer
// ---------------------------------------------------------------------------
router.post('/radiology/worklist/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateWorklistStudy({
      req,
      patientUid: req.body?.patient_uid || null,
      studyId: req.body?.study_id || null,
      accessionNumber: req.body?.accession_number || null,
      modality: req.body?.modality || null,
      bodyPart: req.body?.body_part || null,
      indication: req.body?.indication || null,
      location: req.body?.location || null,
      waitMinutes: req.body?.wait_minutes ?? null,
      fragility: req.body?.fragility || {},
      contextTags: Array.isArray(req.body?.context_tags) ? req.body.context_tags : [],
      priorsAvailable: Boolean(req.body?.priors_available),
      isStatOverride: Boolean(req.body?.is_stat_override),
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_RADIOLOGY_WORKLIST_EVALUATED',
      String(result.priority_id || result.generation_id || 'inline'),
      null,
      {
        priority_id: result.priority_id,
        priority_tier: result.priority_tier,
        priority_score: result.priority_score,
      }
    );
    return success(res, result, 'Radiology worklist priority evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/radiology/worklist', async (req, res, next) => {
  try {
    const result = await listWorklistPriorities({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      modality: req.query?.modality || null,
      priorityTier: req.query?.priority_tier || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Radiology worklist priorities retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/radiology/worklist/:id', async (req, res, next) => {
  try {
    const result = await decideWorklistPriority({
      tenantId: req.tenantId,
      priorityId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_RADIOLOGY_WORKLIST_DECIDED', String(result.id), null, result);
    return success(res, result, 'Radiology worklist priority updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// OT Block Scheduling Optimizer
// ---------------------------------------------------------------------------
router.post('/ot/blocks/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateOtBlock({
      req,
      surgeonUid: req.body?.surgeon_uid || null,
      surgeonName: req.body?.surgeon_name || null,
      serviceLine: req.body?.service_line || null,
      blockLabel: req.body?.block_label,
      orRoom: req.body?.or_room || null,
      windowStart: req.body?.window_start || null,
      windowEnd: req.body?.window_end || null,
      allocatedMinutes: req.body?.allocated_minutes,
      scheduledMinutes: req.body?.scheduled_minutes,
      actualMinutes: req.body?.actual_minutes ?? null,
      primeAllocatedMinutes: req.body?.prime_allocated_minutes ?? null,
      primeUsedMinutes: req.body?.prime_used_minutes ?? null,
      overrunCount: req.body?.overrun_count ?? 0,
      addonCount: req.body?.addon_count ?? 0,
      totalCases: req.body?.total_cases ?? 0,
      avgTurnoverMinutes: req.body?.avg_turnover_minutes ?? null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_OT_BLOCK_EVALUATED',
      String(result.suggestion_id || result.generation_id || 'inline'),
      null,
      {
        suggestion_id: result.suggestion_id,
        recommendation: result.recommendation,
        severity: result.severity,
      }
    );
    return success(res, result, 'OT block evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/ot/blocks', async (req, res, next) => {
  try {
    const result = await listOtBlockSuggestions({
      tenantId: req.tenantId,
      surgeonUid: req.query?.surgeon_uid || null,
      serviceLine: req.query?.service_line || null,
      recommendation: req.query?.recommendation || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'OT block suggestions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/ot/blocks/:id', async (req, res, next) => {
  try {
    const result = await decideOtBlockSuggestion({
      tenantId: req.tenantId,
      suggestionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_OT_BLOCK_DECIDED', String(result.id), null, result);
    return success(res, result, 'OT block suggestion updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Inventory Intelligence (Non-Pharmacy)
// ---------------------------------------------------------------------------
router.post('/inventory/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateInventoryItem({
      req,
      itemSku: req.body?.item_sku,
      itemName: req.body?.item_name,
      category: req.body?.category || null,
      ward: req.body?.ward || null,
      currentStock: req.body?.current_stock,
      reorderPoint: req.body?.reorder_point ?? 0,
      maxStock: req.body?.max_stock ?? null,
      avgDailyUsage: req.body?.avg_daily_usage ?? 0,
      baselineDailyUsage: req.body?.baseline_daily_usage ?? 0,
      nextExpiryDate: req.body?.next_expiry_date || null,
      today: req.body?.today || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_INVENTORY_EVALUATED',
      String(result.alert_id || result.generation_id || 'inline'),
      null,
      {
        alert_id: result.alert_id,
        alert_category: result.alert_category,
        severity: result.severity,
      }
    );
    return success(res, result, 'Inventory alert generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/inventory/alerts', async (req, res, next) => {
  try {
    const result = await listInventoryAlerts({
      tenantId: req.tenantId,
      itemSku: req.query?.item_sku || null,
      category: req.query?.category || null,
      ward: req.query?.ward || null,
      alertCategory: req.query?.alert_category || null,
      severity: req.query?.severity || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Inventory alerts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/inventory/alerts/:id', async (req, res, next) => {
  try {
    const result = await decideInventoryAlert({
      tenantId: req.tenantId,
      alertId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_INVENTORY_DECIDED', String(result.id), null, result);
    return success(res, result, 'Inventory alert updated');
  } catch (err) {
    return next(err);
  }
});

export default router;
