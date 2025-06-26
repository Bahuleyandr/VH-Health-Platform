// src/controllers/health/healthRecordController.js
import { validationResult } from 'express-validator';
import * as healthRecordService from '../../services/health/healthRecordService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { HEALTH_MESSAGES, MEDICAL_ROLES } from '../../config/healthConfig.js';
import logger from '../../logging/logger.js';

export async function testRoute(req, res) {
  success(res, { 
    message: 'Health records routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    user: req.user?.name || 'Unknown'
  }, 'Health records routes operational');
}

export async function getHealthRecords(req, res) {
  try {
    // Role-based access control
    if (!MEDICAL_ROLES.includes(req.user?.role)) {
      return error(res, 'Medical staff access required for health records', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      patient_id: req.query.patient_id,
      type: req.query.type,
      date_from: req.query.date_from,
      date_to: req.query.date_to
    };

    const result = await healthRecordService.getHealthRecords(
      filters,
      req.user?.role,
      req.user?.id
    );

    success(res, {
      health_records: result.records,
      pagination: result.pagination,
      filters: {
        patient_id: filters.patient_id || null,
        type: filters.type || null,
        date_from: filters.date_from || null,
        date_to: filters.date_to || null
      },
      requestedBy: req.user?.name
    }, 'Health records retrieved successfully');
  } catch (err) {
    logger.error('Database error for health records:', err);
    
    // Fallback response
    success(res, {
      health_records: [],
      pagination: {
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false
      },
      note: 'Could not retrieve health records - health_records table may not exist',
      requestedBy: req.user?.name
    }, 'Health records retrieved (empty - table may not exist)');
  }
}

export async function getHealthRecordById(req, res) {
  try {
    const { id } = req.params;
    
    const record = await healthRecordService.getHealthRecordById(
      id,
      req.user?.role,
      req.user?.id
    );
    
    if (!record) {
      return error(res, 'Health record not found or access denied', HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      health_record: record,
      accessedBy: req.user?.name
    }, 'Health record retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve health record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
    // Role-based access control
    if (!MEDICAL_ROLES.includes(req.user?.role)) {
      return error(res, 'Medical staff access required to record health data', HTTP_STATUS.FORBIDDEN);
    }

    const recorderId = req.body.recorded_by || req.user.id;
    
    const result = await healthRecordService.createHealthRecord(req.body, recorderId);
    
    logger.info(`Health record created by ${req.user?.name} for patient ${result.patient.name}`);
    
    success(res, {
      health_record: result.record,
      patient_name: result.patient.name,
      recorded_by_name: result.recorder.name,
      createdBy: req.user?.name
    }, 'Health record created successfully', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Database error:', err);
    
    if (err.message === 'Patient not found') {
      return error(res, HEALTH_MESSAGES.PATIENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to create health record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function updateHealthRecord(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }

  try {
    // Role-based access control
    if (!MEDICAL_ROLES.includes(req.user?.role)) {
      return error(res, 'Medical staff access required to update health records', HTTP_STATUS.FORBIDDEN);
    }

    const { id } = req.params;
    
    const record = await healthRecordService.updateHealthRecord(
      id,
      req.body,
      req.user.id,
      req.user?.role
    );
    
    logger.info(`Health record ${id} updated by ${req.user?.name}`);
    
    success(res, {
      health_record: record,
      updatedBy: req.user?.name
    }, 'Health record updated successfully');
  } catch (err) {
    logger.error('Database error:', err);
    
    if (err.message === 'Health record not found') {
      return error(res, HEALTH_MESSAGES.RECORD_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    if (err.message === 'Can only update records you created') {
      return error(res, HEALTH_MESSAGES.UPDATE_FORBIDDEN, HTTP_STATUS.FORBIDDEN);
    }
    
    error(res, 'Failed to update health record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}