import { Router } from 'express';

import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  approveSubstitutionFundingProposal,
  createSubstitutionFundingProposal,
  SUBSTITUTION_FUNDING_APPROVER_ROLES,
  SUBSTITUTION_FUNDING_PROPOSER_ROLES,
} from '../../services/pharmacy/substitutionFundingReauthorisationService.js';
import { AppError } from '../../utils/AppError.js';
import { error, relayAppError, success } from '../../utils/responseHelper.js';

export const pharmacySubstitutionFundingProposalRoutes = Router({ mergeParams: true });
export const pharmacySubstitutionFundingApprovalRoutes = Router({ mergeParams: true });
export const SUBSTITUTION_FUNDING_PROPOSAL_HOST_ROLES = [
  ...SUBSTITUTION_FUNDING_PROPOSER_ROLES,
];
export const SUBSTITUTION_FUNDING_APPROVAL_HOST_ROLES = [
  ...SUBSTITUTION_FUNDING_APPROVER_ROLES,
];

function requireSubstitutionFundingRole(allowedRoles, message) {
  return (req, res, next) => {
    const role = String(req.user?.role || req.user?.rawRole || '').trim().toUpperCase();
    if (!allowedRoles.includes(role)) {
      return error(res, message, 403);
    }
    return next();
  };
}

const requireProposer = requireSubstitutionFundingRole(
  SUBSTITUTION_FUNDING_PROPOSAL_HOST_ROLES,
  'Pharmacy dispensing role required',
);
const requireApprover = requireSubstitutionFundingRole(
  SUBSTITUTION_FUNDING_APPROVAL_HOST_ROLES,
  'Finance or insurance funding authority required',
);

function canonicalProposalPath(req) {
  return `/api/v1/pharmacy-orders/orders/${encodeURIComponent(
    String(req.params.orderId),
  )}/substitution-funding/proposals`;
}

function canonicalApprovalPath(req) {
  return `${canonicalProposalPath(req)}/${encodeURIComponent(
    String(req.params.approvalId),
  )}/approve`;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      return success(res, await handler(req));
    } catch (err) {
      return relayAppError(res, err, 'Substitution funding reauthorisation error');
    }
  };
}

function requireEmptyApprovalBody(req, res, next) {
  const fields = Object.keys(req.body || {});
  if (fields.length) {
    return relayAppError(res, AppError.badRequest(
      'The approval actor and funding authority are server-derived',
      'SUBSTITUTION_FUNDING_APPROVAL_CALLER_AUTHORITY_FORBIDDEN',
      { forbidden_fields: fields.sort() },
    ), 'Substitution funding reauthorisation error');
  }
  return next();
}

pharmacySubstitutionFundingProposalRoutes.post(
  '/',
  requireProposer,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_substitution_funding_proposal',
    retainOnServerError: true,
    durableDomainReceipt: true,
    revalidateCompletedReplay: true,
    requestPathForIdempotency: canonicalProposalPath,
  }),
  wrap((req) => createSubstitutionFundingProposal({
    tenantId: req.tenantId,
    orderId: req.params.orderId,
    selector: req.body || {},
    proposerUid: req.user?.uid,
    proposerRole: req.user?.role || req.user?.rawRole || null,
    idempotencyKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
  })),
);

pharmacySubstitutionFundingApprovalRoutes.post(
  '/',
  requireApprover,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_substitution_funding_approval',
    retainOnServerError: true,
    durableDomainReceipt: true,
    requestPathForIdempotency: canonicalApprovalPath,
  }),
  requireEmptyApprovalBody,
  wrap((req) => approveSubstitutionFundingProposal({
    tenantId: req.tenantId,
    orderId: req.params.orderId,
    approvalId: req.params.approvalId,
    approverUid: req.user?.uid,
    approverRole: req.user?.role || req.user?.rawRole || null,
  })),
);
