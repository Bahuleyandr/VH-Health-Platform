// src/routes/theatre/theatreRoutes.js
// Operating Theatre Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import theatreService from '../../services/theatre/theatreService.js';
import { success, error } from '../../utils/responseHelper.js';
import { requiredUUID, requiredString, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * POST /theatre/schedule
 * Schedule a new surgery
 */
router.post('/schedule', requiredUUID('patient_uid'), requiredString('procedure_name', 300), requiredUUID('surgeon'), validate, async (req, res, next) => {
  try {
    const scheduleData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      surgeon: req.body.surgeon,
      anesthetist: req.body.anesthetist,
      procedure_name: req.body.procedure_name,
      procedure_code: req.body.procedure_code,
      ot_room: req.body.ot_room,
      scheduled_date: req.body.scheduled_date,
      scheduled_time: req.body.scheduled_time,
      estimated_duration: req.body.estimated_duration,
      equipment_needed: req.body.equipment_needed,
      blood_arranged: req.body.blood_arranged,
      consent_obtained: req.body.consent_obtained
    };

    const schedule = await theatreService.scheduleSurgery(scheduleData);
    return success(res, schedule, 'Surgery scheduled successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to schedule surgery:', { error: err.message });
    next(err);
  }
});

/**
 * GET /theatre/today
 * Get today's OT schedule
 */
router.get('/today', async (req, res, next) => {
  try {
    const filters = {
      ot_room: req.query.ot_room,
      status: req.query.status,
      date: req.query.date
    };

    const schedules = await theatreService.getTodaySchedule(filters);
    return success(res, schedules, 'Today OT schedule retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get OT schedule:', { error: err.message });
    next(err);
  }
});

/**
 * GET /theatre/availability
 * Get available OT rooms for a date
 */
router.get('/availability', async (req, res, next) => {
  try {
    const { date } = req.query;
    const result = await theatreService.getAvailableRooms(date);
    return success(res, result, 'OT room availability retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get OT room availability:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /theatre/:id/status
 * Update surgery status
 */
router.put('/:id/status', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const result = await theatreService.updateStatus(parseInt(id, 10), status, req.user?.uid);
    return success(res, result, 'Surgery status updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to update surgery status:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /theatre/:id/checklist
 * Update pre-op checklist
 */
router.put('/:id/checklist', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { checklist } = req.body;

    const result = await theatreService.completeChecklist(parseInt(id, 10), checklist, {
      tenantId: req.tenantId,
      completedBy: req.user?.uid || null,
    });
    return success(res, result, 'Pre-op checklist updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to update pre-op checklist:', { error: err.message });
    next(err);
  }
});

/**
 * DELETE /theatre/:id
 * Cancel a scheduled surgery
 */
router.delete('/:id', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await theatreService.cancelSurgery(parseInt(id, 10), req.user?.uid);
    return success(res, result, 'Surgery cancelled successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to cancel surgery:', { error: err.message });
    next(err);
  }
});

export default router;
