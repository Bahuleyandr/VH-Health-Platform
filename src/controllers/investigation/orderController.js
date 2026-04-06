import prisma from '../../lib/prisma.js';
import { INVESTIGATION_TYPES, PRIORITY_LEVELS } from '../../config/investigationConfig.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/investigation/orderService.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { success, error } from '../../utils/responseHelper.js';

// Fire-and-forget urgent alert to lab-adjacent staff
async function sendUrgentAlert(investigation, patientName) {
  try {
    const staffResult = await prisma.$queryRawUnsafe(
      `SELECT id, device_token, name FROM users
       WHERE role IN ('NURSE', 'NURSING_STAFF', 'TECHNICIAN', 'LAB_TECHNICIAN', 'LAB', 'RECEPTIONIST', 'RADIOLOGIST')
         AND device_token IS NOT NULL`
    );

    if (staffResult.length === 0) {
      logger.info('No staff with device_tokens found for urgent alert');
      return;
    }

    const tokens = staffResult.map(r => r.device_token).filter(Boolean);
    if (tokens.length === 0) return;

    await sendPushNotification({
      tokens,
      title: '⚠️ URGENT Investigation',
      body: `⚠️ URGENT: ${investigation.test_name} for ${patientName} — immediate processing required`,
      data: { type: 'urgent_investigation', investigation_id: String(investigation.id) }
    });

    await prisma.$queryRawUnsafe(
      `UPDATE investigations SET urgent_alert_sent = TRUE WHERE id = $1`, investigation.id);

    logger.info(`⚠️ Urgent alert sent for investigation ${investigation.id} to ${tokens.length} staff`);
  } catch (err) {
    logger.error(`Failed to send urgent alert for investigation ${investigation?.id}: ${err.message}`);
  }
}

// Order new investigation
export const orderInvestigation = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    if (!orderService.canOrderInvestigations(userRole)) {
      return error(res, 'Access denied: Doctor privileges required to order investigations', 403);
    }
    
    const orderData = {
      ...req.body,
      orderedBy: requestedBy
    };

    const result = await orderService.createInvestigationOrder(orderData);

    if (!result) {
      return error(res, 'Failed to create investigation order', 400);
    }

    await logAudit(req, 'investigation-ordered', { 
      investigation_id: result.investigation.id,
      patient_id: result.investigation.patient_id,
      test_name: result.investigation.test_name,
      type: result.investigation.type
    });

    // Fire-and-forget urgent alert for URGENT/STAT investigations
    const priority = result.investigation?.priority?.toUpperCase();
    if (priority === 'URGENT' || priority === 'STAT') {
      sendUrgentAlert(result.investigation, result.patient_name).catch(e => logger.warn('Urgent investigation alert failed:', e.message));
    }

    success(res, {
      ...result,
      orderedBy: requestedBy
    }, 'Investigation ordered successfully');

  } catch (err) {
    logger.error('Order Investigation Error:', err);
    
    if (err.message === 'PATIENT_NOT_FOUND') {
      return error(res, 'Patient not found', 404);
    } else if (err.message === 'DOCTOR_NOT_FOUND') {
      return error(res, 'Doctor not found', 404);
    } else if (err.message === 'INVALID_TYPE') {
      return error(res, 'Invalid investigation type', 400);
    } else if (err.message === 'INVALID_PRIORITY') {
      return error(res, 'Invalid priority level', 400);
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
      return error(res, 'Phone and test name are required.', HTTP_STATUS.BAD_REQUEST);
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