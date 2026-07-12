// src/services/bloodbank/bloodBankService.js

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { assertBedsideVerified } from './transfusionSafetyService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const VALID_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const VALID_COMPONENTS = ['whole_blood', 'prbc', 'ffp', 'platelets', 'cryoprecipitate'];
const VALID_URGENCIES = ['routine', 'urgent', 'emergency'];

const BLOOD_REQUEST_RETURNING = `id, patient_uid, encounter_id, blood_group, component, units,
    urgency, clinical_indication, cross_match_status, cross_matched_by, cross_matched_at,
    issued_by, issued_at, transfused_at, status, tenant_id, ordered_by, notes, created_at, updated_at`;

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for blood-bank operations', 'BLOOD_BANK_TENANT_REQUIRED');
  }
  return tenantId;
}

async function assertPatientInTenant(patientUid, tenantId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid AND is_active = true
      LIMIT 1`,
    patientUid,
    tenantId,
  );
  if (!rows.length) {
    throw AppError.notFound('Patient not found in tenant', 'BLOOD_BANK_PATIENT_NOT_FOUND');
  }
}

async function recordRequiredBloodEvent(tx, request, previous, {
  eventType,
  eventStatus,
  actorUid,
  actorRole,
  summary,
  payload = {},
}) {
  const event = await recordCanonicalClinicalEvent({
    tenantId: request.tenant_id,
    patientUid: request.patient_uid,
    encounterId: request.encounter_id,
    eventType,
    eventSubtype: request.component,
    eventStatus: eventStatus || request.status,
    sourceTable: 'blood_requests',
    sourceId: request.id,
    resourceType: 'blood_request',
    resourceId: request.id,
    actorUid,
    actorRole,
    summary,
    payload: {
      blood_group: request.blood_group,
      component: request.component,
      units: request.units,
      urgency: request.urgency,
      ...payload,
    },
    beforeState: previous,
    afterState: request,
    timelineIdempotencyKey: `blood_requests:${request.id}:${eventType}:${request.updated_at?.toISOString?.() || 'now'}`,
    auditIdempotencyKey: `blood_requests:${request.id}:audit:${eventType}:${request.updated_at?.toISOString?.() || 'now'}`,
  }, { db: tx });
  if (!event?.timeline?.id || !event?.audit?.id) {
    throw AppError.internal(
      'Blood-bank write requires canonical timeline and audit events',
      'BLOOD_BANK_CANONICAL_EVENT_REQUIRED',
    );
  }
}

class BloodBankService {

  /**
   * Create a new blood request
   */
  async createRequest(data, context = {}) {
    const {
      patient_uid, encounter_id, blood_group, component,
      units, urgency = 'routine', clinical_indication, ordered_by
    } = data;
    const tenantId = requireTenantId(context.tenantId);

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
    const request = await setTenantTx(tenantId, async (tx) => {
      await assertPatientInTenant(patient_uid, tenantId, tx);
      const result = await tx.$queryRawUnsafe(
        `INSERT INTO blood_requests
          (tenant_id, patient_uid, encounter_id, blood_group, component, units, urgency,
           clinical_indication, cross_match_status, status, ordered_by, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'pending', 'requested', $9::uuid, NOW(), NOW())
         RETURNING ${BLOOD_REQUEST_RETURNING}`,
        tenantId, patient_uid, encounter_id || null, blood_group, component, units, urgency,
        clinical_indication, ordered_by
      );
      await recordRequiredBloodEvent(tx, result[0], null, {
        eventType: 'transfusion.requested',
        actorUid: context.actorUid || ordered_by,
        actorRole: context.actorRole || null,
        summary: `${units} unit${units === 1 ? '' : 's'} of ${component} requested`,
        payload: { clinical_indication },
      });
      return result[0];
    });

    logger.info('Blood request created', { requestId: request.id, tenantId, blood_group, component, units, urgency });
    return request;
  }

  /**
   * Record cross-match result
   */
  async crossMatch(id, data, context = {}) {
    const { cross_match_status, cross_matched_by } = data;
    const tenantId = requireTenantId(context.tenantId);

    if (!cross_match_status || !cross_matched_by) {
      throw AppError.badRequest('Missing required fields: cross_match_status, cross_matched_by');
    }
    if (!['compatible', 'incompatible'].includes(cross_match_status)) {
      throw AppError.badRequest('cross_match_status must be compatible or incompatible');
    }

    const request = await setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${BLOOD_REQUEST_RETURNING} FROM blood_requests
          WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
        parseInt(id, 10),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Blood request not found');
      if (existing[0].status !== 'requested') {
        throw AppError.badRequest('Cross-match can only be performed on requests with status "requested"');
      }

      const result = await tx.$queryRawUnsafe(
        `UPDATE blood_requests
         SET cross_match_status = $1, cross_matched_by = $2::uuid, cross_matched_at = NOW(),
             status = 'cross_matched', updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4::uuid
         RETURNING ${BLOOD_REQUEST_RETURNING}`,
        cross_match_status, cross_matched_by, parseInt(id, 10), tenantId
      );
      await recordRequiredBloodEvent(tx, result[0], existing[0], {
        eventType: 'transfusion.crossmatched',
        actorUid: context.actorUid || cross_matched_by,
        actorRole: context.actorRole || null,
        summary: `Blood request cross-match recorded as ${cross_match_status}`,
        payload: { cross_match_status },
      });
      return result[0];
    });

    logger.info('Blood cross-match recorded', { requestId: id, tenantId, cross_match_status, cross_matched_by });
    return request;
  }

  /**
   * Issue blood to patient
   */
  async issueBlood(id, data, context = {}) {
    const { issued_by } = data;
    const tenantId = requireTenantId(context.tenantId);

    if (!issued_by) throw AppError.badRequest('Missing required field: issued_by');

    const request = await setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${BLOOD_REQUEST_RETURNING} FROM blood_requests
          WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
        parseInt(id, 10),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Blood request not found');
      if (existing[0].status !== 'cross_matched') {
        throw AppError.badRequest('Blood can only be issued after cross-matching');
      }
      if (existing[0].cross_match_status !== 'compatible') {
        throw AppError.badRequest('Cannot issue blood with incompatible cross-match result');
      }

      const result = await tx.$queryRawUnsafe(
        `UPDATE blood_requests
         SET issued_by = $1::uuid, issued_at = NOW(), status = 'issued', updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid
         RETURNING ${BLOOD_REQUEST_RETURNING}`,
        issued_by, parseInt(id, 10), tenantId
      );
      await recordRequiredBloodEvent(tx, result[0], existing[0], {
        eventType: 'transfusion.issued',
        actorUid: context.actorUid || issued_by,
        actorRole: context.actorRole || null,
        summary: 'Blood issued for transfusion',
      });
      return result[0];
    });

    logger.info('Blood issued', { requestId: id, tenantId, issued_by });
    return request;
  }

  /**
   * Record transfusion completion. `transfusion_reaction` (if any) is appended to `notes`
   * because the table has no dedicated column for it.
   */
  async recordTransfusion(id, data, context = {}) {
    const { transfusion_reaction, verification_override_reason } = data;
    const tenantId = requireTenantId(context.tenantId);

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM blood_requests WHERE id = $1 AND tenant_id = $2::uuid`,
      parseInt(id, 10),
      tenantId,
    );
    if (existing.length === 0) throw AppError.notFound('Blood request not found');
    if (existing[0].status !== 'issued') {
      throw AppError.badRequest('Transfusion can only be recorded for issued blood');
    }

    // Roadmap B5 — the legacy completion path honours the same two-person
    // bedside verification gate as the closed-loop endpoints. Unit-less
    // legacy requests (nothing to scan) need an explicit audited override.
    await assertBedsideVerified(parseInt(id, 10), {
      tenantId,
      legacyOverrideReason: verification_override_reason || null,
    });

    const reactionNote = transfusion_reaction
      ? `Transfusion reaction: ${typeof transfusion_reaction === 'string' ? transfusion_reaction : JSON.stringify(transfusion_reaction)}`
      : null;

    const request = await setTenantTx(tenantId, async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        `SELECT ${BLOOD_REQUEST_RETURNING} FROM blood_requests
          WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
        parseInt(id, 10),
        tenantId,
      );
      if (locked.length === 0) throw AppError.notFound('Blood request not found');
      if (locked[0].status !== 'issued') {
        throw AppError.badRequest('Transfusion can only be recorded for issued blood');
      }
      const result = await tx.$queryRawUnsafe(
        `UPDATE blood_requests
         SET transfused_at = NOW(),
             status = 'transfused',
             notes = CASE WHEN $1::text IS NOT NULL
                          THEN COALESCE(notes || E'\n', '') || $1::text
                          ELSE notes END,
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid
         RETURNING ${BLOOD_REQUEST_RETURNING}`,
        reactionNote, parseInt(id, 10), tenantId
      );
      await recordRequiredBloodEvent(tx, result[0], locked[0], {
        eventType: 'transfusion.completed',
        actorUid: context.actorUid || null,
        actorRole: context.actorRole || null,
        summary: 'Blood transfusion completed',
        payload: {
          transfusion_reaction: transfusion_reaction || null,
          verification_override_reason: verification_override_reason || null,
        },
      });
      return result[0];
    });

    logger.info('Transfusion recorded', { requestId: id, tenantId, hasReaction: !!transfusion_reaction });
    return request;
  }

  /**
   * Get blood inventory summary (aggregated from requests)
   */
  async getInventory(context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    return prisma.$queryRawUnsafe(
      `SELECT blood_group, component,
              SUM(CASE WHEN status = 'requested' THEN units ELSE 0 END)::int as requested_units,
              SUM(CASE WHEN status = 'cross_matched' THEN units ELSE 0 END)::int as cross_matched_units,
              SUM(CASE WHEN status = 'issued' THEN units ELSE 0 END)::int as issued_units,
              SUM(CASE WHEN status = 'transfused' THEN units ELSE 0 END)::int as transfused_units,
              COUNT(*)::int as total_requests
       FROM blood_requests
       WHERE tenant_id = $1::uuid AND status != 'cancelled'
       GROUP BY blood_group, component
       ORDER BY blood_group, component`,
      tenantId,
    );
  }

  /**
   * Get pending blood requests (not yet issued)
   */
  async getPendingRequests(filters = {}, context = {}) {
    const { blood_group, urgency } = filters;
    const tenantId = requireTenantId(context.tenantId);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'created_at'
    });
    const conditions = [`tenant_id = $1::uuid`, `status IN ('requested', 'cross_matched')`];
    const params = [tenantId];

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
      pagination
    };
  }
}

export default new BloodBankService();
