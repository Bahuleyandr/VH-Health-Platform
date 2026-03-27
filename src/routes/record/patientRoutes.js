// src/routes/record/patientRoutes.js
import express from 'express';
import * as patientController from '../../controllers/record/patientRecordController.js';
import { 
  healthRecordCreateValidator, 
  phoneValidator, 
  uidValidator 
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// P2 Security: Derive phone from JWT instead of URL path
router.get('/health-records/my', (req, res, next) => {
  const phone = req.user?.phone;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone not available in token. Use /health-records/:phone endpoint.' });
  }
  req.params.phone = phone;
  next();
}, patientController.getHealthRecordsByPhone);

// Get records by UID
router.get('/uid/:uid', uidValidator, patientController.getRecordsByUID);

// Get health records by phone
router.get('/health-records/:phone', phoneValidator, patientController.getHealthRecordsByPhone);

// Create health record
router.post('/health-records', healthRecordCreateValidator, patientController.createHealthRecord);

// Legacy endpoint - consultations
router.get('/consultations/:phoneNumber', patientController.getConsultationsByPhone);

export default router;