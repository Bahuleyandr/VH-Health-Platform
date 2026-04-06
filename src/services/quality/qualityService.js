// src/services/quality/qualityService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_INCIDENT_TYPES = ['fall', 'medication_error', 'infection', 'equipment_failure', 'near_miss', 'complaint', 'other'];
const VALID_SEVERITIES = ['minor', 'moderate', 'major', 'sentinel'];
const VALID_INCIDENT_STATUSES = ['reported', 'investigating', 'action_taken', 'resolved', 'closed'];
const VALID_INFECTION_SITES = ['surgical_site', 'bloodstream', 'urinary', 'respiratory', 'wound', 'other'];
const VALID_ISOLATION_TYPES = ['contact', 'droplet', 'airborne', 'protective'];

class QualityService {

  // ─── Incident Number Generator ───────────────────────────────────────────

  /**
   * Generate a unique incident number: INC-YYYYMM-XXXX
   */
  async _generateIncidentNumber() {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `INC-${yearMonth}-`;

    const result = await prisma.$queryRawUnsafe(
      `SELECT incident_number FROM quality_incidents
       WHERE incident_number LIKE $1
       ORDER BY id DESC LIMIT 1`,
      [`${prefix}%`]
    );

    let sequence = 1;
    if (result.length > 0) {
      const lastNumber = result[0].incident_number;
      const lastSeq = parseInt(lastNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) {
        sequence = lastSeq + 1;
      }
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  // ─── Quality Incidents ───────────────────────────────────────────────────

  /**
   * Report a new quality incident
   */
  async reportIncident(data) {
    const {
      reported_by, patient_uid, incident_type, severity,
      description, location, date_occurred
    } = data;

    if (!reported_by) {
      throw AppError.badRequest('reported_by is required');
    }
    if (!incident_type || !VALID_INCIDENT_TYPES.includes(incident_type)) {
      throw AppError.badRequest(`Invalid incident_type. Must be one of: ${VALID_INCIDENT_TYPES.join(', ')}`);
    }
    if (!severity || !VALID_SEVERITIES.includes(severity)) {
      throw AppError.badRequest(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
    }
    if (!description) {
      throw AppError.badRequest('description is required');
    }
    if (!date_occurred) {
      throw AppError.badRequest('date_occurred is required');
    }

    const incidentNumber = await this._generateIncidentNumber();

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO quality_incidents (
        incident_number, reported_by, patient_uid, incident_type, severity,
        description, location, date_occurred
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, incident_number, reported_by, patient_uid, incident_type,
        severity, description, location, date_occurred, status, created_at`,
      [
        incidentNumber, reported_by, patient_uid || null, incident_type,
        severity, description, location || null, date_occurred
      ]
    );

    logger.info(`Quality incident reported: ${incidentNumber} by ${reported_by}`);
    return result[0];
  }

  /**
   * Get incidents with filters
   */
  async getIncidents(filters = {}) {
    const { status, incident_type, severity, page = 1, limit = 20 } = filters;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (incident_type) {
      conditions.push(`incident_type = $${paramIndex++}`);
      params.push(incident_type);
    }
    if (severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(severity);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM quality_incidents ${whereClause}`,
      params
    );

    const total = parseInt(countResult[0].total, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, incident_number, reported_by, patient_uid, incident_type,
        severity, description, location, date_occurred, root_cause,
        corrective_action, preventive_action, status, investigated_by,
        resolved_at, created_at
       FROM quality_incidents ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, parseInt(limit, 10), offset]
    );

    return {
      incidents: result,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    };
  }

  /**
   * Update an existing incident (investigation, corrective actions, status)
   */
  async updateIncident(id, data) {
    const incidentId = parseInt(id, 10);
    if (isNaN(incidentId)) {
      throw AppError.badRequest('Invalid incident ID');
    }

    // Verify exists
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM quality_incidents WHERE id = $1`,
      [incidentId]
    );
    if (existing.length === 0) {
      throw AppError.notFound('Incident not found');
    }

    const {
      root_cause, corrective_action, preventive_action,
      status, investigated_by
    } = data;

    if (status && !VALID_INCIDENT_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_INCIDENT_STATUSES.join(', ')}`);
    }

    const resolvedAt = (status === 'resolved' || status === 'closed') ? new Date() : null;

    const result = await prisma.$queryRawUnsafe(
      `UPDATE quality_incidents SET
        root_cause = COALESCE($1, root_cause),
        corrective_action = COALESCE($2, corrective_action),
        preventive_action = COALESCE($3, preventive_action),
        status = COALESCE($4, status),
        investigated_by = COALESCE($5, investigated_by),
        resolved_at = COALESCE($6, resolved_at)
       WHERE id = $7
       RETURNING id, incident_number, reported_by, patient_uid, incident_type,
        severity, description, location, date_occurred, root_cause,
        corrective_action, preventive_action, status, investigated_by,
        resolved_at, created_at`,
      [
        root_cause || null, corrective_action || null, preventive_action || null,
        status || null, investigated_by || null, resolvedAt, incidentId
      ]
    );

    logger.info(`Quality incident ${incidentId} updated, status: ${status || 'unchanged'}`);
    return result[0];
  }

  /**
   * Quality dashboard metrics
   */
  async getQualityDashboard() {
    const totalResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM quality_incidents`
    );

    const openResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS open_count FROM quality_incidents
       WHERE status NOT IN ('resolved', 'closed')`
    );

    const byTypeResult = await prisma.$queryRawUnsafe(
      `SELECT incident_type, COUNT(*) AS count
       FROM quality_incidents
       GROUP BY incident_type
       ORDER BY count DESC`
    );

    const bySeverityResult = await prisma.$queryRawUnsafe(
      `SELECT severity, COUNT(*) AS count
       FROM quality_incidents
       GROUP BY severity
       ORDER BY count DESC`
    );

    const recentResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM quality_incidents
       WHERE created_at >= NOW() - INTERVAL '30 days'`
    );

    return {
      total_incidents: parseInt(totalResult[0].total, 10),
      open_incidents: parseInt(openResult[0].open_count, 10),
      last_30_days: parseInt(recentResult[0].count, 10),
      by_type: byTypeResult,
      by_severity: bySeverityResult,
    };
  }

  // ─── Infection Control ───────────────────────────────────────────────────

  /**
   * Report an infection case
   */
  async reportInfectionCase(data) {
    const {
      patient_uid, encounter_id, organism, infection_site,
      detection_date, culture_date, antibiotic_sensitivity,
      isolation_required, isolation_type, treatment_notes, reported_by
    } = data;

    if (!patient_uid) {
      throw AppError.badRequest('patient_uid is required');
    }
    if (!organism) {
      throw AppError.badRequest('organism is required');
    }
    if (!infection_site || !VALID_INFECTION_SITES.includes(infection_site)) {
      throw AppError.badRequest(`Invalid infection_site. Must be one of: ${VALID_INFECTION_SITES.join(', ')}`);
    }
    if (!detection_date) {
      throw AppError.badRequest('detection_date is required');
    }
    if (!reported_by) {
      throw AppError.badRequest('reported_by is required');
    }
    if (isolation_type && !VALID_ISOLATION_TYPES.includes(isolation_type)) {
      throw AppError.badRequest(`Invalid isolation_type. Must be one of: ${VALID_ISOLATION_TYPES.join(', ')}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO infection_cases (
        patient_uid, encounter_id, organism, infection_site,
        detection_date, culture_date, antibiotic_sensitivity,
        isolation_required, isolation_type, treatment_notes, reported_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, patient_uid, encounter_id, organism, infection_site,
        detection_date, culture_date, antibiotic_sensitivity,
        isolation_required, isolation_type, status, treatment_notes,
        reported_by, created_at`,
      [
        patient_uid, encounter_id || null, organism, infection_site,
        detection_date, culture_date || null,
        antibiotic_sensitivity ? JSON.stringify(antibiotic_sensitivity) : null,
        isolation_required || false, isolation_type || null,
        treatment_notes || null, reported_by
      ]
    );

    logger.info(`Infection case reported for patient ${patient_uid}, organism: ${organism}`);
    return result[0];
  }

  /**
   * Get infection surveillance data with filters
   */
  async getInfectionSurveillance(filters = {}) {
    const { status, organism, infection_site, page = 1, limit = 20 } = filters;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (organism) {
      conditions.push(`organism ILIKE $${paramIndex++}`);
      params.push(`%${organism}%`);
    }
    if (infection_site) {
      conditions.push(`infection_site = $${paramIndex++}`);
      params.push(infection_site);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM infection_cases ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0].total, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, organism, infection_site,
        detection_date, culture_date, antibiotic_sensitivity,
        isolation_required, isolation_type, status, treatment_notes,
        reported_by, created_at
       FROM infection_cases ${whereClause}
       ORDER BY detection_date DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, parseInt(limit, 10), offset]
    );

    // Summary stats
    const summaryResult = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active_cases,
         COUNT(*) FILTER (WHERE isolation_required = true AND status = 'active') AS isolation_count,
         COUNT(DISTINCT organism) AS unique_organisms
       FROM infection_cases`
    );

    return {
      cases: result,
      summary: summaryResult[0],
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    };
  }

  /**
   * Get outbreak alerts — clusters of same organism in short time window
   */
  async getOutbreakAlerts() {
    // Flag organisms with 3+ active cases in the last 14 days
    const result = await prisma.$queryRawUnsafe(
      `SELECT organism, infection_site, COUNT(*) AS case_count,
        MIN(detection_date) AS first_detected,
        MAX(detection_date) AS last_detected,
        COUNT(*) FILTER (WHERE isolation_required = true) AS isolation_count
       FROM infection_cases
       WHERE detection_date >= CURRENT_DATE - INTERVAL '14 days'
         AND status = 'active'
       GROUP BY organism, infection_site
       HAVING COUNT(*) >= 3
       ORDER BY case_count DESC`
    );

    // Also get total active cases
    const totalActive = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM infection_cases WHERE status = 'active'`
    );

    return {
      alerts: result,
      total_active_cases: parseInt(totalActive[0].total, 10),
      threshold: 3,
      window_days: 14,
    };
  }
}

export default new QualityService();
