/**
 * Admin routes for ED operational entities (Phase D4).
 * Mounted at /api/v1/admin/ed.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
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

const router = express.Router();

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
    return success(res, row, 'Emergency visit transitioned');
  } catch (err) { return next(err); }
});

router.patch('/visits/:id/triage-priority', async (req, res, next) => {
  try {
    const row = await setVisitTriagePriority({
      tenantId: req.tenantId, id: req.params.id,
      triagePriority: req.body?.triage_priority,
    });
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

export default router;
