import logger from '../../logging/logger.js';
import {
  acceptOpInpatientTransfer,
  requestOpInpatientTransfer,
} from '../../services/appointment/opInpatientTransferService.js';
import { getAppointmentPathwayWork } from '../../services/appointment/opPathwayWorkService.js';
import { recordOpVisitClosureEvidence } from '../../services/appointment/opVisitClosureEvidenceService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { relayAppError, success } from '../../utils/responseHelper.js';

function requireTransferActor(req) {
  const uid = req.user?.uid;
  const primaryRole = req.user?.role
    ? String(req.user.role).trim().toUpperCase()
    : null;
  const suppliedRoles = Array.isArray(req.user?.roles)
    ? req.user.roles
    : req.user?.roles
      ? [req.user.roles]
      : [];
  const roles = [
    ...new Set([
      primaryRole,
      ...suppliedRoles.map(role => String(role).trim().toUpperCase()),
    ].filter(Boolean)),
  ];
  if (!uid || roles.length === 0) {
    throw AppError.unauthorized('Authenticated transfer actor is required');
  }
  return {
    kind: 'user',
    uid,
    roles,
    primaryRole: primaryRole || roles[0],
    rawRole: req.user?.rawRole || primaryRole || roles[0],
    authorizationMode: 'authenticated_appointment_transfer_route',
  };
}

function requireIdempotencyKey(req) {
  const key = typeof req.get('Idempotency-Key') === 'string'
    ? req.get('Idempotency-Key').trim()
    : '';
  if (!key) {
    throw AppError.badRequest(
      'Idempotency-Key header is required',
      'OP_INPATIENT_TRANSFER_IDEMPOTENCY_REQUIRED',
    );
  }
  return key;
}

function rejectUnknownFields(body, allowed) {
  for (const field of Object.keys(body || {})) {
    if (!allowed.has(field)) {
      throw AppError.badRequest(
        `Unsupported OP-to-inpatient transfer field: ${field}`,
        'OP_INPATIENT_TRANSFER_FIELD_UNSUPPORTED',
      );
    }
  }
}

function setPhiContext(req, result) {
  const patientUid = result?.__patient_uid;
  if (patientUid) {
    req.phiContext = { ...(req.phiContext || {}), patientUid: String(patientUid) };
  }
}

export const getPathwayWork = async (req, res) => {
  try {
    const pathwayWork = await getAppointmentPathwayWork({
      tenantId: resolveTenantOrThrow(req),
      appointmentId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
    });
    return success(res, pathwayWork, 'Appointment pathway work retrieved');
  } catch (err) {
    logger.error('Failed to retrieve appointment pathway work:', err);
    return relayAppError(res, err, 'Failed to retrieve appointment pathway work');
  }
};

export const recordClosureEvidence = async (req, res) => {
  try {
    const result = await recordOpVisitClosureEvidence({
      tenantId: resolveTenantOrThrow(req),
      appointmentId: req.params.id,
      clinicianUid: req.user?.uid,
      clinicianId: req.user?.id,
      clinicianRole: req.user?.role,
      input: req.body,
    });
    return success(
      res,
      result,
      result.replayed
        ? 'Appointment closure evidence already recorded'
        : 'Appointment closure evidence recorded',
      result.replayed ? 200 : 201,
    );
  } catch (err) {
    logger.error('Failed to record appointment closure evidence:', err);
    return relayAppError(res, err, 'Failed to record appointment closure evidence');
  }
};

export const requestInpatientTransfer = async (req, res) => {
  try {
    const body = req.body || {};
    rejectUnknownFields(body, new Set(['intended_recipient_uid', 'reason']));
    const result = await requestOpInpatientTransfer({
      tenantId: resolveTenantOrThrow(req),
      appointmentId: req.params.id,
      intendedRecipientUid: body.intended_recipient_uid,
      reason: body.reason,
      idempotencyKey: requireIdempotencyKey(req),
      actor: requireTransferActor(req),
    });
    setPhiContext(req, result);
    return success(
      res,
      result,
      result.replayed
        ? 'OP-to-inpatient transfer request replayed'
        : 'OP-to-inpatient transfer requested',
      result.replayed ? 200 : 201,
    );
  } catch (err) {
    logger.error('Failed to request OP-to-inpatient transfer:', err);
    return relayAppError(res, err, 'Failed to request OP-to-inpatient transfer');
  }
};

export const acceptInpatientTransfer = async (req, res) => {
  try {
    rejectUnknownFields(req.body || {}, new Set());
    const result = await acceptOpInpatientTransfer({
      tenantId: resolveTenantOrThrow(req),
      appointmentId: req.params.id,
      handoffId: req.params.handoffId,
      idempotencyKey: requireIdempotencyKey(req),
      actor: requireTransferActor(req),
    });
    setPhiContext(req, result);
    return success(
      res,
      result,
      result.replayed
        ? 'OP-to-inpatient transfer acceptance replayed'
        : 'OP-to-inpatient transfer accepted',
    );
  } catch (err) {
    logger.error('Failed to accept OP-to-inpatient transfer:', err);
    return relayAppError(res, err, 'Failed to accept OP-to-inpatient transfer');
  }
};

export default {
  acceptInpatientTransfer,
  getPathwayWork,
  recordClosureEvidence,
  requestInpatientTransfer,
};
