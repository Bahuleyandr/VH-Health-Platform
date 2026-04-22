// Patient-facing virtual-ward check-in routes.
// Mounted at /api/v1/patient/virtual-ward. Patients + SUPER_ADMIN only.

import express from 'express';
import { success, error } from '../../utils/responseHelper.js';
import {
  submitCheckIn,
} from '../../services/ai/virtualWardService.js';

const router = express.Router();

router.post('/check-in', async (req, res, next) => {
  try {
    if (!req.user?.uid) return error(res, 'Authentication required', 401);
    const result = await submitCheckIn({
      req,
      enrollmentId: req.body?.enrollment_id || null,
      patientUid: req.body?.patient_uid || req.user.uid,
      symptoms: req.body?.symptoms || {},
      vitals: req.body?.vitals || {},
      medicationAdherencePct: req.body?.medication_adherence_pct ?? null,
      moodScore: req.body?.mood_score ?? null,
      painScore: req.body?.pain_score ?? null,
      wearablePayload: req.body?.wearable_payload || {},
      source: req.body?.source || 'patient_self_report',
    });
    return success(res, result, 'Check-in received', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
