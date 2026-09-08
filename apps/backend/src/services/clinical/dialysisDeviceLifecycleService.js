import crypto from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DIALYSIS_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import {
  registerDeviceTx, reserveDeviceTx, admitActualUseTx, returnDeviceTx,
  restoreUnusedCaptureTx, releaseToAvailableTx, placeHoldTx, discardDeviceTx,
  evaluateOutstandingObligationsTx, recordRetrospectiveReturnTx,
} from './reprocessableDeviceService.js';
import { evaluateDeviceEligibility } from './reprocessableDeviceRules.js';
import { isolationDecisionTx, reuseEligibilityTx } from './dialysisReuseService.js';
import { lockPatientExposureTx, lockDeviceExposurePatientsTx } from './patientExposureLock.js';
import { reconcileExposureAdmissionTx } from './bloodborneExposureOutboxService.js';
import { recordPredatingExposureOutcomesTx } from './platformReprocessableExposureHandler.js';
import { projectUsageForRole } from './reprocessableDeviceProjection.js';

const first = (rows) => Array.isArray(rows) ? rows[0] : rows;
const jsonValue = (value) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry));

function actorRequired(actor) {
  if (!actor?.uid || !DIALYSIS_ROUTE_ROLES.includes(actor.role)) {
    throw AppError.forbidden('Role cannot operate a dialysis device', 'RPD_DOMAIN_ROLE_FORBIDDEN');
  }
}

function operationalDecision(decision) {
  if (!decision) return null;
  if (!['restricted', 'clear', 'unknown'].includes(decision.status)
    || !['marker', 'legacy_declaration', 'none'].includes(decision.evidence)
    || !Number.isFinite(Date.parse(decision.asOf))
    || (decision.evidence_dated_on != null && !/^\d{4}-\d{2}-\d{2}$/.test(decision.evidence_dated_on))) {
    throw AppError.internal('Stored isolation evidence is invalid', 'RPD_ISOLATION_DECISION_INVALID');
  }
  return {
    contract_version: decision.contract_version, status: decision.status,
    evidence: decision.evidence, evidence_dated_on: decision.evidence_dated_on,
    asOf: decision.asOf, reasons: [],
  };
}

function commandHash(body) {
  const clean = Object.fromEntries(Object.entries(body)
    .filter(([key]) => !['expected_version', 'idempotency_key', 'operation', 'actor', 'actorRole'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  return crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex');
}

function receipt(row) {
  if (!row) return null;
  return jsonValue(Object.fromEntries(['operation_id', 'action', 'device_id', 'version_before', 'version_after', 'audit_id']
    .map((key) => [key, row[key] ?? null])));
}

function deviceView(device) {
  return jsonValue(Object.fromEntries([
    'id', 'device_tag', 'domain', 'category', 'manufacturer_serial', 'manufacturer',
    'model_name', 'status', 'cycle_count', 'max_cycles_snapshot', 'version',
    'exposure_flag', 'residual_test_pending', 'current_usage_id', 'last_processing_event_id',
  ].map((key) => [key, device[key] ?? null])));
}

function usageView(usage, role = 'NURSE') {
  if (!usage) return null;
  const projected = projectUsageForRole(usage, role);
  projected.reuse_screen = operationalDecision(projected.reuse_screen);
  projected.post_use_screen = operationalDecision(projected.post_use_screen);
  return jsonValue(Object.fromEntries([
    'id', 'device_id', 'dialysis_session_id', 'patient_uid', 'reuse_cycle',
    'capture_source', 'capture_provenance', 'captured_at', 'actual_use_started_at',
    'returned_at', 'post_use_disposition', 'reuse_screen', 'post_use_screen',
    'pre_use_residual_test', 'ready_processing_event_id', 'post_use_processing_event_id',
  ].map((key) => [key, projected[key] ?? null])));
}

function replayView(response, actor) {
  return { ...response, device: deviceView(response.device), usage: usageView(response.usage, actor.role) };
}

async function eventTx(tx, { tenantId, session, actor, action, sourceId, sourceTable = 'reprocessable_device_usages', payload = {} }) {
  return recordCanonicalClinicalEvent({
    tenantId, patientUid: session.patient_uid, eventType: action,
    sourceTable, sourceId: String(sourceId),
    actorUid: actor?.uid ?? null, actorRole: actor?.role ?? null,
    summary: 'Dialysis device lifecycle recorded', visibleToPatient: false,
    payload: jsonValue({ session_id: session.id, ...payload }),
    timelineIdempotencyKey: `rpd:${tenantId}:${action}:${sourceId}`,
    auditIdempotencyKey: `rpd:${tenantId}:${action}:${sourceId}:audit`,
  }, { db: tx });
}

async function acknowledgementTx(tx, { tenantId, patientUid, actor, reason, decision, usageId }) {
  if (!String(reason ?? '').trim()) return;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO medication_safety_reviews
      (tenant_id,patient_uid,review_type,severity,status,finding_code,message,override_required,
       override_reason,overridden_by,overridden_at,payload,created_by)
     VALUES ($1::uuid,$2::uuid,'reprocessable_device_reuse','high','overridden',$3,
       'Dialysis reuse evidence acknowledged',TRUE,$4,$5::uuid,clock_timestamp(),$6::jsonb,$5::uuid) RETURNING id`,
    tenantId, patientUid,
    decision.status === 'restricted' ? 'BLOODBORNE_RESTRICTED_OVERRIDE' : 'SEROLOGY_UNKNOWN_ACKNOWLEDGED',
    reason.trim(), actor.uid, JSON.stringify({ domain: 'dialysis', usage_id: String(usageId) }),
  );
  if (rows.length !== 1) throw AppError.internal('Reuse acknowledgement was not recorded', 'RPD_ACKNOWLEDGEMENT_WRITE_REQUIRED');
}

export async function sessionSubjectTx(tx, { tenantId, sessionId, lock = false }) {
  const row = first(await tx.$queryRawUnsafe(
    `SELECT s.*, p.patient_uid FROM dialysis_sessions s
       JOIN dialysis_patients p ON p.tenant_id = s.tenant_id AND p.id = s.dialysis_patient_id
      WHERE s.tenant_id = $1::uuid AND s.id = $2::int ${lock ? 'FOR UPDATE OF s' : ''}`,
    tenantId, Number(sessionId),
  ));
  if (!row) throw AppError.notFound('Session not found');
  return row;
}

export async function lockDialysisSessionTx(tx, { tenantId, sessionId }) {
  const subject = await sessionSubjectTx(tx, { tenantId, sessionId });
  const usage = first(await tx.$queryRawUnsafe(
    `SELECT device_id FROM reprocessable_device_usages
      WHERE tenant_id = $1::uuid AND dialysis_session_id = $2::int
      ORDER BY id DESC LIMIT 1`, tenantId, Number(sessionId),
  ));
  const lockedPatientUids = usage
    ? await lockDeviceExposurePatientsTx(tx, { tenantId, patientUid: subject.patient_uid, deviceId: usage.device_id })
    : (await lockPatientExposureTx(tx, { tenantId, patientUid: subject.patient_uid }), [subject.patient_uid]);
  const session = await sessionSubjectTx(tx, { tenantId, sessionId, lock: true });
  if (session.patient_uid !== subject.patient_uid) {
    throw AppError.conflict('Session patient changed', 'RPD_SESSION_PATIENT_CHANGED');
  }
  return { session, lockedPatientUids };
}

async function policyTx(tx, tenantId, device = null, { allowInactive = false } = {}) {
  let policy = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessing_domain_policies
      WHERE tenant_id = $1::uuid AND domain = 'dialysis' AND category = 'dialyser' FOR SHARE`, tenantId,
  ));
  if (!policy && !device) {
    const enrolled = first(await tx.$queryRawUnsafe(
      `SELECT id FROM reprocessable_devices WHERE tenant_id = $1::uuid
        AND domain = 'dialysis' AND category = 'dialyser' LIMIT 1`, tenantId,
    ));
    if (!enrolled) return null;
    if (allowInactive) return { policy: { reprocessable: false }, protocol: null, scope: null };
    throw AppError.conflict('Dialyser policy is deactivated', 'RPD_POLICY_DEACTIVATED');
  }
  if ((!policy || !policy.reprocessable) && !allowInactive) {
    throw AppError.conflict('Dialyser policy is deactivated', 'RPD_POLICY_DEACTIVATED');
  }
  const scope = device ? first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessing_protocol_device_scopes
      WHERE tenant_id = $1::uuid AND id = $2 FOR SHARE`, tenantId, Number(device.protocol_device_scope_id),
  )) : null;
  policy ??= { reprocessable: false, protocol_id: scope?.protocol_id, max_cycles: device?.max_cycles_snapshot };
  const protocol = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessing_protocols WHERE tenant_id = $1::uuid AND id = $2 FOR SHARE`,
    tenantId, Number(allowInactive && scope ? scope.protocol_id : policy.protocol_id),
  ));
  if (!protocol || (!allowInactive && protocol.status !== 'active')) {
    throw AppError.conflict('An active protocol is required', 'RPD_PROTOCOL_REQUIRED');
  }
  const settings = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessing_domain_settings WHERE tenant_id = $1::uuid AND domain = 'dialysis'`, tenantId,
  )) ?? { unknown_serology_rule: 'warn', reactive_patient_rule: 'quarantine' };
  return { policy, protocol, settings, scope };
}

async function deviceAndUsageTx(tx, { tenantId, sessionId, deviceId }) {
  const reference = first(await tx.$queryRawUnsafe(
    `SELECT id, device_id FROM reprocessable_device_usages
      WHERE tenant_id = $1::uuid AND ($2::int IS NULL OR dialysis_session_id = $2::int)
        AND ($3::bigint IS NULL OR device_id = $3::bigint) ORDER BY id DESC LIMIT 1`,
    tenantId, sessionId == null ? null : Number(sessionId), deviceId == null ? null : Number(deviceId),
  ));
  if (!reference) return null;
  const device = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_devices WHERE tenant_id = $1::uuid AND id = $2 FOR UPDATE`,
    tenantId, Number(reference.device_id),
  ));
  const usage = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND id = $2 FOR UPDATE`,
    tenantId, Number(reference.id),
  ));
  const holds = await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_holds WHERE tenant_id = $1::uuid AND device_id = $2
      AND status IN ('active', 'released') ORDER BY id FOR UPDATE`, tenantId, Number(device.id),
  );
  const link = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_dialysis_links WHERE tenant_id = $1::uuid AND device_id = $2 FOR UPDATE`,
    tenantId, Number(device.id),
  ));
  return { device, usage, holds, link };
}

function assertDedication(link, patientUid) {
  if (!link || !patientUid || String(link.dedicated_patient_uid).toLowerCase() !== String(patientUid).toLowerCase()) {
    throw AppError.conflict('Dialyser is dedicated to another patient', 'DIALYSER_DEDICATED_TO_ANOTHER_PATIENT');
  }
}

function unknownAcknowledged(eligibility, settings, reason) {
  return eligibility.verdict === 'not_established'
    && eligibility.reason_codes.length === 1
    && eligibility.reason_codes[0] === 'RPD_SEROLOGY_NOT_ESTABLISHED'
    && settings.unknown_serology_rule === 'warn' && Boolean(String(reason ?? '').trim());
}

function ceilingOnly(eligibility) {
  return eligibility.verdict === 'ineligible' && eligibility.reason_codes.length === 1
    && eligibility.reason_codes[0] === 'RPD_MAX_CYCLES_REACHED';
}

function isUnusedNotConnectedCancellation(usage, session) {
  return usage.returned_at != null && usage.returned_by != null && usage.actual_use_started_at == null
    && usage.post_use_disposition === 'cancelled_before_use'
    && usage.unopened_confirmation === 'not_connected'
    && ['cancelled', 'no_show'].includes(session.status) && session.actual_start_at == null;
}

export async function deviceEligibilityTx(tx, {
  tenantId, patientUid, action, device, link, holds = [], preparedUse = false,
}) {
  const configuration = await policyTx(tx, tenantId, device);
  assertDedication(link, patientUid);
  const candidate = preparedUse ? { ...device, status: 'available' } : device;
  const basic = evaluateDeviceEligibility({ action, device: candidate, activeHolds: holds });
  if (basic.verdict !== 'eligible') return { ...basic, configuration };
  if (!configuration.scope || configuration.scope.single_use !== false
    || Number(configuration.scope.protocol_id) !== Number(configuration.protocol.id)) {
    return { verdict: 'not_established', reason_codes: ['RPD_PROTOCOL_SCOPE_MISMATCH'], configuration };
  }
  if (action === 'use') return { ...basic, configuration };
  const clock = first(await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now'));
  const eligibility = await reuseEligibilityTx({
    tenantId, patientUid, db: tx, protocol: configuration.protocol,
    device,
    dedicatedPatientUid: link.dedicated_patient_uid, activeHolds: holds,
    asOf: clock.now.toISOString(),
  });
  return { ...eligibility, configuration };
}

export async function captureDialyser({ tenantId, sessionId, actor, body = {}, operation = {} }) {
  actorRequired(actor);
  return setTenantTx(tenantId, async (tx) => {
    const { session } = await lockDialysisSessionTx(tx, { tenantId, sessionId });
    return captureDialyserTx(tx, { tenantId, session, actor, body, operation });
  });
}

export async function captureDialyserTx(tx, { tenantId, session, actor, body = {}, operation = {} }) {
  actorRequired(actor);
  if (!['scheduled', 'in_progress'].includes(session.status)) {
    throw AppError.conflict('Session cannot capture a dialyser', 'DIALYSER_ALREADY_CAPTURED');
  }
  const previous = first(await tx.$queryRawUnsafe(
    `SELECT id, metadata FROM reprocessable_device_usages WHERE tenant_id = $1::uuid
      AND dialysis_session_id = $2::int AND returned_at IS NULL`, tenantId, Number(session.id),
  ));
  if (previous) {
    const key = operation.idempotencyKey ?? operation.operationId;
    if (key && previous.metadata?.capture_key_hash === commandHash({ key })
      && previous.metadata?.capture_request_hash === commandHash(body)) {
      return replayView(previous.metadata.capture_response, actor);
    }
    throw AppError.conflict('Session already has a captured dialyser', 'DIALYSER_ALREADY_CAPTURED');
  }
  const configuration = await policyTx(tx, tenantId);
  if (!configuration?.policy?.reprocessable) {
    throw AppError.conflict('Dialyser policy does not permit reprocessing', 'RPD_POLICY_NOT_REPROCESSABLE');
  }
  const serial = String(body.manufacturer_serial ?? '').trim();
  const tag = String(body.device_tag ?? '').trim();
  if (Boolean(serial) === Boolean(tag)) {
    throw AppError.badRequest('Exactly one serial or device tag is required', 'RPD_DEVICE_IDENTITY_REQUIRED');
  }
  let device = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_devices WHERE tenant_id = $1::uuid
      AND (($2::text <> '' AND device_tag = $2) OR ($3::text <> '' AND domain = 'dialysis' AND manufacturer_serial = $3))
      FOR UPDATE`, tenantId, tag, serial,
  ));
  if (tag && !device) throw AppError.notFound('Dialyser not found', 'RPD_DEVICE_NOT_FOUND');
  if (device && device.domain !== 'dialysis') throw AppError.conflict('Device belongs to another domain', 'RPD_DOMAIN_MISMATCH');
  if (!device) {
    const scope = first(await tx.$queryRawUnsafe(
      `SELECT * FROM reprocessing_protocol_device_scopes WHERE tenant_id = $1::uuid AND protocol_id = $2
        AND manufacturer = $3 AND model_name = $4 AND single_use = FALSE FOR SHARE`,
      tenantId, configuration.protocol.id, body.manufacturer ?? '', body.model_name ?? '',
    ));
    if (!scope) throw AppError.conflict('Approved model scope required', 'RPD_PROTOCOL_SCOPE_MISMATCH');
    const initial = Number(body.initial_cycle_count ?? 0);
    if (!Number.isSafeInteger(initial) || initial < 0
      || (configuration.policy.max_cycles != null && initial > Number(configuration.policy.max_cycles))) {
      throw AppError.conflict('Initial cycle exceeds the approved ceiling', 'RPD_MAX_CYCLES_REACHED');
    }
    device = await registerDeviceTx(tx, {
      tenantId, actor, input: {
        domain: 'dialysis', category: 'dialyser', manufacturer_serial: serial,
        manufacturer: scope.manufacturer, model_name: scope.model_name,
        protocol_device_scope_id: scope.id, enrolled_via: 'session_capture',
        max_cycles_snapshot: configuration.policy.max_cycles,
      },
    });
    const existingLink = first(await tx.$queryRawUnsafe(
      `SELECT device_id FROM reprocessable_device_dialysis_links WHERE tenant_id = $1::uuid AND device_id = $2`,
      tenantId, Number(device.id),
    ));
    if (!existingLink) {
      let baseline = null;
      let source = null;
      if (initial === 0 && Number(body.baseline_tcv_ml) > 0) {
        baseline = Number(body.baseline_tcv_ml); source = 'measured_new';
      } else if (Number(scope.nominal_tcv_ml) > 0) {
        baseline = Number(scope.nominal_tcv_ml); source = 'manufacturer_nominal';
      } else if (initial > 0 && configuration.protocol.mid_life_enrolment_rule === 'refuse') {
        throw AppError.conflict('Approved baseline is required for mid-life enrolment', 'RPD_BASELINE_TCV_REQUIRED');
      }
      device = first(await tx.$queryRawUnsafe(
        `UPDATE reprocessable_devices SET cycle_count = $3,
          metadata = jsonb_build_object('enrolled_mid_life', $4::boolean)
          WHERE tenant_id = $1::uuid AND id = $2 RETURNING *`, tenantId, Number(device.id), initial, initial > 0,
      ));
      await tx.$queryRawUnsafe(
        `INSERT INTO reprocessable_device_dialysis_links
          (tenant_id, device_id, dedicated_patient_uid, dedicated_by, baseline_tcv_ml, baseline_tcv_source, baseline_tcv_measured_at)
          VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,CASE WHEN $5::numeric IS NULL THEN NULL ELSE clock_timestamp() END)
          RETURNING device_id`, tenantId, Number(device.id), session.patient_uid, actor.uid, baseline, source,
      );
    }
  }
  await recordPredatingExposureOutcomesTx(tx, {
    tenantId, patientUid: session.patient_uid, deviceId: device.id,
  });
  const holds = await tx.$queryRawUnsafe(
    `SELECT id, status FROM reprocessable_device_holds WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active' ORDER BY id FOR UPDATE`,
    tenantId, Number(device.id),
  );
  const link = first(await tx.$queryRawUnsafe(
    `SELECT * FROM reprocessable_device_dialysis_links WHERE tenant_id = $1::uuid AND device_id = $2 FOR UPDATE`,
    tenantId, Number(device.id),
  ));
  assertDedication(link, session.patient_uid);
  if (device.status !== 'available') {
    throw AppError.conflict('Dialyser is not available', 'RPD_DEVICE_NOT_AVAILABLE', { status: device.status });
  }
  if (body.expected_version != null && Number(body.expected_version) !== Number(device.version)) {
    throw AppError.conflict('Device version changed', 'RPD_VERSION_CONFLICT');
  }
  if (holds.length > 0) throw AppError.conflict('Dialyser has an active hold', 'RPD_HOLD_ACTIVE');
  if (device.residual_test_pending && body.pre_use_residual_test !== 'negative') {
    throw AppError.conflict('Pre-use residual test is required', 'RPD_RESIDUAL_TEST_REQUIRED');
  }
  const eligibility = await deviceEligibilityTx(tx, {
    tenantId, patientUid: session.patient_uid, action: 'use', device, link, holds,
  });
  if (eligibility.verdict !== 'eligible') {
    throw AppError.conflict('Reuse eligibility is not established', 'RPD_REUSE_NOT_ELIGIBLE', { verdict: eligibility.verdict });
  }
  const decision = await isolationDecisionTx({ tenantId, patientUid: session.patient_uid, db: tx });
  const result = await reserveDeviceTx(tx, {
    tenantId, deviceId: device.id, expectedVersion: device.version, patientUid: session.patient_uid,
    owner: { dialysis_session_id: session.id }, actor, operation,
    captureSource: body.capture_source ?? 'admin_console', captureProvenance: 'live',
    reuseScreen: operationalDecision(decision), preUseResidualTest: body.pre_use_residual_test ?? null,
  });
  await acknowledgementTx(tx, {
    tenantId, patientUid: session.patient_uid, actor, decision, usageId: result.usage.id,
    reason: body.exposure_acknowledgement?.reason,
  });
  if (body.exposure_acknowledgement?.reason) {
    await tx.$queryRawUnsafe(
      `UPDATE reprocessable_device_usages SET acknowledgement_reason = $3
        WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`,
      tenantId, Number(result.usage.id), body.exposure_acknowledgement.reason.trim(),
    );
  }
  await tx.$queryRawUnsafe(
    `UPDATE dialysis_sessions SET dialyser = $3, reuse_count = $4, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2::int RETURNING id`,
    tenantId, Number(session.id), device.model_name ?? device.manufacturer_serial, Number(result.usage.reuse_cycle),
  );
  await eventTx(tx, { tenantId, session, actor, action: 'rpd.device.captured', sourceId: result.usage.id,
    payload: { device_id: device.id, reuse_cycle: result.usage.reuse_cycle } });
  const response = { device: deviceView(result.device), usage: usageView(result.usage, actor.role), receipt: receipt(result.receipt) };
  if (operation.idempotencyKey ?? operation.operationId) {
    await tx.$queryRawUnsafe(
      `UPDATE reprocessable_device_usages SET metadata = metadata || $3::jsonb
        WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`,
      tenantId, Number(result.usage.id), JSON.stringify({
        capture_key_hash: commandHash({ key: operation.idempotencyKey ?? operation.operationId }),
        capture_request_hash: commandHash(body), capture_response: response,
      }),
    );
  }
  return response;
}

export async function onSessionStartingTx(tx, { tenantId, session, actor, body = {}, lockedPatientUids }) {
  const state = await deviceAndUsageTx(tx, { tenantId, sessionId: session.id });
  const configuration = await policyTx(tx, tenantId, state?.device);
  if (!state) {
    if (configuration) throw AppError.conflict('Captured dialyser required', 'RPD_DIALYSIS_USAGE_REQUIRED');
    return null;
  }
  if (state.usage.returned_at || Number(state.device.current_usage_id) !== Number(state.usage.id)) {
    throw AppError.conflict('Device use has already ended', 'RPD_USE_NOT_ENDED');
  }
  await reconcileExposureAdmissionTx(tx, {
    tenantId, patientUid: session.patient_uid, deviceId: state.device.id, lockedPatientUids,
  });
  assertDedication(state.link, session.patient_uid);
  if (state.holds.some((hold) => hold.status === 'active')) throw AppError.conflict('Dialyser has an active hold', 'RPD_HOLD_ACTIVE');
  const obligations = await evaluateOutstandingObligationsTx(tx, {
    tenantId, deviceId: state.device.id, protocolId: configuration.protocol.id,
    protocolDeviceScopeId: configuration.scope?.id,
  });
  if (obligations.length > 0) throw AppError.conflict('Dialyser readiness is incomplete', 'RPD_OUTSTANDING_OBLIGATIONS');
  if (configuration.protocol.residual_test_required && Number(state.device.cycle_count) > 0
    && state.usage.pre_use_residual_test !== 'negative') {
    throw AppError.conflict('Pre-use residual test is required', 'RPD_RESIDUAL_TEST_REQUIRED');
  }
  const eligibility = await deviceEligibilityTx(tx, {
    tenantId, patientUid: session.patient_uid, action: 'use', ...state, preparedUse: true,
  });
  if (eligibility.verdict !== 'eligible') {
    throw AppError.conflict('Reuse eligibility is not established', 'RPD_REUSE_NOT_ELIGIBLE', { verdict: eligibility.verdict });
  }
  const admitted = await admitActualUseTx(tx, {
    tenantId, deviceId: state.device.id, expectedVersion: body.expected_version ?? state.device.version, actor,
  });
  await eventTx(tx, { tenantId, session, actor, action: 'rpd.device.use_started', sourceId: state.usage.id });
  return admitted;
}

export async function onSessionEndedTx(tx, { tenantId, session, actor }) {
  const state = await deviceAndUsageTx(tx, { tenantId, sessionId: session.id });
  if (!state || state.usage.returned_at) return null;
  const decision = await isolationDecisionTx({ tenantId, patientUid: session.patient_uid, db: tx });
  let result = await returnDeviceTx(tx, {
    tenantId, deviceId: state.device.id, expectedVersion: state.device.version,
    disposition: 'sent_for_reprocessing', postUseScreen: operationalDecision(decision), actor,
  });
  const configuration = await policyTx(tx, tenantId, state.device, { allowInactive: true });
  const unknownHold = decision.status === 'unknown' && configuration.settings.unknown_serology_rule === 'block_return';
  const requiredHoldType = unknownHold ? 'serology_required' : 'bloodborne_exposure';
  if ((decision.status === 'restricted' || unknownHold)
    && !state.holds.some((hold) => hold.status === 'active' && hold.hold_type === requiredHoldType)) {
    const held = await placeHoldTx(tx, {
      tenantId, deviceId: state.device.id, expectedVersion: result.device.version,
      holdType: requiredHoldType,
      reasonCode: unknownHold ? 'serology_unknown_block_return' : 'exposure_at_return',
      sourceUsageId: state.usage.id, placedVia: 'return', placedBy: actor.uid,
    });
    result = { ...result, device: held.device, receipt: held.receipt };
  }
  await eventTx(tx, { tenantId, session, actor, action: 'rpd.device.returned', sourceId: state.usage.id });
  return result;
}

export async function onSessionCancelledTx(tx, { tenantId, session, actor, body = {} }) {
  const state = await deviceAndUsageTx(tx, { tenantId, sessionId: session.id });
  if (!state) return null;
  const settled = first(await tx.$queryRawUnsafe(
    `SELECT id FROM dialyzer_reuse_register WHERE tenant_id = $1::uuid AND device_usage_id = $2`,
    tenantId, Number(state.usage.id),
  ));
  if (session.status !== 'scheduled' || state.usage.returned_at || settled) {
    throw AppError.conflict('Recorded use cannot be cancelled', 'RPD_USAGE_NOT_CANCELLABLE');
  }
  const result = await restoreUnusedCaptureTx(tx, {
    tenantId, deviceId: state.device.id, expectedVersion: body.expected_version ?? state.device.version,
    packCondition: body.pack_condition, actor,
  });
  await eventTx(tx, { tenantId, session, actor, action: 'rpd.device.uncaptured', sourceId: state.usage.id,
    payload: { pack_condition: body.pack_condition } });
  return result;
}

function processingEvidence(body, link) {
  return {
    integrity_test_result: body.integrity_test_result,
    baseline_tcv_ml: link.baseline_tcv_ml == null ? null : Number(link.baseline_tcv_ml),
    baseline_tcv_source: link.baseline_tcv_source === 'measured_new' ? 'pre_use' : 'validated_model_manufacturer',
    measured_tcv_ml: body.measured_tcv_ml == null ? null : Number(body.measured_tcv_ml),
    reprocessing_agent: body.reprocessing_agent,
    disinfectant_concentration_pct: body.disinfectant_concentration_pct,
    disinfectant_contact_minutes: body.disinfectant_contact_minutes,
    residual_test_result: body.residual_test_result,
  };
}

function registerView(row) {
  return jsonValue(Object.fromEntries([
    'id', 'session_id', 'device_id', 'device_usage_id', 'reuse_cycle_count', 'session_reuse_count',
    'integrity_test_result', 'status', 'release_status', 'measured_tcv_ml', 'baseline_tcv_ml',
    'tcv_pct_of_baseline', 'reprocessing_agent', 'disinfectant_concentration_pct',
    'disinfectant_contact_minutes', 'missing_evidence', 'capture_provenance', 'protocol_id',
    'processing_event_id', 'processed_at',
  ].map((key) => [key, row[key] ?? null])));
}

function assertExpectedVersion(device, supplied) {
  if (supplied != null && Number(supplied) !== Number(device.version)) {
    throw AppError.conflict('Device version changed', 'RPD_VERSION_CONFLICT');
  }
}

export async function recordPlatformReuseRegisterTx(tx, { tenantId, session, actor, body = {}, operation = body.operation ?? {} }) {
  if (session.status !== 'completed' || !session.actual_end_at) {
    throw AppError.conflict('Dialysis use must end before reprocessing', 'RPD_USE_NOT_ENDED');
  }
  const state = await deviceAndUsageTx(tx, { tenantId, sessionId: session.id });
  const configuration = await policyTx(tx, tenantId, state?.device, { allowInactive: true });
  if (!state) {
    if (configuration) throw AppError.conflict('Session has no recorded dialyser use', 'RPD_DIALYSIS_USAGE_REQUIRED');
    return null;
  }
  actorRequired(actor);
  const { device, usage, link, holds } = state;
  if (body.device_usage_id != null && Number(body.device_usage_id) !== Number(usage.id)) {
    throw AppError.conflict('The requested usage does not match this device', 'RPD_RELATIONSHIP_MISMATCH');
  }
  if (!usage.returned_at) throw AppError.conflict('Dialyser use must end first', 'RPD_USE_NOT_ENDED');
  assertDedication(link, session.patient_uid);
  const settled = first(await tx.$queryRawUnsafe(
    `SELECT id FROM dialyzer_reuse_register WHERE tenant_id = $1::uuid AND device_usage_id = $2`,
    tenantId, Number(usage.id),
  ));
  const requestHash = commandHash(body);
  if (settled) {
    if (usage.metadata?.statutory_request_hash === requestHash && usage.metadata?.statutory_response) {
      return replayView(usage.metadata.statutory_response, actor);
    }
    throw AppError.conflict('Statutory reprocessing record is already settled', 'DIALYZER_REUSE_REGISTER_SETTLED');
  }
  assertExpectedVersion(device, body.expected_version);
  if (body.reuse_cycle_count != null && Number(body.reuse_cycle_count) !== Number(usage.reuse_cycle)) {
    throw AppError.conflict('Reuse count is derived from captured use', 'DIALYZER_REUSE_CYCLE_DERIVED');
  }
  const decision = await isolationDecisionTx({ tenantId, patientUid: session.patient_uid, db: tx });
  await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages SET post_use_screen = $3::jsonb
      WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`,
    tenantId, Number(usage.id), JSON.stringify(operationalDecision(decision)),
  );
  usage.post_use_screen = operationalDecision(decision);
  const clock = first(await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now'));
  let eligibility = await reuseEligibilityTx({
    tenantId, patientUid: session.patient_uid, db: tx, protocol: configuration.protocol,
    device, dedicatedPatientUid: link.dedicated_patient_uid, activeHolds: holds,
    asOf: clock.now.toISOString(),
  });
  let performedCeiling = false;
  if (ceilingOnly(eligibility)) {
    const otherEligibility = await reuseEligibilityTx({
      tenantId, patientUid: session.patient_uid, db: tx, protocol: configuration.protocol,
      device: { ...device, max_cycles_snapshot: null }, dedicatedPatientUid: link.dedicated_patient_uid,
      activeHolds: holds, asOf: clock.now.toISOString(),
    });
    performedCeiling = otherEligibility.verdict !== 'ineligible';
    if (!performedCeiling) eligibility = otherEligibility;
  }
  const status = body.status ?? 'in_use';
  if (!['in_use', 'quarantined', 'discarded'].includes(status)) {
    throw AppError.badRequest('Reprocessing disposition is invalid', 'RPD_DISPOSITION_NOT_ALLOWED');
  }
  if (status === 'in_use' && eligibility.verdict === 'ineligible' && !performedCeiling) {
    throw AppError.conflict('Requested disposition is not allowed', 'RPD_DISPOSITION_NOT_ALLOWED', {
      allowed: ['quarantine', 'discard'], verdict: eligibility.verdict,
      blocked_code: eligibility.reason_codes[0] ?? null,
    });
  }
  if (status === 'in_use' && decision.status === 'unknown'
    && configuration.settings.unknown_serology_rule === 'warn'
    && !String(body.acknowledgement?.reason ?? '').trim()) {
    throw AppError.conflict('Unknown evidence requires acknowledgement', 'RPD_ACKNOWLEDGEMENT_REQUIRED');
  }
  if (unknownAcknowledged(eligibility, configuration.settings, body.acknowledgement?.reason)) {
    eligibility = { verdict: 'eligible', reason_codes: [] };
  }
  const evidence = processingEvidence(body, link);
  const lowTcv = Number(evidence.measured_tcv_ml) > 0 && Number(evidence.baseline_tcv_ml) > 0
    && Number(evidence.measured_tcv_ml) / Number(evidence.baseline_tcv_ml) * 100 < Math.max(80, configuration.protocol.tcv_min_pct ?? 80);
  const discard = status === 'discarded' || evidence.integrity_test_result === 'fail' || lowTcv;
  const initialRelease = discard ? 'discarded' : status === 'quarantined' ? 'quarantined' : 'not_established';
  let register = first(await tx.$queryRawUnsafe(
    `INSERT INTO dialyzer_reuse_register
      (tenant_id,session_id,dialysis_patient_id,patient_uid,dialyzer_serial,reuse_cycle_count,
       session_reuse_count,integrity_test_result,integrity_test_method,disinfectant,processed_by,
       status,discard_reason,notes,device_id,device_usage_id,measured_tcv_ml,baseline_tcv_ml,
       tcv_pct_of_baseline,reprocessing_agent,disinfectant_concentration_pct,disinfectant_contact_minutes,
       release_status,capture_provenance,protocol_id)
     VALUES ($1::uuid,$2::int,$3::int,$4::uuid,$5,$6,$6,$7,$8,$9,$10::uuid,$11,$12,$13,
       $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    tenantId, Number(session.id), Number(session.dialysis_patient_id), session.patient_uid,
    device.manufacturer_serial, Number(usage.reuse_cycle), body.integrity_test_result ?? 'pending',
    body.integrity_test_method ?? null, body.disinfectant ?? null, actor.uid,
    discard ? 'discarded' : status, discard ? body.discard_reason ?? 'other' : null, body.notes ?? null,
    Number(device.id), Number(usage.id), evidence.measured_tcv_ml, evidence.baseline_tcv_ml,
    evidence.measured_tcv_ml && evidence.baseline_tcv_ml ? evidence.measured_tcv_ml / evidence.baseline_tcv_ml * 100 : null,
    body.reprocessing_agent ?? null, body.disinfectant_concentration_pct ?? null,
    body.disinfectant_contact_minutes ?? null, initialRelease, usage.capture_provenance, configuration.protocol.id,
  ));
  let result = { device, receipt: null, criteria: { verdict: initialRelease, missing_evidence: [] } };
  if (discard) {
    const reason = lowTcv ? 'tcv_below_threshold' : evidence.integrity_test_result === 'fail'
      ? 'integrity_failed' : eligibility.reason_codes.includes('RPD_MAX_CYCLES_REACHED') ? 'max_cycles_reached'
        : decision.status === 'restricted' ? 'bloodborne_exposure' : 'other';
    const changed = await discardDeviceTx(tx, {
      tenantId, deviceId: device.id, expectedVersion: device.version, reason, actor,
    });
    result.device = changed.device ?? changed;
    result.receipt = changed.receipt;
  } else if (status === 'quarantined') {
    if (!holds.some((hold) => hold.status === 'active')) {
      const held = await placeHoldTx(tx, {
        tenantId, deviceId: device.id, expectedVersion: device.version,
        holdType: decision.status === 'restricted' ? 'bloodborne_exposure' : 'manual',
        reasonCode: decision.status === 'restricted' ? 'exposure_at_return' : 'manual_ic',
        sourceUsageId: usage.id, placedVia: 'return', placedBy: actor.uid,
      });
      result.device = held.device; result.receipt = held.receipt;
    }
  } else {
    result = await releaseToAvailableTx(tx, {
      tenantId, deviceId: device.id, expectedVersion: device.version, actor,
      recordingMode: 'performed',
      protocol: configuration.protocol, scope: configuration.scope, evidence, eligibility,
      occurrence: { kind: 'chemical_reprocessing', device_usage_id: usage.id,
        dialyzer_reuse_register_id: register.id, protocol_id: configuration.protocol.id,
        cycle_type: 'chemical', recorded_via: 'dialysis_record',
        device_last_returned_at: usage.returned_at.toISOString() },
    });
    register = first(await tx.$queryRawUnsafe(
      `UPDATE dialyzer_reuse_register SET release_status = $3, processing_event_id = $4, missing_evidence = $5::text[]
        WHERE tenant_id = $1::uuid AND id = $2 RETURNING *`,
      tenantId, Number(register.id), result.criteria.verdict, Number(result.event.id), result.criteria.missing_evidence,
    ));
    usage.post_use_processing_event_id = result.event.id;
  }
  const disposition = discard ? lowTcv ? 'discarded_tcv_below_threshold'
    : evidence.integrity_test_result === 'fail' ? 'discarded_integrity_failed'
      : eligibility.reason_codes.includes('RPD_MAX_CYCLES_REACHED') ? 'discarded_max_cycles'
        : decision.status === 'restricted' ? 'discarded_bloodborne_exposure' : 'discarded_other'
    : status === 'quarantined' ? decision.status === 'restricted' ? 'quarantined_bloodborne_exposure' : 'quarantined_other'
      : result.criteria.verdict === 'released' ? 'sent_for_reprocessing' : 'released_not_established';
  await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages SET post_use_disposition = $3
      WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`, tenantId, Number(usage.id), disposition,
  );
  usage.post_use_disposition = disposition;
  const response = {
    ...registerView(register), device: deviceView(result.device), usage: usageView(usage, actor.role),
    receipt: receipt(result.receipt), release: result.criteria,
  };
  await acknowledgementTx(tx, {
    tenantId, patientUid: session.patient_uid, actor, decision, usageId: usage.id,
    reason: body.acknowledgement?.reason,
  });
  await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages SET metadata = metadata || $3::jsonb
      WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`,
    tenantId, Number(usage.id), JSON.stringify({ statutory_request_hash: requestHash, statutory_response: response,
      statutory_operation_key_hash: (operation.idempotencyKey ?? operation.operationId)
        ? commandHash({ key: operation.idempotencyKey ?? operation.operationId }) : null }),
  );
  await eventTx(tx, { tenantId, session, actor, action: 'dialysis.reuse_register.recorded', sourceId: register.id,
    sourceTable: 'dialyzer_reuse_register',
    payload: { device_id: device.id, release_status: register.release_status, decision_status: decision.status } });
  return response;
}

export async function recordDialyserReprocessingAttempt({ tenantId, deviceId, actor, body = {}, operation = {} }) {
  actorRequired(actor);
  return setTenantTx(tenantId, async (tx) => {
    const reference = first(await tx.$queryRawUnsafe(
      `SELECT dialysis_session_id FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY id DESC LIMIT 1`,
      tenantId, Number(deviceId),
    ));
    if (!reference) throw AppError.conflict('Dialyser attempt is not allowed', 'RPD_ATTEMPT_NOT_ALLOWED');
    const { session } = await lockDialysisSessionTx(tx, { tenantId, sessionId: reference.dialysis_session_id });
    const state = await deviceAndUsageTx(tx, { tenantId, deviceId });
    if (body.device_usage_id != null && Number(body.device_usage_id) !== Number(state.usage.id)) {
      throw AppError.conflict('The requested usage does not match this device', 'RPD_RELATIONSHIP_MISMATCH');
    }
    const operationKey = operation.idempotencyKey ?? operation.operationId;
    const operationKeyHash = operationKey ? commandHash({ key: operationKey }) : null;
    const savedAttempt = operationKeyHash ? state.usage.metadata?.attempt_receipts?.[operationKeyHash] : null;
    if (savedAttempt) {
      if (savedAttempt.request_hash !== commandHash(body)) {
        throw AppError.conflict('Idempotency key has different command data', 'RPD_IDEMPOTENCY_CONFLICT');
      }
      return savedAttempt.response;
    }
    const register = first(await tx.$queryRawUnsafe(
      `SELECT id FROM dialyzer_reuse_register WHERE tenant_id = $1::uuid AND device_usage_id = $2`,
      tenantId, Number(state.usage.id),
    ));
    const unusedCancellation = !register && isUnusedNotConnectedCancellation(state.usage, session);
    if ((!register && !unusedCancellation) || state.device.current_usage_id != null
      || (unusedCancellation ? state.device.status === 'available'
        : !['awaiting_reprocessing', 'in_cssd'].includes(state.device.status)
          || state.holds.some((hold) => hold.status === 'active'))) {
      throw AppError.conflict('Dialyser attempt is not allowed', 'RPD_ATTEMPT_NOT_ALLOWED');
    }
    if (body.expected_version == null) throw AppError.badRequest('expected_version is required', 'RPD_EXPECTED_VERSION_REQUIRED');
    assertExpectedVersion(state.device, body.expected_version);
    assertDedication(state.link, session.patient_uid);
    const configuration = await policyTx(tx, tenantId, state.device, { allowInactive: unusedCancellation });
    const clock = first(await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now'));
    let eligibility = await reuseEligibilityTx({
      tenantId, patientUid: session.patient_uid, db: tx, protocol: configuration.protocol,
      device: state.device, dedicatedPatientUid: state.link.dedicated_patient_uid,
      activeHolds: state.holds, asOf: clock.now.toISOString(),
    });
    let performedCeiling = false;
    if (!unusedCancellation && ceilingOnly(eligibility)) {
      const otherEligibility = await reuseEligibilityTx({
        tenantId, patientUid: session.patient_uid, db: tx, protocol: configuration.protocol,
        device: { ...state.device, max_cycles_snapshot: null }, dedicatedPatientUid: state.link.dedicated_patient_uid,
        activeHolds: state.holds, asOf: clock.now.toISOString(),
      });
      performedCeiling = otherEligibility.verdict !== 'ineligible';
      if (!performedCeiling) eligibility = otherEligibility;
    }
    if (!unusedCancellation && eligibility.verdict === 'ineligible' && !performedCeiling) {
      throw AppError.conflict('Dialyser attempt is not allowed', 'RPD_ATTEMPT_NOT_ALLOWED');
    }
    const { protocol, scope, settings } = configuration;
    const decision = await isolationDecisionTx({ tenantId, patientUid: session.patient_uid, db: tx });
    if (decision.status === 'unknown' && settings.unknown_serology_rule === 'warn'
      && !String(body.acknowledgement?.reason ?? '').trim()) {
      throw AppError.conflict('Unknown evidence requires acknowledgement', 'RPD_ACKNOWLEDGEMENT_REQUIRED');
    }
    if (unknownAcknowledged(eligibility, settings, body.acknowledgement?.reason)) {
      eligibility = { verdict: 'eligible', reason_codes: [] };
    }
    const evidence = processingEvidence(body, state.link);
    let attempt;
    const result = await releaseToAvailableTx(tx, {
      tenantId, deviceId, expectedVersion: state.device.version, actor, operation,
      recordingMode: 'performed',
      protocol, scope, evidence, eligibility,
      occurrence: { kind: 'chemical_reprocessing', device_usage_id: state.usage.id,
        protocol_id: protocol.id, cycle_type: 'chemical',
        recorded_via: 'dialysis_attempt', device_last_returned_at: state.usage.returned_at.toISOString() },
      prepareOccurrence: async ({ criteria }) => {
        attempt = first(await tx.$queryRawUnsafe(
      `INSERT INTO dialyser_reprocessing_attempts
        (tenant_id,device_id,device_usage_id,dialyzer_reuse_register_id,attempt_no,authorising_hold_id,protocol_id,
         integrity_test_result,measured_tcv_ml,baseline_tcv_ml,tcv_pct_of_baseline,reprocessing_agent,
         disinfectant_concentration_pct,disinfectant_contact_minutes,verdict,missing_evidence,recorded_by,notes)
       SELECT $1::uuid,$2,$3,$4,COALESCE(max(attempt_no),0)+1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::uuid,$17
         FROM dialyser_reprocessing_attempts WHERE tenant_id = $1::uuid AND device_usage_id = $3
          AND dialyzer_reuse_register_id IS NOT DISTINCT FROM $4::bigint RETURNING *`,
      tenantId, Number(deviceId), Number(state.usage.id), register ? Number(register.id) : null,
      state.holds.find((hold) => hold.status === 'released' && hold.release_requires_processing)?.id ?? null,
      protocol.id, body.integrity_test_result ?? null, evidence.measured_tcv_ml, evidence.baseline_tcv_ml,
      evidence.measured_tcv_ml && evidence.baseline_tcv_ml ? evidence.measured_tcv_ml / evidence.baseline_tcv_ml * 100 : null,
      body.reprocessing_agent ?? null, body.disinfectant_concentration_pct ?? null,
      body.disinfectant_contact_minutes ?? null, criteria.verdict, criteria.missing_evidence, actor.uid, body.notes ?? null,
        ));
        return { attempt_id: attempt.id };
      },
    });
    await acknowledgementTx(tx, {
      tenantId, patientUid: session.patient_uid, actor, reason: body.acknowledgement?.reason,
      decision, usageId: state.usage.id,
    });
    await eventTx(tx, { tenantId, session, actor, action: 'rpd.attempt.recorded', sourceId: attempt.id,
      sourceTable: 'dialyser_reprocessing_attempts',
      payload: { device_id: deviceId, verdict: result.criteria.verdict } });
    const response = jsonValue({ attempt: { id: attempt.id, attempt_no: attempt.attempt_no, verdict: result.criteria.verdict,
      missing_evidence: result.criteria.missing_evidence }, device: deviceView(result.device), receipt: receipt(result.receipt) });
    if (operationKeyHash) {
      await tx.$queryRawUnsafe(
        `UPDATE reprocessable_device_usages SET metadata = jsonb_set(metadata, '{attempt_receipts}', $3::jsonb)
          WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`, tenantId, Number(state.usage.id),
        JSON.stringify({ ...state.usage.metadata?.attempt_receipts,
          [operationKeyHash]: { request_hash: commandHash(body), response } }),
      );
    }
    return response;
  });
}

export async function recordRetrospectiveDialyserUse({ tenantId, sessionId, actor, body = {}, operation = {} }) {
  actorRequired(actor);
  const started = new Date(body.actual_use_started_at);
  const ended = new Date(body.actual_use_ended_at);
  if (!Number.isFinite(started.getTime()) || !Number.isFinite(ended.getTime()) || started >= ended
    || ended > new Date() || !String(body.deviation_reason ?? '').trim()) {
    throw AppError.badRequest('Actual use interval and deviation reason are required', 'RPD_RETROSPECTIVE_PROVENANCE_REQUIRED');
  }
  return setTenantTx(tenantId, async (tx) => {
    const serial = String(body.manufacturer_serial ?? '').trim();
    const tag = String(body.device_tag ?? '').trim();
    if (Boolean(serial) === Boolean(tag)) {
      throw AppError.badRequest('Exactly one serial or device tag is required', 'RPD_DEVICE_IDENTITY_REQUIRED');
    }
    const subject = await sessionSubjectTx(tx, { tenantId, sessionId });
    const identity = first(await tx.$queryRawUnsafe(
      `SELECT id FROM reprocessable_devices WHERE tenant_id = $1::uuid
        AND (($2::text <> '' AND device_tag = $2) OR ($3::text <> '' AND domain = 'dialysis' AND manufacturer_serial = $3))`,
      tenantId, tag, serial,
    ));
    let lockedPatientUids = identity
      ? await lockDeviceExposurePatientsTx(tx, { tenantId, patientUid: subject.patient_uid, deviceId: identity.id }) : null;
    const locked = await lockDialysisSessionTx(tx, { tenantId, sessionId });
    const { session } = locked;
    lockedPatientUids ??= locked.lockedPatientUids;
    if (session.status !== 'completed' || !session.actual_end_at) {
      throw AppError.conflict('Retrospective use must be ended', 'RPD_USE_NOT_ENDED');
    }
    const previous = await tx.$queryRawUnsafe(
      `SELECT id, metadata FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND dialysis_session_id = $2::int`,
      tenantId, Number(sessionId),
    );
    const operationKey = operation.idempotencyKey ?? operation.operationId;
    const operationKeyHash = operationKey ? commandHash({ key: operationKey }) : null;
    if (previous.length) {
      const saved = previous.find(row => operationKeyHash && row.metadata?.retrospective_key_hash === operationKeyHash);
      if (saved) {
        if (saved.metadata.retrospective_request_hash !== commandHash(body)) {
          throw AppError.conflict('Idempotency key has different command data', 'RPD_IDEMPOTENCY_CONFLICT');
        }
        return replayView(saved.metadata.retrospective_response, actor);
      }
      throw AppError.conflict('Session already has a recorded dialyser use', 'DIALYSER_ALREADY_CAPTURED');
    }
    let device = identity ? first(await tx.$queryRawUnsafe(
      `SELECT * FROM reprocessable_devices WHERE tenant_id = $1::uuid AND id = $2 FOR UPDATE`,
      tenantId, Number(identity.id),
    )) : null;
    if (tag && !device) throw AppError.notFound('Dialyser not found', 'RPD_DEVICE_NOT_FOUND');
    if (device && device.domain !== 'dialysis') throw AppError.conflict('Device belongs to another domain', 'RPD_DOMAIN_MISMATCH');
    const configuration = await policyTx(tx, tenantId, device, { allowInactive: true });
    if (!device) {
      if (!configuration?.protocol) throw AppError.conflict('A protocol scope is required to identify a new device', 'RPD_PROTOCOL_SCOPE_MISMATCH');
      const scope = first(await tx.$queryRawUnsafe(
        `SELECT * FROM reprocessing_protocol_device_scopes WHERE tenant_id = $1::uuid AND protocol_id = $2
          AND manufacturer = $3 AND model_name = $4 FOR SHARE`,
        tenantId, configuration.protocol.id, body.manufacturer ?? '', body.model_name ?? '',
      ));
      if (!scope) throw AppError.conflict('Approved identity scope required', 'RPD_PROTOCOL_SCOPE_MISMATCH');
      device = await registerDeviceTx(tx, { tenantId, actor, input: {
        domain: 'dialysis', category: 'dialyser', manufacturer_serial: serial,
        manufacturer: scope.manufacturer, model_name: scope.model_name,
        protocol_device_scope_id: scope.id, enrolled_via: 'session_capture',
        max_cycles_snapshot: configuration.policy.max_cycles, initial_status: 'awaiting_reprocessing',
      } });
      await tx.$queryRawUnsafe(
        `INSERT INTO reprocessable_device_dialysis_links
          (tenant_id,device_id,dedicated_patient_uid,dedicated_by,baseline_tcv_ml,baseline_tcv_source)
         VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,CASE WHEN $5::numeric IS NULL THEN NULL ELSE 'manufacturer_nominal' END)
         ON CONFLICT (device_id) DO NOTHING RETURNING device_id`,
        tenantId, Number(device.id), session.patient_uid, actor.uid, scope.nominal_tcv_ml ?? null,
      );
    }
    assertExpectedVersion(device, body.expected_version);
    const decision = await isolationDecisionTx({ tenantId, patientUid: session.patient_uid, db: tx });
    const exposure = await reconcileExposureAdmissionTx(tx, {
      tenantId, patientUid: session.patient_uid, deviceId: device.id, lockedPatientUids, refusePending: false,
    });
    const exposureDetected = decision.status === 'restricted' || !exposure.complete;
    const unknownHold = decision.status === 'unknown' && configuration.settings.unknown_serology_rule === 'block_return';
    const usage = first(await tx.$queryRawUnsafe(
      `INSERT INTO reprocessable_device_usages
        (tenant_id,domain,device_id,patient_uid,dialysis_session_id,reuse_cycle,captured_by,capture_source,
         capture_provenance,actual_use_started_at,returned_at,returned_by,post_use_disposition,
         acknowledgement_reason,post_use_screen)
       VALUES ($1::uuid,'dialysis',$2,$3::uuid,$4::int,$5,$6::uuid,'admin_console','retrospective',
         $7::timestamptz,$8::timestamptz,$6::uuid,'sent_for_reprocessing',$9,$10::jsonb) RETURNING *`,
      tenantId, Number(device.id), session.patient_uid, Number(session.id), Number(session.reuse_count ?? device.cycle_count),
      actor.uid, started.toISOString(), ended.toISOString(), body.deviation_reason.trim(), JSON.stringify(operationalDecision(decision)),
    ));
    let returned = await recordRetrospectiveReturnTx(tx, {
      tenantId, deviceId: device.id, expectedVersion: device.version, usageId: usage.id, actor, operation, exposureDetected,
    });
    if (exposureDetected && returned.device.status !== 'discarded') {
      returned = await placeHoldTx(tx, {
        tenantId, deviceId: device.id, expectedVersion: returned.device.version,
        holdType: 'bloodborne_exposure', reasonCode: 'exposure_at_return',
        sourceUsageId: usage.id, placedVia: 'return', placedBy: actor.uid,
      });
    }
    if (unknownHold && returned.device.status !== 'discarded') {
      returned = await placeHoldTx(tx, {
        tenantId, deviceId: device.id, expectedVersion: returned.device.version,
        holdType: 'serology_required', reasonCode: 'serology_unknown_block_return',
        sourceUsageId: usage.id, placedVia: 'return', placedBy: actor.uid,
      });
    }
    const disposition = returned.device.status === 'discarded'
      ? exposureDetected ? 'discarded_bloodborne_exposure' : 'discarded_other'
      : returned.device.status === 'quarantined'
        ? exposureDetected ? 'quarantined_bloodborne_exposure' : 'quarantined_other'
        : 'sent_for_reprocessing';
    await tx.$queryRawUnsafe(
      `UPDATE reprocessable_device_usages SET post_use_disposition = $3
        WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`, tenantId, Number(usage.id), disposition,
    );
    usage.post_use_disposition = disposition;
    await eventTx(tx, { tenantId, session, actor, action: 'rpd.device.retrospective_use', sourceId: usage.id });
    const response = { device: deviceView(returned.device), usage: usageView(usage, actor.role), receipt: receipt(returned.receipt) };
    if (operationKeyHash) {
      await tx.$queryRawUnsafe(
        `UPDATE reprocessable_device_usages SET metadata = metadata || $3::jsonb
          WHERE tenant_id = $1::uuid AND id = $2 RETURNING id`, tenantId, Number(usage.id),
        JSON.stringify({ retrospective_key_hash: operationKeyHash,
          retrospective_request_hash: commandHash(body), retrospective_response: response }),
      );
    }
    return response;
  });
}

export async function readDialyser({ tenantId, sessionId, actor }) {
  actorRequired(actor);
  return setTenantTx(tenantId, async (tx) => {
    const session = await sessionSubjectTx(tx, { tenantId, sessionId });
    const state = await deviceAndUsageTx(tx, { tenantId, sessionId });
    if (!state) return { usage: null, device: null, holds: [] };
    const decision = await isolationDecisionTx({ tenantId, patientUid: session.patient_uid, db: tx });
    const configuration = await policyTx(tx, tenantId, state.device, { allowInactive: true });
    const clock = first(await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now'));
    const eligibility = await reuseEligibilityTx({
      tenantId, patientUid: session.patient_uid, db: tx, device: state.device,
      protocol: configuration.protocol, dedicatedPatientUid: state.link.dedicated_patient_uid,
      activeHolds: state.holds, asOf: clock.now.toISOString(),
    });
    const obligations = await evaluateOutstandingObligationsTx(tx, {
      tenantId, deviceId: state.device.id, protocolId: configuration.protocol.id,
      protocolDeviceScopeId: configuration.scope?.id,
    });
    return {
      device: deviceView(state.device), usage: usageView(state.usage, actor.role),
      link: jsonValue({ dedicated_patient_uid: state.link.dedicated_patient_uid,
        baseline_tcv_ml: state.link.baseline_tcv_ml, baseline_tcv_source: state.link.baseline_tcv_source }),
      holds: state.holds.map((hold) => jsonValue({
        id: hold.id, hold_type: hold.hold_type, reason_code: hold.reason_code,
        status: hold.status, placed_at: hold.placed_at,
      })),
      outstanding_obligations: obligations,
      reuse_restriction: operationalDecision(decision), reuse_eligibility: { verdict: eligibility.verdict },
      allowed_dispositions: eligibility.verdict === 'eligible' ? ['reprocess', 'quarantine', 'discard'] : ['quarantine', 'discard'],
      release: { residual_test_pending: state.device.residual_test_pending },
      isolation: { codes: session.isolation_warning_codes, required_group: session.isolation_required_group,
        warn_only: session.isolation_warn_only, enforcement_enabled: session.isolation_enforcement_enabled },
    };
  });
}

export async function reprocessDialysisDevice({ tenantId, deviceId, actor, body = {}, operation = {} }) {
  actorRequired(actor);
  if (body.device_usage_id == null) {
    throw AppError.badRequest('device_usage_id is required', 'RPD_DIALYSIS_USAGE_REQUIRED');
  }
  const target = await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT u.id AS usage_id, u.dialysis_session_id, u.metadata, u.post_use_disposition, r.id AS register_id
        FROM reprocessable_device_usages u
        LEFT JOIN dialyzer_reuse_register r ON r.tenant_id = u.tenant_id AND r.device_usage_id = u.id
       WHERE u.tenant_id = $1::uuid AND u.device_id = $2 AND u.domain = 'dialysis'
       ORDER BY u.id DESC LIMIT 1`, tenantId, Number(deviceId),
    );
    if (!rows[0]) throw AppError.notFound('Dialyser use not found', 'RPD_DIALYSIS_USAGE_REQUIRED');
    if (body.device_usage_id != null && Number(body.device_usage_id) !== Number(rows[0].usage_id)) {
      throw AppError.conflict('The requested usage does not match this device', 'RPD_RELATIONSHIP_MISMATCH');
    }
    return rows[0];
  });
  const operationKey = operation.idempotencyKey ?? operation.operationId;
  if (operationKey && target.metadata?.statutory_operation_key_hash === commandHash({ key: operationKey })) {
    if (target.metadata.statutory_request_hash !== commandHash(body)) {
      throw AppError.conflict('Idempotency key has different command data', 'RPD_IDEMPOTENCY_CONFLICT');
    }
    return replayView(target.metadata.statutory_response, actor);
  }
  if (target.register_id || target.post_use_disposition === 'cancelled_before_use') {
    return recordDialyserReprocessingAttempt({ tenantId, deviceId, actor, body, operation });
  }
  return setTenantTx(tenantId, async (tx) => {
    const { session } = await lockDialysisSessionTx(tx, { tenantId, sessionId: target.dialysis_session_id });
    return recordPlatformReuseRegisterTx(tx, { tenantId, session, actor, body, operation });
  });
}

export const _internal = Object.freeze({ policyTx, deviceAndUsageTx, operationalDecision, commandHash, deviceView, usageView, receipt, eventTx });
