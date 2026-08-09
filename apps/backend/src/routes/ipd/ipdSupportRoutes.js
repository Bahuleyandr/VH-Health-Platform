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
import {
  BILLING_ROUTE_ROLES,
  IP_FLOW_ROUTE_ROLES,
  PHARMACY_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';

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
const WARD_INDENT_SUPPLY_ROLES = PHARMACY_ROUTE_ROLES;

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function requireIntParam(value, fieldName) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
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

router.post(
  '/ward-indents',
  requireRole(...WARD_INDENT_REQUEST_ROLES),
  wrapAsync(async (req, res) => {
    const { ward_id, admission_id, encounter_id, patient_uid, indent_type, items, notes } = req.body ?? {};
    const indent = await ipdSupportService.createWardIndent({
      wardId: ward_id ?? null,
      admissionId: admission_id ?? null,
      encounterId: encounter_id ?? null,
      patientUid: patient_uid ?? null,
      indentType: indent_type ?? 'pharmacy',
      items,
      notes: notes ?? null,
      requestedBy: req.user?.uid,
      tenantId: tenantOf(req),
    });
    success(res, { indent }, `Ward indent ${indent.indent_number} created`, HTTP_STATUS.CREATED);
  })
);

router.get(
  '/ward-indents',
  wrapAsync(async (req, res) => {
    const { ward_id, status, admission_id, patient_uid, limit } = req.query ?? {};
    const indents = await ipdSupportService.listWardIndents({
      wardId: ward_id ? Number.parseInt(ward_id, 10) : null,
      status: status ?? null,
      admissionId: admission_id ? Number.parseInt(admission_id, 10) : null,
      patientUid: patient_uid ?? null,
      limit: limit ? Number.parseInt(limit, 10) : 50,
      tenantId: tenantOf(req),
    });
    success(res, { indents }, 'Ward indents retrieved');
  })
);

router.get(
  '/admissions/:id/ward-indents',
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const { status, limit } = req.query ?? {};
    const indents = await ipdSupportService.listWardIndents({
      admissionId,
      status: status ?? null,
      limit: limit ? Number.parseInt(limit, 10) : 50,
      tenantId: tenantOf(req),
    });
    success(res, { indents }, 'Ward indents for admission retrieved');
  })
);

router.get(
  '/ward-indents/:indentId',
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.getWardIndent(indentId, { tenantId: tenantOf(req) });
    if (!indent) return error(res, 'Ward indent not found', HTTP_STATUS.NOT_FOUND);
    success(res, { indent }, 'Ward indent retrieved');
  })
);

router.post(
  '/ward-indents/:indentId/approve',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.approveWardIndent({
      indentId,
      approvedBy: req.user?.uid,
      tenantId: tenantOf(req),
    });
    success(res, { indent }, 'Indent approved');
  })
);

router.post(
  '/ward-indents/:indentId/reject',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const { reason } = req.body ?? {};
    const indent = await ipdSupportService.rejectWardIndent({
      indentId,
      rejectedBy: req.user?.uid,
      reason,
      tenantId: tenantOf(req),
    });
    success(res, { indent }, 'Indent rejected');
  })
);

router.post(
  '/ward-indents/:indentId/issue',
  requireRole(...WARD_INDENT_SUPPLY_ROLES),
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const { item_quantities_issued } = req.body ?? {};
    const indent = await ipdSupportService.issueWardIndent({
      indentId,
      issuedBy: req.user?.uid,
      itemQuantitiesIssued: item_quantities_issued ?? null,
      tenantId: tenantOf(req),
    });
    success(res, { indent }, 'Indent issued');
  })
);

router.post(
  '/ward-indents/:indentId/receive',
  requireRole(...WARD_INDENT_REQUEST_ROLES),
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.receiveWardIndent({
      indentId,
      receivedBy: req.user?.uid,
      tenantId: tenantOf(req),
    });
    success(res, { indent }, 'Indent receipt acknowledged');
  })
);

export default router;
