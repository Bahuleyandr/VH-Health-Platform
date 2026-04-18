// src/routes/pharmacy/adminRoutes.js

import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as analyticsController from '../../controllers/pharmacy/analyticsController.js';
import * as orderController from '../../controllers/pharmacy/orderController.js';
import { getOrdersValidation } from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

// Admin-only routes
wrapAutoRBAC(router, 'pharmacyAdminRoutes', {
  get: [
    ['/orders', getOrdersValidation, orderController.getAllOrders],
    ['/analytics', analyticsController.getAnalytics]
  ]
});

export default router;