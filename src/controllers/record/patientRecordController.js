// src/controllers/record/patientRecordController.js
import { validationResult } from 'express-validator';
import * as recordService from '../../services/record/recordService.js';
import * as accessControl from '../../services/record/accessControlService.js';
import * as auditService from '../../services/record/auditService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { RECORD_MESSAGES, AUDIT_ACTIONS } from '../../config/recordConfig.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { PATIENT } from '../../utils/roles.js';
import logger from '../../logging/logger.js';

export async function getRecordsByUID(req, res) {
  try {
    const { uid } = req.params;
    const records = await recordService.getRecordsByUID(uid);
    
    success(res, {
      records,
      count: records.length,
      uid
    }, 'Records retrieved successfully');
  } catch (err) {
    logger.error(`[GetRecordsByUID] ${err.message}`);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
}

export async function getHealthRecordsByPhone(req, res) {
  try {
    const phone = normalizePhone(req.params.phone);
    const { type, limit = 50, offset = 0 } = req.query;
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';

    // Role-based access check for patients
    if (userRole === PATIENT) {
      const userPhone = req.user?.phone;
      if (userPhone && normalizePhone(userPhone) !== phone) {
        return res.status(403).json({
          error: 'Access denied: Patients can only view their own records'
        });
      }
    }

    const records = await recordService.getHealthRecordsByPhone(phone, { type, limit, offset });
    
    // Filter records based on privacy level and user role
    const filteredRecords = accessControl.filterRecordsByAccess(
      records, 
      userRole, 
      { phone }
    );

    success(res, {
      records: filteredRecords,
      count: filteredRecords.length,
      totalFound: records.length,
      filters: { type, limit, offset },
      phone,
      requestedBy,
      accessLevel: userRole
    }, 'Health records fetched successfully');

  } catch (err) {
    logger.error(`[HealthRecords] ${err.message}`);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
}

export async function createHealthRecord(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { phone, file_key, file_name, file_type, privacy_level = 0, notes } = req.body;
    const createdBy = req.user?.uid || 'system';
    const createdByRole = req.user?.role || 'unknown';

    // Role-based creation check
    if (!accessControl.canCreateRecord(req.user?.role, phone, req.user?.phone)) {
      return res.status(403).json({
        error: 'Access denied: You cannot create records for other patients'
      });
    }

    const record = await recordService.createHealthRecord(
      req.body,
      createdBy,
      createdByRole
    );

    // Audit log
    await auditService.logAuditEntry(
      AUDIT_ACTIONS.CREATE_HEALTH_RECORD,
      'health_records',
      record.id,
      createdBy,
      createdByRole,
      { file_name, file_type, privacy_level }
    );

    success(res, {
      record,
      createdBy,
      createdByRole,
      timestamp: new Date().toLocaleDateString('en-GB')
    }, RESPONSE_MESSAGES.HEALTH_RECORD_ADDED);

  } catch (err) {
    logger.error(`[AddHealthRecord] ${err.message}`);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
}

// Legacy endpoint
export async function getConsultationsByPhone(req, res) {
  // Redirect to new endpoint
  return getHealthRecordsByPhone(req, res);
}