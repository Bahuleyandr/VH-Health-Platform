// Scheduled MIS report email delivery (migration 679) — end to end against
// the test Postgres with the SMTP transport mocked.
//
// Covers:
//   - admin CRUD on /api/v1/dashboards/mis-report-schedules (validation,
//     tenant scoping, duplicate-name guard)
//   - a full dispatch cycle: runDueMisReportSchedules claims the due
//     occurrence, renders the snapshot reports, emails each recipient, and
//     records per-recipient evidence in mis_report_deliveries
//   - the honest-delivery rule: a rejected or thrown SMTP send is recorded as
//     rejected/uncertain (never sent), and last_status only says 'sent' when
//     every recipient was provider-acknowledged
//   - idempotence: a second sweep for the same occurrence sends nothing
//
// The transport is mocked at the sendEmailNotification seam used by the
// payment-link delivery tests as well.

import { jest } from '@jest/globals';

const sendEmailMock = jest.fn();
jest.unstable_mockModule('../utils/notifications/sendEmailNotification.js', () => ({
  sendEmail: sendEmailMock,
}));

const { default: prisma } = await import('../lib/prisma.js');
const { default: app } = await import('../app.js');
const { default: request } = await import('supertest');
const { API_KEY, generateTestToken, ensureTestIdentity } = await import('./testClient.js');
const {
  runDueMisReportSchedules,
  runMisReportScheduleNow,
} = await import('../services/dashboards/misReportScheduleService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '67900000-0000-4000-8000-0000000000a1';
const TENANT_B = '67900000-0000-4000-8000-0000000000b1';
const ADMIN_A = '67900000-0000-4000-8000-00000000a999';

// 04:30Z = 10:00 IST on Sunday 2026-08-16.
const NOW_DUE = new Date('2026-08-16T04:30:00Z');

function admin(tenantId = TENANT_A) {
  const token = generateTestToken('ADMIN', { uid: ADMIN_A, tenant_id: tenantId });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path, body = {}) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path, body = {}) => request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path) => request(app).delete(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

const BASE = '/api/v1/dashboards/mis-report-schedules';

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM mis_report_deliveries WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM mis_report_schedules WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

async function insertSchedule({
  tenantId = TENANT_A,
  name,
  reportKeys = ['daily-ops'],
  cadence = 'daily',
  sendHour = 10,
  recipients = ['mis@example.com'],
  enabled = true,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO mis_report_schedules
       (tenant_id, name, report_keys, cadence, send_hour, recipients, enabled)
     VALUES ($1::uuid, $2, $3::text[], $4, $5::int, $6::text[], $7)
     RETURNING id`,
    tenantId, name, reportKeys, cadence, sendHour, recipients, enabled,
  );
  return Number(rows[0].id);
}

async function scheduleRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT last_status, last_run_at, last_occurrence_key, last_run_detail
       FROM mis_report_schedules WHERE id = $1::bigint`,
    id,
  );
  return rows[0];
}

async function deliveryRows(scheduleId) {
  return prisma.$queryRawUnsafe(
    `SELECT recipient_email, outcome, provider_message_id, failure_code, occurrence_key
       FROM mis_report_deliveries
      WHERE schedule_id = $1::bigint
      ORDER BY id`,
    scheduleId,
  );
}

d('MIS report schedules (migration 679)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(ADMIN_A, { tenantId: TENANT_A });
  });
  beforeAll(async () => {
    await cleanup();
    for (const [tenantId, slug] of [[TENANT_A, 'mis-679-a'], [TENANT_B, 'mis-679-b']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, settings)
         VALUES ($1::uuid, $2, $3, '{"timezone":"Asia/Kolkata"}'::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET settings = EXCLUDED.settings, status = 'active'`,
        tenantId, slug, `MIS 679 ${slug}`,
      );
    }
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  beforeEach(() => {
    sendEmailMock.mockReset();
  });

  describe('CRUD', () => {
    it('creates, lists, updates and deletes a schedule', async () => {
      const created = await admin().post(BASE, {
        name: 'Morning brief',
        reportKeys: ['daily-ops', 'opd-daily'],
        cadence: 'weekly',
        sendHour: 7,
        sendWeekday: 1,
        recipients: ['CMO@Example.com', 'finance@example.com'],
      });
      expect(created.statusCode).toBe(201);
      expect(created.body.data.cadence).toBe('weekly');
      expect(created.body.data.sendWeekday).toBe(1);
      // Emails are normalized to lowercase.
      expect(created.body.data.recipients).toEqual(['cmo@example.com', 'finance@example.com']);
      const id = created.body.data.id;

      const listed = await admin().get(BASE);
      expect(listed.statusCode).toBe(200);
      expect(listed.body.data.schedules.map((s) => s.id)).toContain(id);
      // The report catalog rides along for the config UI.
      expect(listed.body.data.reports.map((r) => r.key)).toContain('lab-tat');

      const updated = await admin().patch(`${BASE}/${id}`, { cadence: 'daily', enabled: false });
      expect(updated.statusCode).toBe(200);
      expect(updated.body.data.cadence).toBe('daily');
      expect(updated.body.data.sendWeekday).toBeNull();
      expect(updated.body.data.enabled).toBe(false);
      // Untouched fields survive a partial patch.
      expect(updated.body.data.name).toBe('Morning brief');

      const deleted = await admin().delete(`${BASE}/${id}`);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.body.data.deleted).toBe(true);
    });

    it('rejects unknown report keys, bad emails, and duplicate names', async () => {
      const badKey = await admin().post(BASE, {
        name: 'Bad key',
        reportKeys: ['not-a-report'],
        recipients: ['a@example.com'],
      });
      expect(badKey.statusCode).toBe(400);

      const badEmail = await admin().post(BASE, {
        name: 'Bad email',
        reportKeys: ['daily-ops'],
        recipients: ['not-an-email'],
      });
      expect(badEmail.statusCode).toBe(400);

      const weeklyWithoutDay = await admin().post(BASE, {
        name: 'Weekly ok (defaults weekday)',
        reportKeys: ['daily-ops'],
        cadence: 'weekly',
        recipients: ['a@example.com'],
      });
      expect(weeklyWithoutDay.statusCode).toBe(201);
      expect(weeklyWithoutDay.body.data.sendWeekday).toBe(1);

      const dup = await admin().post(BASE, {
        name: 'weekly ok (DEFAULTS weekday)',
        reportKeys: ['daily-ops'],
        recipients: ['a@example.com'],
      });
      expect(dup.statusCode).toBe(400);
      expect(dup.body.code).toBe('MIS_REPORT_SCHEDULE_DUPLICATE_NAME');
    });

    it('scopes reads and writes to the caller tenant', async () => {
      const id = await insertSchedule({ tenantId: TENANT_B, name: 'Tenant B only' });
      const listed = await admin(TENANT_A).get(BASE);
      expect(listed.body.data.schedules.map((s) => s.id)).not.toContain(id);
      const patched = await admin(TENANT_A).patch(`${BASE}/${id}`, { enabled: false });
      expect(patched.statusCode).toBe(404);
      const removed = await admin(TENANT_A).delete(`${BASE}/${id}`);
      expect(removed.statusCode).toBe(404);
    });

    it('requires an admin role', async () => {
      const token = generateTestToken('PATIENT', { uid: ADMIN_A, tenant_id: TENANT_A });
      const res = await request(app).get(BASE)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`);
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe('dispatch cycle', () => {
    it('sends a due schedule once, with per-recipient acknowledged evidence', async () => {
      const id = await insertSchedule({
        name: 'Cycle sent',
        recipients: ['one@example.com', 'two@example.com'],
      });
      sendEmailMock.mockResolvedValue({ messageId: 'provider-msg-1' });

      const summary = await runDueMisReportSchedules({ tenantId: TENANT_A, now: NOW_DUE });
      expect(summary.due).toBe(1);
      expect(summary.sent).toBe(1);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      const call = sendEmailMock.mock.calls[0][0];
      expect(call.receiptMode).toBe(true);
      expect(call.subject).toContain('Cycle sent');
      expect(call.html).toContain('Daily Operations Snapshot');
      expect(call.attachments).toHaveLength(1);
      expect(call.attachments[0].filename).toBe('daily-ops-2026-08-16.csv');

      const row = await scheduleRow(id);
      expect(row.last_status).toBe('sent');
      expect(row.last_occurrence_key).toBe('2026-08-16');
      expect(row.last_run_at).toBeTruthy();
      expect(row.last_run_detail.recipients).toEqual([
        { email: 'one@example.com', outcome: 'acknowledged', failureCode: null },
        { email: 'two@example.com', outcome: 'acknowledged', failureCode: null },
      ]);

      const deliveries = await deliveryRows(id);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((delivery) => delivery.outcome === 'acknowledged')).toBe(true);
      expect(deliveries.every((delivery) => delivery.provider_message_id === 'provider-msg-1')).toBe(true);

      // Same occurrence again: the fence holds, nothing re-sends.
      sendEmailMock.mockClear();
      const again = await runDueMisReportSchedules({ tenantId: TENANT_A, now: NOW_DUE });
      expect(again.due).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('does not run schedules before their send hour or when disabled', async () => {
      await insertSchedule({ name: 'Too early', sendHour: 23 });
      await insertSchedule({ name: 'Disabled', sendHour: 0, enabled: false });
      const summary = await runDueMisReportSchedules({ tenantId: TENANT_A, now: NOW_DUE });
      expect(summary.due).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('never claims success on a rejected send (honest delivery)', async () => {
      const id = await insertSchedule({ name: 'Cycle rejected' });
      sendEmailMock.mockResolvedValue({ outcome: 'rejected', code: 'smtp_not_configured', messageId: null });

      const summary = await runDueMisReportSchedules({ tenantId: TENANT_A, now: NOW_DUE });
      expect(summary.failed).toBe(1);
      const row = await scheduleRow(id);
      expect(row.last_status).toBe('failed');
      const deliveries = await deliveryRows(id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].outcome).toBe('rejected');
      expect(deliveries[0].failure_code).toBe('smtp_not_configured');
      expect(deliveries[0].provider_message_id).toBeNull();
    });

    it('records an uncertain transport outcome as uncertain, and partial acks as partial', async () => {
      const id = await insertSchedule({
        name: 'Cycle partial',
        recipients: ['ok@example.com', 'down@example.com'],
      });
      sendEmailMock
        .mockResolvedValueOnce({ messageId: 'provider-msg-2' })
        .mockRejectedValueOnce(Object.assign(
          new Error('SMTP delivery outcome is uncertain'),
          { code: 'ECONNRESET' },
        ));

      const summary = await runDueMisReportSchedules({ tenantId: TENANT_A, now: NOW_DUE });
      expect(summary.partial).toBe(1);
      const row = await scheduleRow(id);
      expect(row.last_status).toBe('partial');
      const deliveries = await deliveryRows(id);
      expect(deliveries.map((delivery) => delivery.outcome)).toEqual(['acknowledged', 'uncertain']);
      expect(deliveries[1].failure_code).toBe('ECONNRESET');
    });

    it('isolates one failing schedule from the rest of the sweep', async () => {
      const okId = await insertSchedule({ name: 'Sweep survivor', recipients: ['ok@example.com'] });
      const badId = await insertSchedule({ name: 'Sweep failer', recipients: ['bad@example.com'] });
      sendEmailMock.mockImplementation(async ({ to }) => {
        if (to === 'bad@example.com') {
          throw Object.assign(new Error('uncertain'), { code: 'ETIMEDOUT' });
        }
        return { messageId: 'provider-msg-3' };
      });

      const summary = await runDueMisReportSchedules({ tenantId: TENANT_A, now: NOW_DUE });
      expect(summary.due).toBe(2);
      expect(summary.sent).toBe(1);
      expect(summary.failed).toBe(1);
      expect((await scheduleRow(okId)).last_status).toBe('sent');
      expect((await scheduleRow(badId)).last_status).toBe('failed');
    });

    it('run-now delivers immediately without consuming the scheduled occurrence fence', async () => {
      const id = await insertSchedule({ name: 'Manual run', sendHour: 23 });
      sendEmailMock.mockResolvedValue({ messageId: 'provider-msg-4' });

      const result = await runMisReportScheduleNow(TENANT_A, id, { now: NOW_DUE });
      expect(result.status).toBe('sent');
      expect(result.occurrenceKey).toBe('m:2026-08-16');
      expect(result.deliveries).toEqual([
        { email: 'mis@example.com', outcome: 'acknowledged', failureCode: null },
      ]);
      const row = await scheduleRow(id);
      expect(row.last_status).toBe('sent');
      // The scheduled-occurrence fence is untouched by a manual run.
      expect(row.last_occurrence_key).toBeNull();
    });

    it('run-now is exposed over the admin route', async () => {
      const id = await insertSchedule({ name: 'Manual via route' });
      sendEmailMock.mockResolvedValue({ messageId: 'provider-msg-5' });
      const res = await admin().post(`${BASE}/${id}/run-now`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('sent');
      expect(res.body.data.deliveries[0].outcome).toBe('acknowledged');
    });

    it('renders money metrics as plain INR strings, never decimal.js internals', async () => {
      // daily-ops' collections_today is COALESCE(SUM(amount), 0) — a Prisma
      // Decimal OBJECT even when zero. The old renderer recursed into the
      // Decimal's own properties, mailing `collections_today.s/.e/.d` rows.
      const id = await insertSchedule({ name: 'Money rendering' });
      sendEmailMock.mockResolvedValue({ messageId: 'provider-msg-money' });

      const result = await runMisReportScheduleNow(TENANT_A, id, { now: NOW_DUE });
      expect(result.status).toBe('sent');

      const { html, attachments } = sendEmailMock.mock.calls[0][0];
      expect(html).toContain('collections_today');
      expect(html).toContain('₹0.00');
      expect(html).not.toContain('collections_today.s');
      expect(html).not.toContain('collections_today.d');
      expect(html).not.toContain('collections_today.e');
      // CSV carries the same scalar rendering.
      expect(attachments[0].content).toContain('collections_today,₹0.00');
      expect(attachments[0].content).not.toContain('collections_today.s');
    });

    it('delivery evidence survives deleting its schedule (migration 689)', async () => {
      const id = await insertSchedule({ name: 'Evidence survivor' });
      sendEmailMock.mockResolvedValue({ messageId: 'provider-msg-evidence' });
      const run = await runMisReportScheduleNow(TENANT_A, id, { now: NOW_DUE });
      expect(run.status).toBe('sent');
      expect(await deliveryRows(id)).toHaveLength(1);

      const del = await admin().delete(`${BASE}/${id}`);
      expect(del.statusCode).toBe(200);

      // The schedule row is gone; the delivery evidence row is NOT — it keeps
      // the recipient, outcome, receipt, and an insert-time schedule_name
      // snapshot, with schedule_id nulled by the SET NULL FK.
      const survivors = await prisma.$queryRawUnsafe(
        `SELECT schedule_id, schedule_name, recipient_email, outcome, provider_message_id
           FROM mis_report_deliveries
          WHERE tenant_id = $1::uuid AND schedule_name = $2
          ORDER BY id`,
        TENANT_A, 'Evidence survivor',
      );
      expect(survivors).toHaveLength(1);
      expect(survivors[0].schedule_id).toBeNull();
      expect(survivors[0].schedule_name).toBe('Evidence survivor');
      expect(survivors[0].recipient_email).toBe('mis@example.com');
      expect(survivors[0].outcome).toBe('acknowledged');
      expect(survivors[0].provider_message_id).toBe('provider-msg-evidence');
    });
  });
});
