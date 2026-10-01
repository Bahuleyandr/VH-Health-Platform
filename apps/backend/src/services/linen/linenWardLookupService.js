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

const CURSOR_DOMAIN = 'linen-ward-lookup-v1';

export async function listLinenWardOptions({ tenantId, query = {} } = {}) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  }
  if (Object.keys(query).some(key => !['q', 'limit', 'cursor'].includes(key))) throw invalidQuery();
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 80)) throw invalidQuery();
  const q = (query.q || '').trim();
  const limit = pageLimit(query.limit);
  const context = [tenantId.toLowerCase(), q, limit, 'name-id'];
  const after = decodeCursor(query.cursor, context);
  if (after !== null && (!after || Object.keys(after).sort().join(',') !== 'id,name'
    || !Number.isSafeInteger(after.id) || after.id <= 0 || typeof after.name !== 'string')) {
    throw invalidQuery();
  }

  try {
    const rows = await setTenant(tenantId, tx => tx.$queryRawUnsafe(
      `SELECT id, name
         FROM wards
        WHERE tenant_id = $1::uuid
          AND ($2::text = '' OR strpos(lower(name), lower($2::text)) > 0)
          AND ($3::int IS NULL OR (name, id) > ($4::text, $3::int))
        ORDER BY name, id
        LIMIT $5::int`,
      tenantId, q, after?.id ?? null, after?.name ?? null, limit + 1,
    ), { readOnly: true });
    const items = rows.slice(0, limit).map(row => ({ id: Number(row.id), name: row.name }));
    return {
      items,
      next_cursor: rows.length > limit ? encodeCursor(items.at(-1), context) : null,
    };
  } catch (err) {
    throw lookupError(err);
  }
}
