import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as pharmacyController from '../../controllers/staff/pharmacyController.js';
import { 
  updatePharmacyOrderValidation 
} from '../../validators/staff/pharmacyValidators.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffPharmacyRoutes', {
  post: [
    ['/orders', updatePharmacyOrderValidation, pharmacyController.updatePharmacyOrder]
  ]
});

export default router;