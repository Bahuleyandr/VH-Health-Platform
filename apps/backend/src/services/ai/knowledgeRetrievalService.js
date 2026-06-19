/**
 * Knowledge Base permission-filtered retrieval (Phase A1 PR3).
 *
 * Given a free-text query + a clinician's role, return the top-K chunks
 * from knowledge bases that role is allowed to read. Every retrieval is
 * logged to knowledge_retrieval_logs so the governance dashboard can
 * audit who pulled what knowledge into a clinical-AI prompt.
 *
 * Call shape:
 *   retrieveFromKnowledgeBases({
 *     tenantId, queryText, role, knowledgeBaseId?, kbType?, moduleKey?,
 *     retrievedBy, topK, minScore,
 *   })
 *
 * Permission gate: a chunk is returned only if the caller's role has at
 * least 'read' permission on the chunk's knowledge_base (per the
 * knowledge_access_policies table). The filter is applied INSIDE the SQL
 * so we never carry chunks for a KB the role can't access through to JS
 * filtering. Manage and write permissions implicitly include read.
 *
 * Tenant isolation: every read filters tenant_id explicitly. Roles like
 * SUPER_ADMIN are NOT auto-granted everything — they must have an
 * explicit access policy. (Cross-tenant retrieval is a separate concern.)
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { embedText } from './ragService.js';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 50;
const DEFAULT_MIN_SCORE = 0.55;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist|type .* vector/i.test(String(err?.message || ''));
}

function normalizeTopK(value, fallback = DEFAULT_TOP_K, max = MAX_TOP_K) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeMinScore(value, fallback = DEFAULT_MIN_SCORE) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function toPgVector(vec) {
  return `[${vec.map((v) => Number(v)).join(',')}]`;
}

function queryHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

/**
 * Permission-filtered retrieval. Returns:
 *   {
 *     results: [{ chunk_id, document_id, knowledge_base_id, kb_name,
 *                 kb_type, document_title, content, similarity }, ...],
 *     source: 'pgvector' | 'embed_unavailable' | 'corpus_unavailable'
 *           | 'no_access' | 'empty_query',
 *     query_hash,
 *   }
 *
 * Never throws on infrastructure issues — degrades to empty results so
 * the calling AI workflow can still proceed without RAG context.
 */
export async function retrieveFromKnowledgeBases({
  tenantId = null,
  queryText,
  role,
  knowledgeBaseId = null,
  kbType = null,
  moduleKey = null,
  retrievedBy = null,
  topK = DEFAULT_TOP_K,
  minScore = DEFAULT_MIN_SCORE,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const text = String(queryText || '').trim();
  if (!text) {
    return { results: [], source: 'empty_query', query_hash: null };
  }

  const normalizedRole = role ? String(role).toUpperCase() : null;
  if (!normalizedRole) {
    return { results: [], source: 'no_access', query_hash: queryHash(text) };
  }

  const vec = await embedText(text);
  if (!vec) {
    return { results: [], source: 'embed_unavailable', query_hash: queryHash(text) };
  }

  const limit = normalizeTopK(topK);
  const score = normalizeMinScore(minScore);
  const kbIdFilter = knowledgeBaseId ? Number.parseInt(knowledgeBaseId, 10) : null;
  const kbTypeFilter = kbType ? String(kbType).toLowerCase() : null;
  const qHash = queryHash(text);

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT
         c.id            AS chunk_id,
         c.document_id   AS document_id,
         c.knowledge_base_id,
         kb.name         AS kb_name,
         kb.kb_type      AS kb_type,
         d.title         AS document_title,
         d.source_type   AS document_source_type,
         c.content,
         1 - (c.embedding <=> $2::vector) AS similarity
       FROM knowledge_chunks c
       JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
       JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.tenant_id = $1::uuid
         AND kb.status = 'active'
         -- WS5 B5.5: only curation-approved documents feed an AI prompt.
         -- Imported (formulary / antibiogram / protocol) docs land 'pending'
         -- and stay dark until pharmacy / micro-infection-control sign-off.
         AND d.curation_status = 'approved'
         AND ($3::int IS NULL OR c.knowledge_base_id = $3)
         AND ($4::text IS NULL OR kb.kb_type = $4)
         AND EXISTS (
           SELECT 1
           FROM knowledge_access_policies ap
           WHERE ap.knowledge_base_id = kb.id
             AND ap.tenant_id = kb.tenant_id
             AND ap.role = $5
             AND ap.permission IN ('read', 'write', 'manage')
         )
       ORDER BY c.embedding <=> $2::vector
       LIMIT $6`,
      tid, toPgVector(vec), kbIdFilter, kbTypeFilter, normalizedRole, limit,
    );
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { results: [], source: 'corpus_unavailable', query_hash: qHash };
    }
    logger.warn('Knowledge base retrieval query failed', { error: err.message });
    return { results: [], source: 'query_failed', query_hash: qHash };
  }

  const filtered = rows.filter((row) => Number(row.similarity) >= score);

  // Audit-log every retrieved chunk so a regulator can trace which
  // hospital knowledge fed which AI draft.
  if (filtered.length) {
    await logRetrievals({
      tenantId: tid,
      rows: filtered,
      retrievedBy,
      retrievedByRole: normalizedRole,
      moduleKey,
      queryHash: qHash,
    });
  } else if (rows.length) {
    // We retrieved nothing above the score threshold; still log a
    // single row with chunk_id=null so the dashboard can show "0
    // results" attempts.
    await logZeroRetrieval({
      tenantId: tid,
      knowledgeBaseId: kbIdFilter,
      retrievedBy,
      retrievedByRole: normalizedRole,
      moduleKey,
      queryHash: qHash,
      reason: 'below_threshold',
    });
  } else {
    await logZeroRetrieval({
      tenantId: tid,
      knowledgeBaseId: kbIdFilter,
      retrievedBy,
      retrievedByRole: normalizedRole,
      moduleKey,
      queryHash: qHash,
      reason: 'no_match',
    });
  }

  return {
    results: filtered,
    source: filtered.length ? 'pgvector' : 'below_threshold',
    query_hash: qHash,
  };
}

async function logRetrievals({
  tenantId, rows, retrievedBy, retrievedByRole, moduleKey, queryHash: qHash,
}) {
  const inserts = rows.map((row) => prisma.$queryRawUnsafe(
    `INSERT INTO knowledge_retrieval_logs
       (tenant_id, knowledge_base_id, chunk_id, retrieved_by, retrieved_by_role,
        retrieved_for_module_key, query_hash, similarity, metadata)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb)`,
    tenantId, row.knowledge_base_id, row.chunk_id, retrievedBy, retrievedByRole,
    moduleKey || null, qHash, Number(row.similarity || 0),
    JSON.stringify({ document_id: row.document_id }),
  ).catch((err) => {
    if (!isMissingSchemaError(err)) {
      logger.warn('knowledge_retrieval_logs insert failed', { error: err.message });
    }
  }));
  await Promise.all(inserts);
}

async function logZeroRetrieval({
  tenantId, knowledgeBaseId, retrievedBy, retrievedByRole, moduleKey, queryHash: qHash, reason,
}) {
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO knowledge_retrieval_logs
         (tenant_id, knowledge_base_id, chunk_id, retrieved_by, retrieved_by_role,
          retrieved_for_module_key, query_hash, similarity, metadata)
       VALUES ($1::uuid, $2, NULL, $3::uuid, $4, $5, $6, NULL, $7::jsonb)`,
      tenantId, knowledgeBaseId, retrievedBy, retrievedByRole,
      moduleKey || null, qHash,
      JSON.stringify({ reason, zero_result: true }),
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('knowledge_retrieval_logs zero-result insert failed', { error: err.message });
    }
  }
}

/**
 * Recent retrieval log rows for the governance dashboard.
 */
export async function listRetrievalLogs({
  tenantId = null,
  knowledgeBaseId = null,
  moduleKey = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (knowledgeBaseId) {
    params.push(Number.parseInt(knowledgeBaseId, 10));
    filters.push(`knowledge_base_id = $${params.length}`);
  }
  if (moduleKey) {
    params.push(String(moduleKey));
    filters.push(`retrieved_for_module_key = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, knowledge_base_id, chunk_id, retrieved_by,
              retrieved_by_role, retrieved_for_module_key, query_hash,
              similarity, metadata, retrieved_at
       FROM knowledge_retrieval_logs
       WHERE ${filters.join(' AND ')}
       ORDER BY retrieved_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { logs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { logs: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  DEFAULT_TOP_K,
  DEFAULT_MIN_SCORE,
  normalizeMinScore,
  normalizeTopK,
};

export default {
  listRetrievalLogs,
  retrieveFromKnowledgeBases,
};
