"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  RefreshCw,
  Search,
  ShieldCheck,
  Table2,
} from "lucide-react";
import {
  getDatabaseOverview,
  getDatabaseTableRows,
  type DatabaseColumn,
  type DatabaseRowsResponse,
  type DatabaseTableSummary,
} from "@/lib/api/database";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-IN").format(value || 0);
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function tableSearchText(table: DatabaseTableSummary) {
  return `${table.name} ${table.columnCount} ${table.rowEstimate}`.toLowerCase();
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function ContractStatus({
  ok,
  passing,
  total,
}: {
  ok: boolean;
  passing: number;
  total: number;
}) {
  const Icon = ok ? CheckCircle2 : AlertCircle;
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {passing}/{total} contracts
    </div>
  );
}

function TableList({
  tables,
  selected,
  onSelect,
}: {
  tables: DatabaseTableSummary[];
  selected: string | null;
  onSelect: (table: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Table</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Rows</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Cols</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Size</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tables.map((table) => {
            const active = table.name === selected;
            return (
              <tr
                key={table.name}
                className={active ? "bg-primary/10" : "hover:bg-muted/40"}
              >
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onSelect(table.name)}
                    className="block max-w-[18rem] truncate text-left font-medium text-foreground hover:text-primary"
                    title={table.name}
                  >
                    {table.name}
                  </button>
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {formatNumber(table.rowEstimate)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {formatNumber(table.columnCount)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {formatBytes(table.totalBytes)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ColumnList({ columns }: { columns: DatabaseColumn[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Column</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Null</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Preview</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {columns.map((column) => (
            <tr key={column.name} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-medium text-foreground">{column.name}</td>
              <td className="px-3 py-2 text-muted-foreground">{column.dbType || column.dataType}</td>
              <td className="px-3 py-2 text-muted-foreground">{column.nullable ? "Yes" : "No"}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {column.redactedInPreview ? "Redacted" : "Visible"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowsPreview({ data }: { data: DatabaseRowsResponse }) {
  const columns = data.table.columns.map((column) => column.name);

  if (data.rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
        No rows in this table.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-md border border-border">
      <table className="min-w-full text-xs">
        <thead className="bg-muted/60">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-3 py-2 text-left font-medium text-muted-foreground">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.rows.map((row, index) => (
            <tr key={index} className="hover:bg-muted/30">
              {columns.map((column) => (
                <td
                  key={column}
                  className="max-w-[24rem] truncate px-3 py-2 font-mono text-[11px] text-foreground"
                  title={formatCell(row[column])}
                >
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DatabasePage() {
  const [search, setSearch] = useState("");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["database-overview"],
    queryFn: getDatabaseOverview,
    staleTime: 30_000,
  });

  const filteredTables = useMemo(() => {
    const term = search.trim().toLowerCase();
    const tables = overviewQuery.data?.tables ?? [];
    if (!term) return tables;
    return tables.filter((table) => tableSearchText(table).includes(term));
  }, [overviewQuery.data?.tables, search]);

  useEffect(() => {
    if (selectedTable) return;
    const firstTable = overviewQuery.data?.tables[0]?.name;
    if (firstTable) setSelectedTable(firstTable);
  }, [overviewQuery.data?.tables, selectedTable]);

  const rowsQuery = useQuery({
    queryKey: ["database-table-rows", selectedTable],
    queryFn: () => getDatabaseTableRows(selectedTable as string, { limit: 50 }),
    enabled: Boolean(selectedTable),
    staleTime: 15_000,
  });

  const refreshAll = () => {
    void overviewQuery.refetch();
    void rowsQuery.refetch();
  };

  const overview = overviewQuery.data;
  const contractTotals = overview?.contracts.totals;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Database className="h-6 w-6" aria-hidden="true" />
            Database
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Read-only
            </span>
            {contractTotals ? (
              <ContractStatus
                ok={Boolean(overview?.contracts.ok)}
                passing={contractTotals.passing}
                total={contractTotals.contracts}
              />
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      {overviewQuery.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "Failed to load database overview"}
        </div>
      ) : null}

      {overview ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Tables" value={formatNumber(overview.summary.tableCount)} />
          <Stat label="Estimated Rows" value={formatNumber(overview.summary.rowEstimate)} />
          <Stat label="Total Size" value={formatBytes(overview.summary.totalBytes)} />
          <Stat label="Contract Failures" value={formatNumber(overview.summary.failingContracts)} />
        </div>
      ) : null}

      {overview?.contracts.failures.length ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            Schema contract failures
          </div>
          <ul className="space-y-1 text-sm text-destructive">
            {overview.contracts.failures.map((failure) => (
              <li key={`${failure.contract}-${failure.message}`}>
                {failure.contract}: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(22rem,32rem)_1fr]">
        <section className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tables"
              className="w-full rounded-md border border-border bg-card py-2 pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {overviewQuery.isLoading ? (
            <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading tables...
            </div>
          ) : (
            <TableList
              tables={filteredTables}
              selected={selectedTable}
              onSelect={setSelectedTable}
            />
          )}
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Table2 className="h-5 w-5" aria-hidden="true" />
                {selectedTable ?? "Select a table"}
              </h2>
              {rowsQuery.data ? (
                <p className="text-sm text-muted-foreground">
                  {formatNumber(rowsQuery.data.table.rowCount)} rows,
                  {" "}
                  {formatNumber(rowsQuery.data.table.columns.length)} columns
                </p>
              ) : null}
            </div>
            {rowsQuery.data?.table.primaryKeyColumns.length ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                PK: {rowsQuery.data.table.primaryKeyColumns.join(", ")}
              </div>
            ) : null}
          </div>

          {rowsQuery.isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {rowsQuery.error instanceof Error ? rowsQuery.error.message : "Failed to load rows"}
            </div>
          ) : null}

          {rowsQuery.isLoading ? (
            <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading rows...
            </div>
          ) : rowsQuery.data ? (
            <>
              <ColumnList columns={rowsQuery.data.table.columns} />
              <RowsPreview data={rowsQuery.data} />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
