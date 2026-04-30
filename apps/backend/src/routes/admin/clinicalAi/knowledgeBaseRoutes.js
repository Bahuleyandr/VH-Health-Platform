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
import { logClinicalAiAudit } from './audit.js';

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

export default router;
