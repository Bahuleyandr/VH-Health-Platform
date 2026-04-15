// src/utils/search/searchService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

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

export async function searchUsers(query, limit = 20) {
  const tsQuery = buildTsQuery(query);

  if (tsQuery) {
    const result = await prisma.$queryRawUnsafe(`
      SELECT id, name, phone, email, role,
        ts_rank(search_vector, to_tsquery('english', $1)) AS rank,
        ts_headline('english', coalesce(name, '') || ' ' || coalesce(email, ''),
          to_tsquery('english', $1), 'StartSel=<b>, StopSel=</b>, MaxWords=50') AS highlight
      FROM users
      WHERE search_vector @@ to_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $2
    `, tsQuery, limit);
    return result.map(r => ({ ...r, type: 'user' }));
  }

  // Fallback: ILIKE for short queries
  const result = await prisma.$queryRawUnsafe(`
    SELECT id, name, phone, email, role, 0 AS rank
    FROM users
    WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1
    LIMIT $2
  `, `%${query.trim()}%`, limit);
  return result.map(r => ({ ...r, type: 'user' }));
}

export async function searchDoctors(query, limit = 20) {
  const tsQuery = buildTsQuery(query);

  if (tsQuery) {
    const result = await prisma.$queryRawUnsafe(`
      SELECT id, name, specialization, qualification, phone, is_active,
        ts_rank(search_vector, to_tsquery('english', $1)) AS rank,
        ts_headline('english', coalesce(name, '') || ' ' || coalesce(specialization, ''),
          to_tsquery('english', $1), 'StartSel=<b>, StopSel=</b>, MaxWords=50') AS highlight
      FROM doctors
      WHERE search_vector @@ to_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $2
    `, tsQuery, limit);
    return result.map(r => ({ ...r, type: 'doctor' }));
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT id, name, specialization, qualification, phone, is_active, 0 AS rank
    FROM doctors
    WHERE name ILIKE $1 OR specialization ILIKE $1 OR qualification ILIKE $1
    LIMIT $2
  `, `%${query.trim()}%`, limit);
  return result.map(r => ({ ...r, type: 'doctor' }));
}

export async function searchAppointments(query, limit = 20) {
  const tsQuery = buildTsQuery(query);

  if (tsQuery) {
    const result = await prisma.$queryRawUnsafe(`
      SELECT a.id, a.reason, a.notes, a.status, a.appointment_date, a.patient_id, a.doctor_id,
        ts_rank(to_tsvector('english', coalesce(a.reason, '') || ' ' || coalesce(a.notes, '')),
          to_tsquery('english', $1)) AS rank,
        ts_headline('english', coalesce(a.reason, '') || ' ' || coalesce(a.notes, ''),
          to_tsquery('english', $1), 'StartSel=<b>, StopSel=</b>, MaxWords=50') AS highlight
      FROM appointments a
      WHERE to_tsvector('english', coalesce(a.reason, '') || ' ' || coalesce(a.notes, ''))
        @@ to_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $2
    `, tsQuery, limit);
    return result.map(r => ({ ...r, type: 'appointment' }));
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT id, reason, notes, status, appointment_date, patient_id, doctor_id, 0 AS rank
    FROM appointments
    WHERE reason ILIKE $1 OR notes ILIKE $1
    LIMIT $2
  `, `%${query.trim()}%`, limit);
  return result.map(r => ({ ...r, type: 'appointment' }));
}

export async function searchGlobal(query, limit = 50) {
  const perType = Math.ceil(limit / 3);
  try {
    const [users, doctors, appointments] = await Promise.all([
      searchUsers(query, perType),
      searchDoctors(query, perType),
      searchAppointments(query, perType),
    ]);

    const results = [...users, ...doctors, ...appointments]
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
