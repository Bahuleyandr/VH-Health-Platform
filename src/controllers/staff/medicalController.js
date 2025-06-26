import * as medicalService from '../../services/staff/medicalService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

// Upload consultation document
export const uploadConsultation = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const staffUid = req.user?.uid;
    const staffRole = req.user?.role;
    const staffName = req.user?.name;

    // Verify staff has permission
    if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(staffRole)) {
      return error(res, 'Insufficient permissions to upload consultations', HTTP_STATUS.FORBIDDEN);
    }

    const result = await medicalService.uploadConsultation({
      ...req.body,
      phone,
      uploadedBy: staffUid,
      uploadedByName: staffName
    });

    success(res, result, 'Consultation document uploaded successfully');
  } catch (err) {
    logger.error('Upload Consultation Error:', err);
    error(res, 'Failed to upload consultation document', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Upload investigation results
export const uploadInvestigation = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const staffUid = req.user?.uid;
    const staffRole = req.user?.role;
    const staffName = req.user?.name;

    // Verify staff has permission
    if (!['LAB_STAFF', 'DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(staffRole)) {
      return error(res, 'Insufficient permissions to upload investigation results', HTTP_STATUS.FORBIDDEN);
    }

    const result = await medicalService.uploadInvestigationResult({
      ...req.body,
      phone,
      uploadedBy: staffUid,
      uploadedByName: staffName
    });

    success(res, result, 'Investigation result uploaded successfully');
  } catch (err) {
    logger.error('Upload Investigation Error:', err);
    error(res, 'Failed to upload investigation result', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};