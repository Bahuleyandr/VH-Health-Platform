import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

export const ENTITLEMENT_FEATURE_KEYS = Object.freeze({
  clinicalEmergency: 'clinical.emergency',
  clinicalCore: 'clinical.core',
  mobilePatientPortal: 'mobile.patient_portal',
  mobileStaffWorkbench: 'mobile.staff_workbench',
  adminOperations: 'admin.operations',
  adminFeatureFlags: 'admin.feature_flags',
  developerApiClients: 'developer.api_clients',
  commercialBillingPackages: 'commercial.billing_packages'
});

const CATALOG_CACHE_MS = 5 * 60 * 1000;
const TENANT_CACHE_MS = 60 * 1000;
const DEFAULT_STATUS_FEATURES = new Set([
  ENTITLEMENT_FEATURE_KEYS.clinicalEmergency,
  ENTITLEMENT_FEATURE_KEYS.clinicalCore,
  ENTITLEMENT_FEATURE_KEYS.mobilePatientPortal,
  ENTITLEMENT_FEATURE_KEYS.mobileStaffWorkbench
]);
const HARD_BLOCK_CATEGORIES = new Set(['admin', 'developer', 'commercial']);
const STATUS_VALUES = new Set(['active', 'grace', 'expired', 'suspended', 'cancelled']);

let catalogCache = null;
let catalogFetchedAt = 0;
const tenantSummaryCache = new Map();

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function normalizeFeature(row) {
  return {
    featureKey: row.feature_key,
    displayName: row.display_name,
    description: row.description,
    category: row.category,
    enforcementMode: row.enforcement_mode,
    urgentClinical: row.urgent_clinical === true,
    routePatterns: parseJson(row.route_patterns, []),
    navSurfaces: parseJson(row.nav_surfaces, []),
    mobileSurfaceKeys: Array.isArray(row.mobile_surface_keys) ? row.mobile_surface_keys : [],
    metadata: parseJson(row.metadata, {})
  };
}

function normalizePackage(row, featureRows = []) {
  return {
    packageKey: row.package_key,
    displayName: row.display_name,
    description: row.description,
    packageTier: row.package_tier,
    status: row.status,
    gracePeriodDays: Number(row.grace_period_days ?? 0),
    metadata: parseJson(row.metadata, {}),
    features: featureRows
  };
}

function normalizePackageFeature(row) {
  return {
    packageKey: row.package_key,
    featureKey: row.feature_key,
    included: row.included === true,
    limits: parseJson(row.limits, {})
  };
}

function normalizeEntitlement(row) {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    packageKey: row.package_key,
    packageDisplayName: row.package_display_name,
    status: row.status,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    graceEndsAt: row.grace_ends_at,
    source: row.source,
    assignedBy: row.assigned_by,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeAuditEvent(row) {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    featureKey: row.feature_key,
    packageKey: row.package_key,
    action: row.action,
    decision: row.decision,
    enforcementMode: row.enforcement_mode,
    surface: row.surface,
    routePath: row.route_path,
    actorUid: row.actor_uid,
    actorRole: row.actor_role,
    requestId: row.request_id,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at
  };
}

function isDateAfter(date, now) {
  if (!date) return false;
  return new Date(date).getTime() > now.getTime();
}

function entitlementUsableState(row, now = new Date()) {
  if (!row) return null;
  if (row.status === 'active' && (!row.expiresAt || isDateAfter(row.expiresAt, now))) {
    return 'active';
  }
  if (
    (row.status === 'active' || row.status === 'grace') &&
    row.expiresAt &&
    isDateAfter(row.graceEndsAt, now)
  ) {
    return 'grace';
  }
  return null;
}

function buildPackageFeatureMap(packageFeatures) {
  const byPackage = new Map();
  const byFeature = new Map();
  for (const row of packageFeatures) {
    if (!row.included) continue;
    if (!byPackage.has(row.packageKey)) byPackage.set(row.packageKey, []);
    byPackage.get(row.packageKey).push(row);
    if (!byFeature.has(row.featureKey)) byFeature.set(row.featureKey, []);
    byFeature.get(row.featureKey).push(row);
  }
  return { byPackage, byFeature };
}

export async function getEntitlementCatalog({ refresh = false } = {}) {
  if (!refresh && catalogCache && Date.now() - catalogFetchedAt <= CATALOG_CACHE_MS) {
    return catalogCache;
  }

  const [featureRows, packageRows, packageFeatureRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT feature_key, display_name, description, category, enforcement_mode,
              urgent_clinical, route_patterns, nav_surfaces, mobile_surface_keys, metadata
         FROM product_features
        ORDER BY category, feature_key`
    ),
    prisma.$queryRawUnsafe(
      `SELECT package_key, display_name, description, package_tier, status,
              grace_period_days, metadata
         FROM product_packages
        WHERE status <> 'hidden'
        ORDER BY package_tier, package_key`
    ),
    prisma.$queryRawUnsafe(
      `SELECT package_key, feature_key, included, limits
         FROM product_package_features
        ORDER BY package_key, feature_key`
    )
  ]);

  const features = featureRows.map(normalizeFeature);
  const packageFeatures = packageFeatureRows.map(normalizePackageFeature);
  const featureByKey = new Map(features.map(feature => [feature.featureKey, feature]));
  const { byPackage, byFeature } = buildPackageFeatureMap(packageFeatures);
  const packages = packageRows.map(row => {
    const rows = byPackage.get(row.package_key) || [];
    return normalizePackage(
      row,
      rows.map(pf => ({
        ...pf,
        feature: featureByKey.get(pf.featureKey) || null
      }))
    );
  });

  catalogCache = {
    features,
    packages,
    packageFeatures,
    featureByKey,
    packagesByKey: new Map(packages.map(pkg => [pkg.packageKey, pkg])),
    packageFeaturesByFeature: byFeature,
    generatedAt: new Date().toISOString()
  };
  catalogFetchedAt = Date.now();
  return catalogCache;
}

async function getTenantEntitlementRows(tenantId) {
  if (!tenantId) return [];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT te.id, te.tenant_id, te.package_key, p.display_name AS package_display_name,
            te.status, te.starts_at, te.expires_at, te.grace_ends_at, te.source,
            te.assigned_by, te.metadata, te.created_at, te.updated_at
       FROM tenant_entitlements te
       JOIN product_packages p ON p.package_key = te.package_key
      WHERE te.tenant_id = $1::uuid
      ORDER BY te.created_at DESC`,
    tenantId
  );
  return rows.map(normalizeEntitlement);
}

function hardBlockFor(feature) {
  return feature.enforcementMode === 'hard_block' || HARD_BLOCK_CATEGORIES.has(feature.category);
}

function buildFeatureDecision({
  feature,
  entitlements,
  catalog,
  urgentClinical = false,
  now = new Date()
}) {
  const packageFeatureRows = catalog.packageFeaturesByFeature.get(feature.featureKey) || [];
  const entitlementByPackage = new Map(entitlements.map(row => [row.packageKey, row]));
  let matchedPackage = null;
  let matchedState = null;

  for (const packageFeature of packageFeatureRows) {
    const entitlement = entitlementByPackage.get(packageFeature.packageKey);
    const state = entitlementUsableState(entitlement, now);
    if (state) {
      matchedPackage = entitlement;
      matchedState = state;
      break;
    }
  }

  const urgent = urgentClinical === true || feature.urgentClinical === true;
  const hardBlock = hardBlockFor(feature);
  const fallbackAllowed = DEFAULT_STATUS_FEATURES.has(feature.featureKey) && !hardBlock;

  if (matchedState) {
    return {
      featureKey: feature.featureKey,
      allowed: true,
      entitled: true,
      hardBlock,
      decision: matchedState === 'grace' ? 'grace' : 'allow',
      status: matchedState,
      enforcementMode: feature.enforcementMode,
      packageKey: matchedPackage.packageKey,
      packageDisplayName: matchedPackage.packageDisplayName,
      urgentClinical: urgent,
      reason:
        matchedState === 'grace'
          ? 'Package entitlement is in grace period'
          : 'Package entitlement is active'
    };
  }

  if (urgent) {
    return {
      featureKey: feature.featureKey,
      allowed: true,
      entitled: false,
      hardBlock: false,
      decision: 'status_only',
      status: 'not_entitled',
      enforcementMode: 'status_only',
      packageKey: null,
      packageDisplayName: null,
      urgentClinical: true,
      reason: 'Urgent clinical care is visible and audited but never hard-blocked'
    };
  }

  if (
    fallbackAllowed ||
    feature.enforcementMode === 'status_only' ||
    feature.enforcementMode === 'audit_only'
  ) {
    return {
      featureKey: feature.featureKey,
      allowed: true,
      entitled: fallbackAllowed,
      hardBlock: false,
      decision: feature.enforcementMode === 'audit_only' ? 'audit_only' : 'status_only',
      status: fallbackAllowed ? 'default_visible' : 'not_entitled',
      enforcementMode: feature.enforcementMode,
      packageKey: null,
      packageDisplayName: null,
      urgentClinical: false,
      reason: fallbackAllowed
        ? 'Default-visible clinical or mobile capability'
        : 'Feature is informational when no entitlement is assigned'
    };
  }

  return {
    featureKey: feature.featureKey,
    allowed: false,
    entitled: false,
    hardBlock,
    decision: 'deny',
    status: 'not_entitled',
    enforcementMode: feature.enforcementMode,
    packageKey: null,
    packageDisplayName: null,
    urgentClinical: false,
    reason: 'Tenant does not have an active package for this feature'
  };
}

function summarizeSurfaces(features, decisions) {
  const nav = [];
  const mobile = [];
  for (const feature of features) {
    const decision = decisions.get(feature.featureKey);
    const visible = decision?.allowed === true;
    for (const surface of feature.navSurfaces) {
      nav.push({
        surface,
        featureKey: feature.featureKey,
        visible,
        status: decision?.status || 'unknown'
      });
    }
    for (const surface of feature.mobileSurfaceKeys) {
      mobile.push({
        surface,
        featureKey: feature.featureKey,
        visible: feature.urgentClinical === true || visible,
        status: decision?.status || 'unknown'
      });
    }
  }
  return { nav, mobile };
}

export async function getTenantEntitlementSummary(tenantId, { refresh = false } = {}) {
  const cacheKey = String(tenantId || 'none');
  const cached = tenantSummaryCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.fetchedAt <= TENANT_CACHE_MS) {
    return cached.value;
  }

  const catalog = await getEntitlementCatalog({ refresh });
  const entitlements = await getTenantEntitlementRows(tenantId);
  const decisions = new Map();
  for (const feature of catalog.features) {
    decisions.set(feature.featureKey, buildFeatureDecision({ feature, entitlements, catalog }));
  }

  const surfaces = summarizeSurfaces(catalog.features, decisions);
  const summary = {
    tenantId,
    generatedAt: new Date().toISOString(),
    packages: entitlements,
    catalog: {
      packages: catalog.packages,
      features: catalog.features
    },
    features: catalog.features.map(feature => ({
      ...feature,
      decision: decisions.get(feature.featureKey)
    })),
    nav: surfaces.nav,
    mobile: surfaces.mobile,
    invariants: {
      hardBlockCategories: Array.from(HARD_BLOCK_CATEGORIES),
      urgentClinicalPolicy: 'visible_status_audit_never_hard_block'
    }
  };

  tenantSummaryCache.set(cacheKey, { value: summary, fetchedAt: Date.now() });
  return summary;
}

export async function evaluateEntitlement({
  tenantId,
  featureKey,
  urgentClinical = false,
  actorUid = null,
  actorRole = null,
  surface = 'route',
  routePath = null,
  requestId = null,
  audit = false,
  metadata = {}
}) {
  const catalog = await getEntitlementCatalog();
  const feature = catalog.featureByKey.get(featureKey);
  if (!feature) {
    throw AppError.notFound(
      `Unknown entitlement feature: ${featureKey}`,
      'ENTITLEMENT_FEATURE_UNKNOWN'
    );
  }

  const entitlements = await getTenantEntitlementRows(tenantId);
  const decision = buildFeatureDecision({ feature, entitlements, catalog, urgentClinical });

  if (audit && tenantId) {
    await recordEntitlementAuditEvent({
      tenantId,
      featureKey,
      packageKey: decision.packageKey,
      action: decision.allowed ? 'ENTITLEMENT_ALLOW' : 'ENTITLEMENT_DENY',
      decision: decision.decision,
      enforcementMode: decision.enforcementMode,
      surface,
      routePath,
      actorUid,
      actorRole,
      requestId,
      metadata: {
        ...metadata,
        status: decision.status,
        reason: decision.reason,
        hardBlock: decision.hardBlock,
        urgentClinical: decision.urgentClinical
      }
    });
  }

  return decision;
}

export async function recordEntitlementAuditEvent({
  tenantId,
  featureKey = null,
  packageKey = null,
  action,
  decision,
  enforcementMode = null,
  surface = null,
  routePath = null,
  actorUid = null,
  actorRole = null,
  requestId = null,
  metadata = {}
}) {
  if (!tenantId) return null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO entitlement_audit_events
       (tenant_id, feature_key, package_key, action, decision, enforcement_mode,
        surface, route_path, actor_uid, actor_role, request_id, metadata, created_at)
     VALUES (
       $1::uuid, $2, $3, $4, $5, $6,
       $7, $8, $9::uuid, $10, $11, $12::jsonb, NOW()
     )`,
    tenantId,
    featureKey,
    packageKey,
    action,
    decision,
    enforcementMode,
    surface,
    routePath,
    actorUid,
    actorRole,
    requestId,
    JSON.stringify(metadata ?? {})
  );
  return true;
}

export async function upsertTenantEntitlement({
  tenantId,
  packageKey,
  status = 'active',
  expiresAt = null,
  graceEndsAt = null,
  source = 'manual',
  actorUid = null,
  actorRole = null,
  metadata = {}
}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  if (!packageKey) throw AppError.badRequest('packageKey is required', 'PACKAGE_KEY_REQUIRED');
  if (!STATUS_VALUES.has(status)) {
    throw AppError.badRequest('Invalid entitlement status', 'ENTITLEMENT_STATUS_INVALID');
  }

  const catalog = await getEntitlementCatalog();
  if (!catalog.packagesByKey.has(packageKey)) {
    throw AppError.badRequest('Unknown package key', 'PACKAGE_KEY_UNKNOWN');
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tenant_entitlements
       (tenant_id, package_key, status, expires_at, grace_ends_at, source,
        assigned_by, metadata, updated_at)
     VALUES (
       $1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6,
       $7::uuid, $8::jsonb, NOW()
     )
     ON CONFLICT (tenant_id, package_key) DO UPDATE SET
       status = EXCLUDED.status,
       expires_at = EXCLUDED.expires_at,
       grace_ends_at = EXCLUDED.grace_ends_at,
       source = EXCLUDED.source,
       assigned_by = EXCLUDED.assigned_by,
       metadata = tenant_entitlements.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, package_key, status, starts_at, expires_at,
               grace_ends_at, source, assigned_by, metadata, created_at, updated_at`,
    tenantId,
    packageKey,
    status,
    expiresAt,
    graceEndsAt,
    source,
    actorUid,
    JSON.stringify(metadata ?? {})
  );

  tenantSummaryCache.delete(String(tenantId));
  await recordEntitlementAuditEvent({
    tenantId,
    packageKey,
    action: 'TENANT_ENTITLEMENT_UPDATED',
    decision: status === 'active' || status === 'grace' ? 'allow' : 'deny',
    enforcementMode: 'hard_block',
    surface: 'admin',
    actorUid,
    actorRole,
    metadata: { status, source, expiresAt, graceEndsAt }
  });

  return normalizeEntitlement(rows[0]);
}

export async function listEntitlementAuditEvents(tenantId, { limit = 50 } = {}) {
  if (!tenantId) return [];
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, feature_key, package_key, action, decision,
            enforcement_mode, surface, route_path, actor_uid, actor_role,
            request_id, metadata, created_at
       FROM entitlement_audit_events
      WHERE tenant_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT $2::int`,
    tenantId,
    boundedLimit
  );
  return rows.map(normalizeAuditEvent);
}

export function _resetEntitlementCachesForTests() {
  catalogCache = null;
  catalogFetchedAt = 0;
  tenantSummaryCache.clear();
}

export default {
  getEntitlementCatalog,
  getTenantEntitlementSummary,
  evaluateEntitlement,
  recordEntitlementAuditEvent,
  upsertTenantEntitlement,
  listEntitlementAuditEvents
};
