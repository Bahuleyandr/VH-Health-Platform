import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import { emitHousekeepingRequestRaised } from '../clinical/canonicalOperationalBridgeService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const ACTIVE_REQUEST_STATUSES = ['open', 'pending', 'assigned', 'in_progress'];
const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';
// THE housekeeping SLA table — single source for every entry point (dispatch
// here, staff raiseRequest, admin adminCreateRequest in housekeepingController
// import it). Three divergent per-file copies previously assigned the same
// urgency different deadlines depending on which door the ticket came through.
// `high` is the urgency every bed-cleaning dispatch uses
// (createBedCleaningRequest below always passes urgency:'high'), and it MUST
// agree with the canonical `bed_cleaning_turnaround` workflow_sla_rule
// (migration 269, target_minutes = 30) — otherwise the housekeeping_requests
// `sla_due_at` clock (this map) and the canonical workflow-SLA clock disagree
// on when a turnover is late. Reconciled to the migration's 30-min rule (the
// infection-control / throughput target the canonical SLA + escalation engine
// enforce). `urgent` keeps 30 (same target); `normal`/`low` are the
// non-bed-cleaning lanes.
export const HOUSEKEEPING_SLA_MINUTES = Object.freeze({ urgent: 30, high: 30, normal: 240, low: 1440 });
const SLA_MINUTES = HOUSEKEEPING_SLA_MINUTES;
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

async function resolveRequester(requesterUid, tenantId) {
  const normalizedTenantId = requireTenantId(tenantId);
  if (requesterUid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, phone, role
         FROM users
        WHERE uid = $1::uuid
          AND tenant_id = $2::uuid
          AND is_active = true
        LIMIT 1`,
      requesterUid,
      normalizedTenantId,
    );
    if (rows.length) return rows[0];
  }

  const fallbackRows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, name, phone, role
       FROM users
      WHERE is_active = true
        AND tenant_id = $1::uuid
        AND role IN ('SUPER_ADMIN', 'ADMIN', 'HOUSEKEEPING_INCHARGE')
      ORDER BY CASE role
                 WHEN 'SUPER_ADMIN' THEN 0
                 WHEN 'ADMIN' THEN 1
                 ELSE 2
               END,
               id
      LIMIT 1`,
    normalizedTenantId,
  );
  return fallbackRows[0] || null;
}

export async function resolveBedCleaningContext(bedId) {
  const id = Number.parseInt(String(bedId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT b.id AS bed_id,
            b.tenant_id,
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

async function findCurrentRosterRecipients({
  targetId,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
  tenantId,
}) {
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
        AND a.tenant_id = $4::uuid
        AND a.status = 'published'
        AND a.assignment_target_type = 'housekeeping_zone'
        AND a.assignment_target_id = $1::int
       JOIN users u ON u.id = a.staff_id AND u.tenant_id = $4::uuid
      WHERE u.is_active = true
        AND b.tenant_id = $4::uuid
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
    timezone,
    requireTenantId(tenantId),
  );
}

async function findActiveDelegationRecipients({ zoneId, floor, now = new Date(), tenantId }) {
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
       JOIN users u ON u.id = hfa.staff_id AND u.tenant_id = $4::uuid
       LEFT JOIN housekeeping_zones hz ON hz.id = hfa.zone_id AND hz.tenant_id = $4::uuid
      WHERE hfa.status = 'active'
        AND hfa.tenant_id = $4::uuid
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
    now.toISOString(),
    requireTenantId(tenantId),
  );
}

async function findHousekeepingIncharges(tenantId) {
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
        AND tenant_id = $1::uuid
        AND role = 'HOUSEKEEPING_INCHARGE'
      ORDER BY name NULLS LAST, id`,
    requireTenantId(tenantId),
  );
}

async function resolveRequestZoneId(context = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
      FROM housekeeping_zones
      WHERE is_active = true
        AND tenant_id = $3::uuid
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
    context.ward_name || null,
    requireTenantId(context.tenant_id),
  );
  return rows[0]?.id || null;
}

export async function resolveHousekeepingRecipientsForTarget({
  wardId = null,
  zoneId = null,
  floor = null,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
  tenantId = DEFAULT_TENANT_ID,
} = {}) {
  const targetId = wardId || zoneId || null;
  const [rosterRecipients, delegationRecipients, incharges] = await Promise.all([
    findCurrentRosterRecipients({ targetId, now, timezone, tenantId }),
    findActiveDelegationRecipients({ zoneId: targetId, floor, now, tenantId }),
    findHousekeepingIncharges(tenantId),
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
  db = prisma,
} = {}) {
  const id = Number.parseInt(String(requestId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return [];

  const saved = [];
  for (const recipient of uniqueRecipients(recipients)) {
    const rows = await db.$queryRawUnsafe(
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

  // Stamp notified_at ONLY when notifications were actually created. The old
  // `notifiedIds.length ? notifiedIds : ids` fallback marked EVERY recipient as
  // notified even when zero notifications were sent (unresolvable recipients,
  // empty insert), so a failed fan-out looked delivered forever and nothing
  // re-notified. When rows were created, stamp the resolved recipient set:
  // dedupe-suppressed members of it were notified by an earlier fan-out and
  // keep their original stamp via COALESCE.
  const notifiedIds = notificationResult.notification_count > 0
    ? notificationResult.recipients.map(row => row.id)
    : [];
  if (notifiedIds.length) {
    await prisma.$executeRawUnsafe(
      `UPDATE housekeeping_request_recipients
          SET notified_at = COALESCE(notified_at, NOW()),
              updated_at = NOW()
        WHERE request_id = $1::int
          AND staff_id = ANY($2::int[])`,
      requestId,
      notifiedIds
    );
  } else if (ids.length) {
    logger.warn('Housekeeping notification fan-out produced zero notifications; notified_at left unset', {
      requestId,
      recipientCount: ids.length,
    });
  }

  return { notification_count: notificationResult.notification_count };
}

async function findExistingActiveBedCleaningRequest(db, bedId, tenantId) {
  // Dedupe on the structured bed_id column (migration 643), NOT the free-text
  // "bed_id=N." description marker — the description is user-suppliable on the
  // manual request endpoints, so a typed marker could suppress a real dispatch.
  const rows = await db.$queryRawUnsafe(
    `SELECT id, request_number, assigned_to, assigned_to_uid, status, bed_id, patient_uid, tenant_id
       FROM housekeeping_requests
      WHERE tenant_id = $1::uuid
        AND bed_id = $2::int
        AND COALESCE(status, 'open') = ANY($3::text[])
      ORDER BY created_at DESC
      LIMIT 1`,
    requireTenantId(tenantId),
    Number(bedId),
    ACTIVE_REQUEST_STATUSES,
  );
  return rows[0] || null;
}

async function resolveTerminalIsolationContext({
  tenantId,
  bedId,
  admissionId = null,
  patientUid = null,
  trigger = null,
} = {}) {
  if (trigger !== 'final_discharge') return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT io.id,
            io.precaution_type,
            io.patient_uid,
            io.admission_id,
            io.reason
       FROM isolation_orders io
       LEFT JOIN admissions a ON a.id = io.admission_id
      WHERE io.tenant_id = $1::uuid
        AND io.status = 'active'
        AND (
          ($2::int IS NOT NULL AND io.admission_id = $2::int)
          OR ($3::uuid IS NOT NULL AND io.patient_uid = $3::uuid)
          OR (
            $4::int IS NOT NULL
            AND a.bed_id = $4::int
            AND COALESCE(a.status, 'admitted') IN ('admitted', 'transferred', 'discharged')
          )
        )
      ORDER BY io.ordered_at DESC`,
    tenantId,
    admissionId || null,
    patientUid || null,
    bedId || null,
  );
  if (!rows.length) return null;
  const precautions = [...new Set(rows.map((row) => row.precaution_type).filter(Boolean))];
  return {
    tenantId,
    orders: rows,
    orderIds: rows.map((row) => Number(row.id)),
    precautions,
    label: precautions.length ? precautions.join(', ') : 'isolation',
  };
}

async function stampTerminalCleanRequest({ isolationContext, requestId } = {}) {
  if (!isolationContext?.orderIds?.length || !requestId) return;
  await prisma.$executeRawUnsafe(
    `UPDATE isolation_orders
        SET terminal_clean_requested_at = COALESCE(terminal_clean_requested_at, NOW()),
            terminal_clean_request_id = $2::int,
            updated_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND tenant_id = $3::uuid`,
    isolationContext.orderIds,
    requestId,
    isolationContext.tenantId,
  );
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
  // Durable rows (recipient set + system update) land atomically; the staff
  // notification send stays outside the transaction — it calls external
  // providers and must never hold a DB transaction open.
  const savedRecipients = await prisma.$transaction(async (tx) => {
    const saved = await ensureHousekeepingRequestRecipients({ requestId, recipients, db: tx });
    if (updateMessage) {
      await tx.$executeRawUnsafe(
        `INSERT INTO housekeeping_request_updates
           (request_id, author_role, message, is_internal)
         VALUES ($1::int, 'system', $2, false)`,
        requestId,
        updateMessage
      );
    }
    return saved;
  });

  const notifyResult = await notifyHousekeepingRecipients({
    tenantId,
    requestId,
    recipients,
    title,
    body,
    urgency,
    data,
  });

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
  admissionId = null,
  patientUid = null,
  now = new Date(),
} = {}) {
  const context = await resolveBedCleaningContext(bedId);
  if (!context) {
    throw Object.assign(new Error('Bed not found for housekeeping dispatch'), { statusCode: 404 });
  }

  const requester = await resolveRequester(requesterUid, context.tenant_id);
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
    tenantId: context.tenant_id,
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
  const isolationContext = await resolveTerminalIsolationContext({
    tenantId: requireTenantId(context.tenant_id),
    bedId: context.bed_id,
    admissionId,
    patientUid,
    trigger,
  });
  const terminalPrefix = isolationContext
    ? `Terminal isolation clean (${isolationContext.label})`
    : triggerLabel;
  const requestDescription = isolationContext
    ? `${terminalPrefix} required for ${bedLabel}. bed_id=${context.bed_id}.${description ? ` ${description}` : ''}`
    : (description || `${terminalPrefix} cleaning required for ${bedLabel}. bed_id=${context.bed_id}.`);

  const requestState = await setTenantTx(
    requireTenantId(context.tenant_id),
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(
           hashtext('housekeeping-bed-cleaning'), $1::int
         )::text AS lock_result`,
        context.bed_id,
      );
      const existing = await findExistingActiveBedCleaningRequest(
        tx,
        context.bed_id,
        context.tenant_id,
      );
      if (existing) return { request: existing, created: false };

      const requestRows = await tx.$queryRawUnsafe(
        `INSERT INTO housekeeping_requests
           (requester_id, requester_uid, zone_id, bed_id, patient_uid, location_text, request_type,
            urgency, description, assigned_to, assigned_to_uid, assigned_at,
            status, sla_due_at, tenant_id, updated_at)
         VALUES ($1::int,$2::uuid,$3::int,$4::int,$5::uuid,$6,'bed_cleaning',$7,$8,$9::int,$10::uuid,
                 $11::timestamptz,$12,$13::timestamptz,$14::uuid,NOW())
         RETURNING id, request_number, requester_id, requester_uid, zone_id, bed_id, patient_uid,
                   location_text, request_type, urgency, description, assigned_to,
                   assigned_to_uid, status, sla_due_at, created_at, tenant_id`,
        requester.id,
        requester.uid,
        requestZoneId,
        context.bed_id,
        patientUid || null,
        bedLabel,
        safeUrgency,
        requestDescription,
        primary?.id || null,
        primary?.uid || null,
        primary ? now.toISOString() : null,
        status,
        slaDueAt,
        requireTenantId(context.tenant_id),
      );
      return { request: requestRows[0], created: true };
    },
  );
  const { request, created } = requestState;

  if (!created) {
    const existing = request;
    const fanout = await fanOutHousekeepingRequest({
      tenantId: context.tenant_id,
      requestId: existing.id,
      recipients,
      title: 'Housekeeping: bed cleaning required',
      body: `${terminalPrefix} cleaning task for ${bedLabel}.`,
      urgency: safeUrgency,
      data: {
        housekeeping_request_id: existing.id,
        bed_id: context.bed_id,
        ward_id: context.ward_id,
        ward_name: context.ward_name,
        trigger,
        terminal_isolation_clean: Boolean(isolationContext),
        isolation_order_ids: isolationContext?.orderIds || [],
        precaution_types: isolationContext?.precautions || [],
        source: 'bed_cleaning_dispatch',
      },
      updateMessage: `${terminalPrefix} roster fan-out refreshed for ${bedLabel}: ${recipients.length} recipient(s).`,
    });
    await stampTerminalCleanRequest({ isolationContext, requestId: existing.id });
    await emitHousekeepingRequestRaised({
      request: existing,
      actorUid: requester.uid,
      actorRole: requester.role || null,
      trigger,
      payload: {
        bed_id: context.bed_id,
        ward_id: context.ward_id,
        ward_name: context.ward_name,
        terminal_isolation_clean: Boolean(isolationContext),
        isolation_order_ids: isolationContext?.orderIds || [],
        created: false,
      },
    });
    return { request: existing, recipients, fanout, created: false };
  }
  await stampTerminalCleanRequest({ isolationContext, requestId: request.id });

  const fanout = await fanOutHousekeepingRequest({
    tenantId: context.tenant_id,
    requestId: request.id,
    recipients,
    title: 'Housekeeping: bed cleaning required',
    body: `${terminalPrefix} cleaning task for ${bedLabel}.`,
    urgency: safeUrgency,
    data: {
      housekeeping_request_id: request.id,
      bed_id: context.bed_id,
      ward_id: context.ward_id,
      ward_name: context.ward_name,
      trigger,
      terminal_isolation_clean: Boolean(isolationContext),
      isolation_order_ids: isolationContext?.orderIds || [],
      precaution_types: isolationContext?.precautions || [],
      source: 'bed_cleaning_dispatch',
    },
    updateMessage: `Request ${request.request_number} routed to ${recipients.length} housekeeping recipient(s) for ${terminalPrefix} at ${bedLabel}.`,
  });

  logger.info('Housekeeping bed cleaning request dispatched', {
    requestId: request.id,
    bedId: context.bed_id,
    wardId: context.ward_id,
    trigger,
    terminalIsolationClean: Boolean(isolationContext),
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
        terminal_isolation_clean: Boolean(isolationContext),
        isolation_order_ids: isolationContext?.orderIds || [],
        created: true,
      },
    });

  return { request, recipients, fanout, created: true };
}

// Retry lane for the post-commit bed-cleaning dispatch. Discharge/transfer
// flip the bed to 'cleaning' and start the bed-keyed SLA in-tx, but the
// housekeeping_requests work item is dispatched post-commit best-effort — a
// dispatch failure (or a crash between commit and dispatch) used to leave a
// cleaning bed with no ticket forever. This sweep finds such beds and re-runs
// createBedCleaningRequest, which dedupes against any active request itself.
export async function sweepMissingBedCleaningDispatches({ tenantId = null, limit = 25 } = {}) {
  const beds = await prisma.$queryRawUnsafe(
    `SELECT b.id AS bed_id
       FROM beds b
      WHERE b.status = 'cleaning'
        AND ($3::uuid IS NULL OR b.tenant_id = $3::uuid)
        AND NOT EXISTS (
          SELECT 1
            FROM housekeeping_requests hr
           WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
             AND hr.tenant_id = b.tenant_id
             -- Structured linkage (migration 643): only a ticket the dispatcher
             -- actually keyed to this bed suppresses re-dispatch. The legacy
             -- free-text "bed_id=N." description match was user-suppliable and
             -- could silence the sweep with a typed marker.
             AND hr.bed_id = b.id
        )
      ORDER BY b.updated_at ASC NULLS FIRST
      LIMIT $2::int`,
    ACTIVE_REQUEST_STATUSES,
    limit,
    tenantId,
  );

  let dispatched = 0;
  let failed = 0;
  for (const bed of beds) {
    try {
      await createBedCleaningRequest({
        bedId: bed.bed_id,
        trigger: 'bed_cleaning',
        urgency: 'high',
        description: `Bed turnover cleaning re-dispatched by sweep (original dispatch failed). bed_id=${bed.bed_id}.`,
      });
      dispatched += 1;
    } catch (err) {
      failed += 1;
      logger.error(`bed-cleaning-dispatch-sweep: re-dispatch failed for bed ${bed.bed_id}: ${err.message}`);
    }
  }
  return { scanned: beds.length, dispatched, failed };
}

export default {
  createBedCleaningRequest,
  ensureHousekeepingRequestRecipients,
  fanOutHousekeepingRequest,
  notifyHousekeepingRecipients,
  resolveBedCleaningContext,
  resolveHousekeepingRecipientsForTarget,
  sweepMissingBedCleaningDispatches,
};
