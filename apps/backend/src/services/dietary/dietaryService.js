// src/services/dietary/dietaryService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { syncTicketsForOrder } from './kitchenService.js';

// Phase 1.5 (best-effort, post-commit): keep today's kitchen meal tickets in
// step with the order that just changed. Failure is logged, never blocks the
// order write — the 05:00 IST scheduler cut and the manual regenerate
// endpoint are the safety nets.
async function bestEffortTicketSync(tenantId, dietOrderId, actorUid, reason) {
  try {
    await syncTicketsForOrder({ tenantId, dietOrderId, actorUid, reason });
  } catch (err) {
    logger.warn('Dietary meal-ticket sync failed (order write already committed)', {
      tenantId, dietOrderId, error: err.message,
    });
  }
}

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

function tenantOr(value) {
  return requireTenantId(String(value || '').trim() || null);
}

async function assertPatientInTenant(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    patientUid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cross-tenant reference guard (ophthalmologyService.assertEncounterLink
// idiom): diet_orders.encounter_id has no FK, so without this check a caller
// could attach another tenant's (or another patient's) encounter uuid.
async function assertEncounterLink(tenantId, patientUid, encounterId) {
  if (encounterId === null || encounterId === undefined || encounterId === '') return null;
  if (typeof encounterId !== 'string' || !UUID_RE.test(encounterId.trim())) {
    throw AppError.badRequest('encounter_id must be a uuid');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM patient_encounters
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND patient_uid = $3::uuid
      LIMIT 1`,
    tenantId,
    encounterId.trim(),
    patientUid,
  );
  if (!rows.length) {
    throw AppError.badRequest('encounter_id does not belong to this patient', 'DIETARY_ENCOUNTER_MISMATCH');
  }
  return encounterId.trim();
}

class DietaryService {

  /**
   * Create a new diet order
   */
  async createDietOrder(data) {
    const {
      patient_uid, encounter_id, diet_type, restrictions = [],
      allergies = [], meal_preferences, calories_target,
      special_instructions, tenant_id, ordered_by
    } = data;
    const tenantId = tenantOr(tenant_id);

    if (!patient_uid || !diet_type || !ordered_by) {
      throw AppError.badRequest('Missing required fields: patient_uid, diet_type, ordered_by');
    }

    if (!VALID_DIET_TYPES.includes(diet_type)) {
      throw AppError.badRequest(`Invalid diet_type. Must be one of: ${VALID_DIET_TYPES.join(', ')}`);
    }

    const normalizedRestrictions = toTextArray(restrictions);
    const normalizedAllergies = toTextArray(allergies);
    await assertPatientInTenant(tenantId, patient_uid);
    const linkedEncounterId = await assertEncounterLink(tenantId, patient_uid, encounter_id);

    const order = await prisma.diet_orders.create({
      data: {
        tenant_id: tenantId,
        patient_uid,
        encounter_id: linkedEncounterId,
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
    await bestEffortTicketSync(tenantId, order.id, ordered_by, 'diet order created');
    return order;
  }

  /**
   * Get all active diet orders (optionally filtered)
   */
  async getActiveOrders(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM diet_orders
        WHERE tenant_id = $1::uuid AND status = 'active'`,
      tenantId,
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       WHERE tenant_id = $1::uuid AND status = 'active'
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      tenantId, listQuery.limit, listQuery.offset
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination
    };
  }

  /**
   * Update an existing diet plan
   */
  async updateDietPlan(id, data) {
    const {
      diet_type, restrictions, allergies, meal_preferences,
      calories_target, special_instructions, status, tenantId: rawTenantId, reviewed_by
    } = data;
    const tenantId = tenantOr(rawTenantId || data.tenant_id);

    const existing = await prisma.diet_orders.findFirst({
      where: { id: parseInt(id, 10), tenant_id: tenantId },
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

    // updateMany carries an explicit tenant predicate (house pattern: tenant
    // scoping must be provable in the write itself, not only in the
    // pre-flight read) — a bare-PK update here was the no-tenant-predicate
    // shape flagged across this PR.
    const updatedCount = await prisma.diet_orders.updateMany({
      where: { id: parseInt(id, 10), tenant_id: tenantId },
      data: updateData,
    });
    if (updatedCount.count === 0) {
      throw AppError.notFound('Diet order not found');
    }
    const order = await prisma.diet_orders.findFirst({
      where: { id: parseInt(id, 10), tenant_id: tenantId },
      select: DIET_ORDER_SELECT,
    });

    logger.info('Diet order updated', { orderId: id });
    await bestEffortTicketSync(tenantId, order.id, reviewed_by, 'diet order changed');
    return order;
  }

  /**
   * Get diet order history for a patient
   */
  async getPatientDietHistory(patientUid, filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    await assertPatientInTenant(tenantId, patientUid);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM diet_orders
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      tenantId, patientUid
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, diet_type, restrictions, allergies,
              meal_preferences, calories_target, special_instructions, status,
              ordered_by, reviewed_by, created_at
       FROM diet_orders
       WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      tenantId, patientUid, listQuery.limit, listQuery.offset
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination
    };
  }

  /**
   * Get diet worklist (all non-discontinued orders for kitchen/nutrition staff)
   */
  async getDietWorklist(filters = {}) {
    const { status, diet_type } = filters;
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });
    const conditions = [`tenant_id = $1::uuid`];
    const params = [tenantId];

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
      pagination
    };
  }
}

export default new DietaryService();
