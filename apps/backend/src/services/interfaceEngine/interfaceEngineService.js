import crypto from 'node:crypto';

import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { getInteropSecret, resolveTenantBySender } from '../interop/tenantInteropSecretService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { verifySignedRequest, assertSharedReplayOnce } from '../../utils/signedRequest.js';
import { assertSafeFeedUrl, safeFetch } from '../../utils/ssrfGuard.js';
import { IMPLEMENTED_I05_PROTOCOLS, requireI05ProtocolAdapter } from './protocolAdapters/index.js';
import { runTransformDsl, transformMatchesExpected, validateTransformDsl } from './transformDsl.js';
import {
  assertConnectorCanActivate,
  classifyHl7Acknowledgement,
  classifyHttpFailure,
  isSourceIpAllowed,
  normalizeAllowedSourceRanges,
  normalizeRetryPolicy,
  retryAtFor,
  stableOutboundIdempotencyKey,
} from './runtimePolicy.js';
import {
  observeInterfaceOutboundInFlight,
  recordInterfaceOutboundAttempt,
  recordInterfaceOutboundClaims,
  recordInterfaceReplayMessages,
  recordInterfaceSourceRejection,
} from '../../observability/interfaceEngineMetrics.js';

export const SYSTEM_KINDS = ['his', 'lis', 'ris', 'pacs', 'billing', 'hie', 'migration_source', 'vh_backend', 'other'];
export const DIRECTIONS = ['inbound', 'outbound', 'bidirectional'];
export const CONNECTOR_KINDS = ['http_inbound', 'mllp_listener', 'http_outbound', 'file_sftp_poll', 'manual_upload', 'internal_backend'];
export const PROTOCOLS = ['hl7v2', 'csv', 'json', 'fhir_json', 'other'];
export const CHANNEL_STATUSES = ['draft', 'active', 'paused', 'archived'];
export const VERSION_STATUSES = ['draft', 'candidate', 'active', 'retired'];
export const MESSAGE_STATUSES = [
  'received', 'parsed', 'validated', 'transformed', 'queued', 'delivering',
  'delivered', 'failed', 'dead', 'quarantined', 'replay_requested',
  'replayed', 'ignored_duplicate',
];
export const REPLAY_MODES = ['retry_delivery', 'reprocess_original_version', 'reprocess_current_version', 'redeliver_external'];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_SAFE_ERROR = 600;
const MAX_PREVIEW = 500;
const REQUEST_TIMEOUT_MS = 10000;
const OUTBOUND_LEASE_SECONDS = 120;
const OUTBOUND_MAX_IN_FLIGHT = 100;
const MAX_EXTERNAL_RESPONSE_BODY_BYTES = 64 * 1024;
const PREVIEW_BACKEND_ADAPTER = 'backend.interop.preview';

async function readBoundedResponseBody(response) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_EXTERNAL_RESPONSE_BODY_BYTES) {
    try { await response.body?.cancel?.(); } catch { /* best effort */ }
    throw AppError.conflict('Interface response body exceeds the acknowledgement limit', 'INTEROP_RESPONSE_TOO_LARGE');
  }
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_EXTERNAL_RESPONSE_BODY_BYTES) {
      throw AppError.conflict('Interface response body exceeds the acknowledgement limit', 'INTEROP_RESPONSE_TOO_LARGE');
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_EXTERNAL_RESPONSE_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw AppError.conflict('Interface response body exceeds the acknowledgement limit', 'INTEROP_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  const code = err?.meta?.code || err?.meta?.driverAdapterError?.cause?.originalCode || err?.code;
  return code === '23505' || /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max = null) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeEnum(value, allowed, label) {
  const text = safeText(value);
  if (!text || !allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeOptionalEnum(value, allowed, label) {
  const text = safeText(value);
  if (!text) return null;
  return normalizeEnum(text, allowed, label);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeTextArray(value, label) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const cleaned = [...new Set(list.map((item) => safeText(item, 80)).filter(Boolean))];
  if (cleaned.length !== list.filter((item) => safeText(item)).length) {
    throw AppError.badRequest(`${label} entries must be non-empty strings`);
  }
  return cleaned;
}

function endpointUrlFor(connectorConfig) {
  return safeText(connectorConfig?.endpointUrl || connectorConfig?.endpoint_url);
}

async function assertVersionRuntimeReady(channel, version) {
  assertConnectorCanActivate({
    connectorKind: channel.connector_kind,
    protocol: channel.protocol,
  });
  if (channel.connector_kind === 'http_outbound') {
    if (!['outbound', 'bidirectional'].includes(channel.direction)) {
      throw AppError.badRequest(
        'http_outbound channels require an outbound or bidirectional direction',
        'INTEROP_OUTBOUND_DIRECTION_REQUIRED',
      );
    }
    const endpointUrl = endpointUrlFor(version.connector_config);
    if (!endpointUrl) {
      throw AppError.badRequest(
        'http_outbound channel versions require connector_config.endpointUrl',
        'INTEROP_OUTBOUND_URL_REQUIRED',
      );
    }
    await assertSafeFeedUrl(endpointUrl);
  }
  if (channel.connector_kind === 'http_inbound') {
    if (!['inbound', 'bidirectional'].includes(channel.direction)) {
      throw AppError.badRequest(
        'http_inbound channels require an inbound or bidirectional direction',
        'INTEROP_INBOUND_DIRECTION_REQUIRED',
      );
    }
    if (!channel.source_system_id || channel.source_system_status !== 'active') {
      throw AppError.badRequest(
        'http_inbound channels require an active source system',
        'INTEROP_SOURCE_SYSTEM_REQUIRED',
      );
    }
    const ranges = normalizeAllowedSourceRanges(channel.source_allowed_source_ips || []);
    if (ranges.length === 0) {
      throw AppError.badRequest(
        'http_inbound source systems require a non-empty allowed_source_ips policy',
        'INTEROP_SOURCE_IP_ALLOWLIST_REQUIRED',
      );
    }
  }
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(String(payload || '')).digest('hex');
}

function safeError(err) {
  const code = err?.code || 'INTEROP_ERROR';
  const message = safeText(err?.message || 'Interface engine operation failed', MAX_SAFE_ERROR);
  return { code, message };
}

function tryParseHl7(payload) {
  try {
    const parsed = parseHL7(String(payload || ''));
    return { parsed, error: null };
  } catch (err) {
    return { parsed: null, error: err };
  }
}

function summarizePayload({ protocol, payload, parsed = null }) {
  if (protocol === 'hl7v2') {
    const hl7 = parsed || tryParseHl7(payload).parsed;
    return {
      message_type: hl7?.msh?.messageType || null,
      control_id: hl7?.msh?.messageControlId || null,
      sending_app: hl7?.msh?.sendingApp || null,
      sending_facility: hl7?.msh?.sendingFacility || null,
      receiving_facility: hl7?.msh?.receivingFacility || null,
      segment_count: hl7?.segments?.length || 0,
    };
  }
  if (protocol === 'json') {
    return { kind: 'json', bytes: Buffer.byteLength(String(payload || ''), 'utf8') };
  }
  return { kind: protocol, bytes: Buffer.byteLength(String(payload || ''), 'utf8') };
}

function redactedPreview(summary) {
  const pairs = Object.entries(summary || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`);
  return pairs.join(' | ').slice(0, MAX_PREVIEW);
}

function dedupeFor({ protocol, channelId, parsed, payload }) {
  if (protocol === 'hl7v2' && parsed?.msh?.messageControlId) {
    return `${channelId}:hl7:${parsed.msh.messageType || 'UNKNOWN'}:${parsed.msh.messageControlId}`;
  }
  return `${channelId}:hash:${payloadHash(payload)}`;
}

async function runTenantWrite(tenantId, fn) {
  return setTenant(tenantId, fn);
}

async function createAttempt(db, {
  tenantId,
  messageId,
  channelVersionId,
  phase,
  status,
  attemptNumber = 1,
  requestId = null,
  backendIdempotencyKey = null,
  responseStatus = null,
  safeErrorText = null,
  metrics = {},
}) {
  const rows = await db.$queryRawUnsafe(
    `INSERT INTO interop_message_attempts
       (tenant_id, message_id, channel_version_id, attempt_number, phase, status,
        finished_at, duration_ms, request_id, backend_idempotency_key,
        response_status, safe_error, metrics)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW(), 0, $7, $8, $9, $10, $11::jsonb)
     RETURNING id, tenant_id, message_id, channel_version_id, attempt_number,
               phase, status, started_at, finished_at, duration_ms, request_id,
               backend_idempotency_key, response_status, safe_error, metrics, created_at`,
    tenantId,
    messageId,
    channelVersionId,
    attemptNumber,
    phase,
    status,
    requestId,
    backendIdempotencyKey,
    responseStatus,
    safeErrorText,
    JSON.stringify(metrics || {}),
  );
  return rows[0];
}

async function loadChannel({ tenantId, id = null, channelKey = null, activeOnly = false }) {
  const filters = ['c.tenant_id = $1::uuid'];
  const params = [tenantId];
  if (id != null) {
    params.push(normalizeId(id, 'channel id'));
    filters.push(`c.id = $${params.length}`);
  }
  if (channelKey != null) {
    params.push(safeText(channelKey, 100));
    filters.push(`c.channel_key = $${params.length}`);
  }
  if (activeOnly) {
    filters.push(`c.status = 'active'`);
    filters.push(`v.status = 'active'`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.tenant_id::text AS tenant_id, c.channel_key, c.display_name,
            c.source_system_id, c.target_system_id, c.direction, c.connector_kind,
            c.protocol, c.message_types, c.status, c.active_version_id,
            c.auth_kind, c.auth_sender_identifier, c.retention_days, c.max_attempts,
            c.retry_policy, c.dead_letter_policy, c.metadata, c.created_by,
            c.created_at, c.updated_at,
            v.id AS version_id, v.version_number, v.connector_config,
            v.validation_profile, v.transform_dsl, v.routing_policy, v.redaction_profile,
            source.status AS source_system_status,
            source.allowed_source_ips AS source_allowed_source_ips
       FROM interop_channels c
       LEFT JOIN interop_channel_versions v ON v.id = c.active_version_id
       LEFT JOIN interop_systems source
         ON source.tenant_id = c.tenant_id AND source.id = c.source_system_id
      WHERE ${filters.join(' AND ')}
      LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

async function loadVersion({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, channel_id, version_number, status,
            connector_config, validation_profile, transform_dsl, routing_policy,
            redaction_profile, activated_by, activated_at, retired_at,
            created_by, created_at, updated_at
       FROM interop_channel_versions
      WHERE tenant_id = $1::uuid AND id = $2
      LIMIT 1`,
    tenantId,
    normalizeId(id, 'channel version id'),
  );
  if (!rows[0]) throw AppError.notFound('Channel version not found');
  return rows[0];
}

export async function createSystem({
  tenantId = null,
  systemKey,
  displayName,
  kind,
  direction,
  status = 'draft',
  allowedSourceIps = [],
  metadata = {},
  createdBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanKey = safeText(systemKey, 80);
  const cleanName = safeText(displayName, 160);
  if (!cleanKey) throw AppError.badRequest('system_key is required');
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanKind = normalizeEnum(kind, SYSTEM_KINDS, 'kind');
  const cleanDirection = normalizeEnum(direction, DIRECTIONS, 'direction');
  const cleanStatus = normalizeEnum(status, ['draft', 'active', 'paused', 'revoked'], 'status');
  const ips = normalizeAllowedSourceRanges(allowedSourceIps);
  return runTenantWrite(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO interop_systems
         (tenant_id, system_key, display_name, kind, direction, status,
          allowed_source_ips, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9::uuid)
       RETURNING id, tenant_id, system_key, display_name, kind, direction, status,
                 allowed_source_ips, metadata, created_by, created_at, updated_at`,
      tid,
      cleanKey,
      cleanName,
      cleanKind,
      cleanDirection,
      cleanStatus,
      ips,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      createdBy,
    );
    return rows[0];
  });
}

export async function listSystems({ tenantId = null, status = null, kind = null, limit = DEFAULT_LIST_LIMIT } = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  const cleanStatus = normalizeOptionalEnum(status, ['draft', 'active', 'paused', 'revoked'], 'status');
  if (cleanStatus) {
    params.push(cleanStatus);
    filters.push(`status = $${params.length}`);
  }
  const cleanKind = normalizeOptionalEnum(kind, SYSTEM_KINDS, 'kind');
  if (cleanKind) {
    params.push(cleanKind);
    filters.push(`kind = $${params.length}`);
  }
  params.push(normalizeLimit(limit));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, system_key, display_name, kind, direction, status,
              allowed_source_ips, metadata, created_by, created_at, updated_at
         FROM interop_systems
        WHERE ${filters.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT $${params.length}::int`,
      ...params,
    );
    return { systems: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { systems: [], count: 0 };
    throw err;
  }
}

export async function createChannel({
  tenantId = null,
  channelKey,
  displayName,
  sourceSystemId = null,
  targetSystemId = null,
  direction,
  connectorKind,
  protocol,
  messageTypes = [],
  authKind = 'tenant_interop_secret',
  authSenderIdentifier = null,
  retentionDays = 30,
  maxAttempts = 7,
  retryPolicy = {},
  deadLetterPolicy = {},
  metadata = {},
  createdBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanKey = safeText(channelKey, 100);
  const cleanName = safeText(displayName, 180);
  if (!cleanKey) throw AppError.badRequest('channel_key is required');
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanDirection = normalizeEnum(direction, DIRECTIONS, 'direction');
  const cleanConnector = normalizeEnum(connectorKind, CONNECTOR_KINDS, 'connector_kind');
  const cleanProtocol = normalizeEnum(protocol, PROTOCOLS, 'protocol');
  const cleanAuthKind = normalizeEnum(authKind, ['tenant_interop_secret', 'internal', 'none'], 'auth_kind');
  const cleanSender = safeText(authSenderIdentifier, 255);
  if (cleanAuthKind === 'tenant_interop_secret' && ['http_inbound', 'mllp_listener'].includes(cleanConnector) && !cleanSender) {
    throw AppError.badRequest('auth_sender_identifier is required for signed inbound channels');
  }
  return runTenantWrite(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO interop_channels
         (tenant_id, channel_key, display_name, source_system_id, target_system_id,
          direction, connector_kind, protocol, message_types, auth_kind,
          auth_sender_identifier, retention_days, max_attempts, retry_policy,
          dead_letter_policy, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11,
               $12::int, $13::int, $14::jsonb, $15::jsonb, $16::jsonb, $17::uuid)
       RETURNING id, tenant_id, channel_key, display_name, source_system_id,
                 target_system_id, direction, connector_kind, protocol, message_types,
                 status, active_version_id, auth_kind, auth_sender_identifier,
                 retention_days, max_attempts, retry_policy, dead_letter_policy,
                 metadata, created_by, created_at, updated_at`,
      tid,
      cleanKey,
      cleanName,
      sourceSystemId ? normalizeId(sourceSystemId, 'source_system_id') : null,
      targetSystemId ? normalizeId(targetSystemId, 'target_system_id') : null,
      cleanDirection,
      cleanConnector,
      cleanProtocol,
      normalizeTextArray(messageTypes, 'message_types'),
      cleanAuthKind,
      cleanSender,
      Math.min(Math.max(Number.parseInt(retentionDays, 10) || 30, 1), 3650),
      Math.min(Math.max(Number.parseInt(maxAttempts, 10) || 7, 1), 25),
      JSON.stringify(normalizeRetryPolicy(retryPolicy)),
      JSON.stringify(normalizeJsonObject(deadLetterPolicy, 'dead_letter_policy')),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      createdBy,
    );
    return rows[0];
  });
}

export async function listChannels({ tenantId = null, status = null, connectorKind = null, limit = DEFAULT_LIST_LIMIT } = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  const cleanStatus = normalizeOptionalEnum(status, CHANNEL_STATUSES, 'status');
  if (cleanStatus) {
    params.push(cleanStatus);
    filters.push(`status = $${params.length}`);
  }
  const cleanConnector = normalizeOptionalEnum(connectorKind, CONNECTOR_KINDS, 'connector_kind');
  if (cleanConnector) {
    params.push(cleanConnector);
    filters.push(`connector_kind = $${params.length}`);
  }
  params.push(normalizeLimit(limit));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, channel_key, display_name, source_system_id, target_system_id,
              direction, connector_kind, protocol, message_types, status, active_version_id,
              auth_kind, auth_sender_identifier, retention_days, max_attempts,
              retry_policy, dead_letter_policy, metadata, created_by, created_at, updated_at
         FROM interop_channels
        WHERE ${filters.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT $${params.length}::int`,
      ...params,
    );
    return { channels: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { channels: [], count: 0 };
    throw err;
  }
}

export async function createChannelVersion({
  tenantId = null,
  channelId,
  connectorConfig = {},
  validationProfile = {},
  transformDsl = {},
  routingPolicy = {},
  redactionProfile = {},
  status = 'candidate',
  createdBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const channel = await loadChannel({ tenantId: tid, id: channelId });
  if (!channel) throw AppError.notFound('Channel not found');
  validateTransformDsl(normalizeJsonObject(transformDsl, 'transform_dsl'));
  const cleanConnectorConfig = normalizeJsonObject(connectorConfig, 'connector_config');
  const cleanStatus = normalizeEnum(status, VERSION_STATUSES.filter((s) => s !== 'active'), 'status');
  return runTenantWrite(tid, async (tx) => {
    const nextRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
         FROM interop_channel_versions
        WHERE tenant_id = $1::uuid AND channel_id = $2`,
      tid,
      channel.id,
    );
    const nextVersion = Number(nextRows[0]?.next_version || 1);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO interop_channel_versions
         (tenant_id, channel_id, version_number, status, connector_config,
          validation_profile, transform_dsl, routing_policy, redaction_profile,
          created_by)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
               $8::jsonb, $9::jsonb, $10::uuid)
       RETURNING id, tenant_id, channel_id, version_number, status,
                 connector_config, validation_profile, transform_dsl,
                 routing_policy, redaction_profile, activated_by, activated_at,
                 retired_at, created_by, created_at, updated_at`,
      tid,
      channel.id,
      nextVersion,
      cleanStatus,
      JSON.stringify(cleanConnectorConfig),
      JSON.stringify(normalizeJsonObject(validationProfile, 'validation_profile')),
      JSON.stringify(normalizeJsonObject(transformDsl, 'transform_dsl')),
      JSON.stringify(normalizeJsonObject(routingPolicy, 'routing_policy')),
      JSON.stringify(normalizeJsonObject(redactionProfile, 'redaction_profile')),
      createdBy,
    );
    return rows[0];
  });
}

export async function createTransformTest({
  tenantId = null,
  channelVersionId,
  name,
  messageType = null,
  inputPayload,
  inputPayloadIsSynthetic = true,
  expectedOutput = {},
  expectedFindings = [],
  createdBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const version = await loadVersion({ tenantId: tid, id: channelVersionId });
  const cleanName = safeText(name, 160);
  if (!cleanName) throw AppError.badRequest('name is required');
  if (!inputPayload) throw AppError.badRequest('input_payload is required');
  return runTenantWrite(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO interop_transform_tests
         (tenant_id, channel_version_id, name, message_type, input_payload_ciphertext,
          input_payload_is_synthetic, expected_output, expected_findings, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid)
       RETURNING id, tenant_id, channel_version_id, name, message_type,
                 input_payload_is_synthetic, expected_output, expected_findings,
                 last_run_status, last_run_at, last_run_summary, created_by,
                 created_at, updated_at`,
      tid,
      version.id,
      cleanName,
      safeText(messageType, 80),
      encryptField(String(inputPayload), { tenantId: tid }),
      inputPayloadIsSynthetic !== false,
      JSON.stringify(normalizeJsonObject(expectedOutput, 'expected_output')),
      JSON.stringify(Array.isArray(expectedFindings) ? expectedFindings : []),
      createdBy,
    );
    return rows[0];
  });
}

export async function runTransformTest({ tenantId = null, testId } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT t.id, t.tenant_id::text AS tenant_id, t.channel_version_id, t.name,
            t.message_type, t.input_payload_ciphertext, t.expected_output,
            t.expected_findings, v.transform_dsl, c.protocol
       FROM interop_transform_tests t
       JOIN interop_channel_versions v ON v.id = t.channel_version_id
       JOIN interop_channels c ON c.id = v.channel_id
      WHERE t.tenant_id = $1::uuid AND t.id = $2
      LIMIT 1`,
    tid,
    normalizeId(testId, 'transform test id'),
  );
  const test = rows[0];
  if (!test) throw AppError.notFound('Transform test not found');
  let summary;
  let status = 'passed';
  try {
    const result = runTransformDsl({
      protocol: test.protocol,
      payload: decryptField(test.input_payload_ciphertext),
      dsl: test.transform_dsl || {},
    });
    const outputMatches = transformMatchesExpected(result.output, test.expected_output || {});
    const expectedFindings = Array.isArray(test.expected_findings) ? test.expected_findings : [];
    const findingSeverities = result.findings.map((finding) => finding.severity);
    const findingsMatch = expectedFindings.length === 0
      || expectedFindings.every((finding) => findingSeverities.includes(finding.severity));
    status = outputMatches && findingsMatch && !result.findings.some((finding) => finding.severity === 'error')
      ? 'passed'
      : 'failed';
    summary = {
      output: result.output,
      findings: result.findings,
      emit: result.emit,
      output_matches: outputMatches,
      findings_match: findingsMatch,
    };
  } catch (err) {
    status = 'error';
    const safe = safeError(err);
    summary = { error_code: safe.code, error: safe.message };
  }
  return runTenantWrite(tid, async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE interop_transform_tests
          SET last_run_status = $3,
              last_run_at = NOW(),
              last_run_summary = $4::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING id, tenant_id, channel_version_id, name, message_type,
                  input_payload_is_synthetic, expected_output, expected_findings,
                  last_run_status, last_run_at, last_run_summary, created_by,
                  created_at, updated_at`,
      tid,
      test.id,
      status,
      JSON.stringify(summary),
    );
    return updated[0];
  });
}

export async function activateChannelVersion({ tenantId = null, channelVersionId, actorUid = null } = {}) {
  const tid = requireTenantId(tenantId);
  const version = await loadVersion({ tenantId: tid, id: channelVersionId });
  const channel = await loadChannel({ tenantId: tid, id: version.channel_id });
  if (!channel) throw AppError.notFound('Channel not found');
  const tests = await prisma.$queryRawUnsafe(
    `SELECT message_type, last_run_status
       FROM interop_transform_tests
      WHERE tenant_id = $1::uuid AND channel_version_id = $2`,
    tid,
    version.id,
  );
  const requiredTypes = Array.isArray(channel.message_types) && channel.message_types.length > 0
    ? channel.message_types
    : ['*'];
  const passedTypes = new Set(tests.filter((test) => test.last_run_status === 'passed').map((test) => test.message_type || '*'));
  const missingTypes = requiredTypes.filter((type) => !passedTypes.has(type) && !passedTypes.has('*'));
  if (tests.length === 0 || missingTypes.length > 0) {
    throw AppError.badRequest('Activation requires passing transform tests for every accepted message type', 'INTEROP_TRANSFORM_TESTS_REQUIRED', {
      missing_message_types: missingTypes,
    });
  }
  await assertVersionRuntimeReady(channel, version);
  return runTenantWrite(tid, async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE interop_channel_versions
          SET status = 'retired', retired_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND channel_id = $2 AND status = 'active'`,
      tid,
      version.channel_id,
    );
    const versionRows = await tx.$queryRawUnsafe(
      `UPDATE interop_channel_versions
          SET status = 'active', activated_by = $3::uuid, activated_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING id, tenant_id, channel_id, version_number, status,
                  connector_config, validation_profile, transform_dsl,
                  routing_policy, redaction_profile, activated_by, activated_at,
                  retired_at, created_by, created_at, updated_at`,
      tid,
      version.id,
      actorUid,
    );
    await tx.$executeRawUnsafe(
      `UPDATE interop_channels
          SET status = 'active', active_version_id = $2, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $3`,
      tid,
      version.id,
      version.channel_id,
    );
    return versionRows[0];
  });
}

export async function listTransformTests({ tenantId = null, channelVersionId, limit = DEFAULT_LIST_LIMIT } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, channel_version_id, name, message_type,
            input_payload_is_synthetic, expected_output, expected_findings,
            last_run_status, last_run_at, last_run_summary, created_by,
            created_at, updated_at
       FROM interop_transform_tests
      WHERE tenant_id = $1::uuid
        AND channel_version_id = $2
      ORDER BY created_at DESC
      LIMIT $3::int`,
    tid,
    normalizeId(channelVersionId, 'channel version id'),
    normalizeLimit(limit),
  );
  return { tests: rows, count: rows.length };
}

export async function ingestMessage({
  tenantId = null,
  channel,
  payload,
  parsed = null,
  requestId = null,
  sourceTable = null,
  sourceId = null,
  direction = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const activeChannel = channel || await loadChannel({ tenantId: tid, id: channel?.id, activeOnly: true });
  if (!activeChannel || !activeChannel.version_id) throw AppError.notFound('Active channel not found');
  const cleanPayload = String(payload || '');
  if (!cleanPayload) throw AppError.badRequest('payload is required');
  const protocol = activeChannel.protocol;
  const hl7 = protocol === 'hl7v2' ? (parsed || tryParseHl7(cleanPayload).parsed) : null;
  const summary = summarizePayload({ protocol, payload: cleanPayload, parsed: hl7 });
  const messageType = summary.message_type || null;
  if (activeChannel.message_types?.length && messageType && !activeChannel.message_types.includes(messageType)) {
    throw AppError.badRequest(`Message type ${messageType} is not accepted by this channel`, 'INTEROP_MESSAGE_TYPE_NOT_ALLOWED');
  }
  const dedupeKey = dedupeFor({ protocol, channelId: activeChannel.id, parsed: hl7, payload: cleanPayload });
  const hash = payloadHash(cleanPayload);
  const initialStatus = direction === 'outbound' ? 'queued' : 'received';
  const cleanDirection = direction || activeChannel.direction;
  return runTenantWrite(tid, async (tx) => {
    let message;
    try {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO interop_messages
           (tenant_id, channel_id, channel_version_id, direction, protocol,
            message_type, external_control_id, dedupe_key, payload_hash,
            raw_payload_ciphertext, redacted_preview, parsed_summary,
             source_table, source_id, status, retention_until, arrival_class,
             effect_disposition, send_authority, owner_reconciliation_required)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                  $12::jsonb, $13, $14, $15,
                  NOW() + ($16::int * INTERVAL '1 day'), 'live', 'live',
                  'live_authorized', false)
         RETURNING id, tenant_id, channel_id, channel_version_id, direction,
                   protocol, message_type, external_control_id, dedupe_key,
                   payload_hash, raw_payload_retained, redacted_preview,
                   parsed_summary, patient_uid, source_table, source_id,
                   status, last_error_code, last_error_safe, retention_until,
                   created_at, updated_at`,
        tid,
        activeChannel.id,
        activeChannel.version_id,
        cleanDirection,
        protocol,
        messageType,
        summary.control_id || null,
        dedupeKey,
        hash,
        encryptField(cleanPayload, { tenantId: tid }),
        redactedPreview(summary),
        JSON.stringify(summary),
        safeText(sourceTable, 80),
        safeText(sourceId, 80),
        initialStatus,
        activeChannel.retention_days || 30,
      );
      message = rows[0];
      await createAttempt(tx, {
        tenantId: tid,
        messageId: message.id,
        channelVersionId: activeChannel.version_id,
        phase: 'receive',
        status: 'ok',
        requestId,
        metrics: { payload_hash: hash, bytes: Buffer.byteLength(cleanPayload, 'utf8') },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, channel_id, channel_version_id, direction,
                     protocol, message_type, external_control_id, dedupe_key,
                     payload_hash, raw_payload_retained, redacted_preview,
                     parsed_summary, patient_uid, source_table, source_id,
                     status, last_error_code, last_error_safe, retention_until,
                     created_at, updated_at
           FROM interop_messages
          WHERE tenant_id = $1::uuid AND channel_id = $2 AND dedupe_key = $3`,
        tid,
        activeChannel.id,
        dedupeKey,
      );
      message = existing[0];
      await createAttempt(tx, {
        tenantId: tid,
        messageId: message.id,
        channelVersionId: activeChannel.version_id,
        phase: 'receive',
        status: 'skipped',
        requestId,
        metrics: { reason: 'duplicate', dedupe_key: dedupeKey },
      });
      return message;
    }

    if (cleanDirection === 'outbound') return message;

    try {
      await createAttempt(tx, {
        tenantId: tid,
        messageId: message.id,
        channelVersionId: activeChannel.version_id,
        phase: 'parse',
        status: 'ok',
        requestId,
        metrics: summary,
      });
      const transformResult = runTransformDsl({
        protocol,
        payload: cleanPayload,
        dsl: activeChannel.transform_dsl || {},
      });
      const hasErrorFinding = transformResult.findings.some((finding) => finding.severity === 'error');
      await createAttempt(tx, {
        tenantId: tid,
        messageId: message.id,
        channelVersionId: activeChannel.version_id,
        phase: 'transform',
        status: hasErrorFinding ? 'failed' : 'ok',
        requestId,
        metrics: {
          output_keys: Object.keys(transformResult.output || {}),
          findings: transformResult.findings,
          emit: transformResult.emit,
        },
      });
      const adapter = transformResult.emit?.adapter || activeChannel.routing_policy?.adapter || null;
      const backendIdempotencyKey = `${activeChannel.channel_key}:${message.external_control_id || message.id}:backend`;
      let nextStatus = hasErrorFinding ? 'failed' : 'transformed';
      if (adapter && !hasErrorFinding) {
        const protocolAdapter = requireI05ProtocolAdapter(protocol);
        const receipt = await protocolAdapter.deliverBackendTx({
          tx,
          tenantId: tid,
          message,
          adapterKey: adapter,
          rawPayload: cleanPayload,
          transformedPayload: transformResult.output || {},
        });
        await createAttempt(tx, {
          tenantId: tid,
          messageId: message.id,
          channelVersionId: activeChannel.version_id,
          phase: 'deliver_backend',
          status: 'ok',
          requestId,
          backendIdempotencyKey,
          metrics: {
            adapter,
            adapter_version: protocolAdapter.adapterVersion,
            receipt_id: receipt.id,
            payload_hash: message.payload_hash,
            byte_parity_verified: true,
            output_keys: Object.keys(transformResult.output || {}),
            delivery_effect: adapter === PREVIEW_BACKEND_ADAPTER ? 'preview_only' : 'accepted',
          },
        });
        nextStatus = adapter === PREVIEW_BACKEND_ADAPTER ? 'transformed' : 'delivered';
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE interop_messages
            SET status = $4,
                parsed_summary = parsed_summary || $5::jsonb,
                last_error_code = NULL,
                last_error_safe = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2 AND channel_id = $3
          RETURNING id, tenant_id, channel_id, channel_version_id, direction,
                    protocol, message_type, external_control_id, dedupe_key,
                    payload_hash, raw_payload_retained, redacted_preview,
                    parsed_summary, patient_uid, source_table, source_id,
                    status, last_error_code, last_error_safe, retention_until,
                    created_at, updated_at`,
        tid,
        message.id,
        activeChannel.id,
        nextStatus,
        JSON.stringify({ transform: { output_keys: Object.keys(transformResult.output || {}), finding_count: transformResult.findings.length } }),
      );
      return updated[0];
    } catch (err) {
      const safe = safeError(err);
      await createAttempt(tx, {
        tenantId: tid,
        messageId: message.id,
        channelVersionId: activeChannel.version_id,
        phase: 'transform',
        status: 'failed',
        requestId,
        safeErrorText: safe.message,
        metrics: { code: safe.code },
      });
      const failed = await tx.$queryRawUnsafe(
        `UPDATE interop_messages
            SET status = 'failed',
                last_error_code = $4,
                last_error_safe = $5,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2 AND channel_id = $3
          RETURNING id, tenant_id, channel_id, channel_version_id, direction,
                    protocol, message_type, external_control_id, dedupe_key,
                    payload_hash, raw_payload_retained, redacted_preview,
                    parsed_summary, patient_uid, source_table, source_id,
                    status, last_error_code, last_error_safe, retention_until,
                    created_at, updated_at`,
        tid,
        message.id,
        activeChannel.id,
        safe.code,
        safe.message,
      );
      return failed[0];
    }
  });
}

export async function receiveHttpHl7Message({
  channelKey,
  message,
  headers = {},
  sourceIp = null,
} = {}) {
  const parsedResult = tryParseHl7(message);
  if (parsedResult.error || !parsedResult.parsed?.msh) {
    throw AppError.badRequest('Invalid HL7v2 message', 'INTEROP_HL7_PARSE_FAILED');
  }
  const parsed = parsedResult.parsed;
  const receiver = parsed.msh.receivingFacility;
  const tenantId = await resolveTenantBySender('hl7_inbound', receiver);
  if (!tenantId) {
    throw AppError.unauthorized('Interface engine sender not recognized', 'INTEROP_SENDER_UNKNOWN');
  }
  const channel = await loadChannel({ tenantId, channelKey, activeOnly: true });
  if (!channel || channel.connector_kind !== 'http_inbound' || channel.protocol !== 'hl7v2') {
    throw AppError.notFound('Active HL7 inbound channel not found');
  }
  if (channel.auth_sender_identifier && channel.auth_sender_identifier !== receiver) {
    throw AppError.forbidden('HL7 receiver does not match channel tenant binding', 'INTEROP_CHANNEL_TENANT_MISMATCH');
  }
  if (channel.source_system_status !== 'active') {
    recordInterfaceSourceRejection('inactive_source');
    throw AppError.forbidden(
      'Inbound interface source system is not active',
      'INTEROP_SOURCE_SYSTEM_INACTIVE',
    );
  }
  const allowedSourceRanges = normalizeAllowedSourceRanges(channel.source_allowed_source_ips || []);
  if (!sourceIp) {
    recordInterfaceSourceRejection('missing_source');
    throw AppError.forbidden(
      'Inbound interface source address could not be verified',
      'INTEROP_SOURCE_IP_REQUIRED',
    );
  }
  if (allowedSourceRanges.length === 0) {
    recordInterfaceSourceRejection('empty_allowlist');
    throw AppError.forbidden(
      'Inbound interface source allowlist is not configured',
      'INTEROP_SOURCE_IP_ALLOWLIST_REQUIRED',
    );
  }
  if (!isSourceIpAllowed(sourceIp, allowedSourceRanges)) {
    recordInterfaceSourceRejection('not_allowed');
    throw AppError.forbidden(
      'Inbound interface source address is not authorized',
      'INTEROP_SOURCE_IP_NOT_ALLOWED',
    );
  }
  const secret = await getInteropSecret(tenantId, 'hl7_inbound', { senderIdentifier: receiver });
  if (!secret) {
    throw AppError.unauthorized('Interface engine signing secret is not configured', 'INTEROP_SECRET_NOT_CONFIGURED');
  }
  const requestId = headers['x-hl7-message-id'] || headers['x-request-id'] || parsed.msh.messageControlId;
  const timestamp = headers['x-hl7-timestamp'] || headers.timestamp;
  const signature = headers['x-hl7-signature'] || headers['x-vhhealth-hl7-signature'];
  verifySignedRequest({
    secret,
    signature,
    timestamp,
    requestId,
    payload: message,
    context: 'Interface engine HL7 inbound message',
    codePrefix: 'INTEROP_HL7',
    replayNamespace: `interop-engine:${channel.id}`,
  });
  await assertSharedReplayOnce({
    replayNamespace: `interop-engine:${channel.id}`,
    requestId,
    timestamp,
    signature,
    context: 'Interface engine HL7 inbound message',
    codePrefix: 'INTEROP_HL7',
  });
  logger.info('Interface engine HL7 message accepted', {
    channel_id: channel.id,
    message_type: parsed.msh.messageType,
    control_id: parsed.msh.messageControlId,
    source_ip: sourceIp || undefined,
  });
  return ingestMessage({
    tenantId,
    channel,
    payload: message,
    parsed,
    requestId,
    direction: 'inbound',
  });
}

export async function enqueueOutboundMessage({
  tenantId = null,
  channelId,
  payload,
  protocol = null,
  messageType = null,
  sourceTable = null,
  sourceId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const channel = await loadChannel({ tenantId: tid, id: channelId, activeOnly: true });
  if (!channel) throw AppError.notFound('Active outbound channel not found');
  if (channel.connector_kind !== 'http_outbound') {
    throw AppError.badRequest('Only http_outbound channels can enqueue outbound deliveries', 'INTEROP_OUTBOUND_CONNECTOR_REQUIRED');
  }
  if (protocol && protocol !== channel.protocol) {
    throw AppError.badRequest(
      'Outbound message protocol must match the active channel protocol',
      'INTEROP_OUTBOUND_PROTOCOL_MISMATCH',
    );
  }
  const message = await ingestMessage({
    tenantId: tid,
    channel,
    payload,
    direction: 'outbound',
    sourceTable,
    sourceId,
  });
  if (messageType && message.message_type !== messageType) {
    return runTenantWrite(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE interop_messages
            SET message_type = $3, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2
          RETURNING id, tenant_id, channel_id, channel_version_id, direction,
                    protocol, message_type, external_control_id, dedupe_key,
                    payload_hash, raw_payload_retained, redacted_preview,
                    parsed_summary, patient_uid, source_table, source_id,
                    status, last_error_code, last_error_safe, retention_until,
                    created_at, updated_at`,
        tid,
        message.id,
        safeText(messageType, 80),
      );
      return rows[0];
    });
  }
  return message;
}

export async function dispatchOutboundMessages({
  tenantId = null,
  batchSize = 25,
  maxInFlight = OUTBOUND_MAX_IN_FLIGHT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const limit = normalizeLimit(batchSize, 25, 100);
  const inFlightLimit = normalizeLimit(maxInFlight, OUTBOUND_MAX_IN_FLIGHT, 500);
  const expiredRows = await runTenantWrite(tid, tx => tx.$queryRawUnsafe(
    `UPDATE interop_messages
        SET status = 'quarantined',
            send_authority = CASE
              WHEN owner_release_client_event_id IS NULL THEN 'held'
              ELSE send_authority
            END,
            owner_reconciliation_required = CASE
              WHEN owner_release_client_event_id IS NULL THEN true
              ELSE owner_reconciliation_required
            END,
            delivery_claim_token = NULL,
            delivery_claimed_at = NULL,
            delivery_lease_expires_at = NULL,
            retry_at = NULL,
            last_delivery_outcome = 'ambiguous',
            last_error_code = 'INTEROP_DELIVERY_LEASE_EXPIRED',
            last_error_safe = 'Outbound delivery claim expired; downstream acceptance is unknown',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND status = 'delivering'
        AND delivery_claim_token IS NOT NULL
        AND delivery_lease_expires_at <= NOW()
      RETURNING id`,
    tid,
  ));
  recordInterfaceOutboundClaims('lease_expired', expiredRows.length);

  const inFlightRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM interop_messages
      WHERE tenant_id = $1::uuid
        AND status = 'delivering'
        AND delivery_claim_token IS NOT NULL
        AND delivery_lease_expires_at > NOW()`,
    tid,
  );
  const inFlight = Number(inFlightRows[0]?.count || 0);
  observeInterfaceOutboundInFlight(tid, inFlight);
  const capacity = Math.max(0, inFlightLimit - inFlight);
  const pickLimit = Math.min(limit, capacity);
  const stats = {
    capacity,
    in_flight: inFlight,
    due: 0,
    picked: 0,
    delivered: 0,
    retry_scheduled: 0,
    dead: 0,
    ambiguous: 0,
    held: expiredRows.length,
    lease_expired: expiredRows.length,
    backpressured: 0,
  };
  if (pickLimit === 0) {
    const pendingRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM interop_messages m
         JOIN interop_channels c
           ON c.tenant_id = m.tenant_id AND c.id = m.channel_id
         JOIN interop_channel_versions v
           ON v.tenant_id = m.tenant_id AND v.id = m.channel_version_id
        WHERE m.tenant_id = $1::uuid
          AND m.direction IN ('outbound', 'bidirectional')
          AND (m.status = 'queued'
            OR (m.status = 'failed'
              AND m.last_delivery_outcome = 'definitive_retryable'
              AND m.retry_at <= NOW()))
          AND c.connector_kind = 'http_outbound'
          AND c.status = 'active'
          AND v.status = 'active'`,
      tid,
    );
    stats.due = Number(pendingRows[0]?.count || 0);
    stats.backpressured = stats.due;
    recordInterfaceOutboundClaims('backpressured', stats.backpressured);
    if (stats.backpressured > 0) {
      logger.warn('Interface engine outbound dispatch is at its in-flight limit', stats);
    }
    return stats;
  }

  const due = await prisma.$queryRawUnsafe(
    `SELECT m.id, m.tenant_id::text AS tenant_id, m.channel_id, m.channel_version_id,
            m.raw_payload_ciphertext, m.status, m.protocol, m.external_control_id,
            m.payload_hash, m.owner_release_client_event_id,
            c.channel_key, c.max_attempts, c.retry_policy, v.connector_config,
            attempts.attempt_count,
            COUNT(*) OVER()::int AS due_count
       FROM interop_messages m
       JOIN interop_channels c
         ON c.tenant_id = m.tenant_id AND c.id = m.channel_id
       JOIN interop_channel_versions v
         ON v.tenant_id = m.tenant_id AND v.id = m.channel_version_id
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS attempt_count
           FROM interop_message_attempts attempt
          WHERE attempt.tenant_id = m.tenant_id
            AND attempt.message_id = m.id
            AND attempt.phase = 'deliver_external'
       ) attempts
      WHERE m.tenant_id = $1::uuid
        AND m.direction IN ('outbound', 'bidirectional')
        AND (
          m.status = 'queued'
          OR (
            m.status = 'failed'
            AND m.last_delivery_outcome = 'definitive_retryable'
            AND m.retry_at <= NOW()
          )
        )
        AND attempts.attempt_count < c.max_attempts
        AND m.protocol = ANY($3::text[])
        AND (
          (
            m.arrival_class = 'live'
            AND m.effect_disposition = 'live'
            AND m.send_authority = 'live_authorized'
            AND m.owner_reconciliation_required = false
            AND m.owner_release_client_event_id IS NULL
          )
          OR
          (
            m.recovery_ledger_version = 1
            AND m.arrival_class = 'recovery_backlog'
            AND m.effect_disposition = 'late_pending_only'
            AND m.send_authority = 'owner_authorized'
            AND m.owner_reconciliation_required = false
            AND m.owner_release_client_event_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM clinical_continuity_replay_receipts AS receipt
                JOIN clinical_continuity_replay_effect_evidence AS effect
                  ON effect.tenant_id = receipt.tenant_id
                 AND effect.client_event_id = receipt.client_event_id
               WHERE receipt.tenant_id = m.tenant_id
                 AND receipt.client_event_id = m.owner_release_client_event_id
                 AND receipt.source_kind = 'held_message_release'
                 AND receipt.interface_family = 'I05'
                 AND receipt.interop_message_id = m.id
                 AND receipt.disposition = 'applied'
                 AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                 AND effect.interface_family = 'I05'
                 AND effect.interop_message_id = m.id
                 AND effect.network_send_performed = false
                 AND effect.command_fingerprint = receipt.client_command_fingerprint
                 AND effect.source_state_fingerprint = receipt.source_state_fingerprint
            )
          )
        )
        AND c.connector_kind = 'http_outbound'
        AND c.status = 'active'
        AND v.status = 'active'
      ORDER BY COALESCE(m.retry_at, m.updated_at) ASC, m.id ASC
      LIMIT $2::int`,
    tid,
    pickLimit,
    IMPLEMENTED_I05_PROTOCOLS,
  );
  stats.due = Number(due[0]?.due_count || 0);
  stats.backpressured = Math.max(0, stats.due - due.length);
  recordInterfaceOutboundClaims('backpressured', stats.backpressured);

  for (const message of due) {
    const claimToken = crypto.randomUUID();
    const claimedRows = await runTenantWrite(tid, tx => tx.$queryRawUnsafe(
      `UPDATE interop_messages
          SET status = 'delivering',
              retry_at = NULL,
              delivery_claim_token = $3::uuid,
              delivery_claim_generation = delivery_claim_generation + 1,
              delivery_claimed_at = NOW(),
              delivery_lease_expires_at = NOW() + ($4::integer * INTERVAL '1 second'),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND (
            status = 'queued'
            OR (
              status = 'failed'
              AND last_delivery_outcome = 'definitive_retryable'
              AND retry_at <= NOW()
            )
          )
          AND (
            (
              arrival_class = 'live'
              AND effect_disposition = 'live'
              AND send_authority = 'live_authorized'
              AND owner_reconciliation_required = false
              AND owner_release_client_event_id IS NULL
            )
            OR
            (
              recovery_ledger_version = 1
              AND arrival_class = 'recovery_backlog'
              AND effect_disposition = 'late_pending_only'
              AND send_authority = 'owner_authorized'
              AND owner_reconciliation_required = false
              AND owner_release_client_event_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM clinical_continuity_replay_receipts AS receipt
                  JOIN clinical_continuity_replay_effect_evidence AS effect
                    ON effect.tenant_id = receipt.tenant_id
                   AND effect.client_event_id = receipt.client_event_id
                 WHERE receipt.tenant_id = interop_messages.tenant_id
                   AND receipt.client_event_id = interop_messages.owner_release_client_event_id
                   AND receipt.source_kind = 'held_message_release'
                   AND receipt.interface_family = 'I05'
                   AND receipt.interop_message_id = interop_messages.id
                   AND receipt.disposition = 'applied'
                   AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                   AND effect.interface_family = 'I05'
                   AND effect.interop_message_id = interop_messages.id
                   AND effect.network_send_performed = false
                   AND effect.command_fingerprint = receipt.client_command_fingerprint
                   AND effect.source_state_fingerprint = receipt.source_state_fingerprint
              )
            )
          )
          AND delivery_claim_token IS NULL
          AND (
            SELECT COUNT(*)
              FROM interop_message_attempts attempt
             WHERE attempt.tenant_id = interop_messages.tenant_id
               AND attempt.message_id = interop_messages.id
               AND attempt.phase = 'deliver_external'
          ) < $5::integer
        RETURNING delivery_claim_token::text, delivery_claim_generation,
                  delivery_lease_expires_at`,
      tid,
      message.id,
      claimToken,
      OUTBOUND_LEASE_SECONDS,
      message.max_attempts,
    ));
    const claim = claimedRows[0];
    if (!claim) continue;
    stats.picked += 1;
    recordInterfaceOutboundClaims('leased');
    const claimedMessage = { ...message, ...claim };
    const endpointUrl = endpointUrlFor(message.connector_config);
    const attemptNumber = Number(message.attempt_count || 0) + 1;
    const idempotencyKey = stableOutboundIdempotencyKey({
      tenantId: tid,
      messageId: message.id,
      payloadHash: message.payload_hash,
    });
    let response = null;
    let responseBody = '';
    let networkAttempted = false;
    try {
      if (!endpointUrl) {
        const err = AppError.badRequest('Outbound endpointUrl is required', 'INTEROP_OUTBOUND_URL_REQUIRED');
        err.deliveryOutcome = 'definitive_permanent';
        throw err;
      }
      await assertSafeFeedUrl(endpointUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const rawPayload = decryptField(claimedMessage.raw_payload_ciphertext);
      const protocolAdapter = requireI05ProtocolAdapter(claimedMessage.protocol);
      try {
        networkAttempted = true;
        response = await safeFetch(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': message.connector_config?.contentType || 'application/octet-stream',
            'Idempotency-Key': idempotencyKey,
            'X-VH-Interop-Message-Id': String(message.id),
          },
          body: rawPayload,
          signal: controller.signal,
        });
        if (!response.ok) {
          try { await response.body?.cancel?.(); } catch { /* best effort */ }
          const err = new AppError(`HTTP ${response.status}`, 502, 'INTEROP_OUTBOUND_HTTP_FAILED');
          err.deliveryOutcome = classifyHttpFailure(response.status);
          throw err;
        }
        responseBody = await readBoundedResponseBody(response);
      } finally {
        clearTimeout(timer);
      }

      if (claimedMessage.protocol === 'hl7v2') {
        const evaluation = protocolAdapter.evaluateExternalResponse({
          message: claimedMessage,
          rawPayload,
          responseStatus: response.status,
          responseBody,
        });
        if (!evaluation.accepted) {
          const err = AppError.conflict(
            `HL7v2 downstream acknowledgement was ${evaluation.parsed.state}`,
            'INTEROP_HL7V2_ACK_NOT_ACCEPTED',
          );
          err.deliveryOutcome = classifyHl7Acknowledgement(evaluation.parsed.state);
          throw err;
        }
      } else {
        try {
          protocolAdapter.evaluateExternalResponse({
            message: claimedMessage,
            rawPayload,
            responseStatus: response.status,
            responseBody,
          });
        } catch (err) {
          err.deliveryOutcome = 'ambiguous';
          throw err;
        }
      }

      const authorityMatched = await runTenantWrite(tid, async (tx) => {
        const accepted = await protocolAdapter.recordExternalAcceptanceTx({
          tx,
          tenantId: tid,
          message: claimedMessage,
          rawPayload,
          responseStatus: response.status,
          responseBody,
        });
        const deliveredRows = await tx.$queryRawUnsafe(
          `UPDATE interop_messages
              SET status = 'delivered',
                  delivery_claim_token = NULL,
                  delivery_claimed_at = NULL,
                  delivery_lease_expires_at = NULL,
                  retry_at = NULL,
                  last_delivery_outcome = 'accepted',
                  last_delivery_response_status = $5::integer,
                  last_error_code = NULL,
                  last_error_safe = NULL,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer
              AND status = 'delivering'
              AND delivery_claim_token = $3::uuid
              AND delivery_claim_generation = $4::integer
              AND delivery_lease_expires_at > NOW()
            RETURNING id`,
          tid,
          claimedMessage.id,
          claimToken,
          claim.delivery_claim_generation,
          response.status,
        );
        await createAttempt(tx, {
          tenantId: tid,
          messageId: claimedMessage.id,
          channelVersionId: claimedMessage.channel_version_id,
          phase: 'deliver_external',
          status: 'ok',
          attemptNumber,
          backendIdempotencyKey: idempotencyKey,
          responseStatus: response.status,
          metrics: {
            adapter_version: protocolAdapter.adapterVersion,
            receipt_id: accepted.receipt?.id || null,
            acknowledgement: accepted.acknowledgement,
            byte_parity_verified: true,
            claim_token: claimToken,
            claim_generation: claim.delivery_claim_generation,
            authority_fence_matched: Boolean(deliveredRows[0]),
            outcome: 'accepted',
          },
        });
        if (!deliveredRows[0]) {
          await tx.$executeRawUnsafe(
            `UPDATE interop_messages
                SET status = 'quarantined',
                    send_authority = CASE
                      WHEN owner_release_client_event_id IS NULL THEN 'held'
                      ELSE send_authority
                    END,
                    owner_reconciliation_required = CASE
                      WHEN owner_release_client_event_id IS NULL THEN true
                      ELSE owner_reconciliation_required
                    END,
                    delivery_claim_token = NULL,
                    delivery_claimed_at = NULL,
                    delivery_lease_expires_at = NULL,
                    retry_at = NULL,
                    last_delivery_outcome = 'accepted',
                    last_delivery_response_status = $5::integer,
                    last_error_code = 'INTEROP_ACK_RECORDED_CLAIM_FENCED',
                    last_error_safe = 'Positive acknowledgement recorded after the delivery lease expired',
                    updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer
                AND delivery_claim_token = $3::uuid
                AND delivery_claim_generation = $4::integer`,
            tid,
            claimedMessage.id,
            claimToken,
            claim.delivery_claim_generation,
            response.status,
          );
        }
        return Boolean(deliveredRows[0]);
      });
      recordInterfaceOutboundAttempt('accepted');
      if (authorityMatched) stats.delivered += 1;
      else {
        stats.held += 1;
      }
    } catch (err) {
      const safe = safeError(err);
      const outcome = err?.deliveryOutcome || (networkAttempted ? 'ambiguous' : 'definitive_permanent');
      const retryScheduled = outcome === 'definitive_retryable' && attemptNumber < Number(message.max_attempts);
      const retryAt = retryScheduled
        ? retryAtFor({
          retryPolicy: message.retry_policy,
          attemptNumber,
          jitterKey: `${tid}:${message.id}`,
        })
        : null;
      const terminalStatus = retryScheduled
        ? 'failed'
        : (outcome === 'ambiguous' ? 'quarantined' : 'dead');
      const transitionMatched = await runTenantWrite(tid, async (tx) => {
        await createAttempt(tx, {
          tenantId: tid,
          messageId: claimedMessage.id,
          channelVersionId: claimedMessage.channel_version_id,
          phase: 'deliver_external',
          status: retryScheduled ? 'failed' : (outcome === 'ambiguous' ? 'failed' : 'dead'),
          attemptNumber,
          backendIdempotencyKey: idempotencyKey,
          responseStatus: response?.status || null,
          safeErrorText: safe.message,
          metrics: {
            code: safe.code,
            outcome,
            retry_scheduled: retryScheduled,
            retry_at: retryAt?.toISOString() || null,
            max_attempts: Number(message.max_attempts),
            claim_token: claimToken,
            claim_generation: claim.delivery_claim_generation,
            owner_reconciliation_required: !retryScheduled,
          },
        });
        const transitionedRows = await tx.$queryRawUnsafe(
          `UPDATE interop_messages
              SET status = $5,
                  send_authority = CASE
                    WHEN $6::boolean THEN send_authority
                    WHEN owner_release_client_event_id IS NULL THEN 'held'
                    ELSE send_authority
                  END,
                  owner_reconciliation_required = CASE
                    WHEN $6::boolean THEN owner_reconciliation_required
                    WHEN owner_release_client_event_id IS NULL THEN true
                    ELSE owner_reconciliation_required
                  END,
                  delivery_claim_token = NULL,
                  delivery_claimed_at = NULL,
                  delivery_lease_expires_at = NULL,
                  retry_at = $7::timestamptz,
                  last_delivery_outcome = $8,
                  last_delivery_response_status = $9::integer,
                  last_error_code = $10,
                  last_error_safe = $11,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer
              AND delivery_claim_token = $3::uuid
              AND delivery_claim_generation = $4::integer
            RETURNING id`,
          tid,
          claimedMessage.id,
          claimToken,
          claim.delivery_claim_generation,
          terminalStatus,
          retryScheduled,
          retryAt,
          outcome,
          response?.status || null,
          safe.code,
          safe.message,
        );
        return Boolean(transitionedRows[0]);
      });
      recordInterfaceOutboundAttempt(outcome);
      if (!transitionMatched) {
        stats.held += 1;
      } else if (retryScheduled) stats.retry_scheduled += 1;
      else if (outcome === 'ambiguous') {
        stats.ambiguous += 1;
        stats.held += 1;
      } else {
        stats.dead += 1;
        stats.held += 1;
      }
    }
  }
  if (stats.picked > 0 || stats.lease_expired > 0 || stats.backpressured > 0) {
    logger.info('Interface engine outbound dispatch tick', stats);
  }
  return stats;
}

export async function listMessages({ tenantId = null, channelId = null, status = null, limit = DEFAULT_LIST_LIMIT } = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (channelId) {
    params.push(normalizeId(channelId, 'channel id'));
    filters.push(`channel_id = $${params.length}`);
  }
  const cleanStatus = normalizeOptionalEnum(status, MESSAGE_STATUSES, 'status');
  if (cleanStatus) {
    params.push(cleanStatus);
    filters.push(`status = $${params.length}`);
  }
  params.push(normalizeLimit(limit));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, channel_id, channel_version_id, direction, protocol,
            message_type, external_control_id, dedupe_key, payload_hash,
            raw_payload_retained, redacted_preview, parsed_summary, patient_uid,
            source_table, source_id, status, last_error_code, last_error_safe,
            recovery_ledger_version, source_position::text, source_token,
            predecessor_token, recovery_inbox_id, arrival_class,
            effect_disposition, send_authority, owner_reconciliation_required,
            delivery_claim_generation, delivery_claimed_at,
            delivery_lease_expires_at, retry_at, last_delivery_outcome,
            last_delivery_response_status, retention_until, created_at, updated_at
       FROM interop_messages
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
  return { messages: rows, count: rows.length };
}

export async function getMessage({ tenantId = null, id } = {}) {
  const tid = requireTenantId(tenantId);
  const messageRows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, channel_id, channel_version_id, direction, protocol,
            message_type, external_control_id, dedupe_key, payload_hash,
            raw_payload_retained, redacted_preview, parsed_summary, patient_uid,
            source_table, source_id, status, last_error_code, last_error_safe,
            recovery_ledger_version, source_position::text, source_token,
            predecessor_token, recovery_inbox_id, arrival_class,
            effect_disposition, send_authority, owner_reconciliation_required,
            delivery_claim_generation, delivery_claimed_at,
            delivery_lease_expires_at, retry_at, last_delivery_outcome,
            last_delivery_response_status, retention_until, created_at, updated_at
       FROM interop_messages
      WHERE tenant_id = $1::uuid AND id = $2
      LIMIT 1`,
    tid,
    normalizeId(id, 'message id'),
  );
  const message = messageRows[0];
  if (!message) throw AppError.notFound('Message not found');
  const attempts = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, message_id, channel_version_id, attempt_number,
            phase, status, started_at, finished_at, duration_ms, request_id,
            backend_idempotency_key, response_status, safe_error, metrics, created_at
       FROM interop_message_attempts
      WHERE tenant_id = $1::uuid AND message_id = $2
      ORDER BY attempt_number DESC, id DESC`,
    tid,
    message.id,
  );
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT id::text, message_id, channel_id, channel_version_id, protocol,
            direction, adapter_key, adapter_version, payload_sha256::text,
            payload_bytes, receipt_status, recovery_inbox_id::text,
            owner_actor_uid::text, owner_reason, evidence, created_at
       FROM interop_backend_delivery_receipts
      WHERE tenant_id = $1::uuid AND message_id = $2::integer
      ORDER BY id DESC`,
    tid,
    message.id,
  );
  return { ...message, attempts, receipts };
}

export async function markMessageDead({ tenantId = null, id, reason = null } = {}) {
  const tid = requireTenantId(tenantId);
  const cleanReason = safeText(reason, MAX_SAFE_ERROR) || 'Operator moved message to dead-letter';
  return runTenantWrite(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE interop_messages
          SET status = 'dead',
              send_authority = CASE
                WHEN owner_release_client_event_id IS NULL THEN 'held'
                ELSE send_authority
              END,
              owner_reconciliation_required = CASE
                WHEN owner_release_client_event_id IS NULL THEN true
                ELSE owner_reconciliation_required
              END,
              delivery_claim_token = NULL,
              delivery_claimed_at = NULL,
              delivery_lease_expires_at = NULL,
              retry_at = NULL,
              last_error_code = 'INTEROP_OPERATOR_DEAD_LETTER',
              last_error_safe = $3,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING id, tenant_id, channel_id, channel_version_id, direction,
                  protocol, message_type, external_control_id, dedupe_key,
                  payload_hash, raw_payload_retained, redacted_preview,
                  parsed_summary, patient_uid, source_table, source_id,
                  status, last_error_code, last_error_safe, retention_until,
                  created_at, updated_at`,
      tid,
      normalizeId(id, 'message id'),
      cleanReason,
    );
    if (!rows[0]) throw AppError.notFound('Message not found');
    await createAttempt(tx, {
      tenantId: tid,
      messageId: rows[0].id,
      channelVersionId: rows[0].channel_version_id,
      phase: 'replay',
      status: 'dead',
      safeErrorText: cleanReason,
    });
    return rows[0];
  });
}

export async function createReplayBatch({
  tenantId = null,
  channelId,
  reason,
  mode = 'retry_delivery',
  selectionFilter = {},
  requestedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const channel = await loadChannel({ tenantId: tid, id: channelId });
  if (!channel) throw AppError.notFound('Channel not found');
  const cleanReason = safeText(reason, 1000);
  if (!cleanReason || cleanReason.length < 8) {
    throw AppError.badRequest('reason must be at least 8 characters');
  }
  const cleanMode = normalizeEnum(mode, REPLAY_MODES, 'mode');
  if (cleanMode !== 'retry_delivery') {
    throw AppError.badRequest(
      `Replay mode ${cleanMode} has no implemented runtime`,
      'INTEROP_REPLAY_MODE_UNSUPPORTED',
    );
  }
  const filter = normalizeJsonObject(selectionFilter, 'selection_filter');
  const statuses = Array.isArray(filter.statuses) && filter.statuses.length
    ? filter.statuses.map((status) => normalizeEnum(status, MESSAGE_STATUSES, 'selection_filter.statuses'))
    : ['failed'];
  const result = await runTenantWrite(tid, async (tx) => {
    const batchRows = await tx.$queryRawUnsafe(
      `INSERT INTO interop_replay_batches
         (tenant_id, channel_id, requested_by, reason, selection_filter,
          mode, status, message_count, selected_count, queued_count,
          skipped_count, safe_summary, started_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb, $6,
               'running', 0, 0, 0, 0, 'Selecting eligible messages', NOW())
       RETURNING id, tenant_id, channel_id, requested_by, reason,
                 selection_filter, mode, status, message_count,
                 selected_count, queued_count, skipped_count, safe_summary,
                 created_at, started_at, completed_at`,
      tid,
      channel.id,
      requestedBy,
      cleanReason,
      JSON.stringify(filter),
      cleanMode,
    );
    const messages = await tx.$queryRawUnsafe(
      `WITH candidates AS MATERIALIZED (
         SELECT m.id
           FROM interop_messages m
          WHERE m.tenant_id = $1::uuid
            AND m.channel_id = $2::integer
            AND m.status = ANY($3::text[])
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT $4::int
          FOR UPDATE SKIP LOCKED
       )
       SELECT m.id, m.channel_version_id, m.status,
              (m.status = 'failed'
               AND m.last_delivery_outcome = 'definitive_retryable'
               AND m.delivery_claim_token IS NULL
               AND attempts.attempt_count < c.max_attempts
               AND c.connector_kind = 'http_outbound'
               AND c.status = 'active'
               AND v.status = 'active'
               AND c.active_version_id = v.id
               AND (
                  (
                    m.arrival_class = 'live'
                    AND m.effect_disposition = 'live'
                    AND m.send_authority = 'live_authorized'
                    AND m.owner_reconciliation_required = false
                    AND m.owner_release_client_event_id IS NULL
                  )
                  OR
                  (
                    m.recovery_ledger_version = 1
                    AND m.arrival_class = 'recovery_backlog'
                    AND m.effect_disposition = 'late_pending_only'
                    AND m.send_authority = 'owner_authorized'
                    AND m.owner_reconciliation_required = false
                    AND m.owner_release_client_event_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                        FROM clinical_continuity_replay_receipts AS receipt
                        JOIN clinical_continuity_replay_effect_evidence AS effect
                          ON effect.tenant_id = receipt.tenant_id
                         AND effect.client_event_id = receipt.client_event_id
                       WHERE receipt.tenant_id = m.tenant_id
                         AND receipt.client_event_id = m.owner_release_client_event_id
                         AND receipt.source_kind = 'held_message_release'
                         AND receipt.interface_family = 'I05'
                         AND receipt.interop_message_id = m.id
                         AND receipt.disposition = 'applied'
                         AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                         AND effect.interface_family = 'I05'
                         AND effect.interop_message_id = m.id
                         AND effect.network_send_performed = false
                         AND effect.command_fingerprint = receipt.client_command_fingerprint
                         AND effect.source_state_fingerprint = receipt.source_state_fingerprint
                    )
                  )
                )) AS eligible
         FROM candidates
         JOIN interop_messages m ON m.id = candidates.id
         JOIN interop_channels c
           ON c.tenant_id = m.tenant_id AND c.id = m.channel_id
         JOIN interop_channel_versions v
           ON v.tenant_id = m.tenant_id AND v.id = m.channel_version_id
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::int AS attempt_count
             FROM interop_message_attempts attempt
            WHERE attempt.tenant_id = m.tenant_id
              AND attempt.message_id = m.id
              AND attempt.phase = 'deliver_external'
         ) attempts
        ORDER BY m.created_at ASC, m.id ASC`,
      tid,
      channel.id,
      statuses,
      normalizeLimit(filter.limit, 50, 200),
    );
    let queuedCount = 0;
    let skippedCount = 0;
    for (const message of messages) {
      let queued = false;
      if (message.eligible) {
        const queuedRows = await tx.$queryRawUnsafe(
          `UPDATE interop_messages
              SET status = 'queued',
                  retry_at = NULL,
                  delivery_claim_token = NULL,
                  delivery_claimed_at = NULL,
                  delivery_lease_expires_at = NULL,
                  last_error_code = NULL,
                  last_error_safe = NULL,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::integer
              AND status = 'failed'
              AND last_delivery_outcome = 'definitive_retryable'
              AND delivery_claim_token IS NULL
            RETURNING id`,
          tid,
          message.id,
        );
        queued = Boolean(queuedRows[0]);
      }
      if (queued) queuedCount += 1;
      else skippedCount += 1;
      await createAttempt(tx, {
        tenantId: tid,
        messageId: message.id,
        channelVersionId: message.channel_version_id,
        phase: 'replay',
        status: queued ? 'ok' : 'skipped',
        metrics: {
          replay_batch_id: batchRows[0].id,
          mode: cleanMode,
          queued,
          prior_status: message.status,
        },
      });
    }
    const selectedCount = messages.length;
    const completedStatus = skippedCount > 0 ? 'completed_with_failures' : 'completed';
    const safeSummary = selectedCount === 0
      ? 'No messages matched the replay selection'
      : `Queued ${queuedCount} of ${selectedCount} selected message(s); skipped ${skippedCount}`;
    const completedRows = await tx.$queryRawUnsafe(
      `UPDATE interop_replay_batches
          SET status = $3,
              message_count = $4::integer,
              selected_count = $4::integer,
              queued_count = $5::integer,
              skipped_count = $6::integer,
              safe_summary = $7,
              completed_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING id, tenant_id, channel_id, requested_by, reason,
                  selection_filter, mode, status, message_count,
                  selected_count, queued_count, skipped_count, safe_summary,
                  created_at, started_at, completed_at`,
      tid,
      batchRows[0].id,
      completedStatus,
      selectedCount,
      queuedCount,
      skippedCount,
      safeSummary,
    );
    return completedRows[0];
  });
  recordInterfaceReplayMessages('queued', result.queued_count);
  recordInterfaceReplayMessages('skipped', result.skipped_count);
  return result;
}

export async function listReplayBatches({ tenantId = null, channelId = null, limit = DEFAULT_LIST_LIMIT } = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (channelId) {
    params.push(normalizeId(channelId, 'channel id'));
    filters.push(`channel_id = $${params.length}`);
  }
  params.push(normalizeLimit(limit));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, channel_id, requested_by, reason, selection_filter,
            mode, status, message_count, selected_count, queued_count,
            skipped_count, safe_summary, created_at,
            started_at, completed_at
       FROM interop_replay_batches
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
  return { batches: rows, count: rows.length };
}

export default {
  activateChannelVersion,
  createChannel,
  createChannelVersion,
  createReplayBatch,
  createSystem,
  createTransformTest,
  dispatchOutboundMessages,
  enqueueOutboundMessage,
  getMessage,
  listChannels,
  listMessages,
  listReplayBatches,
  listSystems,
  listTransformTests,
  markMessageDead,
  receiveHttpHl7Message,
  runTransformTest,
};
