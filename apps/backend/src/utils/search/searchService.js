// src/utils/search/searchService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../../services/tenant/tenantService.js';
import { maskEmail, maskPhone } from '../piiMask.js';

/**
 * Build a tsquery from user input. For short queries (< 3 chars), returns null (use ILIKE).
 */
function buildTsQuery(query) {
  const trimmed = query.trim();
  if (trimmed.length < 3) return null;
  // Split words and join with & for AND matching, append :* for prefix matching
  const terms = trimmed.split(/\s+/).filter(Boolean).map(t => `${t}:*`).join(' & ');
  return terms;
}

function tenantOf(context = {}) {
  return requireTenantId(context.tenantId || context.tenant_id);
}

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function canSeeRawUserContact(context = {}) {
  return ['ADMIN', 'SUPER_ADMIN'].includes(normalizeRole(context.role));
}

function formatUserSearchResult(row, context) {
  const canSeeRaw = canSeeRawUserContact(context);
  const { highlight, ...result } = row;
  return {
    ...result,
    ...(canSeeRaw && highlight != null ? { highlight } : {}),
    phone: canSeeRaw ? row.phone : maskPhone(row.phone),
    email: canSeeRaw ? row.email : (row.email ? maskEmail(row.email) : null),
    type: 'user',
  };
}

export async function searchUsers(query, limit = 20, context = {}) {
  const tsQuery = buildTsQuery(query);
  const tenantId = tenantOf(context);

  if (tsQuery) {
    const result = await prisma.$queryRawUnsafe(`
      SELECT id, uid, name, phone, email, role,
        ts_rank(search_vector, to_tsquery('english', $1)) AS rank,
        ts_headline('english', coalesce(name, '') || ' ' || coalesce(email, ''),
          to_tsquery('english', $1), 'StartSel=<b>, StopSel=</b>, MaxWords=50') AS highlight
      FROM users
      WHERE tenant_id = $2::uuid
        AND role NOT IN ('ADMIN', 'SUPER_ADMIN')
        AND search_vector @@ to_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $3
    `, tsQuery, tenantId, limit);
    return result.map(r => formatUserSearchResult(r, context));
  }

  // Fallback: ILIKE for short queries
  const result = await prisma.$queryRawUnsafe(`
    SELECT id, uid, name, phone, email, role, 0 AS rank
    FROM users
    WHERE tenant_id = $2::uuid
      AND role NOT IN ('ADMIN', 'SUPER_ADMIN')
      AND (name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1)
    LIMIT $3
  `, `%${query.trim()}%`, tenantId, limit);
  return result.map(r => formatUserSearchResult(r, context));
}

export async function searchDoctors(query, limit = 20, context = {}) {
  const tsQuery = buildTsQuery(query);
  const tenantId = tenantOf(context);

  if (tsQuery) {
    const result = await prisma.$queryRawUnsafe(`
      SELECT d.id, d.name, d.specialty AS specialization, d.qualifications AS qualification,
        u.phone, d.is_active,
        ts_rank(d.search_vector, to_tsquery('english', $1)) AS rank,
        ts_headline('english', coalesce(d.name, '') || ' ' || coalesce(d.specialty, ''),
          to_tsquery('english', $1), 'StartSel=<b>, StopSel=</b>, MaxWords=50') AS highlight
      FROM doctors d
      LEFT JOIN users u
        ON u.id = d.user_id
       AND u.tenant_id = d.tenant_id
      WHERE d.tenant_id = $2::uuid
        AND d.search_vector @@ to_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $3
    `, tsQuery, tenantId, limit);
    return result.map(r => ({ ...r, phone: maskPhone(r.phone), type: 'doctor' }));
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT d.id, d.name, d.specialty AS specialization, d.qualifications AS qualification,
      u.phone, d.is_active, 0 AS rank
    FROM doctors d
    LEFT JOIN users u
      ON u.id = d.user_id
     AND u.tenant_id = d.tenant_id
    WHERE d.tenant_id = $2::uuid
      AND (d.name ILIKE $1 OR d.specialty ILIKE $1 OR d.qualifications ILIKE $1)
    LIMIT $3
  `, `%${query.trim()}%`, tenantId, limit);
  return result.map(r => ({ ...r, phone: maskPhone(r.phone), type: 'doctor' }));
}

export async function searchGlobal(query, limit = 50, context = {}) {
  const perType = Math.ceil(limit / 2);
  try {
    const [users, doctors] = await Promise.all([
      searchUsers(query, perType, context),
      searchDoctors(query, perType, context),
    ]);

    const results = [...users, ...doctors]
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .slice(0, limit);

    return {
      total: results.length,
      results,
    };
  } catch (err) {
    logger.error('Global search error:', err.message);
    throw err;
  }
}
