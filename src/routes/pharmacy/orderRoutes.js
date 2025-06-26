import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as orderController from '../../controllers/pharmacy/orderController.js';
import * as pharmacyController from '../../controllers/pharmacyController.js';
import { 
  placeOrderValidation,
  updateOrderStatusValidation,
  getOrdersValidation,
  phoneParamValidation,
  uidParamValidation 
} from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

// Patient routes
wrapAutoRBAC(router, 'pharmacyOrderRoutes', {
  post: [
    ['/', placeOrderValidation, orderController.placeOrder]
  ],
  
  get: [
    ['/uid/:uid', uidParamValidation, orderController.getOrdersByUID],
    ['/:phone', phoneParamValidation, getOrdersValidation, orderController.getOrdersByPhone]
  ]
});

// Pharmacy staff routes
wrapAutoRBAC(router, 'pharmacyStaffOrderRoutes', {
  put: [
    ['/:orderId/status', updateOrderStatusValidation, orderController.updateOrderStatus]
  ]
});

export default router;