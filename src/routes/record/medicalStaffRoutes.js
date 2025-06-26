// src/routes/record/medicalStaffRoutes.js
import express from 'express';
import * as medicalStaffController from '../../controllers/record/medicalStaffRecordController.js';
import {
  paginationValidator,
  filterValidator,
  recordIdValidator,
  patientIdValidator
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// Get all medical records with filtering
router.get('/list', 
  [...paginationValidator, ...filterValidator], 
  medicalStaffController.getMedicalRecords
);

// Get medical record by ID
router.get('/record/:id', 
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
  medicalStaffController.getDoctorRecords
);

// Get patient summary
router.get('/patient/:patient_id/summary', 
  patientIdValidator, 
  medicalStaffController.getPatientSummary
);

export default router;