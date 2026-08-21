// apps/backend/scripts/openapi/schemas/misReportSchedules.mjs
// Scheduled MIS report email delivery (migration 679): admin-managed
// tenant schedules that email the dashboards snapshot reports to management
// on a daily/weekly/monthly cadence, served from
// /api/v1/dashboards/mis-report-schedules.
import { envelope } from './_helpers.mjs';

const REPORT_KEYS = [
  'daily-ops',
  'opd-daily',
  'ip-occupancy',
  'doctor-productivity-30d',
  'payer-mix-monthly',
  'lab-tat',
  'teleconsult-ops',
];

export const schemas = {
  MisReportSchedule: {
    type: 'object',
    required: ['id', 'name', 'reportKeys', 'cadence', 'sendHour', 'recipients', 'enabled'],
    properties: {
      id: { type: 'integer', format: 'int64' },
      name: { type: 'string', maxLength: 160 },
      reportKeys: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: REPORT_KEYS },
        description: 'Snapshot reports included in each email, from the pinned MIS report catalog.',
      },
      cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
      sendHour: {
        type: 'integer',
        minimum: 0,
        maximum: 23,
        description: 'Local send hour in the tenant timezone (settings.timezone, default Asia/Kolkata).',
      },
      sendWeekday: {
        type: 'integer',
        minimum: 0,
        maximum: 6,
        nullable: true,
        description: 'Weekly cadence day, 0=Sunday through 6=Saturday; null for other cadences.',
      },
      sendDayOfMonth: {
        type: 'integer',
        minimum: 1,
        maximum: 28,
        nullable: true,
        description: 'Monthly cadence day of month; null for other cadences.',
      },
      recipients: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { type: 'string', format: 'email' },
      },
      enabled: { type: 'boolean' },
      lastRunAt: { type: 'string', format: 'date-time', nullable: true },
      lastStatus: {
        type: 'string',
        enum: ['running', 'sent', 'partial', 'failed'],
        nullable: true,
        description: 'Outcome of the most recent run; sent requires every recipient to be provider-acknowledged.',
      },
      lastRunDetail: {
        type: 'object',
        additionalProperties: true,
        nullable: true,
        description: 'Per-recipient outcomes and failure codes recorded by the most recent run.',
      },
      lastOccurrenceKey: { type: 'string', nullable: true },
      createdBy: { type: 'string', nullable: true },
      updatedBy: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time', nullable: true },
      updatedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  MisReportCatalogEntry: {
    type: 'object',
    required: ['key', 'title'],
    properties: {
      key: { type: 'string', enum: REPORT_KEYS },
      title: { type: 'string' },
    },
  },

  MisReportScheduleListPayload: {
    type: 'object',
    required: ['schedules', 'reports', 'count'],
    properties: {
      schedules: { type: 'array', items: { $ref: '#/components/schemas/MisReportSchedule' } },
      reports: { type: 'array', items: { $ref: '#/components/schemas/MisReportCatalogEntry' } },
      count: { type: 'integer' },
    },
  },

  MisReportScheduleWriteRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 160 },
      reportKeys: { type: 'array', minItems: 1, items: { type: 'string', enum: REPORT_KEYS } },
      cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
      sendHour: { type: 'integer', minimum: 0, maximum: 23 },
      sendWeekday: { type: 'integer', minimum: 0, maximum: 6, nullable: true },
      sendDayOfMonth: { type: 'integer', minimum: 1, maximum: 28, nullable: true },
      recipients: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', format: 'email' } },
      enabled: { type: 'boolean' },
    },
  },

  MisReportScheduleDeletePayload: {
    type: 'object',
    required: ['deleted', 'id'],
    properties: {
      deleted: { type: 'boolean' },
      id: { type: 'integer', format: 'int64' },
    },
  },

  MisReportScheduleRunPayload: {
    type: 'object',
    required: ['scheduleId', 'status', 'occurrenceKey', 'deliveries'],
    properties: {
      scheduleId: { type: 'integer', format: 'int64' },
      status: { type: 'string', enum: ['sent', 'partial', 'failed'] },
      occurrenceKey: { type: 'string' },
      deliveries: {
        type: 'array',
        items: {
          type: 'object',
          required: ['email', 'outcome'],
          properties: {
            email: { type: 'string', format: 'email' },
            outcome: { type: 'string', enum: ['acknowledged', 'rejected', 'uncertain'] },
            failureCode: { type: 'string', nullable: true },
          },
        },
      },
    },
  },

  MisReportScheduleListResponse: envelope('MisReportScheduleListPayload'),
  MisReportScheduleResponse: envelope('MisReportSchedule'),
  MisReportScheduleDeleteResponse: envelope('MisReportScheduleDeletePayload'),
  MisReportScheduleRunResponse: envelope('MisReportScheduleRunPayload'),
};

export const operations = {
  'GET /api/v1/dashboards/mis-report-schedules': {
    description:
      'Lists the tenant\'s scheduled MIS report email deliveries together with the pinned report catalog (snapshot report keys and titles). ADMIN or SUPER_ADMIN only.',
    response: 'MisReportScheduleListResponse',
  },
  'POST /api/v1/dashboards/mis-report-schedules': {
    description:
      'Creates a scheduled MIS report email delivery: which snapshot reports, a daily/weekly/monthly cadence with a local send hour in the tenant timezone, and up to 20 recipient email addresses. The hourly dispatch sweep sends due schedules with per-recipient SMTP delivery evidence.',
    request: 'MisReportScheduleWriteRequest',
    response: 'MisReportScheduleResponse',
  },
  'PATCH /api/v1/dashboards/mis-report-schedules/{scheduleId}': {
    description:
      'Updates an MIS report email schedule; omitted fields keep their current values. Disabling a schedule stops future sends without deleting its delivery history.',
    request: 'MisReportScheduleWriteRequest',
    response: 'MisReportScheduleResponse',
  },
  'DELETE /api/v1/dashboards/mis-report-schedules/{scheduleId}': {
    description:
      'Deletes an MIS report email schedule and (via cascade) its per-recipient delivery evidence rows.',
    response: 'MisReportScheduleDeleteResponse',
  },
  'POST /api/v1/dashboards/mis-report-schedules/{scheduleId}/run-now': {
    description:
      'Renders and emails the schedule\'s reports immediately, without consuming the scheduled occurrence fence. Returns the per-recipient delivery outcomes; a recipient counts as acknowledged only when the SMTP provider returned a message id.',
    response: 'MisReportScheduleRunResponse',
  },
};
