// src/services/radiology/radiologyService.js

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_MODALITIES = ['xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy'];
const VALID_PRIORITIES = ['routine', 'urgent', 'stat'];
const VALID_STATUSES = ['ordered', 'scheduled', 'in_progress', 'completed', 'cancelled'];

class RadiologyService {

  /**
   * Create a new radiology order
   */
  async createOrder(data) {
    const {
      patient_uid, encounter_id, modality, body_part,
      clinical_indication, priority = 'routine', ordered_by, notes
    } = data;

    if (!patient_uid || !modality || !body_part || !clinical_indication || !ordered_by) {
      throw AppError.badRequest('Missing required fields: patient_uid, modality, body_part, clinical_indication, ordered_by');
    }

    if (!VALID_MODALITIES.includes(modality)) {
      throw AppError.badRequest(`Invalid modality. Must be one of: ${VALID_MODALITIES.join(', ')}`);
    }

    if (!VALID_PRIORITIES.includes(priority)) {
      throw AppError.badRequest(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    }

    const result = await db.query(
      `INSERT INTO radiology_orders
        (patient_uid, encounter_id, modality, body_part, clinical_indication, priority, status, ordered_by, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ordered', $7, $8, NOW())
       RETURNING id, patient_uid, encounter_id, modality, body_part, clinical_indication, priority, status, ordered_by, notes, created_at`,
      [patient_uid, encounter_id || null, modality, body_part, clinical_indication, priority, ordered_by, notes || null]
    );

    logger.info('Radiology order created', { orderId: result.rows[0].id, modality, patient_uid });
    return result.rows[0];
  }

  /**
   * Get radiology worklist (filterable by status, modality, priority)
   */
  async getWorklist(filters = {}) {
    const { status, modality, priority, page = 1, limit = 50 } = filters;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`ro.status = $${params.length}`);
    }
    if (modality) {
      params.push(modality);
      conditions.push(`ro.modality = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      conditions.push(`ro.priority = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*) FROM radiology_orders ro ${whereClause}`,
      params
    );

    const total = parseInt(countResult.rows[0].count, 10);

    params.push(parseInt(limit, 10));
    params.push(offset);

    const result = await db.query(
      `SELECT ro.id, ro.patient_uid, ro.encounter_id, ro.modality, ro.body_part,
              ro.clinical_indication, ro.priority, ro.status, ro.ordered_by,
              ro.reported_by, ro.reported_at, ro.notes, ro.created_at
       FROM radiology_orders ro
       ${whereClause}
       ORDER BY
         CASE ro.priority WHEN 'stat' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
         ro.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      orders: result.rows,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    };
  }

  /**
   * Submit a radiology report for an order
   */
  async submitReport(id, data) {
    const { report, findings, impression, images, reported_by } = data;

    if (!report || !reported_by) {
      throw AppError.badRequest('Missing required fields: report, reported_by');
    }

    // Verify order exists and is not cancelled
    const existing = await db.query(
      `SELECT id, status FROM radiology_orders WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('Radiology order not found');
    }

    if (existing.rows[0].status === 'cancelled') {
      throw AppError.badRequest('Cannot submit report for a cancelled order');
    }

    const result = await db.query(
      `UPDATE radiology_orders
       SET report = $1, findings = $2, impression = $3, images = $4,
           reported_by = $5, reported_at = NOW(), status = 'completed'
       WHERE id = $6
       RETURNING id, patient_uid, modality, body_part, status, report, findings, impression, images, reported_by, reported_at`,
      [report, findings || null, impression || null, images || [], reported_by, id]
    );

    logger.info('Radiology report submitted', { orderId: id, reported_by });
    return result.rows[0];
  }

  /**
   * Get radiology history for a patient
   */
  async getPatientHistory(patientUid, filters = {}) {
    const { page = 1, limit = 20 } = filters;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const countResult = await db.query(
      `SELECT COUNT(*) FROM radiology_orders WHERE patient_uid = $1`,
      [patientUid]
    );

    const total = parseInt(countResult.rows[0].count, 10);

    const result = await db.query(
      `SELECT id, patient_uid, encounter_id, modality, body_part, clinical_indication,
              priority, status, report, findings, impression, images,
              ordered_by, reported_by, reported_at, notes, created_at
       FROM radiology_orders
       WHERE patient_uid = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [patientUid, parseInt(limit, 10), offset]
    );

    return {
      orders: result.rows,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    };
  }

  /**
   * Get detail for a single radiology order
   */
  async getOrderDetail(id) {
    const result = await db.query(
      `SELECT id, patient_uid, encounter_id, modality, body_part, clinical_indication,
              priority, status, report, findings, impression, images,
              ordered_by, reported_by, reported_at, notes, created_at
       FROM radiology_orders
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      throw AppError.notFound('Radiology order not found');
    }

    return result.rows[0];
  }

  /**
   * Cancel a radiology order
   */
  async cancelOrder(id, cancelledBy) {
    const existing = await db.query(
      `SELECT id, status FROM radiology_orders WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw AppError.notFound('Radiology order not found');
    }

    if (existing.rows[0].status === 'completed') {
      throw AppError.badRequest('Cannot cancel a completed order');
    }

    if (existing.rows[0].status === 'cancelled') {
      throw AppError.badRequest('Order is already cancelled');
    }

    const result = await db.query(
      `UPDATE radiology_orders SET status = 'cancelled' WHERE id = $1
       RETURNING id, patient_uid, modality, body_part, status`,
      [id]
    );

    logger.info('Radiology order cancelled', { orderId: id, cancelledBy });
    return result.rows[0];
  }
}

export default new RadiologyService();
