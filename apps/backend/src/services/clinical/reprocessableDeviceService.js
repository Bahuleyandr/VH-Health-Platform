import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import {
  assertHoldReleaseAuthority,
  deviceTransition,
  evaluateReleaseCriteria,
} from './reprocessableDeviceRules.js';

export const LOCK_ORDER = Object.freeze([
  'tenant_patient_advisory',
  'dialysis_session_or_load',
  'ot_issue',
  'instrument_set',
  'device',
  'usage',
  'hold_and_satisfaction',
  'dialysis_link',
  'append_only_receipts',
]);

function first(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

function positiveId(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'RPD_BAD_ID');
  }
  return Number(text);
}

function assertVersion(device, expectedVersion) {
  const expected = Number(expectedVersion);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw AppError.badRequest('expected_version is required', 'RPD_EXPECTED_VERSION_REQUIRED');
  }
  if (Number(device.version) !== expected) {
    throw AppError.conflict('The device changed before this command could be applied',
      'RPD_VERSION_CONFLICT', { expected_version: expected, actual_version: Number(device.version) });
  }
}

async function lockDeviceTx(tx, tenantId, deviceId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_devices
      WHERE tenant_id = $1::uuid AND id = $2
      FOR UPDATE`,
    tenantId,
    positiveId(deviceId, 'device_id'),
  );
  const device = first(rows);
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  return device;
}

function operationIdentity(action, input = {}) {
  const operationId = input.operationId ?? crypto.randomUUID();
  const idempotencySource = input.idempotencyKey ?? operationId;
  return {
    operationId,
    idempotencyHash: crypto.createHash('sha256').update(String(idempotencySource)).digest('hex'),
    action,
  };
}

async function updateDeviceWithReceiptTx(tx, {
  tenantId,
  device,
  status,
  action,
  operation = {},
  extraSet = '',
  extraValues = [],
  resultSummary = {},
}) {
  const identity = operationIdentity(action, operation);
  const versionAfter = Number(device.version) + 1;
  const rows = await tx.$queryRawUnsafe(
    `WITH changed AS (
       UPDATE reprocessable_devices
          SET status = $3::varchar(32),
              version = $4,
              updated_at = clock_timestamp()
              ${extraSet}
        WHERE tenant_id = $1::uuid AND id = $2 AND version = $5
        RETURNING *
     ), receipt AS (
       INSERT INTO reprocessable_device_operations (
         tenant_id, operation_id, device_id, action, idempotency_key_hash,
         version_before, version_after, result_summary
       )
       SELECT $1::uuid, $6::uuid, id, $7, $8, $5, $4, $9::jsonb
         FROM changed
       RETURNING operation_id::text, action, device_id::text, version_before, version_after, audit_id
     )
     SELECT changed.*, row_to_json(receipt) AS receipt
       FROM changed JOIN receipt ON TRUE`,
    tenantId,
    Number(device.id),
    status,
    versionAfter,
    Number(device.version),
    identity.operationId,
    identity.action,
    identity.idempotencyHash,
    JSON.stringify(resultSummary),
    ...extraValues,
  );
  const changed = first(rows);
  if (!changed) {
    throw AppError.conflict('The device changed before this command could be applied',
      'RPD_VERSION_CONFLICT');
  }
  return changed;
}

export async function registerDeviceTx(tx, {
  tenantId,
  input,
  actor,
  operation = {},
}) {
  const scopeRows = await tx.$queryRawUnsafe(
    `SELECT scope.*, protocol.domain AS protocol_domain, protocol.status AS protocol_status
       FROM reprocessing_protocol_device_scopes scope
       JOIN reprocessing_protocols protocol
         ON protocol.tenant_id = scope.tenant_id AND protocol.id = scope.protocol_id
      WHERE scope.tenant_id = $1::uuid AND scope.id = $2
      FOR SHARE OF scope, protocol`,
    tenantId,
    positiveId(input.protocol_device_scope_id, 'protocol_device_scope_id'),
  );
  const scope = first(scopeRows);
  if (!scope || scope.protocol_status !== 'active'
    || scope.single_use !== false
    || scope.protocol_domain !== input.domain
    || scope.category !== input.category
    || scope.manufacturer !== input.manufacturer
    || scope.model_name !== input.model_name) {
    throw AppError.conflict('Device does not match an active approved protocol scope',
      'RPD_PROTOCOL_SCOPE_MISMATCH');
  }
  if (input.domain === 'dialysis' && !String(input.manufacturer_serial ?? '').trim()) {
    throw AppError.badRequest('Dialysis devices require a manufacturer serial',
      'RPD_DEVICE_IDENTITY_REQUIRED');
  }
  if (input.category === 'procedure_pack') {
    throw AppError.badRequest('Procedure packs cannot be reprocessed',
      'RPD_PROCEDURE_PACK_REPROCESSING_FORBIDDEN');
  }
  const identity = operationIdentity('register', operation);
  const rows = await tx.$queryRawUnsafe(
    `WITH inserted AS (
       INSERT INTO reprocessable_devices (
         tenant_id, domain, category, facility_id, manufacturer_serial,
         hospital_asset_id, manufacturer, model_name, protocol_device_scope_id,
         instrument_set_id, enrolled_via, max_cycles_snapshot, status, created_by
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid)
       ON CONFLICT DO NOTHING
       RETURNING *
     ), receipt AS (
       INSERT INTO reprocessable_device_operations (
         tenant_id, operation_id, device_id, action, idempotency_key_hash,
         version_before, version_after, result_summary
       )
       SELECT $1::uuid, $15::uuid, id, 'register', $16, 0, version,
              jsonb_build_object('domain', domain, 'category', category)
         FROM inserted
       RETURNING operation_id::text, action, device_id::text, version_before, version_after, audit_id
     )
     SELECT inserted.*, row_to_json(receipt) AS receipt
       FROM inserted JOIN receipt ON TRUE`,
    tenantId,
    input.domain,
    input.category,
    input.facility_id ?? null,
    input.manufacturer_serial?.trim() || null,
    input.hospital_asset_id?.trim() || null,
    input.manufacturer.trim(),
    input.model_name.trim(),
    Number(scope.id),
    input.instrument_set_id ?? null,
    input.enrolled_via,
    input.max_cycles_snapshot ?? null,
    input.initial_status ?? 'available',
    actor.uid,
    identity.operationId,
    identity.idempotencyHash,
  );
  const inserted = first(rows);
  if (inserted) return inserted;
  const existingRows = await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_devices
      WHERE tenant_id = $1::uuid AND domain = $2
        AND (($3::text IS NOT NULL AND manufacturer_serial = $3)
          OR ($4::text IS NOT NULL AND hospital_asset_id = $4))
      FOR UPDATE`,
    tenantId,
    input.domain,
    input.manufacturer_serial?.trim() || null,
    input.hospital_asset_id?.trim() || null,
  );
  const existing = first(existingRows);
  if (!existing) throw AppError.conflict('Device identity is already registered', 'RPD_EXTERNAL_REF_TAKEN');
  if (existing.manufacturer !== input.manufacturer
    || existing.model_name !== input.model_name
    || Number(existing.protocol_device_scope_id) !== Number(scope.id)) {
    throw AppError.conflict('Registered device identity does not match the approved scope',
      'RPD_EXTERNAL_REF_TAKEN');
  }
  return existing;
}

export async function reserveDeviceTx(tx, {
  tenantId,
  deviceId,
  expectedVersion,
  patientUid,
  owner,
  captureSource,
  captureProvenance = 'live',
  reuseScreen,
  preUseResidualTest = null,
  actor,
  operation = {},
}) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  const transition = deviceTransition(device.status, 'reserve');
  if (!transition.ok) throw AppError.conflict('Device is not available for capture', 'RPD_DEVICE_NOT_READY');
  const usageRows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessable_device_usages (
       tenant_id, domain, device_id, patient_uid, dialysis_session_id, ot_schedule_id,
       instrument_set_id, set_issue_log_id, ready_processing_event_id, reuse_cycle,
       captured_by, capture_source, capture_provenance, pre_use_residual_test, reuse_screen
     ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10,
       $11::uuid, $12, $13, $14, $15::jsonb)
     RETURNING *`,
    tenantId,
    device.domain,
    Number(device.id),
    patientUid,
    owner.dialysis_session_id ?? null,
    owner.ot_schedule_id ?? null,
    owner.instrument_set_id ?? null,
    owner.set_issue_log_id ?? null,
    device.last_processing_event_id ?? null,
    Number(device.cycle_count),
    actor.uid,
    captureSource,
    captureProvenance,
    preUseResidualTest,
    JSON.stringify(reuseScreen ?? null),
  );
  const usage = first(usageRows);
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: 'in_case',
    action: 'reserve',
    operation,
    extraSet: ', current_usage_id = $10',
    extraValues: [usage.id],
    resultSummary: { usage_id: usage.id },
  });
  return { usage, device: changed, receipt: changed.receipt ?? null };
}

export async function admitActualUseTx(tx, { tenantId, deviceId, expectedVersion }) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  if (device.status !== 'in_case' || !device.current_usage_id) {
    throw AppError.conflict('Device has no captured use to start', 'RPD_DEVICE_NOT_CAPTURED');
  }
  const activeHolds = await tx.$queryRawUnsafe(
    `SELECT id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active'
      ORDER BY id FOR UPDATE`,
    tenantId,
    Number(device.id),
  );
  if ((activeHolds ?? []).length > 0) {
    throw AppError.conflict('An active hold prevents use', 'RPD_ACTIVE_HOLD');
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages
        SET actual_use_started_at = COALESCE(actual_use_started_at, clock_timestamp()),
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3
      RETURNING *`,
    tenantId,
    Number(device.current_usage_id),
    Number(device.id),
  );
  return first(rows);
}

export async function returnDeviceTx(tx, {
  tenantId,
  deviceId,
  expectedVersion,
  disposition,
  postUseScreen = null,
  actor,
  operation = {},
}) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  if (!device.current_usage_id || device.status !== 'in_case') {
    throw AppError.conflict('Device has no open use to return', 'RPD_RETURN_REQUIRED');
  }
  const usageRows = await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages
        SET returned_at = clock_timestamp(), returned_by = $4::uuid,
            post_use_disposition = $5, post_use_screen = $6::jsonb,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3 AND returned_at IS NULL
      RETURNING *`,
    tenantId,
    Number(device.current_usage_id),
    Number(device.id),
    actor.uid,
    disposition,
    JSON.stringify(postUseScreen),
  );
  const usage = first(usageRows);
  if (!usage) throw AppError.conflict('Device use is already returned', 'RPD_RETURN_REQUIRED');
  const holdRows = await tx.$queryRawUnsafe(
    `SELECT id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active'
      ORDER BY id FOR UPDATE`,
    tenantId,
    Number(device.id),
  );
  const held = (holdRows ?? []).length > 0;
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: held ? 'quarantined' : 'awaiting_reprocessing',
    action: 'return',
    operation,
    extraSet: ", current_usage_id = NULL, residual_test_pending = TRUE, quarantine_reason = CASE WHEN $3 = 'quarantined' THEN COALESCE(quarantine_reason, 'manual') ELSE quarantine_reason END",
    resultSummary: { usage_id: usage.id, disposition, held },
  });
  return { usage, device: changed, receipt: changed.receipt ?? null };
}

export async function discardDeviceTx(tx, {
  tenantId,
  deviceId,
  expectedVersion,
  reason,
  note = null,
  actor,
  operation = {},
}) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  if (!deviceTransition(device.status, 'discard').ok) {
    throw AppError.conflict('Device is already discarded', 'RPD_DEVICE_DISCARDED');
  }
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: 'discarded',
    action: 'discard',
    operation,
    extraSet: ', current_usage_id = NULL, discard_reason = $10, discard_note = $11, discarded_at = clock_timestamp(), discarded_by = $12::uuid',
    extraValues: [reason, note, actor.uid],
    resultSummary: { discard_reason: reason },
  });
  return { device: changed, receipt: changed.receipt ?? null };
}

export async function deviceLabelTx(tx, { tenantId, deviceId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, device_tag, domain, category, manufacturer, model_name,
            cycle_count, max_cycles_snapshot, status
       FROM reprocessable_devices
      WHERE tenant_id = $1::uuid AND id = $2`,
    tenantId,
    positiveId(deviceId, 'device_id'),
  );
  const device = first(rows);
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  return device;
}

export async function placeHoldTx(tx, {
  tenantId,
  deviceId,
  holdType,
  reasonCode,
  placedVia,
  placedBy = null,
  sourceMarkerRowId = null,
  sourceLoadId = null,
  sourceUsageId = null,
  note = null,
  pendingReturn = null,
  expectedVersion,
  operation = {},
}) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  if (device.status === 'discarded') {
    throw AppError.conflict('A discarded device cannot receive a hold', 'RPD_DEVICE_DISCARDED');
  }
  const shouldPend = pendingReturn ?? device.status === 'in_case';
  const holdRows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessable_device_holds (
       tenant_id, domain, device_id, hold_type, reason_code, pending_return,
       source_marker_row_id, source_load_id, source_usage_id, note, placed_by, placed_via
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12)
     ON CONFLICT (tenant_id, device_id, hold_type) WHERE status = 'active'
     DO UPDATE SET
       pending_return = reprocessable_device_holds.pending_return OR EXCLUDED.pending_return,
       updated_at = clock_timestamp()
     RETURNING *`,
    tenantId,
    device.domain,
    Number(device.id),
    holdType,
    reasonCode,
    shouldPend,
    sourceMarkerRowId,
    sourceLoadId,
    sourceUsageId,
    note,
    placedBy,
    placedVia,
  );
  const hold = first(holdRows);
  const status = device.status === 'in_case' || device.status === 'quarantined'
    ? device.status
    : 'quarantined';
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status,
    action: 'place_hold',
    operation,
    extraSet: ", quarantine_reason = CASE WHEN $3 = 'quarantined' THEN $10 ELSE quarantine_reason END, quarantined_at = CASE WHEN $3 = 'quarantined' THEN clock_timestamp() ELSE quarantined_at END",
    extraValues: [holdType === 'prion_exposure' ? 'prion_hold' : (
      holdType === 'bloodborne_exposure' ? 'exposure_hold' : holdType
    )],
    resultSummary: { hold_id: hold?.id, hold_type: holdType, reason_code: reasonCode },
  });
  return { hold, device: changed, receipt: changed.receipt ?? null };
}

export async function releaseHoldTx(tx, {
  tenantId,
  holdId,
  expectedVersion,
  actor,
  approval,
  operation = {},
}) {
  const holdRows = await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND id = $2
      FOR UPDATE`,
    tenantId,
    positiveId(holdId, 'hold_id'),
  );
  const hold = first(holdRows);
  if (!hold) throw AppError.notFound('Device hold not found', 'RPD_HOLD_NOT_FOUND');
  if (hold.status !== 'active') {
    throw AppError.conflict('Device hold is already settled', 'RPD_HOLD_SETTLED');
  }
  const device = await lockDeviceTx(tx, tenantId, hold.device_id);
  assertVersion(device, expectedVersion);
  const authority = assertHoldReleaseAuthority({
    holdType: hold.hold_type,
    actorRole: actor?.role,
    approverRole: approval?.approved_role,
  });
  if (!approval?.approved_by || !approval?.approved_at || !String(approval?.adjudication ?? '').trim()) {
    throw AppError.badRequest('Hold release approval is incomplete', 'RPD_HOLD_RELEASE_APPROVAL_REQUIRED');
  }
  if (approval.requires_processing !== false && !approval.protocol_id) {
    throw AppError.badRequest('A processing protocol is required for hold release',
      'RPD_HOLD_RELEASE_PROTOCOL_REQUIRED');
  }
  if (!authority.administrativeApplication && actor.uid !== approval.approved_by) {
    throw AppError.conflict(
      'The accountable approver must apply their own hold decision',
      'RPD_ACCOUNTABLE_APPROVAL_REQUIRED',
    );
  }
  const evidence = {
    ...(approval.evidence ?? {}),
    accountable_approval: {
      approved_by: approval.approved_by,
      approved_role: approval.approved_role,
      approved_at: approval.approved_at,
    },
    administrative_applicator: actor?.role === 'ADMIN' || actor?.role === 'SUPER_ADMIN'
      ? { applied_by: actor.uid, applied_role: actor.role }
      : null,
  };
  const releasedRows = await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_holds
        SET status = 'released', released_at = clock_timestamp(), released_by = $3::uuid,
            released_role = $4, release_adjudication = $5, release_protocol_id = $6,
            release_evidence = $7::jsonb, release_requires_processing = $8,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2 AND status = 'active'
      RETURNING *`,
    tenantId,
    Number(hold.id),
    actor.uid,
    actor.role,
    approval.adjudication.trim(),
    approval.protocol_id ?? null,
    JSON.stringify(evidence),
    approval.requires_processing !== false,
  );
  const released = first(releasedRows);
  const nextStatus = device.status === 'quarantined' ? 'awaiting_reprocessing' : device.status;
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: nextStatus,
    action: 'release_hold',
    operation,
    extraSet: ", quarantine_reason = CASE WHEN $3 = 'awaiting_reprocessing' THEN NULL ELSE quarantine_reason END",
    resultSummary: { hold_id: released.id, status: 'released' },
  });
  return { hold: released, device: changed, receipt: changed.receipt ?? null };
}

export async function evaluateOutstandingObligationsTx(tx, {
  tenantId,
  deviceId,
  protocolId = null,
  protocolDeviceScopeId = null,
}) {
  const holds = await tx.$queryRawUnsafe(
    `SELECT id, status, release_requires_processing, satisfied_at, release_protocol_id
       FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2
        AND (status = 'active'
          OR (status = 'released' AND release_requires_processing = TRUE AND satisfied_at IS NULL))
      ORDER BY id`,
    tenantId,
    positiveId(deviceId, 'device_id'),
  );
  const deviceRows = await tx.$queryRawUnsafe(
    `SELECT d.*,
            EXISTS (
              SELECT 1 FROM device_processing_event_revisions r
               WHERE r.tenant_id = d.tenant_id
                 AND r.processing_event_id = d.last_processing_event_id
                 AND r.outcome IN ('failed', 'invalidated')
            ) AS readiness_invalidated,
            EXISTS (
              SELECT 1 FROM reprocessable_device_usages u
               WHERE u.tenant_id = d.tenant_id AND u.device_id = d.id
                 AND u.returned_at IS NOT NULL
                 AND u.post_use_processing_event_id IS NULL
                 AND u.post_use_disposition IS DISTINCT FROM 'cancelled_before_use'
            ) AS dirty_return
       FROM reprocessable_devices d
      WHERE d.tenant_id = $1::uuid AND d.id = $2`,
    tenantId,
    Number(deviceId),
  );
  const device = first(deviceRows);
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  const obligations = [];
  for (const hold of holds ?? []) {
    if (hold.status === 'active') obligations.push(`active_hold:${hold.id}`);
    else obligations.push(`released_hold_processing:${hold.id}`);
  }
  if (device.dirty_return) obligations.push('dirty_return');
  if (device.readiness_invalidated) obligations.push('readiness_invalidated');
  if (device.residual_test_pending) obligations.push('residual_test_pending');
  if (protocolDeviceScopeId != null
    && Number(device.protocol_device_scope_id) !== Number(protocolDeviceScopeId)) {
    obligations.push('protocol_device_scope_mismatch');
  }
  if ((holds ?? []).some((hold) => hold.status === 'released'
    && hold.release_protocol_id != null
    && Number(hold.release_protocol_id) !== Number(protocolId))) {
    obligations.push('release_protocol_mismatch');
  }
  return obligations;
}

export async function restoreUnusedCaptureTx(tx, {
  tenantId,
  deviceId,
  expectedVersion,
  packCondition,
  protocolId = null,
  protocolDeviceScopeId = null,
  actor,
  operation = {},
}) {
  if (packCondition == null || String(packCondition).trim() === '') {
    throw AppError.badRequest('pack_condition is required', 'RPD_PACK_CONDITION_REQUIRED');
  }
  if (!['sealed_unopened', 'not_connected'].includes(packCondition)) {
    throw AppError.badRequest('pack_condition is invalid', 'RPD_PACK_CONDITION_INVALID');
  }
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  if (device.status !== 'in_case' || !device.current_usage_id) {
    throw AppError.conflict('Only an unused captured device can be restored',
      'RPD_USAGE_NOT_CANCELLABLE');
  }
  const usageRows = await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_usages
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3
      FOR UPDATE`,
    tenantId,
    Number(device.current_usage_id),
    Number(device.id),
  );
  const usage = first(usageRows);
  if (!usage || usage.returned_at || usage.actual_use_started_at) {
    throw AppError.conflict('The device usage has already ended', 'RPD_USAGE_NOT_CANCELLABLE');
  }
  const activeHolds = await tx.$queryRawUnsafe(
    `SELECT id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active'
      ORDER BY id FOR UPDATE`,
    tenantId,
    Number(device.id),
  );
  const obligations = await evaluateOutstandingObligationsTx(tx, {
    tenantId,
    deviceId: device.id,
    protocolId,
    protocolDeviceScopeId: protocolDeviceScopeId ?? device.protocol_device_scope_id,
  });
  const held = (activeHolds ?? []).length > 0;
  const restored = packCondition === 'sealed_unopened' && obligations.length === 0;
  const usageResult = await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages
        SET returned_at = clock_timestamp(), returned_by = $4::uuid,
            post_use_disposition = 'cancelled_before_use', unopened_confirmation = $5,
            residual_evidence_cleared_at = CASE WHEN $5 = 'not_connected' THEN clock_timestamp() ELSE NULL END,
            post_use_recorded_by = $4::uuid, post_use_recorded_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3
      RETURNING *`,
    tenantId,
    Number(usage.id),
    Number(device.id),
    actor.uid,
    packCondition,
  );
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: held ? 'quarantined' : (restored ? 'available' : 'awaiting_reprocessing'),
    action: 'restore_unused_capture',
    operation,
    extraSet: ', current_usage_id = NULL, residual_test_pending = CASE WHEN $3 = \'available\' THEN residual_test_pending ELSE TRUE END',
    resultSummary: { pack_condition: packCondition, restored, held },
  });
  return {
    usage: first(usageResult),
    obligations,
    device: changed,
    receipt: changed.receipt ?? null,
  };
}

export async function releaseToAvailableTx(tx, {
  tenantId,
  deviceId,
  expectedVersion,
  actor,
  protocol,
  scope,
  evidence,
  occurrence,
  operation = {},
}) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  const criteria = evaluateReleaseCriteria({ protocol, scope, evidence });
  const eventRows = await tx.$queryRawUnsafe(
    `INSERT INTO device_processing_events (
       tenant_id, domain, device_id, kind, sterilization_load_id,
       dialyzer_reuse_register_id, attempt_id, protocol_id, cycle_type,
       initial_outcome, counts_cycle, sterility_evidence, function_evidence,
       device_last_returned_at, cycle_before, cycle_after,
       device_version_before, device_version_after, recorded_by, recorded_via, metadata
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE,
       $11::jsonb, $12::jsonb, $13::timestamptz, $14, $15, $16, $17,
       $18::uuid, $19, $20::jsonb
     ) RETURNING *`,
    tenantId,
    device.domain,
    Number(device.id),
    occurrence.kind,
    occurrence.sterilization_load_id ?? null,
    occurrence.dialyzer_reuse_register_id ?? null,
    occurrence.attempt_id ?? null,
    occurrence.protocol_id,
    occurrence.cycle_type,
    criteria.verdict === 'released' ? 'passed' : 'held',
    JSON.stringify(occurrence.sterility_evidence ?? {}),
    JSON.stringify(occurrence.function_evidence ?? {}),
    occurrence.device_last_returned_at ?? null,
    Number(device.cycle_count),
    Number(device.cycle_count) + 1,
    Number(device.version),
    Number(device.version) + 1,
    actor.uid,
    occurrence.recorded_via,
    JSON.stringify({ missing_evidence: criteria.missing_evidence }),
  );
  const event = first(eventRows);
  const obligations = await evaluateOutstandingObligationsTx(tx, {
    tenantId,
    deviceId: device.id,
    protocolId: occurrence.protocol_id,
    protocolDeviceScopeId: scope.id,
  });
  const released = criteria.verdict === 'released' && obligations.length === 0;
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: released ? 'available' : 'awaiting_reprocessing',
    action: 'record_processing',
    operation,
    extraSet: ', cycle_count = cycle_count + 1, last_processing_event_id = $10, last_reprocessed_at = clock_timestamp(), last_reprocessed_by = $11::uuid, last_cycle_type = $12',
    extraValues: [event.id, actor.uid, occurrence.cycle_type],
    resultSummary: { processing_event_id: event.id, verdict: criteria.verdict, released },
  });
  return { event, criteria, obligations, device: changed, receipt: changed.receipt ?? null };
}

export async function operationByIdTx(tx, { tenantId, operationId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT operation_id::text, action, device_id::text, version_before, version_after, audit_id
       FROM reprocessable_device_operations
      WHERE tenant_id = $1::uuid AND operation_id = $2::uuid`,
    tenantId,
    operationId,
  );
  return first(rows) ?? null;
}

export async function deviceHistoryTx(tx, { tenantId, deviceId }) {
  const id = positiveId(deviceId, 'device_id');
  const deviceRows = await tx.$queryRawUnsafe(
    'SELECT * FROM reprocessable_devices WHERE tenant_id = $1::uuid AND id = $2',
    tenantId,
    id,
  );
  const device = first(deviceRows);
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  const events = await tx.$queryRawUnsafe(
    `SELECT * FROM device_processing_events
      WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY recorded_at, id`,
    tenantId,
    id,
  );
  const holds = await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY placed_at, id`,
    tenantId,
    id,
  );
  return { device, events, holds };
}

export const _internal = Object.freeze({ assertVersion, lockDeviceTx, operationIdentity });
