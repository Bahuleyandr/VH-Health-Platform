// src/services/bloodbank/bloodBankService.js

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const VALID_COMPONENTS = ['whole_blood', 'prbc', 'ffp', 'platelets', 'cryoprecipitate'];
const VALID_URGENCIES = ['routine', 'urgent', 'emergency'];
const VALID_STATUSES = ['requested', 'cross_matched', 'issued', 'transfused', 'cancelled'];

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

    const result = await db.query(
      `INSERT INTO blood_requests
        (patient_uid, encounter_id, blood_group, component, units, urgency,
         clinical_indication, cross_match_status, status, ordered_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'requested', $8, NOW())
       RETURNING id, patient_uid, encounter_id, blood_group, component, units, urgency,
                 clinical_indication, cross_match_status, status, ordered_by, created_at`,
      [patient_uid, encounter_id || null, blood_group, component, units, urgency, clinical_indication, ordered_by]
    );

    logger.info('Blood request created', { requestId: result.rows[0].id, blood_group, component, units, urgency });
    return result.rows[0];
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

    const existing = await db.query(
      `SELECT id, status FROM blood_requests WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('Blood request not found');
    }

    if (existing.rows[0].status !== 'requested') {
      throw AppError.badRequest('Cross-match can only be performed on requests with status "requested"');
    }

    const result = await db.query(
      `UPDATE blood_requests
       SET cross_match_status = $1, cross_matched_by = $2, cross_matched_at = NOW(),
           status = 'cross_matched'
       WHERE id = $3
       RETURNING id, patient_uid, blood_group, component, units, cross_match_status,
                 cross_matched_by, cross_matched_at, status`,
      [cross_match_status, cross_matched_by, id]
    );

    logger.info('Blood cross-match recorded', { requestId: id, cross_match_status, cross_matched_by });
    return result.rows[0];
  }

  /**
   * Issue blood to patient
   */
  async issueBlood(id, data) {
    const { issued_by } = data;

    if (!issued_by) {
      throw AppError.badRequest('Missing required field: issued_by');
    }

    const existing = await db.query(
      `SELECT id, status, cross_match_status FROM blood_requests WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('Blood request not found');
    }

    if (existing.rows[0].status !== 'cross_matched') {
      throw AppError.badRequest('Blood can only be issued after cross-matching');
    }

    if (existing.rows[0].cross_match_status !== 'compatible') {
      throw AppError.badRequest('Cannot issue blood with incompatible cross-match result');
    }

    const result = await db.query(
      `UPDATE blood_requests
       SET issued = true, issued_by = $1, issued_at = NOW(), status = 'issued'
       WHERE id = $2
       RETURNING id, patient_uid, blood_group, component, units, issued, issued_by, issued_at, status`,
      [issued_by, id]
    );

    logger.info('Blood issued', { requestId: id, issued_by });
    return result.rows[0];
  }

  /**
   * Record transfusion completion (and any reactions)
   */
  async recordTransfusion(id, data) {
    const { transfusion_reaction } = data;

    const existing = await db.query(
      `SELECT id, status FROM blood_requests WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('Blood request not found');
    }

    if (existing.rows[0].status !== 'issued') {
      throw AppError.badRequest('Transfusion can only be recorded for issued blood');
    }

    const result = await db.query(
      `UPDATE blood_requests
       SET transfused = true, transfusion_reaction = $1, status = 'transfused'
       WHERE id = $2
       RETURNING id, patient_uid, blood_group, component, units, transfused, transfusion_reaction, status`,
      [transfusion_reaction || null, id]
    );

    logger.info('Transfusion recorded', { requestId: id, hasReaction: !!transfusion_reaction });
    return result.rows[0];
  }

  /**
   * Get blood inventory summary (aggregated from requests)
   */
  async getInventory() {
    const result = await db.query(
      `SELECT blood_group, component,
              SUM(CASE WHEN status = 'requested' THEN units ELSE 0 END) as requested_units,
              SUM(CASE WHEN status = 'cross_matched' THEN units ELSE 0 END) as cross_matched_units,
              SUM(CASE WHEN status = 'issued' THEN units ELSE 0 END) as issued_units,
              SUM(CASE WHEN status = 'transfused' THEN units ELSE 0 END) as transfused_units,
              COUNT(*) as total_requests
       FROM blood_requests
       WHERE status != 'cancelled'
       GROUP BY blood_group, component
       ORDER BY blood_group, component`
    );

    return result.rows;
  }

  /**
   * Get pending blood requests (not yet issued)
   */
  async getPendingRequests(filters = {}) {
    const { blood_group, urgency, page = 1, limit = 50 } = filters;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
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

    const countResult = await db.query(
      `SELECT COUNT(*) FROM blood_requests ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(parseInt(limit, 10));
    params.push(offset);

    const result = await db.query(
      `SELECT id, patient_uid, encounter_id, blood_group, component, units, urgency,
              clinical_indication, cross_match_status, cross_matched_by, cross_matched_at,
              status, ordered_by, created_at
       FROM blood_requests
       ${whereClause}
       ORDER BY
         CASE urgency WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      requests: result.rows,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    };
  }
}

export default new BloodBankService();
