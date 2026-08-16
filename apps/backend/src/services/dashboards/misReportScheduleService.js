// src/services/dashboards/misReportScheduleService.js
//
// Scheduled MIS report email delivery (migration 679). Management configures
// tenant-scoped schedules that render the existing dashboard snapshot reports
// into an HTML email (one simple table per report, CSV attachment each) and
// send them to a recipient list on a daily/weekly/monthly cadence, evaluated
// in the tenant's local timezone (tenants.settings->>'timezone', falling back
// to Asia/Kolkata — the appointment reminder job's convention).
//
// Delivery honesty: emails go through sendEmailNotification's receiptMode (the
// reportService / paymentLinkService idiom for system emails with attachments
// — the notification outbox drain only routes push/SMS providers). A recipient
// is recorded 'acknowledged' only when the SMTP provider returned a message id;
// a rejected or thrown send is recorded as exactly that in the append-only
// mis_report_deliveries evidence table, and the schedule's last_status can
// only claim 'sent' when every recipient acknowledged.
//
// Idempotence: the hourly dispatch sweep claims a schedule for one local-date
// occurrence with a compare-and-set on last_occurrence_key, so catch-up ticks
// later the same day never re-send an occurrence that already ran.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { sendEmail } from '../../utils/notifications/sendEmailNotification.js';
import { requireTenantId } from '../tenant/tenantService.js';
import * as snapshot from './snapshotService.js';
import { getTeleconsultOpsSnapshot } from './teleconsultOpsService.js';

const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';
const CADENCES = new Set(['daily', 'weekly', 'monthly']);
const MAX_RECIPIENTS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Report registry — keys are pinned by chk_mis_schedule_report_keys (679).
// Every fetch returns either an array of row objects (tabular) or a single
// object (rendered as a Metric/Value table).
export const MIS_REPORT_DEFINITIONS = Object.freeze({
  'daily-ops': {
    title: 'Daily Operations Snapshot',
    fetch: async ({ tenantId }) => snapshot.getDailyOpsSnapshot({ tenantId }),
  },
  'opd-daily': {
    title: 'OPD Daily (last 14 days)',
    fetch: async ({ tenantId }) => snapshot.getOpdDaily({ tenantId }),
  },
  'ip-occupancy': {
    title: 'IP Occupancy by Ward (last 14 days)',
    fetch: async ({ tenantId }) => snapshot.getIpOccupancy({ tenantId }),
  },
  'doctor-productivity-30d': {
    title: 'Doctor Productivity (last 30 days)',
    fetch: async ({ tenantId }) => snapshot.getDoctorProductivity30d({ tenantId }),
  },
  'payer-mix-monthly': {
    title: 'Payer Mix by Month (last 6 months)',
    fetch: async ({ tenantId }) => snapshot.getPayerMixMonthly({ tenantId }),
  },
  'lab-tat': {
    title: 'Lab Turnaround Time (last 14 days)',
    fetch: async ({ tenantId }) => snapshot.getLabTatSummary({ tenantId }),
  },
  'teleconsult-ops': {
    title: 'Teleconsult Operations (last 24 hours)',
    fetch: async ({ tenantId }) => getTeleconsultOpsSnapshot({ tenantId, windowHours: 24 }),
  },
});

export function listMisReportCatalog() {
  return Object.entries(MIS_REPORT_DEFINITIONS)
    .map(([key, def]) => ({ key, title: def.title }));
}

/* ─── validation ─────────────────────────────────────────────────────────── */

function badRequest(message) {
  return AppError.badRequest(message, 'MIS_REPORT_SCHEDULE_INVALID');
}

function normalizeName(value) {
  const name = String(value ?? '').trim().slice(0, 160);
  if (!name) throw badRequest('name is required');
  return name;
}

function normalizeReportKeys(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('reportKeys must be a non-empty array');
  }
  const keys = [...new Set(value.map((key) => String(key || '').trim()))].filter(Boolean);
  if (keys.length === 0) throw badRequest('reportKeys must be a non-empty array');
  for (const key of keys) {
    if (!MIS_REPORT_DEFINITIONS[key]) throw badRequest(`unknown report key: ${key}`);
  }
  return keys;
}

function normalizeRecipients(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('recipients must be a non-empty array of email addresses');
  }
  const emails = [...new Set(value.map((email) => String(email || '').trim().toLowerCase()))]
    .filter(Boolean);
  if (emails.length === 0 || emails.length > MAX_RECIPIENTS) {
    throw badRequest(`recipients must contain 1 to ${MAX_RECIPIENTS} email addresses`);
  }
  for (const email of emails) {
    if (email.length > 320 || !EMAIL_RE.test(email)) {
      throw badRequest(`invalid recipient email: ${email}`);
    }
  }
  return emails;
}

function boundedInt(value, field, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeCadenceFields(payload, existing = null) {
  const cadence = String(payload.cadence ?? existing?.cadence ?? 'daily').trim().toLowerCase();
  if (!CADENCES.has(cadence)) throw badRequest('cadence must be daily, weekly, or monthly');
  const sendHour = boundedInt(payload.sendHour ?? existing?.sendHour ?? 7, 'sendHour', 0, 23);
  let sendWeekday = null;
  let sendDayOfMonth = null;
  if (cadence === 'weekly') {
    sendWeekday = boundedInt(
      payload.sendWeekday ?? existing?.sendWeekday ?? 1,
      'sendWeekday (0=Sunday…6=Saturday)',
      0,
      6,
    );
  }
  if (cadence === 'monthly') {
    sendDayOfMonth = boundedInt(
      payload.sendDayOfMonth ?? existing?.sendDayOfMonth ?? 1,
      'sendDayOfMonth',
      1,
      28,
    );
  }
  return { cadence, sendHour, sendWeekday, sendDayOfMonth };
}

function normalizePayload(payload = {}, existing = null) {
  return {
    name: normalizeName(payload.name ?? existing?.name),
    reportKeys: normalizeReportKeys(payload.reportKeys ?? existing?.reportKeys),
    recipients: normalizeRecipients(payload.recipients ?? existing?.recipients),
    ...normalizeCadenceFields(payload, existing),
    enabled: payload.enabled === undefined
      ? (existing?.enabled ?? true)
      : payload.enabled === true || payload.enabled === 'true',
  };
}

/* ─── row mapping ────────────────────────────────────────────────────────── */

const SCHEDULE_COLUMNS = `id, tenant_id, name, report_keys, cadence, send_hour,
       send_weekday, send_day_of_month, recipients, enabled, last_run_at,
       last_status, last_run_detail, last_occurrence_key,
       created_by, updated_by, created_at, updated_at`;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function toSchedule(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    reportKeys: row.report_keys || [],
    cadence: row.cadence,
    sendHour: Number(row.send_hour),
    sendWeekday: row.send_weekday == null ? null : Number(row.send_weekday),
    sendDayOfMonth: row.send_day_of_month == null ? null : Number(row.send_day_of_month),
    recipients: row.recipients || [],
    enabled: row.enabled === true,
    lastRunAt: toIso(row.last_run_at),
    lastStatus: row.last_status ?? null,
    lastRunDetail: row.last_run_detail ?? null,
    lastOccurrenceKey: row.last_occurrence_key ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/* ─── CRUD ───────────────────────────────────────────────────────────────── */

export async function listMisReportSchedules(tenantId) {
  const scopedTenantId = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SCHEDULE_COLUMNS}
       FROM mis_report_schedules
      WHERE tenant_id = $1::uuid
      ORDER BY enabled DESC, name ASC, id ASC`,
    scopedTenantId,
  );
  return rows.map(toSchedule);
}

export async function getMisReportSchedule(tenantId, scheduleId) {
  const scopedTenantId = requireTenantId(tenantId);
  const id = Number.parseInt(scheduleId, 10);
  if (!Number.isInteger(id) || id < 1) throw badRequest('scheduleId is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SCHEDULE_COLUMNS}
       FROM mis_report_schedules
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    scopedTenantId,
    id,
  );
  const schedule = toSchedule(rows[0]);
  if (!schedule) {
    throw AppError.notFound('MIS report schedule not found', 'MIS_REPORT_SCHEDULE_NOT_FOUND');
  }
  return schedule;
}

export async function createMisReportSchedule(tenantId, payload = {}, { actorUid = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const next = normalizePayload(payload);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO mis_report_schedules (
         tenant_id, name, report_keys, cadence, send_hour, send_weekday,
         send_day_of_month, recipients, enabled, created_by, updated_by
       )
       VALUES ($1::uuid, $2, $3::text[], $4, $5::int, $6::int, $7::int,
               $8::text[], $9, $10::uuid, $10::uuid)
       RETURNING ${SCHEDULE_COLUMNS}`,
      scopedTenantId,
      next.name,
      next.reportKeys,
      next.cadence,
      next.sendHour,
      next.sendWeekday,
      next.sendDayOfMonth,
      next.recipients,
      next.enabled,
      actorUid,
    );
    return toSchedule(rows[0]);
  } catch (err) {
    if (err?.meta?.code === '23505' || /ux_mis_report_schedules_name/.test(String(err?.message))) {
      throw AppError.badRequest(
        'A schedule with this name already exists',
        'MIS_REPORT_SCHEDULE_DUPLICATE_NAME',
      );
    }
    throw err;
  }
}

export async function updateMisReportSchedule(
  tenantId,
  scheduleId,
  payload = {},
  { actorUid = null } = {},
) {
  const current = await getMisReportSchedule(tenantId, scheduleId);
  const scopedTenantId = requireTenantId(tenantId);
  const next = normalizePayload(payload, current);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE mis_report_schedules
        SET name = $3,
            report_keys = $4::text[],
            cadence = $5,
            send_hour = $6::int,
            send_weekday = $7::int,
            send_day_of_month = $8::int,
            recipients = $9::text[],
            enabled = $10,
            updated_by = $11::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING ${SCHEDULE_COLUMNS}`,
    scopedTenantId,
    current.id,
    next.name,
    next.reportKeys,
    next.cadence,
    next.sendHour,
    next.sendWeekday,
    next.sendDayOfMonth,
    next.recipients,
    next.enabled,
    actorUid,
  );
  return toSchedule(rows[0]);
}

export async function deleteMisReportSchedule(tenantId, scheduleId) {
  const current = await getMisReportSchedule(tenantId, scheduleId);
  const scopedTenantId = requireTenantId(tenantId);
  await prisma.$executeRawUnsafe(
    `DELETE FROM mis_report_schedules WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    scopedTenantId,
    current.id,
  );
  return { deleted: true, id: current.id };
}

/* ─── due computation (pure — unit-tested) ───────────────────────────────── */

const WEEKDAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

/**
 * Wall-clock parts of `now` in an IANA timezone.
 * @returns {{ date: string, hour: number, weekday: number, dayOfMonth: number }}
 */
export function localClock(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    weekday: WEEKDAY_INDEX[parts.weekday] ?? new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).getUTCDay(),
    dayOfMonth: Number(parts.day),
  };
}

/**
 * Occurrence key (tenant-local YYYY-MM-DD) a schedule is due for at `clock`,
 * or null when not due. Catch-up friendly: any tick at-or-after send_hour on
 * the cadence day is due until the occurrence is claimed; the claimed
 * occurrence is fenced by lastOccurrenceKey so it never runs twice.
 */
export function computeDueOccurrence(schedule, clock) {
  if (!schedule || schedule.enabled === false) return null;
  if (clock.hour < schedule.sendHour) return null;
  if (schedule.cadence === 'weekly' && clock.weekday !== schedule.sendWeekday) return null;
  if (schedule.cadence === 'monthly' && clock.dayOfMonth !== schedule.sendDayOfMonth) return null;
  if (schedule.lastOccurrenceKey === clock.date) return null;
  return clock.date;
}

function safeTimezone(candidate) {
  const timezone = String(candidate || '').trim();
  if (!timezone) return DEFAULT_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

async function loadTenantClockContext(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT name, settings ->> 'timezone' AS timezone
       FROM tenants
      WHERE id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return {
    tenantName: rows?.[0]?.name || 'VH Health',
    timezone: safeTimezone(rows?.[0]?.timezone),
  };
}

/* ─── rendering ──────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function flattenMetrics(payload, prefix = '') {
  const rows = [];
  for (const [key, value] of Object.entries(payload || {})) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      rows.push(...flattenMetrics(value, label));
    } else {
      rows.push({ metric: label, value: formatCell(value) });
    }
  }
  return rows;
}

function toTable(result) {
  if (Array.isArray(result)) {
    const columns = result.length ? Object.keys(result[0]) : [];
    return {
      columns,
      rows: result.map((row) => columns.map((column) => formatCell(row[column]))),
    };
  }
  const metrics = flattenMetrics(result);
  return {
    columns: ['metric', 'value'],
    rows: metrics.map((metric) => [metric.metric, metric.value]),
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableToCsv(table) {
  const lines = [table.columns.map(csvEscape).join(',')];
  for (const row of table.rows) lines.push(row.map(csvEscape).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const CELL_STYLE = 'padding:6px 10px;border:1px solid #d7dbe0;text-align:left;';

function tableToHtml(title, table) {
  if (table.rows.length === 0) {
    return `<h3 style="margin:24px 0 8px;font-size:15px;">${escapeHtml(title)}</h3>`
      + '<p style="margin:0;color:#667085;">No data for this period.</p>';
  }
  const head = table.columns
    .map((column) => `<th style="${CELL_STYLE}background:#f2f4f7;">${escapeHtml(column)}</th>`)
    .join('');
  const body = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td style="${CELL_STYLE}">${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<h3 style="margin:24px 0 8px;font-size:15px;">${escapeHtml(title)}</h3>`
    + `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">`
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function renderScheduleSections(schedule, { tenantId }) {
  const sections = [];
  for (const key of schedule.reportKeys) {
    const definition = MIS_REPORT_DEFINITIONS[key];
    const result = await definition.fetch({ tenantId });
    const table = toTable(result ?? []);
    sections.push({ key, title: definition.title, table });
  }
  return sections;
}

function buildEmailContent(schedule, { tenantName, occurrenceKey, sections }) {
  const subject = `[VH Health] MIS reports: ${schedule.name} (${occurrenceKey})`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#101828;">`
    + `<h2 style="margin:0 0 4px;font-size:18px;">${escapeHtml(tenantName)} — MIS reports</h2>`
    + `<p style="margin:0 0 8px;color:#667085;">Schedule "${escapeHtml(schedule.name)}" · ${escapeHtml(occurrenceKey)} · ${escapeHtml(schedule.cadence)}</p>`
    + sections.map((section) => tableToHtml(section.title, section.table)).join('')
    + `<p style="margin:24px 0 0;font-size:12px;color:#98a2b3;">Automated MIS report from VH Health. CSV attachments carry the same data.</p>`
    + `</div>`;
  const attachments = sections.map((section) => ({
    filename: `${section.key}-${occurrenceKey}.csv`,
    content: tableToCsv(section.table),
    contentType: 'text/csv',
  }));
  return { subject, html, attachments };
}

/* ─── delivery ───────────────────────────────────────────────────────────── */

async function recordDelivery(tenantId, schedule, occurrenceKey, delivery) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO mis_report_deliveries (
       tenant_id, schedule_id, occurrence_key, recipient_email, report_keys,
       outcome, provider_message_id, failure_code
     )
     VALUES ($1::uuid, $2::bigint, $3, $4, $5::text[], $6, $7, $8)`,
    tenantId,
    schedule.id,
    occurrenceKey,
    delivery.recipient,
    schedule.reportKeys,
    delivery.outcome,
    delivery.providerMessageId,
    delivery.failureCode,
  );
}

async function deliverToRecipients(schedule, { tenantId, occurrenceKey, content }) {
  const deliveries = [];
  for (const recipient of schedule.recipients) {
    let delivery;
    try {
      const result = await sendEmail({
        to: recipient,
        subject: content.subject,
        html: content.html,
        attachments: content.attachments,
        receiptMode: true,
      });
      const allRecipientsRejected = Array.isArray(result?.accepted)
        && result.accepted.length === 0
        && Array.isArray(result.rejected)
        && result.rejected.length > 0;
      if (result?.messageId && result.outcome !== 'rejected' && !allRecipientsRejected) {
        delivery = {
          recipient,
          outcome: 'acknowledged',
          providerMessageId: String(result.messageId),
          failureCode: null,
        };
      } else {
        delivery = {
          recipient,
          outcome: 'rejected',
          providerMessageId: null,
          failureCode: String(result?.code || 'smtp_not_accepted').slice(0, 120),
        };
      }
    } catch (err) {
      // receiptMode throws on transport failure — outcome is genuinely unknown.
      delivery = {
        recipient,
        outcome: 'uncertain',
        providerMessageId: null,
        failureCode: String(err?.code || 'smtp_transport_failure').slice(0, 120),
      };
    }
    await recordDelivery(tenantId, schedule, occurrenceKey, delivery);
    deliveries.push(delivery);
  }
  return deliveries;
}

function summarizeDeliveries(deliveries) {
  const acknowledged = deliveries.filter((delivery) => delivery.outcome === 'acknowledged').length;
  if (acknowledged === deliveries.length && deliveries.length > 0) return 'sent';
  if (acknowledged > 0) return 'partial';
  return 'failed';
}

async function finalizeRun(tenantId, scheduleId, { status, detail }) {
  await prisma.$executeRawUnsafe(
    `UPDATE mis_report_schedules
        SET last_status = $3,
            last_run_detail = $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    tenantId,
    scheduleId,
    status,
    JSON.stringify(detail),
  );
}

async function executeScheduleRun(schedule, { tenantId, tenantName, occurrenceKey, trigger }) {
  let sections;
  try {
    sections = await renderScheduleSections(schedule, { tenantId });
  } catch (err) {
    logger.error('mis-report-schedule: report render failed', {
      tenantId,
      scheduleId: schedule.id,
      occurrenceKey,
      error: err.message,
    });
    await finalizeRun(tenantId, schedule.id, {
      status: 'failed',
      detail: {
        occurrence: occurrenceKey,
        trigger,
        failureCode: 'report_render_failed',
        error: String(err.message || err).slice(0, 300),
      },
    });
    return { scheduleId: schedule.id, status: 'failed', deliveries: [] };
  }

  const content = buildEmailContent(schedule, { tenantName, occurrenceKey, sections });
  const deliveries = await deliverToRecipients(schedule, { tenantId, occurrenceKey, content });
  const status = summarizeDeliveries(deliveries);
  await finalizeRun(tenantId, schedule.id, {
    status,
    detail: {
      occurrence: occurrenceKey,
      trigger,
      reports: schedule.reportKeys,
      recipients: deliveries.map((delivery) => ({
        email: delivery.recipient,
        outcome: delivery.outcome,
        failureCode: delivery.failureCode,
      })),
    },
  });
  logger.info('mis-report-schedule run complete', {
    tenantId,
    scheduleId: schedule.id,
    occurrenceKey,
    status,
    recipients: deliveries.length,
  });
  return { scheduleId: schedule.id, status, deliveries };
}

/**
 * Compare-and-set claim of one occurrence. Returns the claimed schedule row
 * or null when another process (or an earlier tick) already claimed it.
 */
async function claimOccurrence(tenantId, scheduleId, occurrenceKey) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE mis_report_schedules
        SET last_occurrence_key = $3,
            last_run_at = NOW(),
            last_status = 'running',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND enabled = TRUE
        AND last_occurrence_key IS DISTINCT FROM $3
      RETURNING ${SCHEDULE_COLUMNS}`,
    tenantId,
    scheduleId,
    occurrenceKey,
  );
  return toSchedule(rows[0]);
}

/* ─── scheduler entry points ─────────────────────────────────────────────── */

/**
 * Hourly per-tenant sweep (called via runForEachTenant from scheduler.js).
 * Per-schedule isolation: an individual schedule's render/send failure is
 * recorded on its own row and never aborts the other schedules or the tick.
 */
export async function runDueMisReportSchedules({ tenantId, now = new Date() } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const { tenantName, timezone } = await loadTenantClockContext(scopedTenantId);
  const clock = localClock(now, timezone);
  const schedules = await listMisReportSchedules(scopedTenantId);

  const summary = { tenantId: scopedTenantId, checked: schedules.length, due: 0, sent: 0, partial: 0, failed: 0 };
  for (const schedule of schedules) {
    const occurrenceKey = computeDueOccurrence(schedule, clock);
    if (!occurrenceKey) continue;
    try {
      const claimed = await claimOccurrence(scopedTenantId, schedule.id, occurrenceKey);
      if (!claimed) continue;
      summary.due += 1;
      const result = await executeScheduleRun(claimed, {
        tenantId: scopedTenantId,
        tenantName,
        occurrenceKey,
        trigger: 'scheduled',
      });
      summary[result.status] = (summary[result.status] || 0) + 1;
    } catch (err) {
      // Isolation: a schedule whose claim/run infrastructure failed must not
      // sink the sweep for the tenant's other schedules.
      summary.failed += 1;
      logger.error('mis-report-schedule run failed', {
        tenantId: scopedTenantId,
        scheduleId: schedule.id,
        occurrenceKey,
        error: err.message,
      });
      await finalizeRun(scopedTenantId, schedule.id, {
        status: 'failed',
        detail: {
          occurrence: occurrenceKey,
          trigger: 'scheduled',
          failureCode: 'schedule_run_failed',
          error: String(err.message || err).slice(0, 300),
        },
      }).catch((finalizeErr) => {
        logger.error('mis-report-schedule failure could not be recorded', {
          tenantId: scopedTenantId,
          scheduleId: schedule.id,
          error: finalizeErr.message,
        });
      });
    }
  }
  if (summary.due > 0) logger.info('mis-report-schedule sweep complete', summary);
  return summary;
}

/**
 * Manual "send now" (admin action). Runs immediately with a manual occurrence
 * key so it never consumes the scheduled occurrence fence.
 */
export async function runMisReportScheduleNow(tenantId, scheduleId, { now = new Date() } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const schedule = await getMisReportSchedule(scopedTenantId, scheduleId);
  const { tenantName, timezone } = await loadTenantClockContext(scopedTenantId);
  const clock = localClock(now, timezone);
  const occurrenceKey = `m:${clock.date}`.slice(0, 20);
  await prisma.$executeRawUnsafe(
    `UPDATE mis_report_schedules
        SET last_run_at = NOW(), last_status = 'running', updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    scopedTenantId,
    schedule.id,
  );
  const result = await executeScheduleRun(schedule, {
    tenantId: scopedTenantId,
    tenantName,
    occurrenceKey,
    trigger: 'manual',
  });
  return {
    ...result,
    occurrenceKey,
    deliveries: result.deliveries.map((delivery) => ({
      email: delivery.recipient,
      outcome: delivery.outcome,
      failureCode: delivery.failureCode,
    })),
  };
}
