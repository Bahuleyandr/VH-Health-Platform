// src/routes/doctor/doctorRoutes.js
import express from 'express';
import { validationResult } from 'express-validator';
import { requiredString } from '../../validators/sharedValidators.js';
import { doctorController } from '../../controllers/doctor/doctorController.js';
import { doctorValidators } from '../../validators/doctor/doctorValidator.js';

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
router.get('/test', doctorController.test);

// Legacy routes (backward compatibility)
router.get('/', doctorController.getAllDoctors);
router.get('/:doctorId', validateDoctorId, doctorController.getDoctorById);
router.post('/', requiredString('name', 255), validate, doctorController.addDoctor);
router.delete('/:doctorId', validateDoctorId, doctorController.deleteDoctor);

// Enhanced routes
router.get('/list', doctorValidators.listDoctors, doctorController.getAllDoctors);
router.get('/profile/:id', doctorValidators.getById, doctorController.getDoctorById);
router.get('/department/:department', doctorController.getDoctorsByDepartment);
router.get('/available/now', doctorController.getAvailableDoctors);

// Profile management
router.post('/profile', doctorValidators.createProfile, doctorController.createDoctorProfile);
router.put('/:id/profile', doctorValidators.updateProfile, doctorController.updateDoctorProfile);
router.put('/:id/availability', doctorValidators.updateAvailability, doctorController.updateDoctorAvailability);

// Deactivation (admin only)
router.delete('/:id/deactivate', doctorController.deactivateDoctor);

export default router;