// src/services/referral/referralService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_REFERRAL_TYPES = ['internal', 'external'];
const VALID_URGENCIES = ['routine', 'urgent', 'emergency'];

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

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO referrals (
        referral_number, patient_uid, encounter_id, referring_doctor,
        referred_to_doctor, referred_to_department, referral_type,
        reason, urgency, clinical_summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, referral_number, patient_uid, encounter_id,
        referring_doctor, referred_to_doctor, referred_to_department,
        referral_type, reason, urgency, clinical_summary, status, created_at`,
      
        referralNumber, patient_uid, encounter_id || null, referring_doctor,
        referred_to_doctor || null, referred_to_department,
        referral_type || 'internal', reason, urgency || 'routine',
        clinical_summary || null
      
    );

    logger.info(`Referral created: ${referralNumber} from ${referring_doctor} to ${referred_to_department}`);
    return result[0];
  }

  /**
   * Get incoming referrals (referred to a specific doctor)
   */
  async getIncomingReferrals(doctorUid, filters = {}) {
    const { status, urgency, page = 1, limit = 20 } = filters;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const conditions = [`referred_to_doctor = $1`];
    const params = [doctorUid];
    let paramIndex = 2;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (urgency) {
      conditions.push(`urgency = $${paramIndex++}`);
      params.push(urgency);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM referrals ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0].total, 10);

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
      ...params, parseInt(limit, 10), offset
    );

    return {
      referrals: result,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    };
  }

  /**
   * Get outgoing referrals (referred by a specific doctor)
   */
  async getOutgoingReferrals(doctorUid, filters = {}) {
    const { status, urgency, page = 1, limit = 20 } = filters;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const conditions = [`referring_doctor = $1`];
    const params = [doctorUid];
    let paramIndex = 2;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (urgency) {
      conditions.push(`urgency = $${paramIndex++}`);
      params.push(urgency);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM referrals ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0].total, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, referral_number, patient_uid, encounter_id,
        referring_doctor, referred_to_doctor, referred_to_department,
        referral_type, reason, urgency, clinical_summary, status,
        accepted_by, accepted_at, completed_at, response_notes, created_at
       FROM referrals ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      ...params, parseInt(limit, 10), offset
    );

    return {
      referrals: result,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
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

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM referrals WHERE id = $1`,
      referralId
    );
    if (existing.length === 0) {
      throw AppError.notFound('Referral not found');
    }
    if (existing[0].status !== 'pending') {
      throw AppError.badRequest(`Cannot accept referral with status: ${existing[0].status}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE referrals SET
        status = 'accepted',
        accepted_by = $1,
        accepted_at = NOW()
       WHERE id = $2
       RETURNING id, referral_number, patient_uid, referring_doctor,
        referred_to_doctor, referred_to_department, referral_type,
        reason, urgency, status, accepted_by, accepted_at, created_at`,
      acceptedBy, referralId
    );

    logger.info(`Referral ${referralId} accepted by ${acceptedBy}`);
    return result[0];
  }

  /**
   * Complete a referral
   */
  async completeReferral(id, responseNotes) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM referrals WHERE id = $1`,
      referralId
    );
    if (existing.length === 0) {
      throw AppError.notFound('Referral not found');
    }
    if (!['accepted', 'in_progress'].includes(existing[0].status)) {
      throw AppError.badRequest(`Cannot complete referral with status: ${existing[0].status}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE referrals SET
        status = 'completed',
        completed_at = NOW(),
        response_notes = COALESCE($1, response_notes)
       WHERE id = $2
       RETURNING id, referral_number, patient_uid, referring_doctor,
        referred_to_doctor, referred_to_department, referral_type,
        reason, urgency, status, accepted_by, accepted_at,
        completed_at, response_notes, created_at`,
      responseNotes || null, referralId
    );

    logger.info(`Referral ${referralId} completed`);
    return result[0];
  }

  /**
   * Decline a referral
   */
  async declineReferral(id, responseNotes) {
    const referralId = parseInt(id, 10);
    if (isNaN(referralId)) {
      throw AppError.badRequest('Invalid referral ID');
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM referrals WHERE id = $1`,
      referralId
    );
    if (existing.length === 0) {
      throw AppError.notFound('Referral not found');
    }
    if (existing[0].status !== 'pending') {
      throw AppError.badRequest(`Cannot decline referral with status: ${existing[0].status}`);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE referrals SET
        status = 'declined',
        response_notes = $1
       WHERE id = $2
       RETURNING id, referral_number, patient_uid, referring_doctor,
        referred_to_doctor, referred_to_department, referral_type,
        reason, urgency, status, response_notes, created_at`,
      responseNotes || null, referralId
    );

    logger.info(`Referral ${referralId} declined`);
    return result[0];
  }

  /**
   * Get all referrals for a specific patient
   */
  async getPatientReferrals(patientUid, filters = {}) {
    const { page = 1, limit = 20 } = filters;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM referrals WHERE patient_uid = $1`,
      patientUid
    );
    const total = parseInt(countResult[0].total, 10);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, referral_number, patient_uid, encounter_id,
        referring_doctor, referred_to_doctor, referred_to_department,
        referral_type, reason, urgency, clinical_summary, status,
        accepted_by, accepted_at, completed_at, response_notes, created_at
       FROM referrals
       WHERE patient_uid = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      patientUid, parseInt(limit, 10), offset
    );

    return {
      referrals: result,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    };
  }
}

export default new ReferralService();
