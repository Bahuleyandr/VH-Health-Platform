// src/controllers/record/doctorRecordController.js
import { validationResult } from 'express-validator';
import * as recordService from '../../services/record/recordService.js';
import * as accessControl from '../../services/record/accessControlService.js';
import * as auditService from '../../services/record/auditService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { RECORD_MESSAGES, AUDIT_ACTIONS } from '../../config/recordConfig.js';
import { ADMIN } from '../../utils/roles.js';
import logger from '../../logging/logger.js';

export async function createMedicalRecord(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const doctorId = req.user?.uid;
    const createdBy = req.user?.uid || 'system';
    
    const { record, patient } = await recordService.createMedicalRecord(
      req.body,
      doctorId,
      createdBy
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
        created_at_formatted: new Date(record.created_at).toLocaleDateString('en-GB')
      },
      patient_name: patient.name,
      doctor_id: createdBy,
      timestamp: new Date().toLocaleDateString('en-GB')
    }, RECORD_MESSAGES.CREATE_SUCCESS);

  } catch (err) {
    logger.error(`[CreateMedicalRecord] ${err.message}`);
    
    if (err.message === 'Patient not found') {
      return res.status(404).json({ 
        message: RECORD_MESSAGES.PATIENT_NOT_FOUND,
        patient_id: req.body.patient_id
      });
    }
    
    res.status(500).json({
      message: 'Failed to create medical record',
      error: err.message,
      suggestion: 'Ensure medical_records table exists with proper structure'
    });
  }
}

export async function updateMedicalRecord(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    const { id } = req.params;
    const updatedBy = req.user?.uid || 'system';

    // Check if record exists and user has permission
    const existingRecord = await recordService.getMedicalRecordById(id);
    
    if (!existingRecord) {
      return res.status(404).json({ 
        message: RECORD_MESSAGES.NOT_FOUND,
        id
      });
    }

    // Check update permissions
    if (!accessControl.canUpdateRecord(req.user?.role, existingRecord.doctor_id, req.user?.uid)) {
      return res.status(403).json({
        error: 'Access denied: You can only update records you created'
      });
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
        updated_at_formatted: new Date(updatedRecord.updated_at).toLocaleDateString('en-GB')
      },
      updatedBy,
      timestamp: new Date().toLocaleDateString('en-GB')
    }, RECORD_MESSAGES.UPDATE_SUCCESS);

  } catch (err) {
    logger.error(`[UpdateMedicalRecord] ${err.message}`);
    error(res, 'Failed to update medical record');
  }
}