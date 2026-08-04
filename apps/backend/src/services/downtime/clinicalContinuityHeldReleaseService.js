import { createHash } from 'node:crypto';

import { NHCX_CONFIG } from '../../config/nhcxConfig.js';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  HELD_MESSAGE_RELEASE_SCHEMA,
} from '../../validators/clinicalContinuityHeldReleaseSchemas.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { loadNHCXRuntimeConfig } from '../nhcx/nhcxTenantConfigService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { hashCanonicalValue } from './continuityPackCanonical.js';
import { loadActiveClinicalContinuityPolicyForFacilityTx } from './clinicalContinuityPolicyService.js';

const ACTION_ID = 'clinical_continuity.interface_held_message.release';
const BINDING_ID = `${ACTION_ID}/v1`;
const INCIDENT_ADMIN_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
  'QUALITY_OFFICER',
]);
const FAMILY_REASON_CODES = Object.freeze({
  I04: new Set([
    'downstream_readiness_confirmed',
    'duplicate_delivery_risk_reviewed',
    'acknowledgement_uncertainty_reviewed',
  ]),
  I05: new Set([
    'downstream_readiness_confirmed',
    'transport_configuration_corrected',
    'duplicate_delivery_risk_reviewed',
    'owner_recovery_evidence_reconciled',
  ]),
  I19: new Set([
    'downstream_readiness_confirmed',
    'transport_configuration_corrected',
    'duplicate_delivery_risk_reviewed',
    'owner_recovery_evidence_reconciled',
  ]),
});
const SOURCE_FIELDS = Object.freeze({
  I04: 'hl7_outbound_message_id',
  I05: 'interop_message_id',
  I19: 'nhcx_message_id',
});
const AUTHORITY_STATES = Object.freeze({
  I04: Object.freeze({
    prior: Object.freeze({ status: 'reconciliation_required', send_authority: 'held_owner_reconciliation' }),
    next: Object.freeze({ status: 'queued', send_authority: 'authorized' }),
  }),
  I05: Object.freeze({
    prior: Object.freeze({
      status: 'quarantined',
      send_authority: 'held',
      owner_reconciliation_required: true,
    }),
    next: Object.freeze({
      status: 'queued',
      send_authority: 'owner_authorized',
      owner_reconciliation_required: false,
    }),
  }),
  I19: Object.freeze({
    prior: Object.freeze({ status: 'recovery_pending' }),
    next: Object.freeze({ status: 'pending' }),
  }),
});

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function deterministicUuid(value) {
  const chars = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} is invalid`, 'CONTINUITY_IDENTIFIER_INVALID');
  }
  return parsed;
}

function idempotencyKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200) {
    throw AppError.badRequest('Idempotency-Key is required', 'CONTINUITY_IDEMPOTENCY_KEY_REQUIRED');
  }
  return normalized;
}

async function facilityTransaction({ tenantId, facilityId, isolationLevel = 'Serializable' }, callback) {
  const tenant = requireTenantId(tenantId);
  const facility = positiveInteger(facilityId, 'facility_id');
  return setTenantTx(tenant, async tx => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_facility_id', $1, true)`, String(facility));
    return callback(tx, { tenantId: tenant, facilityId: facility });
  }, { isolationLevel });
}

async function requiredAudit(tx, input) {
  const row = await recordClinicalAuditEvent(input, { db: tx });
  if (!row) throw AppError.internal('Held-message audit evidence was not recorded', 'CONTINUITY_AUDIT_REQUIRED');
  return row;
}

async function loadConfigTx(tx, tenantId, facilityId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, fallback_principal, clinical_safety_lead_uid::text,
            interface_owner_principal, version
       FROM clinical_continuity_reconciliation_config
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer
      FOR SHARE`,
    tenantId,
    facilityId,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Facility continuity reconciliation ownership is not configured',
      'CONTINUITY_RECONCILIATION_CONFIG_REQUIRED',
      { safe: true },
    );
  }
  return rows[0];
}

async function sourceSnapshotTx(tx, tenantId, family, messageId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT public.clinical_continuity_held_message_snapshot(
       $1::uuid, $2::varchar, $3::bigint
     ) AS snapshot`,
    tenantId,
    family,
    messageId,
  );
  return rows[0]?.snapshot;
}

function assertSourceReleaseable(family, snapshot) {
  const denied = () => {
    throw AppError.conflict(
      `${family} held message is not releaseable`,
      'CONTINUITY_HELD_MESSAGE_NOT_RELEASEABLE',
      { safe: true },
    );
  };
  if (!snapshot || snapshot.interface_family !== family) denied();
  if (family === 'I04') {
    if (
      Number(snapshot.ledger_version) !== 1
      || snapshot.status !== 'reconciliation_required'
      || snapshot.send_authority !== 'held_owner_reconciliation'
      || snapshot.claim_token != null
      || snapshot.positive_ack_exists === true
      || !snapshot.payload_sha256
      || !snapshot.recovery_inbox_id
    ) denied();
    return Object.freeze({ holdReasonCode: 'acknowledgement_or_delivery_uncertainty', safetyClass: 'safety_critical' });
  }
  if (family === 'I05') {
    if (
      Number(snapshot.recovery_ledger_version) !== 1
      || snapshot.status !== 'quarantined'
      || snapshot.arrival_class !== 'recovery_backlog'
      || snapshot.effect_disposition !== 'late_pending_only'
      || snapshot.send_authority !== 'held'
      || snapshot.owner_reconciliation_required !== true
      || !['outbound', 'bidirectional'].includes(snapshot.direction)
      || !['hl7v2', 'csv', 'json', 'fhir_json', 'other'].includes(snapshot.protocol)
      || snapshot.delivery_claim_token != null
      || snapshot.channel_status !== 'active'
      || snapshot.channel_version_status !== 'active'
      || String(snapshot.channel_active_version_id) !== String(snapshot.channel_version_id)
      || snapshot.raw_payload_retained !== true
      || !snapshot.payload_hash
      || !snapshot.recovery_inbox_id
    ) denied();
    return Object.freeze({ holdReasonCode: 'recovery_backlog_owner_reconciliation', safetyClass: 'safety_critical' });
  }
  if (
    snapshot.status !== 'recovery_pending'
    || snapshot.direction !== 'outbound'
    || snapshot.cycle === 'payment_notice'
    || snapshot.recovery_disposition !== 'manual_redrive_requested'
    || snapshot.payload_ciphertext_present !== true
    || !snapshot.payload_hash
    || !snapshot.recovery_inbox_id
  ) denied();
  return Object.freeze({ holdReasonCode: 'outbound_recovery_owner_reconciliation', safetyClass: 'routine_operational' });
}

function resolvedAssignee({ actorUid, actorRole, config, requirement }) {
  if (requirement.assigned_to_uid) return String(requirement.assigned_to_uid);
  if (config.interface_owner_principal === config.fallback_principal) return config.clinical_safety_lead_uid;
  const expectedRole = `role:${normalizeRole(actorRole).toLowerCase()}`;
  return config.interface_owner_principal.toLowerCase() === expectedRole ? actorUid : null;
}

function sourceIdentity(family, messageId) {
  return `${family}:${messageId}`;
}

function effectIdentity({ tenantId, facilityId, incidentId, incidentInterfaceId, itemId, family, messageId, snapshot }) {
  return Object.freeze({
    action_id: ACTION_ID,
    binding_id: BINDING_ID,
    facility_id: facilityId,
    incident_id: incidentId,
    incident_interface_id: incidentInterfaceId,
    interface_family: family,
    message_id: String(messageId),
    original_recovery_inbox_id: snapshot.recovery_inbox_id,
    reconciliation_item_id: itemId,
    schema_id: HELD_MESSAGE_RELEASE_SCHEMA.id,
    schema_version: HELD_MESSAGE_RELEASE_SCHEMA.version,
    tenant_id: tenantId,
  });
}

function commandFingerprint({ item, requirement, actorUid, actorRole, parsed, attestationId = null, releaseVersion }) {
  const family = item.interface_family;
  const messageId = item[SOURCE_FIELDS[family]];
  const authority = AUTHORITY_STATES[family];
  return hashCanonicalValue({
    effect_identity: effectIdentity({
      tenantId: item.tenant_id,
      facilityId: Number(item.facility_id),
      incidentId: item.incident_id,
      incidentInterfaceId: item.incident_interface_id,
      itemId: item.id,
      family,
      messageId,
      snapshot: item.source_state_snapshot,
    }),
    expected_incident_interface_version: Number(requirement.version),
    expected_item_version: Number(releaseVersion),
    hold_safety_class: item.hold_safety_class,
    intended_releaser_uid: item.assigned_to_uid,
    original_releaser_role: normalizeRole(actorRole),
    original_releaser_uid: actorUid,
    prior_authority_state: authority.prior,
    next_authority_state: authority.next,
    release_attestation_decision_id: attestationId,
    release_reason_code: parsed.releaseReasonCode,
    release_reason_detail: parsed.releaseReasonDetail,
    source_state_fingerprint: parsed.sourceStateFingerprint,
    source_version_evidence: family === 'I05'
      ? {
          channel_id: item.source_state_snapshot.channel_id,
          channel_version_id: item.source_state_snapshot.channel_version_id,
          channel_version_number: item.source_state_snapshot.channel_version_number,
          connector_config_sha256: item.source_state_snapshot.connector_config_sha256,
          protocol: item.source_state_snapshot.protocol,
        }
      : family === 'I19'
        ? {
            cycle: item.source_state_snapshot.cycle,
            endpoint: item.source_state_snapshot.endpoint,
            environment: item.source_state_snapshot.environment,
            hcx_api_call_id: item.source_state_snapshot.hcx_api_call_id,
          }
        : { ledger_version: item.source_state_snapshot.ledger_version },
  });
}

function requireFamilyReason(family, reasonCode) {
  if (!FAMILY_REASON_CODES[family]?.has(reasonCode)) {
    throw AppError.badRequest(
      `release_reason_code is not valid for ${family}`,
      'CONTINUITY_HELD_MESSAGE_REASON_INVALID',
      { safe: true },
    );
  }
}

async function loadItemContextTx(tx, { tenantId, facilityId, itemId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT item.*, requirement.version AS incident_interface_version,
            requirement.assigned_to_uid::text AS requirement_assigned_to_uid,
            requirement.source_partition AS requirement_source_partition,
            requirement.offset_id::text AS requirement_offset_id
       FROM clinical_continuity_reconciliation_items AS item
       JOIN clinical_continuity_incident_interfaces AS requirement
         ON requirement.tenant_id = item.tenant_id
        AND requirement.facility_id = item.facility_id
        AND requirement.id = item.incident_interface_id
      WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
        AND item.id = $3::uuid AND item.interface_item_kind = 'held_message_release'
      FOR UPDATE OF item, requirement`,
    tenantId,
    facilityId,
    itemId,
  );
  if (!rows[0]) throw AppError.notFound('Held-message reconciliation item not found', 'CONTINUITY_HELD_MESSAGE_ITEM_NOT_FOUND');
  return {
    item: rows[0],
    requirement: {
      version: rows[0].incident_interface_version,
      assigned_to_uid: rows[0].requirement_assigned_to_uid,
      source_partition: rows[0].requirement_source_partition,
      offset_id: rows[0].requirement_offset_id,
    },
  };
}

async function assertNhcxRuntimeReady(tenantId) {
  const runtime = await loadNHCXRuntimeConfig(tenantId);
  const globallyEnabled = NHCX_CONFIG.enabled === true
    || String(process.env.NHCX_ENABLED || '').toLowerCase() === 'true';
  const enabled = runtime?.effectiveEnabled === true || (globallyEnabled && runtime?.enabled === true);
  if (!enabled || !runtime?.gatewayBaseUrl || (runtime?.missing || []).filter(Boolean).length > 0) {
    throw AppError.conflict(
      'NHCX runtime is disabled or incomplete',
      'CONTINUITY_HELD_MESSAGE_RUNTIME_NOT_READY',
      { safe: true },
    );
  }
}

export async function bindClinicalContinuityHeldMessage({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  parsed,
}) {
  const role = normalizeRole(actorRole);
  if (!INCIDENT_ADMIN_ROLES.has(role)) {
    throw AppError.forbidden('Held-message binding was denied', 'CONTINUITY_HELD_MESSAGE_BIND_DENIED', { safe: true });
  }
  const result = await facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const requirementRows = await tx.$queryRawUnsafe(
      `SELECT requirement.*
         FROM clinical_continuity_incident_interfaces AS requirement
         JOIN clinical_continuity_incidents AS incident
           ON incident.tenant_id = requirement.tenant_id
          AND incident.facility_id = requirement.facility_id
          AND incident.id = requirement.incident_id
        WHERE requirement.tenant_id = $1::uuid AND requirement.facility_id = $2::integer
          AND requirement.id = $3::uuid AND requirement.incident_id = $4::uuid
          AND requirement.interface_family = $5
          AND requirement.version = $6::integer
          AND requirement.disposition <> 'not_applicable'
          AND incident.lifecycle_state IN ('declared', 'restored', 'reconciling')
        FOR UPDATE OF requirement, incident`,
      scope.tenantId,
      scope.facilityId,
      parsed.incidentInterfaceId,
      incidentId,
      parsed.interfaceFamily,
      parsed.expectedIncidentInterfaceVersion,
    );
    const requirement = requirementRows[0];
    if (!requirement) {
      throw AppError.conflict('Incident-interface requirement changed', 'CONTINUITY_STALE_PROJECTION', { safe: true });
    }
    const snapshot = await sourceSnapshotTx(tx, scope.tenantId, parsed.interfaceFamily, parsed.messageId);
    const sourceFingerprint = hashCanonicalValue(snapshot);
    if (sourceFingerprint !== parsed.sourceStateFingerprint) {
      throw AppError.conflict('Held-message source state changed', 'CONTINUITY_HELD_MESSAGE_SOURCE_DRIFT', { safe: true });
    }
    const classification = assertSourceReleaseable(parsed.interfaceFamily, snapshot);
    if (
      String(requirement.offset_id) !== String(snapshot.offset_id)
      || requirement.source_partition !== snapshot.source_partition
    ) {
      throw AppError.conflict(
        'Held message does not match the incident-interface recovery source',
        'CONTINUITY_HELD_MESSAGE_REQUIREMENT_MISMATCH',
        { safe: true },
      );
    }
    const sourceField = SOURCE_FIELDS[parsed.interfaceFamily];
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_reconciliation_items
        WHERE tenant_id = $1::uuid AND ${sourceField} = $2
          AND interface_item_kind = 'held_message_release'
        FOR UPDATE`,
      scope.tenantId,
      parsed.messageId,
    );
    if (existingRows[0]) {
      const existing = existingRows[0];
      if (
        existing.facility_id === scope.facilityId
        && existing.incident_id === incidentId
        && existing.incident_interface_id === parsed.incidentInterfaceId
        && existing.interface_family === parsed.interfaceFamily
        && existing.source_state_fingerprint === sourceFingerprint
        && existing.hold_safety_class === classification.safetyClass
      ) return { item: existing, exact_duplicate: true };
      await requiredAudit(tx, {
        tenantId: scope.tenantId,
        action: 'clinical_continuity.interface_held_message.bind_denied',
        actionStatus: 'denied',
        actorUid,
        actorRole: role,
        resourceType: 'clinical_continuity_reconciliation_item',
        resourceTable: 'clinical_continuity_reconciliation_items',
        resourceId: existing.id,
        requestId,
        afterState: { code: 'CONTINUITY_HELD_MESSAGE_BINDING_DRIFT' },
        idempotencyKey: `cc-held-bind-denied:${existing.id}:${sourceFingerprint}`,
      });
      return { binding_mismatch: true };
    }
    const assignedToUid = resolvedAssignee({ actorUid, actorRole: role, config, requirement });
    const sourceColumns = {
      hl7_outbound_message_id: null,
      interop_message_id: null,
      nhcx_message_id: null,
    };
    sourceColumns[sourceField] = parsed.messageId;
    const insertedRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_reconciliation_items (
         tenant_id, facility_id, incident_id, queue_type, disposition, reason_code,
         safety_critical, owner_principal, assigned_to_uid, created_by, updated_by,
         incident_interface_id, interface_item_kind, interface_family,
         hl7_outbound_message_id, interop_message_id, nhcx_message_id,
         hold_reason_code, hold_safety_class, source_state_snapshot, source_state_fingerprint
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, 'interface', 'open', $4,
         $5, $6, $7::uuid, $8::uuid, $8::uuid,
         $9::uuid, 'held_message_release', $10,
         $11::integer, $12::integer, $13::bigint,
         $4, $14, $15::jsonb, $16
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      incidentId,
      classification.holdReasonCode,
      classification.safetyClass === 'safety_critical',
      config.interface_owner_principal,
      assignedToUid,
      actorUid,
      parsed.incidentInterfaceId,
      parsed.interfaceFamily,
      sourceColumns.hl7_outbound_message_id,
      sourceColumns.interop_message_id,
      sourceColumns.nhcx_message_id,
      classification.safetyClass,
      JSON.stringify(snapshot),
      sourceFingerprint,
    );
    let item = insertedRows[0];
    const task = await createTask({
      tenantId: scope.tenantId,
      taskKind: 'review',
      title: `Review held ${parsed.interfaceFamily} message ${parsed.messageId}`,
      description: 'Inspect immutable recovery evidence before granting send authority.',
      relatedResourceType: 'clinical_continuity_reconciliation_item',
      relatedResourceId: item.id,
      priority: classification.safetyClass === 'safety_critical' ? 'critical' : 'high',
      assignedToUid,
      assignedToRole: !assignedToUid && config.interface_owner_principal.startsWith('role:')
        ? config.interface_owner_principal.slice(5).toUpperCase()
        : null,
      createdBy: actorUid,
      slaCompletionSemantics: 'none',
      metadata: {
        continuity_incident_id: incidentId,
        incident_interface_id: parsed.incidentInterfaceId,
        interface_family: parsed.interfaceFamily,
        interface_item_kind: 'held_message_release',
        message_id: String(parsed.messageId),
      },
      onConflictResourceDoNothing: true,
      tx,
    });
    if (task) {
      const linkedRows = await tx.$queryRawUnsafe(
        `UPDATE clinical_continuity_reconciliation_items
            SET task_id = $1::integer, updated_by = $2::uuid,
                updated_at = clock_timestamp(), version = version + 1
          WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid
          RETURNING *`,
        task.id,
        actorUid,
        scope.tenantId,
        scope.facilityId,
        item.id,
      );
      item = linkedRows[0];
    }
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.interface_held_message.bound',
      actorUid,
      actorRole: role,
      resourceType: 'clinical_continuity_reconciliation_item',
      resourceTable: 'clinical_continuity_reconciliation_items',
      resourceId: item.id,
      requestId,
      afterState: {
        incident_interface_id: parsed.incidentInterfaceId,
        interface_family: parsed.interfaceFamily,
        message_id: String(parsed.messageId),
        hold_safety_class: classification.safetyClass,
        source_state_fingerprint: sourceFingerprint,
      },
      idempotencyKey: `cc-held-bind:${item.id}`,
    });
    return { item, task: task || null, audit_event_id: audit.id, exact_duplicate: false };
  });
  if (result?.binding_mismatch) {
    throw AppError.conflict('Held message is already bound differently', 'CONTINUITY_HELD_MESSAGE_BINDING_DRIFT', { safe: true });
  }
  return result;
}

export async function attestClinicalContinuityHeldMessageRelease({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  itemId,
  parsed,
}) {
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const { item, requirement } = await loadItemContextTx(tx, {
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      itemId,
    });
    if (item.hold_safety_class !== 'safety_critical') {
      throw AppError.conflict('Routine held messages do not accept safety attestations', 'CONTINUITY_HELD_MESSAGE_ATTESTATION_NOT_REQUIRED', { safe: true });
    }
    requireFamilyReason(item.interface_family, parsed.releaseReasonCode);
    if (parsed.sourceStateFingerprint !== item.source_state_fingerprint) {
      throw AppError.conflict('Held-message source fingerprint changed', 'CONTINUITY_HELD_MESSAGE_SOURCE_DRIFT', { safe: true });
    }
    if (!item.assigned_to_uid) {
      throw AppError.conflict('Held-message release requires a named assignee', 'CONTINUITY_HELD_MESSAGE_ASSIGNEE_REQUIRED', { safe: true });
    }
    const decisionId = deterministicUuid([
      'cc-held-attestation', scope.tenantId, item.id, parsed.expectedVersion,
      item.assigned_to_uid, parsed.releaseReasonCode, parsed.releaseReasonDetail,
      parsed.sourceStateFingerprint,
    ].join(':'));
    const fingerprint = commandFingerprint({
      item,
      requirement,
      actorUid: item.assigned_to_uid,
      actorRole: item.owner_principal.startsWith('role:') ? item.owner_principal.slice(5) : actorRole,
      parsed,
      attestationId: decisionId,
      releaseVersion: parsed.expectedVersion + 1,
    });
    const rows = await tx.$queryRawUnsafe(
      `SELECT public.clinical_continuity_held_release_attest(
         $1::uuid, $2::integer, $3::jsonb
       ) AS decision`,
      scope.tenantId,
      scope.facilityId,
      JSON.stringify({
        id: decisionId,
        reconciliation_item_id: item.id,
        actor_uid: actorUid,
        intended_releaser_uid: item.assigned_to_uid,
        expected_version: parsed.expectedVersion,
        release_reason_code: parsed.releaseReasonCode,
        release_reason_detail: parsed.releaseReasonDetail,
        command_fingerprint: fingerprint,
        source_state_fingerprint: parsed.sourceStateFingerprint,
      }),
    );
    const decision = rows[0]?.decision;
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.interface_held_message.release_attested',
      actorUid,
      actorRole: normalizeRole(actorRole),
      resourceType: 'clinical_continuity_reconciliation_item',
      resourceTable: 'clinical_continuity_reconciliation_items',
      resourceId: item.id,
      requestId,
      afterState: {
        decision_id: decisionId,
        intended_releaser_uid: item.assigned_to_uid,
        command_fingerprint: fingerprint,
        network_send_performed: false,
      },
      idempotencyKey: `cc-held-attestation:${decisionId}`,
    });
    return { decision, command_fingerprint: fingerprint, audit_event_id: audit.id };
  });
}

function heldReceipt({
  scope,
  item,
  actorUid,
  actorRole,
  facilityContext,
  appVersion,
  devicePosture,
  rawIdempotencyKey,
  policy,
  fingerprint,
  clientEventId,
  receivedAt,
}) {
  if (!policy.effectiveUntil) {
    throw AppError.conflict('Continuity policy requires a finite effective window', 'CONTINUITY_POLICY_NOT_EFFECTIVE');
  }
  const family = item.interface_family;
  const messageId = item[SOURCE_FIELDS[family]];
  const payloadHash = family === 'I04'
    ? item.source_state_snapshot.payload_sha256
    : item.source_state_snapshot.payload_hash;
  const orderingIdentity = effectIdentity({
    tenantId: scope.tenantId,
    facilityId: scope.facilityId,
    incidentId: item.incident_id,
    incidentInterfaceId: item.incident_interface_id,
    itemId: item.id,
    family,
    messageId,
    snapshot: item.source_state_snapshot,
  });
  const expiresAt = new Date(Date.parse(receivedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const sourceColumns = {
    hl7_outbound_message_id: null,
    interop_message_id: null,
    nhcx_message_id: null,
  };
  sourceColumns[SOURCE_FIELDS[family]] = messageId;
  return {
    tenant_id: scope.tenantId,
    client_event_id: clientEventId,
    source_kind: 'held_message_release',
    facility_id: scope.facilityId,
    incident_id: item.incident_id,
    paper_item_id: null,
    original_idempotency_key: rawIdempotencyKey,
    action_id: ACTION_ID,
    binding_id: BINDING_ID,
    http_method: 'POST',
    schema_id: HELD_MESSAGE_RELEASE_SCHEMA.id,
    schema_version: HELD_MESSAGE_RELEASE_SCHEMA.version,
    schema_checksum: HELD_MESSAGE_RELEASE_SCHEMA.checksum,
    client_command_fingerprint: fingerprint,
    receipt_fingerprint: fingerprint,
    payload_hash: payloadHash,
    capture_actor_uid: actorUid,
    capture_role: normalizeRole(actorRole),
    patient_id: null,
    patient_uid: null,
    appointment_id: null,
    encounter_id: null,
    admission_id: null,
    unit_id: null,
    device_id: facilityContext.deviceId,
    device_posture: String(devicePosture || 'managed').slice(0, 32),
    capture_session_id: facilityContext.contextId,
    occurred_at: receivedAt,
    captured_at: receivedAt,
    queued_at: receivedAt,
    expires_at: expiresAt,
    clock_evidence_hash: hashCanonicalValue({ received_at: receivedAt, source: 'server' }),
    cached_sources_hash: hashCanonicalValue({
      incident_id: item.incident_id,
      incident_interface_id: item.incident_interface_id,
      source_state_fingerprint: item.source_state_fingerprint,
    }),
    source_cache_version: `reconciliation-item:${item.version}`,
    app_version: String(appVersion || 'continuity-reconciliation/v1').slice(0, 80),
    envelope_schema_version: 1,
    queue_schema_version: 1,
    action_version: 1,
    action_checksum: HELD_MESSAGE_RELEASE_SCHEMA.checksum,
    policy_id: policy.id,
    policy_version: policy.policyVersion,
    policy_checksum: policy.policyChecksum,
    policy_signing_key_id: policy.policySigningKeyId,
    policy_effective_from: policy.effectiveFrom,
    policy_effective_until: policy.effectiveUntil,
    policy_supersedes_id: policy.supersedesPolicyId,
    policy_revocation_epoch: policy.revocationEpoch,
    registry_version: policy.actionRegistryVersion,
    registry_checksum: policy.actionRegistryChecksum,
    minimum_app_version: String(policy.policyDocument?.minimumAppVersion || 'continuity-reconciliation/v1'),
    base_revision: item.version,
    base_etag: null,
    ordering_key: sourceIdentity(family, messageId),
    ordering_key_digest: hashCanonicalValue(orderingIdentity),
    sequence_no: 1,
    predecessor_client_event_id: null,
    supersession_generation: 0,
    human_review_required: item.hold_safety_class === 'safety_critical',
    reconciliation_item_id: item.id,
    incident_interface_id: item.incident_interface_id,
    subject_kind: 'interface_held_message',
    subject_key: sourceIdentity(family, messageId),
    interface_family: family,
    ...sourceColumns,
    source_state_fingerprint: item.source_state_fingerprint,
  };
}

function heldEffect({
  scope,
  item,
  actorUid,
  actorRole,
  parsed,
  fingerprint,
  clientEventId,
  attestationId,
  auditId,
}) {
  const family = item.interface_family;
  const authority = AUTHORITY_STATES[family];
  const sourceColumns = {
    hl7_outbound_message_id: null,
    interop_message_id: null,
    nhcx_message_id: null,
  };
  sourceColumns[SOURCE_FIELDS[family]] = item[SOURCE_FIELDS[family]];
  return {
    tenant_id: scope.tenantId,
    client_event_id: clientEventId,
    note_draft_id: null,
    outcome_code: 'held_message_send_authority_rearmed',
    draft_revision: null,
    draft_updated_at: null,
    clinical_timeline_event_id: null,
    clinical_audit_event_id: null,
    workflow_sla_instance_id: null,
    notification_outbox_id: null,
    event_outbox_id: null,
    created_at: new Date().toISOString(),
    retrospective_fact_id: null,
    paper_item_row_id: null,
    fact_resource_type: null,
    fact_resource_id: null,
    occurred_at: null,
    recorded_at: null,
    reviewed_at: null,
    decided_at: null,
    retrospective_event_outbox_id: null,
    effect_disposition: null,
    facility_id: scope.facilityId,
    reconciliation_item_id: item.id,
    release_attestation_decision_id: attestationId,
    interface_family: family,
    ...sourceColumns,
    original_releaser_uid: actorUid,
    original_releaser_role: normalizeRole(actorRole),
    release_reason_code: parsed.releaseReasonCode,
    release_reason_detail: parsed.releaseReasonDetail,
    prior_authority_state: authority.prior,
    prior_authority_state_hash: hashCanonicalValue(authority.prior),
    next_authority_state: authority.next,
    next_authority_state_hash: hashCanonicalValue(authority.next),
    source_state_fingerprint: item.source_state_fingerprint,
    command_fingerprint: fingerprint,
    released_at: null,
    release_audit_event_id: auditId,
    network_send_performed: false,
  };
}

export async function releaseClinicalContinuityHeldMessage({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  itemId,
  parsed,
  facilityContext,
  appVersion,
  devicePosture,
  idempotencyKey: rawIdempotencyKey,
}) {
  const originalIdempotencyKey = idempotencyKey(rawIdempotencyKey);
  const result = await facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const { item, requirement } = await loadItemContextTx(tx, {
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      itemId,
    });
    requireFamilyReason(item.interface_family, parsed.releaseReasonCode);
    if (parsed.sourceStateFingerprint !== item.source_state_fingerprint) {
      throw AppError.conflict('Held-message source fingerprint changed', 'CONTINUITY_HELD_MESSAGE_SOURCE_DRIFT', { safe: true });
    }
    if (item.hold_safety_class === 'unclassified') {
      throw AppError.conflict('Unclassified held messages cannot be released', 'CONTINUITY_HELD_MESSAGE_UNCLASSIFIED', { safe: true });
    }
    const attestationId = item.hold_safety_class === 'safety_critical'
      ? parsed.safetyAttestationId
      : null;
    if (item.hold_safety_class === 'safety_critical' && !attestationId) {
      throw AppError.conflict('Distinct safety attestation is required', 'CONTINUITY_HELD_MESSAGE_ATTESTATION_REQUIRED', { safe: true });
    }
    if (item.hold_safety_class === 'routine_operational' && parsed.safetyAttestationId) {
      throw AppError.badRequest('Routine releases cannot carry a safety attestation', 'CONTINUITY_HELD_MESSAGE_ATTESTATION_INVALID', { safe: true });
    }
    const fingerprint = commandFingerprint({
      item,
      requirement,
      actorUid,
      actorRole,
      parsed,
      attestationId,
      releaseVersion: parsed.expectedVersion,
    });
    const clientEventId = deterministicUuid(`cc-held-release:${scope.tenantId}:${item.interface_family}:${item[SOURCE_FIELDS[item.interface_family]]}`);
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT disposition, client_command_fingerprint
         FROM clinical_continuity_replay_receipts
        WHERE tenant_id = $1::uuid AND client_event_id = $2::uuid`,
      scope.tenantId,
      clientEventId,
    );
    if (item.interface_family === 'I19' && existingRows.length === 0) {
      await assertNhcxRuntimeReady(scope.tenantId);
    }
    const policy = await loadActiveClinicalContinuityPolicyForFacilityTx({
      tx,
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
    });
    const receivedAt = new Date().toISOString();
    const receipt = heldReceipt({
      scope,
      item,
      actorUid,
      actorRole,
      facilityContext,
      appVersion,
      devicePosture,
      rawIdempotencyKey: originalIdempotencyKey,
      policy,
      fingerprint,
      clientEventId,
      receivedAt,
    });
    const authority = AUTHORITY_STATES[item.interface_family];
    const audit = existingRows.length === 0
      ? await requiredAudit(tx, {
        tenantId: scope.tenantId,
        action: 'clinical_continuity.interface_held_message.release',
        actionStatus: 'success',
        actorUid,
        actorRole: normalizeRole(actorRole),
        resourceType: 'clinical_continuity_reconciliation_item',
        resourceTable: 'clinical_continuity_reconciliation_items',
        resourceId: item.id,
        requestId,
        beforeState: authority.prior,
        afterState: authority.next,
        metadata: {
          interface_family: item.interface_family,
          receipt_client_event_id: clientEventId,
          network_send_performed: false,
        },
        idempotencyKey: `cc-held-release:${clientEventId}`,
      })
      : null;
    const effect = heldEffect({
      scope,
      item,
      actorUid,
      actorRole,
      parsed,
      fingerprint,
      clientEventId,
      attestationId,
      auditId: audit?.id ?? null,
    });
    const releaseDecisionId = deterministicUuid(`cc-held-release-decision:${clientEventId}`);
    const rows = await tx.$queryRawUnsafe(
      `SELECT public.clinical_continuity_held_message_release(
         $1::uuid, $2::integer, $3::jsonb
       ) AS result`,
      scope.tenantId,
      scope.facilityId,
      JSON.stringify({
        actor_uid: actorUid,
        reconciliation_item_id: item.id,
        release_decision_id: releaseDecisionId,
        release_attestation_decision_id: attestationId,
        expected_version: parsed.expectedVersion,
        expected_incident_interface_version: Number(requirement.version),
        command_fingerprint: fingerprint,
        release_reason_code: parsed.releaseReasonCode,
        release_reason_detail: parsed.releaseReasonDetail,
        facility_context_id: facilityContext.contextId,
        facility_context_revision: facilityContext.contextRevision,
        request_id: requestId,
        receipt,
        effect,
      }),
    );
    const commandResult = rows[0]?.result;
    if (commandResult?.disposition === 'applied') {
      const completed = await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = 'completed', completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status IN ('open', 'in_progress', 'blocked', 'overdue')
            AND assigned_to_uid = $3::uuid
            AND sla_completion_semantics = 'none'
            AND workflow_sla_instance_id IS NULL`,
        scope.tenantId,
        item.task_id,
        actorUid,
      );
      if (completed !== 1) {
        throw AppError.conflict(
          'Held-message task changed during release',
          'CONTINUITY_HELD_MESSAGE_TASK_DRIFT',
          { safe: true },
        );
      }
    }
    return commandResult;
  });
  if (result?.disposition === 'mismatch') {
    throw AppError.conflict('Held-message release fingerprint drifted', result.code, { safe: true });
  }
  return result;
}

export const __testing__ = Object.freeze({
  ACTION_ID,
  AUTHORITY_STATES,
  BINDING_ID,
  FAMILY_REASON_CODES,
  SOURCE_FIELDS,
  assertSourceReleaseable,
  commandFingerprint,
  deterministicUuid,
});
