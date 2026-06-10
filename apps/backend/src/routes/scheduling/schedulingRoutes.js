// src/routes/scheduling/schedulingRoutes.js
//
// Roadmap D2 — scheduling optimization. Mounted at /api/v1/scheduling
// (app.js) for clinical + reception staff.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  upsertTemplate,
  listTemplates,
  recordLeave,
  getSlotGrid,
  addToWaitlist,
  fillWaitlist,
  resolveWaitlistEntry,
  createResource,
  bookResource,
  listResourceSchedule,
} from '../../services/scheduling/schedulingOptimizationService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canManageSchedules = (role) => isAdmin(role) || isDoctor(role)
  || role === 'SUPER_ADMIN' || role === ROLES.RECEPTION_INCHARGE;

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Scheduling ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
    }, { actorUid: req.user?.uid || null });
    return success(res, { template }, 'Availability template saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save template');
  }
});

router.get('/templates/:doctorId', async (req, res) => {
  try {
    const templates = await listTemplates(Number.parseInt(req.params.doctorId, 10));
    return success(res, { templates, count: templates.length }, 'Availability templates');
  } catch (err) {
    return handleFailure(res, err, 'list templates');
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
    }, { actorUid: req.user?.uid || null });
    return success(res, { leave }, 'Leave recorded (slots auto-blocked)', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record leave');
  }
});

// Slot grid + overbook suggestions
router.get('/slots', async (req, res) => {
  try {
    const grid = await getSlotGrid({ doctorId: req.query.doctor_id, date: req.query.date });
    return success(res, grid, 'Slot grid');
  } catch (err) {
    return handleFailure(res, err, 'build slot grid');
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
    }, { actorUid: req.user?.uid || null });
    return success(res, result, 'Waitlist fill pass complete');
  } catch (err) {
    return handleFailure(res, err, 'fill waitlist');
  }
});

router.patch('/waitlist/:id', async (req, res) => {
  try {
    const entry = await resolveWaitlistEntry(req.params.id, { status: req.body.status });
    return success(res, { entry }, 'Waitlist entry updated');
  } catch (err) {
    return handleFailure(res, err, 'update waitlist entry');
  }
});

// Bookable resources
router.post('/resources', async (req, res) => {
  try {
    if (!canManageSchedules(req.user?.role)) return error(res, 'Not allowed to manage resources', HTTP_STATUS.FORBIDDEN);
    const resource = await createResource({
      kind: req.body.kind, name: req.body.name, location: req.body.location || null,
    });
    return success(res, { resource }, 'Resource saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create resource');
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
    }, { actorUid: req.user?.uid || null });
    return success(res, { booking }, 'Resource booked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'book resource');
  }
});

router.get('/resources/:id/schedule', async (req, res) => {
  try {
    const bookings = await listResourceSchedule({ resourceId: req.params.id, date: req.query.date });
    return success(res, { bookings, count: bookings.length }, 'Resource schedule');
  } catch (err) {
    return handleFailure(res, err, 'read resource schedule');
  }
});

export default router;
