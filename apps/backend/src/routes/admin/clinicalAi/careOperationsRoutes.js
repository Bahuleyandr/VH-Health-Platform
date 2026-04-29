import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  decideImagingFinding,
  getImagingPacsStatus,
  importImagingStudyFromPacs,
  ingestInferenceResult,
  listImagingFindings,
  registerImagingStudy,
} from '../../../services/ai/imagingAiService.js';
import {
  acknowledgeEscalation,
  enrollPatient,
  listActiveEnrollments,
  listOpenEscalations,
  resolveEscalation,
} from '../../../services/ai/virtualWardService.js';
import {
  decideNursingAmbientSession,
  generateNursingAmbientSession,
  listNursingAmbientSessions,
} from '../../../services/ai/nursingAmbientDocumentationService.js';
import {
  decideFamilyUpdate,
  generateFamilyUpdate,
  listFamilyUpdates,
  markFamilyUpdateSent,
} from '../../../services/ai/familyUpdateGeneratorService.js';
import {
  discardRoster,
  generateRoster,
  listRosterRuns,
  publishRoster,
} from '../../../services/ai/rosterOptimizerService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Staff roster optimizer
// ---------------------------------------------------------------------------
router.post('/roster', async (req, res, next) => {
  try {
    const result = await generateRoster({
      req,
      department: req.body?.department,
      startDate: req.body?.start_date,
      endDate: req.body?.end_date,
      demandOverride: req.body?.demand || null,
      staffOverride: req.body?.staff || null,
      strategy: req.body?.strategy || null,
      solverTimeoutMs: req.body?.solver_timeout_ms || undefined,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ROSTER_SUGGESTED', String(result.run_id || 'inline'), null, {
      department: result.department,
      total_slots: result.total_slots,
      filled_slots: result.filled_slots,
      gaps: result.coverage_gaps.length,
      optimizer: result.optimizer,
      solver_status: result.solver_status,
    });
    return success(res, result, 'Roster suggested', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/roster', async (req, res, next) => {
  try {
    const result = await listRosterRuns({
      tenantId: req.tenantId,
      department: req.query?.department || null,
      status: req.query?.status || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Roster runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/roster/:id/publish', async (req, res, next) => {
  try {
    const published = await publishRoster({
      tenantId: req.tenantId,
      runId: req.params.id,
      publishedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ROSTER_PUBLISHED', String(published.id), null, published);
    return success(res, published, 'Roster published');
  } catch (err) {
    return next(err);
  }
});

router.patch('/roster/:id/discard', async (req, res, next) => {
  try {
    const discarded = await discardRoster({
      tenantId: req.tenantId,
      runId: req.params.id,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ROSTER_DISCARDED', String(discarded.id), null, discarded);
    return success(res, discarded, 'Roster discarded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Virtual ward — enrollments + escalations
// ---------------------------------------------------------------------------
router.post('/virtual-ward/enrollments', async (req, res, next) => {
  try {
    const enrollment = await enrollPatient({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      careManagerUid: req.body?.care_manager_uid || null,
      pathway: req.body?.pathway || 'generic_post_discharge',
      startDate: req.body?.start_date || null,
      expectedCheckInCadenceHours: req.body?.expected_check_in_cadence_hours || 24,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VIRTUAL_WARD_ENROLLED', String(enrollment.id), null, enrollment);
    return success(res, enrollment, 'Patient enrolled in virtual ward', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/virtual-ward/enrollments', async (req, res, next) => {
  try {
    const result = await listActiveEnrollments({ tenantId: req.tenantId, limit: req.query.limit });
    return success(res, result, 'Active enrollments retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/virtual-ward/escalations', async (req, res, next) => {
  try {
    const result = await listOpenEscalations({
      tenantId: req.tenantId,
      severity: req.query.severity || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Open escalations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/virtual-ward/escalations/:id/acknowledge', async (req, res, next) => {
  try {
    const acked = await acknowledgeEscalation({
      tenantId: req.tenantId,
      escalationId: req.params.id,
      acknowledgedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VIRTUAL_WARD_ACK', String(acked.id), null, acked);
    return success(res, acked, 'Escalation acknowledged');
  } catch (err) {
    return next(err);
  }
});

router.patch('/virtual-ward/escalations/:id/resolve', async (req, res, next) => {
  try {
    const resolved = await resolveEscalation({
      tenantId: req.tenantId,
      escalationId: req.params.id,
      resolution: req.body?.resolution,
      note: req.body?.note || null,
      resolvedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VIRTUAL_WARD_RESOLVED', String(resolved.id), null, resolved);
    return success(res, resolved, 'Escalation resolved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Imaging AI — DICOM study register + inference ingestion + review
// ---------------------------------------------------------------------------
router.get('/imaging/pacs/status', async (req, res, next) => {
  try {
    const result = getImagingPacsStatus({ tenantRegion: req.tenant?.region || null });
    return success(res, result, 'Imaging PACS adapter status retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/imaging/studies', async (req, res, next) => {
  try {
    const saved = await registerImagingStudy({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id,
      studyInstanceUid: req.body?.study_instance_uid,
      modality: req.body?.modality,
      bodyPart: req.body?.body_part,
      studyDate: req.body?.study_date,
      seriesCount: req.body?.series_count,
      instanceCount: req.body?.instance_count,
      pacsUrl: req.body?.pacs_url,
      storageKey: req.body?.storage_key,
      sourceSystem: req.body?.source_system,
      orderedBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_STUDY_REGISTERED', String(saved.id), null, saved);
    return success(res, saved, 'Imaging study registered', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/imaging/studies/import-pacs', async (req, res, next) => {
  try {
    const result = await importImagingStudyFromPacs({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id,
      studyInstanceUid: req.body?.study_instance_uid,
      accessionNumber: req.body?.accession_number,
      provider: req.body?.provider || null,
      orderedBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_PACS_IMPORT', String(result.study?.id || 'inline'), null, {
      imported: result.imported,
      pacs_status: result.pacs_status,
      reason: result.reason || null,
      provider: result.provider,
      api_mode: result.api_mode,
    });
    return success(res, result, result.imported ? 'Imaging study imported from PACS' : 'Imaging PACS import skipped', result.imported ? 201 : 200);
  } catch (err) {
    return next(err);
  }
});

router.post('/imaging/inference', async (req, res, next) => {
  try {
    const result = await ingestInferenceResult({
      req,
      studyInstanceUid: req.body?.study_instance_uid,
      provider: req.body?.provider,
      model: req.body?.model || null,
      modelVersion: req.body?.model_version || null,
      results: req.body?.results || [],
      heatmapUrl: req.body?.heatmap_url || null,
      rawProviderPayload: req.body?.raw_provider_payload || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_INFERENCE_INGESTED', String(result.finding_id || 'inline'), null, {
      severity: result.overall_severity,
      confidence_pct: result.confidence_pct,
    });
    return success(res, result, 'Imaging inference ingested', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/imaging/findings', async (req, res, next) => {
  try {
    const result = await listImagingFindings({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      severity: req.query.severity || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Imaging findings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/imaging/findings/:id', async (req, res, next) => {
  try {
    const decided = await decideImagingFinding({
      tenantId: req.tenantId,
      findingId: req.params.id,
      decision: req.body?.decision,
      radiologistUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Imaging finding decided');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Nursing ambient documentation
// ---------------------------------------------------------------------------
router.post('/nursing-ambient/sessions', async (req, res, next) => {
  try {
    const result = await generateNursingAmbientSession({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      nurseUid: req.body?.nurse_uid || req.user?.uid || null,
      shift: req.body?.shift || 'day',
      recordingStartedAt: req.body?.recording_started_at || null,
      recordingEndedAt: req.body?.recording_ended_at || null,
      durationSeconds: req.body?.duration_seconds || null,
      consentReference: req.body?.consent_reference || null,
      audioStorageKey: req.body?.audio_storage_key || null,
      audioMime: req.body?.audio_mime || null,
      sttProvider: req.body?.stt_provider || 'none',
      sttModel: req.body?.stt_model || null,
      sttLanguage: req.body?.stt_language || null,
      diarizationProvider: req.body?.diarization_provider || null,
      transcriptSegments: req.body?.transcript_segments || [],
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_NURSING_AMBIENT_SESSION_GENERATED',
      String(result.session_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        session_id: result.session_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        shift: result.shift,
        fall_count: result.draft?.falls?.length || 0,
        wound_count: result.draft?.wounds?.length || 0,
      }
    );
    return success(res, result, 'Nursing ambient session generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/nursing-ambient/sessions', async (req, res, next) => {
  try {
    const result = await listNursingAmbientSessions({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      shift: req.query?.shift || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Nursing ambient sessions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/nursing-ambient/sessions/:id', async (req, res, next) => {
  try {
    const result = await decideNursingAmbientSession({
      tenantId: req.tenantId,
      sessionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_NURSING_AMBIENT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Nursing ambient session updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Consent-aware family update generator
// ---------------------------------------------------------------------------
router.post('/family-updates', async (req, res, next) => {
  try {
    const result = await generateFamilyUpdate({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      caregiverIdentifier: req.body?.caregiver_identifier || null,
      caregiverRelationship: req.body?.caregiver_relationship || 'other',
      language: req.body?.language || 'en',
      sourceGenerationId: req.body?.source_generation_id || null,
      consentReference: req.body?.consent_reference || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_FAMILY_UPDATE_GENERATED',
      String(result.update_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        update_id: result.update_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        caregiver_relationship: result.caregiver_relationship,
        language: result.language,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Family update drafted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/family-updates', async (req, res, next) => {
  try {
    const result = await listFamilyUpdates({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      updateStatus: req.query?.update_status || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Family updates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/family-updates/:id', async (req, res, next) => {
  try {
    const result = await decideFamilyUpdate({
      tenantId: req.tenantId,
      updateId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FAMILY_UPDATE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Family update review recorded');
  } catch (err) {
    return next(err);
  }
});

router.post('/family-updates/:id/sent', async (req, res, next) => {
  try {
    const result = await markFamilyUpdateSent({
      tenantId: req.tenantId,
      updateId: req.params.id,
      sentBy: req.user?.uid || null,
      deliveryChannel: req.body?.delivery_channel || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FAMILY_UPDATE_SENT', String(result.id), null, result);
    return success(res, result, 'Family update marked as sent');
  } catch (err) {
    return next(err);
  }
});

export default router;
