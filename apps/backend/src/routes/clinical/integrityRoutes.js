// src/routes/clinical/integrityRoutes.js
//
// Roadmap C4 — document integrity surface. Mounted at /api/v1/integrity
// behind the clinical-staff gate + PHI logger (app.js).
//   POST /sign                              — sign a document (doctors/admin)
//   GET  /signatures/:id/verify             — recompute + compare content hash
//   GET  /signatures/:documentType/:id      — signatures on a document
//   GET  /audit-chain/verify                — admin: verify the hash chain

import express from 'express';
import logger from '../../logging/logger.js';
import {
  signDocument,
  verifyDocumentSignature,
  listDocumentSignatures,
  verifyAuditChain,
} from '../../services/clinical/documentIntegrityService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canSign = (role) => isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Integrity ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.post('/sign', async (req, res) => {
  try {
    if (!canSign(req.user?.role)) {
      return error(res, 'Only doctors or admins can sign documents', HTTP_STATUS.FORBIDDEN);
    }
    const signature = await signDocument({
      documentType: req.body.document_type,
      documentId: req.body.document_id,
      statement: req.body.statement || null,
      method: req.body.signature_method || 'electronic_attestation',
      esignTxnRef: req.body.esign_txn_ref || null,
      certificateRef: req.body.certificate_ref || null,
    }, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      actorName: req.user?.name || null,
    });
    return success(res, { signature }, 'Document signed', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'sign document');
  }
});

router.get('/signatures/:id/verify', async (req, res) => {
  try {
    const verdict = await verifyDocumentSignature(req.params.id);
    return success(res, verdict, verdict.intact ? 'Signature intact' : 'DOCUMENT CHANGED SINCE SIGNATURE');
  } catch (err) {
    return handleFailure(res, err, 'verify signature');
  }
});

router.get('/signatures/:documentType/:documentId', async (req, res) => {
  try {
    const signatures = await listDocumentSignatures(req.params.documentType, req.params.documentId);
    return success(res, { signatures, count: signatures.length }, 'Document signatures');
  } catch (err) {
    return handleFailure(res, err, 'list signatures');
  }
});

router.get('/audit-chain/verify', async (req, res) => {
  try {
    if (!isAdmin(req.user?.role) && req.user?.role !== 'SUPER_ADMIN') {
      return error(res, 'Only admins can verify the audit chain', HTTP_STATUS.FORBIDDEN);
    }
    const result = await verifyAuditChain({
      tenantId: req.query.tenant_id || '00000000-0000-4000-8000-000000000001',
      limit: req.query.limit || null,
    });
    return success(res, result, result.intact ? 'Audit chain intact' : 'AUDIT CHAIN BREAK DETECTED');
  } catch (err) {
    return handleFailure(res, err, 'verify audit chain');
  }
});

export default router;
