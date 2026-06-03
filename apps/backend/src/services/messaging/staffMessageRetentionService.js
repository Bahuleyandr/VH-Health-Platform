import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function asPositiveInt(value, fallback, max = 10000) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeThreadIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    return value
      .replace(/[{}"]/g, '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
  }
  return [];
}

export async function purgeExpiredStaffMessages({
  retentionDays = process.env.STAFF_MESSAGE_RETENTION_DAYS || DEFAULT_RETENTION_DAYS,
  batchSize = process.env.STAFF_MESSAGE_RETENTION_BATCH_SIZE || DEFAULT_BATCH_SIZE,
} = {}) {
  const safeDays = asPositiveInt(retentionDays, DEFAULT_RETENTION_DAYS, 3650);
  const safeBatchSize = asPositiveInt(batchSize, DEFAULT_BATCH_SIZE, 10000);

  const rows = await prisma.$queryRawUnsafe(
    `WITH target AS (
       SELECT id, thread_id
         FROM staff_messages
        WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY created_at ASC NULLS FIRST, id ASC
        LIMIT $2::int
     ), deleted_attachments AS (
       DELETE FROM staff_message_attachments a
        WHERE a.message_id IN (SELECT id FROM target)
        RETURNING a.id
     ), deleted_messages AS (
       DELETE FROM staff_messages m
        WHERE m.id IN (SELECT id FROM target)
        RETURNING m.id, m.thread_id
     )
     SELECT
       (SELECT COUNT(*)::int FROM deleted_messages) AS deleted_messages,
       (SELECT COUNT(*)::int FROM deleted_attachments) AS deleted_attachments,
       ARRAY(
         SELECT DISTINCT thread_id
           FROM deleted_messages
          WHERE thread_id IS NOT NULL
       ) AS affected_thread_ids`,
    safeDays,
    safeBatchSize,
  );

  const summary = rows[0] || {};
  const affectedThreadIds = normalizeThreadIds(summary.affected_thread_ids);
  let updatedThreads = 0;
  let deletedThreads = 0;
  let deletedParticipants = 0;

  if (affectedThreadIds.length > 0) {
    const updated = await prisma.$queryRawUnsafe(
      `WITH latest AS (
         SELECT DISTINCT ON (thread_id)
                thread_id, id, created_at
           FROM staff_messages
          WHERE thread_id = ANY($1::uuid[])
          ORDER BY thread_id, created_at DESC NULLS LAST, id DESC
       )
       UPDATE staff_message_threads t
          SET last_message_id = latest.id,
              last_message_at = latest.created_at,
              updated_at = NOW()
         FROM latest
        WHERE t.id = latest.thread_id
        RETURNING t.id`,
      affectedThreadIds,
    );
    updatedThreads = updated.length;

    const participants = await prisma.$queryRawUnsafe(
      `WITH orphan_threads AS (
         SELECT t.id
           FROM staff_message_threads t
          WHERE t.id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM staff_messages m WHERE m.thread_id = t.id
            )
       )
       DELETE FROM staff_message_thread_participants p
        USING orphan_threads o
        WHERE p.thread_id = o.id
        RETURNING p.thread_id`,
      affectedThreadIds,
    );
    deletedParticipants = participants.length;

    const threadRows = await prisma.$queryRawUnsafe(
      `WITH orphan_threads AS (
         SELECT t.id
           FROM staff_message_threads t
          WHERE t.id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM staff_messages m WHERE m.thread_id = t.id
            )
       )
       DELETE FROM staff_message_threads t
        USING orphan_threads o
        WHERE t.id = o.id
        RETURNING t.id`,
      affectedThreadIds,
    );
    deletedThreads = threadRows.length;
  }

  const result = {
    retention_days: safeDays,
    batch_size: safeBatchSize,
    deleted_messages: Number(summary.deleted_messages || 0),
    deleted_attachments: Number(summary.deleted_attachments || 0),
    updated_threads: updatedThreads,
    deleted_threads: deletedThreads,
    deleted_thread_participants: deletedParticipants,
  };

  if (result.deleted_messages > 0 || result.deleted_attachments > 0 || result.deleted_threads > 0) {
    logger.info('Staff message retention purge completed', result);
  }

  return result;
}

export async function purgeExpiredStaffMessagesForTenant({
  tenantId = DEFAULT_TENANT_ID,
  retentionDays = DEFAULT_RETENTION_DAYS,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const safeDays = asPositiveInt(retentionDays, DEFAULT_RETENTION_DAYS, 3650);
  const safeBatchSize = asPositiveInt(batchSize, DEFAULT_BATCH_SIZE, 10000);
  const rows = await prisma.$queryRawUnsafe(
    `WITH target AS (
       SELECT id
         FROM staff_messages
        WHERE tenant_id = $1::uuid
          AND created_at < NOW() - ($2::int * INTERVAL '1 day')
        ORDER BY created_at ASC NULLS FIRST, id ASC
        LIMIT $3::int
     ), deleted_attachments AS (
       DELETE FROM staff_message_attachments a
        WHERE a.message_id IN (SELECT id FROM target)
        RETURNING a.id
     ), deleted_messages AS (
       DELETE FROM staff_messages m
        WHERE m.id IN (SELECT id FROM target)
        RETURNING m.id
     )
     SELECT
       (SELECT COUNT(*)::int FROM deleted_messages) AS deleted_messages,
       (SELECT COUNT(*)::int FROM deleted_attachments) AS deleted_attachments`,
    tenantId,
    safeDays,
    safeBatchSize,
  );
  return {
    tenant_id: tenantId,
    retention_days: safeDays,
    batch_size: safeBatchSize,
    deleted_messages: Number(rows[0]?.deleted_messages || 0),
    deleted_attachments: Number(rows[0]?.deleted_attachments || 0),
  };
}

export default {
  purgeExpiredStaffMessages,
  purgeExpiredStaffMessagesForTenant,
};
