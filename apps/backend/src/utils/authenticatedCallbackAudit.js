const AUTHENTICATED_CALLBACK_AUDIT = Symbol('authenticatedCallbackAudit');

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UHI_CALLBACK_PATH_RE = /^\/api\/v1\/uhi\/(?:search|init|confirm|status|cancel)\/?$/i;

export function isProviderCallbackPath(path) {
  const pathOnly = String(path || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
  return pathOnly === '/webhooks/payments'
    || pathOnly.startsWith('/webhooks/payments/')
    || pathOnly === '/webhooks/sms'
    || pathOnly.startsWith('/webhooks/sms/')
    || UHI_CALLBACK_PATH_RE.test(pathOnly);
}

function boundedActorValue(value, field) {
  const text = String(value || '').trim();
  if (!text || text.length > 160 || !/^[A-Za-z0-9._:@|/-]+$/.test(text)) {
    throw new TypeError(`Invalid authenticated callback ${field}`);
  }
  return text;
}

export function setAuthenticatedCallbackAuditContext(req, {
  tenantId,
  provider,
  externalActorId = null,
}) {
  const normalizedTenantId = String(tenantId || '').trim().toLowerCase();
  if (!UUID_RE.test(normalizedTenantId)) {
    throw new TypeError('Invalid authenticated callback tenantId');
  }

  const normalizedProvider = boundedActorValue(provider, 'provider').toLowerCase();
  const normalizedActorId = externalActorId == null
    ? normalizedProvider
    : boundedActorValue(externalActorId, 'externalActorId');

  const existing = req?.[AUTHENTICATED_CALLBACK_AUDIT];
  if (existing) {
    if (existing.tenantId === normalizedTenantId
        && existing.provider === normalizedProvider
        && existing.externalActorId === normalizedActorId) {
      return;
    }
    throw new TypeError('Authenticated callback audit context cannot be replaced');
  }

  Object.defineProperty(req, AUTHENTICATED_CALLBACK_AUDIT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      tenantId: normalizedTenantId,
      provider: normalizedProvider,
      externalActorId: normalizedActorId,
      actorName: `${normalizedProvider} callback`,
      actorRole: 'SYSTEM',
    }),
  });
}

export function getAuthenticatedCallbackAuditContext(req) {
  return req?.[AUTHENTICATED_CALLBACK_AUDIT] || null;
}
