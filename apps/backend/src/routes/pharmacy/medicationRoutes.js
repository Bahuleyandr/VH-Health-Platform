import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as medicationController from '../../controllers/pharmacy/medicationController.js';
import { 
  createMedicationValidation,
  updateMedicationValidation,
  updateStockValidation,
  searchMedicationValidation 
} from '../../validators/pharmacy/medicationValidators.js';

const router = express.Router();

// Pharmacy staff routes
wrapAutoRBAC(router, 'pharmacyStaffMedicationRoutes', {
  get: [
    ['/', medicationController.getAllMedications],
    ['/:id', medicationController.getMedicationById],
    ['/category/:category', medicationController.getMedicationsByCategory],
    ['/search', searchMedicationValidation, medicationController.searchMedications]
  ],
  
  put: [
    ['/:id/stock', updateStockValidation, medicationController.updateStock]
  ]
});

// Admin routes
wrapAutoRBAC(router, 'pharmacyAdminMedicationRoutes', {
  post: [
    ['/', createMedicationValidation, medicationController.createMedication]
  ],
  
  put: [
    ['/:id', updateMedicationValidation, medicationController.updateMedication]
  ],
  
  delete: [
    ['/:id', medicationController.deleteMedication]
  ]
});

export default router;