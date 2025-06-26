// src/controllers/health/patientHealthController.js
import * as patientHealthService from '../../services/health/patientHealthService.js';
import * as healthRecordService from '../../services/health/healthRecordService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { HEALTH_MESSAGES, MEDICAL_ROLES } from '../../config/healthConfig.js';
import logger from '../../logging/logger.js';

export async function getPatientSummary(req, res) {
  try {
    const { patient_id } = req.params;
    const days = parseInt(req.query.days) || 30;
    
    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      // Check if doctor has treated this patient
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }
    
    const summary = await patientHealthService.getPatientSummary(patient_id, days);
    
    success(res, {
      ...summary,
      accessedBy: req.user?.name
    }, 'Patient health summary retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    
    if (err.message === 'Patient not found') {
      return error(res, HEALTH_MESSAGES.PATIENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to retrieve patient health summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientVitalTrends(req, res) {
  try {
    const { patient_id } = req.params;
    const days = parseInt(req.query.days) || 30;
    const vital_type = req.query.vital_type;
    
    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }
    
    const trends = await patientHealthService.getPatientVitalTrends(patient_id, days, vital_type);
    
    success(res, {
      ...trends,
      accessedBy: req.user?.name
    }, 'Patient vital trends retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve vital trends', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientAllergies(req, res) {
  try {
    const { patient_id } = req.params;
    
    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }
    
    const allergies = await patientHealthService.getPatientAllergies(patient_id);
    
    success(res, {
      ...allergies,
      accessedBy: req.user?.name
    }, 'Patient allergies retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve patient allergies', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientConditions(req, res) {
  try {
    const { patient_id } = req.params;
    const active_only = req.query.active_only === 'true';
    
    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }
    
    const conditions = await patientHealthService.getPatientConditions(patient_id, active_only);
    
    success(res, {
      ...conditions,
      accessedBy: req.user?.name
    }, 'Patient conditions retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve patient conditions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}