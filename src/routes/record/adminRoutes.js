// src/routes/record/adminRoutes.js
import express from 'express';
import * as adminController from '../../controllers/record/adminRecordController.js';
import { 
  recordIdValidator, 
  deleteReasonValidator 
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// Get analytics
router.get('/admin/analytics', adminController.getRecordAnalytics);

// Get HIPAA audit
router.get('/admin/hipaa-audit', adminController.getHipaaAudit);

// Delete record
router.delete('/:id', 
  [...recordIdValidator, ...deleteReasonValidator], 
  adminController.deleteMedicalRecord
);

export default router;