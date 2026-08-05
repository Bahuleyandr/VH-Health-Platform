import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  deactivateScimIdentityTx,
  revokeScimIdentityTokens,
} from '../auth/scimProvisioningService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  hashCanonicalValue,
} from './continuityPackCanonical.js';
import { loadActiveClinicalContinuityPolicyForFacilityTx } from './clinicalContinuityPolicyService.js';
import { loadClinicalContinuityReconciliationConfigTx } from './clinicalContinuityReconciliationService.js';
import { parseClinicalContinuityDeviceLoss } from '../../validators/clinicalContinuityDeviceLossSchemas.js';

const DEVICE_LOSS_ORDER_FORMAT = 'vhhealth_continuity_device_wipe_order/v1';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STEP_NAMES = Object.freeze([
  'capture_grants',
  'edge_read_grants',
  'identity_access',
  'tokens',
  'wipe_order',
  'needs_review_routing',
  'offline_pack_risk',
]);

function unavailable(message = 'Clinical continuity device-loss orchestration is not activated') {
  return new AppError(
    message,
    503,
    'CONTINUITY_DEVICE_LOSS_ORCHESTRATION_NOT_ACTIVATED',
    { safe: true },
  );
}

function retryable(message, code, operation) {
  return new AppError(message, 503, code, { safe: true, operation });
}

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function initialStepProjection({ facilityIds, offlineRiskExpiresAt }) {
  const projection = Object.fromEntries(STEP_NAMES.map(name => [name, {
    state: 'retryable_failed',
    attempt: 0,
    evidence_ids: [],
    error_code: 'BLOCKED_BY_PRIOR_STEP',
  }]));
  projection.facility_ids = facilityIds;
  projection.offline_risk_expires_at = offlineRiskExpiresAt;
  return projection;
}

function nextStep(projection, name, {
  state,
  evidenceIds = [],
  errorCode = null,
  details = {},
  increment = true,
}) {
  const previous = projection?.[name] || {};
  return {
    ...projection,
    [name]: {
      state,
      attempt: Number(previous.attempt || 0) + (increment ? 1 : 0),
      evidence_ids: evidenceIds.map(String),
      error_code: errorCode,
      ...details,
    },
  };
}

async function setFacilityContextTx(tx, facilityId) {
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_facility_id', $1, true)`,
    String(facilityId),
  );
}

async function requiredAudit(tx, input) {
  const row = await recordClinicalAuditEvent(input, { db: tx });
  if (!row) {
    throw AppError.internal(
      'Device-loss audit evidence was not recorded',
      'CONTINUITY_AUDIT_REQUIRED',
    );
  }
  return row;
}

function auditInput({
  tenantId,
  operationId,
  actorUid,
  requestId,
  action,
  status = 'success',
  suffix,
  metadata,
}) {
  return {
    tenantId,
    action,
    actionStatus: status,
    actorUid,
    actorRole: 'SUPER_ADMIN',
    resourceType: 'clinical_continuity_device_loss_operation',
    resourceTable: 'clinical_continuity_device_loss_operations',
    resourceId: operationId,
    requestId,
    metadata,
    idempotencyKey: `cc-device-loss:${operationId}:${suffix}`,
  };
}

function activationState(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'absent';
  const continuity = settings.clinical_continuity;
  if (!continuity || typeof continuity !== 'object' || Array.isArray(continuity)) return 'absent';
  const value = continuity.device_loss_orchestration;
  return ['off', 'shadow', 'active'].includes(value) ? value : 'absent';
}

export async function assertClinicalContinuityDeviceLossActivated({ tenantId }) {
  const tenant = requireTenantId(tenantId);
  if (tenant === DEFAULT_TENANT_ID) throw unavailable();
  const state = await setTenantTx(tenant, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT settings
         FROM tenants
        WHERE id = $1::uuid
        LIMIT 1`,
      tenant,
    );
    if (!rows[0]) return 'absent';
    return activationState(rows[0].settings);
  }, { readOnly: true, isolationLevel: 'RepeatableRead' });
  if (state !== 'active') throw unavailable();
  return Object.freeze({ state });
}

async function loadOperationByFingerprintTx(tx, tenantId, requestFingerprint, { forUpdate = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM clinical_continuity_device_loss_operations
      WHERE tenant_id = $1::uuid AND request_fingerprint = $2
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    tenantId,
    requestFingerprint,
  );
  return rows[0] || null;
}

async function loadOperationTx(tx, tenantId, operationId, { forUpdate = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM clinical_continuity_device_loss_operations
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    tenantId,
    operationId,
  );
  return rows[0] || null;
}

async function loadActiveGrantsTx(tx, tenantId, stableDeviceId) {
  return tx.$queryRawUnsafe(
    `SELECT grant_row.id::text, grant_row.facility_id,
            grant_row.grant_purpose, grant_row.staff_uid::text,
            grant_row.valid_until
       FROM clinical_continuity_edge_access_grants AS grant_row
       LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
         ON revocation.tenant_id = grant_row.tenant_id
        AND revocation.facility_id = grant_row.facility_id
        AND revocation.grant_id = grant_row.id
        AND revocation.grant_purpose = grant_row.grant_purpose
      WHERE grant_row.tenant_id = $1::uuid
        AND grant_row.device_id = $2
        AND grant_row.valid_from <= clock_timestamp()
        AND grant_row.valid_until > clock_timestamp()
        AND revocation.id IS NULL
      ORDER BY grant_row.facility_id, grant_row.grant_purpose, grant_row.id
      FOR SHARE OF grant_row`,
    tenantId,
    stableDeviceId,
  );
}

async function loadSubjectsTx(tx, tenantId, stableDeviceId, staffUids) {
  if (staffUids.length === 0) return [];
  const rows = await tx.$queryRawUnsafe(
    `SELECT account.uid::text, account.is_break_glass_account,
            staff_row.id AS staff_id,
            ARRAY(
              SELECT DISTINCT association.facility_id
                FROM (
                  SELECT device.facility_id
                    FROM user_devices AS device
                   WHERE device.tenant_id = account.tenant_id
                     AND device.user_uid = account.uid
                     AND device.device_id = $2
                     AND device.facility_id IS NOT NULL
                  UNION
                  SELECT grant_row.facility_id
                    FROM clinical_continuity_edge_access_grants AS grant_row
                   WHERE grant_row.tenant_id = account.tenant_id
                     AND grant_row.staff_uid = account.uid
                     AND grant_row.device_id = $2
                ) AS association
            ) AS facility_ids,
            EXISTS (
              SELECT 1 FROM user_devices AS device
               WHERE device.tenant_id = account.tenant_id
                 AND device.user_uid = account.uid
                 AND device.device_id = $2
            ) OR EXISTS (
              SELECT 1 FROM staff_devices AS staff_device
               WHERE staff_device.tenant_id = account.tenant_id
                 AND staff_device.user_uid = account.uid
                 AND staff_device.device_id = $2
            ) OR EXISTS (
              SELECT 1 FROM clinical_continuity_edge_access_grants AS grant_row
               WHERE grant_row.tenant_id = account.tenant_id
                 AND grant_row.staff_uid = account.uid
                 AND grant_row.device_id = $2
            ) AS associated
       FROM users AS account
       JOIN staff AS staff_row
         ON staff_row.tenant_id = account.tenant_id
        AND staff_row.user_id = account.uid
      WHERE account.tenant_id = $1::uuid
        AND account.uid = ANY(
          ARRAY(SELECT jsonb_array_elements_text($3::jsonb)::uuid)
        )
      ORDER BY account.uid
      FOR SHARE OF account, staff_row`,
    tenantId,
    stableDeviceId,
    JSON.stringify(staffUids),
  );
  if (rows.length !== staffUids.length || rows.some(row => row.associated !== true)) {
    throw AppError.conflict(
      'Affected Staff scope is not proved for the exact device',
      'CONTINUITY_DEVICE_LOSS_SUBJECT_SCOPE_UNPROVED',
      { safe: true },
    );
  }
  return rows.map(row => ({
    uid: String(row.uid),
    staffId: Number(row.staff_id),
    breakGlass: row.is_break_glass_account === true,
    facilityIds: (row.facility_ids || []).map(Number),
  }));
}

async function preflight({ tenantId, parsed, requestFingerprint }) {
  return setTenantTx(tenantId, async tx => {
    const existing = await loadOperationByFingerprintTx(tx, tenantId, requestFingerprint);
    let grants = [];
    let subjects = [];
    let facilityIds = [];
    if (existing?.capture_audit_event_id) {
      const subjectRows = await tx.$queryRawUnsafe(
        `SELECT staff_uid::text AS uid, staff_id, break_glass
           FROM clinical_continuity_device_loss_subjects
          WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
          ORDER BY staff_uid`,
        tenantId,
        existing.id,
      );
      subjects = subjectRows.map(row => ({
        uid: row.uid,
        staffId: Number(row.staff_id),
        breakGlass: row.break_glass === true,
        facilityIds: [],
      }));
      facilityIds = (existing.step_projection?.facility_ids || []).map(Number);
    } else {
      grants = await loadActiveGrantsTx(tx, tenantId, parsed.stableDeviceId);
      subjects = await loadSubjectsTx(
        tx,
        tenantId,
        parsed.stableDeviceId,
        parsed.affectedStaffUids,
      );
      if (parsed.affectedStaffUids.length === 0 && !grants.some(
        row => row.grant_purpose === 'capture_fixed_device',
      )) {
        throw AppError.conflict(
          'An empty Staff scope requires a proved fixed-device capture grant',
          'CONTINUITY_DEVICE_LOSS_FIXED_DEVICE_SCOPE_UNPROVED',
          { safe: true },
        );
      }
      facilityIds = [...new Set([
        ...grants.map(row => Number(row.facility_id)),
        ...subjects.flatMap(subject => subject.facilityIds),
      ])].sort((left, right) => left - right);
    }
    if (facilityIds.length === 0) {
      throw AppError.conflict(
        'The exact device has no proved continuity facility scope',
        'CONTINUITY_DEVICE_LOSS_FACILITY_SCOPE_UNPROVED',
        { safe: true },
      );
    }

    const configs = [];
    const policies = [];
    for (const facilityId of facilityIds) {
      await setFacilityContextTx(tx, facilityId);
      const config = await loadClinicalContinuityReconciliationConfigTx(tx, tenantId, facilityId);
      if (
        config.fallback_principal !== 'role:clinical_safety_lead'
        || !config.clinical_safety_lead_uid
      ) {
        throw AppError.conflict(
          'Facility fallback reconciliation principal is not resolved',
          'CONTINUITY_RECONCILIATION_CONFIG_REQUIRED',
          { safe: true },
        );
      }
      configs.push({ facilityId, ...config });
      if (!existing?.wipe_content) {
        policies.push(await loadActiveClinicalContinuityPolicyForFacilityTx({
          tx,
          tenantId,
          facilityId,
        }));
      }
    }

    let offlineRiskExpiresAt = existing?.step_projection?.offline_risk_expires_at || null;
    if (!offlineRiskExpiresAt) {
      const authorizationMinutes = policies.map(policy => Number(
        policy.policyDocument?.edgeAccess?.maximumOfflineAuthorizationMinutes,
      ));
      if (
        authorizationMinutes.length !== facilityIds.length
        || authorizationMinutes.some(value => !Number.isSafeInteger(value) || value < 1 || value > 1440)
      ) {
        throw AppError.conflict(
          'Signed offline authorization risk cannot be bounded to 24 hours',
          'CONTINUITY_DEVICE_LOSS_OFFLINE_RISK_UNBOUNDED',
          { safe: true },
        );
      }
      offlineRiskExpiresAt = new Date(
        Date.now() + Math.max(...authorizationMinutes) * 60_000,
      ).toISOString();
    }
    if (policies.length > 1) {
      const binding = policies.map(policy => (
        `${policy.currentPackSigningKeyId}:${policy.currentPackSigningPublicKeySha256}`
      ));
      if (new Set(binding).size !== 1) {
        throw AppError.conflict(
          'Affected facilities do not share one current continuity signing key',
          'CONTINUITY_DEVICE_LOSS_SIGNING_KEY_AMBIGUOUS',
          { safe: true },
        );
      }
    }
    return { existing, grants, subjects, facilityIds, configs, policies, offlineRiskExpiresAt };
  }, { readOnly: true, isolationLevel: 'RepeatableRead' });
}

async function phaseOne({
  tenantId,
  parsed,
  requestFingerprint,
  actorUid,
  requestId,
  preflightResult,
  revokeClinicalContinuityFacilityGrant,
  revokeContinuityEdgeGrant,
}) {
  return setTenantTx(tenantId, async tx => {
    let operation = await loadOperationByFingerprintTx(tx, tenantId, requestFingerprint, { forUpdate: true });
    if (operation?.capture_audit_event_id) return operation;
    if (!operation) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_device_loss_operations (
           tenant_id, stable_device_id, request_fingerprint,
           incident_reference, reason, actor_uid, actor_role, step_projection
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, 'SUPER_ADMIN', $7::jsonb)
         ON CONFLICT (tenant_id, request_fingerprint) DO NOTHING
         RETURNING *`,
        tenantId,
        parsed.stableDeviceId,
        requestFingerprint,
        parsed.incidentReference,
        parsed.reason,
        actorUid,
        JSON.stringify(initialStepProjection({
          facilityIds: preflightResult.facilityIds,
          offlineRiskExpiresAt: preflightResult.offlineRiskExpiresAt,
        })),
      );
      operation = rows[0] || await loadOperationByFingerprintTx(
        tx,
        tenantId,
        requestFingerprint,
        { forUpdate: true },
      );
    }
    if (!operation) throw new Error('Device-loss operation could not be acquired');

    for (const subject of preflightResult.subjects) {
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_continuity_device_loss_subjects (
           tenant_id, operation_id, staff_uid, staff_id, realm, break_glass
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer, 'staff', $5)
         ON CONFLICT (tenant_id, operation_id, staff_uid) DO NOTHING`,
        tenantId,
        operation.id,
        subject.uid,
        subject.staffId,
        subject.breakGlass,
      );
    }

    const captureRevocations = [];
    const edgeRevocations = [];
    const scopeRunner = async (_ignoredTenantId, callback) => callback(tx);
    for (const grant of preflightResult.grants.filter(row => row.grant_purpose !== 'edge_read')) {
      await setFacilityContextTx(tx, Number(grant.facility_id));
      captureRevocations.push(await revokeClinicalContinuityFacilityGrant({
        tenantId,
        facilityId: Number(grant.facility_id),
        grantId: grant.id,
        revokedBy: actorUid,
        reason: parsed.reason,
        scopeRunner,
      }));
    }
    for (const grant of preflightResult.grants.filter(row => row.grant_purpose === 'edge_read')) {
      await setFacilityContextTx(tx, Number(grant.facility_id));
      edgeRevocations.push(await revokeContinuityEdgeGrant({
        tenantId,
        facilityId: Number(grant.facility_id),
        grantId: grant.id,
        revokedBy: actorUid,
        reason: parsed.reason,
      }, { scopeRunner }));
    }

    const captureAudit = await requiredAudit(tx, auditInput({
      tenantId,
      operationId: operation.id,
      actorUid,
      requestId,
      action: 'continuity.device_loss.capture_grants_revoked',
      suffix: 'capture-grants',
      metadata: { incident_reference: parsed.incidentReference, revocations: captureRevocations },
    }));
    const edgeAudit = await requiredAudit(tx, auditInput({
      tenantId,
      operationId: operation.id,
      actorUid,
      requestId,
      action: 'continuity.device_loss.edge_read_grants_revoked',
      suffix: 'edge-read-grants',
      metadata: { incident_reference: parsed.incidentReference, revocations: edgeRevocations },
    }));

    const identityEvidenceIds = [];
    const tokenExclusionEvidenceIds = [];
    for (const subject of preflightResult.subjects) {
      const evidence = await deactivateScimIdentityTx(tx, {
        tenantId,
        uid: subject.uid,
        staffId: subject.staffId,
        realm: 'staff',
        breakGlass: subject.breakGlass,
        reason: parsed.reason,
        revokeTokens: false,
      });
      const identityAudit = await requiredAudit(tx, auditInput({
        tenantId,
        operationId: operation.id,
        actorUid,
        requestId,
        action: subject.breakGlass
          ? 'continuity.device_loss.identity_access_excluded'
          : 'continuity.device_loss.identity_access_revoked',
        suffix: `identity:${subject.uid}`,
        metadata: { staff_uid: subject.uid, ...evidence },
      }));
      identityEvidenceIds.push(identityAudit.id);
      let tokenAudit = null;
      if (subject.breakGlass) {
        tokenAudit = await requiredAudit(tx, auditInput({
          tenantId,
          operationId: operation.id,
          actorUid,
          requestId,
          action: 'continuity.device_loss.tokens_excluded',
          suffix: `tokens:${subject.uid}:excluded`,
          metadata: { staff_uid: subject.uid, excluded_break_glass: true },
        }));
        tokenExclusionEvidenceIds.push(tokenAudit.id);
      }
      const finalizedRows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_device_loss_subject_identity_finalize(
           $1::uuid, $2::uuid, $3::uuid, $4::varchar, $5::jsonb, $6::uuid,
           $7::varchar, $8::jsonb, $9::uuid
         ) AS finalized`,
        tenantId,
        operation.id,
        subject.uid,
        subject.breakGlass ? 'excluded_break_glass' : 'completed',
        JSON.stringify(evidence),
        identityAudit.id,
        subject.breakGlass ? 'excluded_break_glass' : null,
        JSON.stringify({ excluded_break_glass: true }),
        tokenAudit?.id || null,
      );
      if (finalizedRows[0]?.finalized !== true) {
        throw new Error('Device-loss subject identity finalization failed');
      }
    }

    let projection = operation.step_projection;
    projection = nextStep(projection, 'capture_grants', {
      state: captureRevocations.length ? 'completed' : 'not_applicable',
      evidenceIds: [captureAudit.id],
      details: { revoked_count: captureRevocations.length },
    });
    projection = nextStep(projection, 'edge_read_grants', {
      state: edgeRevocations.length ? 'completed' : 'not_applicable',
      evidenceIds: [edgeAudit.id],
      details: { revoked_count: edgeRevocations.length },
    });
    projection = nextStep(projection, 'identity_access', {
      state: preflightResult.subjects.length === 0
        ? 'not_applicable'
        : preflightResult.subjects.every(subject => subject.breakGlass)
          ? 'excluded'
          : 'completed',
      evidenceIds: identityEvidenceIds,
      details: { subject_count: preflightResult.subjects.length },
    });
    if (preflightResult.subjects.length === 0) {
      projection = nextStep(projection, 'tokens', { state: 'not_applicable' });
    } else if (preflightResult.subjects.every(subject => subject.breakGlass)) {
      projection = nextStep(projection, 'tokens', {
        state: 'excluded',
        evidenceIds: tokenExclusionEvidenceIds,
      });
    }
    const finalizedRows = await tx.$queryRawUnsafe(
      `SELECT public.clinical_continuity_device_loss_phase1_finalize(
         $1::uuid, $2::uuid, $3::jsonb, $4::uuid, $5::uuid
       ) AS finalized`,
      tenantId,
      operation.id,
      JSON.stringify(projection),
      captureAudit.id,
      edgeAudit.id,
    );
    if (finalizedRows[0]?.finalized !== true) {
      throw new Error('Device-loss Phase 1 finalization failed');
    }
    return loadOperationTx(tx, tenantId, operation.id);
  }, { isolationLevel: 'Serializable' });
}

async function recordStepFailure({
  tenantId,
  operationId,
  actorUid,
  requestId,
  stepName,
  code,
  metadata = {},
  subjectUid = null,
}) {
  return setTenantTx(tenantId, async tx => {
    const operation = await loadOperationTx(tx, tenantId, operationId, { forUpdate: true });
    if (!operation) throw new Error('Device-loss operation disappeared');
    const audit = await requiredAudit(tx, auditInput({
      tenantId,
      operationId,
      actorUid,
      requestId,
      action: `continuity.device_loss.${stepName}.failed`,
      status: 'failed',
      suffix: `${stepName}:failure:${Number(operation.step_projection?.[stepName]?.attempt || 0) + 1}`,
      metadata: { error_code: code, ...metadata },
    }));
    if (subjectUid) {
      const tokenRows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_device_loss_subject_token_record(
           $1::uuid, $2::uuid, $3::uuid, 'pending', $4::jsonb, $5::uuid
         ) AS recorded`,
        tenantId,
        operationId,
        subjectUid,
        JSON.stringify({ error_code: code, ...metadata }),
        audit.id,
      );
      if (tokenRows[0]?.recorded !== true) {
        throw new Error('Device-loss token failure evidence was not recorded');
      }
    }
    const projection = nextStep(operation.step_projection, stepName, {
      state: 'retryable_failed',
      evidenceIds: [audit.id],
      errorCode: code,
    });
    const failureRows = await tx.$queryRawUnsafe(
      `SELECT public.clinical_continuity_device_loss_step_failed(
         $1::uuid, $2::uuid, $3::jsonb
       ) AS recorded`,
      tenantId,
      operationId,
      JSON.stringify(projection),
    );
    if (failureRows[0]?.recorded !== true) {
      throw new Error('Device-loss step failure was not recorded');
    }
    return audit;
  }, { isolationLevel: 'Serializable' });
}

async function revokeTokens({ tenantId, operationId, actorUid, requestId }) {
  const subjects = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `SELECT staff_uid::text
       FROM clinical_continuity_device_loss_subjects
      WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
        AND token_state = 'pending'
      ORDER BY staff_uid`,
    tenantId,
    operationId,
  ), { readOnly: true, isolationLevel: 'RepeatableRead' });
  for (const subject of subjects) {
    let evidence;
    try {
      evidence = await revokeScimIdentityTokens({ uid: subject.staff_uid });
    } catch (error) {
      const code = error?.code || 'CONTINUITY_DEVICE_LOSS_TOKEN_REVOCATION_UNAVAILABLE';
      await recordStepFailure({
        tenantId,
        operationId,
        actorUid,
        requestId,
        stepName: 'tokens',
        code,
        subjectUid: subject.staff_uid,
        metadata: { staff_uid: subject.staff_uid },
      });
      return { failed: true, code };
    }
    await setTenantTx(tenantId, async tx => {
      const audit = await requiredAudit(tx, auditInput({
        tenantId,
        operationId,
        actorUid,
        requestId,
        action: 'continuity.device_loss.tokens_revoked',
        suffix: `tokens:${subject.staff_uid}:completed`,
        metadata: { staff_uid: subject.staff_uid, ...evidence },
      }));
      const tokenRows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_device_loss_subject_token_record(
           $1::uuid, $2::uuid, $3::uuid, 'completed', $4::jsonb, $5::uuid
         ) AS recorded`,
        tenantId,
        operationId,
        subject.staff_uid,
        JSON.stringify(evidence),
        audit.id,
      );
      if (tokenRows[0]?.recorded !== true) {
        throw new Error('Device-loss token evidence was not finalized');
      }
    }, { isolationLevel: 'Serializable' });
  }

  await setTenantTx(tenantId, async tx => {
    const operation = await loadOperationTx(tx, tenantId, operationId, { forUpdate: true });
    if (operation.wipe_content) return;
    const evidenceRows = await tx.$queryRawUnsafe(
      `SELECT token_state, token_audit_event_id::text
         FROM clinical_continuity_device_loss_subjects
        WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
        ORDER BY staff_uid`,
      tenantId,
      operationId,
    );
    if (evidenceRows.some(row => row.token_state === 'pending')) return;
    const evidenceIds = evidenceRows.map(row => row.token_audit_event_id).filter(Boolean);
    const projection = nextStep(operation.step_projection, 'tokens', {
      state: evidenceRows.length === 0
        ? 'not_applicable'
        : evidenceRows.every(row => row.token_state === 'excluded_break_glass')
          ? 'excluded'
          : 'completed',
      evidenceIds,
      increment: Number(operation.step_projection?.tokens?.attempt || 0) === 0,
    });
    const finalizedRows = await tx.$queryRawUnsafe(
      `SELECT public.clinical_continuity_device_loss_tokens_finalize(
         $1::uuid, $2::uuid, $3::jsonb
       ) AS finalized`,
      tenantId,
      operationId,
      JSON.stringify(projection),
    );
    if (finalizedRows[0]?.finalized !== true) {
      throw new Error('Device-loss token step finalization failed');
    }
  }, { isolationLevel: 'Serializable' });
  return { failed: false };
}

function wipeOrderContent(operation, facilityIds, subjectUids) {
  return Object.freeze({
    command: 'governed_wipe_device',
    execute_at: 'next_authenticated_contact',
    facility_ids: facilityIds.map(String),
    format: DEVICE_LOSS_ORDER_FORMAT,
    incident_reference: operation.incident_reference,
    issued_at: iso(operation.wipe_issued_at),
    operation_id: String(operation.id),
    order_id: String(operation.wipe_order_id),
    reason: operation.reason,
    stable_device_id: String(operation.stable_device_id),
    subject_uids: subjectUids,
    tenant_id: String(operation.tenant_id),
  });
}

async function issueWipeOrder({
  tenantId,
  operationId,
  actorUid,
  requestId,
  signer,
  policies,
  signClinicalContinuityCanonicalValue,
  verifyClinicalContinuityCanonicalSignature,
}) {
  const state = await setTenantTx(tenantId, async tx => {
    const operation = await loadOperationTx(tx, tenantId, operationId);
    const subjects = await tx.$queryRawUnsafe(
      `SELECT staff_uid::text
         FROM clinical_continuity_device_loss_subjects
        WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
        ORDER BY staff_uid`,
      tenantId,
      operationId,
    );
    return { operation, subjectUids: subjects.map(row => row.staff_uid) };
  }, { readOnly: true, isolationLevel: 'RepeatableRead' });
  if (state.operation.wipe_content) return { failed: false };
  const policy = policies[0];
  if (!policy) {
    await recordStepFailure({
      tenantId, operationId, actorUid, requestId, stepName: 'wipe_order',
      code: 'CONTINUITY_DEVICE_LOSS_SIGNING_POLICY_UNAVAILABLE',
    });
    return { failed: true, code: 'CONTINUITY_DEVICE_LOSS_SIGNING_POLICY_UNAVAILABLE' };
  }
  const facilityIds = state.operation.step_projection.facility_ids.map(Number);
  const content = wipeOrderContent(state.operation, facilityIds, state.subjectUids);
  const contentHash = hashCanonicalValue(content);
  let signature;
  try {
    signature = await signClinicalContinuityCanonicalValue({
      signer,
      keyId: policy.currentPackSigningKeyId,
      content,
    });
    if (!verifyClinicalContinuityCanonicalSignature({
      policy,
      keyId: policy.currentPackSigningKeyId,
      content,
      signature,
    })) {
      throw new Error('Continuity signer returned an unverifiable wipe order');
    }
  } catch (error) {
    const code = error?.code || 'CONTINUITY_DEVICE_LOSS_SIGNER_UNAVAILABLE';
    await recordStepFailure({
      tenantId, operationId, actorUid, requestId, stepName: 'wipe_order', code,
    });
    return { failed: true, code };
  }

  await setTenantTx(tenantId, async tx => {
    const operation = await loadOperationTx(tx, tenantId, operationId, { forUpdate: true });
    if (operation.wipe_content) {
      if (
        canonicalizeJson(operation.wipe_content) !== canonicalizeJson(content)
        || operation.wipe_content_hash !== contentHash
      ) {
        throw AppError.conflict(
          'Existing wipe order content does not match the operation',
          'CONTINUITY_DEVICE_LOSS_ORDER_CONFLICT',
        );
      }
      return;
    }
    const audit = await requiredAudit(tx, auditInput({
      tenantId,
      operationId,
      actorUid,
      requestId,
      action: 'continuity.device_loss.wipe_order_issued',
      suffix: 'wipe-order',
      metadata: {
        content_hash: contentHash,
        key_id: policy.currentPackSigningKeyId,
        order_id: operation.wipe_order_id,
      },
    }));
    const projection = nextStep(operation.step_projection, 'wipe_order', {
      state: 'completed',
      evidenceIds: [audit.id],
      errorCode: null,
    });
    const finalizedRows = await tx.$queryRawUnsafe(
      `SELECT public.clinical_continuity_device_loss_wipe_finalize(
         $1::uuid, $2::uuid, $3::jsonb, $4::char(64), $5::varchar,
         $6::varchar, $7::uuid, $8::jsonb
       ) AS finalized`,
      tenantId,
      operationId,
      JSON.stringify(content),
      contentHash,
      policy.currentPackSigningKeyId,
      signature,
      audit.id,
      JSON.stringify(projection),
    );
    if (finalizedRows[0]?.finalized !== true) {
      throw new Error('Device-loss wipe order finalization failed');
    }
  }, { isolationLevel: 'Serializable' });
  return { failed: false };
}

async function armNeedsReviewRouting({
  tenantId,
  operationId,
  actorUid,
  requestId,
  stableDeviceId,
  facilityIds,
}) {
  try {
    await setTenantTx(tenantId, async tx => {
      const operation = await loadOperationTx(tx, tenantId, operationId, { forUpdate: true });
      if (operation.routing_audit_event_id) return;
      const routes = [];
      for (const facilityId of facilityIds) {
        await setFacilityContextTx(tx, facilityId);
        const config = await loadClinicalContinuityReconciliationConfigTx(tx, tenantId, facilityId);
        if (
          config.fallback_principal !== 'role:clinical_safety_lead'
          || !config.clinical_safety_lead_uid
        ) {
          throw AppError.conflict(
            'Facility fallback reconciliation principal is not resolved',
            'CONTINUITY_RECONCILIATION_CONFIG_REQUIRED',
            { safe: true },
          );
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO clinical_continuity_device_loss_routes (
             tenant_id, stable_device_id, facility_id, operation_id,
             fallback_principal, assigned_to_uid
           ) VALUES ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5, $6::uuid)
           ON CONFLICT (tenant_id, stable_device_id, facility_id) DO NOTHING`,
          tenantId,
          stableDeviceId,
          facilityId,
          operationId,
          config.fallback_principal,
          config.clinical_safety_lead_uid,
        );
        const rows = await tx.$queryRawUnsafe(
          `SELECT facility_id, fallback_principal, assigned_to_uid::text,
                  operation_id::text
             FROM clinical_continuity_device_loss_routes
            WHERE tenant_id = $1::uuid AND stable_device_id = $2::uuid
              AND facility_id = $3::integer AND active = true`,
          tenantId,
          stableDeviceId,
          facilityId,
        );
        if (
          rows.length !== 1
          || rows[0].fallback_principal !== config.fallback_principal
          || rows[0].assigned_to_uid !== config.clinical_safety_lead_uid
        ) {
          throw AppError.conflict(
            'Existing lost-device route conflicts with C-D6 ownership',
            'CONTINUITY_DEVICE_LOSS_ROUTE_CONFLICT',
            { safe: true },
          );
        }
        routes.push(rows[0]);
      }
      const routingAudit = await requiredAudit(tx, auditInput({
        tenantId,
        operationId,
        actorUid,
        requestId,
        action: 'continuity.device_loss.needs_review_route_armed',
        suffix: 'needs-review-routing',
        metadata: { routes, stable_device_id: stableDeviceId },
      }));
      const riskAudit = await requiredAudit(tx, auditInput({
        tenantId,
        operationId,
        actorUid,
        requestId,
        action: 'continuity.device_loss.offline_pack_risk_recorded',
        suffix: 'offline-pack-risk',
        metadata: {
          stable_device_id: stableDeviceId,
          access_expires_no_later_than: operation.step_projection.offline_risk_expires_at,
          maximum_residual_hours: 24,
        },
      }));
      let projection = nextStep(operation.step_projection, 'needs_review_routing', {
        state: 'completed',
        evidenceIds: [routingAudit.id],
        details: { route_count: routes.length },
      });
      projection = nextStep(projection, 'offline_pack_risk', {
        state: 'awaiting_contact',
        evidenceIds: [riskAudit.id],
        details: { expires_no_later_than: operation.step_projection.offline_risk_expires_at },
      });
      const finalizedRows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_device_loss_routing_finalize(
           $1::uuid, $2::uuid, $4::uuid, $5::uuid, $3::jsonb
         ) AS finalized`,
        tenantId,
        operationId,
        JSON.stringify(projection),
        routingAudit.id,
        riskAudit.id,
      );
      if (finalizedRows[0]?.finalized !== true) {
        throw new Error('Device-loss routing finalization failed');
      }
    }, { isolationLevel: 'Serializable' });
    return { failed: false };
  } catch (error) {
    const code = error?.code || 'CONTINUITY_DEVICE_LOSS_ROUTING_UNAVAILABLE';
    await recordStepFailure({
      tenantId,
      operationId,
      actorUid,
      requestId,
      stepName: 'needs_review_routing',
      code,
    });
    return { failed: true, code };
  }
}

async function operationSnapshot({ tenantId, operationId, requestId, idempotentReplay }) {
  return setTenantTx(tenantId, async tx => {
    const operation = await loadOperationTx(tx, tenantId, operationId);
    const subjects = await tx.$queryRawUnsafe(
      `SELECT staff_uid::text, break_glass, identity_state,
              identity_audit_event_id::text, token_state,
              token_audit_event_id::text
         FROM clinical_continuity_device_loss_subjects
        WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
        ORDER BY staff_uid`,
      tenantId,
      operationId,
    );
    if (!operation) throw AppError.notFound('Device-loss operation not found');
    return Object.freeze({
      operation_id: String(operation.id),
      state: operation.state,
      stable_device_id: String(operation.stable_device_id),
      incident_reference: operation.incident_reference,
      idempotent_replay: idempotentReplay,
      subjects: Object.freeze(subjects.map(subject => Object.freeze({
        staff_uid: subject.staff_uid,
        break_glass: subject.break_glass,
        identity_revocation: subject.identity_state,
        token_revocation: subject.token_state,
        evidence_ids: [
          subject.identity_audit_event_id,
          subject.token_audit_event_id,
        ].filter(Boolean),
      }))),
      steps: Object.freeze(STEP_NAMES.map(name => Object.freeze({
        name,
        state: operation.step_projection?.[name]?.state || 'retryable_failed',
        attempt: Number(operation.step_projection?.[name]?.attempt || 0),
        evidence_ids: Object.freeze(operation.step_projection?.[name]?.evidence_ids || []),
        error_code: operation.step_projection?.[name]?.error_code || null,
        ...(operation.step_projection?.[name]?.expires_no_later_than
          ? { expires_no_later_than: operation.step_projection[name].expires_no_later_than }
          : {}),
      }))),
      wipe_order: operation.wipe_content ? Object.freeze({
        order_id: String(operation.wipe_order_id),
        content: operation.wipe_content,
        content_hash: operation.wipe_content_hash,
        algorithm: SIGNATURE_ALGORITHM,
        key_id: operation.wipe_key_id,
        signature: operation.wipe_signature,
        delivery_state: operation.state === 'executed' ? 'executed' : 'awaiting_contact',
      }) : null,
      request_id: requestId || null,
    });
  }, { readOnly: true, isolationLevel: 'RepeatableRead' });
}

export async function loadClinicalContinuityDeviceLossRouteTx(tx, {
  tenantId,
  stableDeviceId,
  facilityId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT operation_id::text, fallback_principal, assigned_to_uid::text,
            created_at, retention_until
       FROM clinical_continuity_device_loss_routes
      WHERE tenant_id = $1::uuid AND stable_device_id = $2::uuid
        AND facility_id = $3::integer AND active = true
      LIMIT 1`,
    tenantId,
    stableDeviceId,
    facilityId,
  );
  return rows[0] || null;
}

export async function orchestrateClinicalContinuityDeviceLoss({
  tenantId: rawTenantId,
  actorUid,
  actorRole,
  body,
  requestId = null,
  signer,
}) {
  const tenantId = requireTenantId(rawTenantId);
  if (normalizeRole(actorRole) !== 'SUPER_ADMIN') {
    throw AppError.forbidden(
      'Only SUPER_ADMIN may execute continuity device-loss containment',
      'CONTINUITY_DEVICE_LOSS_SUPER_ADMIN_REQUIRED',
    );
  }
  const parsed = parseClinicalContinuityDeviceLoss(body);
  const requestFingerprint = hashCanonicalValue({
    schema: 'clinical-continuity-device-loss/v1',
    tenant_id: tenantId,
    ...parsed,
  });
  const prepared = await preflight({ tenantId, parsed, requestFingerprint });
  const idempotentReplay = Boolean(prepared.existing);
  const {
    revokeClinicalContinuityFacilityGrant,
    signClinicalContinuityCanonicalValue,
    verifyClinicalContinuityCanonicalSignature,
  } = await import('./clinicalContinuityFacilityContextService.js');
  const { revokeContinuityEdgeGrant } = await import('./continuityEdgeAccessService.js');
  const phaseOneOperation = await phaseOne({
    tenantId,
    parsed,
    requestFingerprint,
    actorUid,
    requestId,
    preflightResult: prepared,
    revokeClinicalContinuityFacilityGrant,
    revokeContinuityEdgeGrant,
  });
  const operationId = String(phaseOneOperation.id);

  const tokenResult = await revokeTokens({ tenantId, operationId, actorUid, requestId });
  if (tokenResult.failed) {
    const operation = await operationSnapshot({ tenantId, operationId, requestId, idempotentReplay: true });
    throw retryable('Token revocation is incomplete; re-invocation will retry it', tokenResult.code, operation);
  }
  const wipeResult = await issueWipeOrder({
    tenantId,
    operationId,
    actorUid,
    requestId,
    signer,
    policies: prepared.policies,
    signClinicalContinuityCanonicalValue,
    verifyClinicalContinuityCanonicalSignature,
  });
  if (wipeResult.failed) {
    const operation = await operationSnapshot({ tenantId, operationId, requestId, idempotentReplay: true });
    throw retryable('Wipe-order issuance is incomplete; re-invocation will retry it', wipeResult.code, operation);
  }
  const routeResult = await armNeedsReviewRouting({
    tenantId,
    operationId,
    actorUid,
    requestId,
    stableDeviceId: parsed.stableDeviceId,
    facilityIds: prepared.facilityIds,
  });
  if (routeResult.failed) {
    const operation = await operationSnapshot({ tenantId, operationId, requestId, idempotentReplay: true });
    throw retryable('Needs-review routing is incomplete; re-invocation will retry it', routeResult.code, operation);
  }
  return operationSnapshot({ tenantId, operationId, requestId, idempotentReplay });
}

export const __testing__ = Object.freeze({ activationState, initialStepProjection, wipeOrderContent });
