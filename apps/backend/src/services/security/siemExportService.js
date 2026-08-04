import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { safeFetch } from '../../utils/ssrfGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const SIEM_REDACTION_POLICY_VERSION = 'nl12-s2-phi-min-v1';
export const SIEM_PAYLOAD_SCHEMA = 'vhhealth.siem.event.v1';
export const SIEM_TRANSPORTS = ['webhook', 'syslog', 'object_drop'];
export const SIEM_SEVERITIES = ['high', 'critical'];
export const SIEM_RETRY_LIMIT = 5;
export const SIEM_ACKNOWLEDGEMENT_CONTRACTS = Object.freeze([
  'unclassified',
  'webhook_http_2xx_ingested',
  'webhook_receipt_header',
  'syslog_udp_transport_only',
  'local_file_transport_only',
]);

const DEFAULT_BATCH = 50;
const MAX_BATCH = 250;
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_EXCERPT_MAX = 2_000;
const ATTEMPT_LEASE_MS = 60_000;
const BACKOFF_SECONDS = [60, 300, 900, 3_600, 14_400];
const SEVERITY_RANK = { high: 2, critical: 3 };

const CRITICAL_SECURITY_EVENTS = new Set([
  'ACCOUNT_LOCKED',
  'ADMIN_IP_BLOCKED',
  'AUDIT_CHAIN_TAMPERED',
  'BREAK_GLASS_ACTIVATED',
  'BRUTE_FORCE_DETECTED',
  'SUSPICIOUS_ACTIVITY',
  'SYNTHETIC_SECURITY_DRILL_CRITICAL',
]);

const HIGH_SECURITY_EVENTS = new Set([
  'INSUFFICIENT_SCOPE',
  'LOGIN_FAILED',
  'PERMISSION_DENIED',
  'SUPER_ADMIN_STEP_UP_REQUIRED',
  'TOKEN_REVOKED',
]);

const SAFE_METADATA_KEYS = new Set([
  'control_code',
  'drill_id',
  'event_family',
  'outcome',
  'provider_key',
  'realm',
  'reason',
  'request_id',
  'source',
  'status_code',
  'synthetic',
  'transport',
]);

const PHI_KEY_PATTERNS = [
  /aadhaar/i,
  /abha/i,
  /address/i,
  /clinical/i,
  /diagnosis/i,
  /dob/i,
  /email/i,
  /name/i,
  /note/i,
  /patient/i,
  /payload/i,
  /phone/i,
  /prescription/i,
];

function clean(value, max = 255) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeTransport(value) {
  const transport = clean(value, 40);
  if (!SIEM_TRANSPORTS.includes(transport)) {
    throw AppError.badRequest(`transport must be one of: ${SIEM_TRANSPORTS.join(', ')}`);
  }
  return transport;
}

function normalizeSeverity(value, fallback = 'high') {
  const severity = clean(value, 20)?.toLowerCase() || fallback;
  if (!SIEM_SEVERITIES.includes(severity)) {
    throw AppError.badRequest(`severity must be one of: ${SIEM_SEVERITIES.join(', ')}`);
  }
  return severity;
}

function normalizeAcknowledgementContract(value, transport) {
  const contract = clean(value, 48) || 'unclassified';
  if (!SIEM_ACKNOWLEDGEMENT_CONTRACTS.includes(contract)) {
    throw AppError.badRequest('acknowledgement_contract is not supported');
  }
  const allowed = contract === 'unclassified'
    || (transport === 'webhook' && ['webhook_http_2xx_ingested', 'webhook_receipt_header'].includes(contract))
    || (transport === 'syslog' && contract === 'syslog_udp_transport_only')
    || (transport === 'object_drop' && contract === 'local_file_transport_only');
  if (!allowed) throw AppError.badRequest('acknowledgement_contract does not match transport');
  return contract;
}

function severityAtLeast(severity, minimum) {
  return (SEVERITY_RANK[severity] || 0) >= (SEVERITY_RANK[minimum] || 0);
}

function toSafeLimit(limit, fallback = DEFAULT_BATCH) {
  return Math.min(Math.max(Number.parseInt(limit, 10) || fallback, 1), MAX_BATCH);
}

function sha256(value) {
  if (value === null || value === undefined || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashPayload(payload) {
  return sha256(JSON.stringify(payload)) || crypto.createHash('sha256').update('{}').digest('hex');
}

function parseJsonish(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isPhiKey(key) {
  return PHI_KEY_PATTERNS.some((re) => re.test(String(key || '')));
}

function safeMetadata(value) {
  const source = parseJsonish(value, {});
  const metadata = {};
  let redactedFieldCount = 0;

  for (const [key, raw] of Object.entries(source)) {
    if (isPhiKey(key) || !SAFE_METADATA_KEYS.has(key)) {
      redactedFieldCount += 1;
      continue;
    }
    if (raw === null || raw === undefined) {
      metadata[key] = null;
    } else if (typeof raw === 'boolean' || typeof raw === 'number') {
      metadata[key] = raw;
    } else if (typeof raw === 'string') {
      metadata[key] = clean(raw, 500);
    } else {
      redactedFieldCount += 1;
    }
  }

  return { metadata, redactedFieldCount };
}

function requestIdFor(event) {
  return clean(event.request_id || event.requestId || event.metadata?.request_id, 100);
}

function mapAuditLogSeverity(row = {}) {
  const action = clean(row.action, 120)?.toUpperCase() || 'SECURITY_EVENT';
  if (CRITICAL_SECURITY_EVENTS.has(action)) return 'critical';
  if (HIGH_SECURITY_EVENTS.has(action)) return 'high';
  if (Number(row.status_code) >= 500) return 'high';
  return 'high';
}

function backoffSecondsForAttempt(attemptNumber) {
  const idx = Math.max(0, Math.min(Number(attemptNumber) - 1, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[idx];
}

function computeNextRetryAt(attemptNumber) {
  return new Date(Date.now() + backoffSecondsForAttempt(attemptNumber) * 1000);
}

function isRetryable(httpStatus) {
  if (httpStatus == null) return true;
  if (httpStatus >= 500 && httpStatus < 600) return true;
  return httpStatus === 408 || httpStatus === 425 || httpStatus === 429;
}

function normalizeSourceName(value) {
  const sourceName = clean(value, 80) || 'synthetic';
  if (!['audit_log', 'identity_audit_events', 'clinical_audit_events', 'synthetic'].includes(sourceName)) {
    throw AppError.badRequest('source_name is not a supported SIEM source');
  }
  return sourceName;
}

export function normalizeSiemEvent(input = {}) {
  const sourceName = normalizeSourceName(input.source_name || input.sourceName);
  const sourceId = clean(input.source_id || input.sourceId || crypto.randomUUID(), 255);
  const eventType = clean(input.event_type || input.eventType || input.action || 'SECURITY_EVENT', 120);
  const severity = normalizeSeverity(input.severity || (sourceName === 'audit_log' ? mapAuditLogSeverity(input) : 'high'));
  const requestId = requestIdFor(input);
  const meta = safeMetadata(input.metadata || input.details || {});
  const actorHash = sha256(input.actor_uid || input.actorUid || input.uid || input.user_id || input.userId);
  const subjectHash = sha256(input.subject_uid || input.subjectUid);
  const ipHash = sha256(input.ip_address || input.ip || input.remote_ip);
  const resourceHash = sha256(input.resource_id || input.resourceId);
  const pathHash = sha256(input.path);
  const userAgentHash = sha256(input.user_agent || input.userAgent);
  const sourceCreatedAt = input.source_created_at || input.sourceCreatedAt || input.created_at || input.createdAt || null;
  const synthetic = Boolean(input.synthetic || sourceName === 'synthetic');

  const payload = {
    schema: SIEM_PAYLOAD_SCHEMA,
    tenant_id: requireTenantId(input.tenant_id || input.tenantId),
    event: {
      type: eventType,
      severity,
      category: clean(input.category, 80) || 'security',
      synthetic,
    },
    source: {
      name: sourceName,
      id: sourceId,
      created_at: sourceCreatedAt ? new Date(sourceCreatedAt).toISOString() : null,
    },
    actor: {
      hash: actorHash,
      role: clean(input.user_role || input.userRole || input.actor_role || input.actorRole, 80),
    },
    subject: {
      hash: subjectHash,
    },
    request: {
      request_id: requestId,
      method: clean(input.method, 20),
      path_hash: pathHash,
      ip_hash: ipHash,
      user_agent_hash: userAgentHash,
      status_code: input.status_code ?? input.statusCode ?? null,
      success: typeof input.success === 'boolean' ? input.success : null,
    },
    resource: {
      type: clean(input.resource || input.resource_type || input.resourceType, 100),
      id_hash: resourceHash,
    },
    metadata: meta.metadata,
    redaction: {
      policy: SIEM_REDACTION_POLICY_VERSION,
      raw_payload_exported: false,
      redacted_field_count: meta.redactedFieldCount,
    },
  };

  const payloadSha = hashPayload(payload);
  return {
    tenant_id: payload.tenant_id,
    source_name: sourceName,
    source_id: sourceId,
    source_created_at: sourceCreatedAt ? new Date(sourceCreatedAt) : null,
    event_type: eventType,
    severity,
    category: payload.event.category,
    actor_hash: actorHash,
    subject_hash: subjectHash,
    ip_hash: ipHash,
    request_id: requestId,
    resource_type: payload.resource.type,
    resource_hash: resourceHash,
    redaction_policy_version: SIEM_REDACTION_POLICY_VERSION,
    minimized_payload: payload,
    payload_sha256: payloadSha,
    synthetic,
  };
}

export function normalizeSecurityAuditRow(row = {}, tenantId = null) {
  const tid = requireTenantId(tenantId || row.tenant_id);
  return normalizeSiemEvent({
    ...row,
    tenant_id: tid,
    source_name: 'audit_log',
    source_id: String(row.id),
    source_created_at: row.created_at,
    severity: mapAuditLogSeverity(row),
    metadata: {
      ...parseJsonish(row.metadata, {}),
      reason: row.request_summary || undefined,
      status_code: row.status_code ?? undefined,
    },
  });
}

export async function upsertSiemExportTarget({
  tenantId = null,
  targetKey,
  displayName,
  transport,
  status = 'draft',
  minSeverity = 'high',
  endpointUrl = null,
  syslogHost = null,
  syslogPort = null,
  objectDropUri = null,
  config = {},
  actorUid = null,
  metadata = {},
  acknowledgementContract = 'unclassified',
  acknowledgementConfig = {},
  acknowledgementOwnerReason = null,
  acknowledgementOwnerEvidence = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const key = clean(targetKey, 80);
  const name = clean(displayName || targetKey, 160);
  if (!key) throw AppError.badRequest('target_key is required');
  if (!name) throw AppError.badRequest('display_name is required');
  const normalizedTransport = normalizeTransport(transport);
  const normalizedStatus = clean(status, 20) || 'draft';
  const normalizedMinSeverity = normalizeSeverity(minSeverity);
  const normalizedAckContract = normalizeAcknowledgementContract(
    acknowledgementContract,
    normalizedTransport,
  );
  if (normalizedAckContract !== 'unclassified'
      && (!actorUid || !clean(acknowledgementOwnerReason, 500)
        || !acknowledgementOwnerEvidence || typeof acknowledgementOwnerEvidence !== 'object'
        || Array.isArray(acknowledgementOwnerEvidence)
        || Object.keys(acknowledgementOwnerEvidence).length === 0)) {
    throw AppError.badRequest('Classified SIEM acknowledgement requires owner identity, reason, and evidence');
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO siem_export_targets (
       tenant_id, target_key, display_name, transport, status, min_severity,
       endpoint_url, syslog_host, syslog_port, object_drop_uri,
       redaction_policy_version, config, created_by, updated_by, metadata,
       acknowledgement_contract, acknowledgement_config,
       acknowledgement_classified_by, acknowledgement_owner_reason,
       acknowledgement_owner_evidence, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::int, $10,
       $11, $12::jsonb, $13::uuid, $13::uuid, $14::jsonb,
       $15, $16::jsonb, $17::uuid, $18, $19::jsonb, NOW(), NOW()
     )
     ON CONFLICT (tenant_id, target_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       transport = EXCLUDED.transport,
       status = EXCLUDED.status,
       min_severity = EXCLUDED.min_severity,
       endpoint_url = EXCLUDED.endpoint_url,
       syslog_host = EXCLUDED.syslog_host,
       syslog_port = EXCLUDED.syslog_port,
       object_drop_uri = EXCLUDED.object_drop_uri,
       redaction_policy_version = EXCLUDED.redaction_policy_version,
       config = EXCLUDED.config,
       updated_by = EXCLUDED.updated_by,
       metadata = siem_export_targets.metadata || EXCLUDED.metadata,
       acknowledgement_contract = EXCLUDED.acknowledgement_contract,
       acknowledgement_config = EXCLUDED.acknowledgement_config,
       acknowledgement_classified_by = EXCLUDED.acknowledgement_classified_by,
       acknowledgement_owner_reason = EXCLUDED.acknowledgement_owner_reason,
       acknowledgement_owner_evidence = EXCLUDED.acknowledgement_owner_evidence,
       updated_at = NOW()
     RETURNING id, uid, tenant_id, target_key, display_name, transport, status,
               min_severity, endpoint_url, syslog_host, syslog_port,
               object_drop_uri, redaction_policy_version, config, metadata,
               last_drill_at, acknowledgement_contract, acknowledgement_config,
               acknowledgement_classified_by, acknowledgement_owner_reason,
               acknowledgement_owner_evidence, created_at, updated_at`,
    tid,
    key,
    name,
    normalizedTransport,
    normalizedStatus,
    normalizedMinSeverity,
    clean(endpointUrl, 2_000),
    clean(syslogHost, 255),
    syslogPort == null ? null : Number(syslogPort),
    clean(objectDropUri, 2_000),
    SIEM_REDACTION_POLICY_VERSION,
    JSON.stringify(config || {}),
    actorUid || null,
    JSON.stringify(metadata || {}),
    normalizedAckContract,
    JSON.stringify(acknowledgementConfig || {}),
    normalizedAckContract === 'unclassified' ? null : actorUid,
    normalizedAckContract === 'unclassified' ? null : clean(acknowledgementOwnerReason, 500),
    normalizedAckContract === 'unclassified' ? null : JSON.stringify(acknowledgementOwnerEvidence),
  );
  return rows[0];
}

export async function findSiemExportTarget({ tenantId = null, targetKey } = {}) {
  const tid = requireTenantId(tenantId);
  const key = clean(targetKey, 80);
  if (!key) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, target_key, display_name, transport, status,
            min_severity, endpoint_url, syslog_host, syslog_port,
            object_drop_uri, redaction_policy_version, config, metadata,
            last_drill_at, acknowledgement_contract, acknowledgement_config,
            acknowledgement_classified_by, acknowledgement_owner_reason,
            acknowledgement_owner_evidence, created_at, updated_at
       FROM siem_export_targets
      WHERE tenant_id = $1::uuid
        AND target_key = $2
      LIMIT 1`,
    tid,
    key,
  );
  return rows[0] || null;
}

async function insertSiemEvent(normalized, runner = prisma) {
  const rows = await runner.$queryRawUnsafe(
    `INSERT INTO siem_export_events (
       tenant_id, source_name, source_id, source_created_at, event_type,
       severity, category, actor_hash, subject_hash, ip_hash, request_id,
       resource_type, resource_hash, redaction_policy_version,
       minimized_payload, payload_sha256, synthetic, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15::jsonb, $16, $17, NOW(), NOW()
     )
     ON CONFLICT (tenant_id, source_name, source_id) DO NOTHING
     RETURNING id, uid, tenant_id, source_name, source_id, source_created_at,
               event_type, severity, category, payload_sha256, minimized_payload,
               export_status, synthetic, created_at, updated_at`,
    normalized.tenant_id,
    normalized.source_name,
    normalized.source_id,
    normalized.source_created_at,
    normalized.event_type,
    normalized.severity,
    normalized.category,
    normalized.actor_hash,
    normalized.subject_hash,
    normalized.ip_hash,
    normalized.request_id,
    normalized.resource_type,
    normalized.resource_hash,
    normalized.redaction_policy_version,
    JSON.stringify(normalized.minimized_payload),
    normalized.payload_sha256,
    normalized.synthetic,
  );
  if (rows[0]) return rows[0];
  const existing = await runner.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, source_name, source_id, source_created_at,
            event_type, severity, category, payload_sha256, minimized_payload,
            export_status, synthetic, created_at, updated_at
       FROM siem_export_events
      WHERE tenant_id = $1::uuid AND source_name = $2 AND source_id = $3
      LIMIT 1`,
    normalized.tenant_id,
    normalized.source_name,
    normalized.source_id,
  );
  if (existing[0]?.payload_sha256 !== normalized.payload_sha256) {
    throw AppError.conflict(
      'SIEM source identity was reused with different minimized payload evidence',
      'I25_CAPTURE_PAYLOAD_CONFLICT',
    );
  }
  return existing[0];
}

export async function createSiemExportEvent(input = {}) {
  return insertSiemEvent(normalizeSiemEvent(input));
}

export async function capturePendingSecurityAuditEvents({
  tenantId = null,
  batchSize = DEFAULT_BATCH,
} = {}) {
  const tid = requireTenantId(tenantId);
  const limit = toSafeLimit(batchSize);
  return setTenantTx(tid, async (tx) => {
    const cursorRows = await tx.$queryRawUnsafe(
      `SELECT id, last_source_id, writer_state, canonical_capture_offset_id::text,
              capture_schedule_decision
         FROM siem_export_cursors
        WHERE tenant_id = $1::uuid
          AND source_name = 'audit_log'
          AND cursor_key = 'security'
        LIMIT 1
        FOR UPDATE`,
      tid,
    );
    const legacyCursor = cursorRows[0] || null;
    let canonicalOffset = null;
    let lastSourceId = Number(legacyCursor?.last_source_id || 0);
    if (legacyCursor?.writer_state === 'canonical_offsets') {
      const offsets = await tx.$queryRawUnsafe(
        `SELECT offset_id::text, high_water_position::text, generation, recovery_state
           FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid
            AND offset_id = $2::uuid
            AND scope_kind = 'external_interface'
            AND interface_family = 'I25'
          FOR UPDATE`,
        tid,
        legacyCursor.canonical_capture_offset_id,
      );
      canonicalOffset = offsets[0];
      if (!canonicalOffset || !['ready', 'replaying'].includes(canonicalOffset.recovery_state)) {
        throw AppError.conflict(
          'I25 canonical capture offset is paused pending separate scheduler activation',
          'I25_CAPTURE_CANONICAL_OFFSET_PAUSED',
        );
      }
      lastSourceId = Number(canonicalOffset.high_water_position || 0);
    }

    const sourceRows = await tx.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, action, resource, resource_id, metadata,
              ip_address, created_at, user_id, user_name, user_role, method,
              path, module, status_code, success, user_agent, actor_uid,
              subject_uid, request_summary
         FROM audit_log
        WHERE tenant_id = $1::uuid
          AND module = 'security'
          AND id > $2::bigint
        ORDER BY id ASC
        LIMIT $3`,
      tid,
      lastSourceId,
      limit,
    );

    const captured = [];
    let maxId = lastSourceId;
    let maxCreatedAt = null;
    for (const row of sourceRows) {
      maxId = Math.max(maxId, Number(row.id));
      maxCreatedAt = row.created_at || maxCreatedAt;
      const normalized = normalizeSecurityAuditRow(row, tid);
      captured.push(await insertSiemEvent(normalized, tx));
    }

    if (sourceRows.length > 0 && canonicalOffset) {
      const advanced = await tx.$queryRawUnsafe(
        `UPDATE event_consumer_offsets
            SET high_water_position = $3::bigint,
                high_water_token = $4::text,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
            AND high_water_position = $5::bigint
            AND recovery_state IN ('ready', 'replaying')
          RETURNING offset_id::text`,
        tid,
        canonicalOffset.offset_id,
        maxId,
        `audit_log:${maxId}:captured`,
        lastSourceId,
      );
      if (advanced.length !== 1) {
        throw AppError.conflict('I25 canonical capture fence was lost', 'I25_CAPTURE_FENCE_LOST');
      }
    } else if (sourceRows.length > 0) {
      await tx.$queryRawUnsafe(
        `INSERT INTO siem_export_cursors (
           tenant_id, source_name, cursor_key, last_source_id,
           last_source_ref, last_source_at, last_captured_at, metadata,
           created_at, updated_at
         )
         VALUES (
           $1::uuid, 'audit_log', 'security', $2::bigint, $3,
           $4, NOW(), $5::jsonb, NOW(), NOW()
         )
         ON CONFLICT (tenant_id, source_name, cursor_key) DO UPDATE SET
           last_source_id = EXCLUDED.last_source_id,
           last_source_ref = EXCLUDED.last_source_ref,
           last_source_at = EXCLUDED.last_source_at,
           last_captured_at = NOW(),
           metadata = siem_export_cursors.metadata || EXCLUDED.metadata,
           updated_at = NOW()
         WHERE siem_export_cursors.writer_state = 'legacy_capture'`,
        tid,
        maxId,
        String(maxId),
        maxCreatedAt,
        JSON.stringify({
          captured_count: captured.length,
          cursor_semantics: 'capture_into_event_ledger',
          capture_schedule_decision: legacyCursor?.capture_schedule_decision
            || 'owner_activation_required',
        }),
      );
    }

    return { captured_count: captured.length, last_source_id: maxId, events: captured };
  }, { isolationLevel: 'Serializable' });
}

export async function createSyntheticSecurityEvent({
  tenantId = null,
  severity = 'critical',
  eventType = 'SYNTHETIC_SECURITY_DRILL_CRITICAL',
  actorUid = null,
  requestId = null,
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const drillId = crypto.randomUUID();
  return createSiemExportEvent({
    tenant_id: tid,
    source_name: 'synthetic',
    source_id: `synthetic:${drillId}`,
    source_created_at: new Date(),
    event_type: eventType,
    severity,
    category: 'security',
    actor_uid: actorUid,
    ip_address: metadata.ip_address || '203.0.113.10',
    user_agent: metadata.user_agent || 'vhhealth-siem-drill',
    method: 'POST',
    path: '/internal/synthetic/siem-drill',
    request_id: requestId || drillId,
    synthetic: true,
    metadata: {
      ...metadata,
      control_code: 'SIEM_ALERTS_ONCALL',
      drill_id: drillId,
      event_family: 'synthetic_security_drill',
      reason: 'synthetic high/critical SIEM export drill',
      synthetic: true,
    },
  });
}

async function activeTargets({ tenantId, targetKey = null } = {}) {
  const tid = requireTenantId(tenantId);
  const key = clean(targetKey, 80);
  const rows = key
    ? await prisma.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, target_key, display_name, transport, status,
              min_severity, endpoint_url, syslog_host, syslog_port,
              object_drop_uri, redaction_policy_version, config, metadata,
              last_drill_at, acknowledgement_contract, acknowledgement_config,
              acknowledgement_classified_by, acknowledgement_owner_reason,
              acknowledgement_owner_evidence, created_at, updated_at
         FROM siem_export_targets
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND target_key = $2
        ORDER BY updated_at DESC`,
      tid,
      key,
    )
    : await prisma.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, target_key, display_name, transport, status,
              min_severity, endpoint_url, syslog_host, syslog_port,
              object_drop_uri, redaction_policy_version, config, metadata,
              last_drill_at, acknowledgement_contract, acknowledgement_config,
              acknowledgement_classified_by, acknowledgement_owner_reason,
              acknowledgement_owner_evidence, created_at, updated_at
         FROM siem_export_targets
        WHERE tenant_id = $1::uuid
          AND status = 'active'
        ORDER BY updated_at DESC`,
      tid,
    );
  return rows;
}

export async function enqueueSiemDeliveries({
  tenantId = null,
  targetKey = null,
  batchSize = DEFAULT_BATCH,
} = {}) {
  const tid = requireTenantId(tenantId);
  const targets = await activeTargets({ tenantId: tid, targetKey });
  if (targets.length === 0) {
    return { targets: 0, enqueued: 0, skipped_reason: 'no_active_siem_export_target' };
  }

  const limit = toSafeLimit(batchSize);
  let enqueued = 0;
  for (const target of targets) {
    const events = await prisma.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, event_type, severity, minimized_payload,
              payload_sha256, created_at
         FROM siem_export_events e
        WHERE e.tenant_id = $1::uuid
          AND NOT EXISTS (
            SELECT 1
              FROM siem_export_delivery_attempts d
             WHERE d.event_id = e.id
               AND d.target_id = $2::bigint
          )
        ORDER BY e.created_at ASC
        LIMIT $3`,
      tid,
      String(target.id),
      limit,
    );

    for (const event of events.filter((row) => severityAtLeast(row.severity, target.min_severity))) {
      const payload = parseJsonish(event.minimized_payload, {});
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO siem_export_delivery_attempts (
           tenant_id, event_id, target_id, transport, attempt_number, status,
           payload_snapshot, payload_sha256, request_id, next_retry_at, metadata,
           created_at, updated_at
         )
         VALUES (
           $1::uuid, $2::bigint, $3::bigint, $4, 1, 'pending',
           $5::jsonb, $6, $7, NOW(), $8::jsonb, NOW(), NOW()
         )
         ON CONFLICT (event_id, target_id, attempt_number) DO NOTHING
         RETURNING id`,
        tid,
        String(event.id),
        String(target.id),
        target.transport,
        JSON.stringify(payload),
        event.payload_sha256,
        payload.request?.request_id || crypto.randomUUID(),
        JSON.stringify({ target_key: target.target_key }),
      );
      if (rows.length > 0) {
        enqueued += 1;
      }
    }
  }

  return { targets: targets.length, enqueued };
}

async function fetchTargetForAttempt(attempt) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, target_key, display_name, transport, status,
            min_severity, endpoint_url, syslog_host, syslog_port,
            object_drop_uri, redaction_policy_version, config, metadata,
            last_drill_at, acknowledgement_contract, acknowledgement_config,
            acknowledgement_classified_by, acknowledgement_owner_reason,
            acknowledgement_owner_evidence, created_at, updated_at
       FROM siem_export_targets
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    String(attempt.target_id),
    attempt.tenant_id,
  );
  return rows[0] || null;
}

function signatureFor(payload, target) {
  const config = parseJsonish(target.config, {});
  const envName = clean(config.shared_secret_env, 120);
  const secret = envName ? process.env[envName] : null;
  if (!secret) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

async function deliverWebhook({ attempt, target, fetchImpl = null }) {
  const payload = parseJsonish(attempt.payload_snapshot, {});
  const signature = signatureFor(payload, target);
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': attempt.request_id || crypto.randomUUID(),
    'X-VHHealth-SIEM-Attempt-Id': String(attempt.id),
    'X-VHHealth-SIEM-Redaction-Policy': SIEM_REDACTION_POLICY_VERSION,
  };
  if (signature) headers['X-VHHealth-SIEM-Signature'] = signature;

  const response = fetchImpl
    ? await fetchImpl(target.endpoint_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    : await safeFetch(target.endpoint_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, {
      label: 'siem_endpoint_url',
      allowlistEnv: 'SIEM_EXPORT_WEBHOOK_HOST_ALLOWLIST',
      allowPrivateEnv: 'SIEM_EXPORT_WEBHOOK_ALLOW_PRIVATE_TARGETS',
    });

  let responseExcerpt = null;
  try {
    const text = await response.text();
    responseExcerpt = text ? text.slice(0, RESPONSE_EXCERPT_MAX) : null;
  } catch {
    responseExcerpt = null;
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    httpStatus: response.status,
    responseExcerpt,
    evidenceUri: target.endpoint_url,
    responseHeaders: response.headers || null,
  };
}

function objectDropDirectory(rawUri) {
  const uri = clean(rawUri, 2_000);
  if (!uri) throw AppError.badRequest('object_drop_uri is required for SIEM object-drop targets');
  if (uri.startsWith('file://')) return fileURLToPath(uri);
  return path.resolve(uri);
}

async function deliverObjectDrop({ attempt, target, mkdirImpl = fs.mkdir, writeFileImpl = fs.writeFile }) {
  const payload = parseJsonish(attempt.payload_snapshot, {});
  const dir = objectDropDirectory(target.object_drop_uri);
  await mkdirImpl(dir, { recursive: true });
  const eventId = clean(payload.source?.id, 120)?.replace(/[^a-zA-Z0-9_.-]/g, '_') || String(attempt.event_id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${stamp}-attempt-${attempt.id}-${eventId}.json`);
  await writeFileImpl(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    httpStatus: null,
    responseExcerpt: 'object_drop_written',
    evidenceUri: filePath,
  };
}

function formatSyslogMessage(payload) {
  const timestamp = new Date().toISOString();
  const eventId = clean(payload.source?.id, 80) || '-';
  return `<134>1 ${timestamp} vhhealth siem-export - ${eventId} ${JSON.stringify(payload)}`;
}

async function sendSyslogUdp({ host, port, message }) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.send(Buffer.from(message), Number(port) || 514, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } finally {
    socket.close();
  }
}

async function deliverSyslog({ attempt, target, syslogImpl = sendSyslogUdp }) {
  const payload = parseJsonish(attempt.payload_snapshot, {});
  const host = clean(target.syslog_host, 255);
  if (!host) throw AppError.badRequest('syslog_host is required for SIEM syslog targets');
  const port = Number(target.syslog_port || 514);
  await syslogImpl({ host, port, message: formatSyslogMessage(payload), payload, attempt, target });
  return {
    ok: true,
    httpStatus: null,
    responseExcerpt: 'syslog_sent',
    evidenceUri: `syslog://${host}:${port}`,
  };
}

async function deliverAttempt(attempt, target, injections = {}) {
  let outcome;
  if (target.transport === 'webhook') {
    outcome = await deliverWebhook({ attempt, target, fetchImpl: injections.fetchImpl || null });
  } else if (target.transport === 'object_drop') {
    outcome = await deliverObjectDrop({
      attempt,
      target,
      mkdirImpl: injections.mkdirImpl || fs.mkdir,
      writeFileImpl: injections.writeFileImpl || fs.writeFile,
    });
  } else if (target.transport === 'syslog') {
    outcome = await deliverSyslog({
      attempt,
      target,
      syslogImpl: injections.syslogImpl || sendSyslogUdp,
    });
  } else {
    throw AppError.badRequest(`Unsupported SIEM transport: ${target.transport}`);
  }
  return Object.freeze({ ...outcome, ...evaluateAcknowledgement(outcome, target) });
}

function evaluateAcknowledgement(outcome, target) {
  if (!outcome.ok) {
    return {
      acknowledgementState: 'negative',
      acknowledgementEvidence: {
        contract: target.acknowledgement_contract || 'unclassified',
        transport_succeeded: false,
        http_status: outcome.httpStatus ?? null,
      },
    };
  }
  const contract = target.acknowledgement_contract || 'unclassified';
  if (contract === 'webhook_http_2xx_ingested') {
    return {
      acknowledgementState: 'positive',
      acknowledgementEvidence: {
        contract,
        transport_succeeded: true,
        http_status: outcome.httpStatus,
        owner_classified_http_2xx_as_ingested: true,
      },
    };
  }
  if (contract === 'webhook_receipt_header') {
    const config = parseJsonish(target.acknowledgement_config, {});
    const headerName = clean(config.header_name, 120)?.toLowerCase();
    const expectedValue = clean(config.expected_value, 500);
    const actualValue = headerName && outcome.responseHeaders?.get
      ? outcome.responseHeaders.get(headerName)
      : null;
    const positive = Boolean(headerName && expectedValue && actualValue === expectedValue);
    return {
      acknowledgementState: positive ? 'positive' : 'uncertain',
      acknowledgementEvidence: {
        contract,
        transport_succeeded: true,
        http_status: outcome.httpStatus,
        receipt_header: headerName || null,
        receipt_value_sha256: actualValue ? sha256(actualValue) : null,
        expected_receipt_observed: positive,
      },
    };
  }
  return {
    acknowledgementState: contract === 'unclassified' ? 'uncertain' : 'transport_only',
    acknowledgementEvidence: {
      contract,
      transport_succeeded: true,
      positive_delivery_acknowledgement_proven: false,
      udp_send_is_not_delivery: target.transport === 'syslog',
      local_write_is_not_object_store_drop: target.transport === 'object_drop',
    },
  };
}

async function markAttemptComplete(attempt, outcome) {
  const retryable = !outcome.ok && isRetryable(outcome.httpStatus) && Number(attempt.attempt_number) < SIEM_RETRY_LIMIT;
  const status = outcome.ok ? 'succeeded' : retryable ? 'failed' : 'dead';
  return setTenantTx(attempt.tenant_id, async (tx) => {
    const acknowledgementState = outcome.acknowledgementState
      || (outcome.ok ? 'uncertain' : 'negative');
    const completed = await tx.$queryRawUnsafe(
      `UPDATE siem_export_delivery_attempts
          SET status = $1,
              http_status = $2::int,
              response_excerpt = $3,
              error_message = $4,
              evidence_uri = $5,
              acknowledgement_state = $6,
              acknowledgement_evidence = $7::jsonb,
              acknowledged_at = CASE WHEN $6 = 'positive' THEN NOW() ELSE NULL END,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE id = $8::bigint
          AND tenant_id = $9::uuid
          AND status = 'in_flight'
          AND lease_token = $10::uuid
          AND lease_generation = $11::bigint
          AND lease_expires_at > NOW()
        RETURNING id`,
      status,
      outcome.httpStatus == null ? null : Number(outcome.httpStatus),
      clean(outcome.responseExcerpt, RESPONSE_EXCERPT_MAX),
      clean(outcome.errorMessage, 1_000),
      clean(outcome.evidenceUri, 2_000),
      acknowledgementState,
      JSON.stringify(outcome.acknowledgementEvidence || {
        positive_delivery_acknowledgement_proven: false,
      }),
      String(attempt.id),
      attempt.tenant_id,
      attempt.lease_token,
      Number(attempt.lease_generation),
    );
    if (completed.length !== 1) {
      throw AppError.conflict('I25 SIEM attempt completion fence was lost', 'I25_ATTEMPT_FENCE_LOST');
    }

    if (retryable) {
      const nextAttempt = Number(attempt.attempt_number) + 1;
      const nextRetryAt = computeNextRetryAt(nextAttempt);
      await tx.$queryRawUnsafe(
        `INSERT INTO siem_export_delivery_attempts (
           tenant_id, event_id, target_id, transport, attempt_number, status,
           payload_snapshot, payload_sha256, request_id, next_retry_at, metadata,
           created_at, updated_at
         )
         VALUES (
           $1::uuid, $2::bigint, $3::bigint, $4, $5::int, 'pending',
           $6::jsonb, $7, $8, $9, $10::jsonb, NOW(), NOW()
         )
         ON CONFLICT (event_id, target_id, attempt_number) DO NOTHING`,
        attempt.tenant_id,
        String(attempt.event_id),
        String(attempt.target_id),
        attempt.transport,
        nextAttempt,
        JSON.stringify(parseJsonish(attempt.payload_snapshot, {})),
        attempt.payload_sha256,
        crypto.randomUUID(),
        nextRetryAt,
        JSON.stringify({ retry_from_attempt_id: String(attempt.id) }),
      );
    }

    return { status, retryable, acknowledgement_state: acknowledgementState };
  }, { isolationLevel: 'Serializable' });
}

export async function recoverExpiredSiemAttemptLeases({
  tenantId = null,
  limit = MAX_BATCH,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = toSafeLimit(limit, MAX_BATCH);
  return setTenantTx(tid, async (tx) => {
    const expired = await tx.$queryRawUnsafe(
      `WITH candidates AS (
         SELECT id
           FROM siem_export_delivery_attempts
          WHERE tenant_id = $1::uuid
            AND status = 'in_flight'
            AND lease_expires_at <= NOW()
          ORDER BY lease_expires_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE siem_export_delivery_attempts AS attempts
          SET status = CASE WHEN attempt_number < $3::integer THEN 'failed' ELSE 'dead' END,
              error_message = 'siem_attempt_lease_expired',
              acknowledgement_state = 'uncertain',
              acknowledgement_evidence = '{"reason":"lease_expired_before_fenced_completion"}'::jsonb,
              completed_at = NOW(),
              updated_at = NOW()
         FROM candidates
        WHERE attempts.id = candidates.id
        RETURNING attempts.*`,
      tid,
      safeLimit,
      SIEM_RETRY_LIMIT,
    );
    let retried = 0;
    for (const attempt of expired) {
      if (Number(attempt.attempt_number) >= SIEM_RETRY_LIMIT) continue;
      const nextAttempt = Number(attempt.attempt_number) + 1;
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO siem_export_delivery_attempts
           (tenant_id, event_id, target_id, transport, attempt_number, status,
            payload_snapshot, payload_sha256, request_id, next_retry_at, metadata)
         VALUES
           ($1::uuid, $2::bigint, $3::bigint, $4, $5::integer, 'pending',
            $6::jsonb, $7, $8, NOW(), $9::jsonb)
         ON CONFLICT (event_id, target_id, attempt_number) DO NOTHING
         RETURNING id`,
        tid,
        String(attempt.event_id),
        String(attempt.target_id),
        attempt.transport,
        nextAttempt,
        JSON.stringify(parseJsonish(attempt.payload_snapshot, {})),
        attempt.payload_sha256,
        crypto.randomUUID(),
        JSON.stringify({ retry_from_expired_lease_attempt_id: String(attempt.id) }),
      );
      retried += rows.length;
    }
    return Object.freeze({ expired: expired.length, retried });
  }, { isolationLevel: 'Serializable' });
}

async function markAttemptInFlight({ tenantId, targetKey, batchSize }) {
  const tid = requireTenantId(tenantId);
  const limit = toSafeLimit(batchSize);
  const key = clean(targetKey, 80);
  const leaseOwner = `siem-dispatch:${process.pid}:${crypto.randomUUID()}`;
  return key
    ? prisma.$queryRawUnsafe(
      `UPDATE siem_export_delivery_attempts
          SET status = 'in_flight',
              started_at = NOW(),
              lease_owner = $4,
              lease_token = gen_random_uuid(),
              lease_generation = lease_generation + 1,
              lease_expires_at = NOW() + ($5::integer * INTERVAL '1 millisecond'),
              updated_at = NOW()
        WHERE id IN (
          SELECT d.id
            FROM siem_export_delivery_attempts d
            JOIN siem_export_targets t ON t.id = d.target_id
           WHERE d.tenant_id = $1::uuid
             AND d.status = 'pending'
             AND d.next_retry_at <= NOW()
             AND t.target_key = $2
           ORDER BY d.next_retry_at ASC, d.id ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, event_id, target_id, transport, attempt_number,
                  payload_snapshot, payload_sha256, request_id,
                  lease_token::text, lease_generation, lease_expires_at`,
      tid,
      key,
      limit,
      leaseOwner,
      ATTEMPT_LEASE_MS,
    )
    : prisma.$queryRawUnsafe(
      `UPDATE siem_export_delivery_attempts
          SET status = 'in_flight',
              started_at = NOW(),
              lease_owner = $3,
              lease_token = gen_random_uuid(),
              lease_generation = lease_generation + 1,
              lease_expires_at = NOW() + ($4::integer * INTERVAL '1 millisecond'),
              updated_at = NOW()
        WHERE id IN (
          SELECT id
            FROM siem_export_delivery_attempts
           WHERE tenant_id = $1::uuid
             AND status = 'pending'
             AND next_retry_at <= NOW()
           ORDER BY next_retry_at ASC, id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, event_id, target_id, transport, attempt_number,
                  payload_snapshot, payload_sha256, request_id,
                  lease_token::text, lease_generation, lease_expires_at`,
      tid,
      limit,
      leaseOwner,
      ATTEMPT_LEASE_MS,
    );
}

export async function dispatchSiemDeliveries({
  tenantId = null,
  targetKey = null,
  batchSize = DEFAULT_BATCH,
  fetchImpl = null,
  mkdirImpl = null,
  writeFileImpl = null,
  syslogImpl = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await recoverExpiredSiemAttemptLeases({ tenantId: tid, limit: batchSize });
  const attempts = await markAttemptInFlight({ tenantId: tid, targetKey, batchSize });
  let succeeded = 0;
  let failed = 0;
  let dead = 0;

  for (const attempt of attempts) {
    const target = await fetchTargetForAttempt(attempt);
    if (!target || target.status !== 'active') {
      const result = await markAttemptComplete(attempt, {
        ok: false,
        httpStatus: null,
        errorMessage: 'siem_target_missing_or_inactive',
        responseExcerpt: null,
        evidenceUri: null,
      });
      if (result.status === 'dead') dead += 1;
      else failed += 1;
      continue;
    }

    try {
      const outcome = await deliverAttempt(attempt, target, {
        fetchImpl,
        mkdirImpl,
        writeFileImpl,
        syslogImpl,
      });
      const result = await markAttemptComplete(attempt, outcome);
      if (result.status === 'succeeded') succeeded += 1;
      else if (result.status === 'dead') dead += 1;
      else failed += 1;
    } catch (err) {
      logger.warn('SIEM delivery attempt failed', {
        attempt_id: String(attempt.id),
        target_id: String(attempt.target_id),
        error: err.message,
      });
      const result = await markAttemptComplete(attempt, {
        ok: false,
        httpStatus: null,
        errorMessage: err.message,
        responseExcerpt: null,
        evidenceUri: null,
      });
      if (result.status === 'dead') dead += 1;
      else failed += 1;
    }
  }

  return { dispatched: attempts.length, succeeded, failed, dead };
}

export async function listSiemDeliveryEvidence({
  tenantId = null,
  targetKey = null,
  limit = 25,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = toSafeLimit(limit, 25);
  const key = clean(targetKey, 80);
  const rows = key
    ? await prisma.$queryRawUnsafe(
      `SELECT d.id, d.event_id, d.target_id, t.target_key, t.transport,
              e.event_type, e.severity, e.synthetic,
              d.attempt_number, d.status, d.http_status, d.evidence_uri,
              d.error_message, d.acknowledgement_state,
              d.acknowledgement_evidence, d.acknowledged_at,
              d.lease_generation, d.lease_expires_at,
              d.created_at, d.completed_at
         FROM siem_export_delivery_attempts d
         JOIN siem_export_targets t ON t.id = d.target_id
         JOIN siem_export_events e ON e.id = d.event_id
        WHERE d.tenant_id = $1::uuid
          AND t.target_key = $2
        ORDER BY d.created_at DESC
        LIMIT $3`,
      tid,
      key,
      safeLimit,
    )
    : await prisma.$queryRawUnsafe(
      `SELECT d.id, d.event_id, d.target_id, t.target_key, t.transport,
              e.event_type, e.severity, e.synthetic,
              d.attempt_number, d.status, d.http_status, d.evidence_uri,
              d.error_message, d.acknowledgement_state,
              d.acknowledgement_evidence, d.acknowledged_at,
              d.lease_generation, d.lease_expires_at,
              d.created_at, d.completed_at
         FROM siem_export_delivery_attempts d
         JOIN siem_export_targets t ON t.id = d.target_id
         JOIN siem_export_events e ON e.id = d.event_id
        WHERE d.tenant_id = $1::uuid
        ORDER BY d.created_at DESC
        LIMIT $2`,
      tid,
      safeLimit,
    );
  return { evidence: rows, count: rows.length };
}

async function markComplianceEvidenceInProgress({ tenantId, evidenceUri, dispatch }) {
  await prisma.$queryRawUnsafe(
    `UPDATE india_compliance_evidence
        SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
            evidence_uri = COALESCE(NULLIF(evidence_uri, ''), $2),
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND control_code = 'SIEM_ALERTS_ONCALL'`,
    tenantId,
    clean(evidenceUri, 2_000),
    JSON.stringify({
      last_synthetic_drill_at: new Date().toISOString(),
      last_synthetic_drill_status: dispatch.succeeded > 0 ? 'delivered' : 'not_delivered',
      last_synthetic_drill_counts: dispatch,
      acceptance_note: 'Operator still must verify on-call acknowledgement before accepting this control.',
    }),
  );
}

function defaultObjectDropDir() {
  return path.join(os.tmpdir(), 'vhhealth-siem-export-drill');
}

export async function runSyntheticSiemDrill({
  tenantId = null,
  targetKey = 'synthetic-object-drop',
  transport = 'object_drop',
  objectDropDir = null,
  endpointUrl = null,
  syslogHost = null,
  syslogPort = null,
  severity = 'critical',
  fetchImpl = null,
  mkdirImpl = null,
  writeFileImpl = null,
  syslogImpl = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const normalizedTransport = normalizeTransport(transport);
  const target = await upsertSiemExportTarget({
    tenantId: tid,
    targetKey,
    displayName: 'Synthetic SIEM drill target',
    transport: normalizedTransport,
    status: 'active',
    minSeverity: 'high',
    endpointUrl,
    syslogHost,
    syslogPort,
    objectDropUri: normalizedTransport === 'object_drop' ? (objectDropDir || defaultObjectDropDir()) : null,
    metadata: { synthetic_drill_target: true },
  });

  const event = await createSyntheticSecurityEvent({
    tenantId: tid,
    severity,
    metadata: {
      transport: normalizedTransport,
      patient_name: 'REDACTED_TEST_NAME_SHOULD_NOT_EXPORT',
      clinical_payload: 'REDACTED_TEST_PAYLOAD_SHOULD_NOT_EXPORT',
    },
  });
  const enqueue = await enqueueSiemDeliveries({ tenantId: tid, targetKey: target.target_key, batchSize: 5 });
  const dispatch = await dispatchSiemDeliveries({
    tenantId: tid,
    targetKey: target.target_key,
    batchSize: 5,
    fetchImpl,
    mkdirImpl,
    writeFileImpl,
    syslogImpl,
  });
  const evidence = await listSiemDeliveryEvidence({ tenantId: tid, targetKey: target.target_key, limit: 5 });
  const evidenceUri = evidence.evidence.find((row) => row.status === 'succeeded')?.evidence_uri || null;
  await markComplianceEvidenceInProgress({ tenantId: tid, evidenceUri, dispatch });
  await prisma.$queryRawUnsafe(
    `UPDATE siem_export_targets
        SET last_drill_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid`,
    String(target.id),
    tid,
  );

  return {
    tenant_id: tid,
    target_key: target.target_key,
    transport: normalizedTransport,
    event,
    enqueue,
    dispatch,
    evidence,
  };
}

export const __testing__ = {
  BACKOFF_SECONDS,
  CRITICAL_SECURITY_EVENTS,
  HIGH_SECURITY_EVENTS,
  backoffSecondsForAttempt,
  computeNextRetryAt,
  defaultObjectDropDir,
  formatSyslogMessage,
  hashPayload,
  isRetryable,
  evaluateAcknowledgement,
  safeMetadata,
  severityAtLeast,
};

export default {
  capturePendingSecurityAuditEvents,
  createSiemExportEvent,
  createSyntheticSecurityEvent,
  dispatchSiemDeliveries,
  enqueueSiemDeliveries,
  findSiemExportTarget,
  listSiemDeliveryEvidence,
  normalizeSiemEvent,
  normalizeSecurityAuditRow,
  recoverExpiredSiemAttemptLeases,
  runSyntheticSiemDrill,
  upsertSiemExportTarget,
};
