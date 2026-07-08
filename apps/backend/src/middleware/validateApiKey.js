// src/middleware/validateApiKey.js
import crypto from 'crypto';
import logger from '../logging/logger.js';
import { authenticateByApiKeyGlobal } from '../services/auth/apiClientService.js';

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Per-client API key registry.
 * Supports multiple keys via environment variables:
 *   API_KEY           — primary/shared key (backwards compatible)
 *   API_KEY_PATIENT   — patient Flutter app
 *   API_KEY_STAFF     — staff Flutter app
 *   API_KEY_ADMIN     — admin portal
 *
 * If per-client keys are set, they take precedence. The shared API_KEY still works
 * as a fallback for backwards compatibility.
 */
function buildKeyRegistry() {
  const registry = [];

  // Per-client keys (preferred)
  if (process.env.API_KEY_PATIENT) registry.push({ key: process.env.API_KEY_PATIENT, client: 'patient' });
  if (process.env.API_KEY_STAFF) registry.push({ key: process.env.API_KEY_STAFF, client: 'staff' });
  if (process.env.API_KEY_ADMIN) registry.push({ key: process.env.API_KEY_ADMIN, client: 'admin' });

  // Shared key (backwards compatible fallback)
  if (process.env.API_KEY) registry.push({ key: process.env.API_KEY, client: 'shared' });

  return registry;
}

const keyRegistry = buildKeyRegistry();

/**
 * Middleware to validate the API Key sent in request headers.
 *
 * W3 (multi-tenancy): a DB-backed per-tenant key (api_keys table) is tried
 * FIRST — the key itself identifies the api_client + tenant, so a hit also
 * stamps req.tenantId. Falls back to the env-var registry (shared / per-client
 * keys) so the existing single-tenant deployment is unchanged. Sets req.apiClient
 * to the matched client_code (DB) or registry client name ('patient'/'staff'/
 * 'admin'/'shared').
 */
export default async function validateApiKey(req, res, next) {
  const clientApiKey = req.headers['x-api-key'];

  if (!clientApiKey) {
    return res.status(401).json({ error: 'Missing API Key in request headers' });
  }

  // 1) DB-backed per-tenant key (global lookup on the unique key_hash). A DB
  //    error must never block auth — fall through to the env registry.
  try {
    const dbClient = await authenticateByApiKeyGlobal({
      plaintext: clientApiKey,
      ipAddress: req.ip,
    });
    if (dbClient) {
      req.apiClient = dbClient.client_code;
      req.apiClientId = dbClient.api_client_id;
      req.apiClientEnvironment = dbClient.environment;
      req.apiClientScopes = Array.isArray(dbClient.scopes) ? dbClient.scopes : [];
      req.tenantId = dbClient.tenant_id;
      return next();
    }
  } catch (err) {
    logger.error('validateApiKey DB lookup failed; falling back to env registry', { error: err.message });
  }

  // 2) Env-var registry fallback (shared / default-tenant keys).
  if (keyRegistry.length === 0) {
    logger.error('Server misconfiguration: no API keys configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Check against all registered keys (timing-safe comparison for each)
  const matched = keyRegistry.find(entry => constantTimeCompare(clientApiKey, entry.key));

  if (!matched) {
    logger.warn('Invalid API Key provided');
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // Attach client identifier for audit logging and role-scoped rate limiting
  req.apiClient = matched.client;
  next();
}
