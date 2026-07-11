/**
 * Admin routes for ED operational entities (Phase D4).
 * Mounted at /api/v1/admin/ed.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { emitEdBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
import {
  acceptPrehospitalHandover,
  appendPrehospitalTimelineEvent,
  createPrehospitalHandover,
  getPrehospitalHandover,
  linkPrehospitalDevice,
  listPrehospitalHandovers,
  recordPartnerSuppliedPayload,
} from '../../services/ed/ambulancePrehospitalService.js';
import {
  certifyMlcRecord,
  createAmbulanceRequest,
  createEmergencyVisit,
  createMlcRecord,
  listAmbulanceRequests,
  listEmergencyVisits,
  listMlcRecords,
  listTriageAssessments,
  recordPoliceReport,
  recordTriageAssessment,
  setVisitTriagePriority,
  transitionAmbulanceRequest,
  transitionEmergencyVisit,
} from '../../services/ed/edOperationsService.js';
import {
  addTraumaTimelineEvent,
  createTraumaActivation,
  getTenantEdPolicy,
  linkEdEncounterEvidence,
  listTraumaActivations,
  recordTraumaSurvey,
  upsertMlcCompletenessReview,
  upsertTenantEdPolicy,
} from '../../services/ed/edTraumaMlcService.js';

const router = express.Router();

// Tenant ED policy
router.get('/policy', async (req, res, next) => {
  try {
    const row = await getTenantEdPolicy({ tenantId: req.tenantId });
    return success(res, row, 'Tenant ED policy retrieved');
  } catch (err) { return next(err); }
});

router.put('/policy', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertTenantEdPolicy({
      tenantId: req.tenantId,
      canonicalTriageScale: b.canonical_triage_scale,
      active: b.active,
      alternativeScaleMappings: b.alternative_scale_mappings,
      traumaRegistryParticipation: b.trauma_registry_participation,
      registryExportEnabled: b.registry_export_enabled,
      evidenceOwnerUid: b.evidence_owner_uid,
      clinicalGovernanceOwnerUid: b.clinical_governance_owner_uid,
      reviewerUid: b.reviewer_uid || req.user?.uid || null,
      reviewedAt: b.reviewed_at,
      activatedBy: b.activated_by || req.user?.uid || null,
      activatedAt: b.activated_at,
      policyVersion: b.policy_version,
      sourceMetadata: b.source_metadata,
    });
    return success(res, row, 'Tenant ED policy saved');
  } catch (err) { return next(err); }
});

// Emergency visits
router.post('/visits', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createEmergencyVisit({
      tenantId: req.tenantId, facilityId: b.facility_id,
      visitNumber: b.visit_number, patientUid: b.patient_uid,
      arrivalAt: b.arrival_at, arrivalMode: b.arrival_mode,
      ambulanceRequestId: b.ambulance_request_id,
      chiefComplaint: b.chief_complaint,
      attendingDoctorUid: b.attending_doctor_uid,
      isMlc: b.is_mlc, metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    emitEdBoardEvent('arrival', row, { tenantId: req.tenantId });
    return success(res, row, 'Emergency visit created', 201);
  } catch (err) { return next(err); }
});

router.get('/visits', async (req, res, next) => {
  try {
    const result = await listEmergencyVisits({
      tenantId: req.tenantId,
      status: req.query.status || null,
      openOnly: String(req.query.open_only || '').toLowerCase() === 'true',
      triagePriority: req.query.triage_priority || null,
      isMlc: req.query.is_mlc != null ? req.query.is_mlc === 'true' : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Emergency visits retrieved');
  } catch (err) { return next(err); }
});

router.patch('/visits/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionEmergencyVisit({
      tenantId: req.tenantId, id: req.params.id,
      nextStatus: req.body?.next_status,
      disposition: req.body?.disposition,
    });
    emitEdBoardEvent('transition', row, { tenantId: req.tenantId });
    return success(res, row, 'Emergency visit transitioned');
  } catch (err) { return next(err); }
});

router.patch('/visits/:id/triage-priority', async (req, res, next) => {
  try {
    const row = await setVisitTriagePriority({
      tenantId: req.tenantId, id: req.params.id,
      triagePriority: req.body?.triage_priority,
    });
    emitEdBoardEvent('priority', row, { tenantId: req.tenantId });
    return success(res, row, 'Triage priority set');
  } catch (err) { return next(err); }
});

// Triage assessments
router.post('/triage-assessments', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordTriageAssessment({
      tenantId: req.tenantId,
      emergencyVisitId: b.emergency_visit_id, patientUid: b.patient_uid,
      assessmentKind: b.assessment_kind,
      assessedAt: b.assessed_at,
      assessedByUid: b.assessed_by_uid || req.user?.uid || null,
      level: b.level, presentingComplaint: b.presenting_complaint,
      vitals: b.vitals, painScore: b.pain_score,
      airwayConcern: b.airway_concern,
      breathingConcern: b.breathing_concern,
      circulationConcern: b.circulation_concern,
      redFlags: b.red_flags,
      aiPredictedLevel: b.ai_predicted_level,
      aiPredictionId: b.ai_prediction_id,
      reassessmentDueAt: b.reassessment_due_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Triage assessment recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/triage-assessments', async (req, res, next) => {
  try {
    const result = await listTriageAssessments({
      tenantId: req.tenantId,
      emergencyVisitId: req.query.emergency_visit_id || null,
      assessmentKind: req.query.assessment_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Triage assessments retrieved');
  } catch (err) { return next(err); }
});

// Trauma activation / surveys / timeline
router.post('/trauma-activations', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createTraumaActivation({
      tenantId: req.tenantId,
      activationNumber: b.activation_number,
      emergencyVisitId: b.emergency_visit_id,
      admissionId: b.admission_id,
      patientUid: b.patient_uid,
      activationReason: b.activation_reason,
      activationLevel: b.activation_level,
      activatedAt: b.activated_at,
      activatedByUid: b.activated_by_uid || req.user?.uid || null,
      teamLeaderUid: b.team_leader_uid,
      expectedArrivalAt: b.expected_arrival_at,
      patientArrivedAt: b.patient_arrived_at,
      bloodBankAlertedAt: b.blood_bank_alerted_at,
      bloodBankAlertedByUid: b.blood_bank_alerted_by_uid || req.user?.uid || null,
      radiologyAlertedAt: b.radiology_alerted_at,
      radiologyAlertedByUid: b.radiology_alerted_by_uid || req.user?.uid || null,
      otAlertedAt: b.ot_alerted_at,
      otAlertedByUid: b.ot_alerted_by_uid || req.user?.uid || null,
      registryParticipation: b.registry_participation,
      registryReviewerUid: b.registry_reviewer_uid,
      registryReviewedAt: b.registry_reviewed_at,
      registryExportStatus: b.registry_export_status,
      teamRoles: b.team_roles,
      sourceMetadata: b.source_metadata,
    });
    return success(res, row, 'Trauma activation created', 201);
  } catch (err) { return next(err); }
});

router.get('/trauma-activations', async (req, res, next) => {
  try {
    const result = await listTraumaActivations({
      tenantId: req.tenantId,
      status: req.query.status || null,
      emergencyVisitId: req.query.emergency_visit_id || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Trauma activations retrieved');
  } catch (err) { return next(err); }
});

router.post('/trauma-surveys', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordTraumaSurvey({
      tenantId: req.tenantId,
      traumaActivationId: b.trauma_activation_id,
      emergencyVisitId: b.emergency_visit_id,
      patientUid: b.patient_uid,
      surveyKind: b.survey_kind,
      assessedAt: b.assessed_at,
      assessedByUid: b.assessed_by_uid || req.user?.uid || null,
      responsibleClinicianUid: b.responsible_clinician_uid || req.user?.uid || null,
      airway: b.airway,
      breathing: b.breathing,
      circulation: b.circulation,
      disability: b.disability,
      exposure: b.exposure,
      fastImaging: b.fast_imaging,
      interventions: b.interventions,
      reassessmentDueAt: b.reassessment_due_at,
      sourceCitations: b.source_citations,
      completionStatus: b.completion_status,
    });
    return success(res, row, 'Trauma survey recorded', 201);
  } catch (err) { return next(err); }
});

router.post('/trauma-timeline', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await addTraumaTimelineEvent({
      tenantId: req.tenantId,
      traumaActivationId: b.trauma_activation_id,
      emergencyVisitId: b.emergency_visit_id,
      patientUid: b.patient_uid,
      occurredAt: b.occurred_at,
      eventType: b.event_type,
      eventLabel: b.event_label,
      interventionDetails: b.intervention_details,
      performedByUid: b.performed_by_uid || req.user?.uid || null,
      sourceCitations: b.source_citations,
      createdByUid: req.user?.uid || null,
    });
    return success(res, row, 'Trauma timeline event appended', 201);
  } catch (err) { return next(err); }
});

router.post('/encounter-evidence', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await linkEdEncounterEvidence({
      tenantId: req.tenantId,
      emergencyVisitId: b.emergency_visit_id,
      patientUid: b.patient_uid,
      evidenceKind: b.evidence_kind,
      vitalsChartId: b.vitals_chart_id,
      deviceVitalSampleObservationId: b.device_vital_sample_observation_id,
      deviceRegistryId: b.device_registry_id,
      observedAt: b.observed_at,
      verified: b.verified,
      linkedByUid: b.linked_by_uid || req.user?.uid || null,
      notes: b.notes,
      metadata: b.metadata,
    });
    return success(res, row, 'ED encounter evidence linked', 201);
  } catch (err) { return next(err); }
});

// Ambulance requests
router.post('/ambulance-requests', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createAmbulanceRequest({
      tenantId: req.tenantId, facilityId: b.facility_id,
      requestNumber: b.request_number, requestKind: b.request_kind,
      priority: b.priority,
      callerName: b.caller_name, callerPhone: b.caller_phone,
      patientUid: b.patient_uid, patientName: b.patient_name,
      pickupAddress: b.pickup_address,
      pickupGeoLat: b.pickup_geo_lat, pickupGeoLng: b.pickup_geo_lng,
      destination: b.destination,
      destinationFacilityId: b.destination_facility_id,
      presentingComplaint: b.presenting_complaint,
      metadata: b.metadata, createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Ambulance request created', 201);
  } catch (err) { return next(err); }
});

router.get('/ambulance-requests', async (req, res, next) => {
  try {
    const result = await listAmbulanceRequests({
      tenantId: req.tenantId,
      status: req.query.status || null,
      openOnly: String(req.query.open_only || '').toLowerCase() === 'true',
      priority: req.query.priority || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Ambulance requests retrieved');
  } catch (err) { return next(err); }
});

router.patch('/ambulance-requests/:id/transition', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await transitionAmbulanceRequest({
      tenantId: req.tenantId, id: req.params.id,
      nextStatus: b.next_status,
      cancelledReason: b.cancelled_reason,
      ambulanceUnitId: b.ambulance_unit_id,
      driverName: b.driver_name,
      attendantName: b.attendant_name,
    });
    return success(res, row, 'Ambulance request transitioned');
  } catch (err) { return next(err); }
});

// Pre-hospital handover seam (NL-14 P2/P3). The parent /api/v1/ed mount
// supplies ED clinical RBAC + PHI logging; this guard adds patient-context ABAC
// when the handover request carries a patient_uid.
router.use('/prehospital', patientAccessGuard('PREHOSPITAL_HANDOVER', { careTeamModeGoverned: true }));

router.post('/prehospital/handovers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createPrehospitalHandover({
      tenantId: req.tenantId,
      ambulanceRequestId: b.ambulance_request_id,
      emergencyVisitId: b.emergency_visit_id,
      createEmergencyVisit: b.create_ed_visit,
      handoverNumber: b.handover_number,
      patientUid: b.patient_uid,
      pickupContext: b.pickup_context,
      sceneObservations: b.scene_observations,
      allergiesReported: b.allergies_reported,
      medicationsReported: b.medications_reported,
      etaFirstAt: b.eta_first_at,
      etaLatestAt: b.eta_latest_at,
      etaChangeReason: b.eta_change_reason,
      presentingComplaint: b.presenting_complaint,
      sbar: b.sbar,
      partnerConfigId: b.partner_config_id,
      status: b.status,
      manualEntry: b.manual_entry,
      sourceType: b.source_type,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
      actorRole: req.user?.role || req.user?.roles?.[0] || null,
    });
    return success(res, row, 'Pre-hospital handover created', 201);
  } catch (err) { return next(err); }
});

router.get('/prehospital/handovers', async (req, res, next) => {
  try {
    const result = await listPrehospitalHandovers({
      tenantId: req.tenantId,
      status: req.query.status || null,
      openOnly: String(req.query.open_only || '').toLowerCase() === 'true',
      ambulanceRequestId: req.query.ambulance_request_id || null,
      emergencyVisitId: req.query.emergency_visit_id || null,
      patientUid: req.query.patient_uid || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Pre-hospital handovers retrieved');
  } catch (err) { return next(err); }
});

router.post('/prehospital/handovers/:id/timeline', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await appendPrehospitalTimelineEvent({
      tenantId: req.tenantId,
      handoverId: req.params.id,
      eventType: b.event_type,
      eventAt: b.event_at,
      recordedBy: req.user?.uid || null, // Sol Ultra ambulance-H2: recorder is the authenticated actor, not a body value
      sourceType: b.source_type,
      summary: b.summary,
      observation: b.observation,
      intervention: b.intervention,
      vitalSigns: b.vital_signs,
      externalReference: b.external_reference,
      metadata: b.metadata,
      actorRole: req.user?.role || req.user?.roles?.[0] || null,
    });
    return success(res, row, 'Pre-hospital timeline event recorded', 201);
  } catch (err) { return next(err); }
});

router.post('/prehospital/handovers/:id/acceptances', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await acceptPrehospitalHandover({
      tenantId: req.tenantId,
      handoverId: req.params.id,
      // Sol Ultra ambulance-H2: the receiving-clinician acceptance signature is
      // the authenticated actor's — not a caller-supplied accepted_by uid/role.
      acceptedByUid: req.user?.uid || null,
      acceptedByRole: req.user?.role || req.user?.roles?.[0] || null,
      acceptanceRole: b.acceptance_role,
      signatureMethod: b.signature_method,
      signatureText: b.signature_text,
      handoverSignedAt: b.handover_signed_at,
      clinicalAttestation: b.clinical_attestation,
      metadata: b.metadata,
    });
    return success(res, row, 'Pre-hospital handover accepted', 201);
  } catch (err) { return next(err); }
});

router.post('/prehospital/handovers/:id/device-links', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await linkPrehospitalDevice({
      tenantId: req.tenantId,
      handoverId: req.params.id,
      devicePatientAssociationId: b.device_patient_association_id,
      deviceRegistryId: b.device_registry_id,
      linkStatus: b.link_status,
      verificationStatus: b.verification_status,
      sourceSystem: b.source_system,
      verifiedByUid: req.user?.uid || null, // Sol Ultra ambulance-H2: device-link verifier is the authenticated actor
      verifiedAt: b.verified_at,
      notes: b.notes,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
      actorRole: req.user?.role || req.user?.roles?.[0] || null,
    });
    return success(res, row, 'Pre-hospital device link recorded', 201);
  } catch (err) { return next(err); }
});

router.post('/prehospital/partner-payloads', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordPartnerSuppliedPayload({
      tenantId: req.tenantId,
      handoverId: b.handover_id,
      deviceLinkId: b.device_link_id,
      payload: b.payload,
      receivedBy: req.user?.uid || null,
      actorRole: req.user?.role || req.user?.roles?.[0] || null,
    });
    return success(res, row, 'Partner pre-hospital payload recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/prehospital/handovers/:id', async (req, res, next) => {
  try {
    const result = await getPrehospitalHandover({
      tenantId: req.tenantId,
      handoverId: req.params.id,
    });
    return success(res, result, 'Pre-hospital handover retrieved');
  } catch (err) { return next(err); }
});

// MLC records
router.post('/mlc-records', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createMlcRecord({
      tenantId: req.tenantId,
      emergencyVisitId: b.emergency_visit_id, patientUid: b.patient_uid,
      mlcNumber: b.mlc_number, mlcKind: b.mlc_kind,
      broughtByRelation: b.brought_by_relation,
      broughtByName: b.brought_by_name,
      broughtByPhone: b.brought_by_phone,
      incidentAt: b.incident_at, incidentAddress: b.incident_address,
      historySummary: b.history_summary,
      examinationSummary: b.examination_summary,
      injuries: b.injuries,
      consentForExamination: b.consent_for_examination,
      consentForDisclosure: b.consent_for_disclosure,
      metadata: b.metadata, createdBy: req.user?.uid || null,
    });
    return success(res, row, 'MLC record created', 201);
  } catch (err) { return next(err); }
});

router.get('/mlc-records', async (req, res, next) => {
  try {
    const result = await listMlcRecords({
      tenantId: req.tenantId,
      status: req.query.status || null,
      mlcKind: req.query.mlc_kind || null,
      unreportedOnly: String(req.query.unreported_only || '').toLowerCase() === 'true',
      limit: req.query.limit,
    });
    return success(res, result, 'MLC records retrieved');
  } catch (err) { return next(err); }
});

router.patch('/mlc-records/:id/police-report', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordPoliceReport({
      tenantId: req.tenantId, id: req.params.id,
      reportedAt: b.reported_at,
      policeStation: b.police_station,
      policeReportNumber: b.police_report_number,
      ipcSections: b.ipc_sections,
    });
    return success(res, row, 'Police report recorded');
  } catch (err) { return next(err); }
});

router.patch('/mlc-records/:id/certify', async (req, res, next) => {
  try {
    const row = await certifyMlcRecord({
      tenantId: req.tenantId, id: req.params.id,
      certifiedByUid: req.user?.uid || req.body?.certified_by_uid,
    });
    return success(res, row, 'MLC record certified');
  } catch (err) { return next(err); }
});

router.put('/mlc-records/:id/completeness', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertMlcCompletenessReview({
      tenantId: req.tenantId,
      mlcRecordId: req.params.id,
      emergencyVisitId: b.emergency_visit_id,
      patientUid: b.patient_uid,
      allegedHistory: b.alleged_history,
      injuryDescription: b.injury_description,
      injuryDiagramComplete: b.injury_diagram_complete,
      policeNotificationComplete: b.police_notification_complete,
      certificateSignerUid: b.certificate_signer_uid,
      chainOfCustodyComplete: b.chain_of_custody_complete,
      closureRequirements: b.closure_requirements,
      assistantPrefillOutputId: b.assistant_prefill_output_id,
      assistantPrefillMetadata: b.assistant_prefill_metadata,
      reviewedByUid: b.reviewed_by_uid || req.user?.uid || null,
      reviewedAt: b.reviewed_at,
      completenessStatus: b.completeness_status,
    });
    return success(res, row, 'MLC completeness reviewed');
  } catch (err) { return next(err); }
});

export default router;
