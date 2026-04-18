import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as deliveryController from '../../controllers/delivery/deliveryTrackingController.js';
import logger from '../../logging/logger.js';

const router = express.Router();

logger.info('✅ Delivery tracking routes loaded');

// Staff: send GPS location updates
wrapAutoRBAC(router, 'deliveryTrackingRoutes', {
  post: [
    ['/location-update', [], deliveryController.updateDeliveryLocation],
    ['/stop-tracking', [], deliveryController.stopTracking],
  ],
  get: [
    ['/track/:order_type/:order_id', [], deliveryController.getDeliveryTracking],
  ],
});

export default router;
