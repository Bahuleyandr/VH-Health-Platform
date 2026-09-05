// src/routes/dietary/dietaryRoutes.js
// Dietary / Nutrition Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import dietaryService from '../../services/dietary/dietaryService.js';
import * as kitchen from '../../services/dietary/kitchenService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { paramId, dietaryOrderValidator } from '../../validators/sharedValidators.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { hasRole } from '../../utils/roles.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = Router();

// Per-route patient guard. The mount-level patientAccessGuard could never
// decide this route: mount middleware runs before Express binds the path
// param, so it saw req.params = {} and returned no_patient_context without
// evaluating a policy. routePatientAccessGuards.js carries the full
// rationale, the selector contract and the shadow-mode posture.
const guardDietaryPatientHistory = routePatientGuard('CLINICAL_WORKFLOW', {
  tag: 'dietary:patient-uid-param',
  patientSelector: (req) => ({ uid: req.params?.uid }),
});


function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

// Kitchen RBAC on top of the mount-level DIETARY_ROUTE_ROLES gate: menu
// mutations are manager-gated (dietitian/admin), kitchen actions need a
// dietary capability role, and the ward tray leg stays open to every role
// the mount admits (per-transition gating lives in the service).
function requireKitchenRole(allowedRoles, message) {
  return (req, res, next) => {
    if (!hasRole(req.user, allowedRoles)) return error(res, message, 403);
    return next();
  };
}
const requireMenuManager = requireKitchenRole(
  kitchen.MENU_MANAGE_ROLES, 'Dietary manager role required',
);
const requireKitchen = requireKitchenRole(
  kitchen.KITCHEN_ROLES, 'Kitchen (dietary) role required',
);

function wrapKitchen(handler, failMessage) {
  return async (req, res, next) => {
    try {
      return await handler(req, res);
    } catch (err) {
      if (err.isOperational) return relayAppError(res, err, failMessage);
      logger.error(failMessage, { error: err.message });
      return next(err);
    }
  };
}

/**
 * POST /dietary/orders
 * Create a new diet order
 */
router.post('/orders', ...dietaryOrderValidator, validate, async (req, res, next) => {
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
      tenant_id: tenantOf(req),
      ordered_by: req.user?.uid || null
    };

    const order = await dietaryService.createDietOrder(orderData);
    return success(res, order, 'Diet order created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to create diet order');
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
      tenantId: tenantOf(req),
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await dietaryService.getDietWorklist(filters);
    return success(res, result.orders, 'Diet worklist retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to get diet worklist');
    }
    logger.error('Failed to get diet worklist:', { error: err.message });
    next(err);
  }
});

/**
 * GET /dietary/menu-items
 * Menu master list (filter: meal_type, diet_type, active)
 */
router.get('/menu-items', wrapKitchen(async (req, res) => {
  const items = await kitchen.listMenuItems({
    tenantId: tenantOf(req),
    meal_type: req.query.meal_type,
    diet_type: req.query.diet_type,
    active: req.query.active,
  });
  return success(res, { items }, 'Menu items retrieved');
}, 'Failed to get menu items'));

/**
 * POST /dietary/menu-items
 * Create a menu item (dietary manager)
 */
router.post('/menu-items', requireMenuManager, wrapKitchen(async (req, res) => {
  const item = await kitchen.createMenuItem({
    tenant_id: tenantOf(req),
    name: req.body.name,
    meal_type: req.body.meal_type,
    diet_types: req.body.diet_types,
    is_veg: req.body.is_veg,
    allergen_tags: req.body.allergen_tags,
    notes: req.body.notes,
    created_by: req.user?.uid || null,
  });
  return success(res, item, 'Menu item created', 201);
}, 'Failed to create menu item'));

/**
 * PUT /dietary/menu-items/:id
 * Update / activate / deactivate a menu item (dietary manager)
 */
router.put('/menu-items/:id', requireMenuManager, paramId(), validate, wrapKitchen(async (req, res) => {
  const item = await kitchen.updateMenuItem(req.params.id, {
    tenant_id: tenantOf(req),
    name: req.body.name,
    meal_type: req.body.meal_type,
    diet_types: req.body.diet_types,
    is_veg: req.body.is_veg,
    allergen_tags: req.body.allergen_tags,
    active: req.body.active,
    notes: req.body.notes,
  });
  return success(res, item, 'Menu item updated');
}, 'Failed to update menu item'));

/**
 * GET /dietary/kitchen/tickets
 * Kitchen board / tray list for a service date (default: today IST)
 */
router.get('/kitchen/tickets', wrapKitchen(async (req, res) => {
  const result = await kitchen.listMealTickets({
    tenantId: tenantOf(req),
    date: req.query.date,
    meal_type: req.query.meal_type,
    status: req.query.status,
    ward: req.query.ward,
    patient_uid: req.query.patient_uid,
  });
  return success(res, result, 'Meal tickets retrieved');
}, 'Failed to get meal tickets'));

/**
 * GET /dietary/kitchen/summary
 * Production summary: live-ticket counts by meal x diet type + status rollup
 */
router.get('/kitchen/summary', wrapKitchen(async (req, res) => {
  const result = await kitchen.getProductionSummary({
    tenantId: tenantOf(req),
    date: req.query.date,
  });
  return success(res, result, 'Production summary retrieved');
}, 'Failed to get production summary'));

/**
 * POST /dietary/kitchen/generate
 * Manual (re)generation of the day's tickets (kitchen roles). Idempotent —
 * meals that already hold a live ticket are skipped.
 */
router.post('/kitchen/generate', requireKitchen, wrapKitchen(async (req, res) => {
  const result = await kitchen.generateMealTickets({
    tenantId: tenantOf(req),
    serviceDate: req.body.service_date,
    source: 'manual',
    generatedBy: req.user?.uid || null,
  });
  return success(res, result, 'Meal ticket generation complete');
}, 'Failed to generate meal tickets'));

/**
 * POST /dietary/kitchen/tickets/:id/status
 * Ticket lifecycle transition. Kitchen leg (preparing/ready/dispatched and
 * pre-dispatch cancel) is role-gated in the service; the ward tray leg
 * (delivered/collected) is open to every role on the dietary mount.
 */
router.post('/kitchen/tickets/:id/status', paramId(), validate, wrapKitchen(async (req, res) => {
  const ticket = await kitchen.transitionTicket({
    tenantId: tenantOf(req),
    ticketId: req.params.id,
    toStatus: req.body.status,
    actor: req.user || null,
    reason: req.body.reason,
  });
  return success(res, ticket, 'Meal ticket updated');
}, 'Failed to update meal ticket'));

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
      tenantId: tenantOf(req),
      reviewed_by: req.user?.uid || null
    };

    const result = await dietaryService.updateDietPlan(parseInt(id, 10), updateData);
    return success(res, result, 'Diet order updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to update diet order');
    }
    logger.error('Failed to update diet order:', { error: err.message });
    next(err);
  }
});

/**
 * GET /dietary/patient/:uid
 * Get diet order history for a patient
 */
router.get('/patient/:uid', guardDietaryPatientHistory, async (req, res, next) => {
  try {
    const { uid } = req.params;
    const filters = {
      page: req.query.page,
      tenantId: tenantOf(req),
      limit: req.query.limit
    };

    const result = await dietaryService.getPatientDietHistory(uid, filters);
    return success(res, result.orders, 'Patient diet history retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to get patient diet history');
    }
    logger.error('Failed to get patient diet history:', { error: err.message });
    next(err);
  }
});

export default router;
