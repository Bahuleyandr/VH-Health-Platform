/**
 * Admin routes for CarePlan / FollowUpPlan (Phase C3).
 *
 * Mounted at /api/v1/admin/care-plans + /api/v1/admin/follow-ups.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  appendReviewLog,
  createActivity,
  createCarePlan,
  createFollowUp,
  createGoal,
  getCarePlan,
  listActivities,
  listCarePlans,
  listFollowUps,
  listGoals,
  listReviewLog,
  recordActivityCompletion,
  setCarePlanVisibility,
  transitionCarePlan,
  transitionFollowUp,
  updateGoalProgress,
} from '../../services/carePlan/carePlanService.js';

const carePlansRouter = express.Router();
const followUpsRouter = express.Router();

// Care plans
carePlansRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createCarePlan({
      tenantId: req.tenantId,
      patientUid: b.patient_uid,
      planKind: b.plan_kind,
      primaryCondition: b.primary_condition,
      primaryConditionIcd10: b.primary_condition_icd10,
      displayName: b.display_name,
      description: b.description,
      status: b.status,
      startDate: b.start_date,
      targetEndDate: b.target_end_date,
      primaryDoctorUid: b.primary_doctor_uid,
      careTeamRole: b.care_team_role,
      encounterId: b.encounter_id,
      facilityId: b.facility_id,
      isPatientVisible: b.is_patient_visible,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Care plan created', 201);
  } catch (err) { return next(err); }
});

carePlansRouter.get('/', async (req, res, next) => {
  try {
    const result = await listCarePlans({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      status: req.query.status || null,
      planKind: req.query.plan_kind || null,
      doctorUid: req.query.doctor_uid || null,
      isPatientVisible: req.query.is_patient_visible != null ? req.query.is_patient_visible === 'true' : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Care plans retrieved');
  } catch (err) { return next(err); }
});

carePlansRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getCarePlan({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Care plan retrieved');
  } catch (err) { return next(err); }
});

carePlansRouter.patch('/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionCarePlan({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: req.body?.next_status,
      reviewerUid: req.user?.uid || null,
      notes: req.body?.notes,
    });
    return success(res, row, 'Care plan transitioned');
  } catch (err) { return next(err); }
});

carePlansRouter.patch('/:id/visibility', async (req, res, next) => {
  try {
    const row = await setCarePlanVisibility({
      tenantId: req.tenantId,
      id: req.params.id,
      isPatientVisible: req.body?.is_patient_visible,
      reviewerUid: req.user?.uid || null,
    });
    return success(res, row, 'Care plan visibility updated');
  } catch (err) { return next(err); }
});

// Goals
carePlansRouter.post('/:id/goals', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createGoal({
      tenantId: req.tenantId,
      carePlanId: req.params.id,
      patientUid: b.patient_uid,
      goalKind: b.goal_kind,
      description: b.description,
      measurementLabel: b.measurement_label,
      measurementUnit: b.measurement_unit,
      baselineValue: b.baseline_value,
      targetValue: b.target_value,
      currentValue: b.current_value,
      targetDueDate: b.target_due_date,
      priority: b.priority,
      metadata: b.metadata,
    });
    return success(res, row, 'Goal added', 201);
  } catch (err) { return next(err); }
});

carePlansRouter.get('/:id/goals', async (req, res, next) => {
  try {
    const result = await listGoals({
      tenantId: req.tenantId,
      carePlanId: req.params.id,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Goals retrieved');
  } catch (err) { return next(err); }
});

carePlansRouter.patch('/goals/:goalId/progress', async (req, res, next) => {
  try {
    const row = await updateGoalProgress({
      tenantId: req.tenantId,
      id: req.params.goalId,
      currentValue: req.body?.current_value,
      status: req.body?.status,
      achievedAt: req.body?.achieved_at,
    });
    return success(res, row, 'Goal progress updated');
  } catch (err) { return next(err); }
});

// Activities
carePlansRouter.post('/:id/activities', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createActivity({
      tenantId: req.tenantId,
      carePlanId: req.params.id,
      relatedGoalId: b.related_goal_id,
      patientUid: b.patient_uid,
      activityKind: b.activity_kind,
      title: b.title,
      description: b.description,
      scheduleKind: b.schedule_kind,
      schedulePayload: b.schedule_payload,
      scheduledStart: b.scheduled_start,
      scheduledEnd: b.scheduled_end,
      nextDueAt: b.next_due_at,
      assignedToUid: b.assigned_to_uid,
      assignedToRole: b.assigned_to_role,
      expectedCount: b.expected_count,
      isPatientFacing: b.is_patient_facing,
      taskId: b.task_id,
      metadata: b.metadata,
    });
    return success(res, row, 'Activity added', 201);
  } catch (err) { return next(err); }
});

carePlansRouter.get('/:id/activities', async (req, res, next) => {
  try {
    const result = await listActivities({
      tenantId: req.tenantId,
      carePlanId: req.params.id,
      status: req.query.status || null,
      patientUid: req.query.patient_uid || null,
      dueWithinHours: req.query.due_within_hours || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Activities retrieved');
  } catch (err) { return next(err); }
});

carePlansRouter.patch('/activities/:activityId/complete', async (req, res, next) => {
  try {
    const row = await recordActivityCompletion({
      tenantId: req.tenantId,
      id: req.params.activityId,
      status: req.body?.status,
      incrementCount: req.body?.increment_count,
    });
    return success(res, row, 'Activity completion recorded');
  } catch (err) { return next(err); }
});

// Review log
carePlansRouter.post('/:id/review-log', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await appendReviewLog({
      tenantId: req.tenantId,
      carePlanId: req.params.id,
      reviewerUid: req.user?.uid || null,
      reviewerRole: b.reviewer_role,
      eventKind: b.event_kind,
      notes: b.notes,
      payload: b.payload,
    });
    return success(res, row, 'Review entry added', 201);
  } catch (err) { return next(err); }
});

carePlansRouter.get('/:id/review-log', async (req, res, next) => {
  try {
    const result = await listReviewLog({
      tenantId: req.tenantId,
      carePlanId: req.params.id,
      limit: req.query.limit,
    });
    return success(res, result, 'Review log retrieved');
  } catch (err) { return next(err); }
});

// Follow-ups
followUpsRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createFollowUp({
      tenantId: req.tenantId,
      patientUid: b.patient_uid,
      originKind: b.origin_kind,
      originResourceType: b.origin_resource_type,
      originResourceId: b.origin_resource_id,
      encounterId: b.encounter_id,
      doctorUid: b.doctor_uid,
      facilityId: b.facility_id,
      carePlanId: b.care_plan_id,
      dueAt: b.due_at,
      reason: b.reason,
      reminderOffsetsMinutes: b.reminder_offsets_minutes,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
      bookAppointment: b.book_appointment,
    });
    return success(res, row, 'Follow-up plan created', 201);
  } catch (err) { return next(err); }
});

followUpsRouter.get('/', async (req, res, next) => {
  try {
    const result = await listFollowUps({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      status: req.query.status || null,
      originKind: req.query.origin_kind || null,
      doctorUid: req.query.doctor_uid || null,
      overdueOnly: String(req.query.overdue_only || '').toLowerCase() === 'true',
      limit: req.query.limit,
    });
    return success(res, result, 'Follow-ups retrieved');
  } catch (err) { return next(err); }
});

followUpsRouter.patch('/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionFollowUp({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: req.body?.next_status,
      closureOutcome: req.body?.closure_outcome,
      appointmentId: req.body?.appointment_id,
    });
    return success(res, row, 'Follow-up transitioned');
  } catch (err) { return next(err); }
});

export { carePlansRouter, followUpsRouter };
export default carePlansRouter;
