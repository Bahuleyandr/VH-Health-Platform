// src/controllers/record/medicalStaffRecordController.js
import * as recordService from '../../services/record/recordService.js';
import * as accessControl from '../../services/record/accessControlService.js';
import { success, error } from '../../utils/responseHelper.js';
import { RECORD_MESSAGES } from '../../config/recordConfig.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';

export async function getMedicalRecords(req, res) {
  try {
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';
    const filters = {
      page: parseInt(req.query.page) || 1,
      limit: Math.min(parseInt(req.query.limit) || 10, 100),
      patient_id: req.query.patient_id,
      doctor_id: req.query.doctor_id,
      record_type: req.query.type,
      date_from: req.query.date_from,
      date_to: req.query.date_to
    };

    const privacyFilter = accessControl.getPrivacyFilterForRole(userRole);
    const result = await recordService.getMedicalRecords(filters, userRole);

    success(res, {
      ...result,
      filters: {
        patient_id: filters.patient_id || null,
        doctor_id: filters.doctor_id || null,
        record_type: filters.record_type || null,
        date_from: filters.date_from || null,
        date_to: filters.date_to || null
      },
      accessLevel: userRole,
      requestedBy
    }, 'Medical records retrieved successfully');

  } catch (err) {
    logger.error(`[MedicalRecords] ${err.message}`);
    error(res, 'Failed to retrieve medical records', {
  details: err.message,
  suggestion: 'Ensure medical_records table exists with proper structure'
});
  }
}

export async function getMedicalRecordById(req, res) {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';
    
    const record = await recordService.getMedicalRecordById(id);
    
    if (!record) {
      return res.status(404).json({ 
        message: RECORD_MESSAGES.NOT_FOUND,
        id,
        requestedBy
      });
    }

    // Privacy level check
    if (!accessControl.checkDataAccess(userRole, { uid: record.patient_uid }, record)) {
      return res.status(403).json({
        error: 'Access denied: Insufficient permissions for this record privacy level',
        requiredLevel: record.privacy_level,
        userRole
      });
    }

    success(res, {
      record,
      accessLevel: userRole,
      requestedBy
    }, 'Medical record retrieved successfully');

  } catch (err) {
    logger.error(`[GetMedicalRecord] ${err.message}`);
    error(res, 'Failed to retrieve medical record');
  }
}

export async function getPatientRecords(req, res) {
  try {
    const { patient_id } = req.params;
    const record_type = req.query.type;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';
    
    const privacyFilter = accessControl.getPrivacyFilterForRole(userRole);
    const filters = {
      patient_id,
      record_type,
      limit
    };
    
    const result = await recordService.getMedicalRecords(filters, userRole);
    
    // Get patient info
    const patientInfo = await recordService.getPatientInfo(patient_id);
    
    success(res, {
      records: result.records,
      count: result.records.length,
      patient: patientInfo,
      filter: record_type ? { type: record_type } : null,
      accessLevel: userRole,
      requestedBy
    }, 'Medical records for patient retrieved successfully');

  } catch (err) {
    logger.error(`[PatientMedicalRecords] ${err.message}`);
    error(res, 'Failed to retrieve patient medical records');
  }
}

export async function getDoctorRecords(req, res) {
  try {
    const { doctor_id } = req.params;
    const date = req.query.date;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';
    
    const privacyFilter = accessControl.getPrivacyFilterForRole(userRole);
    const filters = {
      doctor_id,
      limit
    };
    
    if (date) {
      filters.date_from = date;
      filters.date_to = date;
    }
    
    const result = await recordService.getMedicalRecords(filters, userRole);
    
    success(res, {
      records: result.records,
      count: result.records.length,
      doctor_id,
      filter: date ? { date } : null,
      accessLevel: userRole,
      requestedBy
    }, 'Medical records by doctor retrieved successfully');

  } catch (err) {
    logger.error(`[DoctorMedicalRecords] ${err.message}`);
    error(res, 'Failed to retrieve doctor medical records');
  }
}

export async function getPatientSummary(req, res) {
  try {
    const { patient_id } = req.params;
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';

    const privacyFilter = accessControl.getPrivacyFilterForRole(userRole);
    const summary = await recordService.getPatientSummary(patient_id, privacyFilter);
    
    if (!summary.patient) {
      return res.status(404).json({ 
        message: RECORD_MESSAGES.PATIENT_NOT_FOUND,
        patient_id,
        requestedBy
      });
    }
    
    const totalRecords = summary.recordStats.reduce((sum, stat) => sum + parseInt(stat.count), 0);
    
    success(res, {
      patient: summary.patient,
      record_statistics: summary.recordStats.map(stat => ({
  ...stat,
  last_record: stat.last_record ? formatDateDDMMYYYY(stat.last_record) : null
})),
      recent_records: summary.recentRecords,
      total_records: totalRecords,
      accessLevel: userRole,
      dataFilter: privacyFilter ? 'Privacy filtered' : 'Full access',
      requestedBy
    }, 'Patient medical summary retrieved successfully');

  } catch (err) {
    logger.error(`[PatientSummary] ${err.message}`);
    error(res, 'Failed to retrieve patient summary');
  }
}
export async function searchMedicalRecords(req, res) {
  try {
    const { q, limit = 50 } = req.query;
    const userRole = req.user?.role;
    const requestedBy = req.user?.uid || 'anonymous';
    
    const records = await recordService.searchMedicalRecords(q, userRole, limit);
    
    success(res, {
      records,
      count: records.length,
      searchTerm: q,
      accessLevel: userRole,
      requestedBy
    }, 'Search completed successfully');
  } catch (err) {
    logger.error(`[SearchRecords] ${err.message}`);
    error(res, 'Failed to search medical records');
  }
}