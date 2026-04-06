// src/routes/dietary/dietaryRoutes.js
// Dietary / Nutrition Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import dietaryService from '../../services/dietary/dietaryService.js';
import { success, error } from '../../utils/responseHelper.js';
import { requiredUUID, requiredString, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * POST /dietary/orders
 * Create a new diet order
 */
router.post('/orders', requiredUUID('patient_uid'), requiredString('diet_type', 100), validate, async (req, res, next) => {
  try {
    const orderData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      diet_type: req.body.diet_type,
      restrictions: req.body.restrictions,
      allergies: req.body.allergies,
      meal_preferences: req.body.meal_preferences,
      calories_target: req.body.calories_target,
      special_instructions: req.body.special_instructions,
      ordered_by: req.user?.uid || null
    };

    const order = await dietaryService.createDietOrder(orderData);
    return success(res, order, 'Diet order created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to create diet order:', { error: err.message });
    next(err);
  }
});

/**
 * GET /dietary/worklist
 * Get diet worklist for kitchen/nutrition staff
 */
router.get('/worklist', async (req, res, next) => {
  try {
    const filters = {
      status: req.query.status,
      diet_type: req.query.diet_type,
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await dietaryService.getDietWorklist(filters);
    return success(res, result.orders, 'Diet worklist retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get diet worklist:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /dietary/:id
 * Update a diet plan
 */
router.put('/:id', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = {
      diet_type: req.body.diet_type,
      restrictions: req.body.restrictions,
      allergies: req.body.allergies,
      meal_preferences: req.body.meal_preferences,
      calories_target: req.body.calories_target,
      special_instructions: req.body.special_instructions,
      status: req.body.status,
      reviewed_by: req.user?.uid || null
    };

    const result = await dietaryService.updateDietPlan(parseInt(id, 10), updateData);
    return success(res, result, 'Diet order updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to update diet order:', { error: err.message });
    next(err);
  }
});

/**
 * GET /dietary/patient/:uid
 * Get diet order history for a patient
 */
router.get('/patient/:uid', async (req, res, next) => {
  try {
    const { uid } = req.params;
    const filters = {
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await dietaryService.getPatientDietHistory(uid, filters);
    return success(res, result.orders, 'Patient diet history retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get patient diet history:', { error: err.message });
    next(err);
  }
});

export default router;
