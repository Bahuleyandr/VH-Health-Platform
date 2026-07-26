import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentValidationService from '../../services/appointment/appointmentValidationService.js';
import * as pointService from '../../services/gamification/pointService.js';
import { getWaitingQueueForDoctor } from '../../services/appointment/waitTimeService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { broadcast, sendToUser } from '../../utils/websocket/wsServer.js';
import { emitAppointmentEvent, emitQueuePosition } from '../../utils/websocket/realtimeEmitter.js';
import { logAudit } from '../../utils/logAudit.js';

// Status transitions that shift every downstream patient's queue position
const QUEUE_SHIFTING_STATUSES = new Set(['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED']);

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function attachAppointmentPhiContext(req, appointment) {
  req.phiContext = {
    ...(req.phiContext ?? {}),
    appointmentId: appointment?.id ?? req.params?.id ?? null,
    appointment_id: appointment?.id ?? req.params?.id ?? null,
    patientId: appointment?.patient_id ?? null,
    patient_id: appointment?.patient_id ?? null,
    patientUid: appointment?.patient_uid ?? null,
    patient_uid: appointment?.patient_uid ?? null,
  };
}

async function fanOutQueuePositions(appointment) {
  if (!appointment?.doctor_id || !appointment?.appointment_date) return;
  const date = new Date(appointment.appointment_date).toISOString().split('T')[0];
  try {
    const waiting = await getWaitingQueueForDoctor(appointment.doctor_id, date);
    for (const row of waiting) {
      emitQueuePosition({
        patientId: row.patientId,
        appointmentId: row.appointmentId,
        position: row.position,
        etaMinutes: row.etaMinutes,
      });
    }
  } catch (err) {
    logger.warn('Queue-position fan-out failed:', err.message);
  }
}

export const updateAppointmentStatus = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { id } = req.params;
    const { status, notes } = req.body;

    // Validate status
    const statusValidation = appointmentValidationService.validateStatusUpdate(status);
    if (!statusValidation.valid) {
      return error(res, statusValidation.error, HTTP_STATUS.BAD_REQUEST);
    }

    // Get appointment to check permissions
    const appointment = await appointmentService.getAppointmentById(id, tenantId);
    
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    // Check permissions
    if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
      return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
    }
    if (req.user?.role === 'DOCTOR' && appointment.doctor_id !== req.user.id) {
      return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
    }

    // Update status
    const updatedAppointment = await appointmentService.updateAppointmentStatus(
      id,
      statusValidation.status,
      notes,
      req.user?.name,
      tenantId,
      {
        actorUid: req.user?.uid || null,
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        source: 'status_update',
      },
    );
    attachAppointmentPhiContext(req, {
      ...updatedAppointment,
      id: updatedAppointment?.id ?? appointment.id ?? Number(id),
      patient_id: updatedAppointment?.patient_id ?? appointment.patient_id ?? null,
      patient_uid: updatedAppointment?.patient_uid ?? appointment.patient_uid ?? null,
    });
    await logAudit(req, 'FRONT_OFFICE_APPOINTMENT_STATUS_UPDATED', {
      appointment_id: Number(id),
      appointment_uid: appointment.uid || updatedAppointment?.uid || null,
      patient_id: appointment.patient_id ?? updatedAppointment?.patient_id ?? null,
      patient_uid: appointment.patient_uid ?? null,
      doctor_id: appointment.doctor_id ?? updatedAppointment?.doctor_id ?? null,
      prior_status: appointment.status,
      updated_status: statusValidation.status,
      note_present: Boolean(notes),
    }, {
      resource: 'appointment',
      resourceId: id,
    });

    // Emit WebSocket event for appointment status change
    broadcast('appointment-updates', {
      appointmentId: id,
      status: statusValidation.status,
      updatedBy: req.user?.name,
    });
    // Notify patient and doctor directly
    if (updatedAppointment.patient_id) {
      sendToUser(updatedAppointment.patient_id, 'appointment-status-changed', {
        appointmentId: id, status: statusValidation.status,
      });
    }
    if (updatedAppointment.doctor_id) {
      sendToUser(updatedAppointment.doctor_id, 'appointment-status-changed', {
        appointmentId: id, status: statusValidation.status,
      });
    }

    // Staff-wide appointment feed (gated to staff roles via channelAuth).
    // PHI-free {kind, at} nudge — consumers (Flutter staff app + admin board) refetch.
    emitAppointmentEvent('status-changed', { tenantId });

    // Queue-position fan-out to remaining waiting patients on status transitions that shift the queue
    if (QUEUE_SHIFTING_STATUSES.has(statusValidation.status)) {
      fanOutQueuePositions(updatedAppointment).catch(() => {});
    }

    // Gamification: fire-and-forget point awards
    if (statusValidation.status === 'COMPLETED') {
      pointService.awardAppointmentPoints(updatedAppointment).catch(err =>
        logger.warn('Gamification: appointment point award failed', { error: err.message })
      );
    }
    if (statusValidation.status === 'IN_PROGRESS') {
      pointService.awardOnTimeBonus(updatedAppointment).catch(err =>
        logger.warn('Gamification: on-time bonus check failed', { error: err.message })
      );
    }

    success(res, {
      appointment: updatedAppointment,
      updated_by: req.user?.name
    }, 'Appointment status updated successfully');
  } catch (err) {
    logger.error('Error updating appointment status:', err);
    return relayAppError(res, err, 'Failed to update appointment status');
  }
};
