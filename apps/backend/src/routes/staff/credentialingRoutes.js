// src/routes/staff/credentialingRoutes.js
//
// Roadmap D3 — credential/privilege registry. Mounted at
// /api/v1/credentials (app.js). HR/admin manage; clinical surfaces read
// the privilege check.

import express from 'express';
import { upload, validateFileContent, validateGenericDocumentUpload } from '../../middleware/uploadMiddleware.js';
import {
  addCredential,
  acknowledgeCredentialExpiryAlert,
  decidePrivilegeApproval,
  listCredentials,
  listCredentialExpiryAlerts,
  updateCredentialStatus,
  listExpiring,
  listPrivilegeApprovals,
  listPrivilegeCatalog,
  requestPrivilegeGrant,
  scanCredentialExpiryAlerts,
  hasActivePrivilege,
  uploadCredentialDocument,
  upsertPrivilegeCatalog,
} from '../../services/staff/credentialingService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { ROLES, isAdmin, isLeadership } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = express.Router();

const canManage = (role) => isAdmin(role) || isLeadership(role) || role === ROLES.HR_STAFF || role === 'SUPER_ADMIN';
const canApprove = (role) => isAdmin(role) || isLeadership(role) || role === 'SUPER_ADMIN';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.post('/', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership manage credentials', HTTP_STATUS.FORBIDDEN);
    const credential = await addCredential({
      staffUid: req.body.staff_uid,
      credentialType: req.body.credential_type,
      name: req.body.name,
      issuingBody: req.body.issuing_body || null,
      registrationNumber: req.body.registration_number || null,
      validFrom: req.body.valid_from || null,
      validUntil: req.body.valid_until || null,
      documentRef: req.body.document_ref || null,
      notes: req.body.notes || null,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { credential }, 'Credential recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record credential');
  }
});

router.get('/catalog', async (req, res) => {
  try {
    const result = await listPrivilegeCatalog({
      tenantId: tenantOf(req),
      status: req.query.status || null,
      q: req.query.q || null,
    });
    return success(res, result, 'Privilege catalog');
  } catch (err) {
    return handleFailure(res, err, 'list privilege catalog');
  }
});

router.put('/catalog', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership manage the privilege catalog', HTTP_STATUS.FORBIDDEN);
    const b = req.body || {};
    const catalog = await upsertPrivilegeCatalog({
      tenantId: tenantOf(req),
      id: b.id,
      privilegeKey: b.privilege_key,
      displayName: b.display_name,
      description: b.description,
      requiredCredentialTypes: b.required_credential_types,
      reviewCadenceDays: b.review_cadence_days,
      enforcementScope: b.enforcement_scope,
      status: b.status,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, { catalog }, 'Privilege catalog saved');
  } catch (err) {
    return handleFailure(res, err, 'save privilege catalog');
  }
});

router.post('/privilege-requests', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership request privilege grants', HTTP_STATUS.FORBIDDEN);
    const b = req.body || {};
    const result = await requestPrivilegeGrant({
      staffUid: b.staff_uid,
      privilegeCatalogId: b.privilege_catalog_id,
      privilege: b.privilege || b.name,
      issuingBody: b.issuing_body,
      registrationNumber: b.registration_number,
      validFrom: b.valid_from,
      validUntil: b.valid_until,
      documentRef: b.document_ref,
      notes: b.notes,
      metadata: b.metadata,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, result, 'Privilege grant requested', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'request privilege grant');
  }
});

router.get('/approvals', async (req, res) => {
  try {
    const result = await listPrivilegeApprovals({
      tenantId: tenantOf(req),
      status: req.query.status || 'pending',
      limit: req.query.limit,
    });
    return success(res, result, 'Privilege approvals');
  } catch (err) {
    return handleFailure(res, err, 'list privilege approvals');
  }
});

router.post('/approvals/:id/decide', async (req, res) => {
  try {
    if (!canApprove(req.user?.role)) return error(res, 'Only admin/leadership approve privilege grants', HTTP_STATUS.FORBIDDEN);
    const result = await decidePrivilegeApproval({
      approvalId: req.params.id,
      decision: req.body?.decision,
      reason: req.body?.reason || null,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, result, 'Privilege approval decided');
  } catch (err) {
    return handleFailure(res, err, 'decide privilege approval');
  }
});

router.get('/staff/:staffUid', async (req, res) => {
  try {
    const credentials = await listCredentials(req.params.staffUid, {
      type: req.query.type || null,
      tenantId: tenantOf(req),
    });
    return success(res, { credentials, count: credentials.length }, 'Staff credentials');
  } catch (err) {
    return handleFailure(res, err, 'list credentials');
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership manage credentials', HTTP_STATUS.FORBIDDEN);
    const credential = await updateCredentialStatus(req.params.id, {
      status: req.body.status, notes: req.body.notes || null, tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { credential }, 'Credential status updated');
  } catch (err) {
    return handleFailure(res, err, 'update credential');
  }
});

router.post('/:id/document', upload.single('file'), validateFileContent, validateGenericDocumentUpload, async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership upload credential documents', HTTP_STATUS.FORBIDDEN);
    const document = await uploadCredentialDocument({
      credentialId: req.params.id,
      file: req.file,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { document }, 'Credential document uploaded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'upload credential document');
  }
});

router.get('/expiring', async (req, res) => {
  try {
    const credentials = await listExpiring({ days: req.query.days, tenantId: tenantOf(req) });
    return success(res, { credentials, count: credentials.length }, 'Expiring credentials');
  } catch (err) {
    return handleFailure(res, err, 'list expiring credentials');
  }
});

router.post('/expiry-alerts/scan', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership scan credential expiry alerts', HTTP_STATUS.FORBIDDEN);
    const result = await scanCredentialExpiryAlerts({
      days: req.body?.days || req.body?.lookahead_days || 60,
      tenantId: tenantOf(req),
    });
    return success(res, result, 'Credential expiry alerts refreshed');
  } catch (err) {
    return handleFailure(res, err, 'scan credential expiry alerts');
  }
});

router.get('/expiry-alerts', async (req, res) => {
  try {
    const result = await listCredentialExpiryAlerts({
      tenantId: tenantOf(req),
      status: req.query.status || 'open',
      severity: req.query.severity || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Credential expiry alerts');
  } catch (err) {
    return handleFailure(res, err, 'list credential expiry alerts');
  }
});

router.patch('/expiry-alerts/:id/acknowledge', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership acknowledge credential alerts', HTTP_STATUS.FORBIDDEN);
    const alert = await acknowledgeCredentialExpiryAlert({
      tenantId: tenantOf(req),
      id: req.params.id,
      acknowledgedBy: req.user?.uid || null,
      resolution: req.body?.resolution || null,
    });
    return success(res, { alert }, 'Credential expiry alert acknowledged');
  } catch (err) {
    return handleFailure(res, err, 'acknowledge credential expiry alert');
  }
});

// The gate clinical surfaces call (e.g. chemo administration, OT booking).
router.get('/check', async (req, res) => {
  try {
    const verdict = await hasActivePrivilege(req.query.staff_uid, req.query.privilege, {
      tenantId: tenantOf(req),
    });
    return success(res, verdict, verdict.allowed ? 'Privilege held' : 'Privilege not held');
  } catch (err) {
    return handleFailure(res, err, 'check privilege');
  }
});

export default router;
