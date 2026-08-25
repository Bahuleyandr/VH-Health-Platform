// src/utils/notifications/smsOutbox.js
//
// Patient-facing SMS intents go through the migration-609 notification
// outbox — never straight at `services/smsService.js`.
//
// No SMS gateway is configured on this platform. `smsService.sendSMS` is a
// dry-run logger, and the only code allowed to reach it is the outbox drain
// (`notificationOutboxDelivery.js`), which resolves an `sms` attempt to a
// provider receipt of `rejected('sms_gateway_not_configured')`. Calling
// sendSMS from a request path or a cron therefore produced a log line and
// nothing else: the patient got no text and staff got no signal that the
// message had gone nowhere (audit 2026-08-09 finding F7).
//
// Queueing here instead leaves a durable `notification_outbox` row per
// attempt. Until a gateway is wired the drain lands that row FAILED with the
// honest reason above — which is visible, alertable, and replayable — rather
// than silently discarding the intent.
//
// fix-deferred: SMS gateway integration. When one is wired, it goes behind
// `smsService.sendSMS` and these rows drain to SENT with a real provider
// acknowledgement. No call site here needs to change.

import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../logMasking.js';
import { notificationOutbox } from './notificationOutbox.js';

/**
 * Queue one patient-facing SMS intent on the notification outbox.
 *
 * Best-effort by contract: never throws, so a queue failure cannot roll back
 * or block the clinical/billing action that triggered it. The return value
 * says what actually happened so callers can report honestly instead of
 * assuming delivery.
 *
 * @param {Object}  options
 * @param {string}  [options.tenantId]      Explicit tenant. Falls back to the
 *   ambient tenant context, then a recipient lookup, inside the outbox.
 * @param {string|number} [options.recipientId] users.id or users.uid.
 * @param {string}  options.recipientPhone  Patient phone, any format.
 * @param {string}  options.title           Short intent title (ledger only).
 * @param {string}  options.body            The message the patient would read.
 * @param {Object}  [options.data]          Extra payload. Must be JSON-safe —
 *   `undefined` values are rejected by the outbox canonicalizer.
 * @param {string}  [options.sourceEventKey] Domain key making a replay of the
 *   same event idempotent (e.g. `investigation-booking-confirmed:42`).
 * @param {string}  [options.templateVersion] Template identity recorded on the
 *   ledger row; also scopes the delivery-intent dedupe.
 * @param {string}  [options.context]       Label for log lines.
 * @returns {Promise<{queued: boolean, outboxId: number|null,
 *   duplicate: boolean, reason: string|null}>}
 */
export async function queuePatientSms({
  tenantId = null,
  recipientId = null,
  recipientPhone,
  title,
  body,
  data = {},
  sourceEventKey = null,
  templateVersion = 'sms.v1',
  context = 'sms',
} = {}) {
  const phone = String(recipientPhone || '').trim();
  if (!phone) {
    logger.warn(`[SMS outbox] ${context}: no phone on file — no SMS intent recorded`);
    return { queued: false, outboxId: null, duplicate: false, reason: 'phone_missing' };
  }

  let row = null;
  try {
    row = await notificationOutbox.queue({
      type: 'sms',
      tenantId,
      recipientId,
      recipientPhone: phone,
      title: title || '',
      body: body || '',
      data,
      templateVersion,
      ...(sourceEventKey ? { sourceEventKey } : {}),
    });
  } catch (err) {
    // notificationOutbox.queue already swallows in non-strict mode; this is a
    // belt-and-braces guard so a caller's success path can never be broken by
    // the notification tail.
    logger.warn(`[SMS outbox] ${context}: queue threw — ${err.message}`);
    row = null;
  }

  if (!row) {
    logger.warn(
      `[SMS outbox] ${context}: FAILED to record the SMS intent for ${maskPhoneForLog(phone)} `
      + '— the patient will not be contacted by SMS and there is no durable row to replay',
    );
    return { queued: false, outboxId: null, duplicate: false, reason: 'queue_failed' };
  }

  logger.info(
    `[SMS outbox] ${context}: intent queued as outbox row ${row.id}`
    + `${row.duplicate ? ' (duplicate of an existing intent)' : ''} for ${maskPhoneForLog(phone)} `
    + '— NOT delivered: no SMS gateway is configured',
  );
  return {
    queued: true,
    outboxId: row.id,
    duplicate: !!row.duplicate,
    reason: null,
  };
}

/**
 * Appointment confirmation copy. Kept byte-identical to the text that
 * `smsService.sendAppointmentConfirmationSMS` used to compose before this
 * moved behind the outbox.
 */
export function renderAppointmentConfirmationSms({
  patientName, doctorName, date, time, tokenNumber, department,
}) {
  const formattedDate = new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const deptPart = department ? ` (${department})` : '';
  const hospitalPhone = process.env.HOSPITAL_PHONE || '044-XXXXXXXX';
  return (
    `Dear ${patientName}, your appointment at Venkataeswara Hospitals is confirmed.\n`
    + `Date: ${formattedDate}\nTime: ${time}\nDoctor: Dr. ${doctorName}${deptPart}\n`
    + `Token: #${tokenNumber}\n\nPlease arrive 15 min early. For queries call: ${hospitalPhone}`
  );
}

/** Queue the appointment-confirmation SMS intent. */
export async function queueAppointmentConfirmationSms({
  tenantId = null, recipientId = null, phone, patientName, doctorName,
  date, time, tokenNumber, department = null, appointmentId = null,
}) {
  if (!phone) {
    logger.warn('[SMS outbox] appointment-confirmation: no phone on file — no SMS intent recorded');
    return { queued: false, outboxId: null, duplicate: false, reason: 'phone_missing' };
  }
  return queuePatientSms({
    tenantId,
    recipientId,
    recipientPhone: phone,
    title: 'Appointment confirmed',
    body: renderAppointmentConfirmationSms({
      patientName: patientName || 'Patient',
      doctorName: doctorName || 'Doctor',
      date,
      time,
      tokenNumber,
      department,
    }),
    data: {
      type: 'appointment_confirmed',
      appointment_id: appointmentId === null || appointmentId === undefined
        ? null
        : String(appointmentId),
      token_number: tokenNumber === null || tokenNumber === undefined
        ? null
        : String(tokenNumber),
    },
    sourceEventKey: appointmentId ? `appointment-confirmed:${appointmentId}` : null,
    templateVersion: 'sms.appointment_confirmation.v1',
    context: 'appointment-confirmation',
  });
}

/**
 * Appointment reschedule copy.
 *
 * Deliberately leads with the NEW slot and repeats the old one underneath:
 * the failure this text exists to prevent is a patient arriving at the time
 * staff moved them off. A reschedule clears `token_number` (the row goes back
 * to SCHEDULED and must be re-confirmed at the desk), so this copy must not
 * promise a token the way the confirmation copy does.
 */
export function renderAppointmentRescheduleSms({
  patientName, doctorName, date, time, previousDate, previousTime, department,
}) {
  const formatDate = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? String(value ?? '')
      : parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  const deptPart = department ? ` (${department})` : '';
  const hospitalPhone = process.env.HOSPITAL_PHONE || '044-XXXXXXXX';
  const previousPart = previousDate || previousTime
    ? `Previously: ${formatDate(previousDate)}${previousTime ? ` at ${previousTime}` : ''}\n`
    : '';
  return (
    `Dear ${patientName}, your appointment at Venkataeswara Hospitals has been RESCHEDULED.\n`
    + `New date: ${formatDate(date)}\nNew time: ${time}\nDoctor: Dr. ${doctorName}${deptPart}\n`
    + previousPart
    + `\nPlease do not attend at the earlier time. For queries call: ${hospitalPhone}`
  );
}

/** Queue the appointment-reschedule SMS intent. */
export async function queueAppointmentRescheduleSms({
  tenantId = null, recipientId = null, phone, patientName, doctorName,
  date, time, previousDate = null, previousTime = null, department = null,
  appointmentId = null,
}) {
  if (!phone) {
    logger.warn('[SMS outbox] appointment-reschedule: no phone on file — no SMS intent recorded');
    return { queued: false, outboxId: null, duplicate: false, reason: 'phone_missing' };
  }
  return queuePatientSms({
    tenantId,
    recipientId,
    recipientPhone: phone,
    title: 'Appointment rescheduled',
    body: renderAppointmentRescheduleSms({
      patientName: patientName || 'Patient',
      doctorName: doctorName || 'Doctor',
      date,
      time,
      previousDate,
      previousTime,
      department,
    }),
    data: {
      type: 'appointment_rescheduled',
      appointment_id: appointmentId === null || appointmentId === undefined
        ? null
        : String(appointmentId),
    },
    sourceEventKey: appointmentId ? `appointment-rescheduled:${appointmentId}` : null,
    templateVersion: 'sms.appointment_reschedule.v1',
    context: 'appointment-reschedule',
  });
}

/**
 * Appointment reminder copy. Kept byte-identical to the text that
 * `smsService.sendAppointmentReminderSMS` used to compose.
 */
export function renderAppointmentReminderSms({
  patientName, doctorName, time, hoursAhead, tokenNumber,
}) {
  const hoursLabel = hoursAhead > 1 ? `${hoursAhead} hours` : '1 hour';
  return (
    `Reminder: Dear ${patientName}, you have an appointment at Venkataeswara Hospitals in ${hoursLabel}.\n`
    + `Time: ${time} | Dr. ${doctorName} | Token #${tokenNumber}`
  );
}

/** Queue the appointment-reminder SMS intent. */
export async function queueAppointmentReminderSms({
  tenantId = null, recipientId = null, phone, patientName, doctorName,
  time, hoursAhead, tokenNumber, appointmentId = null,
}) {
  if (!phone) {
    logger.warn('[SMS outbox] appointment-reminder: no phone on file — no SMS intent recorded');
    return { queued: false, outboxId: null, duplicate: false, reason: 'phone_missing' };
  }
  return queuePatientSms({
    tenantId,
    recipientId,
    recipientPhone: phone,
    title: 'Appointment reminder',
    body: renderAppointmentReminderSms({
      patientName: patientName || 'Patient',
      doctorName: doctorName || 'Doctor',
      time,
      hoursAhead,
      tokenNumber,
    }),
    data: {
      type: `appointment_reminder_${hoursAhead}h`,
      appointment_id: appointmentId === null || appointmentId === undefined
        ? null
        : String(appointmentId),
      hours_ahead: Number(hoursAhead) || 0,
    },
    sourceEventKey: appointmentId
      ? `appointment-reminder-${hoursAhead}h:${appointmentId}`
      : null,
    templateVersion: 'sms.appointment_reminder.v1',
    context: `appointment-reminder-${hoursAhead}h`,
  });
}

export default {
  queuePatientSms,
  queueAppointmentConfirmationSms,
  queueAppointmentRescheduleSms,
  queueAppointmentReminderSms,
  renderAppointmentConfirmationSms,
  renderAppointmentRescheduleSms,
  renderAppointmentReminderSms,
};
