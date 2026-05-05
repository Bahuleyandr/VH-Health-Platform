// src/services/bloodbank/bloodBankService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const VALID_COMPONENTS = ['whole_blood', 'prbc', 'ffp', 'platelets', 'cryoprecipitate'];
const VALID_URGENCIES = ['routine', 'urgent', 'emergency'];

const BLOOD_REQUEST_RETURNING = `id, patient_uid, encounter_id, blood_group, component, units,
    urgency, clinical_indication, cross_match_status, cross_matched_by, cross_matched_at,
    issued_by, issued_at, transfused_at, status, ordered_by, notes, created_at, updated_at`;

class BloodBankService {

  /**
   * Create a new blood request
   */
  async createRequest(data) {
    const {
      patient_uid, encounter_id, blood_group, component,
      units, urgency = 'routine', clinical_indication, ordered_by
    } = data;

    if (!patient_uid || !blood_group || !component || !units || !clinical_indication || !ordered_by) {
      throw AppError.badRequest('Missing required fields: patient_uid, blood_group, component, units, clinical_indication, ordered_by');
    }
    if (!VALID_BLOOD_GROUPS.includes(blood_group)) {
      throw AppError.badRequest(`Invalid blood_group. Must be one of: ${VALID_BLOOD_GROUPS.join(', ')}`);
    }
    if (!VALID_COMPONENTS.includes(component)) {
      throw AppError.badRequest(`Invalid component. Must be one of: ${VALID_COMPONENTS.join(', ')}`);
    }
    if (!VALID_URGENCIES.includes(urgency)) {
      throw AppError.badRequest(`Invalid urgency. Must be one of: ${VALID_URGENCIES.join(', ')}`);
    }
    if (!Number.isInteger(units) || units < 1) {
      throw AppError.badRequest('Units must be a positive integer');
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO blood_requests
        (patient_uid, encounter_id, blood_group, component, units, urgency,
         clinical_indication, cross_match_status, status, ordered_by, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'pending', 'requested', $8::uuid, NOW(), NOW())
       RETURNING ${BLOOD_REQUEST_RETURNING}`,
      patient_uid, encounter_id || null, blood_group, component, units, urgency,
      clinical_indication, ordered_by
    );

    logger.info('Blood request created', { requestId: result[0].id, blood_group, component, units, urgency });
    return result[0];
  }

  /**
   * Record cross-match result
   */
  async crossMatch(id, data) {
    const { cross_match_status, cross_matched_by } = data;

    if (!cross_match_status || !cross_matched_by) {
      throw AppError.badRequest('Missing required fields: cross_match_status, cross_matched_by');
    }
    if (!['compatible', 'incompatible'].includes(cross_match_status)) {
      throw AppError.badRequest('cross_match_status must be compatible or incompatible');
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM blood_requests WHERE id = $1`, parseInt(id));
    if (existing.length === 0) throw AppError.notFound('Blood request not found');
    if (existing[0].status !== 'requested') {
      throw AppError.badRequest('Cross-match can only be performed on requests with status "requested"');
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE blood_requests
       SET cross_match_status = $1, cross_matched_by = $2::uuid, cross_matched_at = NOW(),
           status = 'cross_matched', updated_at = NOW()
       WHERE id = $3
       RETURNING ${BLOOD_REQUEST_RETURNING}`,
      cross_match_status, cross_matched_by, parseInt(id)
    );

    logger.info('Blood cross-match recorded', { requestId: id, cross_match_status, cross_matched_by });
    return result[0];
  }

  /**
   * Issue blood to patient
   */
  async issueBlood(id, data) {
    const { issued_by } = data;

    if (!issued_by) throw AppError.badRequest('Missing required field: issued_by');

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, cross_match_status FROM blood_requests WHERE id = $1`, parseInt(id));
    if (existing.length === 0) throw AppError.notFound('Blood request not found');
    if (existing[0].status !== 'cross_matched') {
      throw AppError.badRequest('Blood can only be issued after cross-matching');
    }
    if (existing[0].cross_match_status !== 'compatible') {
      throw AppError.badRequest('Cannot issue blood with incompatible cross-match result');
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE blood_requests
       SET issued_by = $1::uuid, issued_at = NOW(), status = 'issued', updated_at = NOW()
       WHERE id = $2
       RETURNING ${BLOOD_REQUEST_RETURNING}`,
      issued_by, parseInt(id)
    );

    logger.info('Blood issued', { requestId: id, issued_by });
    return result[0];
  }

  /**
   * Record transfusion completion. `transfusion_reaction` (if any) is appended to `notes`
   * because the table has no dedicated column for it.
   */
  async recordTransfusion(id, data) {
    const { transfusion_reaction } = data;

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM blood_requests WHERE id = $1`, parseInt(id));
    if (existing.length === 0) throw AppError.notFound('Blood request not found');
    if (existing[0].status !== 'issued') {
      throw AppError.badRequest('Transfusion can only be recorded for issued blood');
    }

    const reactionNote = transfusion_reaction
      ? `Transfusion reaction: ${typeof transfusion_reaction === 'string' ? transfusion_reaction : JSON.stringify(transfusion_reaction)}`
      : null;

    const result = await prisma.$queryRawUnsafe(
      `UPDATE blood_requests
       SET transfused_at = NOW(),
           status = 'transfused',
           notes = CASE WHEN $1::text IS NOT NULL
                        THEN COALESCE(notes || E'\n', '') || $1::text
                        ELSE notes END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING ${BLOOD_REQUEST_RETURNING}`,
      reactionNote, parseInt(id)
    );

    logger.info('Transfusion recorded', { requestId: id, hasReaction: !!transfusion_reaction });
    return result[0];
  }

  /**
   * Get blood inventory summary (aggregated from requests)
   */
  async getInventory() {
    return prisma.$queryRawUnsafe(
      `SELECT blood_group, component,
              SUM(CASE WHEN status = 'requested' THEN units ELSE 0 END)::int as requested_units,
              SUM(CASE WHEN status = 'cross_matched' THEN units ELSE 0 END)::int as cross_matched_units,
              SUM(CASE WHEN status = 'issued' THEN units ELSE 0 END)::int as issued_units,
              SUM(CASE WHEN status = 'transfused' THEN units ELSE 0 END)::int as transfused_units,
              COUNT(*)::int as total_requests
       FROM blood_requests
       WHERE status != 'cancelled'
       GROUP BY blood_group, component
       ORDER BY blood_group, component`
    );
  }

  /**
   * Get pending blood requests (not yet issued)
   */
  async getPendingRequests(filters = {}) {
    const { blood_group, urgency } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'created_at'
    });
    const conditions = [`status IN ('requested', 'cross_matched')`];
    const params = [];

    if (blood_group) {
      params.push(blood_group);
      conditions.push(`blood_group = $${params.length}`);
    }
    if (urgency) {
      params.push(urgency);
      conditions.push(`urgency = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM blood_requests ${whereClause}`,
      ...params
    );
    const total = parseInt(countResult[0].count, 10);

    params.push(listQuery.limit);
    params.push(listQuery.offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, blood_group, component, units, urgency,
              clinical_indication, cross_match_status, cross_matched_by, cross_matched_at,
              status, ordered_by, created_at
       FROM blood_requests
       ${whereClause}
       ORDER BY
         CASE urgency WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      requests: result,
      pagination: {
        ...pagination,
        pages: pagination.totalPages
      }
    };
  }
}

export default new BloodBankService();
