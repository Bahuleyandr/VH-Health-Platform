import { createHash, randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  INCIDENT_PACKET_SIGNING_KEY_PURPOSE,
  INCIDENT_PACKET_SIGNING_PURPOSE,
  loadActiveClinicalContinuityPolicyForFacilityTx,
  requireClinicalContinuityIncidentPacketPolicy,
} from './clinicalContinuityPolicyService.js';
import {
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  hashCanonicalValue,
  verifyCanonicalValue,
} from './continuityPackCanonical.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

function uuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID');
  }
  return normalized;
}

function role(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(normalized)) {
    throw AppError.forbidden(
      'Incident-packet authority was denied',
      'CONTINUITY_INCIDENT_PACKET_ROLE_DENIED',
      { safe: true },
    );
  }
  return normalized;
}

function text(value, label, maximum, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maximum) {
    throw AppError.badRequest(`${label} is invalid`, 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID');
  }
  return normalized;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw AppError.badRequest(`${label} is invalid`, 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID');
  }
  return number;
}

function exactObject(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be an object`, 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID');
  }
  const unexpected = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw AppError.badRequest(`${label} contains unsupported fields`, 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID');
  }
}

function normalizeContactSheetContent(value) {
  exactObject(value, 'contact_sheet content', [
    'schemaVersion',
    'source',
    'custodyLocation',
    'contacts',
    'instructions',
  ]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.contacts)
      || value.contacts.length < 1 || value.contacts.length > 50) {
    throw AppError.badRequest(
      'contact_sheet content is invalid',
      'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
    );
  }
  const escalationOrders = new Set();
  const contacts = value.contacts.map((contact, index) => {
    exactObject(contact, `contact_sheet contacts[${index}]`, [
      'role',
      'label',
      'escalationOrder',
      'channels',
    ]);
    const escalationOrder = positiveInteger(
      contact.escalationOrder,
      `contact_sheet contacts[${index}].escalationOrder`,
    );
    if (escalationOrders.has(escalationOrder) || !Array.isArray(contact.channels)
        || contact.channels.length < 2 || contact.channels.length > 10) {
      throw AppError.badRequest(
        'contact_sheet contacts require unique escalation order and independent channels',
        'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
      );
    }
    escalationOrders.add(escalationOrder);
    const channelKinds = new Set();
    const channels = contact.channels.map((channel, channelIndex) => {
      exactObject(channel, `contact_sheet contacts[${index}].channels[${channelIndex}]`, [
        'kind',
        'value',
      ]);
      const kind = String(channel.kind || '').trim().toLowerCase();
      if (!['phone', 'sms', 'messaging', 'radio'].includes(kind)) {
        throw AppError.badRequest(
          'contact_sheet channel kind is invalid',
          'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
        );
      }
      channelKinds.add(kind);
      return { kind, value: text(channel.value, 'contact_sheet channel value', 160) };
    });
    if (channelKinds.size < 2) {
      throw AppError.badRequest(
        'contact_sheet contacts require two independent channel kinds',
        'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
      );
    }
    const contactRole = String(contact.role || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(contactRole)) {
      throw AppError.badRequest(
        'contact_sheet contact role is invalid',
        'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
      );
    }
    return {
      role: contactRole,
      label: text(contact.label, 'contact_sheet contact label', 120),
      escalationOrder,
      channels: channels.sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`)),
    };
  });
  return {
    schemaVersion: 1,
    source: text(value.source, 'contact_sheet source', 240),
    custodyLocation: text(value.custodyLocation, 'contact_sheet custody location', 240),
    contacts: contacts.sort((a, b) => a.escalationOrder - b.escalationOrder),
    instructions: text(value.instructions, 'contact_sheet instructions', 1000),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeScope({ tenantId, facilityId, actorUid, actorRole }) {
  const facility = Number(facilityId);
  if (!Number.isSafeInteger(facility) || facility < 1) {
    throw AppError.badRequest('facility_id is invalid', 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID');
  }
  return {
    tenantId: requireTenantId(tenantId),
    facilityId: facility,
    actorUid: uuid(actorUid, 'actor_uid'),
    actorRole: role(actorRole),
  };
}

async function facilityTransaction(scope, callback, { readOnly = false } = {}) {
  return setTenantTx(scope.tenantId, async tx => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_facility_id', $1, true)`,
      String(scope.facilityId),
    );
    return callback(tx);
  }, { isolationLevel: 'Serializable', readOnly });
}

function requireConfiguredRole(policyConfig, actorRole, field) {
  if (!policyConfig[field].includes(actorRole)) {
    throw AppError.forbidden(
      'Incident-packet authority was denied',
      'CONTINUITY_INCIDENT_PACKET_ROLE_DENIED',
      { safe: true },
    );
  }
}

async function loadAuthorityTx(tx, scope) {
  const policy = await loadActiveClinicalContinuityPolicyForFacilityTx({
    tx,
    tenantId: scope.tenantId,
    facilityId: scope.facilityId,
  });
  return { policy, config: requireClinicalContinuityIncidentPacketPolicy(policy) };
}

async function requiredAuditTx(tx, scope, {
  action,
  resourceType,
  resourceTable,
  resourceId,
  requestId = null,
  afterState,
}) {
  const audit = await recordClinicalAuditEvent({
    tenantId: scope.tenantId,
    action,
    actorUid: scope.actorUid,
    actorRole: scope.actorRole,
    resourceType,
    resourceTable,
    resourceId,
    requestId,
    afterState,
    idempotencyKey: `cc-packet:${scope.tenantId}:${resourceId}:${action}`,
  }, { db: tx });
  if (!audit) {
    throw AppError.internal(
      'Incident-packet audit evidence was not recorded',
      'CONTINUITY_INCIDENT_PACKET_AUDIT_REQUIRED',
    );
  }
  return audit;
}

async function loadSigningKeyTx(tx, scope, config) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, key_id, algorithm, status, metadata
       FROM encryption_keys
      WHERE tenant_id = $1::uuid AND key_id = $2
      LIMIT 2`,
    scope.tenantId,
    config.signingKeyId,
  );
  const key = rows[0];
  const publicKey = key?.metadata?.public_key_spki_pem;
  if (
    rows.length !== 1
    || key.algorithm !== SIGNATURE_ALGORITHM
    || key.status !== 'active'
    || key.metadata?.purpose !== INCIDENT_PACKET_SIGNING_KEY_PURPOSE
    || typeof publicKey !== 'string'
    || sha256(Buffer.from(publicKey, 'utf8')) !== config.signingPublicKeySha256
  ) {
    throw AppError.conflict(
      'Incident-packet signing key is unavailable',
      'CONTINUITY_INCIDENT_PACKET_SIGNING_KEY_UNAVAILABLE',
      { safe: true },
    );
  }
  return { ...key, publicKey };
}

async function requestSignature({ signer, keyId, payload, publicKey }) {
  if (!signer || typeof signer.sign !== 'function') {
    throw new AppError(
      'Incident-packet signer is unavailable',
      503,
      'CONTINUITY_INCIDENT_PACKET_SIGNER_UNAVAILABLE',
      { safe: true },
    );
  }
  const signature = await signer.sign({
    algorithm: SIGNATURE_ALGORITHM,
    keyId,
    payload: Buffer.from(canonicalizeJson(payload), 'utf8'),
    purpose: INCIDENT_PACKET_SIGNING_PURPOSE,
  });
  if (!SIGNATURE_PATTERN.test(String(signature || ''))
      || !verifyCanonicalValue(payload, signature, publicKey)) {
    throw AppError.conflict(
      'Incident-packet signature failed local verification',
      'CONTINUITY_INCIDENT_PACKET_SIGNATURE_INVALID',
      { safe: true },
    );
  }
  return signature;
}

function packetArtifact(payload, signature, contactContent, canonicalPayloadHash) {
  const signedEnvelope = Buffer.from(canonicalizeJson({ payload, signature }), 'utf8').toString('base64');
  return [
    'VH HEALTH CLINICAL CONTINUITY INCIDENT PACKET',
    'USE ONCE — A RECEIVED CUSTODY RECORD IS REQUIRED BEFORE USE',
    `PACKET ID: ${payload.packetId}`,
    `TENANT ID: ${payload.tenantId}`,
    `FACILITY ID: ${payload.facilityId}`,
    `FACILITY TIMEZONE: ${payload.facilityTimezone}`,
    `PACKET SCHEMA: ${payload.format}`,
    `RESERVED INCIDENT ID: ${payload.reservedIncidentId}`,
    `PAPER RANGE: ${payload.range.prefix}${payload.range.first}-${payload.range.prefix}${payload.range.last}`,
    `NOT VALID BEFORE: ${payload.notValidBefore}`,
    `NOT VALID AFTER: ${payload.notValidAfter}`,
    `POLICY: ${payload.policy.id} / ${payload.policy.version} / ${payload.policy.checksum}`,
    `CONTACT SHEET: ${payload.contactSheet.id} / ${payload.contactSheet.version} / ${payload.contactSheet.checksum}`,
    `CONTACT SHEET WINDOW: ${payload.contactSheet.effectiveFrom} through ${payload.contactSheet.effectiveUntil}`,
    `ALLOWED CONTROLLED COPIES: ${payload.allowedCopyCount}`,
    `SIGNING KEY: ${payload.key.id} / ${payload.key.version} / ${payload.key.publicKeySha256}`,
    `CANONICAL PAYLOAD SHA-256: ${canonicalPayloadHash}`,
    `SIGNATURE: ${signature}`,
    `MACHINE-READABLE SIGNED ENVELOPE (BASE64): ${signedEnvelope}`,
    '',
    'C-D10 PHONE TREE / ROLE CONTACT SHEET:',
    canonicalizeJson(contactContent),
    '',
    'This packet contains no patient data.',
    'If the NOT VALID AFTER time, signed envelope, signature, or paper range is missing or unreadable, do not use this packet and do not invent an identifier.',
  ].join('\n');
}

export async function createIncidentPacketContactSheet(input) {
  const scope = normalizeScope(input);
  const content = normalizeContactSheetContent(input.content);
  return facilityTransaction(scope, async tx => {
    const { config } = await loadAuthorityTx(tx, scope);
    requireConfiguredRole(config, scope.actorRole, 'issuerRoles');
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_create_incident_contact_sheet(
         $1::uuid, $2::integer, $3::uuid, $4, $5::jsonb
       )`,
      scope.tenantId,
      scope.facilityId,
      scope.actorUid,
      scope.actorRole,
      JSON.stringify(content),
    );
    const audit = await requiredAuditTx(tx, scope, {
      action: 'clinical_continuity.incident_packet.contact_sheet_created',
      resourceType: 'clinical_continuity_incident_contact_sheet',
      resourceTable: 'clinical_continuity_incident_contact_sheets',
      resourceId: rows[0].id,
      afterState: { facility_id: scope.facilityId, version: String(rows[0].version) },
    });
    return { contact_sheet: rows[0], audit_event_id: audit.id };
  });
}

export async function approveIncidentPacketContactSheet(input) {
  const scope = normalizeScope(input);
  const contactSheetId = uuid(input.contactSheetId, 'contact_sheet_id');
  return facilityTransaction(scope, async tx => {
    const { config } = await loadAuthorityTx(tx, scope);
    requireConfiguredRole(config, scope.actorRole, 'contactSheetApproverRoles');
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_approve_incident_contact_sheet(
         $1::uuid, $2::integer, $3::uuid, $4, $5::uuid
       )`,
      scope.tenantId,
      scope.facilityId,
      scope.actorUid,
      scope.actorRole,
      contactSheetId,
    );
    const audit = await requiredAuditTx(tx, scope, {
      action: 'clinical_continuity.incident_packet.contact_sheet_approved',
      resourceType: 'clinical_continuity_incident_contact_sheet_approval',
      resourceTable: 'clinical_continuity_incident_contact_sheet_approvals',
      resourceId: rows[0].id,
      afterState: { contact_sheet_id: contactSheetId, facility_id: scope.facilityId },
    });
    return { approval: rows[0], audit_event_id: audit.id };
  });
}

async function voidAllocation(scope, allocationId, reason) {
  await facilityTransaction(scope, tx => tx.$executeRawUnsafe(
    `SELECT clinical_continuity_void_incident_packet_allocation(
       $1::uuid, $2::integer, $3::uuid, $4::uuid, $5, $6
     )`,
    scope.tenantId,
    scope.facilityId,
    allocationId,
    scope.actorUid,
    scope.actorRole,
    reason,
  )).catch((err) => {
    // Best-effort compensation after a failed provision — the caller is
    // already unwinding on the original error, but a stuck ACTIVE allocation
    // must be visible to operators, not silently leaked.
    logger.error('Incident packet allocation void failed', {
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      allocationId,
      reason,
      error: err.message,
    });
  });
}

export async function provisionIncidentPacket(input) {
  const scope = normalizeScope(input);
  const contactSheetId = uuid(input.contactSheetId, 'contact_sheet_id');
  const requestId = uuid(input.requestId, 'request_id');
  const supersedesPacketId = input.supersedesPacketId
    ? uuid(input.supersedesPacketId, 'supersedes_packet_id')
    : null;
  const requestFingerprint = hashCanonicalValue({
    contactSheetId,
    facilityId: scope.facilityId,
    purpose: INCIDENT_PACKET_SIGNING_PURPOSE,
    supersedesPacketId,
    tenantId: scope.tenantId,
  });
  const prepared = await facilityTransaction(scope, async tx => {
    const { policy, config } = await loadAuthorityTx(tx, scope);
    requireConfiguredRole(config, scope.actorRole, 'issuerRoles');
    const key = await loadSigningKeyTx(tx, scope, config);
    if (supersedesPacketId) {
      const replaced = await tx.$queryRawUnsafe(
        `SELECT id::text, status, valid_until::text,
                clock_timestamp() >= valid_until
                  - make_interval(mins => $4::integer) AS refresh_window_open,
                clock_timestamp() + make_interval(secs => $5::integer) < valid_until
                  AS not_expired
           FROM clinical_continuity_incident_packets
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid`,
        scope.tenantId,
        scope.facilityId,
        supersedesPacketId,
        config.refreshLeadMinutes,
        config.clockUncertaintySeconds,
      );
      if (
        replaced.length !== 1
        || replaced[0].status !== 'unused'
        || replaced[0].refresh_window_open !== true
        || replaced[0].not_expired !== true
      ) {
        throw AppError.conflict(
          'Only an unused packet can be refreshed',
          'CONTINUITY_INCIDENT_PACKET_REFRESH_INVALID',
          { safe: true },
        );
      }
    }
    const allocationRows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_allocate_incident_packet(
         $1::uuid, $2::integer, $3::uuid, $4, $5::uuid, $6, $7::uuid, $8::uuid
       )`,
      scope.tenantId,
      scope.facilityId,
      scope.actorUid,
      scope.actorRole,
      requestId,
      requestFingerprint,
      randomUUID(),
      contactSheetId,
    );
    const allocation = allocationRows[0];
    if (allocation.state === 'issued') {
      const issued = await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_incident_packets
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid`,
        scope.tenantId,
        scope.facilityId,
        allocation.issued_packet_id,
      );
      return { exactDuplicate: issued[0] };
    }
    const contactRows = await tx.$queryRawUnsafe(
      `SELECT sheet.id::text, sheet.version::text, sheet.content_hash,
              sheet.content, sheet.effective_from::text, sheet.effective_until::text,
              facility.timezone
         FROM clinical_continuity_incident_contact_sheets sheet
         JOIN clinical_continuity_incident_contact_sheet_approvals approval
           ON approval.tenant_id = sheet.tenant_id
          AND approval.facility_id = sheet.facility_id
          AND approval.contact_sheet_id = sheet.id
         JOIN facilities facility
           ON facility.tenant_id = sheet.tenant_id AND facility.id = sheet.facility_id
        WHERE sheet.tenant_id = $1::uuid AND sheet.facility_id = $2::integer
          AND sheet.id = $3::uuid AND approval.policy_id = $4::uuid`,
      scope.tenantId,
      scope.facilityId,
      contactSheetId,
      policy.id,
    );
    if (contactRows.length !== 1) {
      throw AppError.conflict(
        'An approved current-policy contact sheet is required',
        'CONTINUITY_INCIDENT_PACKET_CONTACT_SHEET_REQUIRED',
        { safe: true },
      );
    }
    await requiredAuditTx(tx, scope, {
      action: 'clinical_continuity.incident_packet.range_allocated',
      resourceType: 'clinical_continuity_incident_packet_allocation',
      resourceTable: 'clinical_continuity_incident_packet_allocations',
      resourceId: allocation.id,
      requestId,
      afterState: {
        contact_sheet_id: contactSheetId,
        facility_id: scope.facilityId,
        range_first: String(allocation.range_first),
        range_last: String(allocation.range_last),
        range_prefix: allocation.range_prefix,
        reserved_incident_id: String(allocation.reserved_incident_id),
      },
    });
    return { allocation, config, contact: contactRows[0], key, policy };
  });
  if (prepared.exactDuplicate) {
    return { disposition: 'exact_duplicate', packet: prepared.exactDuplicate };
  }

  const allocationId = String(prepared.allocation.id).toLowerCase();
  try {
    const packetId = randomUUID();
    const validFrom = new Date(prepared.policy.trustedNow);
    const validUntil = new Date(validFrom.getTime() + prepared.config.validityMinutes * 60_000);
    const payload = {
      allowedCopyCount: prepared.config.allowedCopyCount,
      contactSheet: {
        checksum: prepared.contact.content_hash,
        effectiveFrom: prepared.contact.effective_from,
        effectiveUntil: prepared.contact.effective_until,
        id: prepared.contact.id,
        version: prepared.contact.version,
      },
      facilityId: scope.facilityId,
      facilityTimezone: prepared.contact.timezone,
      format: 'vhhealth_clinical_continuity_incident_packet/v1',
      key: {
        id: prepared.key.key_id,
        publicKeySha256: prepared.config.signingPublicKeySha256,
        version: prepared.key.id,
      },
      notValidAfter: validUntil.toISOString(),
      notValidBefore: validFrom.toISOString(),
      packetId,
      policy: {
        checksum: prepared.policy.policyChecksum,
        id: prepared.policy.id,
        version: prepared.policy.policyVersion,
      },
      purpose: INCIDENT_PACKET_SIGNING_PURPOSE,
      range: {
        first: String(prepared.allocation.range_first),
        last: String(prepared.allocation.range_last),
        prefix: prepared.allocation.range_prefix,
      },
      reservedIncidentId: String(prepared.allocation.reserved_incident_id).toLowerCase(),
      tenantId: scope.tenantId,
    };
    const signature = await requestSignature({
      signer: input.signer,
      keyId: prepared.key.key_id,
      payload,
      publicKey: prepared.key.publicKey,
    });
    const canonicalPayloadJcs = canonicalizeJson(payload);
    const canonicalPayloadHash = sha256(Buffer.from(canonicalPayloadJcs, 'utf8'));
    const artifact = packetArtifact(
      payload,
      signature,
      prepared.contact.content,
      canonicalPayloadHash,
    );
    const packetEvidence = {
      allocation_id: allocationId,
      artifact_base64: Buffer.from(artifact, 'utf8').toString('base64'),
      artifact_sha256: sha256(Buffer.from(artifact, 'utf8')),
      canonical_payload: payload,
      canonical_payload_hash: canonicalPayloadHash,
      canonical_payload_jcs: canonicalPayloadJcs,
      packet_id: packetId,
      request_fingerprint: requestFingerprint,
      signature,
      supersedes_packet_id: supersedesPacketId,
      valid_from: validFrom.toISOString(),
      valid_until: validUntil.toISOString(),
    };
    const issued = await facilityTransaction(scope, async tx => {
      const authorizationAudit = await requiredAuditTx(tx, scope, {
        action: 'clinical_continuity.incident_packet.issue_authorized',
        resourceType: 'clinical_continuity_incident_packet_allocation',
        resourceTable: 'clinical_continuity_incident_packet_allocations',
        resourceId: allocationId,
        requestId,
        afterState: {
          artifact_sha256: packetEvidence.artifact_sha256,
          canonical_payload_hash: packetEvidence.canonical_payload_hash,
          packet_id: packetEvidence.packet_id,
          signature_sha256: sha256(Buffer.from(signature, 'utf8')),
        },
      });
      packetEvidence.authorization_audit_id = authorizationAudit.id;
      const rows = await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_issue_incident_packet(
           $1::uuid, $2::integer, $3::uuid, $4, $5::jsonb
         )`,
        scope.tenantId,
        scope.facilityId,
        scope.actorUid,
        scope.actorRole,
        JSON.stringify(packetEvidence),
      );
      const audit = await requiredAuditTx(tx, scope, {
        action: 'clinical_continuity.incident_packet.issued',
        resourceType: 'clinical_continuity_incident_packet',
        resourceTable: 'clinical_continuity_incident_packets',
        resourceId: rows[0].id,
        requestId,
        afterState: {
          artifact_sha256: packetEvidence.artifact_sha256,
          facility_id: scope.facilityId,
          not_valid_after: packetEvidence.valid_until,
          policy_id: prepared.policy.id,
          policy_version: prepared.policy.policyVersion,
        },
      });
      return { packet: rows[0], auditId: audit.id };
    });
    return { disposition: 'issued', packet: issued.packet, audit_event_id: issued.auditId };
  } catch (error) {
    await voidAllocation(scope, allocationId, 'signing or issuance failed');
    throw error;
  }
}

export async function refreshIncidentPacket(input) {
  return provisionIncidentPacket({ ...input, supersedesPacketId: input.packetId });
}

export async function recordIncidentPacketCustody(input) {
  const scope = normalizeScope(input);
  const packetId = uuid(input.packetId, 'packet_id');
  const eventType = text(input.eventType, 'event_type', 24);
  const copyNumber = positiveInteger(input.copyNumber, 'copy_number');
  const evidenceHash = String(input.evidenceHash || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(evidenceHash)) {
    throw AppError.badRequest(
      'evidence_hash must be a SHA-256 digest',
      'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
    );
  }
  const occurredAt = new Date(String(input.occurredAt || ''));
  if (!Number.isFinite(occurredAt.getTime())) {
    throw AppError.badRequest(
      'occurred_at must be an ISO timestamp',
      'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID',
    );
  }
  return facilityTransaction(scope, async tx => {
    const { config } = await loadAuthorityTx(tx, scope);
    requireConfiguredRole(config, scope.actorRole, 'custodianRoles');
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_record_incident_packet_custody(
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5, $6, $7::integer,
         $8, $9, $10::timestamptz
       )`,
      scope.tenantId,
      scope.facilityId,
      packetId,
      scope.actorUid,
      scope.actorRole,
      eventType,
      copyNumber,
      evidenceHash,
      text(input.notes, 'notes', 500, { nullable: true }),
      occurredAt.toISOString(),
    );
    const audit = await requiredAuditTx(tx, scope, {
      action: 'clinical_continuity.incident_packet.custody_recorded',
      resourceType: 'clinical_continuity_incident_packet_custody_event',
      resourceTable: 'clinical_continuity_incident_packet_custody_events',
      resourceId: rows[0].id,
      afterState: { event_type: eventType, packet_id: packetId, copy_number: copyNumber },
    });
    return { custody_event: rows[0], audit_event_id: audit.id };
  });
}

export async function revokeIncidentPacket(input) {
  const scope = normalizeScope(input);
  const packetId = uuid(input.packetId, 'packet_id');
  const reason = text(input.reason, 'reason', 160);
  return facilityTransaction(scope, async tx => {
    const { config } = await loadAuthorityTx(tx, scope);
    requireConfiguredRole(config, scope.actorRole, 'issuerRoles');
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_revoke_incident_packet(
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5, $6
       )`,
      scope.tenantId,
      scope.facilityId,
      packetId,
      scope.actorUid,
      scope.actorRole,
      reason,
    );
    const audit = await requiredAuditTx(tx, scope, {
      action: 'clinical_continuity.incident_packet.revoked',
      resourceType: 'clinical_continuity_incident_packet',
      resourceTable: 'clinical_continuity_incident_packets',
      resourceId: packetId,
      afterState: { facility_id: scope.facilityId, reason },
    });
    return { packet: rows[0], audit_event_id: audit.id };
  });
}

export async function getIncidentPacketArtifact(input) {
  const scope = normalizeScope(input);
  const packetId = uuid(input.packetId, 'packet_id');
  return facilityTransaction(scope, async tx => {
    const { config } = await loadAuthorityTx(tx, scope);
    const allowed = config.issuerRoles.includes(scope.actorRole)
      || config.custodianRoles.includes(scope.actorRole);
    if (!allowed) requireConfiguredRole(config, scope.actorRole, 'issuerRoles');
    const rows = await tx.$queryRawUnsafe(
      `SELECT packet.id::text AS packet_id, packet.status,
              packet.valid_from::text, packet.valid_until::text,
              artifact.media_type, encode(artifact.artifact_bytes, 'base64') AS artifact_base64,
              artifact.artifact_sha256
         FROM clinical_continuity_incident_packets packet
         JOIN clinical_continuity_incident_packet_artifacts artifact
           ON artifact.tenant_id = packet.tenant_id
          AND artifact.facility_id = packet.facility_id
          AND artifact.packet_id = packet.id
        WHERE packet.tenant_id = $1::uuid AND packet.facility_id = $2::integer
          AND packet.id = $3::uuid`,
      scope.tenantId,
      scope.facilityId,
      packetId,
    );
    if (rows.length !== 1) {
      throw AppError.notFound('Incident packet artifact not found', 'CONTINUITY_INCIDENT_PACKET_NOT_FOUND');
    }
    return { artifact: rows[0] };
  }, { readOnly: true });
}

export async function verifyProvisionedIncidentPacketTx(tx, packetRow) {
  if (Number(packetRow.packet_schema_version || 0) !== 1) return;
  const canonical = canonicalizeJson(packetRow.canonical_payload);
  const trustedRows = await tx.$queryRawUnsafe(
    `SELECT clock_timestamp()::text AS trusted_now,
            key_record.algorithm, key_record.status, key_record.metadata,
            EXISTS (
              SELECT 1 FROM clinical_continuity_incident_packet_custody_events custody
               WHERE custody.tenant_id = packet.tenant_id
                 AND custody.facility_id = packet.facility_id
                 AND custody.packet_id = packet.id
                 AND custody.event_type = 'received'
            ) AS custody_received
       FROM clinical_continuity_incident_packets packet
       JOIN encryption_keys key_record
         ON key_record.tenant_id = packet.tenant_id AND key_record.key_id = packet.packet_key_id
      WHERE packet.tenant_id = $1::uuid AND packet.facility_id = $2::integer
        AND packet.id = $3::uuid`,
    packetRow.tenant_id,
    packetRow.facility_id,
    packetRow.id,
  );
  const evidence = trustedRows[0];
  const trustedNow = Date.parse(evidence?.trusted_now);
  if (
    canonical !== packetRow.canonical_payload_jcs
    || sha256(Buffer.from(canonical, 'utf8')) !== packetRow.canonical_payload_hash
    || !verifyCanonicalValue(packetRow.canonical_payload, packetRow.signature, packetRow.signing_public_key_spki_pem)
    || sha256(Buffer.from(packetRow.signing_public_key_spki_pem, 'utf8')) !== packetRow.signing_public_key_sha256
    || evidence?.algorithm !== SIGNATURE_ALGORITHM
    || !['active', 'retiring'].includes(evidence?.status)
    || evidence?.metadata?.purpose !== INCIDENT_PACKET_SIGNING_KEY_PURPOSE
    || evidence?.custody_received !== true
    || !Number.isFinite(trustedNow)
    || trustedNow + Number(packetRow.clock_uncertainty_seconds) * 1000 < Date.parse(packetRow.valid_from)
    || trustedNow + Number(packetRow.clock_uncertainty_seconds) * 1000 >= Date.parse(packetRow.valid_until)
  ) {
    throw AppError.conflict(
      'Incident packet cryptographic or custody evidence did not verify',
      'CONTINUITY_PACKET_INVALID',
      { safe: true },
    );
  }
}
