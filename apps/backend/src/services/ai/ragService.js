/**
 * RAG layer — institutional memory over signed documents.
 *
 * Design goals:
 *   1. Tenant-scoped from day 1. Every corpus row carries tenant_id; every
 *      query filters on it. A DPDP India tenant never sees a US tenant's
 *      prior cases, ever.
 *   2. Gracefully degrades. If pgvector isn't installed or Ollama embed is
 *      unreachable, all RAG paths return empty results with a clear flag,
 *      letting the clinical draft still complete via normal chart context.
 *   3. Only signed content is indexed. Unsigned clinical notes, discharge
 *      summaries, or referrals never enter the corpus — we cannot cite
 *      evidence that hasn't been clinician-attested.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { detectPromptInjection } from './documentPromptInjectionDetectorService.js';

const EMBED_DIM = 768;
const DEFAULT_CHUNK_CHARS = 1600; // ~400 tokens at ~4 chars/token
const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SIMILARITY = 0.65;

function isMissingSchemaError(err) {
  return /does not exist|extension|relation .* does not exist|type .*vector/i.test(String(err?.message || ''));
}

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function embedBaseUrl() {
  return (
    process.env.CLINICAL_AI_EMBED_URL ||
    process.env.CLINICAL_AI_BASE_URL ||
    'http://localhost:11434'
  ).replace(/\/+$/, '');
}

function embedModel() {
  return process.env.CLINICAL_AI_EMBED_MODEL || 'nomic-embed-text';
}

/**
 * Call Ollama's embed endpoint (or any compatible /api/embed). Returns a
 * 768-dim Float32 array, or null on any failure (timeouts, missing Ollama,
 * dimension mismatch). Never throws.
 */
export async function embedText(text) {
  const body = String(text || '').slice(0, 8000);
  if (!body.trim()) return null;
  try {
    const response = await fetch(`${embedBaseUrl()}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel(), input: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.debug('RAG embed call failed', { status: response.status });
      return null;
    }
    const payload = await response.json();
    const vec = Array.isArray(payload.embeddings)
      ? payload.embeddings[0]
      : Array.isArray(payload.embedding)
        ? payload.embedding
        : null;
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
      logger.debug('RAG embed returned unexpected shape', {
        got: Array.isArray(vec) ? vec.length : typeof vec,
        expected: EMBED_DIM,
      });
      return null;
    }
    return vec.map((v) => Number(v));
  } catch (err) {
    logger.debug('RAG embed unreachable', { error: err.message });
    return null;
  }
}

function toPgVector(vec) {
  // pgvector's TEXT input format is '[v1,v2,...]'.
  return `[${vec.map((v) => Number(v)).join(',')}]`;
}

/**
 * Split content into overlapping character windows. Crude but deterministic
 * and avoids dependency on a tokenizer. Overlap keeps semantic boundaries.
 */
export function chunkText(text, { maxChars = DEFAULT_CHUNK_CHARS, overlap = 200 } = {}) {
  const body = String(text || '').trim();
  if (!body) return [];
  if (body.length <= maxChars) return [body];

  const chunks = [];
  let cursor = 0;
  while (cursor < body.length) {
    const end = Math.min(cursor + maxChars, body.length);
    chunks.push(body.slice(cursor, end));
    if (end === body.length) break;
    cursor = end - overlap;
  }
  return chunks;
}

/**
 * Index one document into the corpus. Idempotent on
 * (tenant_id, source_type, source_id, chunk_index).
 */
export async function indexDocument({
  tenantId = null,
  sourceType,
  sourceId,
  content,
  patientUid = null,
  metadata = {},
  signedAt = null,
  retentionDays = 365,
} = {}) {
  if (!sourceType || !sourceId) {
    throw new Error('indexDocument requires sourceType and sourceId');
  }
  const tid = resolveTenantId({ tenantId });

  // S1 prompt-injection gate — refuses to index 'block' verdict content into
  // the corpus, where it would otherwise feed every future RAG retrieval.
  // 'flag' verdicts are indexed with the verdict captured in chunk metadata
  // so retrievers / admins can audit which corpus rows looked suspicious.
  const fullText = String(content || '');
  let injectionVerdict = null;
  if (fullText.trim().length >= 20) {
    const injection = detectPromptInjection({
      text: fullText,
      source: `rag_corpus:${sourceType}`,
      metadata: { sourceId: String(sourceId), patientUid },
    });
    injectionVerdict = injection.verdict;
    if (injection.verdict === 'block') {
      logger.warn('RAG indexDocument blocked for prompt injection', {
        tenantId: tid,
        sourceType,
        sourceId: String(sourceId),
        score: injection.score,
        hit_count: injection.hits.length,
      });
      return {
        indexed: 0,
        skipped_reason: 'prompt_injection_blocked',
        injection: {
          score: injection.score,
          hit_count: injection.hits.length,
          reasons: injection.reasons.slice(0, 5),
        },
      };
    }
  }

  const chunks = chunkText(content);
  if (!chunks.length) return { indexed: 0, skipped_reason: 'empty_content' };

  const chunkMetadata = injectionVerdict === 'flag'
    ? { ...(metadata || {}), prompt_injection_verdict: 'flag' }
    : (metadata || {});

  let indexed = 0;
  let skippedReason = null;
  const retentionUntil = retentionDays
    ? new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;

  for (let i = 0; i < chunks.length; i += 1) {
    const vec = await embedText(chunks[i]);
    if (!vec) {
      skippedReason = skippedReason || 'embed_unavailable';
      continue;
    }
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_corpus
           (tenant_id, source_type, source_id, patient_uid, chunk_index, content,
            embedding, metadata, signed_at, retention_until, created_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::vector, $8::jsonb,
                 $9::timestamptz, $10::date, NOW())
         ON CONFLICT (tenant_id, source_type, source_id, chunk_index)
         DO UPDATE SET
           content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           metadata = EXCLUDED.metadata,
           signed_at = EXCLUDED.signed_at,
           retention_until = EXCLUDED.retention_until`,
        tid,
        sourceType,
        String(sourceId),
        patientUid,
        i,
        chunks[i],
        toPgVector(vec),
        JSON.stringify(chunkMetadata),
        signedAt || null,
        retentionUntil
      );
      indexed += 1;
    } catch (err) {
      if (isMissingSchemaError(err)) {
        return { indexed: 0, skipped_reason: 'corpus_unavailable' };
      }
      logger.warn('RAG indexDocument row insert failed', {
        sourceType,
        sourceId,
        chunkIndex: i,
        error: err.message,
      });
    }
  }
  return { indexed, skipped_reason: skippedReason };
}

/**
 * Retrieve top-K similar chunks for a free-text query, filtered by tenant
 * and optional metadata filters. Returns [] when pgvector/Ollama aren't
 * available — caller treats as "no retrieval this time" and proceeds.
 */
export async function retrieveRelevant({
  tenantId = null,
  queryText,
  filters = {},
  topK = DEFAULT_TOP_K,
  minScore = DEFAULT_MIN_SIMILARITY,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!queryText || !String(queryText).trim()) return { results: [], source: 'empty_query' };

  const vec = await embedText(queryText);
  if (!vec) return { results: [], source: 'embed_unavailable' };

  const limit = Math.min(Math.max(Number.parseInt(topK, 10) || DEFAULT_TOP_K, 1), 50);
  const sourceType = filters.sourceType || null;
  const patientUid = filters.patientUid || null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         id,
         source_type,
         source_id,
         patient_uid,
         content,
         metadata,
         signed_at,
         1 - (embedding <=> $2::vector) AS similarity
       FROM clinical_ai_corpus
       WHERE tenant_id = $1::uuid
         AND ($3::text IS NULL OR source_type = $3)
         AND ($4::uuid IS NULL OR patient_uid = $4::uuid)
       ORDER BY embedding <=> $2::vector
       LIMIT $5`,
      tid,
      toPgVector(vec),
      sourceType,
      patientUid,
      limit
    );
    const filtered = rows.filter((row) => Number(row.similarity) >= minScore);
    return { results: filtered, source: filtered.length ? 'pgvector' : 'below_threshold' };
  } catch (err) {
    if (isMissingSchemaError(err)) return { results: [], source: 'corpus_unavailable' };
    logger.warn('RAG retrieveRelevant query failed', { error: err.message });
    return { results: [], source: 'query_failed' };
  }
}

/**
 * Quick corpus health snapshot — used by the admin dashboard. Returns a row
 * count per source_type and metadata about staleness + retention. Safe if
 * pgvector isn't installed (returns zeros).
 */
export async function getCorpusHealth({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         source_type,
         COUNT(*)::int AS chunk_count,
         COUNT(DISTINCT source_id)::int AS document_count,
         MIN(signed_at) AS oldest_signed,
         MAX(signed_at) AS newest_signed,
         COALESCE(SUM(CASE WHEN retention_until < CURRENT_DATE THEN 1 ELSE 0 END), 0)::int AS expired_chunks
       FROM clinical_ai_corpus
       WHERE tenant_id = $1::uuid
       GROUP BY source_type
       ORDER BY source_type`,
      tid
    );
    return {
      by_source_type: rows,
      total_chunks: rows.reduce((sum, row) => sum + Number(row.chunk_count || 0), 0),
      corpus_available: true,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { by_source_type: [], total_chunks: 0, corpus_available: false };
    }
    throw err;
  }
}

/**
 * Backfill signed discharge summaries into the corpus. Tenant-scoped; caller
 * must pass the tenantId they want to index. Safe to re-run (idempotent).
 */
export async function backfillSignedDischargeSummaries({ tenantId = null, limit = 200 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 2000);

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT a.id AS admission_id,
              a.patient_uid,
              a.discharge_summary,
              a.discharge_summary->>'signed_at' AS signed_at,
              a.admitting_diagnosis,
              a.chief_complaint,
              a.ward
       FROM admissions a
       WHERE a.tenant_id = $1::uuid
         AND a.discharge_summary IS NOT NULL
         AND a.discharge_summary->>'is_signed' = 'true'
       ORDER BY a.discharged_at DESC NULLS LAST
       LIMIT $2`,
      tid,
      safeLimit
    );
  } catch (err) {
    // admissions may not have tenant_id yet (only clinical_ai_* did in M0).
    // Fall back to a tenant-less scan if the column doesn't exist.
    if (/column .* tenant_id .*does not exist/i.test(String(err?.message || ''))) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT a.id AS admission_id,
                a.patient_uid,
                a.discharge_summary,
                a.discharge_summary->>'signed_at' AS signed_at,
                a.admitting_diagnosis,
                a.chief_complaint,
                a.ward
         FROM admissions a
         WHERE a.discharge_summary IS NOT NULL
           AND a.discharge_summary->>'is_signed' = 'true'
         ORDER BY a.discharged_at DESC NULLS LAST
         LIMIT $1`,
        safeLimit
      );
    } else {
      throw err;
    }
  }

  let indexed = 0;
  let skipped = 0;
  let injectionBlocked = 0;
  for (const row of rows) {
    const summary = row.discharge_summary || {};
    const content = [
      `Admission: ${row.admitting_diagnosis || ''} (${row.chief_complaint || ''})`,
      `Ward: ${row.ward || ''}`,
      `Hospital course: ${summary.hospital_course || ''}`,
      `Discharge diagnosis: ${summary.discharge_diagnosis || ''}`,
      `Follow-up: ${summary.follow_up_instructions || ''}`,
      `Procedures: ${Array.isArray(summary.procedures_performed) ? summary.procedures_performed.join('; ') : ''}`,
    ].join('\n');

    const result = await indexDocument({
      tenantId: tid,
      sourceType: 'discharge_summary',
      sourceId: String(row.admission_id),
      content,
      patientUid: row.patient_uid || null,
      metadata: {
        ward: row.ward,
        admitting_diagnosis: row.admitting_diagnosis,
        chief_complaint: row.chief_complaint,
      },
      signedAt: row.signed_at || null,
      retentionDays: 365,
    });

    if (result.indexed > 0) indexed += result.indexed;
    else skipped += 1;

    if (result.skipped_reason === 'prompt_injection_blocked') {
      injectionBlocked += 1;
      // Per-document concern; continue with the rest of the backfill.
      continue;
    }

    // Stop early if the embed endpoint is unreachable — no point retrying
    // the remaining rows this run.
    if (result.skipped_reason === 'embed_unavailable') {
      return { indexed, skipped, injection_blocked: injectionBlocked, halted: true, reason: 'embed_unavailable' };
    }
    if (result.skipped_reason === 'corpus_unavailable') {
      return { indexed, skipped, injection_blocked: injectionBlocked, halted: true, reason: 'corpus_unavailable' };
    }
  }

  return { indexed, skipped, injection_blocked: injectionBlocked, halted: false };
}

export default {
  backfillSignedDischargeSummaries,
  chunkText,
  embedText,
  getCorpusHealth,
  indexDocument,
  retrieveRelevant,
};
