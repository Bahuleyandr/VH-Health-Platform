/**
 * Knowledge Base CRUD admin routes — Phase A1 of the structural audit.
 *
 *   GET    /knowledge-bases                              — list KBs
 *   POST   /knowledge-bases                              — create KB
 *   GET    /knowledge-bases/:id                          — get one KB
 *   PATCH  /knowledge-bases/:id                          — update KB
 *   PATCH  /knowledge-bases/:id/archive                  — soft-archive
 *   PATCH  /knowledge-bases/:id/unarchive                — restore
 *   GET    /knowledge-bases/:id/access-policies          — list grants
 *   POST   /knowledge-bases/:id/access-policies          — grant access
 *   DELETE /knowledge-bases/:id/access-policies/:role/:permission
 *                                                        — revoke access
 *
 * Document upload + chunking + embedding + retrieval ship in PR2/PR3.
 */

import express from 'express';
import multer from 'multer';

import { validateFileContent } from '../../../middleware/uploadMiddleware.js';
import { success } from '../../../utils/responseHelper.js';
import {
  archiveKnowledgeBase,
  createKnowledgeBase,
  getKnowledgeBase,
  grantAccess,
  listAccessPolicies,
  listKnowledgeBases,
  revokeAccess,
  unarchiveKnowledgeBase,
  updateKnowledgeBase,
} from '../../../services/ai/knowledgeBaseService.js';
import {
  createInlineDocument,
  decideKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  reindexDocument,
  uploadDocument,
} from '../../../services/ai/knowledgeDocumentService.js';
import {
  listRetrievalLogs,
  retrieveFromKnowledgeBases,
} from '../../../services/ai/knowledgeRetrievalService.js';
import { logClinicalAiAudit } from './audit.js';

const KB_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/rtf',
  'application/json',
  'application/fhir+json',
]);

const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
    fields: 12,
    fieldSize: 64 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!KB_DOCUMENT_MIME_TYPES.has(mimeType)) {
      cb(new Error(`Knowledge base upload does not support ${mimeType}`));
      return;
    }
    cb(null, true);
  },
});

// Declared MIME types the shared magic-byte validator (validateFileContent)
// cannot positively recognise but the KB document pipeline legitimately
// supports. These are text-based formats with no fixed binary signature; they
// are still prompt-injection scanned downstream in knowledgeDocumentService.
// `text/*` and `application/fhir+json` already pass the shared validator's
// relaxed allowance, so only bare `application/json` needs the skip here.
const KB_MAGIC_BYTE_EXEMPT_MIME_TYPES = new Set(['application/json']);

// Magic-byte content validation for KB document uploads. Delegates to the
// shared validateFileContent so a spoofed binary (e.g. an executable renamed
// .pdf with an application/pdf Content-Type) is rejected before the text/OCR
// pipeline runs. The shared validator only knows binary signatures + a relaxed
// text family, so we exempt the JSON type it cannot fingerprint to avoid
// rejecting a documented, supported upload format.
function validateKnowledgeUploadContent(req, res, next) {
  const declaredMime = String(req.file?.mimetype || '').toLowerCase().split(';')[0].trim();
  if (KB_MAGIC_BYTE_EXEMPT_MIME_TYPES.has(declaredMime)) return next();
  return validateFileContent(req, res, next);
}

const router = express.Router();

// ---------------------------------------------------------------------------
// KB CRUD
// ---------------------------------------------------------------------------

router.get('/knowledge-bases', async (req, res, next) => {
  try {
    const result = await listKnowledgeBases({
      tenantId: req.tenantId,
      kbType: req.query.kb_type || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Knowledge bases retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/knowledge-bases', async (req, res, next) => {
  try {
    const kb = await createKnowledgeBase({
      tenantId: req.tenantId,
      name: req.body?.name,
      description: req.body?.description || null,
      kbType: req.body?.kb_type || 'general',
      createdBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_BASE_CREATED',
      String(kb.id),
      null,
      { id: kb.id, name: kb.name, kb_type: kb.kb_type },
    );
    return success(res, kb, 'Knowledge base created', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/knowledge-bases/retrieval-logs', async (req, res, next) => {
  try {
    const result = await listRetrievalLogs({
      tenantId: req.tenantId,
      knowledgeBaseId: req.query.knowledge_base_id || null,
      moduleKey: req.query.module_key || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Retrieval logs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/knowledge-bases/:id', async (req, res, next) => {
  try {
    const kb = await getKnowledgeBase({ tenantId: req.tenantId, id: req.params.id });
    return success(res, kb, 'Knowledge base retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/knowledge-bases/:id', async (req, res, next) => {
  try {
    const before = await getKnowledgeBase({ tenantId: req.tenantId, id: req.params.id });
    const kb = await updateKnowledgeBase({
      tenantId: req.tenantId,
      id: req.params.id,
      name: req.body?.name,
      description: req.body?.description,
      kbType: req.body?.kb_type,
      metadata: req.body?.metadata,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_BASE_UPDATED',
      String(kb.id),
      { name: before.name, kb_type: before.kb_type, description: before.description },
      { name: kb.name, kb_type: kb.kb_type, description: kb.description },
    );
    return success(res, kb, 'Knowledge base updated');
  } catch (err) {
    return next(err);
  }
});

router.patch('/knowledge-bases/:id/archive', async (req, res, next) => {
  try {
    const kb = await archiveKnowledgeBase({ tenantId: req.tenantId, id: req.params.id });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_BASE_ARCHIVED',
      String(kb.id),
      { status: 'active' },
      { status: kb.status },
    );
    return success(res, kb, 'Knowledge base archived');
  } catch (err) {
    return next(err);
  }
});

router.patch('/knowledge-bases/:id/unarchive', async (req, res, next) => {
  try {
    const kb = await unarchiveKnowledgeBase({ tenantId: req.tenantId, id: req.params.id });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_BASE_UNARCHIVED',
      String(kb.id),
      { status: 'archived' },
      { status: kb.status },
    );
    return success(res, kb, 'Knowledge base restored');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Access policies
// ---------------------------------------------------------------------------

router.get('/knowledge-bases/:id/access-policies', async (req, res, next) => {
  try {
    const result = await listAccessPolicies({
      tenantId: req.tenantId,
      knowledgeBaseId: req.params.id,
    });
    return success(res, result, 'Knowledge base access policies retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/knowledge-bases/:id/access-policies', async (req, res, next) => {
  try {
    const policy = await grantAccess({
      tenantId: req.tenantId,
      knowledgeBaseId: req.params.id,
      role: req.body?.role,
      permission: req.body?.permission || 'read',
      grantedBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_BASE_ACCESS_GRANTED',
      `${policy.knowledge_base_id}:${policy.role}:${policy.permission}`,
      null,
      policy,
    );
    return success(res, policy, 'Access policy granted', 201);
  } catch (err) {
    return next(err);
  }
});

router.delete('/knowledge-bases/:id/access-policies/:role/:permission', async (req, res, next) => {
  try {
    const policy = await revokeAccess({
      tenantId: req.tenantId,
      knowledgeBaseId: req.params.id,
      role: req.params.role,
      permission: req.params.permission,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_BASE_ACCESS_REVOKED',
      `${policy.knowledge_base_id}:${policy.role}:${policy.permission}`,
      policy,
      null,
    );
    return success(res, policy, 'Access policy revoked');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Documents (PR2)
// ---------------------------------------------------------------------------

router.get('/knowledge-bases/:id/documents', async (req, res, next) => {
  try {
    const result = await listKnowledgeDocuments({
      tenantId: req.tenantId,
      knowledgeBaseId: req.params.id,
      status: req.query.status || null,
      // WS5 B5.5: curation queue filter (?curation_status=pending shows the
      // imported docs awaiting sign-off).
      curationStatus: req.query.curation_status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Knowledge documents retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/knowledge-bases/:id/documents/inline', async (req, res, next) => {
  try {
    const result = await createInlineDocument({
      tenantId: req.tenantId,
      knowledgeBaseId: req.params.id,
      title: req.body?.title,
      rawText: req.body?.raw_text,
      sourceType: req.body?.source_type || 'inline_text',
      uploadedBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_DOCUMENT_INGESTED',
      String(result.document?.id || 'inline'),
      null,
      {
        document_id: result.document?.id,
        knowledge_base_id: result.document?.knowledge_base_id,
        processing_status: result.document?.processing_status,
        chunk_count: result.chunk_count || 0,
        embedded_count: result.embedded_count || 0,
        prompt_injection_verdict: result.document?.prompt_injection_verdict,
      },
    );
    return success(res, result, 'Knowledge document ingested', 201);
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/knowledge-bases/:id/documents',
  (req, res, next) => {
    knowledgeUpload.single('file')(req, res, (err) => {
      if (err) return next(err);
      return next();
    });
  },
  validateKnowledgeUploadContent,
  async (req, res, next) => {
    try {
      const result = await uploadDocument({
        tenantId: req.tenantId,
        knowledgeBaseId: req.params.id,
        file: req.file,
        title: req.body?.title || null,
        uploadedBy: req.user?.uid || null,
        metadata: req.body?.metadata
          ? safeParseJson(req.body.metadata)
          : {},
      });
      await logClinicalAiAudit(
        req,
        'CLINICAL_AI_KNOWLEDGE_DOCUMENT_UPLOADED',
        String(result.document?.id || 'inline'),
        null,
        {
          document_id: result.document?.id,
          knowledge_base_id: result.document?.knowledge_base_id,
          processing_status: result.document?.processing_status,
          chunk_count: result.chunk_count || 0,
          embedded_count: result.embedded_count || 0,
          prompt_injection_verdict: result.document?.prompt_injection_verdict,
          file_name: req.file?.originalname,
        },
      );
      return success(res, result, 'Knowledge document uploaded', 201);
    } catch (err) {
      return next(err);
    }
  },
);

router.get('/knowledge-bases/:id/documents/:documentId', async (req, res, next) => {
  try {
    const document = await getKnowledgeDocument({
      tenantId: req.tenantId,
      documentId: req.params.documentId,
    });
    return success(res, document, 'Knowledge document retrieved');
  } catch (err) {
    return next(err);
  }
});

router.delete('/knowledge-bases/:id/documents/:documentId', async (req, res, next) => {
  try {
    const document = await deleteKnowledgeDocument({
      tenantId: req.tenantId,
      documentId: req.params.documentId,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_DOCUMENT_DELETED',
      String(document.id),
      document,
      null,
    );
    return success(res, document, 'Knowledge document deleted');
  } catch (err) {
    return next(err);
  }
});

router.post('/knowledge-bases/:id/documents/:documentId/reindex', async (req, res, next) => {
  try {
    const result = await reindexDocument({
      tenantId: req.tenantId,
      documentId: req.params.documentId,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_DOCUMENT_REINDEXED',
      String(result.document?.id || req.params.documentId),
      null,
      {
        document_id: result.document?.id,
        chunk_count: result.chunk_count || 0,
        embedded_count: result.embedded_count || 0,
        processing_status: result.document?.processing_status,
      },
    );
    return success(res, result, 'Knowledge document re-indexed', 201);
  } catch (err) {
    return next(err);
  }
});

// WS5 B5.5 — curation sign-off. Mirrors the decide* pattern (reviewer_decision
// + note + clinical-AI audit). Approving an imported (formulary / antibiogram /
// protocol) document makes it retrievable; rejecting suppresses it.
router.patch('/knowledge-bases/:id/documents/:documentId/curation', async (req, res, next) => {
  try {
    const before = await getKnowledgeDocument({
      tenantId: req.tenantId,
      documentId: req.params.documentId,
    });
    const document = await decideKnowledgeDocument({
      tenantId: req.tenantId,
      documentId: req.params.documentId,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_KNOWLEDGE_DOCUMENT_CURATED',
      String(document.id),
      { curation_status: before.curation_status },
      {
        curation_status: document.curation_status,
        reviewed_by: document.reviewed_by,
        reviewed_at: document.reviewed_at,
      },
    );
    return success(res, document, 'Knowledge document curation updated');
  } catch (err) {
    return next(err);
  }
});

function safeParseJson(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Retrieval (PR3) — permission-filtered RAG against a hospital's KBs.
// ---------------------------------------------------------------------------

router.post('/knowledge-bases/retrieve', async (req, res, next) => {
  try {
    const result = await retrieveFromKnowledgeBases({
      tenantId: req.tenantId,
      queryText: req.body?.query || req.body?.q || '',
      // Role defaults to the caller's role; admins can supply role= to
      // simulate retrieval for a different role for testing / audit.
      role: req.body?.role || req.user?.role || null,
      knowledgeBaseId: req.body?.knowledge_base_id || null,
      kbType: req.body?.kb_type || null,
      moduleKey: req.body?.module_key || null,
      retrievedBy: req.user?.uid || null,
      topK: req.body?.top_k,
      minScore: req.body?.min_score,
    });
    return success(res, result, 'Knowledge base retrieval complete');
  } catch (err) {
    return next(err);
  }
});

export default router;
