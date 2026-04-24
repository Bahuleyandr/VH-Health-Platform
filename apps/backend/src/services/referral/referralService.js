// src/services/referral/referralService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_REFERRAL_TYPES = ['internal', 'external'];
const VALID_URGENCIES = ['routine', 'urgent', 'emergency'];

// Shared `select` for state-transition returns (accept / complete / decline).
// Keeping the shape consistent means callers don't need to branch on which
// action produced the row.
const REFERRAL_STATE_SELECT = {
  id: true,
  referral_number: true,
  patient_uid: true,
  referring_doctor: true,
  referred_to_doctor: true,
  referred_to_department: true,
  referral_type: true,
  reason: true,
  urgency: true,
  clinical_summary: true,
  status: true,
  accepted_by: true,
  accepted_at: true,
  completed_at: true,
  response_notes: true,
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

  /**
   * Create a new referral
   */
  async createReferral(data) {
    const {
      patient_uid, encounter_id, referring_doctor,
      referred_to_doctor, referred_to_department,
      referral_type, reason, urgency, clinical_summary
    } = data;

    if (!patient_uid) {
      throw AppError.badRequest('patient_uid is required');
    }
    if (!referring_doctor) {
      throw AppError.badRequest('referring_doctor is required');
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

    const referralNumber = await this._generateReferralNumber();

    // Prisma ORM — column names validated at runtime against schema.prisma.
    // Defaults for status ('pending') come from the schema itself, so we
    // don't set them here.
    const referral = await prisma.referrals.create({
      data: {
        referral_number: referralNumber,
        patient_uid,
        encounter_id: encounter_id || null,
        referring_doctor,
        referred_to_doctor: referred_to_doctor || null,
        referred_to_department,
        referral_type: referral_type || 'internal',
        reason,
        urgency: urgency || 'routine',
        clinical_summary: clinical_summary || null,
      },
      select: {
        id: true,
        referral_number: true,
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
        created_at: true,
      },
    });

    logger.info(`Referral created: ${referralNumber} from ${referring_doctor} to ${referred_to_department}`);
    return referral;
  }

  /**
   * Get incoming referrals (referred to a specific doctor)
   */
  async getIncomingReferrals(doctorUid, filters = {}) {
    const { status, urgency, page = 1, limit = 20 } = filters;
    const parsedLimit = parseInt(limit, 10);
    const offset = (parseInt(page, 10) - 1) * parsedLimit;

    const where = { referred_to_doctor: doctorUid };
    if (status) where.status = status;
    if (urgency) where.urgency = urgency;

    // Count uses ORM so column-name drift (e.g. referred_to_doctor rename)
    // fails fast. The list itself keeps the raw query because its
    // `ORDER BY CASE urgency ...` expression has no first-class Prisma
    // equivalent — pulling the unordered page and sorting in JS would
    // break pagination (a page-2 emergency referral could never reach
    // page 1). This is the only remaining raw read in this service.
    const total = await prisma.referrals.count({ where });

    const conditions = [`referred_to_doctor = $1`];
    const params = [doctorUid];
    let paramIndex = 2;
    if (status) { conditions.push(`status = $${paramIndex++}`); params.push(status); }
    if (urgency) { conditions.push(`urgency = $${paramIndex++}`); params.push(urgency); }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, referral_number, patient_uid, encounter_id,
        referring_doctor, referred_to_doctor, referred_to_department,
        referral_type, reason, urgency, clinical_summary, status,
        accepted_by, accepted_at, completed_at, response_notes, created_at
       FROM referrals ${whereClause}
       ORDER BY
         CASE urgency WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      ...params, parsedLimit, offset
    );

    return {
      referrals: result,
      pagination: {
        page: parseInt(page, 10),
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
      },
    };
  }

  /**
   * Get outgoing referrals (referred by a specific doctor)
   */
  async getOutgoingReferrals(doctorUid, filters = {}) {
    const { status, urgency, page = 1, limit = 20 } = filters;
    const parsedLimit = parseInt(limit, 10);
    const offset = (parseInt(page, 10) - 1) * parsedLimit;

    const where = { referring_doctor: doctorUid };
    if (status) where.status = status;
    if (urgency) where.urgency = urgency;

    const [total, referrals] = await Promise.all([
      prisma.referrals.count({ where }),
      prisma.referrals.findMany({
        where,
        select: REFERRAL_LIST_SELECT,
        orderBy: { created_at: 'desc' },
        take: parsedLimit,
        skip: offset,
      }),
    ]);

    return {
      referrals,
      pagination: {
        page: parseInt(page, 10),
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
      },
    };
  }

  /**
   * Accept a referral
   */
  async acceptReferral(id, acceptedBy) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    if (existing.status !== 'pending') {
      throw AppError.badRequest(`Cannot accept referral with status: ${existing.status}`);
    }

    const referral = await prisma.referrals.update({
      where: { id: referralId },
      data: {
        status: 'accepted',
        accepted_by: acceptedBy,
        accepted_at: new Date(),
        updated_at: new Date(),
      },
      select: REFERRAL_STATE_SELECT,
    });

    logger.info(`Referral ${referralId} accepted by ${acceptedBy}`);
    return referral;
  }

  /**
   * Complete a referral
   */
  async completeReferral(id, responseNotes) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    if (!['accepted', 'in_progress'].includes(existing.status)) {
      throw AppError.badRequest(`Cannot complete referral with status: ${existing.status}`);
    }

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
    return referral;
  }

  /**
   * Decline a referral
   */
  async declineReferral(id, responseNotes) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.referrals.findUnique({
      where: { id: referralId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw AppError.notFound('Referral not found');
    }
    if (existing.status !== 'pending') {
      throw AppError.badRequest(`Cannot decline referral with status: ${existing.status}`);
    }

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
    return referral;
  }

  /**
   * Get all referrals for a specific patient
   */
  async getPatientReferrals(patientUid, filters = {}) {
    const { page = 1, limit = 20 } = filters;
    const parsedLimit = parseInt(limit, 10);
    const offset = (parseInt(page, 10) - 1) * parsedLimit;

    const where = { patient_uid: patientUid };

    const [total, referrals] = await Promise.all([
      prisma.referrals.count({ where }),
      prisma.referrals.findMany({
        where,
        select: REFERRAL_LIST_SELECT,
        orderBy: { created_at: 'desc' },
        take: parsedLimit,
        skip: offset,
      }),
    ]);

    return {
      referrals,
      pagination: {
        page: parseInt(page, 10),
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
      },
    };
  }
}

export default new ReferralService();
