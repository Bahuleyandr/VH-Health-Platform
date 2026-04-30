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
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  reindexDocument,
  uploadDocument,
} from '../../../services/ai/knowledgeDocumentService.js';
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

function safeParseJson(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export default router;
