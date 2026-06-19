// src/services/referral/referralService.js

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { DEFAULT_TENANT_ID, requireTenantId } from '../tenant/tenantService.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import {
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from '../clinical/canonicalClinicalPlatformService.js';

const VALID_REFERRAL_TYPES = ['internal', 'external'];
const VALID_URGENCIES = ['routine', 'urgent', 'emergency'];
const ACTIVE_REFERRAL_STATUSES = ['pending', 'accepted', 'in_progress'];
const DOCTOR_ROLES = [
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
  'ANAESTHETIST',
  'ANESTHETIST',
  'MEDICAL_SUPERINTENDENT',
];
const REFERRAL_ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const WARD_REFERRAL_ROLES = [
  'CNO',
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
];

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeRole(value) {
  return cleanText(value).toUpperCase();
}

function normalizeTenantId(value) {
  return requireTenantId(cleanText(value));
}

function priorityForUrgency(urgency) {
  const normalized = cleanText(urgency || 'routine').toLowerCase();
  if (normalized === 'emergency') return 'EMERGENCY';
  if (normalized === 'urgent') return 'URGENT';
  return 'ROUTINE';
}

function notificationPriorityForUrgency(urgency) {
  const normalized = cleanText(urgency || 'routine').toLowerCase();
  return normalized === 'routine' ? 'MEDIUM' : 'HIGH';
}

async function bestEffortReferralCanonical(label, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`Canonical referral event failed during ${label}: ${err?.message || err}`);
    return null;
  }
}

// Shared `select` for state-transition returns (accept / complete / decline).
// Keeping the shape consistent means callers don't need to branch on which
// action produced the row.
const REFERRAL_STATE_SELECT = {
  id: true,
  referral_number: true,
  patient_uid: true,
  encounter_id: true,
  referring_doctor: true,
  referred_to_doctor: true,
  referred_to_department: true,
  referral_type: true,
  tenant_id: true,
  reason: true,
  urgency: true,
  clinical_summary: true,
  status: true,
  accepted_by: true,
  accepted_at: true,
  completed_at: true,
  response_notes: true,
  first_seen_at: true,
  first_seen_by: true,
  requester_id: true,
  performer_id: true,
  source: true,
  created_at: true,
};

// Columns returned by the three list views (getIncomingReferrals /
// getOutgoingReferrals / getPatientReferrals). Superset of REFERRAL_STATE_SELECT
// with `encounter_id` — which the list views include but the mutation returns
// don't.
const REFERRAL_LIST_SELECT = {
  ...REFERRAL_STATE_SELECT,
  encounter_id: true,
};

class ReferralService {

  /**
   * Generate a unique referral number: REF-YYYYMM-XXXX
   */
  async _generateReferralNumber() {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `REF-${yearMonth}-`;

    const result = await prisma.$queryRawUnsafe(
      `SELECT referral_number FROM referrals
       WHERE referral_number LIKE $1
       ORDER BY id DESC LIMIT 1`,
      `${prefix}%`
    );

    let sequence = 1;
    if (result.length > 0) {
      const lastNumber = result[0].referral_number;
      const lastSeq = parseInt(lastNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) {
        sequence = lastSeq + 1;
      }
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  async _resolveReferringDoctor({ tenantId, patientUid, proposedDoctorUid, requesterUid, actorRole }) {
    const normalizedRole = normalizeRole(actorRole);
    if (proposedDoctorUid && REFERRAL_ADMIN_ROLES.includes(normalizedRole)) {
      return proposedDoctorUid;
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT admitting_doctor, attending_doctor
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND COALESCE(status, '') NOT IN ('DISCHARGED', 'CANCELLED')
        ORDER BY admitted_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      normalizeTenantId(tenantId),
      patientUid,
    );
    const admission = rows[0] || {};
    return admission.attending_doctor || admission.admitting_doctor || proposedDoctorUid || requesterUid;
  }

  async _assertCanCreateForPatient({ tenantId, patientUid, requesterUid, actorRole, proposedDoctorUid }) {
    const normalizedRole = normalizeRole(actorRole);
    const tenant = normalizeTenantId(tenantId);
    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT uid
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND role = 'PATIENT'
          AND COALESCE(is_active, true) = true
        LIMIT 1`,
      tenant,
      patientUid,
    );
    if (!patientRows.length) throw AppError.notFound('Patient not found');

    if (REFERRAL_ADMIN_ROLES.includes(normalizedRole)) return;

    if (proposedDoctorUid && requesterUid
        && String(proposedDoctorUid).toLowerCase() !== String(requesterUid).toLowerCase()) {
      throw AppError.forbidden('Only admins may create referrals on behalf of another doctor');
    }

    const doctorScoped = DOCTOR_ROLES.includes(normalizedRole);
    const wardScoped = WARD_REFERRAL_ROLES.includes(normalizedRole);
    const relationshipRows = await prisma.$queryRawUnsafe(
      `WITH admission_rel AS (
         SELECT id
           FROM admissions
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND COALESCE(status, '') NOT IN ('DISCHARGED', 'CANCELLED', 'discharged', 'cancelled')
            AND (
              $4::boolean = TRUE
              OR (
                $5::boolean = TRUE
                AND $3::uuid IS NOT NULL
                AND (
                  admitting_doctor = $3::uuid
                  OR attending_doctor = $3::uuid
                )
              )
            )
          LIMIT 1
       ),
       care_team_rel AS (
         SELECT ctm.id
           FROM care_team_members ctm
           JOIN care_teams ct ON ct.id = ctm.care_team_id
          WHERE ctm.tenant_id = $1::uuid
            AND ct.tenant_id = $1::uuid
            AND ct.patient_uid = $2::uuid
            AND ctm.staff_uid = $3::uuid
            AND ct.status = 'active'
            AND ctm.status = 'active'
            AND ctm.active_from <= NOW()
            AND (ctm.active_until IS NULL OR ctm.active_until >= NOW())
          LIMIT 1
       )
       SELECT 'admission' AS source FROM admission_rel
       UNION ALL
       SELECT 'care_team' AS source FROM care_team_rel
       LIMIT 1`,
      tenant,
      patientUid,
      requesterUid || null,
      wardScoped,
      doctorScoped,
    );
    if (!relationshipRows.length) {
      throw AppError.forbidden('Referral creation requires an active patient relationship');
    }
  }

  async searchConsultants({ tenantId = DEFAULT_TENANT_ID, q = '', department = '', limit = 25 } = {}) {
    const query = cleanText(q).toLowerCase();
    const dept = cleanText(department).toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 25, 100));

    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.uid,
              u.id AS user_id,
              COALESCE(NULLIF(TRIM(d.name), ''), u.name) AS name,
              u.role,
              COALESCE(NULLIF(TRIM(dept.name), ''), NULLIF(TRIM(d.department), ''), NULLIF(TRIM(s.department), '')) AS department,
              NULLIF(TRIM(d.specialty), '') AS specialty
         FROM users u
         JOIN doctors d ON d.user_id = u.id
         LEFT JOIN departments dept ON dept.id = d.department_id
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
          AND COALESCE(u.is_active, true) = true
          AND COALESCE(d.is_active, true) = true
          AND UPPER(u.role) = ANY($2::text[])
          AND (
            $3::text = ''
            OR LOWER(COALESCE(d.name, u.name, '')) LIKE '%' || $3::text || '%'
            OR LOWER(COALESCE(d.specialty, '')) LIKE '%' || $3::text || '%'
            OR LOWER(COALESCE(d.department, dept.name, s.department, '')) LIKE '%' || $3::text || '%'
          )
          AND (
            $4::text = ''
            OR LOWER(COALESCE(d.department, dept.name, s.department, '')) LIKE '%' || $4::text || '%'
            OR LOWER(COALESCE(d.specialty, '')) LIKE '%' || $4::text || '%'
          )
        ORDER BY COALESCE(dept.name, d.department, s.department, ''), COALESCE(d.name, u.name)
        LIMIT $5::int`,
      normalizeTenantId(tenantId),
      DOCTOR_ROLES,
      query,
      dept,
      safeLimit,
    );

    return rows;
  }

  async _notifyReferralRecipients(referral) {
    try {
      const recipientUids = referral.referred_to_doctor
        ? [referral.referred_to_doctor]
        : (await this.searchConsultants({
          tenantId: referral.tenant_id,
          department: referral.referred_to_department,
          limit: 50,
        })).map((row) => row.uid);

      if (!recipientUids.length) return { notification_count: 0, recipients: [] };

      return sendStaffNotifications({
        tenantId: referral.tenant_id,
        recipientUids,
        excludeUids: [referral.requester_id, referral.referring_doctor].filter(Boolean),
        title: 'New ward referral',
        body: `${referral.referred_to_department} referral requested: ${referral.reason}`,
        type: 'REFERRAL',
        priority: notificationPriorityForUrgency(referral.urgency),
        relatedId: referral.id,
        data: {
          event_type: 'ward_referral_requested',
          referral_id: referral.id,
          referral_number: referral.referral_number,
          patient_uid: referral.patient_uid,
          urgency: referral.urgency,
          route: '/referrals',
        },
      });
    } catch (err) {
      logger.warn('Referral notification dispatch failed', {
        referralId: referral?.id,
        error: err?.message || err,
      });
      return { notification_count: 0, recipients: [] };
    }
  }

  /**
   * Create a new referral
   */
  async createReferral(data) {
    const {
      patient_uid, encounter_id, referring_doctor,
      referred_to_doctor, referred_to_department,
      referral_type, reason, urgency, clinical_summary,
      requester_id, performer_id, tenant_id, actor_role,
      source, request_context
    } = data;
    const tenantId = normalizeTenantId(tenant_id);
    const requesterUid = requester_id || referring_doctor;

    if (!patient_uid) {
      throw AppError.badRequest('patient_uid is required');
    }
    if (!requesterUid) {
      throw AppError.badRequest('requester_id is required');
    }
    if (!referred_to_department) {
      throw AppError.badRequest('referred_to_department is required');
    }
    if (!reason) {
      throw AppError.badRequest('reason is required');
    }
    if (referral_type && !VALID_REFERRAL_TYPES.includes(referral_type)) {
      throw AppError.badRequest(`Invalid referral_type. Must be one of: ${VALID_REFERRAL_TYPES.join(', ')}`);
    }
    if (urgency && !VALID_URGENCIES.includes(urgency)) {
      throw AppError.badRequest(`Invalid urgency. Must be one of: ${VALID_URGENCIES.join(', ')}`);
    }

    await this._assertCanCreateForPatient({
      tenantId,
      patientUid: patient_uid,
      requesterUid,
      actorRole: actor_role,
      proposedDoctorUid: referring_doctor,
    });

    const referralNumber = await this._generateReferralNumber();
    const resolvedReferringDoctor = await this._resolveReferringDoctor({
      tenantId,
      patientUid: patient_uid,
      proposedDoctorUid: referring_doctor,
      requesterUid,
      actorRole: actor_role,
    });
    if (!resolvedReferringDoctor) {
      throw AppError.badRequest('An active admission doctor is required for ward referrals');
    }

    // Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md)
    // + Phase 0/1 transaction rule (apps/backend CLAUDE.md): the referral detail
    // row, its canonical referral.requested timeline + audit event, and the
    // referral_response SLA start are ONE atomic unit. Previously the canonical
    // event + SLA-start ran post-commit inside bestEffortReferralCanonical, so an
    // SLA-start failure was silently swallowed — a referral could exist with no
    // response-time clock and no timeline row (the safety artifact vanished).
    // Emitting them on `tx` (via { db: tx }) means a canonical/SLA failure rolls
    // the referral back rather than leaving an orphan. Pre-flight lookups
    // (_assertCanCreateForPatient / _generateReferralNumber / _resolveReferringDoctor)
    // already ran on plain prisma above (Phase 0) so a not-found surfaces as 4xx,
    // not a 500 inside the tx.
    const referral = await setTenantTx(tenantId, async (tx) => {
      // Prisma ORM — column names validated at runtime against schema.prisma.
      // Defaults for status ('pending') come from the schema itself, so we
      // don't set them here.
      const created = await tx.referrals.create({
        data: {
          referral_number: referralNumber,
          tenant_id: tenantId,
          patient_uid,
          encounter_id: encounter_id || null,
          referring_doctor: resolvedReferringDoctor,
          referred_to_doctor: referred_to_doctor || null,
          referred_to_department,
          referral_type: referral_type || 'internal',
          reason,
          urgency: urgency || 'routine',
          priority: priorityForUrgency(urgency),
          clinical_summary: clinical_summary || null,
          requester_id: requesterUid || null,
          performer_id: performer_id || referred_to_doctor || null,
          source: source || 'ward',
          request_context: request_context || {},
        },
        select: {
          id: true,
          referral_number: true,
          tenant_id: true,
          patient_uid: true,
          encounter_id: true,
          referring_doctor: true,
          referred_to_doctor: true,
          referred_to_department: true,
          referral_type: true,
          reason: true,
          urgency: true,
          clinical_summary: true,
          status: true,
          priority: true,
          requester_id: true,
          performer_id: true,
          first_seen_at: true,
          first_seen_by: true,
          source: true,
          created_at: true,
        },
      });

      await recordCanonicalClinicalEvent({
        tenantId,
        patientUid: created.patient_uid,
        encounterId: created.encounter_id,
        eventType: 'referral.requested',
        eventSubtype: created.referred_to_department,
        eventStatus: created.status,
        sourceTable: 'referrals',
        sourceId: created.id,
        resourceType: 'referral',
        resourceId: created.id,
        actorUid: requesterUid,
        actorRole: actor_role,
        summary: `Referral requested to ${created.referred_to_department}`,
        payload: {
          referral_number: created.referral_number,
          referred_to_doctor: created.referred_to_doctor,
          referred_to_department: created.referred_to_department,
          urgency: created.urgency,
          reason: created.reason,
          clinical_summary: created.clinical_summary,
          source: created.source,
        },
        afterState: created,
      }, { db: tx });
      await startWorkflowSla({
        tenantId,
        ruleCode: 'referral_response',
        patientUid: created.patient_uid,
        encounterId: created.encounter_id,
        sourceTable: 'referrals',
        sourceId: created.id,
        priority: created.priority || created.urgency || 'normal',
        assignedUserUid: created.referred_to_doctor,
        metadata: {
          referral_number: created.referral_number,
          referred_to_department: created.referred_to_department,
          urgency: created.urgency,
        },
      }, { db: tx });

      return created;
    });

    // Notifications are a genuinely fire-and-forget downstream (external push /
    // staff inbox) — Phase 1.5 post-commit, must never roll back the referral.
    const notifications = await this._notifyReferralRecipients(referral);
    logger.info(`Referral created: ${referralNumber} from ${referring_doctor} to ${referred_to_department}`);
    return { ...referral, notifications };
  }

  /**
   * Get incoming referrals (referred to a specific doctor)
   */
  async getIncomingReferrals(doctorUid, filters = {}) {
    const { status, urgency, tenantId = DEFAULT_TENANT_ID } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const actorDepartments = doctorUid
      ? await this._doctorDepartmentTokens(doctorUid, tenantId)
      : [];

    const conditions = ['tenant_id = $1::uuid'];
    const params = [normalizeTenantId(tenantId)];
    let paramIndex = 2;
    if (doctorUid) {
      conditions.push(`(
        referred_to_doctor = $${paramIndex}::uuid
        OR accepted_by = $${paramIndex}::uuid
        OR performer_id = $${paramIndex}::uuid
        OR (
          referred_to_doctor IS NULL
          AND COALESCE(status, 'pending') = 'pending'
          AND cardinality($${paramIndex + 1}::text[]) > 0
          AND LOWER(TRIM(referred_to_department)) = ANY($${paramIndex + 1}::text[])
        )
      )`);
      params.push(doctorUid, actorDepartments);
      paramIndex += 2;
    }
    if (status) { conditions.push(`status = $${paramIndex++}`); params.push(status); }
    if (urgency) { conditions.push(`urgency = $${paramIndex++}`); params.push(urgency); }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM referrals ${whereClause}`,
      ...params,
    );
    const total = Number.parseInt(countRows[0]?.count ?? 0, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, referral_number, tenant_id, patient_uid, encounter_id,
              referring_doctor, referred_to_doctor, referred_to_department,
              referral_type, reason, urgency, clinical_summary, status,
              accepted_by, accepted_at, completed_at, response_notes,
              requester_id, performer_id, first_seen_at, first_seen_by,
              source, created_at
         FROM referrals ${whereClause}
        ORDER BY
          CASE urgency WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
          created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      ...params, listQuery.limit, listQuery.offset
    );

    return {
      referrals: result,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }

  async _doctorDepartmentTokens(doctorUid, tenantId = DEFAULT_TENANT_ID) {
    if (!doctorUid) return [];
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT LOWER(TRIM(token)) AS token
         FROM (
           SELECT d.department AS token
             FROM users u
             JOIN doctors d ON d.user_id = u.id
            WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
              AND u.uid = $2::uuid
           UNION ALL
           SELECT d.specialty AS token
             FROM users u
             JOIN doctors d ON d.user_id = u.id
            WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
              AND u.uid = $2::uuid
           UNION ALL
           SELECT dept.name AS token
             FROM users u
             JOIN doctors d ON d.user_id = u.id
             JOIN departments dept ON dept.id = d.department_id
            WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
              AND u.uid = $2::uuid
         ) tokens
        WHERE NULLIF(TRIM(token), '') IS NOT NULL`,
      normalizeTenantId(tenantId),
      doctorUid,
    );
    return rows.map((row) => cleanText(row.token).toLowerCase()).filter(Boolean);
  }

  async _assertCanActOnReferral(referral, actorUid, actorRole, actionLabel = 'update') {
    const normalizedRole = normalizeRole(actorRole);
    if (!actorUid || !DOCTOR_ROLES.includes(normalizedRole)) {
      throw AppError.forbidden(`Only the referred specialist can ${actionLabel} this referral`);
    }

    const directUids = [
      referral.referred_to_doctor,
      referral.accepted_by,
      referral.performer_id,
    ].filter(Boolean).map(String);
    if (directUids.includes(String(actorUid))) return;

    if (!referral.referred_to_doctor && referral.referred_to_department) {
      const tokens = await this._doctorDepartmentTokens(actorUid, referral.tenant_id);
      if (tokens.includes(cleanText(referral.referred_to_department).toLowerCase())) return;
    }

    throw AppError.forbidden(`Only the referred specialist can ${actionLabel} this referral`);
  }

  async _assertCanDeclineReferral(referral, actorUid, actorRole) {
    const actor = String(actorUid || '');
    const senderUids = [
      referral.referring_doctor,
      referral.requester_id,
    ].filter(Boolean).map(String);
    if (actor && senderUids.includes(actor)) return;

    try {
      await this._assertCanActOnReferral(referral, actorUid, actorRole, 'decline');
    } catch (err) {
      if (err?.statusCode !== 403) throw err;
      throw AppError.forbidden('Only the referred specialist or requesting doctor can decline this referral');
    }
  }

  /**
   * Get outgoing referrals (referred by a specific doctor)
   */
  async getOutgoingReferrals(doctorUid, filters = {}) {
    const { status, urgency, tenantId = DEFAULT_TENANT_ID } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const where = { tenant_id: normalizeTenantId(tenantId) };
    if (doctorUid) {
      where.OR = [
        { referring_doctor: doctorUid },
        { requester_id: doctorUid },
      ];
    }
    if (status) where.status = status;
    if (urgency) where.urgency = urgency;

    const [total, referrals] = await Promise.all([
      prisma.referrals.count({ where }),
      prisma.referrals.findMany({
        where,
        select: REFERRAL_LIST_SELECT,
        orderBy: { created_at: 'desc' },
        take: listQuery.limit,
        skip: listQuery.offset,
      }),
    ]);

    return {
      referrals,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }

  /**
   * Accept a referral
   */
  async acceptReferral(id, acceptedBy, options = {}) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: {
        id: true,
        status: true,
        tenant_id: true,
        patient_uid: true,
        encounter_id: true,
        referred_to_doctor: true,
        referred_to_department: true,
        accepted_by: true,
        performer_id: true,
        first_seen_at: true,
      },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    if (existing.status !== 'pending') {
      throw AppError.badRequest(`Cannot accept referral with status: ${existing.status}`);
    }
    await this._assertCanActOnReferral(existing, acceptedBy, options.actorRole, 'accept');

    const referral = await prisma.referrals.update({
      where: { id: referralId },
      data: {
        status: 'accepted',
        accepted_by: acceptedBy,
        referred_to_doctor: existing.referred_to_doctor || acceptedBy,
        performer_id: acceptedBy,
        accepted_at: new Date(),
        first_seen_at: existing.first_seen_at || new Date(),
        first_seen_by: existing.first_seen_at ? undefined : acceptedBy,
        updated_at: new Date(),
      },
      select: REFERRAL_STATE_SELECT,
    });

    logger.info(`Referral ${referralId} accepted by ${acceptedBy}`);
    await bestEffortReferralCanonical('referral accept', async () => {
      await recordCanonicalClinicalEvent({
        tenantId: referral.tenant_id,
        patientUid: referral.patient_uid,
        encounterId: referral.encounter_id,
        eventType: 'referral.accepted',
        eventSubtype: referral.referred_to_department,
        eventStatus: referral.status,
        sourceTable: 'referrals',
        sourceId: referral.id,
        resourceType: 'referral',
        resourceId: referral.id,
        actorUid: acceptedBy,
        actorRole: options.actorRole,
        summary: `Referral ${referral.referral_number} accepted`,
        payload: {
          referral_number: referral.referral_number,
          accepted_by: referral.accepted_by,
          accepted_at: referral.accepted_at,
        },
        beforeState: existing,
        afterState: referral,
      });
      await completeWorkflowSla({
        tenantId: referral.tenant_id,
        ruleCode: 'referral_response',
        sourceTable: 'referrals',
        sourceId: referral.id,
        metadata: { completed_by: acceptedBy, completed_by_action: 'accepted' },
      });
    });
    return referral;
  }

  /**
   * Complete a referral
   */
  async completeReferral(id, responseNotes, options = {}) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: {
        id: true,
        status: true,
        tenant_id: true,
        patient_uid: true,
        encounter_id: true,
        referring_doctor: true,
        referred_to_doctor: true,
        referred_to_department: true,
        accepted_by: true,
        performer_id: true,
        requester_id: true,
      },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    if (!['accepted', 'in_progress'].includes(existing.status)) {
      throw AppError.badRequest(`Cannot complete referral with status: ${existing.status}`);
    }
    await this._assertCanActOnReferral(existing, options.actorUid, options.actorRole, 'complete');

    // Matches the old COALESCE semantics: only overwrite response_notes
    // when the caller supplied a non-null value.
    const data = {
      status: 'completed',
      completed_at: new Date(),
      updated_at: new Date(),
    };
    if (responseNotes != null) data.response_notes = responseNotes;

    const referral = await prisma.referrals.update({
      where: { id: referralId },
      data,
      select: REFERRAL_STATE_SELECT,
    });

    logger.info(`Referral ${referralId} completed`);
    await bestEffortReferralCanonical('referral complete', () => recordCanonicalClinicalEvent({
      tenantId: referral.tenant_id,
      patientUid: referral.patient_uid,
      encounterId: referral.encounter_id,
      eventType: 'referral.completed',
      eventSubtype: referral.referred_to_department,
      eventStatus: referral.status,
      sourceTable: 'referrals',
      sourceId: referral.id,
      resourceType: 'referral',
      resourceId: referral.id,
      actorUid: options.actorUid,
      actorRole: options.actorRole,
      summary: `Referral ${referral.referral_number} completed`,
      payload: {
        referral_number: referral.referral_number,
        response_notes: referral.response_notes,
        completed_at: referral.completed_at,
      },
      beforeState: existing,
      afterState: referral,
    }));
    return referral;
  }

  /**
   * Decline a referral
   */
  async declineReferral(id, responseNotes, options = {}) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: {
        id: true,
        status: true,
        tenant_id: true,
        patient_uid: true,
        encounter_id: true,
        referred_to_doctor: true,
        referred_to_department: true,
        accepted_by: true,
        performer_id: true,
      },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    if (existing.status !== 'pending') {
      throw AppError.badRequest(`Cannot decline referral with status: ${existing.status}`);
    }
    await this._assertCanDeclineReferral(existing, options.actorUid, options.actorRole);

    const referral = await prisma.referrals.update({
      where: { id: referralId },
      data: {
        status: 'declined',
        response_notes: responseNotes || null,
        updated_at: new Date(),
      },
      select: REFERRAL_STATE_SELECT,
    });

    logger.info(`Referral ${referralId} declined`);
    await bestEffortReferralCanonical('referral decline', async () => {
      await recordCanonicalClinicalEvent({
        tenantId: referral.tenant_id,
        patientUid: referral.patient_uid,
        encounterId: referral.encounter_id,
        eventType: 'referral.declined',
        eventSubtype: referral.referred_to_department,
        eventStatus: referral.status,
        sourceTable: 'referrals',
        sourceId: referral.id,
        resourceType: 'referral',
        resourceId: referral.id,
        actorUid: options.actorUid,
        actorRole: options.actorRole,
        summary: `Referral ${referral.referral_number} declined`,
        payload: {
          referral_number: referral.referral_number,
          response_notes: referral.response_notes,
        },
        beforeState: existing,
        afterState: referral,
      });
      await completeWorkflowSla({
        tenantId: referral.tenant_id,
        ruleCode: 'referral_response',
        sourceTable: 'referrals',
        sourceId: referral.id,
        metadata: { completed_by: options.actorUid, completed_by_action: 'declined' },
      });
    });
    return referral;
  }

  /**
   * Get all referrals for a specific patient
   */
  async markReferralSeen(id, actorUid, options = {}) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }
    if (!actorUid) {
      throw AppError.badRequest('actor uid is required');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: {
        id: true,
        status: true,
        tenant_id: true,
        patient_uid: true,
        encounter_id: true,
        referred_to_doctor: true,
        referred_to_department: true,
        accepted_by: true,
        performer_id: true,
        first_seen_at: true,
      },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    await this._assertCanActOnReferral(existing, actorUid, options.actorRole, 'mark as seen');

    const data = {
      updated_at: new Date(),
    };
    if (!existing.first_seen_at) {
      data.first_seen_at = new Date();
      data.first_seen_by = actorUid;
    }
    if (!existing.referred_to_doctor && ACTIVE_REFERRAL_STATUSES.includes(existing.status)) {
      data.performer_id = actorUid;
    }

    const referral = await prisma.referrals.update({
      where: { id: referralId },
      data,
      select: REFERRAL_STATE_SELECT,
    });
    await bestEffortReferralCanonical('referral seen', async () => {
      await recordCanonicalClinicalEvent({
        tenantId: referral.tenant_id,
        patientUid: referral.patient_uid,
        encounterId: referral.encounter_id,
        eventType: 'referral.seen',
        eventSubtype: referral.referred_to_department,
        eventStatus: referral.status,
        sourceTable: 'referrals',
        sourceId: referral.id,
        resourceType: 'referral',
        resourceId: referral.id,
        actorUid,
        actorRole: options.actorRole,
        summary: `Referral ${referral.referral_number} seen`,
        payload: {
          referral_number: referral.referral_number,
          first_seen_at: referral.first_seen_at,
          first_seen_by: referral.first_seen_by,
        },
        beforeState: existing,
        afterState: referral,
      });
      await completeWorkflowSla({
        tenantId: referral.tenant_id,
        ruleCode: 'referral_response',
        sourceTable: 'referrals',
        sourceId: referral.id,
        metadata: { completed_by: actorUid, completed_by_action: 'seen' },
      });
    });
    return referral;
  }

  async getReferralAudit(filters = {}) {
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'created_at',
    });
    const tenantId = normalizeTenantId(filters.tenantId);
    const conditions = ['r.tenant_id = $1::uuid'];
    const params = [tenantId];
    let paramIndex = 2;
    if (filters.status) { conditions.push(`r.status = $${paramIndex++}`); params.push(filters.status); }
    if (filters.urgency) { conditions.push(`r.urgency = $${paramIndex++}`); params.push(filters.urgency); }
    if (filters.department) {
      conditions.push(`LOWER(r.referred_to_department) LIKE '%' || LOWER($${paramIndex++}) || '%'`);
      params.push(filters.department);
    }
    if (filters.doctor_uid) {
      conditions.push(`(r.referred_to_doctor = $${paramIndex}::uuid OR r.accepted_by = $${paramIndex}::uuid OR r.performer_id = $${paramIndex}::uuid)`);
      params.push(filters.doctor_uid);
      paramIndex += 1;
    }
    if (filters.patient_uid) { conditions.push(`r.patient_uid = $${paramIndex++}::uuid`); params.push(filters.patient_uid); }
    if (filters.date_from) { conditions.push(`r.created_at >= $${paramIndex++}::timestamptz`); params.push(filters.date_from); }
    if (filters.date_to) { conditions.push(`r.created_at < $${paramIndex++}::timestamptz`); params.push(filters.date_to); }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM referrals r ${whereClause}`,
      ...params,
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id,
              r.referral_number,
              r.patient_uid,
              p.name AS patient_name,
              r.referred_to_department,
              r.referred_to_doctor,
              target.name AS referred_to_doctor_name,
              r.referring_doctor,
              referrer.name AS referring_doctor_name,
              r.requester_id,
              requester.name AS requester_name,
              r.urgency,
              r.status,
              r.reason,
              r.created_at AS requested_at,
              r.first_seen_at,
              r.first_seen_by,
              seen_by.name AS first_seen_by_name,
              CASE
                WHEN r.first_seen_at IS NULL THEN NULL
                ELSE ROUND(EXTRACT(EPOCH FROM (r.first_seen_at - r.created_at)) / 60.0)::int
              END AS minutes_to_first_seen,
              r.accepted_at,
              r.completed_at
         FROM referrals r
         LEFT JOIN users p ON p.uid = r.patient_uid
         LEFT JOIN users target ON target.uid = r.referred_to_doctor
         LEFT JOIN users referrer ON referrer.uid = r.referring_doctor
         LEFT JOIN users requester ON requester.uid = r.requester_id
         LEFT JOIN users seen_by ON seen_by.uid = r.first_seen_by
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      ...params,
      listQuery.limit,
      listQuery.offset,
    );

    return {
      referrals: rows,
      pagination: buildPagination(Number.parseInt(countRows[0]?.count ?? 0, 10), listQuery.page, listQuery.limit),
    };
  }

  async getPatientReferrals(patientUid, filters = {}) {
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const where = {
      patient_uid: patientUid,
      tenant_id: normalizeTenantId(filters.tenantId),
    };

    const [total, referrals] = await Promise.all([
      prisma.referrals.count({ where }),
      prisma.referrals.findMany({
        where,
        select: REFERRAL_LIST_SELECT,
        orderBy: { created_at: 'desc' },
        take: listQuery.limit,
        skip: listQuery.offset,
      }),
    ]);

    return {
      referrals,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }
}

export default new ReferralService();
