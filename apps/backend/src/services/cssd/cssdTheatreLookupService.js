import { createHmac, timingSafeEqual } from 'node:crypto';
import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidQuery() {
  return AppError.badRequest('Invalid lookup query', 'INVALID_LOOKUP_QUERY');
}

function signature(payload, context) {
  if (!process.env.JWT_SECRET) throw AppError.internal();
  return createHmac('sha256', process.env.JWT_SECRET)
    .update(JSON.stringify([CURSOR_DOMAIN, context, payload])).digest();
}

function encodeCursor(position, context) {
  const payload = Buffer.from(JSON.stringify(position)).toString('base64url');
  return `${payload}.${signature(payload, context).toString('base64url')}`;
}

function decodeCursor(value, context) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(value)) {
    throw invalidQuery();
  }
  const [payload, mac] = value.split('.');
  const expected = signature(payload, context);
  const actual = Buffer.from(mac, 'base64url');
  if (actual.toString('base64url') !== mac
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidQuery();
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalidQuery();
  }
}

function pageLimit(value) {
  if (value === undefined) return 100;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw invalidQuery();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 200) throw invalidQuery();
  return limit;
}

function lookupError(err) {
  const code = String(err?.meta?.code || err?.code || '');
  if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'ECONNREFUSED', 'ETIMEDOUT',
    '57P01', '57P02', '57P03', '53300'].includes(code)
    || /^08\d{3}$/.test(code)
    || err?.message === 'Database circuit breaker is open — service temporarily unavailable') {
    return AppError.serviceUnavailable('Lookup temporarily unavailable', 'LOOKUP_UNAVAILABLE');
  }
  return err;
}

const CURSOR_DOMAIN = 'cssd-theatre-lookup-v1';
const TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?|24:00:00)$/;

function calendarDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidQuery();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalidQuery();
  return value;
}

export async function listCssdTheatreOptions({ tenantId, query = {} } = {}) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  }
  if (Object.keys(query).some(key => !['date', 'limit', 'cursor'].includes(key))) throw invalidQuery();
  const date = calendarDate(query.date);
  const limit = pageLimit(query.limit);
  const context = [tenantId.toLowerCase(), date, limit, 'time-nulls-last-id'];
  const after = decodeCursor(query.cursor, context);
  if (after !== null && (!after || Object.keys(after).sort().join(',') !== 'id,scheduled_time'
    || !Number.isSafeInteger(after.id) || after.id <= 0
    || (after.scheduled_time !== null && (typeof after.scheduled_time !== 'string'
      || !TIME.test(after.scheduled_time))))) throw invalidQuery();

  try {
    const rows = await setTenant(tenantId, tx => tx.$queryRawUnsafe(
      `SELECT id, scheduled_date::text AS scheduled_date, scheduled_time::text AS scheduled_time
         FROM ot_schedules
        WHERE tenant_id = $1::uuid
          AND scheduled_date = $2::date
          AND status IN ('scheduled', 'pre_op', 'in_progress')
          AND ($3::int IS NULL
            OR ($4::time IS NULL AND scheduled_time IS NULL AND id > $3::int)
            OR ($4::time IS NOT NULL AND
              (scheduled_time IS NULL OR (scheduled_time, id) > ($4::time, $3::int))))
        ORDER BY scheduled_time NULLS LAST, id
        LIMIT $5::int`,
      tenantId, date, after?.id ?? null, after?.scheduled_time ?? null, limit + 1,
    ), { readOnly: true });
    const items = rows.slice(0, limit).map(row => ({
      id: Number(row.id), scheduled_date: row.scheduled_date, scheduled_time: row.scheduled_time,
    }));
    const last = items.at(-1);
    return {
      items,
      next_cursor: rows.length > limit
        ? encodeCursor({ id: last.id, scheduled_time: last.scheduled_time }, context) : null,
    };
  } catch (err) {
    throw lookupError(err);
  }
}
