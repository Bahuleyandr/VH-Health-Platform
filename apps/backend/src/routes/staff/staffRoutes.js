import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as staffController from '../../controllers/staff/staffController.js';
import { staffAccessGuard } from '../../middleware/staffAccessMiddleware.js';
import { STAFF_ACCESS_POLICY_CODES } from '../../services/security/staffAccessDecisionService.js';
import { 
  staffProfileValidation, 
  updateStaffValidation,
  staffListValidation,
  staffByDepartmentValidation,
  staffByShiftValidation,
  staffIdentifierValidation
} from '../../validators/staff/staffValidators.js';

const router = express.Router();
const guardDirectoryView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_DIRECTORY_VIEW, {
  allowNoTarget: true,
});
const guardProfileView = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW, {
  targetParam: 'identifier',
  requireTarget: true,
});
const guardProfileCreate = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE, {
  allowNoTarget: true,
});
const guardProfileUpdate = staffAccessGuard(STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE, {
  targetParam: 'id',
  requireTarget: true,
});

// Staff management routes only (no attendance, medical, pharmacy, hr routes here)
wrapAutoRBAC(router, 'staffRoutes', {
  get: [
    ['/list', guardDirectoryView, staffListValidation, staffController.getStaffList],
    ['/:identifier', staffIdentifierValidation, guardProfileView, staffController.getStaffProfile],
    ['/department/:department', guardDirectoryView, staffByDepartmentValidation, staffController.getStaffByDepartment],
    ['/shift/:shift', guardDirectoryView, staffByShiftValidation, staffController.getStaffByShift],
    ['/stats/summary', guardDirectoryView, staffController.getStaffStatistics]
  ],
  
  post: [
    ['/create', guardProfileCreate, staffProfileValidation, staffController.createStaffProfile]
  ],
  
  put: [
    ['/:id', updateStaffValidation, guardProfileUpdate, staffController.updateStaffProfile]
  ]
});

export default router;
