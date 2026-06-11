// src/services/quality/qualityService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_INCIDENT_TYPES = ['fall', 'medication_error', 'infection', 'equipment_failure', 'near_miss', 'complaint', 'other'];
const VALID_SEVERITIES = ['minor', 'moderate', 'major', 'sentinel'];
const SEVERITY_ALIASES = {
  LOW: 'minor',
  MEDIUM: 'moderate',
  HIGH: 'major',
  CRITICAL: 'sentinel',
};
const VALID_INCIDENT_STATUSES = ['reported', 'investigating', 'action_taken', 'resolved', 'closed'];
const VALID_INFECTION_SITES = ['surgical_site', 'bloodstream', 'urinary', 'respiratory', 'wound', 'other'];
const VALID_ISOLATION_TYPES = ['contact', 'droplet', 'airborne', 'protective'];

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for quality operations', 'QUALITY_TENANT_REQUIRED');
  }
  return tenantId;
}

function normalizeIncidentSeverity(severity) {
  const normalized = typeof severity === 'string' ? severity.trim() : severity;
  return SEVERITY_ALIASES[normalized?.toUpperCase?.()] || normalized;
}

async function assertPatientInTenant(patientUid, tenantId) {
  if (!patientUid) return;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid AND is_active = true
      LIMIT 1`,
    patientUid,
    tenantId
  );
  if (!rows.length) {
    throw AppError.notFound('Patient not found in tenant', 'QUALITY_PATIENT_NOT_FOUND');
  }
}

class QualityService {

  // ─── Incident Number Generator ───────────────────────────────────────────

  /**
   * Generate a unique incident number: INC-YYYYMM-XXXX
   */
  async _generateIncidentNumber(tenantId) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const tenantFragment = tenantId.replace(/-/g, '').toUpperCase();
    const prefix = `INC-${yearMonth}-${tenantFragment}-`;

    const result = await prisma.$queryRawUnsafe(
      `SELECT incident_number FROM quality_incidents
       WHERE tenant_id = $1::uuid
         AND incident_number LIKE $2
       ORDER BY id DESC LIMIT 1`,
      tenantId,
      `${prefix}%`
    );

    let sequence = 1;
    if (result.length > 0) {
      const lastNumber = result[0].incident_number;
      const lastSeq = parseInt(lastNumber.split('-').at(-1), 10);
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
      description, location, date_occurred, tenantId
    } = data;
    const resolvedTenantId = requireTenantId(tenantId);
    const normalizedSeverity = normalizeIncidentSeverity(severity);

    if (!reported_by) {
      throw AppError.badRequest('reported_by is required');
    }
    if (!incident_type || !VALID_INCIDENT_TYPES.includes(incident_type)) {
      throw AppError.badRequest(`Invalid incident_type. Must be one of: ${VALID_INCIDENT_TYPES.join(', ')}`);
    }
    if (!normalizedSeverity || !VALID_SEVERITIES.includes(normalizedSeverity)) {
      throw AppError.badRequest(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
    }
    if (!description) {
      throw AppError.badRequest('description is required');
    }
    if (!date_occurred) {
      throw AppError.badRequest('date_occurred is required');
    }

    await assertPatientInTenant(patient_uid, resolvedTenantId);

    const incidentNumber = await this._generateIncidentNumber(resolvedTenantId);

    const incident = await prisma.quality_incidents.create({
      data: {
        incident_number: incidentNumber,
        tenant_id: resolvedTenantId,
        reported_by,
        patient_uid: patient_uid || null,
        incident_type,
        severity: normalizedSeverity,
        description,
        location: location || null,
        date_occurred: new Date(date_occurred),
      },
      select: {
        id: true,
        incident_number: true,
        reported_by: true,
        patient_uid: true,
        incident_type: true,
        severity: true,
        description: true,
        location: true,
        date_occurred: true,
        status: true,
        tenant_id: true,
        created_at: true,
      },
    });

    logger.info(`Quality incident reported: ${incidentNumber} by ${reported_by}`);
    return incident;
  }

  /**
   * Get incidents with filters
   */
  async getIncidents(filters = {}) {
    const { status, incident_type, severity, tenantId } = filters;
    const resolvedTenantId = requireTenantId(tenantId);
    const normalizedSeverity = normalizeIncidentSeverity(severity);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });
    const conditions = ['tenant_id = $1::uuid'];
    const params = [resolvedTenantId];
    let paramIndex = 2;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (incident_type) {
      conditions.push(`incident_type = $${paramIndex++}`);
      params.push(incident_type);
    }
    if (normalizedSeverity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(normalizedSeverity);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM quality_incidents ${whereClause}`,
      ...params
    );

    const total = parseInt(countResult[0].total, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, incident_number, reported_by, patient_uid, incident_type,
        severity, description, location, date_occurred, root_cause,
        corrective_action, preventive_action, status, investigated_by,
        resolved_at, tenant_id, created_at
       FROM quality_incidents ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      ...params, listQuery.limit, listQuery.offset
    );

    return {
      incidents: result,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }

  /**
   * Update an existing incident (investigation, corrective actions, status)
   */
  async updateIncident(id, data) {
    const tenantId = requireTenantId(data.tenantId);
    const incidentId = parseInt(id, 10);
    if (isNaN(incidentId)) {
      throw AppError.badRequest('Invalid incident ID');
    }

    const existing = await prisma.quality_incidents.findFirst({
      where: { id: incidentId, tenant_id: tenantId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw AppError.notFound('Incident not found');
    }

    const {
      root_cause, corrective_action, preventive_action,
      status, investigated_by
    } = data;

    if (status && !VALID_INCIDENT_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_INCIDENT_STATUSES.join(', ')}`);
    }

    // COALESCE semantics: only update fields the caller supplied.
    const updateData = { updated_at: new Date() };
    if (root_cause != null) updateData.root_cause = root_cause;
    if (corrective_action != null) updateData.corrective_action = corrective_action;
    if (preventive_action != null) updateData.preventive_action = preventive_action;
    if (status != null) updateData.status = status;
    if (investigated_by != null) updateData.investigated_by = investigated_by;
    if (status === 'resolved' || status === 'closed') updateData.resolved_at = new Date();

    const incident = await prisma.quality_incidents.update({
      where: { id: existing.id },
      data: updateData,
      select: {
        id: true,
        incident_number: true,
        reported_by: true,
        patient_uid: true,
        incident_type: true,
        severity: true,
        description: true,
        location: true,
        date_occurred: true,
        root_cause: true,
        corrective_action: true,
        preventive_action: true,
        status: true,
        investigated_by: true,
        resolved_at: true,
        tenant_id: true,
        created_at: true,
      },
    });

    logger.info(`Quality incident ${incidentId} updated, status: ${status || 'unchanged'}`);
    return incident;
  }

  /**
   * Quality dashboard metrics
   */
  async getQualityDashboard(filters = {}) {
    const tenantId = requireTenantId(filters.tenantId);
    const totalResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM quality_incidents WHERE tenant_id = $1::uuid`,
      tenantId
    );

    const openResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS open_count FROM quality_incidents
       WHERE tenant_id = $1::uuid
         AND status NOT IN ('resolved', 'closed')`,
      tenantId
    );

    const byTypeResult = await prisma.$queryRawUnsafe(
      `SELECT incident_type, COUNT(*) AS count
       FROM quality_incidents
       WHERE tenant_id = $1::uuid
       GROUP BY incident_type
       ORDER BY count DESC`,
      tenantId
    );

    const bySeverityResult = await prisma.$queryRawUnsafe(
      `SELECT severity, COUNT(*) AS count
       FROM quality_incidents
       WHERE tenant_id = $1::uuid
       GROUP BY severity
       ORDER BY count DESC`,
      tenantId
    );

    const recentResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM quality_incidents
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - INTERVAL '30 days'`,
      tenantId
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
      isolation_required, isolation_type, treatment_notes, reported_by,
      tenantId
    } = data;
    const resolvedTenantId = requireTenantId(tenantId);

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

    await assertPatientInTenant(patient_uid, resolvedTenantId);

    const infectionCase = await prisma.infection_cases.create({
      data: {
        tenant_id: resolvedTenantId,
        patient_uid,
        encounter_id: encounter_id || null,
        organism,
        infection_site,
        detection_date: new Date(detection_date),
        culture_date: culture_date ? new Date(culture_date) : null,
        // Prisma handles JSONB serialisation — pass the object/value
        // directly, no manual JSON.stringify needed.
        antibiotic_sensitivity: antibiotic_sensitivity ?? null,
        isolation_required: isolation_required || false,
        isolation_type: isolation_type || null,
        treatment_notes: treatment_notes || null,
        reported_by,
      },
      select: {
        id: true,
        patient_uid: true,
        encounter_id: true,
        organism: true,
        infection_site: true,
        detection_date: true,
        culture_date: true,
        antibiotic_sensitivity: true,
        isolation_required: true,
        isolation_type: true,
        status: true,
        treatment_notes: true,
        reported_by: true,
        tenant_id: true,
        created_at: true,
      },
    });

    logger.info(`Infection case reported for patient ${patient_uid}, organism: ${organism}`);
    return infectionCase;
  }

  /**
   * Get infection surveillance data with filters
   */
  async getInfectionSurveillance(filters = {}) {
    const { status, organism, infection_site, tenantId } = filters;
    const resolvedTenantId = requireTenantId(tenantId);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'detection_date'
    });
    const conditions = ['tenant_id = $1::uuid'];
    const params = [resolvedTenantId];
    let paramIndex = 2;

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

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM infection_cases ${whereClause}`,
      ...params
    );
    const total = parseInt(countResult[0].total, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, encounter_id, organism, infection_site,
        detection_date, culture_date, antibiotic_sensitivity,
        isolation_required, isolation_type, status, treatment_notes,
        reported_by, tenant_id, created_at
       FROM infection_cases ${whereClause}
       ORDER BY detection_date DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      ...params, listQuery.limit, listQuery.offset
    );

    // Summary stats
    const summaryResult = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active_cases,
         COUNT(*) FILTER (WHERE isolation_required = true AND status = 'active') AS isolation_count,
         COUNT(DISTINCT organism) AS unique_organisms
       FROM infection_cases
       WHERE tenant_id = $1::uuid`,
      resolvedTenantId
    );

    return {
      cases: result,
      summary: summaryResult[0],
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }

  /**
   * Get outbreak alerts — clusters of same organism in short time window
   */
  async getOutbreakAlerts(filters = {}) {
    const tenantId = requireTenantId(filters.tenantId);
    // Flag organisms with 3+ active cases in the last 14 days
    const result = await prisma.$queryRawUnsafe(
      `SELECT organism, infection_site, COUNT(*) AS case_count,
        MIN(detection_date) AS first_detected,
        MAX(detection_date) AS last_detected,
        COUNT(*) FILTER (WHERE isolation_required = true) AS isolation_count
       FROM infection_cases
       WHERE tenant_id = $1::uuid
         AND detection_date >= CURRENT_DATE - INTERVAL '14 days'
         AND status = 'active'
       GROUP BY organism, infection_site
       HAVING COUNT(*) >= 3
       ORDER BY case_count DESC`,
      tenantId
    );

    // Also get total active cases
    const totalActive = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM infection_cases
       WHERE tenant_id = $1::uuid
         AND status = 'active'`,
      tenantId
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
