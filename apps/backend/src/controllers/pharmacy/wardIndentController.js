// src/controllers/pharmacy/wardIndentController.js
//
// IPD ward-indent surface for the pharmacy module.
//
// Bridges the ward (requesting consumables) and pharmacy stores (issuing
// from inventory) — the swarm finding flagged that the entire pharmacy
// module was OPD-home-delivery only; all IPD wards had no way to request
// or receive stock via the REST surface. The service layer
// (ipdSupportService.createWardIndent / approveWardIndent / issueWardIndent
// / receiveWardIndent / listWardIndents / getWardIndent) was already
// implemented; this controller exposes it. Workflow:
//   requested → approved (or rejected) → issued → received
// Finding: 2026-05-08-inpatient-admission-pharmacy-no-ipd-ward-indent.

import logger from '../../logging/logger.js';
import {
  approveWardIndent,
  createWardIndent,
  getWardIndent,
  issueWardIndent,
  listWardIndents,
  receiveWardIndent,
  rejectWardIndent,
} from '../../services/ipd/ipdSupportService.js';
import { error, success } from '../../utils/responseHelper.js';

function parseIntParam(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const listIndents = async (req, res) => {
  try {
    const wardId = req.query.wardId ? parseIntParam(req.query.wardId) : null;
    const status = req.query.status ? String(req.query.status).trim() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    // PHI scoping: a ward queue spans every admission, so an unfiltered
    // list mixes one patient's IPD pharmacy indents with everyone else's.
    // Honor admission_id / patient_uid query params (the service applies
    // them in the WHERE) so staff searching for a specific admission or
    // patient never see other patients' rows. Finding:
    // 2026-05-22-inpatient-admission-pharmacy-3e9d3302.
    const admissionId = req.query.admission_id ? parseIntParam(req.query.admission_id) : null;
    const patientUid = req.query.patient_uid ? String(req.query.patient_uid).trim() : null;
    const indents = await listWardIndents({ wardId, status, admissionId, patientUid, limit });
    success(res, indents, 'Ward indents retrieved');
  } catch (err) {
    logger.error('listIndents error:', err);
    error(res, err.message || 'Failed to list ward indents', err.statusCode || 500);
  }
};

export const getIndent = async (req, res) => {
  try {
    const indentId = parseIntParam(req.params.id);
    if (!indentId) return error(res, 'Invalid indent id', 400);
    const indent = await getWardIndent(indentId);
    if (!indent) return error(res, 'Ward indent not found', 404);
    success(res, indent, 'Ward indent retrieved');
  } catch (err) {
    logger.error('getIndent error:', err);
    error(res, err.message || 'Failed to fetch ward indent', err.statusCode || 500);
  }
};

export const createIndent = async (req, res) => {
  try {
    const requestedBy = req.user?.uid;
    if (!requestedBy) return error(res, 'Authenticated uid required', 401);
    const { ward_id, wardId, indent_type, items, notes } = req.body || {};
    const indent = await createWardIndent({
      wardId: parseIntParam(ward_id ?? wardId),
      indentType: indent_type || 'pharmacy',
      items,
      notes: notes ?? null,
      requestedBy,
    });
    success(res, indent, 'Ward indent created', 201);
  } catch (err) {
    logger.error('createIndent error:', err);
    error(res, err.message || 'Failed to create ward indent', err.statusCode || 500);
  }
};

export const approveIndent = async (req, res) => {
  try {
    const indentId = parseIntParam(req.params.id);
    if (!indentId) return error(res, 'Invalid indent id', 400);
    const approvedBy = req.user?.uid;
    if (!approvedBy) return error(res, 'Authenticated uid required', 401);
    const indent = await approveWardIndent({ indentId, approvedBy });
    success(res, indent, 'Ward indent approved');
  } catch (err) {
    logger.error('approveIndent error:', err);
    error(res, err.message || 'Failed to approve ward indent', err.statusCode || 500);
  }
};

export const rejectIndent = async (req, res) => {
  try {
    const indentId = parseIntParam(req.params.id);
    if (!indentId) return error(res, 'Invalid indent id', 400);
    const rejectedBy = req.user?.uid;
    if (!rejectedBy) return error(res, 'Authenticated uid required', 401);
    const reason = req.body?.reason;
    const indent = await rejectWardIndent({ indentId, rejectedBy, reason });
    success(res, indent, 'Ward indent rejected');
  } catch (err) {
    logger.error('rejectIndent error:', err);
    error(res, err.message || 'Failed to reject ward indent', err.statusCode || 500);
  }
};

export const issueIndent = async (req, res) => {
  try {
    const indentId = parseIntParam(req.params.id);
    if (!indentId) return error(res, 'Invalid indent id', 400);
    const issuedBy = req.user?.uid;
    if (!issuedBy) return error(res, 'Authenticated uid required', 401);
    const itemQuantitiesIssued = Array.isArray(req.body?.item_quantities_issued)
      ? req.body.item_quantities_issued
      : Array.isArray(req.body?.items)
        ? req.body.items.map((x) => ({
            item_id: parseIntParam(x.item_id ?? x.id),
            quantity_issued: Number(x.quantity_issued),
          }))
        : [];
    const indent = await issueWardIndent({ indentId, issuedBy, itemQuantitiesIssued });
    success(res, indent, 'Ward indent issued');
  } catch (err) {
    logger.error('issueIndent error:', err);
    error(res, err.message || 'Failed to issue ward indent', err.statusCode || 500);
  }
};

export const receiveIndent = async (req, res) => {
  try {
    const indentId = parseIntParam(req.params.id);
    if (!indentId) return error(res, 'Invalid indent id', 400);
    const receivedBy = req.user?.uid;
    if (!receivedBy) return error(res, 'Authenticated uid required', 401);
    const indent = await receiveWardIndent({ indentId, receivedBy });
    success(res, indent, 'Ward indent received');
  } catch (err) {
    logger.error('receiveIndent error:', err);
    error(res, err.message || 'Failed to receive ward indent', err.statusCode || 500);
  }
};
