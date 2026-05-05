// src/services/dietary/dietaryService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_DIET_TYPES = ['regular', 'diabetic', 'cardiac', 'renal', 'soft', 'liquid', 'npo', 'enteral'];
const VALID_STATUSES = ['active', 'on_hold', 'discontinued'];

// Shared `select` shape for create + update return values — callers see a
// stable object regardless of which method produced it.
const DIET_ORDER_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  diet_type: true,
  restrictions: true,
  allergies: true,
  meal_preferences: true,
  calories_target: true,
  special_instructions: true,
  status: true,
  ordered_by: true,
  reviewed_by: true,
  created_at: true,
};

const toTextArray = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,\n;]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

class DietaryService {

  /**
   * Create a new diet order
   */
  async createDietOrder(data) {
    const {
      patient_uid, encounter_id, diet_type, restrictions = [],
      allergies = [], meal_preferences, calories_target,
      special_instructions, ordered_by
    } = data;

    if (!patient_uid || !diet_type || !ordered_by) {
      throw AppError.badRequest('Missing required fields: patient_uid, diet_type, ordered_by');
    }

    if (!VALID_DIET_TYPES.includes(diet_type)) {
      throw AppError.badRequest(`Invalid diet_type. Must be one of: ${VALID_DIET_TYPES.join(', ')}`);
    }

    const normalizedRestrictions = toTextArray(restrictions);
    const normalizedAllergies = toTextArray(allergies);

    const order = await prisma.diet_orders.create({
      data: {
        patient_uid,
        encounter_id: encounter_id || null,
        diet_type,
        restrictions: normalizedRestrictions,
        allergies: normalizedAllergies,
        meal_preferences: meal_preferences || null,
        calories_target: calories_target || null,
        special_instructions: special_instructions || null,
        status: 'active',
        ordered_by,
      },
      select: DIET_ORDER_SELECT,
    });

    logger.info('Diet order created', { orderId: order.id, diet_type, patient_uid });
    return order;
  }

  /**
   * Get all active diet orders (optionally filtered)
   */
  async getActiveOrders(filters = {}) {
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM diet_orders WHERE status = 'active'`
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       WHERE status = 'active'
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      listQuery.limit, listQuery.offset
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination: {
        ...pagination,
        pages: pagination.totalPages
      }
    };
  }

  /**
   * Update an existing diet plan
   */
  async updateDietPlan(id, data) {
    const {
      diet_type, restrictions, allergies, meal_preferences,
      calories_target, special_instructions, status, reviewed_by
    } = data;

    const existing = await prisma.diet_orders.findUnique({
      where: { id: parseInt(id, 10) },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw AppError.notFound('Diet order not found');
    }

    if (existing.status === 'discontinued') {
      throw AppError.badRequest('Cannot update a discontinued diet order');
    }

    if (status && !VALID_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    if (diet_type && !VALID_DIET_TYPES.includes(diet_type)) {
      throw AppError.badRequest(`Invalid diet_type. Must be one of: ${VALID_DIET_TYPES.join(', ')}`);
    }

    // Build the update payload with COALESCE semantics: undefined = skip the
    // field (Prisma convention), so unspecified fields keep their current
    // values in the DB.
    const updateData = { updated_at: new Date() };
    if (diet_type != null) updateData.diet_type = diet_type;
    if (restrictions !== undefined) updateData.restrictions = toTextArray(restrictions);
    if (allergies !== undefined) updateData.allergies = toTextArray(allergies);
    if (meal_preferences != null) updateData.meal_preferences = meal_preferences;
    if (calories_target != null) updateData.calories_target = calories_target;
    if (special_instructions != null) updateData.special_instructions = special_instructions;
    if (status != null) updateData.status = status;
    if (reviewed_by != null) updateData.reviewed_by = reviewed_by;

    const order = await prisma.diet_orders.update({
      where: { id: parseInt(id, 10) },
      data: updateData,
      select: DIET_ORDER_SELECT,
    });

    logger.info('Diet order updated', { orderId: id });
    return order;
  }

  /**
   * Get diet order history for a patient
   */
  async getPatientDietHistory(patientUid, filters = {}) {
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM diet_orders WHERE patient_uid = $1::uuid`,
      patientUid
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      patientUid, listQuery.limit, listQuery.offset
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination: {
        ...pagination,
        pages: pagination.totalPages
      }
    };
  }

  /**
   * Get diet worklist (all non-discontinued orders for kitchen/nutrition staff)
   */
  async getDietWorklist(filters = {}) {
    const { status, diet_type } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });
    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    } else {
      conditions.push(`status != 'discontinued'`);
    }

    if (diet_type) {
      params.push(diet_type);
      conditions.push(`diet_type = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM diet_orders ${whereClause}`,
      ...params
    );
    const total = parseInt(countResult[0].count, 10);

    params.push(listQuery.limit);
    params.push(listQuery.offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination: {
        ...pagination,
        pages: pagination.totalPages
      }
    };
  }
}

export default new DietaryService();
