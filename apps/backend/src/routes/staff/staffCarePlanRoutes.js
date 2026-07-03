import express from 'express';

import { CLINICAL_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import {
  patientAccessGuard,
  patientAccessGuardForResource,
  phiAccessLogger,
} from '../../middleware/phiAccessMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  createActivity,
  createCarePlan,
  createGoal,
  getCarePlanBundle,
  listActivities,
  listCarePlanBundlesForPatient,
  listGoals,
  recordActivityCompletion,
  setCarePlanVisibility,
  transitionCarePlan,
  updateGoalProgress,
} from '../../services/carePlan/carePlanService.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

const carePlanRead = patientAccessGuard('CARE_PLAN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  careTeamModeGoverned: true,
  requirePatientContext: true,
});

const carePlanWrite = patientAccessGuard('CARE_PLAN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  careTeamModeGoverned: true,
  requirePatientContext: true,
});

const carePlanResourceRead = patientAccessGuardForResource('CARE_PLAN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'care_plan',
  careTeamModeGoverned: true,
});

const carePlanResourceWrite = patientAccessGuardForResource('CARE_PLAN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'care_plan',
  careTeamModeGoverned: true,
});

const goalResourceWrite = patientAccessGuardForResource('CARE_PLAN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'care_plan_goal',
  idParam: 'goalId',
  careTeamModeGoverned: true,
});

const activityResourceWrite = patientAccessGuardForResource('CARE_PLAN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'care_plan_activity',
  idParam: 'activityId',
  careTeamModeGoverned: true,
});

router.use(requireRole(...CLINICAL_STAFF_ROUTE_ROLES));

router.get(
  '/patients/:patientUid/care-plans',
  carePlanRead,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const result = await listCarePlanBundlesForPatient({
        tenantId: req.tenantId,
        patientUid: req.params.patientUid,
        status: req.query.status || null,
        limit: req.query.limit,
      });
      return success(res, result, 'Patient care plans retrieved');
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/patients/:patientUid/care-plans',
  carePlanWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const row = await createCarePlan({
        tenantId: req.tenantId,
        patientUid: req.params.patientUid,
        planKind: b.plan_kind,
        primaryCondition: b.primary_condition,
        primaryConditionIcd10: b.primary_condition_icd10,
        displayName: b.display_name,
        description: b.description,
        status: b.status,
        startDate: b.start_date,
        targetEndDate: b.target_end_date,
        primaryDoctorUid: b.primary_doctor_uid || req.user?.uid || null,
        careTeamRole: b.care_team_role,
        encounterId: b.encounter_id,
        facilityId: b.facility_id,
        isPatientVisible: b.is_patient_visible,
        metadata: b.metadata,
        createdBy: req.user?.uid || null,
      });
      return success(res, row, 'Care plan created', 201);
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/care-plans/:id',
  carePlanResourceRead,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const result = await getCarePlanBundle({
        tenantId: req.tenantId,
        id: req.params.id,
      });
      return success(res, result, 'Care plan retrieved');
    } catch (err) {
      return next(err);
    }
  },
);

router.patch(
  '/care-plans/:id/transition',
  carePlanResourceWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const row = await transitionCarePlan({
        tenantId: req.tenantId,
        id: req.params.id,
        nextStatus: req.body?.next_status,
        reviewerUid: req.user?.uid || null,
        notes: req.body?.notes,
      });
      return success(res, row, 'Care plan transitioned');
    } catch (err) {
      return next(err);
    }
  },
);

router.patch(
  '/care-plans/:id/visibility',
  carePlanResourceWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const row = await setCarePlanVisibility({
        tenantId: req.tenantId,
        id: req.params.id,
        isPatientVisible: req.body?.is_patient_visible,
        reviewerUid: req.user?.uid || null,
      });
      return success(res, row, 'Care plan visibility updated');
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/care-plans/:id/goals',
  carePlanResourceRead,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const result = await listGoals({
        tenantId: req.tenantId,
        carePlanId: req.params.id,
        status: req.query.status || null,
        limit: req.query.limit,
      });
      return success(res, result, 'Goals retrieved');
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/care-plans/:id/goals',
  carePlanResourceWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
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
    } catch (err) {
      return next(err);
    }
  },
);

router.patch(
  '/care-plans/goals/:goalId/progress',
  goalResourceWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const row = await updateGoalProgress({
        tenantId: req.tenantId,
        id: req.params.goalId,
        currentValue: req.body?.current_value,
        status: req.body?.status,
        achievedAt: req.body?.achieved_at,
      });
      return success(res, row, 'Goal progress updated');
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/care-plans/:id/activities',
  carePlanResourceRead,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
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
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/care-plans/:id/activities',
  carePlanResourceWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
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
    } catch (err) {
      return next(err);
    }
  },
);

router.patch(
  '/care-plans/activities/:activityId/complete',
  activityResourceWrite,
  phiAccessLogger('CARE_PLAN'),
  async (req, res, next) => {
    try {
      const row = await recordActivityCompletion({
        tenantId: req.tenantId,
        id: req.params.activityId,
        status: req.body?.status,
        incrementCount: req.body?.increment_count,
      });
      return success(res, row, 'Activity completion recorded');
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
