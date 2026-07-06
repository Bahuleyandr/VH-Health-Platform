import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  getTeleconsultFeatureState,
  teleconsultPatientJoinState,
} from '../telemedicine/teleconsultProvisioningService.js';

function cleanInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isTeleVisit(row) {
  return String(row?.visit_type || row?.visitType || '')
    .trim()
    .toUpperCase() === 'TELE';
}

function teleconsultPayload(row, featureState) {
  if (!row) {
    return {
      teleconsultation_id: null,
      teleconsult_status: null,
      teleconsult_join_state: null,
      teleconsult_joinable: false,
      teleconsult_consent_recorded: false,
      teleconsult_recording_enabled: false,
      teleconsult_livekit_enabled: featureState.livekit_enabled,
      teleconsult_provider: featureState.provider,
    };
  }

  const joinState = teleconsultPatientJoinState(row);
  return {
    teleconsultation_id: cleanInt(row.teleconsultation_id ?? row.id),
    teleconsult_status: row.status ?? null,
    teleconsult_join_state: joinState,
    teleconsult_joinable: ['lobby-open', 'in-progress'].includes(joinState),
    teleconsult_consent_recorded: Boolean(
      row.remote_consent_id && row.remote_consent_signed_at,
    ),
    teleconsult_recording_enabled: false,
    teleconsult_livekit_enabled: featureState.livekit_enabled,
    teleconsult_provider: featureState.provider,
  };
}

export async function attachTeleconsultState(rows, db = prisma) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const featureState = getTeleconsultFeatureState();
  const appointmentIds = [
    ...new Set(rows.map((row) => cleanInt(row?.id)).filter(Boolean)),
  ];
  if (appointmentIds.length === 0) return rows;

  try {
    const consultRows = await db.$queryRawUnsafe(
      `SELECT DISTINCT ON (appointment_id)
          id AS teleconsultation_id,
          appointment_id,
          status,
          scheduled_start,
          remote_consent_id,
          remote_consent_signed_at,
          updated_at
         FROM teleconsultations
        WHERE appointment_id = ANY($1::int[])
        ORDER BY appointment_id,
          CASE status
            WHEN 'in_progress' THEN 0
            WHEN 'waiting' THEN 1
            WHEN 'scheduled' THEN 2
            ELSE 3
          END,
          updated_at DESC NULLS LAST,
          id DESC`,
      appointmentIds,
    );
    const byAppointmentId = new Map(
      consultRows
        .map((row) => [cleanInt(row.appointment_id), row])
        .filter(([id]) => id != null),
    );

    return rows.map((row) => {
      if (!isTeleVisit(row)) return row;
      const consult = byAppointmentId.get(cleanInt(row.id));
      return {
        ...row,
        ...teleconsultPayload(consult, featureState),
      };
    });
  } catch (err) {
    logger.warn('Appointment teleconsult enrichment failed:', err?.message);
    return rows;
  }
}

export const __testing__ = {
  teleconsultPayload,
};
