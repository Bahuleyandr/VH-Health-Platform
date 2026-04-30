/**
 * Knowledge Base document pipeline (Phase A1 PR2).
 *
 * Pipeline:
 *   inline_text or file upload
 *     → S1 prompt-injection gate
 *         → block: persist row, processing_status='blocked'
 *         → flag : continue, mark prompt_injection_verdict='flag'
 *         → pass : continue
 *     → chunk via ragService.chunkText (consistent boundaries with the
 *        existing discharge-summary corpus)
 *     → embed each chunk via ragService.embedText (Ollama-backed, 768-dim)
 *     → INSERT into knowledge_chunks with the embedding as pgvector
 *     → mark processing_status='indexed', set chunk_count
 *
 * Failures:
 *   - embed_unavailable (Ollama down) → processing_status='failed' with
 *     processing_error='embed_unavailable'; reindex retries from scratch
 *     (chunks for this document are deleted before re-running).
 *   - missing pgvector → propagates as a schema error; caller surfaces
 *     to the admin so they can install the extension.
 *
 * Tenant isolation: every read/write filters on tenant_id explicitly.
 *
 * Decision-support only: documents go in to *augment* AI prompts; they
 * never become the authoritative chart record.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { extractTextFromDocumentUpload } from './documentOcrAdapter.js';
import {
  detectPromptInjection,
  injectionSafetyFlag,
} from './documentPromptInjectionDetectorService.js';
import { chunkText, embedText } from './ragService.js';
import { getKnowledgeBase } from './knowledgeBaseService.js';

const MAX_RAW_TEXT_CHARS = 200_000;
const TITLE_MAX = 255;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const PROCESSING_STATUSES = [
  'pending',
  'extracting',
  'chunking',
  'embedding',
  'indexed',
  'failed',
  'blocked',
];

const SOURCE_TYPES = ['upload', 'url', 'inline_text', 'imported'];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function safeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function toPgVector(vec) {
  return `[${vec.map((v) => Number(v)).join(',')}]`;
}

function evaluateInjection(text, source, metadata = {}) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 20) {
    return { result: null, safetyFlag: null, verdict: 'pass' };
  }
  const result = detectPromptInjection({ text: trimmed, source, metadata });
  return {
    result,
    safetyFlag: injectionSafetyFlag(result),
    verdict: result.verdict,
  };
}

function buildInjectionMetadata(injection) {
  if (!injection?.result) return {};
  return {
    verdict: injection.verdict,
    score: injection.result.score,
    hit_count: injection.result.hits.length,
    reasons: injection.result.reasons.slice(0, 6),
    sample: injection.result.sample,
  };
}

// ---------------------------------------------------------------------------
// Document creation entry points
// ---------------------------------------------------------------------------

export async function createInlineDocument({
  tenantId = null,
  knowledgeBaseId,
  title,
  rawText,
  sourceType = 'inline_text',
  uploadedBy = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(knowledgeBaseId, 'knowledge_base_id');
  const cleanTitle = safeText(title, TITLE_MAX);
  if (!cleanTitle) throw AppError.badRequest('title is required');
  const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, MAX_RAW_TEXT_CHARS);
  if (!text) throw AppError.badRequest('raw_text is required for inline_text documents');
  if (!SOURCE_TYPES.includes(String(sourceType))) {
    throw AppError.badRequest(`source_type must be one of: ${SOURCE_TYPES.join(', ')}`);
  }
  // Tenant + KB existence check.
  await getKnowledgeBase({ tenantId: tid, id: kbId });

  const injection = evaluateInjection(text, 'knowledge_base_inline', { knowledge_base_id: kbId });
  const blocked = injection.verdict === 'block';

  const documentRow = await insertDocument({
    tenantId: tid,
    knowledgeBaseId: kbId,
    title: cleanTitle,
    sourceType,
    sourceUri: null,
    mimeType: 'text/plain',
    fileHash: sourceHash(text),
    fileSizeBytes: Buffer.byteLength(text, 'utf8'),
    rawText: text,
    processingStatus: blocked ? 'blocked' : 'pending',
    processingError: blocked ? 'prompt_injection_blocked' : null,
    promptInjectionVerdict: injection.verdict || null,
    promptInjectionMetadata: buildInjectionMetadata(injection),
    uploadedBy,
    metadata,
  });

  if (blocked) {
    logger.warn('Knowledge document inline ingestion blocked for prompt injection', {
      tenantId: tid,
      knowledgeBaseId: kbId,
      score: injection.result.score,
      hit_count: injection.result.hits.length,
    });
    return { document: documentRow, processed: false, reason: 'prompt_injection_blocked', injection_safety_flag: injection.safetyFlag };
  }

  const processed = await processDocumentChunks({
    tenantId: tid,
    document: documentRow,
    rawText: text,
  });
  return { document: processed.document, processed: true, ...processed.summary };
}

export async function uploadDocument({
  tenantId = null,
  knowledgeBaseId,
  file,
  title = null,
  uploadedBy = null,
  metadata = {},
} = {}) {
  if (!file?.buffer) throw AppError.badRequest('file is required');
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(knowledgeBaseId, 'knowledge_base_id');
  await getKnowledgeBase({ tenantId: tid, id: kbId });

  const ocrResult = await extractTextFromDocumentUpload({
    buffer: file.buffer,
    mimeType: file.mimetype,
    fileName: file.originalname,
  });
  const rawText = String(ocrResult.raw_text || '').slice(0, MAX_RAW_TEXT_CHARS);
  const cleanTitle = safeText(title, TITLE_MAX) || file.originalname?.slice(0, TITLE_MAX) || 'Untitled';

  const injection = evaluateInjection(rawText, 'knowledge_base_upload', {
    knowledge_base_id: kbId,
    file_name: file.originalname,
    mime_type: ocrResult.mime_type,
  });
  const blocked = injection.verdict === 'block';

  const documentRow = await insertDocument({
    tenantId: tid,
    knowledgeBaseId: kbId,
    title: cleanTitle,
    sourceType: 'upload',
    sourceUri: file.originalname || null,
    mimeType: ocrResult.mime_type || file.mimetype || null,
    fileHash: ocrResult.file_hash || sourceHash(rawText),
    fileSizeBytes: ocrResult.file_size_bytes || file.size || Buffer.byteLength(rawText, 'utf8'),
    rawText,
    processingStatus: blocked ? 'blocked' : (rawText ? 'pending' : 'failed'),
    processingError: blocked ? 'prompt_injection_blocked' : (rawText ? null : 'no_text_extracted'),
    promptInjectionVerdict: injection.verdict || null,
    promptInjectionMetadata: buildInjectionMetadata(injection),
    uploadedBy,
    metadata: {
      ...metadata,
      ocr_provider: ocrResult.provider,
      ocr_status: ocrResult.status,
      ocr_metadata: ocrResult.metadata || {},
    },
  });

  if (blocked) {
    logger.warn('Knowledge document upload blocked for prompt injection', {
      tenantId: tid,
      knowledgeBaseId: kbId,
      file_name: file.originalname,
      score: injection.result.score,
    });
    return { document: documentRow, processed: false, reason: 'prompt_injection_blocked', injection_safety_flag: injection.safetyFlag };
  }
  if (!rawText) {
    return { document: documentRow, processed: false, reason: 'no_text_extracted' };
  }

  const processed = await processDocumentChunks({
    tenantId: tid,
    document: documentRow,
    rawText,
  });
  return { document: processed.document, processed: true, ...processed.summary };
}

export async function reindexDocument({ tenantId = null, documentId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const docId = normalizeId(documentId, 'document_id');
  const document = await getKnowledgeDocument({ tenantId: tid, documentId: docId });

  if (!document.raw_text) {
    throw AppError.badRequest('document has no raw_text to re-index');
  }

  // Wipe existing chunks then re-run the pipeline.
  await prisma.$queryRawUnsafe(
    `DELETE FROM knowledge_chunks WHERE document_id = $1 AND tenant_id = $2::uuid`,
    docId, tid,
  );
  await prisma.$queryRawUnsafe(
    `UPDATE knowledge_documents
     SET processing_status = 'pending', processing_error = NULL, chunk_count = 0,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid`,
    docId, tid,
  );

  const refreshed = await getKnowledgeDocument({ tenantId: tid, documentId: docId });
  const processed = await processDocumentChunks({
    tenantId: tid,
    document: refreshed,
    rawText: refreshed.raw_text,
  });
  return { document: processed.document, processed: true, ...processed.summary };
}

// ---------------------------------------------------------------------------
// Pipeline (chunk + embed + index) — internal
// ---------------------------------------------------------------------------

async function insertDocument(args) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO knowledge_documents
       (knowledge_base_id, tenant_id, title, source_type, source_uri,
        mime_type, file_hash, file_size_bytes, raw_text,
        processing_status, processing_error, prompt_injection_verdict,
        prompt_injection_metadata, uploaded_by, metadata)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13::jsonb, $14::uuid, $15::jsonb)
     RETURNING id, knowledge_base_id, tenant_id, title, source_type,
               source_uri, mime_type, file_hash, file_size_bytes,
               raw_text, processing_status, processing_error, chunk_count,
               prompt_injection_verdict, prompt_injection_metadata,
               uploaded_by, metadata, created_at, updated_at`,
    args.knowledgeBaseId, args.tenantId, args.title, args.sourceType, args.sourceUri,
    args.mimeType, args.fileHash, args.fileSizeBytes, args.rawText,
    args.processingStatus, args.processingError, args.promptInjectionVerdict,
    JSON.stringify(args.promptInjectionMetadata || {}), args.uploadedBy,
    JSON.stringify(args.metadata || {}),
  );
  return rows[0];
}

async function setDocumentStatus({ tenantId, documentId, status, error: errMsg = null, chunkCount = null }) {
  const fields = ['processing_status = $1', 'updated_at = NOW()'];
  const params = [status];
  let nextIdx = 2;
  if (errMsg !== null) {
    fields.push(`processing_error = $${nextIdx}`);
    params.push(errMsg);
    nextIdx += 1;
  }
  if (chunkCount !== null) {
    fields.push(`chunk_count = $${nextIdx}`);
    params.push(chunkCount);
    nextIdx += 1;
  }
  params.push(documentId, tenantId);
  await prisma.$queryRawUnsafe(
    `UPDATE knowledge_documents SET ${fields.join(', ')}
     WHERE id = $${nextIdx} AND tenant_id = $${nextIdx + 1}::uuid`,
    ...params,
  );
}

async function processDocumentChunks({ tenantId, document, rawText }) {
  const docId = document.id;

  await setDocumentStatus({ tenantId, documentId: docId, status: 'chunking' });
  const chunks = chunkText(rawText);
  if (!chunks.length) {
    await setDocumentStatus({
      tenantId,
      documentId: docId,
      status: 'failed',
      error: 'no_chunks_produced',
    });
    const refreshed = await getKnowledgeDocument({ tenantId, documentId: docId });
    return {
      document: refreshed,
      summary: { chunk_count: 0, embedded_count: 0, reason: 'no_chunks_produced' },
    };
  }

  await setDocumentStatus({ tenantId, documentId: docId, status: 'embedding' });

  let embeddedCount = 0;
  let firstFailure = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const vec = await embedText(chunks[i]);
    if (!vec) {
      firstFailure = firstFailure || 'embed_unavailable';
      continue;
    }
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO knowledge_chunks
           (document_id, knowledge_base_id, tenant_id, chunk_index, content, embedding, metadata)
         VALUES ($1, $2, $3::uuid, $4, $5, $6::vector, $7::jsonb)
         ON CONFLICT (document_id, chunk_index)
         DO UPDATE SET
           content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           metadata = EXCLUDED.metadata`,
        docId, document.knowledge_base_id, tenantId, i, chunks[i],
        toPgVector(vec), JSON.stringify({ char_count: chunks[i].length }),
      );
      embeddedCount += 1;
    } catch (err) {
      firstFailure = firstFailure || `chunk_insert_failed:${i}`;
      if (isMissingSchemaError(err)) {
        await setDocumentStatus({
          tenantId,
          documentId: docId,
          status: 'failed',
          error: 'corpus_unavailable',
        });
        const refreshed = await getKnowledgeDocument({ tenantId, documentId: docId });
        return {
          document: refreshed,
          summary: { chunk_count: chunks.length, embedded_count: embeddedCount, reason: 'corpus_unavailable' },
        };
      }
      logger.warn('Knowledge chunk insert failed', { documentId: docId, chunkIndex: i, error: err.message });
    }
  }

  if (embeddedCount === 0) {
    await setDocumentStatus({
      tenantId,
      documentId: docId,
      status: 'failed',
      error: firstFailure || 'embedding_failed',
      chunkCount: 0,
    });
  } else {
    await setDocumentStatus({
      tenantId,
      documentId: docId,
      status: 'indexed',
      error: null,
      chunkCount: embeddedCount,
    });
  }

  const refreshed = await getKnowledgeDocument({ tenantId, documentId: docId });
  return {
    document: refreshed,
    summary: {
      chunk_count: chunks.length,
      embedded_count: embeddedCount,
      reason: embeddedCount === 0 ? (firstFailure || 'embedding_failed') : null,
    },
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listKnowledgeDocuments({
  tenantId = null,
  knowledgeBaseId,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(knowledgeBaseId, 'knowledge_base_id');
  const safeLimit = normalizeLimit(limit);
  const filters = ['knowledge_base_id = $1', 'tenant_id = $2::uuid'];
  const params = [kbId, tid];
  if (status) {
    if (!PROCESSING_STATUSES.includes(String(status))) {
      throw AppError.badRequest(`status must be one of: ${PROCESSING_STATUSES.join(', ')}`);
    }
    params.push(status);
    filters.push(`processing_status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, knowledge_base_id, tenant_id, title, source_type, source_uri,
              mime_type, file_hash, file_size_bytes, processing_status,
              processing_error, chunk_count, prompt_injection_verdict,
              prompt_injection_metadata, uploaded_by, metadata,
              created_at, updated_at
       FROM knowledge_documents
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { documents: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { documents: [], count: 0 };
    throw err;
  }
}

export async function getKnowledgeDocument({ tenantId = null, documentId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const docId = normalizeId(documentId, 'document_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, knowledge_base_id, tenant_id, title, source_type, source_uri,
            mime_type, file_hash, file_size_bytes, raw_text,
            processing_status, processing_error, chunk_count,
            prompt_injection_verdict, prompt_injection_metadata,
            uploaded_by, metadata, created_at, updated_at
     FROM knowledge_documents
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    docId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Knowledge document not found');
  return rows[0];
}

export async function deleteKnowledgeDocument({ tenantId = null, documentId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const docId = normalizeId(documentId, 'document_id');
  const rows = await prisma.$queryRawUnsafe(
    `DELETE FROM knowledge_documents
     WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING id, knowledge_base_id, title`,
    docId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Knowledge document not found');
  return rows[0];
}

export const __testing__ = {
  PROCESSING_STATUSES,
  SOURCE_TYPES,
  MAX_RAW_TEXT_CHARS,
};

export default {
  createInlineDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  reindexDocument,
  uploadDocument,
};
