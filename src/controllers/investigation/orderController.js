import { INVESTIGATION_TYPES, PRIORITY_LEVELS } from '../../config/investigationConfig.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/investigation/orderService.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// Order new investigation
export const orderInvestigation = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    if (!orderService.canOrderInvestigations(userRole)) {
      return res.status(403).json({ 
        message: 'Access denied: Doctor privileges required to order investigations',
        requestedBy
      });
    }
    
    const orderData = {
      ...req.body,
      orderedBy: requestedBy
    };

    const result = await orderService.createInvestigationOrder(orderData);

    if (!result) {
      return res.status(400).json({
        message: result.error || 'Failed to create investigation order',
        requestedBy
      });
    }

    await logAudit(req, 'investigation-ordered', { 
      investigation_id: result.investigation.id,
      patient_id: result.investigation.patient_id,
      test_name: result.investigation.test_name,
      type: result.investigation.type
    });

    success(res, {
      ...result,
      orderedBy: requestedBy
    }, 'Investigation ordered successfully');

  } catch (err) {
    logger.error('Order Investigation Error:', err);
    
    if (err.message === 'PATIENT_NOT_FOUND') {
      return res.status(404).json({ message: 'Patient not found', requestedBy: req.user?.uid });
    } else if (err.message === 'DOCTOR_NOT_FOUND') {
      return res.status(404).json({ message: 'Doctor not found', requestedBy: req.user?.uid });
    } else if (err.message === 'INVALID_TYPE') {
      return res.status(400).json({
        message: 'Invalid investigation type',
        validTypes: Object.values(INVESTIGATION_TYPES),
        requestedBy: req.user?.uid
      });
    } else if (err.message === 'INVALID_PRIORITY') {
      return res.status(400).json({
        message: 'Invalid priority level',
        validPriorities: Object.values(PRIORITY_LEVELS),
        requestedBy: req.user?.uid
      });
    }
    
    error(res, 'Failed to order investigation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy phone-based investigation request
export const legacyInvestigationRequest = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const { test_name, file_key } = req.body;
    const requestedBy = req.user?.uid;

    if (!phone || !test_name) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'Phone and test name are required.',
        requestedBy
      });
    }

    const result = await orderService.createLegacyInvestigation({
      phone,
      test_name,
      file_key,
      createdBy: requestedBy
    });

    await logAudit(req, 'legacy-investigation-requested', { phone, test_name });

    success(res, {
      investigation: result,
      requestedBy
    }, RESPONSE_MESSAGES.INVESTIGATION_REQUESTED);

  } catch (err) {
    logger.error('Legacy Investigation Request Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};