// src/routes/ipd/ipdSupportRoutes.js
//
// IPD support subsystem routes (architectural item A4 / migration 174):
//   - /admissions/:id/advance-deposits             collect, list, refund
//   - /admissions/:id/attendant-passes             list, replace, revoke
//   - /ward-indents                                request, approve, reject, issue, receive, list
//
// Mounted under /api/v1/ipd. The app.js mount gates the whole namespace
// on the broad IPD_SUPPORT_ROUTE_ROLES union (billing + ip_flow +
// pharmacy + front desk); the per-route requireRole guards below
// re-narrow each operation to the roles that own it — the same
// re-narrowing pattern bedManagementRoutes uses under the widened
// /api/v1/beds mount, and the same segregation-of-duties model as
// billingV2Routes (money-OUT stricter than money-IN).
//
// We import ipdSupportService as a default-namespace and call its named
// methods (`ipdSupportService.X`) — both rules below would otherwise
// warn on every callsite. The pattern is correct (service exports both
// named + a default object).
/* eslint-disable import/no-named-as-default-member */

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import ipdSupportService from '../../services/ipd/ipdSupportService.js';
import { wrapAsync } from '../../config/routeWrapper.js';
import { success, error } from '../../utils/responseHelper.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { enforceStaffClinicalWriteDevicePosture } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { sanitizeAllBodyStrings } from '../../middleware/sanitizeMiddleware.js';
import {
  BILLING_ROUTE_ROLES,
  IP_FLOW_ROUTE_ROLES,
  PHARMACY_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import { DOCTOR_TIERS } from '../../utils/roleHelpers.js';
import { normalizeRole } from '../../utils/roles.js';
import {
  wardIndentAdmissionGuard,
  wardIndentCreateGuard,
  wardIndentListGuard,
  wardIndentRowGuard,
} from '../pharmacy/wardIndentPatientGuards.js';
import {
  WARD_INDENT_CONTROLLED_HANDOFF_ROLES,
  wardControlledHandoffEvidenceGuard,
} from '../pharmacy/wardIndentRoutes.js';

const router = express.Router();

// ── Per-operation role sets (B-M4) ───────────────────────────────────
//
// Money-IN (deposit collection): billing roles plus the front-desk /
// admission-desk staff who take advances at admit time — mirrors
// billingV2's requireStaffOrAdmin + BILLING_V2_EXTRA_STAFF_ROLES surface.
const DEPOSIT_COLLECT_ROLES = [...new Set([
  ...BILLING_ROUTE_ROLES,
  'RECEPTIONIST',
  'ADMISSION_OFFICER',
  'IPD_COUNSELLOR',
])];

// Money-OUT (refund payout): finance/cashier roles + admin only —
// byte-for-byte the BILLING_CASH_OUT_ROLES segregation-of-duties set in
// billingV2Routes.js ("cash-out paths reachable by non-finance staff").
// CASHIER is kept for parity with that set even though the current
// app.js mount union does not include it (harmless if the union widens).
const DEPOSIT_REFUND_ROLES = [
  'ADMIN', 'SUPER_ADMIN',
  'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'BILLING_STAFF', 'CASHIER',
];

// Attendant passes (replacement issue / revoke): admission-desk and ward
// leadership own the pass lifecycle; porters/pharmacy/billing do not.
const ATTENDANT_PASS_ROLES = [
  'ADMIN', 'SUPER_ADMIN',
  'ADMISSION_OFFICER', 'RECEPTIONIST',
  'NURSING_INCHARGE', 'IP_INCHARGE',
];

// Ward indents: the ward (nursing/clinical) side requests and receives
// (pharmacy may also raise replenishment indents — parity with the
// /api/v1/pharmacy/ward-indents surface); only the pharmacy side
// approves, rejects, and issues stock (the stock-decrement step).
const WARD_INDENT_REQUEST_ROLES = [...new Set([
  ...IP_FLOW_ROUTE_ROLES,
  ...PHARMACY_ROUTE_ROLES,
])];
const WARD_INDENT_READ_ROLES = [...new Set([
  ...WARD_INDENT_REQUEST_ROLES,
])];
const WARD_INDENT_SUPPLY_ROLES = [...new Set([
  ...PHARMACY_ROUTE_ROLES,
])];
const WARD_INDENT_SUBSTITUTION_DECISION_ROLES = [...DOCTOR_TIERS];
const WARD_INDENT_RECEIPT_ROLES = [
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
];
const WARD_INDENT_RECONCILIATION_ROLES = [
  'PHARMACY_INCHARGE',
  'NURSING_INCHARGE',
  'IP_INCHARGE',
  'ICU_INCHARGE',
];
const WARD_INDENT_CANONICAL_BASE = '/api/v1/pharmacy-orders/ward-indents';
const PG_INT4_MAX = 2147483647;
const guardWardIndentRow = wardIndentRowGuard((req) => req.params.indentId);

function wardIndentIdempotency(scope, action = null) {
  return [
    enforceStaffClinicalWriteDevicePosture,
    requireIdempotencyKey({
      required: true,
      scope: `ward_indent_${scope}`,
      retainOnServerError: true,
      requestPathForIdempotency: action
        ? (req) => `${WARD_INDENT_CANONICAL_BASE}/${encodeURIComponent(
            String(req.params.indentId),
          )}/${action}`
        : WARD_INDENT_CANONICAL_BASE,
    }),
  ];
}

function wardIndentMutationContext(req) {
  return {
    expectedVersion: req.body?.expected_version ?? req.body?.state_version ?? null,
    commandKey: req.get('idempotency-key') || null,
    tenantId: tenantOf(req),
  };
}

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function actorRoleCodesOf(req) {
  return [...new Set(
    [req.user?.role, req.user?.rawRole]
      .map(normalizeRole)
      .filter(Boolean),
  )];
}

function requireIntParam(value, fieldName) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const n = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isInteger(n) || n > PG_INT4_MAX) {
    const err = new Error(`${fieldName} must be a positive integer`);
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }
  return n;
}

// ── Advance deposits ─────────────────────────────────────────────────

router.post(
  '/admissions/:id/advance-deposits',
  requireRole(...DEPOSIT_COLLECT_ROLES),
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const { amount, payment_method, payment_reference, purpose, notes } = req.body ?? {};
    const deposit = await ipdSupportService.collectAdvanceDeposit({
      admissionId,
      amount,
      paymentMethod: payment_method,
      paymentReference: payment_reference ?? null,
      purpose: purpose ?? 'admission_advance',
      notes: notes ?? null,
      collectedBy: req.user?.uid,
      tenantId: tenantOf(req),
    });
    success(res, { deposit }, `Advance deposit ${deposit.receipt_number} collected`, HTTP_STATUS.CREATED);
  })
);

router.get(
  '/admissions/:id/advance-deposits',
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const [deposits, balance] = await Promise.all([
      ipdSupportService.listAdmissionDeposits(admissionId, { tenantId: tenantOf(req) }),
      ipdSupportService.getAdmissionDepositBalance(admissionId, { tenantId: tenantOf(req) }),
    ]);
    success(res, { deposits, balance }, 'Advance deposits retrieved');
  })
);

router.post(
  '/advance-deposits/:depositId/refund',
  requireRole(...DEPOSIT_REFUND_ROLES),
  wrapAsync(async (req, res) => {
    const parentDepositId = requireIntParam(req.params.depositId, 'depositId');
    const { refund_amount, payment_method, payment_reference, notes } = req.body ?? {};
    const refund = await ipdSupportService.refundAdvanceDeposit({
      parentDepositId,
      refundAmount: refund_amount,
      paymentMethod: payment_method,
      paymentReference: payment_reference ?? null,
      notes: notes ?? null,
      refundedBy: req.user?.uid,
      tenantId: tenantOf(req),
    });
    success(res, { refund }, `Refund ${refund.receipt_number} processed`, HTTP_STATUS.CREATED);
  })
);

// ── Attendant passes ─────────────────────────────────────────────────

router.get(
  '/admissions/:id/attendant-passes',
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const passes = await ipdSupportService.listAdmissionPasses(admissionId, { tenantId: tenantOf(req) });
    success(res, { passes }, 'Attendant passes retrieved');
  })
);

router.post(
  '/admissions/:id/attendant-passes/replacement',
  requireRole(...ATTENDANT_PASS_ROLES),
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const { patient_uid, patient_name, ward_id, ward_name, notes } = req.body ?? {};
    if (!patient_uid) return error(res, 'patient_uid is required', HTTP_STATUS.BAD_REQUEST);
    const pass = await ipdSupportService.issueReplacementAttendantPass({
      admissionId,
      patientUid: patient_uid,
      patientName: patient_name ?? null,
      wardId: ward_id ?? null,
      wardName: ward_name ?? null,
      issuedBy: req.user?.uid,
      notes: notes ?? null,
      tenantId: tenantOf(req),
    });
    success(res, { pass }, `Replacement pass ${pass.pass_number} issued`, HTTP_STATUS.CREATED);
  })
);

router.post(
  '/attendant-passes/:passId/revoke',
  requireRole(...ATTENDANT_PASS_ROLES),
  wrapAsync(async (req, res) => {
    const passId = requireIntParam(req.params.passId, 'passId');
    const { reason } = req.body ?? {};
    const pass = await ipdSupportService.revokeAttendantPass({
      passId,
      revokedBy: req.user?.uid,
      reason: reason ?? null,
      tenantId: tenantOf(req),
    });
    success(res, { pass }, 'Pass revoked');
  })
);

// ── Ward indents ─────────────────────────────────────────────────────

router.use('/ward-indents', sanitizeAllBodyStrings);

router.post(
  '/ward-indents',
  requireRole(...WARD_INDENT_REQUEST_ROLES),
  wardIndentCreateGuard(),
  wardIndentIdempotency('create'),
  wrapAsync(async (req, res) => {
    const { ward_id, admission_id, encounter_id, patient_uid, indent_type, items, notes } = req.body ?? {};
    const indent = await ipdSupportService.createWardIndent({
      wardId: ward_id == null ? null : requireIntParam(ward_id, 'ward_id'),
      admissionId: admission_id == null ? null : requireIntParam(admission_id, 'admission_id'),
      encounterId: encounter_id ?? null,
      patientUid: patient_uid ?? null,
      indentType: indent_type ?? 'pharmacy',
      items,
      notes: notes ?? null,
      requestedBy: req.user?.uid,
      commandKey: req.get('idempotency-key'),
      tenantId: tenantOf(req),
    });
    success(res, { indent }, `Ward indent ${indent.indent_number} created`, HTTP_STATUS.CREATED);
  }),
);

router.get(
  '/ward-indents',
  requireRole(...WARD_INDENT_READ_ROLES),
  wardIndentListGuard(),
  wrapAsync(async (req, res) => {
    const {
      ward_id,
      status,
      admission_id,
      patient_uid,
      overdue_only,
      worklist,
      before_requested_at,
      before_id,
      limit,
    } = req.query ?? {};
    const page = await ipdSupportService.listWardIndentPage({
      wardId: ward_id ? requireIntParam(ward_id, 'ward_id') : null,
      status: status ?? null,
      admissionId: admission_id ? requireIntParam(admission_id, 'admission_id') : null,
      patientUid: patient_uid ?? null,
      overdueOnly: ['1', 'true'].includes(String(overdue_only || '').toLowerCase()),
      worklist: worklist ?? null,
      beforeRequestedAt: before_requested_at ?? null,
      beforeId: before_id == null ? null : requireIntParam(before_id, 'before_id'),
      actorRoleCodes: actorRoleCodesOf(req),
      limit: limit ? Number.parseInt(limit, 10) : 50,
      tenantId: tenantOf(req),
    });
    success(
      res,
      { indents: page.items },
      'Ward indents retrieved',
      HTTP_STATUS.OK,
      { pagination: page.pagination },
    );
  }),
);

router.get(
  '/admissions/:id/ward-indents',
  requireRole(...WARD_INDENT_READ_ROLES),
  wardIndentAdmissionGuard((req) => req.params.id),
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const {
      status,
      overdue_only,
      worklist,
      before_requested_at,
      before_id,
      limit,
    } = req.query ?? {};
    const page = await ipdSupportService.listWardIndentPage({
      admissionId,
      status: status ?? null,
      overdueOnly: ['1', 'true'].includes(String(overdue_only || '').toLowerCase()),
      worklist: worklist ?? null,
      beforeRequestedAt: before_requested_at ?? null,
      beforeId: before_id == null ? null : requireIntParam(before_id, 'before_id'),
      actorRoleCodes: actorRoleCodesOf(req),
      limit: limit ? Number.parseInt(limit, 10) : 50,
      tenantId: tenantOf(req),
    });
    success(
      res,
      { indents: page.items },
      'Ward indents for admission retrieved',
      HTTP_STATUS.OK,
      { pagination: page.pagination },
    );
  }),
);

router.get(
  '/ward-indents/:indentId',
  requireRole(...WARD_INDENT_READ_ROLES),
  guardWardIndentRow,
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.getWardIndent(indentId, {
      tenantId: tenantOf(req),
      eventLimit: req.query.event_limit ? Number(req.query.event_limit) : 100,
    });
    if (!indent) return error(res, 'Ward indent not found', HTTP_STATUS.NOT_FOUND);
    return success(res, { indent }, 'Ward indent retrieved');
  }),
);

router.get(
  '/ward-indents/:indentId/items/:itemId/inventory-candidates',
  requireRole(...WARD_INDENT_READ_ROLES),
  guardWardIndentRow,
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const itemId = requireIntParam(req.params.itemId, 'itemId');
    const candidates = await ipdSupportService.listWardIndentInventoryCandidates(
      itemId,
      {
        tenantId: tenantOf(req),
        wardIndentId: indentId,
      },
    );
    return success(
      res,
      { item: candidates.item, candidates: candidates.candidates },
      'Ward indent inventory candidates retrieved',
    );
  }),
);

router.post(
  '/ward-indents/:indentId/reserve',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('reserve', 'reserve'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.reserveWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      reservedBy: req.user?.uid,
      itemQuantitiesReserved: req.body?.item_quantities_reserved ?? req.body?.items ?? null,
      inventorySelections: req.body?.inventory_selections ?? null,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent reserved');
  }),
);

router.post(
  '/ward-indents/:indentId/short-supply',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('short_supply', 'short-supply'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.markWardIndentShortSupply({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      markedBy: req.user?.uid,
      reason: req.body?.reason ?? req.body?.short_supply_reason,
      itemQuantitiesAvailable: req.body?.item_quantities_available ?? req.body?.items ?? null,
      inventorySelections: req.body?.inventory_selections ?? null,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent short supply recorded');
  }),
);

router.post(
  '/ward-indents/:indentId/substitutions',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('substitution_propose', 'substitutions'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.proposeWardIndentSubstitution({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      proposedBy: req.user?.uid,
      substitutions: req.body?.substitutions,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent substitution proposed');
  }),
);

router.post(
  '/ward-indents/:indentId/substitutions/approve',
  requireRole(...WARD_INDENT_SUBSTITUTION_DECISION_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('substitution_approve', 'substitutions/approve'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.approveWardIndentSubstitution({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      decidedBy: req.user?.uid,
      inventorySelections: req.body?.inventory_selections ?? null,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent substitution approved');
  }),
);

router.post(
  '/ward-indents/:indentId/substitutions/reject',
  requireRole(...WARD_INDENT_SUBSTITUTION_DECISION_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('substitution_reject', 'substitutions/reject'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.rejectWardIndentSubstitution({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      decidedBy: req.user?.uid,
      reason: req.body?.reason,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent substitution rejected');
  }),
);

router.post(
  '/ward-indents/:indentId/approve',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('approve', 'approve'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.approveWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      approvedBy: req.user?.uid,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent approved');
  }),
);

router.post(
  '/ward-indents/:indentId/reject',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('reject', 'reject'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.rejectWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      rejectedBy: req.user?.uid,
      reason: req.body?.reason,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent rejected');
  }),
);

router.post(
  '/ward-indents/:indentId/controlled-handoff',
  requireRole(...WARD_INDENT_CONTROLLED_HANDOFF_ROLES),
  guardWardIndentRow,
  wardControlledHandoffEvidenceGuard,
  wardIndentIdempotency('controlled_handoff', 'controlled-handoff'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.recordWardIndentControlledHandoff({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      recordedBy: req.user?.uid,
      itemEvidence: req.body?.item_evidence,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent controlled-drug handoff recorded');
  }),
);

router.post(
  '/ward-indents/:indentId/issue',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('issue', 'issue'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.issueWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      issuedBy: req.user?.uid,
      itemQuantitiesIssued: req.body?.item_quantities_issued ?? req.body?.items ?? null,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent issued');
  }),
);

router.post(
  '/ward-indents/:indentId/receive',
  requireRole(...WARD_INDENT_RECEIPT_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('receive', 'receive'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.receiveWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      receivedBy: req.user?.uid,
      itemQuantitiesReceived: req.body?.item_quantities_received ?? req.body?.items ?? null,
      substitutionAcknowledgements: req.body?.substitution_acknowledgements ?? null,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent receipt recorded');
  }),
);

router.post(
  '/ward-indents/:indentId/returns',
  requireRole(...WARD_INDENT_RECEIPT_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('return_request', 'returns'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.requestWardIndentReturn({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      requestedBy: req.user?.uid,
      itemQuantitiesReturned: req.body?.item_quantities_returned ?? req.body?.items ?? null,
      reason: req.body?.reason,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent return requested');
  }),
);

router.post(
  '/ward-indents/:indentId/discrepancies',
  requireRole(...WARD_INDENT_RECEIPT_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('discrepancy', 'discrepancies'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.reportWardIndentDiscrepancy({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      reportedBy: req.user?.uid,
      reason: req.body?.reason,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent reconciliation required');
  }),
);

router.post(
  '/ward-indents/:indentId/reconcile',
  requireRole(...WARD_INDENT_RECONCILIATION_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('reconcile', 'reconcile'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.reconcileWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      reconciledBy: req.user?.uid,
      reason: req.body?.reason,
      itemReconciliations: req.body?.item_reconciliations ?? null,
      allocationReturns: req.body?.allocation_returns ?? null,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent reconciled');
  }),
);

router.post(
  '/ward-indents/:indentId/cancel',
  requireRole(...WARD_INDENT_REQUEST_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('cancel', 'cancel'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.cancelWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      cancelledBy: req.user?.uid,
      reason: req.body?.reason,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent cancelled');
  }),
);

router.post(
  '/ward-indents/:indentId/close',
  requireRole(...WARD_INDENT_RECONCILIATION_ROLES),
  guardWardIndentRow,
  wardIndentIdempotency('close', 'close'),
  wrapAsync(async (req, res) => {
    const indent = await ipdSupportService.closeWardIndent({
      indentId: requireIntParam(req.params.indentId, 'indentId'),
      closedBy: req.user?.uid,
      reason: req.body?.reason,
      ...wardIndentMutationContext(req),
    });
    success(res, { indent }, 'Indent closed');
  }),
);

export default router;
