// src/services/radiology/radiologyService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_MODALITIES = ['xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy'];
const VALID_PRIORITIES = ['routine', 'urgent', 'stat'];

// Canonical columns for radiology_orders. The real schema has:
// `report (text)`, `report_completed_at`, `radiologist (uuid)`, `notes`.
// It does NOT have `findings`, `impression`, `images`, `reported_by`, `reported_at` —
// an earlier service shape referenced those; we fold findings/impression into the
// `report` text blob and keep `radiologist` as the reporter uuid.
const RAD_RETURNING = `id, patient_uid, encounter_id, modality, body_part, clinical_indication,
    priority, status, ordered_by, radiologist, report, report_completed_at, notes,
    created_at, updated_at`;

function requireIntId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw AppError.badRequest('Invalid id — must be an integer');
  return n;
}

class RadiologyService {

  async createOrder(data) {
    const {
      patient_uid, encounter_id, modality, body_part,
      clinical_indication, priority = 'routine', ordered_by, notes,
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

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO radiology_orders
        (patient_uid, encounter_id, modality, body_part, clinical_indication,
         priority, status, ordered_by, notes, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, 'ordered', $7::uuid, $8, NOW(), NOW())
       RETURNING ${RAD_RETURNING}`,
      patient_uid, encounter_id || null, modality, body_part, clinical_indication,
      priority, ordered_by, notes || null
    );

    logger.info('Radiology order created', { orderId: result[0].id, modality, patient_uid });
    return result[0];
  }

  async getWorklist(filters = {}) {
    const { status, modality, priority } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'created_at'
    });
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

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM radiology_orders ro ${whereClause}`,
      ...params
    );
    const total = parseInt(countResult[0].count, 10);

    params.push(listQuery.limit);
    params.push(listQuery.offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT ro.id, ro.patient_uid, ro.encounter_id, ro.modality, ro.body_part,
              ro.clinical_indication, ro.priority, ro.status, ro.ordered_by,
              ro.radiologist, ro.report_completed_at, ro.notes, ro.created_at, ro.updated_at
       FROM radiology_orders ro
       ${whereClause}
       ORDER BY
         CASE ro.priority WHEN 'stat' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
         ro.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params
    );
    const pagination = buildPagination(total, listQuery.page, listQuery.limit);

    return {
      orders: result,
      pagination: {
        ...pagination,
        pages: pagination.totalPages,
      },
    };
  }

  async submitReport(id, data) {
    const { report, findings, impression, reported_by } = data;

    if (!report || !reported_by) {
      throw AppError.badRequest('Missing required fields: report, reported_by');
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (existing[0].status === 'cancelled') {
      throw AppError.badRequest('Cannot submit report for a cancelled order');
    }

    // Compose a full-report blob that captures the structured sections the old
    // API accepted but the DB has no columns for.
    const parts = [];
    if (findings) parts.push(`Findings:\n${findings}`);
    if (impression) parts.push(`Impression:\n${impression}`);
    parts.push(report);
    const fullReport = parts.join('\n\n');

    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders
       SET report = $1, radiologist = $2::uuid, report_completed_at = NOW(),
           status = 'completed', updated_at = NOW()
       WHERE id = $3
       RETURNING ${RAD_RETURNING}`,
      fullReport, reported_by, requireIntId(id)
    );

    logger.info('Radiology report submitted', { orderId: id, reported_by });
    return result[0];
  }

  async getPatientHistory(patientUid, filters = {}) {
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM radiology_orders WHERE patient_uid = $1::uuid`,
      patientUid
    );
    const total = parseInt(countResult[0].count, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT ${RAD_RETURNING}
       FROM radiology_orders
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
        pages: pagination.totalPages,
      },
    };
  }

  async getOrderDetail(id) {
    const result = await prisma.$queryRawUnsafe(
      `SELECT ${RAD_RETURNING}
       FROM radiology_orders
       WHERE id = $1`, requireIntId(id));
    if (result.length === 0) throw AppError.notFound('Radiology order not found');
    return result[0];
  }

  async cancelOrder(id, cancelledBy) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM radiology_orders WHERE id = $1`, requireIntId(id));
    if (existing.length === 0) throw AppError.notFound('Radiology order not found');
    if (existing[0].status === 'completed') {
      throw AppError.badRequest('Cannot cancel a completed order');
    }
    if (existing[0].status === 'cancelled') {
      throw AppError.badRequest('Order is already cancelled');
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE radiology_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1
       RETURNING ${RAD_RETURNING}`,
      requireIntId(id)
    );

    logger.info('Radiology order cancelled', { orderId: id, cancelledBy });
    return result[0];
  }
}

export default new RadiologyService();
