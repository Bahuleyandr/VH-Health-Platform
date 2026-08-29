// src/routes/pharmacy/adminRoutes.js

import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as analyticsController from '../../controllers/pharmacy/analyticsController.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import { getOrdersValidation } from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

// Admin-only routes
wrapAutoRBAC(router, 'pharmacyAdminRoutes', {
  get: [
    ['/orders', getOrdersValidation, pharmacyOrderController.getOrderQueue],
    ['/analytics', analyticsController.getAnalytics]
  ]
});

export default router;
