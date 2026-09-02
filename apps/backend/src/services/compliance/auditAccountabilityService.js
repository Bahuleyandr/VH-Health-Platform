import prisma, { prismaReadOnly } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { mergedPatientUidsSubquery } from '../clinical/mergedPatientReadUnion.js';

const SOURCES = new Set(['request', 'operational', 'clinical', 'phi_access', 'patient_access']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 10_000;
const MAX_EXPORT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DOCTOR_AUDIT_ROLES = Object.freeze([
  'DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'SENIOR_DOCTOR',
  'RESIDENT', 'ANAESTHETIST', 'ANESTHETIST', 'MEDICAL_SUPERINTENDENT',
]);

function scalar(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function cleanText(value, maxLength = 160) {
  const text = String(scalar(value) ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(scalar(value)).trim();
  const parsed = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw AppError.badRequest(`Invalid ${name}`, 'INVALID_AUDIT_FILTER');
  }
  return parsed;
}

function uuid(value, name) {
  const text = cleanText(value, 64);
  if (text && !UUID_RE.test(text)) {
    throw AppError.badRequest(`Invalid ${name}`, 'INVALID_AUDIT_FILTER');
  }
  return text;
}

function instant(value, name) {
  const text = cleanText(value, 80);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`Invalid ${name}`, 'INVALID_AUDIT_FILTER');
  }
  return date.toISOString();
}

export function encodeAuditCursor(row) {
  return Buffer.from(JSON.stringify({
    at: row.cursor_at || new Date(row.occurred_at).toISOString(),
    source: row.source,
    id: String(row.id),
  })).toString('base64url');
}

export function decodeAuditCursor(value) {
  const text = cleanText(value, 512);
  if (!text) return null;
  try {
    const decoded = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!decoded?.at || !SOURCES.has(decoded.source) || !decoded?.id) throw new Error('shape');
    const at = new Date(decoded.at);
    if (Number.isNaN(at.getTime())) throw new Error('date');
    return { at: String(decoded.at), source: decoded.source, id: String(decoded.id).slice(0, 128) };
  } catch {
    throw AppError.badRequest('Invalid audit cursor', 'INVALID_AUDIT_CURSOR');
  }
}

export function normalizeAuditFilters(query = {}, { exportMode = false } = {}) {
  const source = cleanText(query.source, 40);
  if (source && !SOURCES.has(source)) {
    throw AppError.badRequest('Invalid audit source', 'INVALID_AUDIT_FILTER');
  }

  const actorUid = uuid(query.actor_uid ?? query.staff_uid, 'actor_uid');
  const patientUid = uuid(query.patient_uid, 'patient_uid');
  let from = instant(query.from ?? query.date_from, 'from');
  let to = instant(query.to ?? query.date_to, 'to');

  if (exportMode && !from && !to) {
    to = new Date().toISOString();
    from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (from && to && new Date(from) > new Date(to)) {
    throw AppError.badRequest('Audit from date must be before to date', 'INVALID_AUDIT_DATE_RANGE');
  }
  if (exportMode && from && to && new Date(to) - new Date(from) > MAX_EXPORT_WINDOW_MS) {
    throw AppError.badRequest('Audit exports are limited to a 31-day window', 'AUDIT_EXPORT_RANGE_TOO_LARGE');
  }

  return {
    source,
    action: cleanText(query.action, 120),
    actor_uid: actorUid,
    actor_user_id: integer(query.actor_user_id ?? query.staff_id, 'actor_user_id'),
    actor_role: cleanText(query.actor_role ?? query.role, 80)?.toUpperCase() || null,
    patient_uid: patientUid,
    patient_id: cleanText(query.patient_id, 64),
    department_id: cleanText(query.department_id, 120),
    encounter_id: cleanText(query.encounter_id, 120),
    admission_id: cleanText(query.admission_id, 120),
    outcome: cleanText(query.outcome ?? query.status, 40)?.toLowerCase() || null,
    category: cleanText(query.category, 40)?.toLowerCase() || null,
    resource_type: cleanText(query.resource_type ?? query.resource, 100),
    resource_id: cleanText(query.resource_id, 120),
    from,
    to,
    search: cleanText(query.search, 120),
    cursor: exportMode ? null : decodeAuditCursor(query.cursor),
    limit: exportMode
      ? integer(query.limit, 'limit', { min: 1, max: MAX_EXPORT_ROWS, fallback: MAX_EXPORT_ROWS })
      : integer(query.limit, 'limit', { min: 1, max: MAX_PAGE_SIZE, fallback: 100 }),
  };
}

export function buildAuditEventsQuery(tenantId, filters, { includeDetail = false } = {}) {
  const conditions = ['v.tenant_id = $1::uuid'];
  const params = [tenantId];
  let idx = 2;
  const add = (condition, value) => {
    conditions.push(condition.replace('?', `$${idx++}`));
    params.push(value);
  };

  if (filters.source) add('v.source = ?::text', filters.source);
  if (filters.action) add('v.action = ?::text', filters.action);
  if (filters.actor_uid) add('v.actor_uid = ?::uuid', filters.actor_uid);
  if (filters.actor_user_id !== null) add('COALESCE(v.actor_user_id, actor.id) = ?::integer', filters.actor_user_id);
  if (filters.actor_role === 'DOCTOR_GROUP') {
    conditions.push(`UPPER(COALESCE(v.actor_role, actor.role, '')) IN (${DOCTOR_AUDIT_ROLES.map((role) => `'${role}'`).join(', ')})`);
  } else if (filters.actor_role === 'STAFF_GROUP') {
    conditions.push("UPPER(COALESCE(v.actor_role, actor.role, '')) NOT IN ('', 'PATIENT')");
  } else if (filters.actor_role) {
    add('UPPER(COALESCE(v.actor_role, actor.role, \'\')) = ?::text', filters.actor_role);
  }
  if (filters.patient_uid) {
    const patientIdx = idx++;
    conditions.push(
      `v.patient_uid IN (${mergedPatientUidsSubquery('$1::uuid', `$${patientIdx}::uuid`)})`,
    );
    params.push(filters.patient_uid);
  }
  if (filters.patient_id) add('COALESCE(v.patient_id, patient.id::text) = ?::text', filters.patient_id);
  if (filters.department_id) add('v.department_id = ?::text', filters.department_id);
  if (filters.encounter_id) add('v.encounter_id = ?::text', filters.encounter_id);
  if (filters.admission_id) add('v.admission_id = ?::text', filters.admission_id);
  if (filters.outcome) add('LOWER(v.outcome) = ?::text', filters.outcome);
  if (filters.category) add('LOWER(v.category) = ?::text', filters.category);
  if (filters.resource_type) add('v.resource_type = ?::text', filters.resource_type);
  if (filters.resource_id) add('v.resource_id = ?::text', filters.resource_id);
  if (filters.from) add('v.occurred_at >= ?::timestamptz', filters.from);
  if (filters.to) add('v.occurred_at <= ?::timestamptz', filters.to);
  if (filters.search) {
    const searchIdx = idx++;
    conditions.push(`(
      v.action ILIKE $${searchIdx}::text
      OR COALESCE(v.resource_type, '') ILIKE $${searchIdx}::text
      OR COALESCE(v.summary, '') ILIKE $${searchIdx}::text
      OR COALESCE(v.actor_name, actor.name, '') ILIKE $${searchIdx}::text
    )`);
    params.push(`%${filters.search}%`);
  }
  if (filters.cursor) {
    conditions.push(`ROW(v.occurred_at, v.source, v.id) < ROW($${idx++}::timestamptz, $${idx++}::text, $${idx++}::text)`);
    params.push(filters.cursor.at, filters.cursor.source, filters.cursor.id);
  }

  const detailColumn = includeDetail ? ', v.safe_detail' : '';
  const sql = `
    SELECT v.source, v.id, v.occurred_at,
           to_char(v.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
           v.actor_uid, COALESCE(v.actor_user_id, actor.id) AS actor_user_id,
           COALESCE(v.actor_name, actor.name) AS actor_name,
           COALESCE(v.actor_role, actor.role) AS actor_role,
           v.patient_uid, COALESCE(v.patient_id, patient.id::text) AS patient_id,
           patient.name AS patient_name,
           v.department_id, v.encounter_id, v.admission_id,
           v.action, v.outcome, v.category, v.resource_type, v.resource_id,
           v.summary, v.request_id, v.ip_address, v.device_type${detailColumn}
      FROM unified_audit_events_v v
      LEFT JOIN users actor
        ON actor.tenant_id = v.tenant_id AND actor.uid = v.actor_uid
      LEFT JOIN users patient
        ON patient.tenant_id = v.tenant_id AND patient.uid = v.patient_uid
     WHERE ${conditions.join(' AND ')}
     ORDER BY v.occurred_at DESC, v.source DESC, v.id DESC`;
  return { sql, params };
}

function publicFilters(filters) {
  const { cursor, ...rest } = filters;
  return { ...rest, cursor: cursor ? encodeAuditCursor({ occurred_at: cursor.at, ...cursor }) : null };
}

export async function listAuditEvents(tenantId, query = {}) {
  const filters = normalizeAuditFilters(query);
  const { sql, params } = buildAuditEventsQuery(tenantId, filters);
  const fetchLimit = filters.limit + 1;
  const rows = await prismaReadOnly.$queryRawUnsafe(`${sql}\nLIMIT $${params.length + 1}`, ...params, fetchLimit);
  const hasMore = rows.length > filters.limit;
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
  const logs = pageRows.map(({ cursor_at: _cursorAt, ...row }) => row);
  const nextCursor = hasMore ? encodeAuditCursor(pageRows[pageRows.length - 1]) : null;
  return {
    logs,
    limit: filters.limit,
    next_cursor: nextCursor,
    has_more: hasMore,
    pagination: {
      limit: filters.limit,
      next_cursor: nextCursor,
      has_more: hasMore,
    },
    filters: publicFilters(filters),
  };
}

export async function getAuditEventDetail(tenantId, source, id) {
  if (!SOURCES.has(source) || !/^[0-9a-f-]{1,128}$/i.test(String(id))) {
    throw AppError.badRequest('Invalid audit event reference', 'INVALID_AUDIT_EVENT_REFERENCE');
  }
  const filters = normalizeAuditFilters({ source, limit: 1 });
  const { sql, params } = buildAuditEventsQuery(tenantId, filters, { includeDetail: true });
  params.push(String(id));
  const rows = await prismaReadOnly.$queryRawUnsafe(`${sql.replace('ORDER BY v.occurred_at DESC, v.source DESC, v.id DESC', `AND v.id = $${params.length}::text\nORDER BY v.occurred_at DESC, v.source DESC, v.id DESC`)}\nLIMIT 1`, ...params);
  if (!rows[0]) throw AppError.notFound('Audit event not found', 'AUDIT_EVENT_NOT_FOUND');
  const { cursor_at: _cursorAt, ...event } = rows[0];
  return {
    event,
    redactions: ['request_body', 'request_summary', 'before_state', 'after_state', 'free_text_metadata'],
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditEventsToCsv(rows) {
  const columns = [
    'occurred_at', 'source', 'category', 'action', 'outcome', 'actor_uid',
    'actor_user_id', 'actor_name', 'actor_role', 'patient_uid', 'patient_id',
    'department_id', 'encounter_id', 'admission_id', 'resource_type', 'resource_id',
    'request_id', 'device_type', 'summary',
  ];
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n');
}

export async function exportAuditEvents(tenantId, query = {}) {
  const filters = normalizeAuditFilters(query, { exportMode: true });
  const { sql, params } = buildAuditEventsQuery(tenantId, filters);
  const rows = await prismaReadOnly.$queryRawUnsafe(`${sql}\nLIMIT $${params.length + 1}`, ...params, filters.limit);
  return { csv: auditEventsToCsv(rows), row_count: rows.length, filters: publicFilters(filters) };
}

export function normalizeAuditHealthWindow(query = {}, databaseNow) {
  const hours = integer(query.hours, 'hours', { min: 1, max: 24 * 90, fallback: 24 });
  const explicitFrom = instant(query.from, 'from');
  const explicitTo = instant(query.to, 'to');
  let to = explicitTo;

  if (!to) {
    const databaseInstant = databaseNow instanceof Date ? databaseNow : new Date(databaseNow);
    if (Number.isNaN(databaseInstant.getTime())) {
      throw AppError.internal(
        'Database clock returned an invalid audit-health timestamp',
        'AUDIT_HEALTH_DATABASE_CLOCK_INVALID',
      );
    }
    to = databaseInstant.toISOString();
  }

  const from = explicitFrom || new Date(new Date(to).getTime() - hours * 60 * 60 * 1000).toISOString();
  if (new Date(from) > new Date(to)) {
    throw AppError.badRequest('Audit from date must be before to date', 'INVALID_AUDIT_DATE_RANGE');
  }
  return { from, hours, to };
}

export async function getAuditHealth(tenantId, query = {}) {
  const patientThreshold = integer(query.patient_threshold, 'patient_threshold', { min: 1, max: 500, fallback: 20 });
  const databaseNow = query.to
    ? null
    : (await prismaReadOnly.$queryRawUnsafe('SELECT clock_timestamp() AS database_now'))[0]?.database_now;
  const { from, to } = normalizeAuditHealthWindow(query, databaseNow);

  const [
    sources,
    completeness,
    coverage,
    roles,
    actions,
    integrity,
    resources,
    anomalyCounts,
    highPatientActors,
  ] = await Promise.all([
    prismaReadOnly.$queryRawUnsafe(`
      SELECT source,
             COUNT(*)::text AS event_count,
             MAX(occurred_at) AS latest_event_at,
             COUNT(*) FILTER (WHERE actor_uid IS NULL AND actor_user_id IS NULL)::text AS missing_actor_count,
             COUNT(*) FILTER (WHERE request_id IS NULL)::text AS missing_request_id_count
        FROM unified_audit_events_v
       WHERE tenant_id = $1::uuid AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
       GROUP BY source ORDER BY source`, tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      SELECT COUNT(*)::text AS total_events,
             COUNT(*) FILTER (WHERE actor_uid IS NOT NULL OR actor_user_id IS NOT NULL)::text AS actor_attributed,
             COUNT(*) FILTER (WHERE patient_uid IS NOT NULL OR patient_id IS NOT NULL)::text AS patient_attributed,
             COUNT(*) FILTER (WHERE request_id IS NOT NULL)::text AS request_correlated,
             COUNT(DISTINCT actor_uid)::text AS distinct_actors,
             COUNT(DISTINCT COALESCE(patient_uid::text, patient_id))::text AS distinct_patients
        FROM unified_audit_events_v
       WHERE tenant_id = $1::uuid AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz`, tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      WITH candidates AS (
        SELECT request_id
          FROM unified_audit_events_v
         WHERE tenant_id = $1::uuid
           AND source = 'request'
           AND outcome = 'success'
           AND patient_uid IS NOT NULL
           AND safe_detail->>'method' IN ('POST', 'PUT', 'PATCH', 'DELETE')
           AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
      )
      SELECT COUNT(*)::text AS candidate_writes,
             COUNT(*) FILTER (WHERE request_id IS NOT NULL)::text AS request_ids_present,
             COUNT(*) FILTER (WHERE request_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM clinical_audit_events cae
                WHERE cae.tenant_id = $1::uuid AND cae.request_id = candidates.request_id
             ))::text AS canonical_events_linked
        FROM candidates`, tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      SELECT COALESCE(actor_role, 'UNKNOWN') AS actor_role, COUNT(*)::text AS event_count
        FROM unified_audit_events_v
       WHERE tenant_id = $1::uuid AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
       GROUP BY COALESCE(actor_role, 'UNKNOWN') ORDER BY COUNT(*) DESC LIMIT 20`, tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      SELECT action, category, COUNT(*)::text AS event_count
        FROM unified_audit_events_v
       WHERE tenant_id = $1::uuid AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
       GROUP BY action, category ORDER BY COUNT(*) DESC LIMIT 30`, tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      WITH base AS (
        SELECT id, chain_seq, prev_hash, chain_hash, tenant_id, action,
               resource_table, resource_id, actor_uid, occurred_at,
               before_state, after_state
          FROM clinical_audit_events
         WHERE tenant_id = $1::uuid
      ),
      ordered AS (
        SELECT base.*,
               ROW_NUMBER() OVER (ORDER BY chain_seq) AS row_no,
               LAG(chain_hash) OVER (ORDER BY chain_seq) AS expected_prev,
               audit_chain_hash(
                 prev_hash, id, tenant_id, action, resource_table, resource_id,
                 actor_uid, occurred_at, before_state, after_state
               ) AS recomputed
          FROM base
         WHERE chain_seq IS NOT NULL
      ),
      verdict AS (
        SELECT *,
               (chain_hash IS NOT NULL AND recomputed IS DISTINCT FROM chain_hash) AS hash_bad,
               ((row_no = 1 AND prev_hash IS NOT NULL)
                 OR (row_no > 1 AND prev_hash IS DISTINCT FROM expected_prev)) AS link_bad
          FROM ordered
      )
      SELECT (SELECT COUNT(*) FROM base)::text AS total_events,
             (SELECT COUNT(*) FROM base WHERE chain_seq IS NULL OR chain_hash IS NULL)::text AS missing_hash_count,
             COUNT(*) FILTER (WHERE hash_bad)::text AS hash_mismatch_count,
             COUNT(*) FILTER (WHERE link_bad)::text AS continuity_break_count,
             MIN(chain_seq) FILTER (WHERE hash_bad OR link_bad) AS first_problem_seq,
             (ARRAY_AGG(id ORDER BY chain_seq) FILTER (WHERE hash_bad OR link_bad))[1] AS first_problem_id,
             (SELECT id FROM base WHERE chain_seq IS NULL OR chain_hash IS NULL
               ORDER BY occurred_at, id LIMIT 1) AS first_missing_hash_id
        FROM verdict`, tenantId),
    prismaReadOnly.$queryRawUnsafe(`
      WITH catalog(resource_table) AS (
        VALUES ('clinical_notes'::text), ('clinical_orders'::text),
               ('investigations'::text), ('e_prescriptions'::text)
      ),
      resource_window AS (
        SELECT 'clinical_notes'::text AS resource_table, id::text AS resource_id
          FROM clinical_notes
         WHERE tenant_id = $1::uuid AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
        UNION ALL
        SELECT 'clinical_orders', id::text
          FROM clinical_orders
         WHERE tenant_id = $1::uuid AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
        UNION ALL
        SELECT 'investigations', id::text
         FROM investigations
         WHERE tenant_id = $1::uuid
           AND (created_at BETWEEN $2::timestamptz AND $3::timestamptz
             OR (created_at IS NULL AND requested_at AT TIME ZONE 'UTC'
               BETWEEN $2::timestamptz AND $3::timestamptz))
        UNION ALL
        SELECT 'e_prescriptions', id::text
         FROM e_prescriptions
         WHERE tenant_id = $1::uuid
           AND (created_at BETWEEN $2::timestamptz AND $3::timestamptz
             OR (created_at IS NULL AND updated_at BETWEEN $2::timestamptz AND $3::timestamptz))
      ),
      audit_window AS (
        SELECT resource_table, resource_id
          FROM clinical_audit_events
         WHERE tenant_id = $1::uuid
           AND resource_table IN ('clinical_notes', 'clinical_orders', 'investigations', 'e_prescriptions')
           AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
      ),
      dangling AS (
        SELECT aw.resource_table, COUNT(*)::text AS dangling_count
          FROM audit_window aw
         WHERE (aw.resource_table = 'clinical_notes' AND NOT EXISTS (
                  SELECT 1 FROM clinical_notes n WHERE n.tenant_id = $1::uuid AND n.id::text = aw.resource_id))
            OR (aw.resource_table = 'clinical_orders' AND NOT EXISTS (
                  SELECT 1 FROM clinical_orders o WHERE o.tenant_id = $1::uuid AND o.id::text = aw.resource_id))
            OR (aw.resource_table = 'investigations' AND NOT EXISTS (
                  SELECT 1 FROM investigations i WHERE i.tenant_id = $1::uuid AND i.id::text = aw.resource_id))
            OR (aw.resource_table = 'e_prescriptions' AND NOT EXISTS (
                  SELECT 1 FROM e_prescriptions p WHERE p.tenant_id = $1::uuid AND p.id::text = aw.resource_id))
         GROUP BY aw.resource_table
      )
      SELECT c.resource_table,
             COUNT(rw.resource_id)::text AS resource_rows,
             COUNT(rw.resource_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM clinical_audit_events cae
                WHERE cae.tenant_id = $1::uuid
                  AND cae.resource_table = c.resource_table
                  AND cae.resource_id = rw.resource_id
             ))::text AS audited_resource_rows,
             COUNT(rw.resource_id) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM clinical_audit_events cae
                WHERE cae.tenant_id = $1::uuid
                  AND cae.resource_table = c.resource_table
                  AND cae.resource_id = rw.resource_id
             ))::text AS orphan_resource_rows,
             (SELECT COUNT(*) FROM audit_window aw WHERE aw.resource_table = c.resource_table)::text AS audit_event_count,
             COALESCE(MAX(d.dangling_count), '0')::text AS dangling_audit_events
        FROM catalog c
        LEFT JOIN resource_window rw ON rw.resource_table = c.resource_table
        LEFT JOIN dangling d ON d.resource_table = c.resource_table
       GROUP BY c.resource_table
       ORDER BY c.resource_table`, tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      SELECT COUNT(*) FILTER (
               WHERE source = 'patient_access' AND outcome = 'deny'
             )::text AS denied_attempts,
             COUNT(*) FILTER (
               WHERE source = 'patient_access' AND outcome = 'break_glass'
             )::text AS break_glass_accesses,
             COUNT(*) FILTER (
               WHERE source IN ('phi_access', 'patient_access')
                 AND (((occurred_at AT TIME ZONE 'Asia/Kolkata')::time < TIME '07:00')
                   OR ((occurred_at AT TIME ZONE 'Asia/Kolkata')::time >= TIME '20:00'))
             )::text AS after_hours_accesses,
             COUNT(*) FILTER (
               WHERE source = 'operational' AND action = 'AUDIT_EVENTS_EXPORT'
             )::text AS audit_exports
        FROM unified_audit_events_v
       WHERE tenant_id = $1::uuid AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz`,
    tenantId, from, to),
    prismaReadOnly.$queryRawUnsafe(`
      WITH actor_access AS (
        SELECT actor_uid,
               MAX(actor_role) AS actor_role,
               COUNT(DISTINCT COALESCE(patient_uid::text, patient_id))::int AS distinct_patient_count,
               COUNT(*)::int AS access_event_count
          FROM unified_audit_events_v
         WHERE tenant_id = $1::uuid
           AND source IN ('phi_access', 'patient_access')
           AND actor_uid IS NOT NULL
           AND COALESCE(patient_uid::text, patient_id) IS NOT NULL
           AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
         GROUP BY actor_uid
        HAVING COUNT(DISTINCT COALESCE(patient_uid::text, patient_id)) >= $4::int
      )
      SELECT actor_uid, actor_role, distinct_patient_count, access_event_count,
             COUNT(*) OVER ()::text AS anomaly_actor_count
        FROM actor_access
       ORDER BY distinct_patient_count DESC, access_event_count DESC
       LIMIT 20`, tenantId, from, to, patientThreshold),
  ]);

  const toNumbers = (row) => Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [
    key,
    /(_count|_events|_actors|_patients|_writes|_present|_linked|_rows|_attempts|_accesses|_exports)$/.test(key)
      ? Number(value)
      : value,
  ]));
  const normalizedCompleteness = toNumbers(completeness[0]);
  const normalizedCoverage = toNumbers(coverage[0]);
  normalizedCoverage.coverage_percent = normalizedCoverage.candidate_writes > 0
    ? Number(((normalizedCoverage.canonical_events_linked / normalizedCoverage.candidate_writes) * 100).toFixed(1))
    : null;

  const normalizedIntegrity = toNumbers(integrity[0]);
  normalizedIntegrity.first_problem_seq = normalizedIntegrity.first_problem_seq == null
    ? null
    : Number(normalizedIntegrity.first_problem_seq);
  normalizedIntegrity.intact = normalizedIntegrity.missing_hash_count === 0
    && normalizedIntegrity.hash_mismatch_count === 0
    && normalizedIntegrity.continuity_break_count === 0;

  const resourceCompleteness = resources.map((row) => {
    const normalized = toNumbers(row);
    normalized.coverage_percent = normalized.resource_rows > 0
      ? Number(((normalized.audited_resource_rows / normalized.resource_rows) * 100).toFixed(1))
      : null;
    return normalized;
  });
  const normalizedHighActors = highPatientActors.map(toNumbers);
  const anomalies = {
    ...toNumbers(anomalyCounts[0]),
    after_hours_timezone: 'Asia/Kolkata',
    after_hours_window: '20:00-07:00',
    high_patient_access_threshold: patientThreshold,
    high_patient_access_actors: normalizedHighActors[0]?.anomaly_actor_count || 0,
    high_patient_access_actor_details: normalizedHighActors.map(({ anomaly_actor_count: _count, ...row }) => row),
  };

  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    total_events: normalizedCompleteness.total_events,
    sources: sources.map(toNumbers),
    completeness: normalizedCompleteness,
    canonical_write_coverage: normalizedCoverage,
    integrity: normalizedIntegrity,
    resource_completeness: resourceCompleteness,
    anomalies,
    actor_roles: roles.map(toNumbers),
    top_actions: actions.map(toNumbers),
  };
}

export async function recordAuditConsoleAccess(req, action, metadata = {}) {
  const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId;
  const rawActorUid = req.user?.uid || null;
  const actorUid = rawActorUid && UUID_RE.test(String(rawActorUid)) ? String(rawActorUid) : null;
  if (!tenantId) return;
  try {
    await prisma.audit_logs.create({
      data: {
        tenant_id: String(tenantId),
        uid: actorUid,
        actor_uid: actorUid,
        role: req.user?.role || null,
        action,
        resource: 'audit_console',
        resource_id: req.id || null,
        ip_address: req.ip || null,
        user_agent: String(req.headers?.['user-agent'] || '').slice(0, 500) || null,
        metadata: {
          request_id: req.id || null,
          actor_user_id: req.user?.id ?? req.user?.userId ?? null,
          ...metadata,
        },
      },
    });
  } catch (err) {
    logger.error('Failed to record audit-console access', { action, error: err.message });
  }
}
