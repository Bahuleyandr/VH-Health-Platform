// src/controllers/pharmacy/wardIndentController.js
//
// Authoritative ward-to-pharmacy indent workflow. Every mutation is protected
// by route-level idempotency and optimistic state-version checks, while the
// service owns the transactional state, stock, canonical evidence, and SLA
// invariants.

import logger from '../../logging/logger.js';
import {
  approveWardIndent,
  approveWardIndentSubstitution,
  cancelWardIndent,
  closeWardIndent,
  createWardIndent,
  getWardIndent,
  issueWardIndent,
  listWardIndentInventoryCandidates,
  listWardIndentPage,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  receiveWardIndent,
  reconcileWardIndent,
  recordWardIndentControlledHandoff,
  rejectWardIndent,
  rejectWardIndentSubstitution,
  reportWardIndentDiscrepancy,
  requestWardIndentReturn,
  reserveWardIndent,
} from '../../services/ipd/ipdSupportService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { relayAppError, success } from '../../utils/responseHelper.js';
import { normalizeRole } from '../../utils/roles.js';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function positiveInt(raw, fieldName) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw AppError.badRequest(
      `${fieldName} must be a positive integer`,
      'WARD_INDENT_INVALID_IDENTIFIER',
      { field: fieldName },
    );
  }
  return value;
}

function optionalPositiveInt(raw, fieldName) {
  return raw == null || raw === '' ? null : positiveInt(raw, fieldName);
}

function actorOf(req) {
  const actorUid = req.user?.uid;
  if (!actorUid) throw AppError.unauthorized('Authenticated uid required');
  return actorUid;
}

function actorRoleCodesOf(req) {
  return [...new Set(
    [req.user?.role, req.user?.rawRole]
      .map(normalizeRole)
      .filter(Boolean),
  )];
}

function commandOf(req) {
  return req.get('idempotency-key') || null;
}

function expectedVersionOf(req) {
  return req.body?.expected_version ?? req.body?.state_version ?? null;
}

function bodyArray(req, fieldName) {
  if (Array.isArray(req.body?.[fieldName])) return req.body[fieldName];
  return Array.isArray(req.body?.items) ? req.body.items : null;
}

function actionHandler({ operation, message, invoke }) {
  return async (req, res) => {
    try {
      const indentId = positiveInt(req.params.id, 'indent_id');
      const indent = await invoke({
        req,
        indentId,
        actorUid: actorOf(req),
        tenantId: tenantOf(req),
        expectedVersion: expectedVersionOf(req),
        commandKey: commandOf(req),
      });
      return success(res, indent, message);
    } catch (err) {
      logger.error(`Ward indent ${operation} failed:`, err);
      return relayAppError(res, err, `Failed to ${operation} ward indent`);
    }
  };
}

export async function listIndents(req, res) {
  try {
    const page = await listWardIndentPage({
      wardId: optionalPositiveInt(req.query.ward_id ?? req.query.wardId, 'ward_id'),
      status: req.query.status ? String(req.query.status).trim() : null,
      admissionId: optionalPositiveInt(req.query.admission_id, 'admission_id'),
      patientUid: req.query.patient_uid ? String(req.query.patient_uid).trim() : null,
      overdueOnly: ['1', 'true'].includes(String(req.query.overdue_only || '').toLowerCase()),
      worklist: req.query.worklist ? String(req.query.worklist).trim() : null,
      beforeRequestedAt: req.query.before_requested_at ?? null,
      beforeId: optionalPositiveInt(req.query.before_id, 'before_id'),
      actorRoleCodes: actorRoleCodesOf(req),
      limit: req.query.limit ? Number(req.query.limit) : 50,
      tenantId: tenantOf(req),
    });
    return success(
      res,
      page.items,
      'Ward indents retrieved',
      200,
      { pagination: page.pagination },
    );
  } catch (err) {
    logger.error('Ward indent list failed:', err);
    return relayAppError(res, err, 'Failed to list ward indents');
  }
}

export async function getIndent(req, res) {
  try {
    const indentId = positiveInt(req.params.id, 'indent_id');
    const indent = await getWardIndent(indentId, {
      tenantId: tenantOf(req),
      eventLimit: req.query.event_limit ? Number(req.query.event_limit) : 100,
    });
    if (!indent) throw AppError.notFound('Ward indent not found');
    return success(res, indent, 'Ward indent retrieved');
  } catch (err) {
    logger.error('Ward indent get failed:', err);
    return relayAppError(res, err, 'Failed to fetch ward indent');
  }
}

export async function listInventoryCandidates(req, res) {
  try {
    const indentId = positiveInt(req.params.id, 'indent_id');
    const itemId = positiveInt(req.params.itemId, 'ward_indent_item_id');
    const candidates = await listWardIndentInventoryCandidates(itemId, {
      tenantId: tenantOf(req),
      wardIndentId: indentId,
    });
    return success(res, candidates, 'Ward indent inventory candidates retrieved');
  } catch (err) {
    logger.error('Ward indent inventory candidate list failed:', err);
    return relayAppError(res, err, 'Failed to list ward indent inventory candidates');
  }
}

export async function createIndent(req, res) {
  try {
    const body = req.body || {};
    const indent = await createWardIndent({
      wardId: optionalPositiveInt(body.ward_id ?? body.wardId, 'ward_id'),
      admissionId: optionalPositiveInt(body.admission_id, 'admission_id'),
      encounterId: body.encounter_id ?? null,
      patientUid: body.patient_uid ?? null,
      indentType: body.indent_type || 'pharmacy',
      items: body.items,
      notes: body.notes ?? null,
      requestedBy: actorOf(req),
      commandKey: commandOf(req),
      tenantId: tenantOf(req),
    });
    return success(res, indent, 'Ward indent created', 201);
  } catch (err) {
    logger.error('Ward indent create failed:', err);
    return relayAppError(res, err, 'Failed to create ward indent');
  }
}

export const reserveIndent = actionHandler({
  operation: 'reserve',
  message: 'Ward indent reserved',
  invoke: ({ req, actorUid, ...common }) => reserveWardIndent({
    ...common,
    reservedBy: actorUid,
    itemQuantitiesReserved: bodyArray(req, 'item_quantities_reserved'),
    inventorySelections: bodyArray(req, 'inventory_selections'),
  }),
});

export const markShortSupply = actionHandler({
  operation: 'record short supply for',
  message: 'Ward indent short supply recorded',
  invoke: ({ req, actorUid, ...common }) => markWardIndentShortSupply({
    ...common,
    markedBy: actorUid,
    reason: req.body?.reason ?? req.body?.short_supply_reason,
    itemQuantitiesAvailable: bodyArray(req, 'item_quantities_available'),
    inventorySelections: bodyArray(req, 'inventory_selections'),
  }),
});

export const proposeSubstitution = actionHandler({
  operation: 'propose substitution for',
  message: 'Ward indent substitution proposed',
  invoke: ({ req, actorUid, ...common }) => proposeWardIndentSubstitution({
    ...common,
    proposedBy: actorUid,
    substitutions: req.body?.substitutions,
  }),
});

export const approveSubstitution = actionHandler({
  operation: 'approve substitution for',
  message: 'Ward indent substitution approved',
  invoke: ({ req, actorUid, ...common }) => approveWardIndentSubstitution({
    ...common,
    decidedBy: actorUid,
    inventorySelections: bodyArray(req, 'inventory_selections'),
  }),
});

export const rejectSubstitution = actionHandler({
  operation: 'reject substitution for',
  message: 'Ward indent substitution rejected',
  invoke: ({ req, actorUid, ...common }) => rejectWardIndentSubstitution({
    ...common,
    decidedBy: actorUid,
    reason: req.body?.reason,
  }),
});

export const approveIndent = actionHandler({
  operation: 'approve',
  message: 'Ward indent approved',
  invoke: ({ actorUid, ...common }) => approveWardIndent({
    ...common,
    approvedBy: actorUid,
  }),
});

export const rejectIndent = actionHandler({
  operation: 'reject',
  message: 'Ward indent rejected',
  invoke: ({ req, actorUid, ...common }) => rejectWardIndent({
    ...common,
    rejectedBy: actorUid,
    reason: req.body?.reason,
  }),
});

export const recordControlledHandoff = actionHandler({
  operation: 'record controlled handoff for',
  message: 'Ward indent controlled-drug handoff recorded',
  invoke: ({ req, actorUid, ...common }) => recordWardIndentControlledHandoff({
    ...common,
    recordedBy: actorUid,
    itemEvidence: req.body?.item_evidence,
  }),
});

export const issueIndent = actionHandler({
  operation: 'issue',
  message: 'Ward indent issued',
  invoke: ({ req, actorUid, ...common }) => issueWardIndent({
    ...common,
    issuedBy: actorUid,
    itemQuantitiesIssued: bodyArray(req, 'item_quantities_issued'),
  }),
});

export const receiveIndent = actionHandler({
  operation: 'receive',
  message: 'Ward indent receipt recorded',
  invoke: ({ req, actorUid, ...common }) => receiveWardIndent({
    ...common,
    receivedBy: actorUid,
    itemQuantitiesReceived: bodyArray(req, 'item_quantities_received'),
    substitutionAcknowledgements: bodyArray(req, 'substitution_acknowledgements'),
  }),
});

export const requestReturn = actionHandler({
  operation: 'request return for',
  message: 'Ward indent return requested',
  invoke: ({ req, actorUid, ...common }) => requestWardIndentReturn({
    ...common,
    requestedBy: actorUid,
    itemQuantitiesReturned: bodyArray(req, 'item_quantities_returned'),
    reason: req.body?.reason,
  }),
});

export const reportDiscrepancy = actionHandler({
  operation: 'report discrepancy for',
  message: 'Ward indent reconciliation required',
  invoke: ({ req, actorUid, ...common }) => reportWardIndentDiscrepancy({
    ...common,
    reportedBy: actorUid,
    reason: req.body?.reason,
  }),
});

export const reconcileIndent = actionHandler({
  operation: 'reconcile',
  message: 'Ward indent reconciled',
  invoke: ({ req, actorUid, ...common }) => reconcileWardIndent({
    ...common,
    reconciledBy: actorUid,
    reason: req.body?.reason,
    controlledReturnEvidence: req.body?.controlled_return_evidence,
    itemReconciliations: req.body?.item_reconciliations,
    allocationReturns: req.body?.allocation_returns,
  }),
});

export const cancelIndent = actionHandler({
  operation: 'cancel',
  message: 'Ward indent cancelled',
  invoke: ({ req, actorUid, ...common }) => cancelWardIndent({
    ...common,
    cancelledBy: actorUid,
    reason: req.body?.reason,
  }),
});

export const closeIndent = actionHandler({
  operation: 'close',
  message: 'Ward indent closed',
  invoke: ({ req, actorUid, ...common }) => closeWardIndent({
    ...common,
    closedBy: actorUid,
    reason: req.body?.reason,
  }),
});
