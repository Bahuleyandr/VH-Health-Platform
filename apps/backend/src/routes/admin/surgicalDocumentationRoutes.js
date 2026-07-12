/**
 * Admin routes for surgical / OR clinical documentation (Tier B PR1).
 *
 * Mounted at /api/v1/admin/surgical via routes/admin/index.js. RBAC
 * inherits the admin gate already applied at the parent mount.
 *
 *   GET    /surgical/preop/:scheduleId                 — get preop checklist
 *   PUT    /surgical/preop/:scheduleId                 — upsert preop checklist
 *   GET    /surgical/preop                             — list preop checklists
 *   POST   /surgical/intraop                           — create intraop note
 *   GET    /surgical/intraop                           — list intraop notes
 *   PATCH  /surgical/intraop/:id/finalize              — finalize intraop note
 *   POST   /surgical/postop                            — create postop note
 *   GET    /surgical/postop                            — list postop notes
 *   PATCH  /surgical/postop/:id/finalize               — finalize postop note
 *   PUT    /surgical/anesthesia/:scheduleId            — upsert anesthesia record
 *   PATCH  /surgical/anesthesia/:scheduleId/finalize   — finalize anesthesia record
 *   GET    /surgical/anesthesia/:scheduleId            — get anesthesia record
 *   POST   /surgical/implants                          — record implant
 *   GET    /surgical/implants                          — list implants
 *   PATCH  /surgical/implants/:id/remove               — record implant removal
 *   PUT    /surgical/safety/:scheduleId/:phase         — upsert safety phase
 *   GET    /surgical/safety/:scheduleId                — list safety phases
 *   POST   /surgical/complications                     — record complication alert
 *   GET    /surgical/complications                     — list complication alerts
 *   PATCH  /surgical/complications/:id/acknowledge     — acknowledge alert
 *   PATCH  /surgical/complications/:id/resolve         — resolve alert
 */

import express from 'express';

import { error, success } from '../../utils/responseHelper.js';
import {
  acknowledgeComplicationAlert,
  createIntraopNote,
  createPostopNote,
  finalizeAnesthesiaRecord,
  finalizeIntraopNote,
  finalizePostopNote,
  getAnesthesiaRecord,
  getPreopChecklist,
  listComplicationAlerts,
  listImplants,
  listIntraopNotes,
  listPostopNotes,
  listPreopChecklists,
  listSafetyChecklist,
  recordComplicationAlert,
  recordImplant,
  recordImplantRemoval,
  resolveComplicationAlert,
  upsertAnesthesiaRecord,
  upsertPreopChecklist,
  upsertSafetyChecklistPhase,
} from '../../services/theatre/surgicalDocumentationService.js';
import { emitOrBoardEvent } from '../../utils/websocket/realtimeEmitter.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// preop_checklists
// ---------------------------------------------------------------------------

router.get('/preop/:scheduleId', async (req, res, next) => {
  try {
    const result = await getPreopChecklist({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
    });
    if (!result) return error(res, 'Preop checklist not found', 404);
    return success(res, result, 'Preop checklist retrieved');
  } catch (err) { return next(err); }
});

router.put('/preop/:scheduleId', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await upsertPreopChecklist({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
      patientUid: body.patient_uid,
      consentSigned: body.consent_signed,
      consentSignedAt: body.consent_signed_at,
      consentWitness: body.consent_witness,
      npoStatusConfirmed: body.npo_status_confirmed,
      npoSince: body.npo_since,
      siteMarked: body.site_marked,
      siteMarkedBy: body.site_marked_by,
      allergiesReviewed: body.allergies_reviewed,
      allergiesSummary: body.allergies_summary,
      bloodArranged: body.blood_arranged,
      bloodUnits: body.blood_units,
      imagingAvailable: body.imaging_available,
      requiredImaging: body.required_imaging,
      preopLabsReviewed: body.preop_labs_reviewed,
      preopLabsSummary: body.preop_labs_summary,
      bloodGlucoseMgDl: body.blood_glucose_mg_dl,
      bloodGlucoseCheckedAt: body.blood_glucose_checked_at,
      eyeDropsGiven: body.eye_drops_given,
      eyeDropsGivenAt: body.eye_drops_given_at,
      eyeDropsNotes: body.eye_drops_notes,
      antibioticProphylaxis: body.antibiotic_prophylaxis,
      antibioticGivenAt: body.antibiotic_given_at,
      patientIdentityVerified: body.patient_identity_verified,
      procedureVerified: body.procedure_verified,
      anesthesiaConsent: body.anesthesia_consent,
      specialEquipment: body.special_equipment,
      pendingItems: body.pending_items,
      aiReviewSummary: body.ai_review_summary,
      status: body.status,
      completedBy: body.completed_by || req.user?.uid || null,
      overrideReason: body.override_reason,
      metadata: body.metadata,
    });
    return success(res, row, 'Preop checklist saved');
  } catch (err) { return next(err); }
});

router.get('/preop', async (req, res, next) => {
  try {
    const result = await listPreopChecklists({
      tenantId: req.tenantId,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Preop checklists retrieved');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// intraop_notes
// ---------------------------------------------------------------------------

router.post('/intraop', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await createIntraopNote({
      tenantId: req.tenantId,
      otScheduleId: body.ot_schedule_id,
      patientUid: body.patient_uid,
      surgeon: body.surgeon || req.user?.uid || null,
      primaryAssistant: body.primary_assistant,
      scrubNurse: body.scrub_nurse,
      circulator: body.circulator,
      procedurePerformed: body.procedure_performed,
      procedureCodes: body.procedure_codes,
      incisionType: body.incision_type,
      position: body.position,
      findings: body.findings,
      technique: body.technique,
      specimens: body.specimens,
      estimatedBloodLossMl: body.estimated_blood_loss_ml,
      fluidsInput: body.fluids_input,
      fluidsOutput: body.fluids_output,
      complications: body.complications,
      spongeCountCorrect: body.sponge_count_correct,
      sharpCountCorrect: body.sharp_count_correct,
      instrumentCountCorrect: body.instrument_count_correct,
      countDiscrepancyNotes: body.count_discrepancy_notes,
      drainsPlaced: body.drains_placed,
      closureMethod: body.closure_method,
      startTime: body.start_time,
      endTime: body.end_time,
      status: body.status,
      aiAssistGenerationId: body.ai_assist_generation_id,
      metadata: body.metadata,
    });
    emitOrBoardEvent('note', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId });
    return success(res, row, 'Intraop note created', 201);
  } catch (err) { return next(err); }
});

router.get('/intraop', async (req, res, next) => {
  try {
    const result = await listIntraopNotes({
      tenantId: req.tenantId,
      otScheduleId: req.query.ot_schedule_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Intraop notes retrieved');
  } catch (err) { return next(err); }
});

router.patch('/intraop/:id/finalize', async (req, res, next) => {
  try {
    const row = await finalizeIntraopNote({
      tenantId: req.tenantId,
      id: req.params.id,
      finalizedBy: req.user?.uid || null,
    });
    return success(res, row, 'Intraop note finalized');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// postop_notes
// ---------------------------------------------------------------------------

router.post('/postop', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await createPostopNote({
      tenantId: req.tenantId,
      otScheduleId: body.ot_schedule_id,
      patientUid: body.patient_uid,
      authoredBy: body.authored_by || req.user?.uid || null,
      podNumber: body.pod_number,
      recoveryPhase: body.recovery_phase,
      vitals: body.vitals,
      painScore: body.pain_score,
      painManagementPlan: body.pain_management_plan,
      drainStatus: body.drain_status,
      woundStatus: body.wound_status,
      dietAdvancedTo: body.diet_advanced_to,
      ambulation: body.ambulation,
      bowelFunction: body.bowel_function,
      urineOutputMl: body.urine_output_ml,
      complicationsNoted: body.complications_noted,
      pendingOrders: body.pending_orders,
      followUpActions: body.follow_up_actions,
      disposition: body.disposition,
      handoverNotes: body.handover_notes ?? body.handover_text ?? body.recovery_handover ?? null,
      status: body.status,
      finalizedBy: body.finalized_by || req.user?.uid || null,
      aiAssistGenerationId: body.ai_assist_generation_id,
      metadata: body.metadata,
    });
    emitOrBoardEvent('note', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId });
    return success(res, row, 'Postop note created', 201);
  } catch (err) { return next(err); }
});

router.get('/postop', async (req, res, next) => {
  try {
    const result = await listPostopNotes({
      tenantId: req.tenantId,
      otScheduleId: req.query.ot_schedule_id || null,
      recoveryPhase: req.query.recovery_phase || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Postop notes retrieved');
  } catch (err) { return next(err); }
});

router.patch('/postop/:id/finalize', async (req, res, next) => {
  try {
    const row = await finalizePostopNote({
      tenantId: req.tenantId,
      id: req.params.id,
      finalizedBy: req.user?.uid || null,
    });
    return success(res, row, 'Postop note finalized');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// anesthesia_records
// ---------------------------------------------------------------------------

router.put('/anesthesia/:scheduleId', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await upsertAnesthesiaRecord({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
      patientUid: body.patient_uid,
      anesthetist: body.anesthetist || req.user?.uid || null,
      assistant: body.assistant,
      preopAssessmentComplete: body.preop_assessment_complete,
      asaGrade: body.asa_grade,
      airwayAssessment: body.airway_assessment,
      preopMedsHeld: body.preop_meds_held,
      technique: body.technique,
      airwayManaged: body.airway_managed,
      intubationGrade: body.intubation_grade,
      agentsUsed: body.agents_used,
      fluidsInMl: body.fluids_in_ml,
      bloodProductsIn: body.blood_products_in,
      urineOutputMl: body.urine_output_ml,
      bloodLossMl: body.blood_loss_ml,
      events: body.events,
      complications: body.complications,
      recoveryDestination: body.recovery_destination,
      painPlan: body.pain_plan,
      ponvProphylaxis: body.ponv_prophylaxis,
      status: body.status,
      finalizedBy: body.finalized_by || req.user?.uid || null,
      aiPrecheckGenerationId: body.ai_precheck_generation_id,
      metadata: body.metadata,
    });
    return success(res, row, 'Anesthesia record saved');
  } catch (err) { return next(err); }
});

router.patch('/anesthesia/:scheduleId/finalize', async (req, res, next) => {
  try {
    const row = await finalizeAnesthesiaRecord({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
      finalizedBy: req.user?.uid || null,
    });
    return success(res, row, 'Anesthesia record finalized');
  } catch (err) { return next(err); }
});

router.get('/anesthesia/:scheduleId', async (req, res, next) => {
  try {
    const row = await getAnesthesiaRecord({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
    });
    if (!row) return error(res, 'Anesthesia record not found', 404);
    return success(res, row, 'Anesthesia record retrieved');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// surgical_implants
// ---------------------------------------------------------------------------

router.post('/implants', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await recordImplant({
      tenantId: req.tenantId,
      otScheduleId: body.ot_schedule_id,
      patientUid: body.patient_uid,
      implantType: body.implant_type,
      manufacturer: body.manufacturer,
      brandName: body.brand_name,
      productName: body.product_name,
      referenceNumber: body.reference_number,
      lotNumber: body.lot_number,
      serialNumber: body.serial_number,
      udi: body.udi,
      gudidDi: body.gudid_di,
      size: body.size,
      side: body.side,
      expiryDate: body.expiry_date,
      sterilizationLot: body.sterilization_lot,
      implantedBy: body.implanted_by || req.user?.uid || null,
      implantedAt: body.implanted_at,
      status: body.status,
      recallReference: body.recall_reference,
      notes: body.notes,
      metadata: body.metadata,
    });
    return success(res, row, 'Implant recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/implants', async (req, res, next) => {
  try {
    const result = await listImplants({
      tenantId: req.tenantId,
      otScheduleId: req.query.ot_schedule_id || null,
      cathCaseId: req.query.cath_case_id || null,
      cathUsageId: req.query.cath_usage_id || null,
      patientUid: req.query.patient_uid || null,
      status: req.query.status || null,
      manufacturer: req.query.manufacturer || null,
      lotNumber: req.query.lot_number || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Implants retrieved');
  } catch (err) { return next(err); }
});

router.patch('/implants/:id/remove', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await recordImplantRemoval({
      tenantId: req.tenantId,
      id: req.params.id,
      removalDate: body.removal_date,
      removalReason: body.removal_reason,
    });
    return success(res, row, 'Implant removal recorded');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// surgical_safety_checklists (WHO 3-phase)
// ---------------------------------------------------------------------------

router.put('/safety/:scheduleId/:phase', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await upsertSafetyChecklistPhase({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
      patientUid: body.patient_uid,
      phase: req.params.phase,
      performedBy: body.performed_by || req.user?.uid || null,
      performedAt: body.performed_at,
      items: body.items,
      allItemsConfirmed: body.all_items_confirmed,
      outstandingItems: body.outstanding_items,
      status: body.status,
      overrideReason: body.override_reason,
      overrideAuthorizedBy: body.override_authorized_by,
      notes: body.notes,
      metadata: body.metadata,
    });
    emitOrBoardEvent('safety-phase', { scheduleId: Number(req.params.scheduleId), tenantId: req.tenantId });
    return success(res, row, 'Safety checklist phase saved');
  } catch (err) { return next(err); }
});

router.get('/safety/:scheduleId', async (req, res, next) => {
  try {
    const result = await listSafetyChecklist({
      tenantId: req.tenantId,
      otScheduleId: req.params.scheduleId,
    });
    return success(res, result, 'Safety checklist retrieved');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// postop_complication_alerts
// ---------------------------------------------------------------------------

router.post('/complications', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await recordComplicationAlert({
      tenantId: req.tenantId,
      otScheduleId: body.ot_schedule_id,
      patientUid: body.patient_uid,
      complicationType: body.complication_type,
      severity: body.severity,
      detectedAt: body.detected_at,
      detectedBy: body.detected_by || req.user?.uid || null,
      detectionSource: body.detection_source,
      description: body.description,
      clavienDindoGrade: body.clavien_dindo_grade,
      intervention: body.intervention,
      interventionAt: body.intervention_at,
      outcome: body.outcome,
      aiAlertGenerationId: body.ai_alert_generation_id,
      metadata: body.metadata,
    });
    emitOrBoardEvent('complication', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId });
    return success(res, row, 'Complication alert recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/complications', async (req, res, next) => {
  try {
    const result = await listComplicationAlerts({
      tenantId: req.tenantId,
      otScheduleId: req.query.ot_schedule_id || null,
      patientUid: req.query.patient_uid || null,
      status: req.query.status || null,
      severity: req.query.severity || null,
      complicationType: req.query.complication_type || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Complication alerts retrieved');
  } catch (err) { return next(err); }
});

router.patch('/complications/:id/acknowledge', async (req, res, next) => {
  try {
    const row = await acknowledgeComplicationAlert({
      tenantId: req.tenantId,
      id: req.params.id,
      acknowledgedBy: req.user?.uid || null,
    });
    return success(res, row, 'Complication alert acknowledged');
  } catch (err) { return next(err); }
});

router.patch('/complications/:id/resolve', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await resolveComplicationAlert({
      tenantId: req.tenantId,
      id: req.params.id,
      outcome: body.outcome,
      intervention: body.intervention,
      interventionAt: body.intervention_at,
      clavienDindoGrade: body.clavien_dindo_grade,
    });
    emitOrBoardEvent('complication-resolved', { scheduleId: row?.ot_schedule_id ?? null, tenantId: req.tenantId });
    return success(res, row, 'Complication alert resolved');
  } catch (err) { return next(err); }
});

export default router;
