// src/routes/pharmacy/wardIndentRoutes.js
//
// Authoritative ward-indent REST surface. This router is alias-mounted below
// /api/v1/pharmacy-orders and /api/v1/pharmacy; every equivalent mutation uses
// the pharmacy-orders path as its durable idempotency identity.

import express from 'express';
import {
  IP_FLOW_ROUTE_ROLES,
  PHARMACY_ROUTE_ROLES,
  PHARMACY_SUPPLY_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import * as ctl from '../../controllers/pharmacy/wardIndentController.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { sanitizeAllBodyStrings } from '../../middleware/sanitizeMiddleware.js';
import { DOCTOR_TIERS } from '../../utils/roleHelpers.js';
import {
  wardIndentCreateGuard,
  wardIndentListGuard,
  wardIndentRowGuard,
} from './wardIndentPatientGuards.js';

const router = express.Router();
const CANONICAL_BASE = '/api/v1/pharmacy-orders/ward-indents';
const REQUEST_ROLES = [...new Set([...IP_FLOW_ROUTE_ROLES, ...PHARMACY_ROUTE_ROLES])];
const READ_ROLES = [...new Set([...REQUEST_ROLES, ...PHARMACY_SUPPLY_ROUTE_ROLES])];
const SUPPLY_ROLES = [...new Set([...PHARMACY_ROUTE_ROLES, ...PHARMACY_SUPPLY_ROUTE_ROLES])];
const SUBSTITUTION_DECISION_ROLES = [...DOCTOR_TIERS];
const WARD_RECEIPT_ROLES = [
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
  'ER_STAFF',
];
const RECONCILIATION_ROLES = [
  'PHARMACY_INCHARGE',
  'NURSING_INCHARGE',
  'IP_INCHARGE',
  'ICU_INCHARGE',
];
const guardIndentRow = wardIndentRowGuard((req) => req.params.id);

function canonicalActionPath(action) {
  return (req) => `${CANONICAL_BASE}/${encodeURIComponent(String(req.params.id))}/${action}`;
}

function mutationGuard(scope, requestPathForIdempotency) {
  return requireIdempotencyKey({
    required: true,
    scope: `ward_indent_${scope}`,
    retainOnServerError: true,
    requestPathForIdempotency,
  });
}

router.use(sanitizeAllBodyStrings);

router.get('/', requireRole(...READ_ROLES), wardIndentListGuard(), ctl.listIndents);
router.get('/:id', requireRole(...READ_ROLES), guardIndentRow, ctl.getIndent);
router.get(
  '/:id/items/:itemId/inventory-candidates',
  requireRole(...READ_ROLES),
  guardIndentRow,
  ctl.listInventoryCandidates,
);
router.post(
  '/',
  requireRole(...REQUEST_ROLES),
  wardIndentCreateGuard(),
  mutationGuard('create', CANONICAL_BASE),
  ctl.createIndent,
);
router.post(
  '/:id/reserve',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('reserve', canonicalActionPath('reserve')),
  ctl.reserveIndent,
);
router.post(
  '/:id/short-supply',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('short_supply', canonicalActionPath('short-supply')),
  ctl.markShortSupply,
);
router.post(
  '/:id/substitutions',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('substitution_propose', canonicalActionPath('substitutions')),
  ctl.proposeSubstitution,
);
router.post(
  '/:id/substitutions/approve',
  requireRole(...SUBSTITUTION_DECISION_ROLES),
  guardIndentRow,
  mutationGuard('substitution_approve', canonicalActionPath('substitutions/approve')),
  ctl.approveSubstitution,
);
router.post(
  '/:id/substitutions/reject',
  requireRole(...SUBSTITUTION_DECISION_ROLES),
  guardIndentRow,
  mutationGuard('substitution_reject', canonicalActionPath('substitutions/reject')),
  ctl.rejectSubstitution,
);
router.post(
  '/:id/approve',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('approve', canonicalActionPath('approve')),
  ctl.approveIndent,
);
router.post(
  '/:id/reject',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('reject', canonicalActionPath('reject')),
  ctl.rejectIndent,
);
router.post(
  '/:id/controlled-handoff',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('controlled_handoff', canonicalActionPath('controlled-handoff')),
  ctl.recordControlledHandoff,
);
router.post(
  '/:id/issue',
  requireRole(...SUPPLY_ROLES),
  guardIndentRow,
  mutationGuard('issue', canonicalActionPath('issue')),
  ctl.issueIndent,
);
router.post(
  '/:id/receive',
  requireRole(...WARD_RECEIPT_ROLES),
  guardIndentRow,
  mutationGuard('receive', canonicalActionPath('receive')),
  ctl.receiveIndent,
);
router.post(
  '/:id/returns',
  requireRole(...WARD_RECEIPT_ROLES),
  guardIndentRow,
  mutationGuard('return_request', canonicalActionPath('returns')),
  ctl.requestReturn,
);
router.post(
  '/:id/discrepancies',
  requireRole(...WARD_RECEIPT_ROLES),
  guardIndentRow,
  mutationGuard('discrepancy', canonicalActionPath('discrepancies')),
  ctl.reportDiscrepancy,
);
router.post(
  '/:id/reconcile',
  requireRole(...RECONCILIATION_ROLES),
  guardIndentRow,
  mutationGuard('reconcile', canonicalActionPath('reconcile')),
  ctl.reconcileIndent,
);
router.post(
  '/:id/cancel',
  requireRole(...REQUEST_ROLES),
  guardIndentRow,
  mutationGuard('cancel', canonicalActionPath('cancel')),
  ctl.cancelIndent,
);
router.post(
  '/:id/close',
  requireRole(...RECONCILIATION_ROLES),
  guardIndentRow,
  mutationGuard('close', canonicalActionPath('close')),
  ctl.closeIndent,
);

export default router;
