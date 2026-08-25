import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId, runInTenantContext } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { queueAppointmentReminderSms } from './smsOutbox.js';
import { notificationOutbox } from './notificationOutbox.js';
import {
  outboxDrainWillWriteFeedRow,
  recordPatientFeedNotification,
} from './patientNotificationFeed.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';
const RECIPIENT_MISSING_CODES = Object.freeze([
  'fcm_token_missing',
  'fcm_all_tokens_invalid',
  'recipient_identifier_missing',
  'recipient_not_found',
]);

function requireTenantId(value) {
  const tenantId = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(tenantId)) throw new Error('Reminder job requires an explicit tenantId');
  return tenantId;
}

function requireNow(value) {
  const now = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(now.getTime())) throw new Error('Reminder job requires a valid current time');
  return now;
}

function reminderWindow(now, kind) {
  const offsets = kind === '24h'
    ? [23 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]
    : [30 * 60 * 1000, 90 * 60 * 1000];
  return {
    from: new Date(now.getTime() + offsets[0]),
    until: new Date(now.getTime() + offsets[1]),
  };
}

async function reconcileAppointmentReminderReceipts(tenantId) {
  return setTenantTx(tenantId, async (tx) => {
    const reconciled24h = await tx.$queryRawUnsafe(
      `UPDATE appointments AS appointment
          SET reminder_24h_sent = TRUE
        WHERE appointment.tenant_id = $1::uuid
          AND appointment.reminder_24h_sent IS NOT TRUE
          AND EXISTS (
            SELECT 1
              FROM notification_outbox AS outbox
              JOIN notification_provider_receipts AS receipt
                ON receipt.tenant_id = outbox.tenant_id
               AND receipt.notification_outbox_id = outbox.id
               AND receipt.channel = outbox.channel
               AND receipt.outcome = 'acknowledged'
             WHERE outbox.tenant_id = appointment.tenant_id
               AND outbox.channel IN ('push', 'sms')
               AND (
                 outbox.source_event_key = 'appointment-reminder-24h:' || appointment.id::text
                 OR outbox.source_event_key LIKE
                    'appointment-reminder-24h:' || appointment.id::text || ':%'
               )
          )
      RETURNING appointment.id`,
      tenantId,
    );
    const reconciled1h = await tx.$queryRawUnsafe(
      `UPDATE appointments AS appointment
          SET reminder_1h_sent = TRUE
        WHERE appointment.tenant_id = $1::uuid
          AND appointment.reminder_1h_sent IS NOT TRUE
          AND EXISTS (
            SELECT 1
              FROM notification_outbox AS outbox
              JOIN notification_provider_receipts AS receipt
                ON receipt.tenant_id = outbox.tenant_id
               AND receipt.notification_outbox_id = outbox.id
               AND receipt.channel = outbox.channel
               AND receipt.outcome = 'acknowledged'
             WHERE outbox.tenant_id = appointment.tenant_id
               AND outbox.channel IN ('push', 'sms')
               AND (
                 outbox.source_event_key = 'appointment-reminder-1h:' || appointment.id::text
                 OR outbox.source_event_key LIKE
                    'appointment-reminder-1h:' || appointment.id::text || ':%'
               )
          )
      RETURNING appointment.id`,
      tenantId,
    );
    return { reconciled24h: reconciled24h.length, reconciled1h: reconciled1h.length };
  });
}

async function loadDueAppointmentsWithClient(tx, {
  tenantId,
  from,
  until,
  reminderKind,
}) {
  const reminderPredicate = reminderKind === '24h'
    ? 'appointment.reminder_24h_sent IS NOT TRUE'
    : 'appointment.reminder_1h_sent IS NOT TRUE';
  return tx.$queryRawUnsafe(
    `WITH tenant_clock AS MATERIALIZED (
       SELECT tenant.id AS tenant_id,
              COALESCE(configured_timezone.name, fallback_timezone.name, 'Asia/Kolkata')
                AS timezone
         FROM tenants AS tenant
         LEFT JOIN pg_timezone_names AS configured_timezone
           ON configured_timezone.name = NULLIF(tenant.settings ->> 'timezone', '')
         LEFT JOIN pg_timezone_names AS fallback_timezone
           ON fallback_timezone.name = $2::text
        WHERE tenant.id = $1::uuid
     ), candidates AS MATERIALIZED (
       SELECT appointment.id, appointment.tenant_id, appointment.appointment_date,
              appointment.appointment_time, appointment.token_number,
              patient.id AS patient_user_id, patient.name AS patient_name,
              patient.phone AS patient_phone, doctor.id AS doctor_user_id,
              doctor.uid AS doctor_uid, doctor.name AS doctor_name,
              doctor_profile.department, tenant_clock.timezone AS tenant_timezone,
              (
                (appointment.appointment_date + appointment.appointment_time::time)
                AT TIME ZONE tenant_clock.timezone
              ) AS appointment_at
         FROM appointments AS appointment
         JOIN tenant_clock
           ON tenant_clock.tenant_id = appointment.tenant_id
         JOIN users AS patient
           ON patient.id = appointment.patient_id
          AND patient.tenant_id = appointment.tenant_id
         LEFT JOIN users AS doctor
           ON doctor.id = appointment.doctor_id
          AND doctor.tenant_id = appointment.tenant_id
         LEFT JOIN doctors AS doctor_profile
           ON doctor_profile.user_id = appointment.doctor_id
          AND doctor_profile.tenant_id = appointment.tenant_id
        WHERE appointment.tenant_id = $1::uuid
          AND appointment.status = 'CONFIRMED'
          AND ${reminderPredicate}
          AND appointment.appointment_time ~ '^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
     )
     SELECT id, tenant_id, appointment_time, token_number, patient_user_id,
            patient_name, patient_phone, doctor_user_id, doctor_uid, doctor_name,
            department, tenant_timezone
       FROM candidates
      WHERE appointment_at >= $3::timestamptz
        AND appointment_at < $4::timestamptz
      ORDER BY appointment_date, appointment_time, id`,
    tenantId,
    DEFAULT_TIMEZONE,
    from.toISOString(),
    until.toISOString(),
  );
}

async function loadDueAppointments({ tenantId, from, until, reminderKind }) {
  return setTenant(tenantId, tx => loadDueAppointmentsWithClient(tx, {
    tenantId,
    from,
    until,
    reminderKind,
  }), { readOnly: true });
}

function reminderCopy(appointment, hoursAhead) {
  if (hoursAhead === 24) {
    return {
      title: 'Appointment Tomorrow 📅',
      body: `Reminder: Your appointment is tomorrow at ${appointment.appointment_time} with Dr. ${appointment.doctor_name}. Token #${appointment.token_number}`,
    };
  }
  return {
    title: 'Appointment in 1 Hour ⏰',
    body: `Your appointment at ${appointment.appointment_time} with Dr. ${appointment.doctor_name} is in ~1 hour. Token #${appointment.token_number}`,
  };
}

async function queueAppointmentReminderPush(appointment, hoursAhead) {
  const copy = reminderCopy(appointment, hoursAhead);
  const type = `appointment_reminder_${hoursAhead}h`;
  const data = {
    type,
    appointment_id: String(appointment.id),
    hours_ahead: hoursAhead,
  };
  const queued = await notificationOutbox.queue({
    type,
    channel: 'push',
    tenantId: appointment.tenant_id,
    recipientId: appointment.patient_user_id,
    title: copy.title,
    body: copy.body,
    sourceEventKey: `appointment-reminder-${hoursAhead}h:${appointment.id}`,
    templateVersion: 'push.appointment_reminder.v1',
    data,
  });

  // The push this intent becomes is privacy-stripped by
  // sendPushNotification: the patient sees "You have a new update" and lands
  // on /notifications. Without a feed row the inbox is empty. Skip only the
  // duplicate — a re-queue of an already-recorded intent, or a tenant whose
  // configured channels already make the drain write the row. The drain's row
  // is routing-equivalent to this one: `feedRowTypeForTransportType` maps the
  // suffixed transport type back to `appointment_reminder` before the insert,
  // and the inbox tap handler routes on type alone for this case.
  if (queued && !queued.duplicate && !(await outboxDrainWillWriteFeedRow({
    tenant_id: appointment.tenant_id,
    type,
    recipient_id: appointment.patient_user_id,
    payload: data,
  }))) {
    await recordPatientFeedNotification({
      tenantId: appointment.tenant_id,
      userId: appointment.patient_user_id,
      phone: appointment.patient_phone || null,
      title: copy.title,
      body: copy.body,
      // `appointment_reminder` (unsuffixed) is the type string the patient
      // app's inbox tap handler routes to /appointments; the suffixed
      // `..._24h` / `..._1h` forms are transport/template identity only and
      // fall through its switch to "mark read, go nowhere".
      type: 'appointment_reminder',
      data,
      context: `appointment-reminder-${hoursAhead}h`,
    });
  }
  return queued;
}

async function queuePatientReminder(appointment, hoursAhead) {
  const [sms, push] = await Promise.allSettled([
    queueAppointmentReminderSms({
      tenantId: appointment.tenant_id,
      recipientId: appointment.patient_user_id,
      phone: appointment.patient_phone,
      patientName: appointment.patient_name,
      doctorName: appointment.doctor_name,
      time: appointment.appointment_time,
      hoursAhead,
      tokenNumber: appointment.token_number,
      appointmentId: appointment.id,
    }),
    queueAppointmentReminderPush(appointment, hoursAhead),
  ]);
  const recorded = {
    smsRecorded: sms.status === 'fulfilled' && Boolean(sms.value?.queued),
    pushRecorded: push.status === 'fulfilled' && Boolean(push.value?.id),
  };
  const failures = [sms, push]
    .filter(outcome => outcome.status === 'rejected')
    .map(outcome => outcome.reason);
  if (failures.length > 0) {
    const error = new AggregateError(failures, 'One or more patient reminder channels failed');
    error.code = 'REMINDER_CHANNEL_RECORD_FAILED';
    error.recorded = recorded;
    throw error;
  }
  return recorded;
}

async function notifyDoctorOfDueAppointment(appointment) {
  if (!appointment.doctor_user_id) return;
  const { sendStaffNotifications } = await import(
    '../../services/notification/staffNotificationService.js'
  );
  await sendStaffNotifications({
    tenantId: appointment.tenant_id,
    recipientUserIds: [appointment.doctor_user_id],
    title: 'Appointment due soon',
    body: `${appointment.patient_name || 'Patient'} is due at ${appointment.appointment_time}. Token #${appointment.token_number}.`,
    type: 'APPOINTMENT_DUE',
    priority: 'MEDIUM',
    relatedId: appointment.id,
    data: {
      appointment_id: appointment.id,
      token_number: appointment.token_number,
      patient_name: appointment.patient_name,
      doctor_uid: appointment.doctor_uid,
      department: appointment.department,
      route: '/appointments',
    },
    dedupe: true,
  });
}

async function processReminderBatch(appointments, hoursAhead) {
  let recorded = 0;
  const failures = [];
  for (const appointment of appointments) {
    try {
      const result = await queuePatientReminder(appointment, hoursAhead);
      if (result.smsRecorded || result.pushRecorded) recorded += 1;
      else {
        const err = new Error(
          `${hoursAhead}h reminder for appointment ${appointment.id} `
          + 'could not be recorded on any patient channel',
        );
        err.code = 'REMINDER_RECIPIENT_CHANNEL_MISSING';
        failures.push(err);
        logger.warn(
          `[Reminders] ${hoursAhead}h reminder for appointment ${appointment.id} `
          + 'could not be recorded on any patient channel',
        );
      }
    } catch (err) {
      if (err?.recorded?.smsRecorded || err?.recorded?.pushRecorded) recorded += 1;
      failures.push(err);
      logger.warn(`[Reminders] ${hoursAhead}h reminder queue failed for ${appointment.id}: ${err.message}`);
    }
    if (hoursAhead === 1) {
      try {
        await notifyDoctorOfDueAppointment(appointment);
      } catch (err) {
        failures.push(err);
        logger.warn(
          `[Reminders] doctor appointment notification failed for ${appointment.id}: ${err.message}`,
        );
      }
    }
  }
  return { recorded, failures };
}

/**
 * Queue hourly 24h/1h SMS+push reminders for upcoming appointments.
 * Appointment delivery flags are reconciled only from acknowledged provider
 * receipts; recording an outbox intent never counts as delivery.
 */
export async function sendTimedReminders({ tenantId = getCurrentTenantId(), now = new Date() } = {}) {
  const tid = requireTenantId(tenantId);
  const clock = requireNow(now);
  return runInTenantContext(tid, async () => {
    try {
      const reconciled = await reconcileAppointmentReminderReceipts(tid);
      const window24h = reminderWindow(clock, '24h');
      const window1h = reminderWindow(clock, '1h');
      const [due24h, due1h] = await Promise.all([
        loadDueAppointments({ tenantId: tid, ...window24h, reminderKind: '24h' }),
        loadDueAppointments({ tenantId: tid, ...window1h, reminderKind: '1h' }),
      ]);
      const batch24h = await processReminderBatch(due24h, 24);
      const batch1h = await processReminderBatch(due1h, 1);
      const result = {
        due24h: due24h.length,
        due1h: due1h.length,
        queued24h: batch24h.recorded,
        queued1h: batch1h.recorded,
        ...reconciled,
      };
      logger.info('[Reminders] Tenant reminder sweep complete', { tenant_id: tid, ...result });
      const failures = [...batch24h.failures, ...batch1h.failures];
      if (failures.length > 0) {
        const error = new AggregateError(failures, 'One or more appointment reminders were not recorded');
        error.code = 'REMINDER_BATCH_RECORD_FAILED';
        error.result = result;
        throw error;
      }
      return result;
    } catch (err) {
      logger.error(`[Reminders] tenant ${tid} reminder sweep failed: ${err?.message || err}`);
      throw err;
    }
  });
}

function scheduledNotificationSourceKey(id) {
  return `scheduled-notification:${String(id)}`;
}

function renderScheduledNotification(notification) {
  if (!['feedback_request', 'nps_request'].includes(notification.type)) return null;
  const data = notification.data && typeof notification.data === 'object'
    ? notification.data
    : {};
  return {
    title: 'How was your visit? ⭐',
    body: 'Please take a moment to rate your experience at Venkataeswara Hospitals.',
    data: {
      type: 'feedback_request',
      appointment_id: String(data.appointment_id || ''),
      survey: String(data.survey || ''),
      scheduled_notification_id: String(notification.id),
    },
    templateVersion: 'push.feedback_request.v1',
  };
}

async function reconcileScheduledNotificationStatuses(tenantId) {
  return setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `WITH latest_delivery AS (
       SELECT scheduled.id,
              outbox.status AS outbox_status,
              outbox.retry_count,
              outbox.sent_at,
              receipt.outcome AS receipt_outcome,
              receipt.provider_code,
              receipt.observed_at
         FROM scheduled_notifications AS scheduled
         JOIN LATERAL (
           SELECT candidate.id, candidate.status, candidate.retry_count, candidate.sent_at
             FROM notification_outbox AS candidate
            WHERE candidate.tenant_id = scheduled.tenant_id
              AND candidate.channel = 'push'
              AND (
                candidate.source_event_key = 'scheduled-notification:' || scheduled.id::text
                OR candidate.source_event_key LIKE
                   'scheduled-notification:' || scheduled.id::text || ':%'
              )
            ORDER BY candidate.id DESC
            LIMIT 1
         ) AS outbox ON TRUE
         LEFT JOIN LATERAL (
           SELECT candidate.outcome, candidate.provider_code, candidate.observed_at
             FROM notification_provider_receipts AS candidate
            WHERE candidate.tenant_id = $1::uuid
              AND candidate.notification_outbox_id = outbox.id
              AND candidate.channel = 'push'
            ORDER BY candidate.observed_at DESC, candidate.receipt_id DESC
            LIMIT 1
         ) AS receipt ON TRUE
        WHERE scheduled.tenant_id = $1::uuid
          AND scheduled.status <> 'sent'
     ), classified AS (
       SELECT id,
              CASE
                WHEN receipt_outcome = 'acknowledged' THEN 'sent'
                WHEN receipt_outcome = 'rejected'
                  AND provider_code = ANY($2::text[]) THEN 'recipient_missing'
                WHEN receipt_outcome = 'uncertain'
                  OR outbox_status = 'RECONCILIATION_REQUIRED' THEN 'reconcile_required'
                WHEN outbox_status = 'FAILED' AND retry_count >= 3 THEN 'rejected'
                WHEN outbox_status = 'FAILED' THEN 'retrying'
                WHEN outbox_status = 'CLAIMED' THEN 'delivering'
                ELSE 'queued'
              END AS delivery_status,
              COALESCE(observed_at, sent_at) AS delivered_at
         FROM latest_delivery
     )
     UPDATE scheduled_notifications AS scheduled
        SET status = classified.delivery_status,
            sent_at = CASE WHEN classified.delivery_status = 'sent'
              THEN classified.delivered_at ELSE NULL END
       FROM classified
      WHERE scheduled.tenant_id = $1::uuid
        AND scheduled.id = classified.id
        AND (
          scheduled.status IS DISTINCT FROM classified.delivery_status
          OR scheduled.sent_at IS DISTINCT FROM
             CASE WHEN classified.delivery_status = 'sent'
               THEN classified.delivered_at ELSE NULL END
        )
     RETURNING scheduled.id, scheduled.status, scheduled.sent_at`,
    tenantId,
    RECIPIENT_MISSING_CODES,
  ));
}

async function loadUnqueuedScheduledNotifications(tenantId) {
  return setTenant(tenantId, tx => tx.$queryRawUnsafe(
    `SELECT scheduled.id, scheduled.user_id, scheduled.type, scheduled.data,
            scheduled.send_at, scheduled.status
       FROM scheduled_notifications AS scheduled
      WHERE scheduled.tenant_id = $1::uuid
        AND scheduled.status IN ('pending', 'retrying')
        AND scheduled.send_at <= NOW()
        AND NOT EXISTS (
          SELECT 1
            FROM notification_outbox AS outbox
           WHERE outbox.tenant_id = scheduled.tenant_id
             AND outbox.channel = 'push'
             AND (
               outbox.source_event_key = 'scheduled-notification:' || scheduled.id::text
               OR outbox.source_event_key LIKE
                  'scheduled-notification:' || scheduled.id::text || ':%'
             )
        )
      ORDER BY scheduled.send_at, scheduled.id
      LIMIT 50`,
    tenantId,
  ), { readOnly: true });
}

async function setScheduledNotificationStatus(tenantId, id, status) {
  return setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `UPDATE scheduled_notifications
        SET status = $3::text,
            sent_at = NULL
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status <> 'sent'
    RETURNING id, status`,
    tenantId,
    id,
    status,
  ));
}

/**
 * Move due scheduled notifications onto the canonical leased notification
 * outbox. This job never calls a provider and never marks a row sent itself.
 */
export async function processPendingScheduledNotifications({
  tenantId = getCurrentTenantId(),
} = {}) {
  const tid = requireTenantId(tenantId);
  return runInTenantContext(tid, async () => {
    try {
      const before = await reconcileScheduledNotificationStatuses(tid);
      const pending = await loadUnqueuedScheduledNotifications(tid);
      let queued = 0;
      let retrying = 0;
      let rejected = 0;
      for (const notification of pending) {
        const rendered = renderScheduledNotification(notification);
        if (!rendered) {
          await setScheduledNotificationStatus(tid, notification.id, 'rejected');
          rejected += 1;
          logger.warn(
            `[ScheduledNotif] Unsupported scheduled notification type ${notification.type} `
            + `for row ${notification.id}`,
          );
          continue;
        }
        try {
          const outbox = await notificationOutbox.queue({
            type: notification.type,
            channel: 'push',
            tenantId: tid,
            recipientId: notification.user_id,
            title: rendered.title,
            body: rendered.body,
            data: rendered.data,
            sourceEventKey: scheduledNotificationSourceKey(notification.id),
            templateVersion: rendered.templateVersion,
          }, { strict: true });
          if (!outbox?.id) throw new Error('notification outbox returned no row');
          queued += 1;
          // `feedback_request` has no tenant preference key, so its channels
          // always resolve legacy `['push']` — the drain never writes an
          // in-app row for it. The push is privacy-stripped to a generic
          // "open the app" landing on /notifications, so without this the
          // patient is buzzed into an empty inbox two hours after their
          // visit. Never throws; a re-queue is skipped via `duplicate`.
          //
          // The row does NOT reuse rendered.title/body. That copy ("How was
          // your visit? ⭐" / "take a moment to rate your experience") was
          // written for a push, where it was privacy-stripped and never
          // patient-visible. Rendering it in the inbox for the first time
          // would promise a rating control: `feedback_request` taps to
          // /ask-a-doubt, which is a single free-text box posting to
          // /feedback — there are no stars on it. The row therefore
          // carries copy that matches where the tap actually lands.
          if (!outbox.duplicate) {
            await recordPatientFeedNotification({
              tenantId: tid,
              userId: notification.user_id,
              title: 'How was your visit?',
              body: 'Tell us about your visit, or ask a question about your care.',
              type: 'feedback_request',
              data: rendered.data,
              context: 'scheduled-feedback-request',
            });
          }
        } catch (err) {
          retrying += 1;
          await setScheduledNotificationStatus(tid, notification.id, 'retrying');
          logger.warn(
            `[ScheduledNotif] Failed to record outbox intent for row ${notification.id}: ${err.message}`,
          );
        }
      }
      const after = await reconcileScheduledNotificationStatuses(tid);
      const result = {
        due: pending.length,
        queued,
        retrying,
        rejected,
        reconciled: before.length + after.length,
      };
      if (pending.length > 0 || result.reconciled > 0) {
        logger.info('[ScheduledNotif] Tenant scheduled-notification sweep complete', {
          tenant_id: tid,
          ...result,
        });
      }
      return result;
    } catch (err) {
      logger.error(
        `[ScheduledNotif] tenant ${tid} scheduled-notification sweep failed: ${err?.message || err}`,
      );
      throw err;
    }
  });
}

export const __testing__ = Object.freeze({
  reminderWindow,
  loadDueAppointmentsWithClient,
  scheduledNotificationSourceKey,
  renderScheduledNotification,
  queueAppointmentReminderPush,
});
