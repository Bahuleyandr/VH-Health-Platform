import { getJSON } from "./core";

export interface DatabaseTableSummary {
  name: string;
  rowEstimate: number;
  totalBytes: number;
  tableBytes: number;
  columnCount: number;
}

export interface DatabaseContractSummary {
  id: string;
  label: string;
  ok: boolean;
}

export interface DatabaseOverview {
  summary: {
    tableCount: number;
    rowEstimate: number;
    totalBytes: number;
    contractStatus: "passing" | "failing";
    failingContracts: number;
  };
  tables: DatabaseTableSummary[];
  contracts: {
    ok: boolean;
    checkedAt: string;
    totals: {
      contracts: number;
      passing: number;
      failing: number;
      failures: number;
    };
    failures: Array<{ contract: string; message: string }>;
    items: DatabaseContractSummary[];
  };
}

export interface DatabaseColumn {
  name: string;
  dataType: string;
  dbType: string;
  nullable: boolean;
  defaultValue: string | null;
  ordinalPosition: number;
  redactedInPreview: boolean;
}

export interface DatabaseTableDetail {
  name: string;
  rowCount: number;
  primaryKeyColumns: string[];
  columns: DatabaseColumn[];
  indexes: Array<{ name: string; definition: string }>;
  constraints: Array<{ name: string; type: string; definition: string }>;
}

export interface DatabaseRowsResponse {
  table: DatabaseTableDetail;
  pagination: {
    limit: number;
    offset: number;
    returned: number;
  };
  rows: Record<string, unknown>[];
}

export function getDatabaseOverview() {
  return getJSON<DatabaseOverview>("/api/v1/admin/database/overview");
}

export function getDatabaseTableRows(
  tableName: string,
  params: { limit?: number; offset?: number } = {},
) {
  return getJSON<DatabaseRowsResponse>(
    `/api/v1/admin/database/tables/${encodeURIComponent(tableName)}/rows`,
    params,
  );
}
