// src/routes/record/medicalStaffRoutes.js
import express from 'express';
import { query } from 'express-validator';
import * as medicalStaffController from '../../controllers/record/medicalStaffRecordController.js';
import {
  paginationValidator,
  filterValidator,
  recordIdValidator,
  patientIdValidator,
  doctorIdValidator
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// Get all medical records with filtering
router.get('/records', 
  [...paginationValidator, ...filterValidator], 
  medicalStaffController.getMedicalRecords
);

// Get medical record by ID
router.get('/records/:id', 
  recordIdValidator, 
  medicalStaffController.getMedicalRecordById
);

// Get patient records
router.get('/patient/:patient_id', 
  patientIdValidator, 
  medicalStaffController.getPatientRecords
);

// Get doctor records
router.get('/doctor/:doctor_id', 
  doctorIdValidator,
  medicalStaffController.getDoctorRecords
);

// Get patient summary
router.get('/patient/:patient_id/summary', 
  patientIdValidator, 
  medicalStaffController.getPatientSummary
);

// Search medical records
router.get('/search', 
  query('q').notEmpty().withMessage('Search term required').trim(),
  medicalStaffController.searchMedicalRecords
);

export default router;