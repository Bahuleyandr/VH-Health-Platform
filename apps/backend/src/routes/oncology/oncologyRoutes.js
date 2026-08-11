// src/routes/oncology/oncologyRoutes.js
//
// Roadmap D1 — oncology/chemo foundations. Mounted at /api/v1/oncology
// (app.js) behind clinical-staff RBAC + PHI logging. Protocol/plan
// management is doctor/leadership-gated; verification + administration are
// nurse-level actions with the two-person guard enforced in the service.

import express from 'express';
import {
  createProtocol,
  activateProtocol,
  getProtocol,
  listProtocols,
  createTreatmentPlan,
  scheduleCycle,
  createInfusionChair,
  listInfusionChairs,
  updateInfusionChairStatus,
  bookInfusionChair,
  cancelChairBooking,
  getInfusionBoard,
  verifyAdministration,
  recordChemoAdministration,
  withholdAdministration,
  getPatientCumulative,
  getPlanDetail,
} from '../../services/oncology/chemoService.js';
import {
  getOncologyCompletionSettings,
  setOncologyCompletionSettings,
  createOncologyDiagnosis,
  listOncologyDiagnoses,
  createStagingRecord,
  signStagingRecord,
  createToxicityEvent,
  listToxicityEvents,
  signToxicityEvent,
  createTumorBoardMeeting,
  createTumorBoardCase,
  listTumorBoardQueue,
  updateTumorBoardCaseState,
  createTumorBoardRecommendation,
  updateTumorBoardRecommendationStatus,
  createRegistryExport,
  reviewRegistryExport,
} from '../../services/oncology/oncologyCompletionService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import {
  patientAccessGuard,
  patientAccessGuardForResource,
} from '../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isLeadership, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canManage = (role) => isAdmin(role) || isLeadership(role) || isDoctor(role) || role === 'SUPER_ADMIN';
const guardOncologyPatientView = patientAccessGuard('ONCOLOGY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  requirePatientContext: true,
  careTeamModeGoverned: true,
});
const guardOncologyPatientWrite = patientAccessGuard('ONCOLOGY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  requirePatientContext: true,
  careTeamModeGoverned: true,
});
const oncologyResourceGuard = (resourceType, {
  policyCode = ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  idSelector,
  requirePatientContext = false,
} = {}) => patientAccessGuardForResource('ONCOLOGY', {
  policyCode,
  resourceType,
  ...(idSelector ? { idSelector } : {}),
  requirePatientContext,
  careTeamModeGoverned: true,
});

const guardPlanView = oncologyResourceGuard('chemo_treatment_plan', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardPlanWrite = oncologyResourceGuard('chemo_treatment_plan');
const guardCycleBodyWrite = oncologyResourceGuard('chemo_cycle', {
  idSelector: (req) => req.body?.cycle_id,
});
const guardBookingWrite = oncologyResourceGuard('chair_booking');
const guardAdministrationWrite = oncologyResourceGuard('chemo_administration');
const guardDiagnosisWrite = oncologyResourceGuard('oncology_diagnosis');
const guardDiagnosisBodyWrite = oncologyResourceGuard('oncology_diagnosis', {
  idSelector: (req) => req.body?.diagnosis_id,
  requirePatientContext: true,
});
const guardPathologyReportBodyWrite = oncologyResourceGuard('pathology_report', {
  idSelector: (req) => req.body?.pathology_report_id,
  requirePatientContext: true,
});
const guardStagingWrite = oncologyResourceGuard('oncology_staging_record');
const guardToxicityWrite = oncologyResourceGuard('oncology_toxicity_event');
const guardTumorBoardCaseWrite = oncologyResourceGuard('tumor_board_case');
const guardTumorBoardRecommendationWrite = oncologyResourceGuard('tumor_board_recommendation');

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => req?.tenantId || req?.user?.tenantId || req?.user?.tenant_id || req?.tenant?.id || null;

// ── protocols ───────────────────────────────────────────────────────────

router.post('/protocols', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership manage chemo protocols', HTTP_STATUS.FORBIDDEN);
    const protocol = await createProtocol({
      tenantId: tenantOf(req),
      code: req.body.code,
      name: req.body.name,
      indication: req.body.indication || null,
      cycleLengthDays: req.body.cycle_length_days,
      totalCycles: req.body.total_cycles || 1,
      reference: req.body.reference || null,
      drugs: req.body.drugs || [],
    }, ctx(req));
    return success(res, { protocol }, 'Protocol created (draft)', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create protocol');
  }
});

router.get('/protocols', async (req, res) => {
  try {
    const protocols = await listProtocols({
      tenantId: tenantOf(req),
      status: req.query.status || null,
    });
    return success(res, { protocols, count: protocols.length }, 'Chemo protocols');
  } catch (err) {
    return handleFailure(res, err, 'list protocols');
  }
});

router.get('/protocols/:id', async (req, res) => {
  try {
    const protocol = await getProtocol(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { protocol }, 'Chemo protocol');
  } catch (err) {
    return handleFailure(res, err, 'get protocol');
  }
});

router.post('/protocols/:id/activate', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership activate protocols', HTTP_STATUS.FORBIDDEN);
    const protocol = await activateProtocol(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { protocol }, 'Protocol activated');
  } catch (err) {
    return handleFailure(res, err, 'activate protocol');
  }
});

// ── treatment plans + cycles ────────────────────────────────────────────

router.post('/protocols/:id/plans', guardOncologyPatientWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create treatment plans', HTTP_STATUS.FORBIDDEN);
    const plan = await createTreatmentPlan(req.params.id, {
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      indication: req.body.indication || null,
      plannedCycles: req.body.planned_cycles || null,
      consentRef: req.body.consent_ref || null,
      heightCm: req.body.height_cm ?? null,
      weightKg: req.body.weight_kg ?? null,
      startDate: req.body.start_date || null,
    }, ctx(req));
    return success(res, { plan }, 'Treatment plan created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create treatment plan');
  }
});

router.get('/plans/:id', guardPlanView, async (req, res) => {
  try {
    const plan = await getPlanDetail(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { plan }, 'Treatment plan');
  } catch (err) {
    return handleFailure(res, err, 'get treatment plan');
  }
});

router.post('/plans/:id/cycles', guardPlanWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership schedule cycles', HTTP_STATUS.FORBIDDEN);
    const result = await scheduleCycle(req.params.id, {
      tenantId: tenantOf(req),
      cycleNumber: req.body.cycle_number,
      scheduledDate: req.body.scheduled_date,
      weightKg: req.body.weight_kg ?? null,
      doseReductions: req.body.dose_reductions || {},
      ceilingOverrideReason: req.body.ceiling_override_reason || null,
    }, ctx(req));
    return success(res, result, 'Cycle scheduled', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'schedule cycle');
  }
});

// ── infusion chair board ─────────────────────────────────────────────────

router.get('/infusion-chairs', async (req, res) => {
  try {
    const chairs = await listInfusionChairs({
      tenantId: tenantOf(req),
      unitName: req.query.unit_name || null,
      includeInactive: req.query.include_inactive === 'true',
    });
    return success(res, { chairs, count: chairs.length }, 'Infusion chairs');
  } catch (err) {
    return handleFailure(res, err, 'list infusion chairs');
  }
});

router.post('/infusion-chairs', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership manage infusion chairs', HTTP_STATUS.FORBIDDEN);
    const chair = await createInfusionChair({
      tenantId: tenantOf(req),
      unitName: req.body.unit_name || 'Day Care',
      chairCode: req.body.chair_code,
      displayName: req.body.display_name || null,
      status: req.body.status || 'active',
      locationNote: req.body.location_note || null,
    }, ctx(req));
    return success(res, { chair }, 'Infusion chair created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create infusion chair');
  }
});

router.patch('/infusion-chairs/:id/status', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership manage infusion chairs', HTTP_STATUS.FORBIDDEN);
    const chair = await updateInfusionChairStatus(req.params.id, {
      tenantId: tenantOf(req),
      status: req.body.status,
    });
    return success(res, { chair }, 'Infusion chair status updated');
  } catch (err) {
    return handleFailure(res, err, 'update infusion chair status');
  }
});

router.get('/infusion-board', async (req, res) => {
  try {
    const board = await getInfusionBoard({
      tenantId: tenantOf(req),
      date: req.query.date || null,
      unitName: req.query.unit_name || null,
      includeCancelled: req.query.include_cancelled === 'true',
    });
    return success(res, { board }, 'Infusion chair board');
  } catch (err) {
    return handleFailure(res, err, 'get infusion chair board');
  }
});

router.post('/chair-bookings', guardCycleBodyWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership book infusion chairs', HTTP_STATUS.FORBIDDEN);
    const result = await bookInfusionChair({
      tenantId: tenantOf(req),
      cycleId: req.body.cycle_id,
      chairId: req.body.chair_id,
      startAt: req.body.start_at,
      endAt: req.body.end_at,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, result, 'Infusion chair booked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'book infusion chair');
  }
});

router.post('/chair-bookings/:id/cancel', guardBookingWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership cancel infusion chair bookings', HTTP_STATUS.FORBIDDEN);
    const booking = await cancelChairBooking(req.params.id, {
      tenantId: tenantOf(req),
      reason: req.body.reason || null,
    }, ctx(req));
    return success(res, { booking }, 'Infusion chair booking cancelled');
  } catch (err) {
    return handleFailure(res, err, 'cancel infusion chair booking');
  }
});

// ── administration loop ─────────────────────────────────────────────────

router.post('/administrations/:id/verify', guardAdministrationWrite, async (req, res) => {
  try {
    const verification = await verifyAdministration(req.params.id, {
      tenantId: tenantOf(req),
      verifierRole: req.body.verifier_role,
      scannedPatientUid: req.body.scanned_patient_uid || null,
    }, ctx(req));
    return success(res, { verification }, 'Verification recorded');
  } catch (err) {
    return handleFailure(res, err, 'verify administration');
  }
});

router.post('/administrations/:id/administer', guardAdministrationWrite, async (req, res) => {
  try {
    const administration = await recordChemoAdministration(req.params.id, {
      tenantId: tenantOf(req),
      ...ctx(req),
    });
    return success(res, { administration }, 'Chemo administration recorded');
  } catch (err) {
    return handleFailure(res, err, 'record administration');
  }
});

router.post('/administrations/:id/withhold', guardAdministrationWrite, async (req, res) => {
  try {
    const administration = await withholdAdministration(req.params.id, {
      tenantId: tenantOf(req),
      reason: req.body.reason,
    }, ctx(req));
    return success(res, { administration }, 'Administration withheld');
  } catch (err) {
    return handleFailure(res, err, 'withhold administration');
  }
});

// ── cumulative dose view ────────────────────────────────────────────────

router.get('/patients/:uid/cumulative', guardOncologyPatientView, async (req, res) => {
  try {
    const cumulative = await getPatientCumulative(req.params.uid, { tenantId: tenantOf(req) });
    return success(res, { cumulative, count: cumulative.length }, 'Cumulative chemo doses');
  } catch (err) {
    return handleFailure(res, err, 'get cumulative doses');
  }
});

// ── oncology completion settings ────────────────────────────────────────

router.get('/completion-settings', async (req, res) => {
  try {
    const settings = await getOncologyCompletionSettings({ tenantId: tenantOf(req) });
    return success(res, { settings }, 'Oncology completion settings');
  } catch (err) {
    return handleFailure(res, err, 'get completion settings');
  }
});

router.patch('/completion-settings', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership manage oncology completion settings', HTTP_STATUS.FORBIDDEN);
    const settings = await setOncologyCompletionSettings({
      tenantId: tenantOf(req),
      enabled: req.body.enabled === true,
      ownerSourcePolicyRef: req.body.owner_source_policy_ref || null,
      tumorBoardQuorumPolicyRef: req.body.tumor_board_quorum_policy_ref || null,
      acceptanceSnapshot: req.body.acceptance_snapshot || null,
    }, ctx(req));
    return success(res, { settings }, 'Oncology completion settings updated');
  } catch (err) {
    return handleFailure(res, err, 'update completion settings');
  }
});

// ── diagnosis + staging ─────────────────────────────────────────────────

router.get('/diagnoses', guardOncologyPatientView, async (req, res) => {
  try {
    const diagnoses = await listOncologyDiagnoses({
      tenantId: tenantOf(req),
      patientUid: req.query.patient_uid || null,
      limit: req.query.limit,
    });
    return success(res, { diagnoses, count: diagnoses.length }, 'Oncology diagnoses');
  } catch (err) {
    return handleFailure(res, err, 'list oncology diagnoses');
  }
});

router.post('/diagnoses', guardPathologyReportBodyWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create oncology diagnoses', HTTP_STATUS.FORBIDDEN);
    const diagnosis = await createOncologyDiagnosis({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      encounterId: req.body.encounter_id || null,
      cancerSite: req.body.cancer_site,
      morphology: req.body.morphology || null,
      laterality: req.body.laterality || null,
      diagnosisDate: req.body.diagnosis_date || null,
      pathologyReportId: req.body.pathology_report_id || null,
      malignancyFlagSource: req.body.malignancy_flag_source || null,
      sourceEvidenceRefs: req.body.source_evidence_refs || [],
    }, ctx(req));
    return success(res, { diagnosis }, 'Oncology diagnosis created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create oncology diagnosis');
  }
});

router.post('/diagnoses/:id/staging', guardDiagnosisWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership record oncology staging', HTTP_STATUS.FORBIDDEN);
    const staging = await createStagingRecord(req.params.id, {
      tenantId: tenantOf(req),
      tCategory: req.body.t_category || null,
      nCategory: req.body.n_category || null,
      mCategory: req.body.m_category || null,
      clinicalStage: req.body.clinical_stage || null,
      pathologicStage: req.body.pathologic_stage || null,
      ajccEdition: req.body.ajcc_edition || null,
      stagingSource: req.body.staging_source || null,
      stagingSourceVersion: req.body.staging_source_version || null,
      stagingSourceAttachmentRefs: req.body.staging_source_attachment_refs || [],
      verify: req.body.verify === true,
      verificationNote: req.body.verification_note || null,
    }, ctx(req));
    return success(res, { staging }, 'Oncology staging recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record oncology staging');
  }
});

router.post('/staging/:id/sign', guardStagingWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership sign oncology staging', HTTP_STATUS.FORBIDDEN);
    const staging = await signStagingRecord(req.params.id, {
      tenantId: tenantOf(req),
      verificationNote: req.body.verification_note || null,
    }, ctx(req));
    return success(res, { staging }, 'Oncology staging signed');
  } catch (err) {
    return handleFailure(res, err, 'sign oncology staging');
  }
});

// ── CTCAE toxicity ──────────────────────────────────────────────────────

router.get('/toxicity-events', guardOncologyPatientView, async (req, res) => {
  try {
    const toxicity_events = await listToxicityEvents({
      tenantId: tenantOf(req),
      patientUid: req.query.patient_uid || null,
      limit: req.query.limit,
    });
    return success(res, { toxicity_events, count: toxicity_events.length }, 'Oncology toxicity events');
  } catch (err) {
    return handleFailure(res, err, 'list toxicity events');
  }
});

router.post('/toxicity-events', guardDiagnosisBodyWrite, async (req, res) => {
  try {
    const toxicity_event = await createToxicityEvent({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      encounterId: req.body.encounter_id || null,
      diagnosisId: req.body.diagnosis_id || null,
      toxicityTerm: req.body.toxicity_term,
      ctcaeGrade: req.body.ctcae_grade,
      ctcaeSource: req.body.ctcae_source || null,
      ctcaeSourceVersion: req.body.ctcae_source_version || null,
      ctcaeSourceAttachmentRefs: req.body.ctcae_source_attachment_refs || [],
      attribution: req.body.attribution || null,
      actionTaken: req.body.action_taken || 'monitor',
      clinicalNote: req.body.clinical_note || null,
      chemoPlanId: req.body.chemo_plan_id || null,
      chemoCycleId: req.body.chemo_cycle_id || null,
      chemoAdministrationId: req.body.chemo_administration_id || null,
      signoff: req.body.signoff === true,
    }, ctx(req));
    return success(res, { toxicity_event }, 'Toxicity event recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record toxicity event');
  }
});

router.post('/toxicity-events/:id/sign', guardToxicityWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership sign toxicity events', HTTP_STATUS.FORBIDDEN);
    const toxicity_event = await signToxicityEvent(req.params.id, { tenantId: tenantOf(req) }, ctx(req));
    return success(res, { toxicity_event }, 'Toxicity event signed');
  } catch (err) {
    return handleFailure(res, err, 'sign toxicity event');
  }
});

// ── tumor board ─────────────────────────────────────────────────────────

router.get('/tumor-board/queue', async (req, res) => {
  try {
    const cases = await listTumorBoardQueue({
      tenantId: tenantOf(req),
      state: req.query.state || null,
      limit: req.query.limit,
    });
    return success(res, { cases, count: cases.length }, 'Tumor board queue');
  } catch (err) {
    return handleFailure(res, err, 'list tumor board queue');
  }
});

router.post('/tumor-board/meetings', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create tumor board meetings', HTTP_STATUS.FORBIDDEN);
    const meeting = await createTumorBoardMeeting({
      tenantId: tenantOf(req),
      serviceLine: req.body.service_line,
      meetingDate: req.body.meeting_date,
      chairUid: req.body.chair_uid || null,
      attendeeUids: req.body.attendee_uids || [],
      externalAttendees: req.body.external_attendees || [],
      quorumReference: req.body.quorum_reference,
      status: req.body.status || 'scheduled',
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { meeting }, 'Tumor board meeting created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create tumor board meeting');
  }
});

router.post('/tumor-board/cases', guardDiagnosisBodyWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create tumor board cases', HTTP_STATUS.FORBIDDEN);
    const board_case = await createTumorBoardCase({
      tenantId: tenantOf(req),
      diagnosisId: req.body.diagnosis_id,
      meetingId: req.body.meeting_id || null,
      stagingRecordId: req.body.staging_record_id || null,
      apReportId: req.body.ap_report_id || null,
      radiologyOrderId: req.body.radiology_order_id || null,
      question: req.body.question,
      priority: req.body.priority || 'routine',
      discussionState: req.body.discussion_state || 'queued',
    }, ctx(req));
    return success(res, { board_case }, 'Tumor board case created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create tumor board case');
  }
});

router.patch('/tumor-board/cases/:id/state', guardTumorBoardCaseWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership change tumor board case state', HTTP_STATUS.FORBIDDEN);
    const board_case = await updateTumorBoardCaseState(req.params.id, {
      tenantId: tenantOf(req),
      state: req.body.state,
      discussionSummary: req.body.discussion_summary || null,
    }, ctx(req));
    return success(res, { board_case }, 'Tumor board case updated');
  } catch (err) {
    return handleFailure(res, err, 'update tumor board case');
  }
});

router.post('/tumor-board/cases/:id/recommendations', guardTumorBoardCaseWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create tumor board recommendations', HTTP_STATUS.FORBIDDEN);
    const recommendation = await createTumorBoardRecommendation(req.params.id, {
      tenantId: tenantOf(req),
      recommendationType: req.body.recommendation_type,
      recommendationText: req.body.recommendation_text,
      responsibleOwnerUid: req.body.responsible_owner_uid || null,
      dueDate: req.body.due_date,
      chemoPlanId: req.body.chemo_plan_id || null,
    }, ctx(req));
    return success(res, { recommendation }, 'Tumor board recommendation created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create tumor board recommendation');
  }
});

router.patch('/tumor-board/recommendations/:id/status', guardTumorBoardRecommendationWrite, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership update tumor board recommendations', HTTP_STATUS.FORBIDDEN);
    const recommendation = await updateTumorBoardRecommendationStatus(req.params.id, {
      tenantId: tenantOf(req),
      status: req.body.status,
      acceptanceNote: req.body.acceptance_note || null,
      deferReason: req.body.defer_reason || null,
    }, ctx(req));
    return success(res, { recommendation }, 'Tumor board recommendation updated');
  } catch (err) {
    return handleFailure(res, err, 'update tumor board recommendation');
  }
});

// ── registry exports ────────────────────────────────────────────────────

router.post('/registry-exports', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create oncology registry exports', HTTP_STATUS.FORBIDDEN);
    const registry_export = await createRegistryExport({
      tenantId: tenantOf(req),
      registryName: req.body.registry_name,
      exportPeriodStart: req.body.export_period_start,
      exportPeriodEnd: req.body.export_period_end,
      evidenceRefs: req.body.evidence_refs || [],
      filterSnapshot: req.body.filter_snapshot || {},
      rowCount: req.body.row_count || 0,
    }, ctx(req));
    return success(res, { registry_export }, 'Oncology registry export created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create registry export');
  }
});

router.patch('/registry-exports/:id/review', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership review oncology registry exports', HTTP_STATUS.FORBIDDEN);
    const registry_export = await reviewRegistryExport(req.params.id, {
      tenantId: tenantOf(req),
      reviewNote: req.body.review_note || null,
      release: req.body.release === true,
    }, ctx(req));
    return success(res, { registry_export }, 'Oncology registry export reviewed');
  } catch (err) {
    return handleFailure(res, err, 'review registry export');
  }
});

export default router;
