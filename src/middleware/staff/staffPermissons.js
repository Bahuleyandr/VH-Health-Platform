import { STAFF_ROLES } from '../../config/staffConfig.js';

export const requireHRPermission = (req, res, next) => {
  const userRole = req.user?.role;
  if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
    return res.status(403).json({
      message: 'HR permission required',
      requiredRoles: ['ADMIN', 'HR_STAFF']
    });
  }
  next();
};

export const requireMedicalPermission = (req, res, next) => {
  const userRole = req.user?.role;
  if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
    return res.status(403).json({
      message: 'Medical staff permission required',
      requiredRoles: ['DOCTOR', 'NURSING_STAFF', 'ADMIN']
    });
  }
  next();
};

export const requirePharmacyPermission = (req, res, next) => {
  const userRole = req.user?.role;
  if (!['PHARMACY_STAFF', 'DOCTOR', 'ADMIN'].includes(userRole)) {
    return res.status(403).json({
      message: 'Pharmacy permission required',
      requiredRoles: ['PHARMACY_STAFF', 'DOCTOR', 'ADMIN']
    });
  }
  next();
};