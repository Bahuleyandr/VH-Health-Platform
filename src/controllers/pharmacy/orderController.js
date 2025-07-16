import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/pharmacy/orderService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// Place pharmacy order
export const placeOrder = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const { order_note, file_key, prescription_id, urgent } = req.body;
    const requestedBy = req.user?.uid || 'system';
    const requestedByRole = req.user?.role || 'unknown';

    if (!phone || !order_note) {
      return error(res, 'Phone and order note are required', HTTP_STATUS.BAD_REQUEST);
    }

    const order = await orderService.createOrder({
      phone,
      order_note,
      file_key,
      prescription_id,
      urgent,
      requestedBy,
      requestedByRole
    });

    success(res, order, RESPONSE_MESSAGES.ORDER_PLACED);
  } catch (err) {
    logger.error('Place Order Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get orders by phone
export const getOrdersByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const { status, limit = 50, offset = 0 } = req.query;
    const requestedBy = req.user?.uid || 'anonymous';
    const userRole = req.user?.role;
    const userPhone = req.user?.phone;

    // Check access permissions
    if (userRole === 'PATIENT' && userPhone && normalizePhone(userPhone) !== phone) {
      return error(res, 'Access denied: You can only view your own orders', HTTP_STATUS.FORBIDDEN);
    }

    const result = await orderService.getOrdersByPhone(phone, {
      status,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    success(res, {
      ...result,
      requestedBy,
      phone
    }, 'Pharmacy orders fetched successfully');
  } catch (err) {
    logger.error('Get Orders Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get orders by UID
export const getOrdersByUID = async (req, res) => {
  try {
    const { uid } = req.params;
    const { status, limit = 50, offset = 0 } = req.query;
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await orderService.getOrdersByUID(uid, {
      status,
      limit: parseInt(limit),
      offset: parseInt(offset)
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

// Update order status (pharmacy staff)
export const updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, notes } = req.body;
    const updatedBy = req.user?.uid || 'system';
    const updatedByRole = req.user?.role || 'unknown';

    if (!status) {
      return error(res, 'Status is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await orderService.updateOrderStatus(
      orderId,
      status,
      notes,
      updatedBy,
      updatedByRole
    );

    if (!result) {
      return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result, 'Order status updated successfully');
  } catch (err) {
    logger.error('Update Order Status Error:', err);
    
    if (err.message === 'INVALID_STATUS') {
      error(res, 'Invalid status provided', HTTP_STATUS.BAD_REQUEST);
    } else {
      error(res, 'Failed to update order status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

// Get all orders (admin)
export const getAllOrders = async (req, res) => {
  try {
    const { status, limit = 100, offset = 0, urgent_only } = req.query;
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await orderService.getAllOrders({
      status,
      limit: parseInt(limit),
      offset: parseInt(offset),
      urgent_only: urgent_only === 'true'
    });

    success(res, {
      ...result,
      requestedBy
    }, 'All pharmacy orders retrieved successfully');
  } catch (err) {
    logger.error('Get All Orders Error:', err);
    error(res, 'Failed to retrieve pharmacy orders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};