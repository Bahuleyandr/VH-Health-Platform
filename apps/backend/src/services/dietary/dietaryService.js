// src/services/dietary/dietaryService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_DIET_TYPES = ['regular', 'diabetic', 'cardiac', 'renal', 'soft', 'liquid', 'npo', 'enteral'];
const VALID_STATUSES = ['active', 'on_hold', 'discontinued'];

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

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO diet_orders
        (patient_uid, encounter_id, diet_type, restrictions, allergies, meal_preferences,
         calories_target, special_instructions, status, ordered_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, NOW())
       RETURNING id, patient_uid, encounter_id, diet_type, restrictions, allergies,
                 meal_preferences, calories_target, special_instructions, status, ordered_by, created_at`,
      
        patient_uid, encounter_id || null, diet_type, restrictions, allergies,
        meal_preferences || null, calories_target || null, special_instructions || null, ordered_by
      
    );

    logger.info('Diet order created', { orderId: result[0].id, diet_type, patient_uid });
    return result[0];
  }

  /**
   * Get all active diet orders (optionally filtered)
   */
  async getActiveOrders(filters = {}) {
    const { page = 1, limit = 50 } = filters;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

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
      parseInt(limit, 10), offset
    );

    return {
      orders: result,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10))
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

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM diet_orders WHERE id = $1`,
      id
    );

    if (existing.length === 0) {
      throw AppError.notFound('Diet order not found');
    }

    if (existing[0].status === 'discontinued') {
      throw AppError.badRequest('Cannot update a discontinued diet order');
    }

    if (status && !VALID_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    if (diet_type && !VALID_DIET_TYPES.includes(diet_type)) {
      throw AppError.badRequest(`Invalid diet_type. Must be one of: ${VALID_DIET_TYPES.join(', ')}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE diet_orders
       SET diet_type = COALESCE($1, diet_type),
           restrictions = COALESCE($2, restrictions),
           allergies = COALESCE($3, allergies),
           meal_preferences = COALESCE($4, meal_preferences),
           calories_target = COALESCE($5, calories_target),
           special_instructions = COALESCE($6, special_instructions),
           status = COALESCE($7, status),
           reviewed_by = COALESCE($8, reviewed_by)
       WHERE id = $9
       RETURNING id, patient_uid, encounter_id, diet_type, restrictions, allergies,
                 meal_preferences, calories_target, special_instructions, status,
                 ordered_by, reviewed_by, created_at`,
      
        diet_type || null, restrictions || null, allergies || null,
        meal_preferences || null, calories_target || null,
        special_instructions || null, status || null,
        reviewed_by || null, id
      
    );

    logger.info('Diet order updated', { orderId: id });
    return result[0];
  }

  /**
   * Get diet order history for a patient
   */
  async getPatientDietHistory(patientUid, filters = {}) {
    const { page = 1, limit = 20 } = filters;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM diet_orders WHERE patient_uid = $1`,
      patientUid
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       WHERE patient_uid = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      patientUid, parseInt(limit, 10), offset
    );

    return {
      orders: result,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    };
  }

  /**
   * Get diet worklist (all non-discontinued orders for kitchen/nutrition staff)
   */
  async getDietWorklist(filters = {}) {
    const { status, diet_type, page = 1, limit = 50 } = filters;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
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
      params
    );
    const total = parseInt(countResult[0].count, 10);

    params.push(parseInt(limit, 10));
    params.push(offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      orders: result,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    };
  }
}

export default new DietaryService();
