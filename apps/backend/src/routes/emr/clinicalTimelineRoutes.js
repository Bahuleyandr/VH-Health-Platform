// src/routes/emr/clinicalTimelineRoutes.js
import express from 'express';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { readCanonicalPatientTimeline } from '../../services/clinical/canonicalClinicalPlatformService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

// GET /emr/timeline/:patientUid - Unified clinical timeline
router.get('/:patientUid', patientAccessGuard('EMR_TIMELINE', { policyCode: 'patient.timeline.view' }), async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date_from, date_to, limit } = req.query;

    const timeline = await readCanonicalPatientTimeline(patientUid, {
      tenantId: req.tenantId || req.user?.tenant_id,
      date_from: date_from || null,
      date_to: date_to || null,
      limit,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'clinical_timeline',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, timeline.events, 'Patient timeline retrieved', 200, {
      canonical: timeline.counts,
      generated_at: timeline.generated_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
