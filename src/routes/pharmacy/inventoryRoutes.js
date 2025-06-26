import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as inventoryController from '../../controllers/pharmacy/inventoryController.js';
import { 
  inventoryQueryValidation 
} from '../../validators/pharmacy/inventoryValidators.js';

const router = express.Router();

// Pharmacy staff routes
wrapAutoRBAC(router, 'pharmacyStaffInventoryRoutes', {
  get: [
    ['/low-stock', inventoryQueryValidation, inventoryController.getLowStock],
    ['/expired', inventoryController.getExpired],
    ['/expiring-soon', inventoryQueryValidation, inventoryController.getExpiringSoon],
    ['/summary', inventoryController.getInventorySummary]
  ]
});

// Re-export categories under both paths for compatibility
router.get('/categories/list', inventoryController.getCategories);

export default router;