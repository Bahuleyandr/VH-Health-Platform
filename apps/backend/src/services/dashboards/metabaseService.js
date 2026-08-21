// src/services/dashboards/metabaseService.js
//
// Sprint 9 — signed-URL helper for embedding Metabase dashboards
// inside the admin portal. Metabase embedding flow:
//
//   1. Admin sets up an "embedded" dashboard in Metabase, gets back
//      a numeric dashboard id and public-key/private-key pair.
//   2. We hold the private key as METABASE_EMBED_SECRET env.
//   3. To embed, the backend signs a JWT containing
//        { resource: { dashboard: <id> }, params: {...}, exp }
//      with HS256 + the private key.
//   4. Front-end loads
//        <iframe src="<METABASE_URL>/embed/dashboard/<jwt>#bordered=false"></iframe>
//
// This keeps Metabase entirely server-side; the user never logs in
// to Metabase directly. params let us inject tenant/department/date
// scoping per-user without giving the user that authority in Metabase.

import jwt from 'jsonwebtoken';
import { AppError } from '../../utils/AppError.js';
import * as snapshotService from './snapshotService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getAnalyticsBiSettings } from '../tenant/tenantSettingsService.js';
import {
  getCuratedDashboard,
  listDashboardCatalog,
} from './analyticsCatalogService.js';

// Read at call time (not module load) so the env fail-closed gate is
// observable/testable in every process regardless of import order.
function metabaseUrl() {
  return process.env.METABASE_URL || '';
}

function metabaseEmbedSecret() {
  return process.env.METABASE_EMBED_SECRET || '';
}

/** Env layer of the analytics-BI gate: both embed env vars present. */
export function isMetabaseEnvConfigured() {
  return Boolean(metabaseUrl() && metabaseEmbedSecret());
}

/**
 * Three-layer gate resolution for embedded BI (house AND-of-layers rule):
 * env configured AND settings.analyticsBi.enabled. Per-dashboard
 * availability (METABASE_DASH_* id present) stays on the catalog rows.
 */
export async function getAnalyticsBiGate(tenantId) {
  const envConfigured = isMetabaseEnvConfigured();
  const settings = await getAnalyticsBiSettings(tenantId);
  const tenantEnabled = settings.enabled === true;
  return {
    envConfigured,
    tenantEnabled,
    effective: envConfigured && tenantEnabled,
  };
}

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const DEFAULT_EMBED_TTL_SECONDS = 600;
const MIN_EMBED_TTL_SECONDS = 60;
const MAX_EMBED_TTL_SECONDS = 86400;
const RESERVED_PARAM_KEYS = new Set(['tenant', 'tenantid']);

function normalizeParamKey(key) {
  return String(key).replace(/[-_]/g, '').toLowerCase();
}

function sanitizeEmbedParams(params) {
  if (params == null) return {};
  if (Array.isArray(params) || typeof params !== 'object') {
    throw AppError.badRequest('Metabase embed params must be an object', 'METABASE_PARAMS_INVALID');
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_PARAM_KEYS.has(normalizeParamKey(key))) {
      throw AppError.badRequest(
        'Tenant scope is server-managed for Metabase embeds',
        'METABASE_TENANT_PARAM_FORBIDDEN'
      );
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function clampTtlSeconds(ttlSeconds) {
  const parsed = Number.parseInt(ttlSeconds, 10);
  const seconds = Number.isFinite(parsed) ? parsed : DEFAULT_EMBED_TTL_SECONDS;
  return Math.max(MIN_EMBED_TTL_SECONDS, Math.min(MAX_EMBED_TTL_SECONDS, seconds));
}

export async function listDashboards({ role, tenantId } = {}) {
  // Gate off (env unconfigured OR tenant flag off) ⇒ every entry reports
  // unavailable — the same fail-closed posture buildEmbedUrl enforces.
  const gate = await getAnalyticsBiGate(tenantId);
  const dashboards = await listDashboardCatalog({ role, includeHeld: false });
  return dashboards.map((dashboard) => ({
    key: dashboard.key,
    title: dashboard.title,
    description: dashboard.description,
    available: dashboard.available && gate.effective,
    status: dashboard.status,
    certificationStatus: dashboard.certificationStatus,
    datasetKeys: dashboard.datasetKeys,
    embedRoles: dashboard.embedRoles,
    ownerRole: dashboard.ownerRole,
    requiredParams: dashboard.requiredParams,
  }));
}

/**
 * Signs an embed JWT and returns the iframe URL. params let us
 * lock the dashboard down per-user (tenant id, doctor id, etc.).
 */
export async function buildEmbedUrl({
  key,
  params = {},
  ttlSeconds = 600,
  tenantId = DEFAULT_TENANT,
  role,
}) {
  // Fail-closed order: env first (unconfigured deployment), then the
  // per-tenant settings.analyticsBi.enabled flag, then catalog/role checks.
  if (!isMetabaseEnvConfigured()) {
    throw AppError.badRequest('Metabase embedding is not configured (METABASE_URL + METABASE_EMBED_SECRET env required)');
  }
  const analyticsBi = await getAnalyticsBiSettings(tenantId);
  if (analyticsBi.enabled !== true) {
    throw AppError.forbidden(
      'Analytics embedding is not enabled for this hospital',
      'ANALYTICS_BI_TENANT_DISABLED',
    );
  }
  const dash = await getCuratedDashboard(key, { role });
  if (!dash.metabaseId) {
    throw AppError.badRequest(`Dashboard ${key} has no metabase_id configured`);
  }
  const resolvedTenantId = requireTenantId(tenantId);
  const sanitizedParams = sanitizeEmbedParams(params);
  const ttl = clampTtlSeconds(ttlSeconds);
  const payload = {
    resource: { dashboard: dash.metabaseId },
    params: {
      ...sanitizedParams,
      tenant_id: resolvedTenantId,
    },
    exp: Math.round(Date.now() / 1000) + ttl,
  };
  const token = jwt.sign(payload, metabaseEmbedSecret(), { algorithm: 'HS256' });
  const url = `${metabaseUrl().replace(/\/$/, '')}/embed/dashboard/${token}#bordered=false&titled=false`;
  return {
    key,
    title: dash.title,
    url,
    ttlSeconds: ttl,
    datasetKeys: dash.datasetKeys,
    certificationStatus: dash.certificationStatus,
  };
}

/**
 * Convenience for the daily-ops snapshot — the in-house BI views are
 * also queryable directly without Metabase, useful for the admin
 * portal's "today" widget without an iframe round-trip.
 */
export async function getDailyOpsSnapshot({ tenantId } = {}) {
  return snapshotService.getDailyOpsSnapshot({ tenantId });
}
