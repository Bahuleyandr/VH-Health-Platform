// src/services/devices/deviceRegistryService.js

import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const DEVICE_KINDS = Object.freeze([
  'central_station',
  'monitor',
  'monitor_gateway',
  'fridge_sensor',
  'dialysis_machine',
  'rtls_feed',
  'other',
]);

export const DEVICE_STATUSES = Object.freeze(['active', 'paused', 'revoked', 'archived']);
export const DEVICE_PROTOCOLS = Object.freeze(['mllp-hl7v2', 'http-hl7v2', 'http-json']);

const DEVICE_SECRET_BYTES = 32;
const DEVICE_SECRET_PREFIX_LEN = 14;

const DEVICE_RETURNING = `
  id, tenant_id, device_code, display_name, kind, protocol, vendor, model, serial_number,
  biomed_device_id, location_id, allowed_source_ips::text[] AS allowed_source_ips,
  credential_prefix, status, last_seen_at, metadata, charting_interval_minutes,
  critical_suppression_window_minutes, warning_suppression_window_minutes,
  artifact_filter_required, artifact_filter_window, expected_interval_seconds,
  created_by, created_at, updated_at
`;

function safeText(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function positiveInt(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function enumValue(value, allowed, label, fallback = null) {
  const text = safeText(value, 80) || fallback;
  if (!text || !allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function jsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function stringArray(value, label, max = 50) {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  if (value.length > max) throw AppError.badRequest(`${label} max length is ${max}`);
  return value.map((item) => safeText(item, 120)).filter(Boolean);
}

function hashDeviceCredential(plaintext) {
  const digest = crypto.createHash('sha256').update(`vhdev:${plaintext}`).digest('hex');
  return `sha256:${digest}`;
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issuePlaintextCredential() {
  return `vhdev_${crypto.randomBytes(DEVICE_SECRET_BYTES).toString('base64url')}`;
}

function normalizeDeviceInput(input = {}, existing = {}) {
  const deviceCode = safeText(input.device_code ?? input.deviceCode ?? existing.device_code, 120);
  const displayName = safeText(input.display_name ?? input.displayName ?? existing.display_name, 255);
  if (!deviceCode) throw AppError.badRequest('device_code is required');
  if (!displayName) throw AppError.badRequest('display_name is required');
  return {
    deviceCode,
    displayName,
    kind: enumValue(input.kind ?? existing.kind, DEVICE_KINDS, 'kind', 'other'),
    protocol: enumValue(input.protocol ?? existing.protocol, DEVICE_PROTOCOLS, 'protocol', 'mllp-hl7v2'),
    vendor: safeText(input.vendor ?? existing.vendor, 120),
    model: safeText(input.model ?? existing.model, 120),
    serialNumber: safeText(input.serial_number ?? input.serialNumber ?? existing.serial_number, 120),
    biomedDeviceId: positiveInt(input.biomed_device_id ?? input.biomedDeviceId ?? existing.biomed_device_id, 'biomed_device_id'),
    locationId: positiveInt(input.location_id ?? input.locationId ?? existing.location_id, 'location_id'),
    allowedSourceIps: stringArray(
      input.allowed_source_ips ?? input.allowedSourceIps ?? existing.allowed_source_ips,
      'allowed_source_ips',
      50,
    ),
    status: enumValue(input.status ?? existing.status, DEVICE_STATUSES, 'status', 'active'),
    metadata: jsonObject(input.metadata ?? existing.metadata, 'metadata'),
  };
}

function policyPatch(input = {}) {
  return {
    chartingIntervalMinutes: positiveInt(input.charting_interval_minutes ?? input.chartingIntervalMinutes, 'charting_interval_minutes'),
    criticalSuppressionWindowMinutes: positiveInt(input.critical_suppression_window_minutes ?? input.criticalSuppressionWindowMinutes, 'critical_suppression_window_minutes'),
    warningSuppressionWindowMinutes: positiveInt(input.warning_suppression_window_minutes ?? input.warningSuppressionWindowMinutes, 'warning_suppression_window_minutes'),
    artifactFilterRequired: positiveInt(input.artifact_filter_required ?? input.artifactFilterRequired, 'artifact_filter_required'),
    artifactFilterWindow: positiveInt(input.artifact_filter_window ?? input.artifactFilterWindow, 'artifact_filter_window'),
    expectedIntervalSeconds: positiveInt(input.expected_interval_seconds ?? input.expectedIntervalSeconds, 'expected_interval_seconds'),
  };
}

function missingSchema(err) {
  return /relation ["']?device_registry["']? does not exist/i.test(String(err?.message || ''));
}

function duplicateDevice(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

export async function listDevices({ tenantId, status = null, kind = null, search = null, limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const params = [tid];
  const where = ['tenant_id = $1::uuid'];
  if (status) {
    params.push(enumValue(status, DEVICE_STATUSES, 'status'));
    where.push(`status = $${params.length}`);
  }
  if (kind) {
    params.push(enumValue(kind, DEVICE_KINDS, 'kind'));
    where.push(`kind = $${params.length}`);
  }
  if (safeText(search, 120)) {
    params.push(`%${safeText(search, 120)}%`);
    where.push(`(device_code ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  params.push(Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500)));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${DEVICE_RETURNING}
         FROM device_registry
        WHERE ${where.join(' AND ')}
        ORDER BY display_name
        LIMIT $${params.length}::int`,
      ...params,
    );
    return { devices: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { devices: [], count: 0 };
    throw err;
  }
}

export async function getDeviceById({ tenantId, id }) {
  const tid = requireTenantId(tenantId);
  const deviceId = positiveInt(id, 'device id', { required: true });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${DEVICE_RETURNING}
       FROM device_registry
      WHERE tenant_id = $1::uuid AND id = $2
      LIMIT 1`,
    tid,
    deviceId,
  );
  if (!rows[0]) throw AppError.notFound('Device not found', 'DEVICE_NOT_FOUND');
  return rows[0];
}

export async function getActiveDeviceByCode({ tenantId, deviceCode }) {
  const tid = requireTenantId(tenantId);
  const code = safeText(deviceCode, 120);
  if (!code) throw AppError.badRequest('device_code is required', 'DEVICE_CODE_REQUIRED');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${DEVICE_RETURNING}, credential_hash
       FROM device_registry
      WHERE tenant_id = $1::uuid AND device_code = $2 AND status = 'active'
      LIMIT 1`,
    tid,
    code,
  );
  return rows[0] || null;
}

export async function createDevice(input = {}, context = {}) {
  const tid = requireTenantId(context.tenantId || input.tenantId);
  const normalized = normalizeDeviceInput(input);
  let credential = null;
  let credentialHash = null;
  let credentialPrefix = null;
  if (input.issue_credential === true || input.issueCredential === true) {
    credential = issuePlaintextCredential();
    credentialHash = hashDeviceCredential(credential);
    credentialPrefix = credential.slice(0, DEVICE_SECRET_PREFIX_LEN);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO device_registry
         (tenant_id, device_code, display_name, kind, protocol, vendor, model, serial_number,
          biomed_device_id, location_id, allowed_source_ips, credential_hash, credential_prefix,
          status, metadata, created_by)
       VALUES (
          $1::uuid, $2, $3, $4, $5, $6, $7, $8,
          $9::int, $10::int, ARRAY(SELECT unnest($11::text[])::inet), $12, $13,
          $14, $15::jsonb, $16::uuid
       )
       RETURNING ${DEVICE_RETURNING}`,
      tid,
      normalized.deviceCode,
      normalized.displayName,
      normalized.kind,
      normalized.protocol,
      normalized.vendor,
      normalized.model,
      normalized.serialNumber,
      normalized.biomedDeviceId,
      normalized.locationId,
      normalized.allowedSourceIps,
      credentialHash,
      credentialPrefix,
      normalized.status,
      JSON.stringify(normalized.metadata),
      maybeUuid(context.actorUid, 'actor uid'),
    );
    return { device: rows[0], credential_plaintext: credential };
  } catch (err) {
    if (duplicateDevice(err)) throw AppError.conflict('device_code already exists', 'DEVICE_CODE_EXISTS');
    throw err;
  }
}

export async function updateDevice({ tenantId, id, patch = {} } = {}) {
  const existing = await getDeviceById({ tenantId, id });
  const normalized = normalizeDeviceInput(patch, existing);
  const policy = policyPatch(patch);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE device_registry
          SET device_code = $3,
              display_name = $4,
              kind = $5,
              protocol = $6,
              vendor = $7,
              model = $8,
              serial_number = $9,
              biomed_device_id = $10::int,
              location_id = $11::int,
              allowed_source_ips = ARRAY(SELECT unnest($12::text[])::inet),
              status = $13,
              metadata = $14::jsonb,
              charting_interval_minutes = COALESCE($15::int, charting_interval_minutes),
              critical_suppression_window_minutes = COALESCE($16::int, critical_suppression_window_minutes),
              warning_suppression_window_minutes = COALESCE($17::int, warning_suppression_window_minutes),
              artifact_filter_required = COALESCE($18::int, artifact_filter_required),
              artifact_filter_window = COALESCE($19::int, artifact_filter_window),
              expected_interval_seconds = COALESCE($20::int, expected_interval_seconds),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING ${DEVICE_RETURNING}`,
      requireTenantId(tenantId),
      positiveInt(id, 'device id', { required: true }),
      normalized.deviceCode,
      normalized.displayName,
      normalized.kind,
      normalized.protocol,
      normalized.vendor,
      normalized.model,
      normalized.serialNumber,
      normalized.biomedDeviceId,
      normalized.locationId,
      normalized.allowedSourceIps,
      normalized.status,
      JSON.stringify(normalized.metadata),
      policy.chartingIntervalMinutes,
      policy.criticalSuppressionWindowMinutes,
      policy.warningSuppressionWindowMinutes,
      policy.artifactFilterRequired,
      policy.artifactFilterWindow,
      policy.expectedIntervalSeconds,
    );
    return rows[0];
  } catch (err) {
    if (duplicateDevice(err)) throw AppError.conflict('device_code already exists', 'DEVICE_CODE_EXISTS');
    throw err;
  }
}

export async function rotateDeviceCredential({ tenantId, id } = {}) {
  const tid = requireTenantId(tenantId);
  const deviceId = positiveInt(id, 'device id', { required: true });
  const credential = issuePlaintextCredential();
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE device_registry
        SET credential_hash = $3,
            credential_prefix = $4,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2
      RETURNING ${DEVICE_RETURNING}`,
    tid,
    deviceId,
    hashDeviceCredential(credential),
    credential.slice(0, DEVICE_SECRET_PREFIX_LEN),
  );
  if (!rows[0]) throw AppError.notFound('Device not found', 'DEVICE_NOT_FOUND');
  return { device: rows[0], credential_plaintext: credential };
}

export async function authenticateDeviceCredential({
  tenantId,
  plaintext,
  sourceIp = null,
  deviceCode = null,
} = {}) {
  if (!plaintext) return null;
  const tid = requireTenantId(tenantId);
  const keyHash = hashDeviceCredential(String(plaintext).trim());
  const filters = ['tenant_id = $1::uuid', 'credential_hash IS NOT NULL', 'status = \'active\''];
  const params = [tid];
  if (safeText(deviceCode, 120)) {
    params.push(safeText(deviceCode, 120));
    filters.push(`device_code = $${params.length}`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${DEVICE_RETURNING}, credential_hash
       FROM device_registry
      WHERE ${filters.join(' AND ')}
      ORDER BY device_code
      LIMIT 500`,
    ...params,
  );
  for (const row of rows) {
    if (!timingSafeEqualString(row.credential_hash, keyHash)) continue;
    if (sourceIp && Array.isArray(row.allowed_source_ips) && row.allowed_source_ips.length > 0) {
      const allowed = row.allowed_source_ips.some((ip) => timingSafeEqualString(ip, String(sourceIp).trim()));
      if (!allowed) return null;
    }
    await prisma.$executeRawUnsafe(
      `UPDATE device_registry
          SET last_seen_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2`,
      tid,
      row.id,
    );
    const { credential_hash: _credentialHash, ...device } = row;
    return device;
  }
  return null;
}

export async function resolveDeviceBySourceIp({
  tenantId,
  sourceIp,
  deviceCode = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const ip = safeText(sourceIp, 120);
  if (!ip) throw AppError.badRequest('source_ip is required', 'DEVICE_SOURCE_IP_REQUIRED');
  const params = [tid, ip];
  const filters = [
    'tenant_id = $1::uuid',
    'status = \'active\'',
    '$2::inet = ANY(allowed_source_ips)',
  ];
  if (safeText(deviceCode, 120)) {
    params.push(safeText(deviceCode, 120));
    filters.push(`device_code = $${params.length}`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${DEVICE_RETURNING}
       FROM device_registry
      WHERE ${filters.join(' AND ')}
      ORDER BY device_code
      LIMIT 2`,
    ...params,
  );
  if (rows.length > 1) {
    throw AppError.conflict('source_ip matches multiple devices; include device_code', 'DEVICE_SOURCE_IP_AMBIGUOUS');
  }
  if (!rows[0]) return null;
  await prisma.$executeRawUnsafe(
    `UPDATE device_registry
        SET last_seen_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2`,
    tid,
    rows[0].id,
  );
  return rows[0];
}

export async function touchDeviceSeen({ tenantId, id }) {
  await prisma.$executeRawUnsafe(
    `UPDATE device_registry
        SET last_seen_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2`,
    requireTenantId(tenantId),
    positiveInt(id, 'device id', { required: true }),
  );
}

export const __testing__ = {
  hashDeviceCredential,
  timingSafeEqualString,
  issuePlaintextCredential,
};

export default {
  listDevices,
  getDeviceById,
  getActiveDeviceByCode,
  createDevice,
  updateDevice,
  rotateDeviceCredential,
  authenticateDeviceCredential,
  resolveDeviceBySourceIp,
  touchDeviceSeen,
};
