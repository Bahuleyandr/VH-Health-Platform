import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/pharmacy/orderService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';

// Get orders by UID
export const getOrdersByUID = async (req, res) => {
  try {
    const { uid } = req.params;
    const { status, limit = 50, offset = 0 } = req.query;
    const requestedBy = req.user?.uid || 'anonymous';
    const userRole = req.user?.role;

    // IDOR protection: patients can only view their own orders
    if (userRole === 'PATIENT' && String(req.user?.uid) !== String(uid)) {
      return error(res, 'Access denied: You can only view your own orders', HTTP_STATUS.FORBIDDEN);
    }

    const result = await orderService.getOrdersByUID(uid, {
      status,
      limit: parseInt(limit),
      offset: parseInt(offset),
      tenantId: resolveTenantOrThrow(req),
    });

    success(res, {
      ...result,
      requestedBy
    }, 'Pharmacy orders fetched successfully');
  } catch (err) {
    logger.error('Get Orders by UID Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
