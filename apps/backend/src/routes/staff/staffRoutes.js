import express from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
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
  targetParam: 'identifier',
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
    ['/:identifier', updateStaffValidation, guardProfileUpdate, staffController.updateStaffProfile]
  ]
});

// The staff directory + profile record surface. This file cannot bootstrap its
// own tag — `staff/staffRoutes.js` is the audience word in both the directory
// and the file name, so the generator gets no module signal and every operation
// here fell through to the URL: `list`, `shift`, `create` (verbs, not domains)
// and, for /:identifier, `unclassified`. It belongs with the rest of staff
// administration.
markRouterDomain(router, 'staff-admin');

export default router;
