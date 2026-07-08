import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { SwaggerService } from '../infrastructure/swaggerService.js';
import { listApiClients, listApiKeys } from './apiClientService.js';

const AUDIT_EVENT_TYPES = [
  'client.created',
  'client.updated',
  'client.status_changed',
  'key.issued',
  'key.rotated',
  'key.revoked',
  'openapi.downloaded',
  'guide.viewed',
  'scope_dictionary.viewed',
];

export const DEVELOPER_PORTAL_SCOPE_DICTIONARY = [
  {
    key: 'system.read',
    label: 'System metadata',
    category: 'Platform',
    risk: 'low',
    description: 'Read version, health, and product metadata needed by integration monitors.',
  },
  {
    key: 'openapi.read',
    label: 'OpenAPI specification',
    category: 'Documentation',
    risk: 'low',
    description: 'Download the current OpenAPI contract and generated endpoint catalog.',
  },
  {
    key: 'fhir.read',
    label: 'FHIR read',
    category: 'FHIR',
    risk: 'medium',
    description: 'Read SMART/FHIR resources once tenant policy enables public SMART endpoints.',
  },
  {
    key: 'fhir.write',
    label: 'FHIR write',
    category: 'FHIR',
    risk: 'high',
    description: 'Write supported FHIR resources after explicit tenant and platform approval.',
  },
  {
    key: 'webhook.deliver',
    label: 'Webhook delivery',
    category: 'Events',
    risk: 'medium',
    description: 'Receive tenant-scoped integration events through registered webhook subscriptions.',
  },
  {
    key: 'billing.read',
    label: 'Billing read',
    category: 'Revenue cycle',
    risk: 'medium',
    description: 'Read billing summaries and claim status for approved partner integrations.',
  },
];

export const DEVELOPER_PORTAL_INTEGRATION_GUIDE = {
  title: 'VH Health integration guide',
  base_url_hint: 'Use the tenant-specific API base URL configured for the target environment.',
  authentication: [
    'Send the issued value as x-api-key on every request.',
    'Plaintext keys are displayed once at issue or rotation time.',
    'Keys remain bound to their tenant, environment, allowed IP list, and parent API client.',
  ],
  lifecycle: [
    'Create a sandbox client first, then issue a short-lived sandbox key.',
    'Rotate by revoking the selected active key and issuing a replacement in one operation.',
    'Revoke compromised or retired keys immediately; revoked keys cannot authenticate.',
  ],
  security_notes: [
    'Store only the plaintext key in the partner secret manager; VH Health stores a SHA-256 hash.',
    'Keep allowed IPs as narrow as possible before moving a client to production.',
    'SMART/FHIR public exposure is a later NL-11 slice and is not enabled by this portal.',
  ],
};

function requireEventType(eventType) {
  const text = String(eventType || '').trim();
  if (!AUDIT_EVENT_TYPES.includes(text)) {
    throw AppError.badRequest(`event_type must be one of: ${AUDIT_EVENT_TYPES.join(', ')}`);
  }
  return text;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function safeText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function maybeUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

function normalizePositiveInt(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeLimit(value, fallback = 50) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 200));
}

function normalizeMetadata(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be a JSON object');
  }
  return value;
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, jsonSafe(val)]));
  }
  return value;
}

export async function recordDeveloperPortalAuditEvent({
  tenantId = null,
  apiClientId = null,
  apiKeyId = null,
  eventType,
  outcome = 'success',
  actorUid = null,
  actorRole = null,
  ipAddress = null,
  userAgent = null,
  summary = null,
  metadata = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanType = requireEventType(eventType);
  const cleanOutcome = ['success', 'failure', 'skipped'].includes(String(outcome)) ? String(outcome) : 'success';
  try {
    const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO developer_portal_audit_events
         (tenant_id, api_client_id, api_key_id, event_type, outcome, actor_uid,
          actor_role, ip_address, user_agent, summary, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11::jsonb)
       RETURNING id, tenant_id, api_client_id, api_key_id, event_type, outcome,
         actor_uid, actor_role, ip_address, user_agent, summary, metadata, created_at`,
      tid,
      normalizePositiveInt(apiClientId, 'api_client_id'),
      normalizePositiveInt(apiKeyId, 'api_key_id'),
      cleanType,
      cleanOutcome,
      maybeUuid(actorUid),
      safeText(actorRole, 80),
      safeText(ipAddress, 64),
      safeText(userAgent, 255),
      safeText(summary),
      JSON.stringify(normalizeMetadata(metadata)),
    ));
    return rows[0] ? jsonSafe(rows[0]) : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listDeveloperPortalAuditEvents({
  tenantId = null,
  apiClientId = null,
  eventType = null,
  limit = 50,
} = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (apiClientId) {
    params.push(normalizePositiveInt(apiClientId, 'api_client_id'));
    filters.push(`api_client_id = $${params.length}`);
  }
  if (eventType) {
    params.push(requireEventType(eventType));
    filters.push(`event_type = $${params.length}`);
  }
  const cleanLimit = normalizeLimit(limit);
  params.push(cleanLimit);

  try {
    const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT id, tenant_id, api_client_id, api_key_id, event_type, outcome,
              actor_uid, actor_role, ip_address, user_agent, summary, metadata, created_at
       FROM developer_portal_audit_events
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      ...params,
    ));
    const events = rows.map(jsonSafe);
    return { events, count: events.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { events: [], count: 0 };
    throw err;
  }
}

export async function getDeveloperPortalSummary({
  tenantId = null,
  status = null,
  clientKind = null,
  environment = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const [clientsResult, keysResult, auditResult] = await Promise.all([
    listApiClients({ tenantId: tid, status, clientKind, environment }),
    listApiKeys({ tenantId: tid }),
    listDeveloperPortalAuditEvents({ tenantId: tid, limit: 25 }),
  ]);

  const keysByClient = new Map();
  for (const key of keysResult.keys) {
    const safeKey = jsonSafe(key);
    const list = keysByClient.get(safeKey.api_client_id) || [];
    list.push(safeKey);
    keysByClient.set(safeKey.api_client_id, list);
  }

  const clients = clientsResult.clients.map((client) => {
    const safeClient = jsonSafe(client);
    const keys = keysByClient.get(safeClient.id) || [];
    return {
      ...safeClient,
      keys,
      key_count: keys.length,
      active_key_count: keys.filter((key) => key.status === 'active').length,
    };
  });

  return {
    clients,
    count: clients.length,
    counts: {
      total_clients: clients.length,
      active_clients: clients.filter((client) => client.status === 'active').length,
      sandbox_clients: clients.filter((client) => client.environment === 'sandbox').length,
      production_clients: clients.filter((client) => client.environment === 'production').length,
      total_keys: keysResult.keys.length,
      active_keys: keysResult.keys.filter((key) => key.status === 'active').length,
    },
    scope_dictionary: DEVELOPER_PORTAL_SCOPE_DICTIONARY,
    integration_guide: DEVELOPER_PORTAL_INTEGRATION_GUIDE,
    sandbox_key_policy: {
      environment: 'sandbox',
      recommended_status: 'active',
      recommended_scopes: ['system.read', 'openapi.read'],
      recommended_expiry_days: 30,
      production_promotion: 'Create a production client only after tenant and platform approval.',
    },
    openapi_download: {
      endpoint: '/api/v1/admin/developer-portal/openapi',
      filename: 'vh-health-openapi.json',
      media_type: 'application/json',
    },
    audit_events: auditResult.events,
  };
}

export function getDeveloperPortalOpenApiDocument() {
  const { swaggerDocument } = SwaggerService.getSwaggerDocument();
  return {
    ...swaggerDocument,
    'x-generated-at': new Date().toISOString(),
    'x-generator': 'VH Health Developer Portal',
    'x-spec-source': SwaggerService.swaggerCache?.loadError ? 'fallback' : 'file',
  };
}

export default {
  DEVELOPER_PORTAL_SCOPE_DICTIONARY,
  DEVELOPER_PORTAL_INTEGRATION_GUIDE,
  getDeveloperPortalOpenApiDocument,
  getDeveloperPortalSummary,
  listDeveloperPortalAuditEvents,
  recordDeveloperPortalAuditEvent,
};
