// Shared types for the BI Dashboards page (god-page split per admin CLAUDE.md).

export interface DashboardEntry {
  key: string;
  title: string;
  description: string;
  available: boolean;
  status: "active" | "held" | "deprecated";
  certificationStatus: string;
  datasetKeys: string[];
  requiredParams: string[];
  embedRoles: string[];
  ownerRole: string;
  displayOrder: number;
}

export interface DatasetField {
  fieldName: string;
  displayLabel: string;
  semanticType: string;
  phiClass: string;
  hiddenByDefault: boolean;
  allowedFilter: boolean;
  backendDrilldownOnly: boolean;
  description: string;
}

export interface DatasetEntry {
  key: string;
  displayName: string;
  dbtRelation: string;
  grain: string;
  refreshCadence: string;
  sourceDomain: string;
  ownerRole: string;
  certificationStatus: string;
  tenantBoundaryMode: string;
  phiClass: string;
  minCellThreshold: number;
  allowedRoles: string[];
  exportPolicy: string;
  description: string;
  hiddenFieldCount: number;
  backendDrilldownFieldCount: number;
  fields: DatasetField[];
}

// Three-layer embed gate summary from GET /dashboards/catalog: env
// (METABASE_URL + METABASE_EMBED_SECRET on the backend) AND the per-tenant
// settings.analyticsBi.enabled flag. Optional so an older backend (no gate
// field yet) keeps today's behavior.
export interface AnalyticsBiGate {
  envConfigured: boolean;
  tenantEnabled: boolean;
  effective: boolean;
}

export interface CatalogResponse {
  datasets: DatasetEntry[];
  dashboards: DashboardEntry[];
  analyticsBi?: AnalyticsBiGate;
}
