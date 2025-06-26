// src/routes/record/doctorRoutes.js
import express from 'express';
import * as doctorController from '../../controllers/record/doctorRecordController.js';
import { 
  recordCreateValidator, 
  recordUpdateValidator,
  recordIdValidator 
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// Create new medical record
router.post('/create', recordCreateValidator, doctorController.createMedicalRecord);

// Update medical record
router.put('/:id', 
  [...recordIdValidator, ...recordUpdateValidator], 
  doctorController.updateMedicalRecord
);

export default router;