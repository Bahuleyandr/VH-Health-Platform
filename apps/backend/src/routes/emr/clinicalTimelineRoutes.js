// src/routes/emr/clinicalTimelineRoutes.js
import express from 'express';
import * as clinicalNotesService from '../../services/emr/clinicalNotesService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

// GET /emr/timeline/:patientUid - Unified clinical timeline
router.get('/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date_from, date_to } = req.query;

    const timeline = await clinicalNotesService.getPatientTimeline(
      patientUid,
      date_from || null,
      date_to || null,
    );

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'clinical_timeline',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, timeline, 'Patient timeline retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;
