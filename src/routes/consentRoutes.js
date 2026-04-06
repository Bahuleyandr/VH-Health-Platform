// src/routes/consentRoutes.js
// HIPAA Patient Consent Management Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';
import { success, error } from '../utils/responseHelper.js';
import { requiredUUID, requiredString } from '../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * IDOR guard: patients can only manage their own consents.
 * Staff/admin roles are allowed to manage any patient's consents.
 */
function enforceConsentOwnership(req, patientUid) {
  const role = (req.user?.role || '').toUpperCase();
  if (role === 'PATIENT' && String(req.user?.uid) !== String(patientUid)) {
    return false;
  }
  return true;
}

/**
 * POST /consent/grant
 * Grant a consent for a patient.
 * Body: { patient_uid, consent_type, notes? }
 */
router.post('/grant', requiredUUID('patient_uid'), requiredString('consent_type', 100), validate, async (req, res, next) => {
  try {
    const { patient_uid, consent_type, notes } = req.body;

    if (!patient_uid || !consent_type) {
      return error(res, 'patient_uid and consent_type are required', 400);
    }

    // IDOR check: patients can only grant their own consents
    if (!enforceConsentOwnership(req, patient_uid)) {
      return error(res, 'Access denied: You can only manage your own consents', 403);
    }

    const VALID_CONSENT_TYPES = ['data_access', 'treatment', 'research', 'marketing'];
    if (!VALID_CONSENT_TYPES.includes(consent_type)) {
      return error(res, `Invalid consent_type. Must be one of: ${VALID_CONSENT_TYPES.join(', ')}`, 400);
    }

    const grantedBy = req.user?.role?.toLowerCase() || 'patient';
    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    // Check if an active consent of this type already exists
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM patient_consents
       WHERE patient_uid = $1 AND consent_type = $2 AND granted = true AND revoked_at IS NULL
       LIMIT 1`,
      [patient_uid, consent_type]
    );

    if (existing.length > 0) {
      return error(res, 'Active consent of this type already exists for this patient', 409);
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_consents
        (patient_uid, consent_type, granted, granted_at, granted_by, ip_address, notes, created_at)
       VALUES ($1, $2, true, NOW(), $3, $4, $5, NOW())
       RETURNING id, patient_uid, consent_type, granted, granted_at, granted_by, ip_address, notes, created_at`,
      [patient_uid, consent_type, grantedBy, ip, notes || null]
    );

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patient_uid,
      recordType: `consent:${consent_type}`,
      action: 'GRANT_CONSENT',
      ip,
      requestId: req.id,
    });

    logger.info('Consent granted', { patient_uid, consent_type, granted_by: grantedBy });

    return success(res, result[0], 'Consent granted successfully', 201);
  } catch (err) {
    logger.error('Failed to grant consent:', { error: err.message });
    next(err);
  }
});

/**
 * POST /consent/revoke
 * Revoke a consent for a patient.
 * Body: { patient_uid, consent_type }
 */
router.post('/revoke', requiredUUID('patient_uid'), requiredString('consent_type', 100), validate, async (req, res, next) => {
  try {
    const { patient_uid, consent_type } = req.body;

    if (!patient_uid || !consent_type) {
      return error(res, 'patient_uid and consent_type are required', 400);
    }

    // IDOR check: patients can only revoke their own consents
    if (!enforceConsentOwnership(req, patient_uid)) {
      return error(res, 'Access denied: You can only manage your own consents', 403);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE patient_consents
       SET revoked_at = NOW(), granted = false
       WHERE patient_uid = $1
         AND consent_type = $2
         AND granted = true
         AND revoked_at IS NULL
       RETURNING id, patient_uid, consent_type, granted, granted_at, revoked_at`,
      [patient_uid, consent_type]
    );

    if (result.length === 0) {
      return error(res, 'No active consent found to revoke', 404);
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patient_uid,
      recordType: `consent:${consent_type}`,
      action: 'REVOKE_CONSENT',
      ip,
      requestId: req.id,
    });

    logger.info('Consent revoked', { patient_uid, consent_type });

    return success(res, result[0], 'Consent revoked successfully');
  } catch (err) {
    logger.error('Failed to revoke consent:', { error: err.message });
    next(err);
  }
});

/**
 * GET /consent/:patientUid
 * Get all consents for a patient.
 */
router.get('/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;

    if (!patientUid) {
      return error(res, 'Patient UID is required', 400);
    }

    // IDOR check: patients can only view their own consents
    if (!enforceConsentOwnership(req, patientUid)) {
      return error(res, 'Access denied: You can only view your own consents', 403);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, consent_type, granted, granted_at, revoked_at,
              granted_by, ip_address, notes, created_at
       FROM patient_consents
       WHERE patient_uid = $1
       ORDER BY created_at DESC`,
      [patientUid]
    );

    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patientUid,
      recordType: 'consent:all',
      action: 'VIEW_CONSENTS',
      ip,
      requestId: req.id,
    });

    return success(res, result, 'Patient consents retrieved');
  } catch (err) {
    logger.error('Failed to get patient consents:', { error: err.message });
    next(err);
  }
});

/**
 * GET /consent/:patientUid/:consentType
 * Check specific consent for a patient.
 */
router.get('/:patientUid/:consentType', async (req, res, next) => {
  try {
    const { patientUid, consentType } = req.params;

    if (!patientUid || !consentType) {
      return error(res, 'Patient UID and consent type are required', 400);
    }

    // IDOR check: patients can only check their own consent status
    if (!enforceConsentOwnership(req, patientUid)) {
      return error(res, 'Access denied: You can only view your own consents', 403);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, consent_type, granted, granted_at, revoked_at,
              granted_by, ip_address, notes, created_at
       FROM patient_consents
       WHERE patient_uid = $1
         AND consent_type = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [patientUid, consentType]
    );

    if (result.length === 0) {
      return success(res, { has_consent: false, consent: null }, 'No consent record found');
    }

    const consent = result[0];
    const isActive = consent.granted === true && consent.revoked_at === null;

    return success(res, {
      has_consent: isActive,
      consent,
    }, isActive ? 'Active consent found' : 'Consent is not active');
  } catch (err) {
    logger.error('Failed to check consent:', { error: err.message });
    next(err);
  }
});

export default router;
