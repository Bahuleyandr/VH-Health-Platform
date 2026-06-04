/**
 * Admin governance routes for canonical care teams, patient-access audit,
 * lab specimens, analyzers, and QC. Mounted under /api/v1/admin, so the
 * parent Admin/SuperAdmin RBAC gate applies before this router runs.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  addCareTeamMember,
  createCareTeam,
  createLabSpecimen,
  endPatientBreakGlass,
  listCareTeamMembers,
  listCareTeams,
  listLabAnalyzers,
  listLabQcRuns,
  listLabSpecimens,
  listPatientAccessAudit,
  recordLabQcRun,
  startPatientBreakGlass,
  transitionCareTeam,
  transitionCareTeamMember,
  transitionLabSpecimen,
  upsertLabAnalyzer,
} from '../../services/governance/clinicalGovernanceService.js';

const router = express.Router();

function actorUid(req) {
  return req.user?.uid || req.user?.firebaseUid || null;
}

router.get('/care-teams', async (req, res, next) => {
  try {
    const result = await listCareTeams({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      admissionId: req.query.admission_id || null,
      appointmentId: req.query.appointment_id || null,
      status: req.query.status || null,
      take: req.query.limit,
    });
    return success(res, result, 'Care teams retrieved');
  } catch (err) { return next(err); }
});

router.post('/care-teams', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createCareTeam({
      tenantId: req.tenantId,
      patientUid: b.patient_uid,
      admissionId: b.admission_id,
      appointmentId: b.appointment_id,
      teamKind: b.team_kind,
      displayName: b.display_name,
      primaryDepartment: b.primary_department,
      status: b.status,
      statusReason: b.status_reason,
      metadata: b.metadata,
      createdBy: actorUid(req),
    });
    return success(res, row, 'Care team created', 201);
  } catch (err) { return next(err); }
});

router.patch('/care-teams/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionCareTeam({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: req.body?.next_status,
      reason: req.body?.reason,
      changedBy: actorUid(req),
      metadata: req.body?.metadata,
    });
    return success(res, row, 'Care team transitioned');
  } catch (err) { return next(err); }
});

router.get('/care-teams/:id/members', async (req, res, next) => {
  try {
    const result = await listCareTeamMembers({
      tenantId: req.tenantId,
      careTeamId: req.params.id,
      status: req.query.status || null,
      take: req.query.limit,
    });
    return success(res, result, 'Care-team members retrieved');
  } catch (err) { return next(err); }
});

router.post('/care-teams/:id/members', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await addCareTeamMember({
      tenantId: req.tenantId,
      careTeamId: req.params.id,
      staffUid: b.staff_uid,
      staffId: b.staff_id,
      staffRole: b.staff_role,
      memberName: b.member_name,
      relationshipKind: b.relationship_kind,
      accessScope: b.access_scope,
      breakGlassAllowed: b.break_glass_allowed,
      activeFrom: b.active_from,
      activeUntil: b.active_until,
      status: b.status,
      notes: b.notes,
      metadata: b.metadata,
      createdBy: actorUid(req),
    });
    return success(res, row, 'Care-team member added', 201);
  } catch (err) { return next(err); }
});

router.patch('/care-teams/:id/members/:memberId/transition', async (req, res, next) => {
  try {
    const row = await transitionCareTeamMember({
      tenantId: req.tenantId,
      careTeamId: req.params.id,
      memberId: req.params.memberId,
      nextStatus: req.body?.next_status,
      reason: req.body?.reason,
      changedBy: actorUid(req),
      metadata: req.body?.metadata,
    });
    return success(res, row, 'Care-team member transitioned');
  } catch (err) { return next(err); }
});

router.post('/patient-access/break-glass', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await startPatientBreakGlass({
      tenantId: req.tenantId,
      patientUid: b.patient_uid,
      actorUid: b.actor_uid || actorUid(req),
      actorRole: b.actor_role || req.user?.role || null,
      reason: b.reason,
      expiresAt: b.expires_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Break-glass session started', 201);
  } catch (err) { return next(err); }
});

router.patch('/patient-access/break-glass/:id/end', async (req, res, next) => {
  try {
    const row = await endPatientBreakGlass({
      tenantId: req.tenantId,
      id: req.params.id,
      endedBy: actorUid(req),
      status: req.body?.status || 'ended',
    });
    return success(res, row, 'Break-glass session ended');
  } catch (err) { return next(err); }
});

router.get('/patient-access/audit', async (req, res, next) => {
  try {
    const result = await listPatientAccessAudit({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      actorUid: req.query.actor_uid || null,
      decision: req.query.decision || null,
      source: req.query.source || null,
      action: req.query.action || null,
      recordType: req.query.record_type || null,
      resourceType: req.query.resource_type || null,
      route: req.query.route || null,
      dateFrom: req.query.date_from || null,
      dateTo: req.query.date_to || null,
      take: req.query.limit,
    });
    return success(res, result, 'Patient access audit retrieved');
  } catch (err) { return next(err); }
});

router.get('/lab/specimens', async (req, res, next) => {
  try {
    const result = await listLabSpecimens({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      bookingId: req.query.booking_id || null,
      status: req.query.status || null,
      take: req.query.limit,
    });
    return success(res, result, 'Lab specimens retrieved');
  } catch (err) { return next(err); }
});

router.post('/lab/specimens', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createLabSpecimen({
      tenantId: req.tenantId,
      patientUid: b.patient_uid,
      bookingId: b.booking_id,
      accessionNumber: b.accession_number,
      specimenType: b.specimen_type,
      containerType: b.container_type,
      collectionSite: b.collection_site,
      priority: b.priority,
      status: b.status,
      statusReason: b.status_reason,
      collectedAt: b.collected_at,
      collectedBy: b.collected_by || actorUid(req),
      metadata: b.metadata,
      createdBy: actorUid(req),
    });
    return success(res, row, 'Lab specimen created', 201);
  } catch (err) { return next(err); }
});

router.patch('/lab/specimens/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionLabSpecimen({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: req.body?.next_status,
      reason: req.body?.reason,
      changedBy: actorUid(req),
      metadata: req.body?.metadata,
    });
    return success(res, row, 'Lab specimen transitioned');
  } catch (err) { return next(err); }
});

router.get('/lab/analyzers', async (req, res, next) => {
  try {
    const result = await listLabAnalyzers({
      tenantId: req.tenantId,
      status: req.query.status || null,
      facilityId: req.query.facility_id || null,
      take: req.query.limit,
    });
    return success(res, result, 'Lab analyzers retrieved');
  } catch (err) { return next(err); }
});

router.put('/lab/analyzers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertLabAnalyzer({
      tenantId: req.tenantId,
      id: b.id,
      facilityId: b.facility_id,
      locationId: b.location_id,
      analyzerCode: b.analyzer_code,
      displayName: b.display_name,
      manufacturer: b.manufacturer,
      model: b.model,
      serialNumber: b.serial_number,
      interfaceKind: b.interface_kind,
      status: b.status,
      metadata: b.metadata,
      updatedBy: actorUid(req),
    });
    return success(res, row, 'Lab analyzer saved');
  } catch (err) { return next(err); }
});

router.get('/lab/analyzers/:id/qc-runs', async (req, res, next) => {
  try {
    const result = await listLabQcRuns({
      tenantId: req.tenantId,
      analyzerId: req.params.id,
      resultStatus: req.query.result_status || null,
      take: req.query.limit,
    });
    return success(res, result, 'Lab QC runs retrieved');
  } catch (err) { return next(err); }
});

router.post('/lab/analyzers/:id/qc-runs', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordLabQcRun({
      tenantId: req.tenantId,
      analyzerId: req.params.id,
      qcLevel: b.qc_level,
      qcLotNumber: b.qc_lot_number,
      resultStatus: b.result_status,
      measuredValues: b.measured_values,
      performedAt: b.performed_at,
      performedBy: b.performed_by || actorUid(req),
      reviewedAt: b.reviewed_at,
      reviewedBy: b.reviewed_by,
      notes: b.notes,
      rawPayload: b.raw_payload,
      metadata: b.metadata,
    });
    return success(res, row, 'Lab QC run recorded', 201);
  } catch (err) { return next(err); }
});

export default router;
