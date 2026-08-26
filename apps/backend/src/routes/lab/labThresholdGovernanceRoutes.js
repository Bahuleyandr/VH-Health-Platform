import { Router } from 'express';

import * as governance from '../../services/lab/labThresholdGovernanceService.js';
import * as reconciliation from '../../services/lab/labThresholdReconciliationService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { error, relayAppError, success } from '../../utils/responseHelper.js';
import { getAuthenticatedActorRoles } from '../../utils/roleHelpers.js';

const router = Router();

const READ_ROLES = new Set([
  'LAB_STAFF',
  'LAB_INCHARGE',
  'PATHOLOGIST',
  'ADMIN',
  'SUPER_ADMIN',
]);
const AUTHOR_ROLES = new Set(['LAB_INCHARGE', 'ADMIN', 'SUPER_ADMIN']);
const APPROVER_ROLES = new Set(['PATHOLOGIST']);
const ACTIVATOR_ROLES = new Set(['SUPER_ADMIN']);
const RECONCILER_ROLES = new Set(['LAB_INCHARGE', 'ADMIN', 'SUPER_ADMIN']);

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Lab threshold governance error');
    }
  };
}

function requireGovernanceRole(allowedRoles, message) {
  return (req, res, next) => {
    const roles = getAuthenticatedActorRoles(req.user);
    if (!roles.some(role => allowedRoles.has(role))) return error(res, message, 403);
    return next();
  };
}

const requireRead = requireGovernanceRole(READ_ROLES, 'Laboratory governance read role required');
const requireAuthor = requireGovernanceRole(AUTHOR_ROLES, 'Laboratory policy author role required');
const requireApprover = requireGovernanceRole(APPROVER_ROLES, 'Pathologist policy approver role required');
const requireActivator = requireGovernanceRole(ACTIVATOR_ROLES, 'Super-admin policy activation role required');
const requireReconciler = requireGovernanceRole(RECONCILER_ROLES, 'Laboratory exception reconciliation role required');

function actor(req) {
  return {
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  };
}

router.get('/threshold-governance/catalog', requireRead, wrap(async (req) =>
  governance.listLabThresholdCatalog({
    tenantId: tenantOf(req),
    facilityId: req.query.facility_id ?? req.query.facilityId,
  })));

router.post('/threshold-governance/catalog', requireAuthor, wrap(async (req) =>
  governance.addLabThresholdCatalogEntry({
    tenantId: tenantOf(req),
    facilityId: req.body.facility_id ?? req.body.facilityId,
    entry: req.body.entry,
    metadata: req.body.metadata,
    ...actor(req),
  })));

router.post('/threshold-governance/catalog/:entryId/retire', requireAuthor, wrap(async (req) =>
  governance.retireLabThresholdCatalogEntry({
    tenantId: tenantOf(req),
    facilityId: req.body.facility_id ?? req.body.facilityId,
    catalogEntryId: req.params.entryId,
    reason: req.body.reason,
    ...actor(req),
  })));

router.get('/threshold-governance/bundles', requireRead, wrap(async (req) =>
  governance.listLabThresholdPolicyBundles({
    tenantId: tenantOf(req),
    facilityId: req.query.facility_id ?? req.query.facilityId,
    lifecycleStatus: req.query.lifecycle_status ?? req.query.lifecycleStatus,
    limit: req.query.limit,
  })));

router.post('/threshold-governance/bundles', requireAuthor, wrap(async (req) =>
  governance.createLabThresholdPolicyBundle({
    tenantId: tenantOf(req),
    facilityId: req.body.facility_id ?? req.body.facilityId,
    metadata: req.body.metadata,
    ...actor(req),
  })));

router.put('/threshold-governance/bundles/:bundleId/rules', requireAuthor, wrap(async (req) =>
  governance.replaceLabThresholdPolicyRules({
    tenantId: tenantOf(req),
    bundleId: req.params.bundleId,
    rules: req.body.rules,
    ...actor(req),
  })));

router.get('/threshold-governance/bundles/:bundleId/coverage', requireRead, wrap(async (req) =>
  governance.getLabThresholdPolicyCoverage({
    tenantId: tenantOf(req),
    bundleId: req.params.bundleId,
  })));

router.post('/threshold-governance/bundles/:bundleId/submit', requireAuthor, wrap(async (req) =>
  governance.submitLabThresholdPolicyBundle({
    tenantId: tenantOf(req),
    bundleId: req.params.bundleId,
    sourceReference: req.body.source_reference ?? req.body.sourceReference,
    effectiveFrom: req.body.effective_from ?? req.body.effectiveFrom,
    effectiveUntil: req.body.effective_until ?? req.body.effectiveUntil,
    ...actor(req),
  })));

router.post('/threshold-governance/bundles/:bundleId/approve', requireApprover, wrap(async (req) =>
  governance.approveLabThresholdPolicyBundle({
    tenantId: tenantOf(req),
    bundleId: req.params.bundleId,
    reason: req.body.reason,
    evidenceReference: req.body.evidence_reference ?? req.body.evidenceReference,
    evidenceSha256: req.body.evidence_sha256 ?? req.body.evidenceSha256,
    ...actor(req),
  })));

router.post('/threshold-governance/bundles/:bundleId/reject', requireApprover, wrap(async (req) =>
  governance.rejectLabThresholdPolicyBundle({
    tenantId: tenantOf(req),
    bundleId: req.params.bundleId,
    reason: req.body.reason,
    ...actor(req),
  })));

router.post('/threshold-governance/bundles/:bundleId/activate', requireActivator, wrap(async (req) =>
  governance.activateLabThresholdPolicyBundle({
    tenantId: tenantOf(req),
    bundleId: req.params.bundleId,
    reason: req.body.reason,
    ...actor(req),
  })));

router.get('/threshold-governance/exceptions', requireRead, wrap(async (req) =>
  reconciliation.listLabThresholdExceptions({
    tenantId: tenantOf(req),
    lifecycleStatus: req.query.lifecycle_status ?? req.query.lifecycleStatus ?? 'open',
    facilityId: req.query.facility_id ?? req.query.facilityId,
    unmatchedReason: req.query.unmatched_reason ?? req.query.unmatchedReason,
    limit: req.query.limit,
  })));

router.get('/threshold-governance/exceptions/:exceptionId', requireRead, wrap(async (req) =>
  reconciliation.getLabThresholdException({
    tenantId: tenantOf(req),
    exceptionId: req.params.exceptionId,
  })));

router.post('/threshold-governance/exceptions/:exceptionId/reconcile', requireReconciler, wrap(async (req) =>
  reconciliation.reconcileLabThresholdException({
    tenantId: tenantOf(req),
    exceptionId: req.params.exceptionId,
    source: 'lab_threshold_exception_manual_reconciliation',
    ...actor(req),
  })));

export default router;
