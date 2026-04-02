// src/controllers/record/doctorRecordController.js
import { validationResult } from 'express-validator';
import prisma from '../../lib/prisma.js';
import { RECORD_MESSAGES, AUDIT_ACTIONS } from '../../config/recordConfig.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as accessControl from '../../services/record/accessControlService.js';
import * as auditService from '../../services/record/auditService.js';
import * as recordService from '../../services/record/recordService.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { ADMIN } from '../../utils/roles.js';

async function getDoctorUserId(uid) {
  try {
    const result = await prisma.$queryRawUnsafe('SELECT id FROM users WHERE uid = $1::uuid', [uid]);
    return result[0]?.id || null;
  } catch (error) {
    logger.error(`[GetDoctorUserId] ${error.message}`);
    return null;
  }
}

export async function createMedicalRecord(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
  }

  try {
    // Get doctor's UUID and convert to user ID
    const doctorUid = req.user?.uid;
    const doctorId = req.user?.id || (doctorUid ? await getDoctorUserId(doctorUid) : null);

    if (!doctorId) {
      return error(res, 'Unable to identify doctor user ID', 400);
    }

    const createdBy = doctorUid || 'system';
    
    const { record, patient } = await recordService.createMedicalRecord(
      req.body,
      doctorId,  // This is now the integer ID from users table
      createdBy  // This is the UUID for audit purposes
    );

    // Audit log
    await auditService.logAuditEntry(
      AUDIT_ACTIONS.CREATE_MEDICAL_RECORD,
      'medical_records',
      record.id,
      createdBy,
      'DOCTOR',
      { 
        patient_id: req.body.patient_id, 
        record_type: req.body.record_type, 
        privacy_level: req.body.privacy_level 
      }
    );

    logger.info(`📋 Medical record created: ${record.id} by doctor ${createdBy}`);
    
    success(res, {
      record: {
        ...record,
        created_at_formatted: formatDateDDMMYYYY(record.created_at)
      },
      patient_name: patient.name,
      doctor_id: doctorId,  // Return the actual doctor ID used
      timestamp: formatDateDDMMYYYY(new Date())
    }, RECORD_MESSAGES.CREATE_SUCCESS);

  } catch (err) {
    logger.error(`[CreateMedicalRecord] ${err.message}`);
    
    if (err.message === 'Patient not found') {
      return error(res, RECORD_MESSAGES.PATIENT_NOT_FOUND, 404);
    }

    error(res, 'Failed to create medical record');
  }
}

export async function updateMedicalRecord(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
  }

  try {
    const { id } = req.params;
    const updatedBy = req.user?.uid || 'system';
    
    // Get the user's ID for permission checking
    const userUid = req.user?.uid;
    const userId = req.user?.id || (userUid ? await getDoctorUserId(userUid) : null);

    // Check if record exists and user has permission
    const existingRecord = await recordService.getMedicalRecordById(id);
    
    if (!existingRecord) {
      return error(res, RECORD_MESSAGES.NOT_FOUND, 404);
    }

    // Check update permissions (compare integer IDs)
    if (!accessControl.canUpdateRecord(req.user?.role, existingRecord.doctor_id, userId)) {
      return error(res, 'Access denied: You can only update records you created', 403);
    }
    
    const updatedRecord = await recordService.updateMedicalRecord(id, req.body, updatedBy);

    // Audit log
    await auditService.logAuditEntry(
      AUDIT_ACTIONS.UPDATE_MEDICAL_RECORD,
      'medical_records',
      id,
      updatedBy,
      req.user?.role || 'DOCTOR',
      { 
        title: req.body.title, 
        diagnosis: req.body.diagnosis, 
        treatment: req.body.treatment 
      }
    );

    logger.info(`📝 Medical record updated: ${id} by ${updatedBy}`);
    
    success(res, {
      record: {
        ...updatedRecord,
        updated_at_formatted: formatDateDDMMYYYY(updatedRecord.updated_at)
      },
      updatedBy,
      timestamp: formatDateDDMMYYYY(new Date())
    }, RECORD_MESSAGES.UPDATE_SUCCESS);

  } catch (err) {
    logger.error(`[UpdateMedicalRecord] ${err.message}`);
    error(res, 'Failed to update medical record');
  }
}