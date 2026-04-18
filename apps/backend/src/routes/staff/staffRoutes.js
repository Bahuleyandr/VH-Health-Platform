import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as staffController from '../../controllers/staff/staffController.js';
import { 
  staffProfileValidation, 
  updateStaffValidation,
  staffListValidation,
  staffByDepartmentValidation,
  staffByShiftValidation,
  staffIdentifierValidation
} from '../../validators/staff/staffValidators.js';

const router = express.Router();

// Staff management routes only (no attendance, medical, pharmacy, hr routes here)
wrapAutoRBAC(router, 'staffRoutes', {
  get: [
    ['/list', staffListValidation, staffController.getStaffList],
    ['/:identifier', staffIdentifierValidation, staffController.getStaffProfile],
    ['/department/:department', staffByDepartmentValidation, staffController.getStaffByDepartment],
    ['/shift/:shift', staffByShiftValidation, staffController.getStaffByShift],
    ['/stats/summary', staffController.getStaffStatistics]
  ],
  
  post: [
    ['/create', staffProfileValidation, staffController.createStaffProfile]
  ],
  
  put: [
    ['/:id', updateStaffValidation, staffController.updateStaffProfile]
  ]
});

export default router;