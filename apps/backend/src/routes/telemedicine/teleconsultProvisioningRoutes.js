import { Router } from 'express';

import {
  ensureTeleconsultationForAppointment,
  ensureVideoSession,
  getTeleconsultRoomState,
  issueJoinToken,
} from '../../services/telemedicine/teleconsultProvisioningService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success } from '../../utils/responseHelper.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function userUidOf(req) {
  return req.user?.uid || null;
}

router.post('/appointments/:appointmentId/ensure', async (req, res, next) => {
  try {
    const teleconsultation = await ensureTeleconsultationForAppointment({
      tenantId: tenantOf(req),
      appointmentId: req.params.appointmentId,
      actorUid: userUidOf(req),
      role: req.user?.role,
    });
    const videoSession = await ensureVideoSession({
      tenantId: tenantOf(req),
      teleconsultationId: teleconsultation.id,
    });
    return success(res, {
      teleconsultation,
      video_session: videoSession,
      recording_enabled: false,
    }, 'Teleconsultation provisioned');
  } catch (err) {
    return next(err);
  }
});

router.get('/:teleconsultationId/room-state', async (req, res, next) => {
  try {
    const state = await getTeleconsultRoomState({
      tenantId: tenantOf(req),
      teleconsultationId: req.params.teleconsultationId,
    });
    return success(res, state, 'Teleconsult room state retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/:teleconsultationId/token', async (req, res, next) => {
  try {
    const token = await issueJoinToken({
      tenantId: tenantOf(req),
      teleconsultationId: req.params.teleconsultationId,
      participantUid: userUidOf(req),
      role: req.body?.role || 'clinician',
    });
    return success(res, token, 'Teleconsult join token issued');
  } catch (err) {
    return next(err);
  }
});

export default router;
