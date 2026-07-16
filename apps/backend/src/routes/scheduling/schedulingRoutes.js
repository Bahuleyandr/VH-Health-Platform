// src/routes/scheduling/schedulingRoutes.js
//
// Roadmap D2 — scheduling optimization. Mounted at /api/v1/scheduling
// (app.js) for clinical + reception staff.

import express from 'express';
import {
  upsertTemplate,
  listTemplates,
  recordLeave,
  recordTemplateException,
  listTemplateExceptions,
  getSlotGrid,
  createSlotHold,
  confirmSlotHold,
  releaseSlotHold,
  addToWaitlist,
  fillWaitlist,
  resolveWaitlistEntry,
  saveOverbookPolicy,
  listOverbookPolicies,
  evaluateOverbookRequest,
  createResource,
  addResourceCompatibility,
  listResourceCompatibility,
  bookResource,
  listResourceSchedule,
} from '../../services/scheduling/schedulingOptimizationService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { ROLES, isAdmin, isDoctor } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = express.Router();

const canManageSchedules = (role) => isAdmin(role) || isDoctor(role)
  || role === 'SUPER_ADMIN' || role === ROLES.RECEPTION_INCHARGE;

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

// Templates + leaves
router.post('/templates', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to manage templates', HTTP_STATUS.FORBIDDEN);
    const template = await upsertTemplate({
      doctorId: req.body.doctor_id,
      weekday: req.body.weekday,
      startTime: req.body.start_time,
      endTime: req.body.end_time,
      slotMinutes: req.body.slot_minutes,
      location: req.body.location || null,
      effectiveFrom: req.body.effective_from || null,
      effectiveTo: req.body.effective_to || null,
      replacesTemplateId: req.body.replaces_template_id || null,
      appointmentType: req.body.appointment_type || null,
      serviceCode: req.body.service_code || null,
      visitType: req.body.visit_type || null,
      roomResourceId: req.body.room_resource_id || null,
      counterLocation: req.body.counter_location || null,
      metadata: req.body.metadata || {},
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { template }, 'Availability template saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save template');
  }
});

router.get('/templates/:doctorId', async (req, res) => {
  try {
    const templates = await listTemplates(Number.parseInt(req.params.doctorId, 10), {
      tenantId: tenantOf(req),
      includeInactive: req.query.include_inactive === 'true',
    });
    return success(res, { templates, count: templates.length }, 'Availability templates');
  } catch (err) {
    return handleFailure(res, err, 'list templates');
  }
});

router.post('/templates/:id/exceptions', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to manage template exceptions', HTTP_STATUS.FORBIDDEN);
    const exception = await recordTemplateException({
      templateId: req.params.id,
      doctorId: req.body.doctor_id,
      exceptionDate: req.body.exception_date,
      exceptionType: req.body.exception_type || 'blocked',
      allDay: req.body.all_day || false,
      startTime: req.body.start_time || null,
      endTime: req.body.end_time || null,
      slotMinutes: req.body.slot_minutes || null,
      location: req.body.location || null,
      reason: req.body.reason || null,
      metadata: req.body.metadata || {},
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { exception }, 'Template exception saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save template exception');
  }
});

router.get('/templates/:doctorId/exceptions', async (req, res) => {
  try {
    const exceptions = await listTemplateExceptions({
      tenantId: tenantOf(req),
      doctorId: req.params.doctorId,
      date: req.query.date || null,
    });
    return success(res, { exceptions, count: exceptions.length }, 'Template exceptions');
  } catch (err) {
    return handleFailure(res, err, 'list template exceptions');
  }
});

router.post('/leaves', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to record leaves', HTTP_STATUS.FORBIDDEN);
    const leave = await recordLeave({
      doctorId: req.body.doctor_id,
      startsOn: req.body.starts_on,
      endsOn: req.body.ends_on,
      reason: req.body.reason || null,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { leave }, 'Leave recorded (slots auto-blocked)', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record leave');
  }
});

// Slot grid + overbook suggestions
router.get('/slots', async (req, res) => {
  try {
    const grid = await getSlotGrid({
      tenantId: tenantOf(req),
      doctorId: req.query.doctor_id,
      date: req.query.date,
      visitType: req.query.visit_type || null,
      appointmentType: req.query.appointment_type || null,
    });
    return success(res, grid, 'Slot grid');
  } catch (err) {
    return handleFailure(res, err, 'build slot grid');
  }
});

router.post('/slot-holds', async (req, res) => {
  try {
    const hold = await createSlotHold({
      tenantId: tenantOf(req),
      doctorId: req.body.doctor_id,
      date: req.body.date,
      slotStart: req.body.slot_start,
      slotEnd: req.body.slot_end || null,
      patientUid: req.body.patient_uid || null,
      sourceChannel: req.body.source_channel || 'staff',
      idempotencyKey: req.body.idempotency_key,
      holdMinutes: req.body.hold_minutes,
      metadata: req.body.metadata || {},
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    return success(res, { hold }, hold.idempotent ? 'Slot hold reused' : 'Slot held', hold.idempotent ? HTTP_STATUS.OK : HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'hold slot');
  }
});

router.post('/slot-holds/:id/confirm', async (req, res) => {
  try {
    const hold = await confirmSlotHold(req.params.id, {
      appointmentId: req.body.appointment_id || null,
      tenantId: tenantOf(req),
    });
    return success(res, { hold }, 'Slot hold confirmed');
  } catch (err) {
    return handleFailure(res, err, 'confirm slot hold');
  }
});

router.post('/slot-holds/:id/release', async (req, res) => {
  try {
    const hold = await releaseSlotHold(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { hold }, 'Slot hold released');
  } catch (err) {
    return handleFailure(res, err, 'release slot hold');
  }
});

// Waitlist
router.post('/waitlist', async (req, res) => {
  try {
    const entry = await addToWaitlist({
      patientUid: req.body.patient_uid,
      doctorId: req.body.doctor_id,
      preferredDate: req.body.preferred_date || null,
      preferredWindow: req.body.preferred_window || 'any',
      priority: req.body.priority,
      notes: req.body.notes || null,
      sourceChannel: req.body.source_channel || 'staff',
      overrideReason: req.body.override_reason || null,
      metadata: req.body.metadata || {},
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { entry }, 'Added to waitlist', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'add to waitlist');
  }
});

router.post('/waitlist/fill', async (req, res) => {
  try {
    const result = await fillWaitlist({
      doctorId: req.body.doctor_id,
      date: req.body.date,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, result, 'Waitlist fill pass complete');
  } catch (err) {
    return handleFailure(res, err, 'fill waitlist');
  }
});

router.patch('/waitlist/:id', async (req, res) => {
  try {
    const entry = await resolveWaitlistEntry(req.params.id, {
      status: req.body.status,
      overrideReason: req.body.override_reason || null,
      tenantId: tenantOf(req),
    });
    return success(res, { entry }, 'Waitlist entry updated');
  } catch (err) {
    return handleFailure(res, err, 'update waitlist entry');
  }
});

// Overbook policies + decisions
router.get('/overbook-policies', async (req, res) => {
  try {
    const policies = await listOverbookPolicies({
      tenantId: tenantOf(req),
      doctorId: req.query.doctor_id || null,
    });
    return success(res, { policies, count: policies.length }, 'Overbook policies');
  } catch (err) {
    return handleFailure(res, err, 'list overbook policies');
  }
});

router.post('/overbook-policies', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to manage overbook policies', HTTP_STATUS.FORBIDDEN);
    const policy = await saveOverbookPolicy({
      tenantId: tenantOf(req),
      policyId: req.body.id || null,
      policyScope: req.body.policy_scope || 'tenant',
      doctorId: req.body.doctor_id || null,
      departmentId: req.body.department_id || null,
      departmentName: req.body.department_name || null,
      visitType: req.body.visit_type || null,
      appointmentType: req.body.appointment_type || null,
      maxOverbookFraction: req.body.max_overbook_fraction ?? 0,
      maxOverbookSlots: req.body.max_overbook_slots ?? 0,
      authorityRole: req.body.authority_role || 'RECEPTION_INCHARGE',
      overrideRequiresReason: req.body.override_requires_reason !== false,
      enabled: req.body.enabled === true,
      effectiveFrom: req.body.effective_from || null,
      effectiveTo: req.body.effective_to || null,
      metadata: req.body.metadata || {},
    }, { actorUid: req.user?.uid || null });
    return success(res, { policy }, 'Overbook policy saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save overbook policy');
  }
});

router.post('/overbook/evaluate', async (req, res) => {
  try {
    const decision = await evaluateOverbookRequest({
      tenantId: tenantOf(req),
      doctorId: req.body.doctor_id,
      date: req.body.date,
      slotStart: req.body.slot_start || null,
      appointmentId: req.body.appointment_id || null,
      requestedSlots: req.body.requested_slots || 1,
      visitType: req.body.visit_type || null,
      appointmentType: req.body.appointment_type || null,
      overrideReason: req.body.override_reason || null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    return success(res, decision, 'Overbook decision evaluated');
  } catch (err) {
    return handleFailure(res, err, 'evaluate overbook request');
  }
});

// Bookable resources
router.post('/resources', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to manage resources', HTTP_STATUS.FORBIDDEN);
    const resource = await createResource({
      kind: req.body.kind, name: req.body.name, location: req.body.location || null,
      serviceCode: req.body.service_code || null,
      departmentId: req.body.department_id || null,
      capacity: req.body.capacity || 1,
      metadata: req.body.metadata || {},
      tenantId: tenantOf(req),
    });
    return success(res, { resource }, 'Resource saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create resource');
  }
});

router.post('/resources/:id/compatibility', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to manage resource compatibility', HTTP_STATUS.FORBIDDEN);
    const compatibility = await addResourceCompatibility({
      tenantId: tenantOf(req),
      resourceId: req.params.id,
      templateId: req.body.template_id || null,
      doctorId: req.body.doctor_id || null,
      appointmentType: req.body.appointment_type || null,
      serviceCode: req.body.service_code || null,
      visitType: req.body.visit_type || null,
      requirement: req.body.requirement || 'compatible',
      metadata: req.body.metadata || {},
    }, { actorUid: req.user?.uid || null });
    return success(res, { compatibility }, 'Resource compatibility saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save resource compatibility');
  }
});

router.get('/resources/:id/compatibility', async (req, res) => {
  try {
    const compatibility = await listResourceCompatibility({
      tenantId: tenantOf(req),
      resourceId: req.params.id,
    });
    return success(res, { compatibility, count: compatibility.length }, 'Resource compatibility');
  } catch (err) {
    return handleFailure(res, err, 'list resource compatibility');
  }
});

router.post('/resources/:id/book', async (req, res) => {
  try {
    const booking = await bookResource({
      resourceId: req.params.id,
      startsAt: req.body.starts_at,
      endsAt: req.body.ends_at,
      bookedForType: req.body.booked_for_type || 'other',
      bookedForId: req.body.booked_for_id || null,
      patientUid: req.body.patient_uid || null,
      notes: req.body.notes || null,
      doctorId: req.body.doctor_id || null,
      appointmentType: req.body.appointment_type || null,
      serviceCode: req.body.service_code || null,
      visitType: req.body.visit_type || null,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { booking }, 'Resource booked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'book resource');
  }
});

router.get('/resources/:id/schedule', async (req, res) => {
  try {
    const bookings = await listResourceSchedule({
      tenantId: tenantOf(req),
      resourceId: req.params.id,
      date: req.query.date,
    });
    return success(res, { bookings, count: bookings.length }, 'Resource schedule');
  } catch (err) {
    return handleFailure(res, err, 'read resource schedule');
  }
});

export default router;
