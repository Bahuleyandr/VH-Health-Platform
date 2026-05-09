// src/routes/ipd/ipdSupportRoutes.js
//
// IPD support subsystem routes (architectural item A4 / migration 174):
//   - /admissions/:id/advance-deposits             collect, list, refund
//   - /admissions/:id/attendant-passes             list, replace, revoke
//   - /ward-indents                                request, approve, reject, issue, receive, list
//
// Mounted under /api/v1/ipd. RBAC follows the existing platform pattern
// — admin/billing/pharmacy roles gated upstream in app.js.

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import ipdSupportService from '../../services/ipd/ipdSupportService.js';
import { wrapAsync } from '../../config/routeWrapper.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

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
    });
    success(res, { deposit }, `Advance deposit ${deposit.receipt_number} collected`, HTTP_STATUS.CREATED);
  })
);

router.get(
  '/admissions/:id/advance-deposits',
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const [deposits, balance] = await Promise.all([
      ipdSupportService.listAdmissionDeposits(admissionId),
      ipdSupportService.getAdmissionDepositBalance(admissionId),
    ]);
    success(res, { deposits, balance }, 'Advance deposits retrieved');
  })
);

router.post(
  '/advance-deposits/:depositId/refund',
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
    });
    success(res, { refund }, `Refund ${refund.receipt_number} processed`, HTTP_STATUS.CREATED);
  })
);

// ── Attendant passes ─────────────────────────────────────────────────

router.get(
  '/admissions/:id/attendant-passes',
  wrapAsync(async (req, res) => {
    const admissionId = requireIntParam(req.params.id, 'admissionId');
    const passes = await ipdSupportService.listAdmissionPasses(admissionId);
    success(res, { passes }, 'Attendant passes retrieved');
  })
);

router.post(
  '/admissions/:id/attendant-passes/replacement',
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
    });
    success(res, { pass }, `Replacement pass ${pass.pass_number} issued`, HTTP_STATUS.CREATED);
  })
);

router.post(
  '/attendant-passes/:passId/revoke',
  wrapAsync(async (req, res) => {
    const passId = requireIntParam(req.params.passId, 'passId');
    const { reason } = req.body ?? {};
    const pass = await ipdSupportService.revokeAttendantPass({
      passId,
      revokedBy: req.user?.uid,
      reason: reason ?? null,
    });
    success(res, { pass }, 'Pass revoked');
  })
);

// ── Ward indents ─────────────────────────────────────────────────────

router.post(
  '/ward-indents',
  wrapAsync(async (req, res) => {
    const { ward_id, indent_type, items, notes } = req.body ?? {};
    const indent = await ipdSupportService.createWardIndent({
      wardId: ward_id ?? null,
      indentType: indent_type ?? 'pharmacy',
      items,
      notes: notes ?? null,
      requestedBy: req.user?.uid,
    });
    success(res, { indent }, `Ward indent ${indent.indent_number} created`, HTTP_STATUS.CREATED);
  })
);

router.get(
  '/ward-indents',
  wrapAsync(async (req, res) => {
    const { ward_id, status, limit } = req.query ?? {};
    const indents = await ipdSupportService.listWardIndents({
      wardId: ward_id ? Number.parseInt(ward_id, 10) : null,
      status: status ?? null,
      limit: limit ? Number.parseInt(limit, 10) : 50,
    });
    success(res, { indents }, 'Ward indents retrieved');
  })
);

router.get(
  '/ward-indents/:indentId',
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.getWardIndent(indentId);
    if (!indent) return error(res, 'Ward indent not found', HTTP_STATUS.NOT_FOUND);
    success(res, { indent }, 'Ward indent retrieved');
  })
);

router.post(
  '/ward-indents/:indentId/approve',
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.approveWardIndent({
      indentId,
      approvedBy: req.user?.uid,
    });
    success(res, { indent }, 'Indent approved');
  })
);

router.post(
  '/ward-indents/:indentId/reject',
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const { reason } = req.body ?? {};
    const indent = await ipdSupportService.rejectWardIndent({
      indentId,
      rejectedBy: req.user?.uid,
      reason,
    });
    success(res, { indent }, 'Indent rejected');
  })
);

router.post(
  '/ward-indents/:indentId/issue',
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const { item_quantities_issued } = req.body ?? {};
    const indent = await ipdSupportService.issueWardIndent({
      indentId,
      issuedBy: req.user?.uid,
      itemQuantitiesIssued: item_quantities_issued ?? null,
    });
    success(res, { indent }, 'Indent issued');
  })
);

router.post(
  '/ward-indents/:indentId/receive',
  wrapAsync(async (req, res) => {
    const indentId = requireIntParam(req.params.indentId, 'indentId');
    const indent = await ipdSupportService.receiveWardIndent({
      indentId,
      receivedBy: req.user?.uid,
    });
    success(res, { indent }, 'Indent receipt acknowledged');
  })
);

export default router;
