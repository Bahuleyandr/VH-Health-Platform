import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload;
}

export async function publishEvent({
  eventType,
  aggregateType,
  aggregateId = null,
  patientUid = null,
  payload = {},
}) {
  if (!eventType || !aggregateType) {
    logger.warn('Skipped event_outbox insert: missing eventType or aggregateType', {
      eventType,
      aggregateType,
    });
    return null;
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox
         (event_type, aggregate_type, aggregate_id, patient_uid, payload, status, available_at, created_at)
       VALUES ($1, $2, $3, $4::uuid, $5::jsonb, 'pending', NOW(), NOW())
       RETURNING id, event_type, aggregate_type, aggregate_id, patient_uid, status, created_at`,
      eventType,
      aggregateType,
      aggregateId ? String(aggregateId) : null,
      patientUid || null,
      JSON.stringify(normalizePayload(payload))
    );
    return rows[0];
  } catch (err) {
    logger.warn('Failed to publish event_outbox event', {
      eventType,
      aggregateType,
      error: err.message,
    });
    return null;
  }
}

export async function listEvents({ status = 'pending', limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const safeLimit = clampLimit(limit);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const allowedStatuses = new Set(['pending', 'processing', 'delivered', 'failed']);
  const safeStatus = allowedStatuses.has(status) ? status : 'pending';

  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, aggregate_type, aggregate_id, patient_uid, payload,
            status, attempts, available_at, last_error, created_at, delivered_at
     FROM event_outbox
     WHERE status = $1
     ORDER BY available_at ASC, id ASC
     LIMIT $2 OFFSET $3`,
    safeStatus,
    safeLimit,
    safeOffset
  );
}

export async function markDelivered(eventId) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE event_outbox
     SET status = 'delivered', delivered_at = NOW(), last_error = NULL
     WHERE id = $1::bigint
     RETURNING id, status, delivered_at`,
    eventId
  );
  return rows[0] || null;
}

export async function markFailed(eventId, message) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE event_outbox
     SET status = 'failed', attempts = attempts + 1, last_error = $2
     WHERE id = $1::bigint
     RETURNING id, status, attempts, last_error`,
    eventId,
    String(message || 'Unknown delivery failure').slice(0, 2000)
  );
  return rows[0] || null;
}

export default {
  publishEvent,
  listEvents,
  markDelivered,
  markFailed,
};
