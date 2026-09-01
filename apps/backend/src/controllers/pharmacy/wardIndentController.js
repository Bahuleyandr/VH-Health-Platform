// src/controllers/pharmacy/wardIndentController.js
//
// Authoritative ward-to-pharmacy indent workflow. Every mutation is protected
// by route-level idempotency and optimistic state-version checks, while the
// service owns the transactional state, stock, canonical evidence, and SLA
// invariants.

import logger from '../../logging/logger.js';
import {
  applyApprovedWardIndentSubstitution,
  approveWardIndentControlledWitnessApproval,
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
  requestWardIndentControlledWitnessApproval,
  receiveWardIndent,
  reconcileWardIndent,
  recordWardIndentControlledHandoff,
  rejectWardIndent,
  rejectWardIndentSubstitution,
  reportWardIndentDiscrepancy,
  requestWardIndentReturn,
  reserveWardIndent,
} from '../../services/ipd/ipdSupportService.js';
import { sweepWardIndentNotificationCoverage } from '../../services/ipd/wardIndentObligationService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { logAudit } from '../../utils/logAudit.js';
import { relayAppError, success } from '../../utils/responseHelper.js';
import { normalizeRole } from '../../utils/roles.js';

const PG_INT4_MAX = 2147483647;
const COVERAGE_RECOVERY_DEFAULT_LIMIT = 25;
const COVERAGE_RECOVERY_MAX_LIMIT = 100;

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function positiveInt(raw, fieldName) {
  const text = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
  const value = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isInteger(value) || value > PG_INT4_MAX) {
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

function coverageRecoveryLimitOf(req) {
  const raw = req.body?.limit;
  if (raw == null || raw === '') return COVERAGE_RECOVERY_DEFAULT_LIMIT;
  const text = typeof raw === 'number' ? String(raw) : String(raw).trim();
  const value = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(value)
    || value > COVERAGE_RECOVERY_MAX_LIMIT) {
    throw AppError.badRequest(
      `limit must be an integer between 1 and ${COVERAGE_RECOVERY_MAX_LIMIT}`,
      'WARD_INDENT_COVERAGE_RECOVERY_LIMIT_INVALID',
      { field: 'limit', maximum: COVERAGE_RECOVERY_MAX_LIMIT },
    );
  }
  return value;
}

function actionHandler({ operation, message, invoke }) {
  return async (req, res) => {
    try {
      const indentId = positiveInt(req.params.id, 'indent_id');
      const indent = await invoke({
        req,
        indentId,
        actorUid: actorOf(req),
        actorRole: actorRoleCodesOf(req)[0] || null,
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
      actorUid: actorOf(req),
      actorRole: actorRoleCodesOf(req)[0] || null,
    });
    return success(res, candidates, 'Ward indent inventory candidates retrieved');
  } catch (err) {
    logger.error('Ward indent inventory candidate list failed:', err);
    return relayAppError(res, err, 'Failed to list ward indent inventory candidates');
  }
}

export async function recoverNotificationCoverage(req, res) {
  try {
    const summary = await sweepWardIndentNotificationCoverage({
      tenantId: tenantOf(req),
      actorUid: actorOf(req),
      limit: coverageRecoveryLimitOf(req),
    });
    await logAudit(req, 'WARD_INDENT_NOTIFICATION_COVERAGE_RECOVERY_RUN', {
      scanned: summary.scanned,
      recovered: summary.recovered,
      held: summary.held,
      awaiting_recipients: summary.awaitingRecipients,
      bounded_limit: summary.limit,
    }, {
      resource: 'ward_indent_notification_coverage',
      resourceId: commandOf(req),
    });
    return success(res, summary, 'Ward indent notification coverage recovery completed');
  } catch (err) {
    logger.error('Ward indent notification coverage recovery failed:', err);
    return relayAppError(res, err, 'Failed to recover ward indent notification coverage');
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
  invoke: ({ req, actorUid, actorRole, ...common }) => reserveWardIndent({
    ...common,
    reservedBy: actorUid,
    actorRole,
    itemQuantitiesReserved: bodyArray(req, 'item_quantities_reserved'),
    inventorySelections: bodyArray(req, 'inventory_selections'),
  }),
});

export const markShortSupply = actionHandler({
  operation: 'record short supply for',
  message: 'Ward indent short supply recorded',
  invoke: ({ req, actorUid, actorRole, ...common }) => markWardIndentShortSupply({
    ...common,
    markedBy: actorUid,
    actorRole,
    reason: req.body?.reason ?? req.body?.short_supply_reason,
    itemQuantitiesAvailable: bodyArray(req, 'item_quantities_available'),
    inventorySelections: bodyArray(req, 'inventory_selections'),
  }),
});

export const proposeSubstitution = actionHandler({
  operation: 'propose substitution for',
  message: 'Ward indent substitution proposed',
  invoke: ({ req, actorUid, actorRole, ...common }) => proposeWardIndentSubstitution({
    ...common,
    proposedBy: actorUid,
    actorRole,
    substitutions: req.body?.substitutions,
  }),
});

export const approveSubstitution = actionHandler({
  operation: 'approve substitution for',
  message: 'Ward indent substitution approved',
  invoke: ({ actorUid, ...common }) => approveWardIndentSubstitution({
    ...common,
    decidedBy: actorUid,
  }),
});

export const applyApprovedSubstitution = actionHandler({
  operation: 'apply approved substitution for',
  message: 'Approved ward indent substitution applied to inventory',
  invoke: ({ req, actorUid, actorRole, ...common }) => applyApprovedWardIndentSubstitution({
    ...common,
    appliedBy: actorUid,
    actorRole,
    inventorySelections: bodyArray(req, 'inventory_selections'),
  }),
});

export async function requestControlledWitness(req, res) {
  try {
    const approval = await requestWardIndentControlledWitnessApproval({
      tenantId: tenantOf(req),
      indentId: positiveInt(req.params.id, 'indent_id'),
      itemId: positiveInt(req.body?.item_id, 'item_id'),
      allocationId: req.body?.allocation_id,
      requestedBy: actorOf(req),
      actorRole: actorRoleCodesOf(req)[0] || null,
    });
    return success(res, approval, 'Controlled ward handoff witness requested', 201);
  } catch (err) {
    logger.error('Ward indent controlled witness request failed:', err);
    return relayAppError(res, err, 'Failed to request controlled ward handoff witness');
  }
}

export async function approveControlledWitness(req, res) {
  try {
    const witnessActor = req.wardWitnessActor;
    if (!witnessActor?.actorUid) {
      throw AppError.unauthorized('Authenticated witness identity required');
    }
    const approval = await approveWardIndentControlledWitnessApproval({
      tenantId: tenantOf(req),
      indentId: positiveInt(req.params.id, 'indent_id'),
      itemId: positiveInt(req.body?.item_id, 'item_id'),
      allocationId: req.body?.allocation_id,
      requesterUid: actorOf(req),
      requesterRole: actorRoleCodesOf(req)[0] || null,
      witnessUid: witnessActor.actorUid,
      approvalId: req.params.approvalId,
    });
    return success(res, approval, 'Controlled ward handoff witness approved');
  } catch (err) {
    logger.error('Ward indent controlled witness approval failed:', err);
    return relayAppError(res, err, 'Failed to approve controlled ward handoff witness');
  }
}

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
  invoke: ({ actorUid, actorRole, ...common }) => approveWardIndent({
    ...common,
    approvedBy: actorUid,
    actorRole,
  }),
});

export const rejectIndent = actionHandler({
  operation: 'reject',
  message: 'Ward indent rejected',
  invoke: ({ req, actorUid, actorRole, ...common }) => rejectWardIndent({
    ...common,
    rejectedBy: actorUid,
    actorRole,
    reason: req.body?.reason,
  }),
});

export const recordControlledHandoff = actionHandler({
  operation: 'record controlled handoff for',
  message: 'Ward indent controlled-drug handoff recorded',
  invoke: ({ req, actorUid, actorRole, ...common }) => recordWardIndentControlledHandoff({
    ...common,
    recordedBy: actorUid,
    actorRole,
    itemEvidence: req.body?.item_evidence,
  }),
});

export const issueIndent = actionHandler({
  operation: 'issue',
  message: 'Ward indent issued',
  invoke: ({ req, actorUid, actorRole, ...common }) => issueWardIndent({
    ...common,
    issuedBy: actorUid,
    actorRole,
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
  invoke: ({ req, actorUid, actorRole, ...common }) => reconcileWardIndent({
    ...common,
    reconciledBy: actorUid,
    actorRole,
    reason: req.body?.reason,
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
