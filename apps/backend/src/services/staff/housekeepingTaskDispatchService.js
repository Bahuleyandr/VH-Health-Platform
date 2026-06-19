import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import { emitHousekeepingRequestRaised } from '../clinical/canonicalOperationalBridgeService.js';

const ACTIVE_REQUEST_STATUSES = ['open', 'pending', 'assigned', 'in_progress'];
const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';
// Bed-cleaning turnaround target. `high` is the urgency every bed-cleaning
// dispatch uses (createBedCleaningRequest below always passes urgency:'high'),
// and it MUST agree with the canonical `bed_cleaning_turnaround` workflow_sla_rule
// (migration 269, target_minutes = 30) — otherwise the housekeeping_requests
// `sla_due_at` clock (this map) and the canonical workflow-SLA clock disagree on
// when a turnover is late. Reconciled to the migration's 30-min rule (the
// infection-control / throughput target the canonical SLA + escalation engine
// enforce); the prior 120 was an un-sourced duplicate. `urgent` keeps 30 (same
// target); `normal`/`low` are non-bed-cleaning lanes and unchanged.
const SLA_MINUTES = { urgent: 30, high: 30, normal: 240, low: 1440 };
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function cleanText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeUrgency(value) {
  const urgency = cleanText(value, 'high').toLowerCase();
  return Object.prototype.hasOwnProperty.call(SLA_MINUTES, urgency) ? urgency : 'high';
}

function uniqueRecipients(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = Number(row?.id ?? row?.staff_id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      uid: row.uid || row.staff_uid || null,
      name: row.name || row.staff_name || null,
      phone: row.phone || null,
      role: row.role || row.staff_role || null,
      recipient_kind: row.recipient_kind || 'assignee',
      source: row.source || 'manual',
    });
  }
  return out;
}

function getPrimaryAssignee(recipients = []) {
  return recipients.find(row => row.recipient_kind !== 'incharge') || recipients[0] || null;
}

function buildBedLabel(context = {}) {
  return [context.ward_name, context.bed_number].filter(Boolean).join(' / ')
    || `Bed ${context.bed_id}`;
}

function priorityForUrgency(urgency) {
  return urgency === 'urgent' ? 'HIGH' : urgency.toUpperCase();
}

async function resolveRequester(requesterUid) {
  if (requesterUid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, phone, role
         FROM users
        WHERE uid = $1::uuid
          AND is_active = true
        LIMIT 1`,
      requesterUid
    );
    if (rows.length) return rows[0];
  }

  const fallbackRows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, name, phone, role
       FROM users
      WHERE is_active = true
        AND role IN ('SUPER_ADMIN', 'ADMIN', 'HOUSEKEEPING_INCHARGE')
      ORDER BY CASE role
                 WHEN 'SUPER_ADMIN' THEN 0
                 WHEN 'ADMIN' THEN 1
                 ELSE 2
               END,
               id
      LIMIT 1`
  );
  return fallbackRows[0] || null;
}

export async function resolveBedCleaningContext(bedId) {
  const id = Number.parseInt(String(bedId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT b.id AS bed_id,
            b.bed_number,
            b.ward_id,
            COALESCE(w.name, b.ward_name) AS ward_name,
            COALESCE(w.floor::text, b.floor::text) AS floor,
            b.floor::text AS bed_floor,
            b.status
       FROM beds b
       LEFT JOIN wards w ON w.id = b.ward_id
      WHERE b.id = $1::int
      LIMIT 1`,
    id
  );
  return rows[0] || null;
}

async function findCurrentRosterRecipients({ targetId, now = new Date(), timezone = DEFAULT_TIMEZONE }) {
  if (!targetId) return [];
  return prisma.$queryRawUnsafe(
    `WITH ctx AS (
       SELECT $2::timestamptz AS ts,
              ($2::timestamptz AT TIME ZONE $3)::date AS local_date,
              ($2::timestamptz AT TIME ZONE $3)::time AS local_time
     )
     SELECT DISTINCT ON (u.id)
            u.id,
            u.uid,
            u.name,
            u.phone,
            u.role,
            'assigned_staff'::text AS recipient_kind,
            'published_roster'::text AS source
       FROM ctx
       JOIN staff_shift_roster_boards b
         ON b.department = 'housekeeping'
        AND b.status = 'published'
        AND b.roster_date IN (ctx.local_date, ctx.local_date - 1)
       JOIN staff_shift_roster_assignments a
         ON a.roster_id = b.id
        AND a.status = 'published'
        AND a.assignment_target_type = 'housekeeping_zone'
        AND a.assignment_target_id = $1::int
       JOIN users u ON u.id = a.staff_id
      WHERE u.is_active = true
        AND u.role IN ('HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE')
        AND (
          (
            b.shift_end > b.shift_start
            AND b.roster_date = ctx.local_date
            AND ctx.local_time >= b.shift_start
            AND ctx.local_time < b.shift_end
          )
          OR (
            b.shift_end <= b.shift_start
            AND (
              (b.roster_date = ctx.local_date AND ctx.local_time >= b.shift_start)
              OR (b.roster_date = ctx.local_date - 1 AND ctx.local_time < b.shift_end)
            )
          )
        )
      ORDER BY u.id, a.is_lead DESC, b.shift_start ASC`,
    targetId,
    now.toISOString(),
    timezone
  );
}

async function findActiveDelegationRecipients({ zoneId, floor, now = new Date() }) {
  if (!zoneId && !floor) return [];
  return prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (u.id)
            u.id,
            u.uid,
            u.name,
            u.phone,
            u.role,
            'assigned_staff'::text AS recipient_kind,
            CASE
              WHEN hfa.assignment_kind = 'roster' THEN 'roster_projection'
              ELSE 'housekeeping_delegation'
            END AS source
       FROM housekeeping_floor_assignments hfa
       JOIN users u ON u.id = hfa.staff_id
       LEFT JOIN housekeeping_zones hz ON hz.id = hfa.zone_id
      WHERE hfa.status = 'active'
        AND hfa.effective_from <= $3::timestamptz
        AND (hfa.effective_to IS NULL OR hfa.effective_to > $3::timestamptz)
        AND u.is_active = true
        AND u.role IN ('HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE')
        AND (
          ($1::int IS NOT NULL AND hfa.zone_id = $1::int)
          OR ($2::text IS NOT NULL AND (hfa.floor = $2::text OR hz.floor = $2::text))
        )
      ORDER BY u.id,
               CASE WHEN hfa.assignment_kind = 'roster' THEN 0 ELSE 1 END,
               hfa.is_temporary DESC,
               hfa.created_at ASC`,
    zoneId || null,
    floor || null,
    now.toISOString()
  );
}

async function findHousekeepingIncharges() {
  return prisma.$queryRawUnsafe(
    `SELECT id,
            uid,
            name,
            phone,
            role,
            'incharge'::text AS recipient_kind,
            'housekeeping_incharge'::text AS source
       FROM users
      WHERE is_active = true
        AND role = 'HOUSEKEEPING_INCHARGE'
      ORDER BY name NULLS LAST, id`
  );
}

async function resolveRequestZoneId(context = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM housekeeping_zones
      WHERE is_active = true
        AND (
          ($1::int IS NOT NULL AND id = $1::int)
          OR ($2::text IS NOT NULL AND LOWER(name) = LOWER($2::text))
        )
      ORDER BY
        CASE
          WHEN $1::int IS NOT NULL AND id = $1::int THEN 0
          WHEN $2::text IS NOT NULL AND LOWER(name) = LOWER($2::text) THEN 1
          ELSE 2
        END,
        id
      LIMIT 1`,
    context.ward_id || null,
    context.ward_name || null
  );
  return rows[0]?.id || null;
}

export async function resolveHousekeepingRecipientsForTarget({
  wardId = null,
  zoneId = null,
  floor = null,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const targetId = wardId || zoneId || null;
  const [rosterRecipients, delegationRecipients, incharges] = await Promise.all([
    findCurrentRosterRecipients({ targetId, now, timezone }),
    findActiveDelegationRecipients({ zoneId: targetId, floor, now }),
    findHousekeepingIncharges(),
  ]);

  return uniqueRecipients([
    ...rosterRecipients,
    ...delegationRecipients,
    ...incharges,
  ]);
}

export async function ensureHousekeepingRequestRecipients({
  requestId,
  recipients = [],
} = {}) {
  const id = Number.parseInt(String(requestId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return [];

  const saved = [];
  for (const recipient of uniqueRecipients(recipients)) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO housekeeping_request_recipients
         (request_id, staff_id, staff_uid, recipient_kind, source, updated_at)
       VALUES ($1::int,$2::int,$3::uuid,$4,$5,NOW())
       ON CONFLICT (request_id, staff_id)
       DO UPDATE SET
         staff_uid = EXCLUDED.staff_uid,
         recipient_kind = EXCLUDED.recipient_kind,
         source = EXCLUDED.source,
         updated_at = NOW()
       RETURNING id, request_id, staff_id, staff_uid, recipient_kind, source`,
      id,
      recipient.id,
      recipient.uid || null,
      recipient.recipient_kind || 'assignee',
      recipient.source || 'manual'
    );
    saved.push(rows[0]);
  }
  return saved;
}

export async function notifyHousekeepingRecipients({
  tenantId = DEFAULT_TENANT_ID,
  requestId,
  recipients = [],
  title,
  body,
  urgency = 'normal',
  data = {},
} = {}) {
  const ids = uniqueRecipients(recipients).map(row => row.id);
  if (!requestId || !ids.length) return { notification_count: 0 };

  const notificationResult = await sendStaffNotifications(
    {
      tenantId,
      recipientUserIds: ids,
      title,
      body,
      type: 'HOUSEKEEPING',
      priority: priorityForUrgency(normalizeUrgency(urgency)),
      relatedId: requestId,
      data,
      dedupe: true,
    },
  );

  const notifiedIds = notificationResult.recipients.map(row => row.id);
  const idsToMark = notifiedIds.length ? notifiedIds : ids;

  await prisma.$executeRawUnsafe(
    `UPDATE housekeeping_request_recipients
        SET notified_at = COALESCE(notified_at, NOW()),
            updated_at = NOW()
      WHERE request_id = $1::int
        AND staff_id = ANY($2::int[])`,
    requestId,
    idsToMark
  );

  return { notification_count: notificationResult.notification_count };
}

async function findExistingActiveBedCleaningRequest(bedId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, request_number, assigned_to, assigned_to_uid, status
       FROM housekeeping_requests
      WHERE COALESCE(status, 'open') = ANY($2::text[])
        AND (
          description ILIKE $1
          OR location_text ILIKE $3
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    `%bed_id=${bedId}%`,
    ACTIVE_REQUEST_STATUSES,
    `%Bed ${bedId}%`
  );
  return rows[0] || null;
}

export async function fanOutHousekeepingRequest({
  tenantId = DEFAULT_TENANT_ID,
  requestId,
  recipients = [],
  title,
  body,
  urgency = 'normal',
  data = {},
  updateMessage = null,
} = {}) {
  const savedRecipients = await ensureHousekeepingRequestRecipients({ requestId, recipients });
  const notifyResult = await notifyHousekeepingRecipients({
    tenantId,
    requestId,
    recipients,
    title,
    body,
    urgency,
    data,
  });

  if (updateMessage) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO housekeeping_request_updates
         (request_id, author_role, message, is_internal)
       VALUES ($1::int, 'system', $2, false)`,
      requestId,
      updateMessage
    );
  }

  return {
    recipient_count: savedRecipients.length,
    notification_count: notifyResult.notification_count,
  };
}

export async function createBedCleaningRequest({
  bedId,
  requesterUid = null,
  trigger = 'bed_cleaning',
  urgency = 'high',
  description = null,
  now = new Date(),
} = {}) {
  const context = await resolveBedCleaningContext(bedId);
  if (!context) {
    throw Object.assign(new Error('Bed not found for housekeeping dispatch'), { statusCode: 404 });
  }

  const requester = await resolveRequester(requesterUid);
  if (!requester) {
    throw Object.assign(new Error('No active requester available for housekeeping dispatch'), {
      statusCode: 409,
    });
  }

  const safeUrgency = normalizeUrgency(urgency);
  const recipients = await resolveHousekeepingRecipientsForTarget({
    wardId: context.ward_id,
    floor: context.floor,
    now,
  });
  const requestZoneId = await resolveRequestZoneId(context);
  const primary = getPrimaryAssignee(recipients);
  const status = primary ? 'assigned' : 'open';
  const bedLabel = buildBedLabel(context);
  const slaDueAt = new Date(now.getTime() + SLA_MINUTES[safeUrgency] * 60000).toISOString();
  const triggerLabel = trigger === 'bed_transfer'
    ? 'Bed transfer'
    : trigger === 'final_discharge'
      ? 'Final discharge'
      : 'Bed turnover';

  const existing = await findExistingActiveBedCleaningRequest(context.bed_id);
  if (existing) {
    const fanout = await fanOutHousekeepingRequest({
      requestId: existing.id,
      recipients,
      title: 'Housekeeping: bed cleaning required',
      body: `${triggerLabel} cleaning task for ${bedLabel}.`,
      urgency: safeUrgency,
      data: {
        housekeeping_request_id: existing.id,
        bed_id: context.bed_id,
        ward_id: context.ward_id,
        ward_name: context.ward_name,
        trigger,
        source: 'bed_cleaning_dispatch',
      },
      updateMessage: `Roster fan-out refreshed for ${bedLabel}: ${recipients.length} recipient(s).`,
    });
    await emitHousekeepingRequestRaised({
      request: existing,
      actorUid: requester.uid,
      actorRole: requester.role || null,
      trigger,
      payload: {
        bed_id: context.bed_id,
        ward_id: context.ward_id,
        ward_name: context.ward_name,
        created: false,
      },
    });
    return { request: existing, recipients, fanout, created: false };
  }

  const requestRows = await prisma.$queryRawUnsafe(
    `INSERT INTO housekeeping_requests
       (requester_id, requester_uid, zone_id, location_text, request_type,
        urgency, description, assigned_to, assigned_to_uid, assigned_at,
        status, sla_due_at, updated_at)
     VALUES ($1::int,$2::uuid,$3::int,$4,'bed_cleaning',$5,$6,$7::int,$8::uuid,
             $9::timestamptz,$10,$11::timestamptz,NOW())
     RETURNING id, request_number, requester_id, requester_uid, zone_id,
               location_text, request_type, urgency, description, assigned_to,
               assigned_to_uid, status, sla_due_at, created_at`,
    requester.id,
    requester.uid,
    requestZoneId,
    bedLabel,
    safeUrgency,
    description || `${triggerLabel} cleaning required for ${bedLabel}. bed_id=${context.bed_id}.`,
    primary?.id || null,
    primary?.uid || null,
    primary ? now.toISOString() : null,
    status,
    slaDueAt
  );
  const request = requestRows[0];

  const fanout = await fanOutHousekeepingRequest({
    requestId: request.id,
    recipients,
    title: 'Housekeeping: bed cleaning required',
    body: `${triggerLabel} cleaning task for ${bedLabel}.`,
    urgency: safeUrgency,
    data: {
      housekeeping_request_id: request.id,
      bed_id: context.bed_id,
      ward_id: context.ward_id,
      ward_name: context.ward_name,
      trigger,
      source: 'bed_cleaning_dispatch',
    },
    updateMessage: `Request ${request.request_number} routed to ${recipients.length} housekeeping recipient(s) for ${bedLabel}.`,
  });

  logger.info('Housekeeping bed cleaning request dispatched', {
    requestId: request.id,
    bedId: context.bed_id,
    wardId: context.ward_id,
    trigger,
    recipientCount: recipients.length,
  });

  await emitHousekeepingRequestRaised({
    request,
    actorUid: requester.uid,
    actorRole: requester.role || null,
    trigger,
    payload: {
      bed_id: context.bed_id,
      ward_id: context.ward_id,
      ward_name: context.ward_name,
      created: true,
    },
  });

  return { request, recipients, fanout, created: true };
}

export default {
  createBedCleaningRequest,
  ensureHousekeepingRequestRecipients,
  fanOutHousekeepingRequest,
  notifyHousekeepingRecipients,
  resolveBedCleaningContext,
  resolveHousekeepingRecipientsForTarget,
};
