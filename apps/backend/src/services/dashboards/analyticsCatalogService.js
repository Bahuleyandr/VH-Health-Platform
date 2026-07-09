import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const DATASET_CATALOG_SQL = `
  SELECT
    dataset_key,
    display_name,
    dbt_relation,
    grain,
    refresh_cadence,
    source_domain,
    owner_role,
    certification_status,
    tenant_boundary_mode,
    phi_class,
    min_cell_threshold,
    allowed_roles,
    export_policy,
    deprecation_status,
    description
  FROM analytics_dataset_catalog
  WHERE deprecation_status = 'active'
  ORDER BY source_domain ASC, display_name ASC
`;

const DATASET_FIELDS_SQL = `
  SELECT
    dataset_key,
    field_name,
    display_label,
    semantic_type,
    aggregation_behavior,
    phi_class,
    hidden_by_default,
    allowed_filter,
    backend_drilldown_only,
    description
  FROM analytics_dataset_fields
  ORDER BY dataset_key ASC, hidden_by_default DESC, backend_drilldown_only DESC, field_name ASC
`;

const DASHBOARD_CATALOG_SQL = `
  SELECT
    dashboard_key,
    title,
    description,
    metabase_env_var,
    dataset_keys,
    required_params,
    embed_roles,
    owner_role,
    status,
    certification_status,
    last_certified_at,
    display_order
  FROM analytics_dashboard_catalog
`;

const LIST_DASHBOARDS_SQL = `
  ${DASHBOARD_CATALOG_SQL}
  ORDER BY display_order ASC, dashboard_key ASC
`;

const ACTIVE_DASHBOARD_BY_KEY_SQL = `
  ${DASHBOARD_CATALOG_SQL}
  WHERE dashboard_key = $1 AND status = 'active'
  LIMIT 1
`;

function envInt(name) {
  const raw = process.env[name];
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function arrayOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null) return [];
  return [value].filter(Boolean);
}

function roleOf(roleOrUser) {
  if (typeof roleOrUser === 'string') return roleOrUser.toUpperCase();
  return String(roleOrUser?.rawRole || roleOrUser?.role || '').toUpperCase();
}

function roleAllowed(roleOrUser, allowedRoles) {
  const role = roleOf(roleOrUser);
  if (!role) return false;
  if (role === 'SUPER_ADMIN') return true;
  return arrayOf(allowedRoles).map((r) => String(r).toUpperCase()).includes(role);
}

function mapField(row) {
  return {
    fieldName: row.field_name,
    displayLabel: row.display_label,
    semanticType: row.semantic_type,
    aggregationBehavior: row.aggregation_behavior,
    phiClass: row.phi_class,
    hiddenByDefault: Boolean(row.hidden_by_default),
    allowedFilter: Boolean(row.allowed_filter),
    backendDrilldownOnly: Boolean(row.backend_drilldown_only),
    description: row.description,
  };
}

function mapDataset(row, fieldsByDataset) {
  const fields = fieldsByDataset.get(row.dataset_key) || [];
  return {
    key: row.dataset_key,
    displayName: row.display_name,
    dbtRelation: row.dbt_relation,
    grain: row.grain,
    refreshCadence: row.refresh_cadence,
    sourceDomain: row.source_domain,
    ownerRole: row.owner_role,
    certificationStatus: row.certification_status,
    tenantBoundaryMode: row.tenant_boundary_mode,
    phiClass: row.phi_class,
    minCellThreshold: Number(row.min_cell_threshold),
    allowedRoles: arrayOf(row.allowed_roles),
    exportPolicy: row.export_policy,
    deprecationStatus: row.deprecation_status,
    description: row.description,
    hiddenFieldCount: fields.filter((field) => field.hiddenByDefault).length,
    backendDrilldownFieldCount: fields.filter((field) => field.backendDrilldownOnly).length,
    fields,
  };
}

function mapDashboard(row) {
  const metabaseId = envInt(row.metabase_env_var);
  return {
    key: row.dashboard_key,
    title: row.title,
    description: row.description,
    metabaseEnvVar: row.metabase_env_var,
    metabaseId,
    available: row.status === 'active' && metabaseId > 0,
    datasetKeys: arrayOf(row.dataset_keys),
    requiredParams: arrayOf(row.required_params),
    embedRoles: arrayOf(row.embed_roles),
    ownerRole: row.owner_role,
    status: row.status,
    certificationStatus: row.certification_status,
    lastCertifiedAt: row.last_certified_at instanceof Date
      ? row.last_certified_at.toISOString().slice(0, 10)
      : row.last_certified_at,
    displayOrder: Number(row.display_order),
  };
}

export async function listDatasetCatalog() {
  const [datasets, fields] = await Promise.all([
    prisma.$queryRawUnsafe(DATASET_CATALOG_SQL),
    prisma.$queryRawUnsafe(DATASET_FIELDS_SQL),
  ]);
  const fieldsByDataset = new Map();
  for (const row of fields) {
    const list = fieldsByDataset.get(row.dataset_key) || [];
    list.push(mapField(row));
    fieldsByDataset.set(row.dataset_key, list);
  }
  return datasets.map((row) => mapDataset(row, fieldsByDataset));
}

export async function listDashboardCatalog({ role, includeHeld = true } = {}) {
  const dashboards = (await prisma.$queryRawUnsafe(LIST_DASHBOARDS_SQL)).map(mapDashboard);
  return dashboards
    .filter((dashboard) => includeHeld || dashboard.status === 'active')
    .filter((dashboard) => !role || roleAllowed(role, dashboard.embedRoles));
}

export async function getCuratedDashboard(key, { role } = {}) {
  const rows = await prisma.$queryRawUnsafe(ACTIVE_DASHBOARD_BY_KEY_SQL, key);
  const dashboard = rows[0] ? mapDashboard(rows[0]) : null;
  if (!dashboard) {
    throw AppError.notFound(`Unknown dashboard ${key}`, 'DASHBOARD_NOT_FOUND');
  }
  if (role && !roleAllowed(role, dashboard.embedRoles)) {
    throw AppError.forbidden('Dashboard is not available for this role', 'DASHBOARD_ROLE_FORBIDDEN');
  }
  return dashboard;
}

export function canAccessDashboard(roleOrUser, dashboard) {
  return roleAllowed(roleOrUser, dashboard?.embedRoles);
}
