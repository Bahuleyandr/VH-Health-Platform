// src/routes/record/patientRoutes.js
import express from 'express';
import * as patientController from '../../controllers/record/patientRecordController.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import {
  healthRecordCreateValidator,
  phoneValidator,
  uidValidator
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// CAN-039: the /api/v1/records parent mount applies patientAccessGuard before
// these child :uid params are bound, so it can't see them. Guard the uid-based
// record reads at the child route (governed; shadow→enforce). The legacy
// :phone routes need a phone→patient resolver (the /my + /uid routes are the
// preferred, PII-free surface) — tracked as follow-up.
const guardRecordUid = patientAccessGuard('PATIENT_RECORD', { careTeamModeGoverned: true });

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
router.get('/uid/:uid', uidValidator, guardRecordUid, patientController.getRecordsByUID);

// Get health records by phone
router.get('/health-records/:phone', phoneValidator, patientController.getHealthRecordsByPhone);

// Create health record
router.post('/health-records', healthRecordCreateValidator, patientController.createHealthRecord);

// Authenticated patient's own consultations
router.get('/consultations/my', patientController.getMyConsultations);

// UID-based consultations (preferred — no PII in URL)
router.get('/consultations/uid/:uid', uidValidator, guardRecordUid, patientController.getConsultationsByUid);

// Legacy endpoint - consultations
router.get('/consultations/:phoneNumber', patientController.getConsultationsByPhone);

export default router;
