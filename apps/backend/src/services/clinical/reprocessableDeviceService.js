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

function json(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
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
  actor = {},
  extraSet = '',
  extraValues = [],
  resultSummary = {},
}) {
  const identity = operationIdentity(action, operation);
  const versionAfter = Number(device.version) + 1;
  const actorUidParameter = 10 + extraValues.length;
  const actorRoleParameter = actorUidParameter + 1;
  const rows = await tx.$queryRawUnsafe(
    `WITH changed AS (
       UPDATE reprocessable_devices
          SET status = $3::varchar(32),
              version = $4,
              updated_at = clock_timestamp()
              ${extraSet}
        WHERE tenant_id = $1::uuid AND id = $2 AND version = $5
        RETURNING *
     ), audited AS (
       INSERT INTO audit_logs (tenant_id, uid, actor_uid, role, action, resource, resource_id, metadata)
       SELECT $1::uuid, $${actorUidParameter}::uuid, $${actorUidParameter}::uuid,
              $${actorRoleParameter}::text, $7::text, 'reprocessable_device', id::text, $9::jsonb
         FROM changed RETURNING id, resource_id
     ), receipt AS (
       INSERT INTO reprocessable_device_operations (
         tenant_id, operation_id, device_id, action, idempotency_key_hash,
         version_before, version_after, result_summary, audit_id
       )
       SELECT $1::uuid, $6::uuid, changed.id, $7, $8, $5, $4, $9::jsonb, audited.id
         FROM changed JOIN audited ON audited.resource_id = changed.id::text
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
    json(resultSummary),
    ...extraValues,
    actor.uid ?? null,
    actor.role ?? null,
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
  const initialCycleCount = Number(input.initial_cycle_count ?? 0);
  if (!Number.isSafeInteger(initialCycleCount) || initialCycleCount < 0) {
    throw AppError.badRequest('Initial cycle count must be a non-negative integer',
      'RPD_INITIAL_CYCLE_COUNT_INVALID');
  }
  if (input.max_cycles_snapshot != null && initialCycleCount > Number(input.max_cycles_snapshot)) {
    throw AppError.conflict('Initial cycle count exceeds the approved ceiling',
      'RPD_MAX_CYCLES_REACHED');
  }
  const identity = operationIdentity('register', operation);
  const rows = await tx.$queryRawUnsafe(
    `WITH inserted AS (
       INSERT INTO reprocessable_devices (
         tenant_id, domain, category, facility_id, manufacturer_serial,
         hospital_asset_id, manufacturer, model_name, protocol_device_scope_id,
         instrument_set_id, enrolled_via, max_cycles_snapshot, status, created_by, cycle_count, metadata
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid,
         $17, jsonb_build_object('enrolled_mid_life', $18::boolean))
       ON CONFLICT DO NOTHING
       RETURNING *
     ), audited AS (
       INSERT INTO audit_logs (tenant_id, uid, actor_uid, role, action, resource, resource_id, metadata)
       SELECT $1::uuid, $14::uuid, $14::uuid, $19::text, 'register', 'reprocessable_device', id::text,
              jsonb_build_object('domain', domain, 'category', category)
         FROM inserted RETURNING id, resource_id
     ), receipt AS (
       INSERT INTO reprocessable_device_operations (
         tenant_id, operation_id, device_id, action, idempotency_key_hash,
         version_before, version_after, result_summary, audit_id
       )
       SELECT $1::uuid, $15::uuid, inserted.id, 'register', $16, 0, version,
              jsonb_build_object('domain', domain, 'category', category), audited.id
         FROM inserted JOIN audited ON audited.resource_id = inserted.id::text
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
    initialCycleCount,
    initialCycleCount > 0,
    actor.role ?? null,
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
  if (device.residual_test_pending && preUseResidualTest !== 'negative') {
    throw AppError.conflict('A fresh negative residual test is required before capture',
      'RPD_RESIDUAL_TEST_REQUIRED');
  }
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
    json(reuseScreen ?? null),
  );
  const usage = first(usageRows);
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: 'in_case',
    action: 'reserve',
    actor,
    operation,
    extraSet: ', current_usage_id = $10, residual_test_pending = FALSE',
    extraValues: [usage.id],
    resultSummary: { usage_id: usage.id },
  });
  return { usage, device: changed, receipt: changed.receipt ?? null };
}

export async function admitActualUseTx(tx, { tenantId, deviceId, expectedVersion, operation = {}, actor = {} }) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  if (device.status !== 'in_case' || !device.current_usage_id) {
    throw AppError.conflict('Device has no captured use to start', 'RPD_DEVICE_NOT_CAPTURED');
  }
  const usages = await tx.$queryRawUnsafe(
    `SELECT id, actual_use_started_at, returned_at FROM reprocessable_device_usages
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3 FOR UPDATE`,
    tenantId, Number(device.current_usage_id), Number(device.id),
  );
  if (!usages[0] || usages[0].returned_at || usages[0].actual_use_started_at) {
    throw AppError.conflict('The captured use cannot be started', 'RPD_DEVICE_NOT_CAPTURED');
  }
  const activeHolds = await tx.$queryRawUnsafe(
    `SELECT id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active'
      ORDER BY id FOR UPDATE`,
    tenantId,
    Number(device.id),
  );
  if ((activeHolds ?? []).length > 0) {
    throw AppError.conflict('An active hold prevents use', 'RPD_HOLD_ACTIVE');
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
  const usage = first(rows);
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId, device, status: device.status, action: 'admit_actual_use', operation, actor,
    resultSummary: { usage_id: usage.id },
  });
  return { ...usage, device: changed, receipt: changed.receipt ?? null };
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
            pre_use_residual_test = NULL,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3 AND returned_at IS NULL
      RETURNING *`,
    tenantId,
    Number(device.current_usage_id),
    Number(device.id),
    actor.uid,
    disposition,
    json(postUseScreen),
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
    actor,
    operation,
    extraSet: ", current_usage_id = NULL, residual_test_pending = TRUE, quarantine_reason = CASE WHEN $3 = 'quarantined' THEN COALESCE(quarantine_reason, 'manual') ELSE quarantine_reason END",
    resultSummary: { usage_id: usage.id, disposition, held },
  });
  return { usage, device: changed, receipt: changed.receipt ?? null };
}

export async function recordRetrospectiveReturnTx(tx, {
  tenantId,
  deviceId,
  expectedVersion,
  usageId,
  exposureDetected = false,
  actor,
  operation = {},
}) {
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  const usages = await tx.$queryRawUnsafe(
    `SELECT id, capture_provenance, actual_use_started_at, returned_at
       FROM reprocessable_device_usages
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3 FOR UPDATE`,
    tenantId, positiveId(usageId, 'device_usage_id'), Number(device.id),
  );
  const usage = first(usages);
  if (!usage || usage.capture_provenance !== 'retrospective'
    || !usage.actual_use_started_at || !usage.returned_at) {
    throw AppError.conflict('Retrospective use must include the actual use and return times',
      'RPD_RETROSPECTIVE_USAGE_REQUIRED');
  }
  const holds = await tx.$queryRawUnsafe(
    `SELECT id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active' ORDER BY id FOR UPDATE`,
    tenantId, Number(device.id),
  );
  const held = holds.length > 0;
  const status = ['discarded', 'in_case'].includes(device.status) ? device.status
    : (held ? 'quarantined' : 'awaiting_reprocessing');
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId, device, status, action: 'record_retrospective_return', actor, operation,
    extraSet: ', residual_test_pending = TRUE, exposure_flag = exposure_flag OR $10::boolean',
    extraValues: [exposureDetected === true],
    resultSummary: { usage_id: usage.id, capture_provenance: 'retrospective', held,
      exposure_flag: device.exposure_flag || exposureDetected === true },
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
    actor,
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
    actor: { uid: placedBy },
    operation,
    extraSet: ", exposure_flag = exposure_flag OR $11::boolean, quarantine_reason = CASE WHEN $3 = 'quarantined' THEN $10 ELSE quarantine_reason END, quarantined_at = CASE WHEN $3 = 'quarantined' THEN clock_timestamp() ELSE quarantined_at END",
    extraValues: [holdType === 'prion_exposure' ? 'prion_hold' : (
      holdType === 'bloodborne_exposure' ? 'exposure_hold' : holdType
    ), holdType === 'bloodborne_exposure'],
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
  const references = await tx.$queryRawUnsafe(
    `SELECT device_id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND id = $2`,
    tenantId,
    positiveId(holdId, 'hold_id'),
  );
  const reference = first(references);
  if (!reference) throw AppError.notFound('Device hold not found', 'RPD_HOLD_NOT_FOUND');
  const device = await lockDeviceTx(tx, tenantId, reference.device_id);
  assertVersion(device, expectedVersion);
  const holdRows = await tx.$queryRawUnsafe(
    `SELECT id, device_id, hold_type, status FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3 FOR UPDATE`,
    tenantId, positiveId(holdId, 'hold_id'), Number(device.id),
  );
  const hold = first(holdRows);
  if (!hold) throw AppError.notFound('Device hold not found', 'RPD_HOLD_NOT_FOUND');
  if (hold.status !== 'active') {
    throw AppError.conflict('Device hold is already settled', 'RPD_HOLD_SETTLED');
  }
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
  if (hold.hold_type === 'prion_exposure' && approval.requires_processing === false) {
    throw AppError.conflict('A prion hold requires its authorised processing pathway',
      'RPD_HOLD_RELEASE_PROTOCOL_REQUIRED');
  }
  if ((!authority.administrativeApplication && actor.uid !== approval.approved_by)
    || (authority.administrativeApplication && actor.uid === approval.approved_by)) {
    throw AppError.conflict(
      'The accountable approver must apply their own hold decision',
      'RPD_ACCOUNTABLE_APPROVAL_REQUIRED',
    );
  }
  const approvers = await tx.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = $3
        AND is_active = TRUE AND status = 'active' FOR SHARE`,
    tenantId, approval.approved_by, approval.approved_role,
  );
  if (!first(approvers)) {
    throw AppError.conflict('The clinical approver does not currently hold the accountable role',
      'RPD_ACCOUNTABLE_APPROVAL_REQUIRED');
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
    json(evidence),
    approval.requires_processing !== false,
  );
  const released = first(releasedRows);
  const nextStatus = device.status === 'quarantined' ? 'awaiting_reprocessing' : device.status;
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: nextStatus,
    action: 'release_hold',
    actor,
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
  processingCandidate = null,
}) {
  const holds = await tx.$queryRawUnsafe(
    `SELECT h.id, h.status, h.release_requires_processing, h.satisfied_at, h.release_protocol_id
       FROM reprocessable_device_holds h
      WHERE h.tenant_id = $1::uuid AND h.device_id = $2
        AND (h.status = 'active'
          OR (h.status IN ('released', 'satisfied') AND h.release_requires_processing = TRUE
            AND NOT EXISTS (
              SELECT 1 FROM reprocessable_hold_satisfactions s
              JOIN device_processing_events e ON e.tenant_id = s.tenant_id
                AND e.id = s.processing_event_id AND e.device_id = s.device_id
               WHERE s.tenant_id = h.tenant_id AND s.hold_id = h.id AND s.device_id = h.device_id
                 AND s.required_protocol_id = h.release_protocol_id AND e.protocol_id = h.release_protocol_id
                 AND s.satisfied_at > h.released_at AND e.initial_outcome = 'passed'
                 AND NOT EXISTS (
                   SELECT 1 FROM device_processing_event_revisions r
                    WHERE r.tenant_id = e.tenant_id AND r.processing_event_id = e.id
                      AND r.outcome IN ('failed', 'invalidated')
                 )
            )
            AND NOT ($5::boolean AND h.hold_type <> 'prion_exposure'
              AND h.release_protocol_id = $3 AND h.released_at < $4::timestamptz)))
      ORDER BY h.id`,
    tenantId,
    positiveId(deviceId, 'device_id'),
    processingCandidate?.protocol_id ?? null,
    processingCandidate?.occurred_at ?? null,
    processingCandidate?.satisfies_holds === true,
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
                 AND (u.post_use_disposition IS DISTINCT FROM 'cancelled_before_use'
                   OR u.unopened_confirmation = 'not_connected')
                 AND NOT ($5::boolean AND u.id = $3::bigint AND u.returned_at <= $4::timestamptz)
                 AND NOT EXISTS (
                   SELECT 1 FROM device_processing_events e
                    WHERE e.tenant_id = u.tenant_id AND e.device_id = u.device_id
                      AND e.metadata ->> 'device_usage_id' = u.id::text
                      AND e.initial_outcome = 'passed'
                      AND (e.metadata ->> 'occurred_at')::timestamptz >= u.returned_at
                      AND NOT EXISTS (
                        SELECT 1 FROM device_processing_event_revisions r
                         WHERE r.tenant_id = e.tenant_id AND r.processing_event_id = e.id
                           AND r.outcome IN ('failed', 'invalidated')
                      )
                 )
            ) AS dirty_return
       FROM reprocessable_devices d
      WHERE d.tenant_id = $1::uuid AND d.id = $2`,
    tenantId,
    Number(deviceId),
    processingCandidate?.device_usage_id ?? null,
    processingCandidate?.occurred_at ?? null,
    processingCandidate?.clears_dirty === true,
  );
  const device = first(deviceRows);
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  const obligations = [];
  for (const hold of holds ?? []) {
    if (hold.status === 'active') obligations.push(`active_hold:${hold.id}`);
    else obligations.push(`released_hold_processing:${hold.id}`);
  }
  if (device.dirty_return) obligations.push('dirty_return');
  if (device.readiness_invalidated && !processingCandidate?.satisfies_holds) obligations.push('readiness_invalidated');
  if (device.residual_test_pending && !processingCandidate?.satisfies_holds) obligations.push('residual_test_pending');
  if (protocolDeviceScopeId != null
    && Number(device.protocol_device_scope_id) !== Number(protocolDeviceScopeId)) {
    obligations.push('protocol_device_scope_mismatch');
  }
  if ((holds ?? []).some((hold) => hold.status !== 'active'
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
            pre_use_residual_test = NULL, updated_at = clock_timestamp()
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
    actor,
    operation,
    extraSet: ', current_usage_id = NULL, residual_test_pending = CASE WHEN $3 = \'available\' THEN residual_test_pending OR $10::boolean ELSE TRUE END',
    extraValues: [usage.pre_use_residual_test === 'negative'],
    resultSummary: { pack_condition: packCondition, restored, held },
  });
  return {
    usage: first(usageResult),
    obligations,
    device: changed,
    receipt: changed.receipt ?? null,
  };
}

export function evaluateProcessingCriteria({ protocol, scope, evidence }) {
  return evaluateReleaseCriteria({
    protocol: protocol?.domain === 'dialysis' ? { ...protocol, residual_test_required: false } : protocol,
    scope,
    evidence,
  });
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
  recordingMode = 'prospective',
  eligibility = null,
  prepareOccurrence = null,
  operation = {},
}) {
  if (!['prospective', 'performed'].includes(recordingMode)) {
    throw AppError.badRequest('Processing recording mode must be prospective or performed',
      'RPD_PROCESSING_RECORDING_MODE_INVALID');
  }
  const device = await lockDeviceTx(tx, tenantId, deviceId);
  assertVersion(device, expectedVersion);
  const overCeiling = device.max_cycles_snapshot != null
    && Number(device.cycle_count) >= Number(device.max_cycles_snapshot);
  if (overCeiling && recordingMode === 'prospective') {
    throw AppError.conflict('The approved reprocessing ceiling has been reached', 'RPD_MAX_CYCLES_REACHED');
  }
  const usageId = occurrence.device_usage_id;
  if (device.domain === 'dialysis' && usageId == null) {
    throw AppError.badRequest('Dialysis processing requires its ended use', 'RPD_DIALYSIS_USAGE_REQUIRED');
  }
  const usages = usageId == null ? [] : await tx.$queryRawUnsafe(
    `SELECT id, returned_at, post_use_processing_event_id FROM reprocessable_device_usages
      WHERE tenant_id = $1::uuid AND device_id = $2 AND id = $3 FOR UPDATE`,
    tenantId, Number(device.id), positiveId(usageId, 'device_usage_id'),
  );
  const usage = first(usages);
  if (usageId != null && !usage) {
    throw AppError.notFound('The matching device usage was not found', 'RPD_DIALYSIS_USAGE_REQUIRED');
  }
  if (device.current_usage_id || (usage && !usage.returned_at)) {
    throw AppError.conflict('Device use must end before processing', 'RPD_USE_NOT_ENDED');
  }
  await tx.$queryRawUnsafe(
    `SELECT id FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2 AND status IN ('active', 'released', 'satisfied')
      ORDER BY id FOR UPDATE`,
    tenantId, Number(device.id),
  );
  const clockRows = await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now');
  const occurredAt = new Date(occurrence.occurred_at ?? occurrence.completed_at ?? first(clockRows).now);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw AppError.badRequest('Processing occurrence time is invalid', 'RPD_PROCESSING_TIME_INVALID');
  }
  const physicalCriteria = evaluateProcessingCriteria({ protocol, scope, evidence });
  const policyRows = await tx.$queryRawUnsafe(
    `SELECT p.reprocessable, p.protocol_id, p.allowed_cycle_types, p.tcv_min_pct,
            r.status AS protocol_status
       FROM reprocessing_domain_policies p
       LEFT JOIN reprocessing_protocols r ON r.tenant_id = p.tenant_id AND r.id = p.protocol_id
      WHERE p.tenant_id = $1::uuid AND p.domain = $2 AND p.category = $3 FOR SHARE OF p`,
    tenantId, device.domain, device.category,
  );
  const policy = first(policyRows);
  const authorizationObligations = [];
  if (overCeiling) authorizationObligations.push('max_cycles_reached');
  if (!policy?.reprocessable || policy.protocol_status !== 'active') {
    authorizationObligations.push('policy_inactive');
  }
  if (Number(policy?.protocol_id) !== Number(occurrence.protocol_id)
    || Number(protocol?.id) !== Number(occurrence.protocol_id)
    || Number(scope?.protocol_id) !== Number(occurrence.protocol_id)
    || Number(scope?.id) !== Number(device.protocol_device_scope_id)
    || scope?.manufacturer !== device.manufacturer || scope?.model_name !== device.model_name) {
    authorizationObligations.push('protocol_device_scope_mismatch');
  }
  if (!policy?.allowed_cycle_types?.includes(occurrence.cycle_type)) {
    authorizationObligations.push('cycle_type_not_allowed');
  }
  if (usage && occurredAt < new Date(usage.returned_at)) {
    authorizationObligations.push('processing_before_return');
  }
  if (device.status === 'discarded') authorizationObligations.push('device_discarded');
  if ((device.domain === 'dialysis' || eligibility != null) && eligibility?.verdict !== 'eligible') {
    authorizationObligations.push(...(eligibility?.reason_codes?.length
      ? eligibility.reason_codes : ['reuse_not_established']));
  }
  if (policy?.tcv_min_pct != null
    && (Number(evidence.measured_tcv_ml) / Number(evidence.baseline_tcv_ml)) * 100 < Number(policy.tcv_min_pct)) {
    authorizationObligations.push('tcv_threshold');
  }
  const passingApplicable = physicalCriteria.verdict === 'released' && authorizationObligations.length === 0;
  const previewObligations = [...new Set([
    ...await evaluateOutstandingObligationsTx(tx, {
      tenantId, deviceId: device.id, protocolId: occurrence.protocol_id, protocolDeviceScopeId: scope?.id,
      processingCandidate: {
        protocol_id: occurrence.protocol_id, device_usage_id: usage?.id ?? null,
        occurred_at: occurredAt.toISOString(), satisfies_holds: passingApplicable,
        clears_dirty: physicalCriteria.verdict === 'released' && usage != null,
      },
    }),
    ...authorizationObligations,
  ])];
  const previewCriteria = passingApplicable && previewObligations.length === 0
    ? { verdict: 'released', missing_evidence: [] }
    : { verdict: 'not_established',
      missing_evidence: [...new Set([...physicalCriteria.missing_evidence, ...previewObligations])] };
  if (prepareOccurrence) {
    const prepared = await prepareOccurrence({ criteria: previewCriteria, obligations: previewObligations });
    occurrence = { ...occurrence,
      attempt_id: prepared?.attempt_id ?? occurrence.attempt_id,
      dialyzer_reuse_register_id: prepared?.dialyzer_reuse_register_id ?? occurrence.dialyzer_reuse_register_id };
  }
  const eventRows = await tx.$queryRawUnsafe(
    `INSERT INTO device_processing_events (
       tenant_id, domain, device_id, kind, sterilization_load_id,
       dialyzer_reuse_register_id, attempt_id, protocol_id, cycle_type,
       initial_outcome, counts_cycle, sterility_evidence, function_evidence,
       device_last_returned_at, cycle_before, cycle_after,
       device_version_before, device_version_after, recorded_by, recorded_via, metadata, over_ceiling
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE,
       $11::jsonb, $12::jsonb, $13::timestamptz, $14, $15, $16, $17,
       $18::uuid, $19, $20::jsonb, $21::boolean
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
    physicalCriteria.verdict === 'released' ? 'passed' : 'held',
    json(occurrence.sterility_evidence ?? {}),
    json(occurrence.function_evidence ?? {}),
    usage?.returned_at ?? occurrence.device_last_returned_at ?? null,
    Number(device.cycle_count),
    Number(device.cycle_count) + 1,
    Number(device.version),
    Number(device.version) + 1,
    actor.uid,
    occurrence.recorded_via,
    json({ missing_evidence: physicalCriteria.missing_evidence,
      device_usage_id: usage?.id ?? null, occurred_at: occurredAt.toISOString(), recording_mode: recordingMode }),
    overCeiling,
  );
  const event = first(eventRows);
  if (usage) {
    await tx.$queryRawUnsafe(
      `UPDATE reprocessable_device_usages
          SET post_use_processing_event_id = COALESCE(post_use_processing_event_id, $4),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2 AND device_id = $3 RETURNING id`,
      tenantId, Number(usage.id), Number(device.id), Number(event.id),
    );
  }
  if (physicalCriteria.verdict === 'released' && authorizationObligations.length === 0) {
    await tx.$queryRawUnsafe(
      `WITH eligible AS (
         SELECT h.id, h.device_id, h.release_protocol_id
           FROM reprocessable_device_holds h
          WHERE h.tenant_id = $1::uuid AND h.device_id = $2 AND h.status IN ('released', 'satisfied')
            AND h.release_requires_processing = TRUE
            AND NOT EXISTS (
              SELECT 1 FROM reprocessable_hold_satisfactions s
              JOIN device_processing_events e ON e.tenant_id = s.tenant_id
                AND e.id = s.processing_event_id AND e.device_id = s.device_id
               WHERE s.tenant_id = h.tenant_id AND s.hold_id = h.id AND s.device_id = h.device_id
                 AND s.required_protocol_id = h.release_protocol_id AND e.protocol_id = h.release_protocol_id
                 AND s.satisfied_at > h.released_at AND e.initial_outcome = 'passed'
                 AND NOT EXISTS (
                   SELECT 1 FROM device_processing_event_revisions r
                    WHERE r.tenant_id = e.tenant_id AND r.processing_event_id = e.id
                      AND r.outcome IN ('failed', 'invalidated')
                 )
            )
            AND h.release_protocol_id = $3 AND h.released_at < $5::timestamptz
            AND h.hold_type <> 'prion_exposure'
          ORDER BY h.id FOR UPDATE
       ), appended AS (
         INSERT INTO reprocessable_hold_satisfactions (
           tenant_id, hold_id, device_id, required_protocol_id, processing_event_id, satisfied_at, recorded_by
         ) SELECT $1::uuid, id, device_id, release_protocol_id, $4, $5::timestamptz, $6::uuid
             FROM eligible ON CONFLICT DO NOTHING RETURNING hold_id, satisfied_at
       )
       UPDATE reprocessable_device_holds h SET status = 'satisfied', satisfied_at = a.satisfied_at,
              updated_at = clock_timestamp()
         FROM appended a WHERE h.tenant_id = $1::uuid AND h.id = a.hold_id RETURNING h.id`,
      tenantId, Number(device.id), Number(occurrence.protocol_id), Number(event.id),
      occurredAt.toISOString(), actor.uid,
    );
  }
  let obligations = await evaluateOutstandingObligationsTx(tx, {
    tenantId,
    deviceId: device.id,
    protocolId: occurrence.protocol_id,
    protocolDeviceScopeId: scope?.id,
  });
  if (passingApplicable) {
    obligations = obligations.filter((obligation) => (
      obligation !== 'readiness_invalidated' && obligation !== 'residual_test_pending'
    ));
  }
  obligations = [...new Set([...obligations, ...authorizationObligations])];
  const released = passingApplicable && obligations.length === 0;
  const held = obligations.some((obligation) => obligation.startsWith('active_hold:'));
  const criteria = released ? { verdict: 'released', missing_evidence: [] } : {
    verdict: 'not_established',
    missing_evidence: [...new Set([...physicalCriteria.missing_evidence, ...obligations])],
  };
  if (json(criteria) !== json(previewCriteria)) {
    throw AppError.conflict('Processing obligations changed during the atomic occurrence command',
      'RPD_PROCESSING_ASSESSMENT_CHANGED');
  }
  const changed = await updateDeviceWithReceiptTx(tx, {
    tenantId,
    device,
    status: device.status === 'discarded' ? 'discarded'
      : (released ? 'available' : (held ? 'quarantined' : 'awaiting_reprocessing')),
    action: 'record_processing',
    actor,
    operation,
    extraSet: `, cycle_count = cycle_count + 1,
      last_processing_event_id = CASE WHEN $13::boolean THEN $10 ELSE last_processing_event_id END,
      last_reprocessed_at = $14::timestamptz, last_reprocessed_by = $11::uuid, last_cycle_type = $12,
      residual_test_pending = CASE WHEN $13::boolean THEN $15::boolean ELSE residual_test_pending END,
      quarantine_reason = CASE WHEN $13::boolean THEN NULL ELSE quarantine_reason END`,
    extraValues: [event.id, actor.uid, occurrence.cycle_type, released, occurredAt.toISOString(),
      device.domain === 'dialysis' && protocol.residual_test_required === true],
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
