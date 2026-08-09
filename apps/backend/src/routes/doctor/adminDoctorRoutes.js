// src/routes/doctor/adminDoctorRoutes.js
import express from 'express';
import { validationResult } from 'express-validator';
import { adminDoctorController } from '../../controllers/doctor/adminDoctorController.js';
import { doctorStatsController } from '../../controllers/doctor/doctorStatsController.js';
import { adminDoctorValidators } from '../../validators/doctor/adminDoctorValidator.js';
import { doctorCreateValidator } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

// Validation middleware for numeric doctor IDs
const validateDoctorId = (req, res, next) => {
  if (!/^\d+$/.test(req.params.doctorId)) {
    return res.status(400).json({ 
      success: false,
      error: 'Doctor ID must be numeric' 
    });
  }
  next();
};

// Test route
router.get('/test', adminDoctorController.test);

// Overview and analytics
router.get('/overview', adminDoctorController.getDoctorOverview);
router.get('/manage', adminDoctorController.getDoctorManagementList);
router.get('/:id/analytics', adminDoctorValidators.getAnalytics, doctorStatsController.getDoctorAnalytics);
router.get('/workload-analysis', adminDoctorValidators.workloadAnalysis, doctorStatsController.getWorkloadAnalysis);

// Doctor management
router.post('/create', adminDoctorValidators.createDoctor, adminDoctorController.createDoctorAccount);
router.post('/bulk-operations', adminDoctorValidators.bulkOperations, adminDoctorController.performBulkOperations);
router.put('/:id/profile', adminDoctorValidators.updateProfile, adminDoctorController.updateDoctorProfile);
router.put('/:id/availability', adminDoctorValidators.updateAvailability, adminDoctorController.updateDoctorAvailability);
router.delete('/:id/account', adminDoctorValidators.deleteDoctor, adminDoctorController.deleteDoctorAccount);

// Legacy routes
router.post('/', ...doctorCreateValidator, validate, adminDoctorController.addDoctor);
router.delete('/:doctorId', validateDoctorId, adminDoctorController.deleteDoctor);

export default router;