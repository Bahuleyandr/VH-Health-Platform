import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/pharmacy/orderService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { broadcast } from '../../utils/websocket/wsServer.js';

// Place pharmacy order
const VALID_DELIVERY_TYPES = new Set(['delivery', 'counter']);

export const placeOrder = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const { order_note, file_key, prescription_id, urgent, delivery_type } = req.body;
    const requestedBy = req.user?.uid || 'system';
    const requestedByRole = req.user?.role || 'unknown';

    if (!phone || !order_note) {
      return error(res, 'Phone and order note are required', HTTP_STATUS.BAD_REQUEST);
    }

    // `delivery_type` was previously dropped silently, so the counter-
    // dispense short-circuit (POST /:id/dispense-counter) refused every
    // walk-in order placed via this endpoint. Accept it now, default to
    // 'delivery' for backwards-compat. Finding:
    //   2026-05-09-pediatric-opd-pharmacy-counter-delivery-type-ignored.
    let resolvedDeliveryType = 'delivery';
    if (delivery_type != null && delivery_type !== '') {
      const dtNorm = String(delivery_type).toLowerCase().trim();
      if (!VALID_DELIVERY_TYPES.has(dtNorm)) {
        return error(
          res,
          `delivery_type must be one of: ${[...VALID_DELIVERY_TYPES].join(', ')}`,
          HTTP_STATUS.BAD_REQUEST,
        );
      }
      resolvedDeliveryType = dtNorm;
    }

    const order = await orderService.createOrder({
      phone,
      order_note,
      file_key,
      prescription_id,
      urgent,
      delivery_type: resolvedDeliveryType,
      requestedBy,
      requestedByRole,
      tenantId: resolveTenantOrThrow(req), // CAN-033: scope phone lookup + insert
    });

    success(res, order, RESPONSE_MESSAGES.ORDER_PLACED);
  } catch (err) {
    logger.error('Place Order Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

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
      updatedByRole,
      req.tenantId
    );

    if (!result) {
      return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    }

    // Emit WebSocket event for order status change
    broadcast('queue-updates', {
      orderId: req.params.orderId,
      status,
      updatedBy: req.user?.uid,
    });

    success(res, result, 'Order status updated successfully');
  } catch (err) {
    logger.error('Update Order Status Error:', err);
    
    if (err.message === 'INVALID_STATUS') {
      error(res, 'Invalid status provided', HTTP_STATUS.BAD_REQUEST);
    } else if (err.message === 'INVALID_TRANSITION') {
      error(res, 'Invalid order status transition', HTTP_STATUS.BAD_REQUEST);
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
