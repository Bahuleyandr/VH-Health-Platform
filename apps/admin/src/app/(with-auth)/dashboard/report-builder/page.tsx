// src/app/(with-auth)/dashboard/report-builder/page.tsx
"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { exportToCsv, type CsvColumn } from "@/lib/exportToCsv";
import { Spinner } from "@/components/ui/spinner";
import {
  DownloadIcon,
  RefreshIcon,
  FileTextIcon,
  BarChartIcon,
} from "@/components/icons";
import { toast } from "react-hot-toast";

/* ========================================================================
 * Types
 * ======================================================================== */

type ReportType =
  | "users"
  | "appointments"
  | "attendance"
  | "pharmacy"
  | "investigations";

interface ReportTypeConfig {
  label: string;
  endpoint: string;
  responseKey: string;
  columns: ColumnDef[];
}

interface ColumnDef {
  key: string;
  label: string;
  /** Checked by default */
  defaultSelected: boolean;
}

/* ========================================================================
 * Report type configurations
 * ======================================================================== */

const REPORT_CONFIGS: Record<ReportType, ReportTypeConfig> = {
  users: {
    label: "Users",
    endpoint: "/admin/users",
    responseKey: "users",
    columns: [
      { key: "id", label: "ID", defaultSelected: true },
      { key: "name", label: "Name", defaultSelected: true },
      { key: "email", label: "Email", defaultSelected: true },
      { key: "phone", label: "Phone", defaultSelected: true },
      { key: "role", label: "Role", defaultSelected: true },
      { key: "gender", label: "Gender", defaultSelected: false },
      { key: "blood_group", label: "Blood Group", defaultSelected: false },
      { key: "date_of_birth", label: "Date of Birth", defaultSelected: false },
      { key: "address", label: "Address", defaultSelected: false },
      { key: "created_at", label: "Created At", defaultSelected: true },
      { key: "status", label: "Status", defaultSelected: true },
    ],
  },
  appointments: {
    label: "Appointments",
    endpoint: "/appointments/list",
    responseKey: "appointments",
    columns: [
      { key: "id", label: "ID", defaultSelected: true },
      { key: "patient_name", label: "Patient Name", defaultSelected: true },
      { key: "doctor_name", label: "Doctor Name", defaultSelected: true },
      { key: "department", label: "Department", defaultSelected: true },
      { key: "appointment_date", label: "Date", defaultSelected: true },
      { key: "time_slot", label: "Time Slot", defaultSelected: true },
      { key: "status", label: "Status", defaultSelected: true },
      { key: "type", label: "Type", defaultSelected: false },
      { key: "reason", label: "Reason", defaultSelected: false },
      { key: "notes", label: "Notes", defaultSelected: false },
      { key: "created_at", label: "Created At", defaultSelected: false },
    ],
  },
  attendance: {
    label: "Attendance",
    endpoint: "/attendance/admin/records",
    responseKey: "records",
    columns: [
      { key: "id", label: "ID", defaultSelected: true },
      { key: "user_id", label: "User ID", defaultSelected: true },
      { key: "user_name", label: "User Name", defaultSelected: true },
      { key: "date", label: "Date", defaultSelected: true },
      { key: "check_in", label: "Check In", defaultSelected: true },
      { key: "check_out", label: "Check Out", defaultSelected: true },
      { key: "status", label: "Status", defaultSelected: true },
      { key: "department", label: "Department", defaultSelected: false },
      { key: "shift", label: "Shift", defaultSelected: false },
      { key: "hours_worked", label: "Hours Worked", defaultSelected: false },
    ],
  },
  pharmacy: {
    label: "Pharmacy Orders",
    endpoint: "/pharmacy/admin/orders",
    responseKey: "orders",
    columns: [
      { key: "id", label: "Order ID", defaultSelected: true },
      { key: "patient_name", label: "Patient Name", defaultSelected: true },
      { key: "doctor_name", label: "Prescribed By", defaultSelected: true },
      { key: "medication", label: "Medication", defaultSelected: true },
      { key: "quantity", label: "Quantity", defaultSelected: true },
      { key: "status", label: "Status", defaultSelected: true },
      { key: "order_date", label: "Order Date", defaultSelected: true },
      { key: "total_amount", label: "Total Amount", defaultSelected: false },
      {
        key: "payment_status",
        label: "Payment Status",
        defaultSelected: false,
      },
      { key: "notes", label: "Notes", defaultSelected: false },
    ],
  },
  investigations: {
    label: "Investigations",
    endpoint: "/investigations/admin/list",
    responseKey: "investigations",
    columns: [
      { key: "id", label: "ID", defaultSelected: true },
      { key: "patient_name", label: "Patient Name", defaultSelected: true },
      { key: "doctor_name", label: "Ordered By", defaultSelected: true },
      { key: "test_name", label: "Test Name", defaultSelected: true },
      { key: "category", label: "Category", defaultSelected: true },
      { key: "status", label: "Status", defaultSelected: true },
      { key: "ordered_date", label: "Ordered Date", defaultSelected: true },
      { key: "result_date", label: "Result Date", defaultSelected: false },
      { key: "result", label: "Result", defaultSelected: false },
      { key: "priority", label: "Priority", defaultSelected: false },
    ],
  },
};

const REPORT_TYPE_OPTIONS: { value: ReportType; label: string }[] = [
  { value: "users", label: "Users" },
  { value: "appointments", label: "Appointments" },
  { value: "attendance", label: "Attendance" },
  { value: "pharmacy", label: "Pharmacy Orders" },
  { value: "investigations", label: "Investigations" },
];

/* ========================================================================
 * Helpers
 * ======================================================================== */

function today() {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().split("T")[0];
}

/** Safely read a cell value for display */
function cellValue(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (v === null || v === undefined) return "-";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/* ========================================================================
 * Page Component
 * ======================================================================== */

export default function ReportBuilderPage() {
  const [reportType, setReportType] = useState<ReportType>("users");
  const [dateFrom, setDateFrom] = useState(daysAgo(30));
  const [dateTo, setDateTo] = useState(today());
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(() => {
    const cfg = REPORT_CONFIGS.users;
    return new Set(
      cfg.columns.filter((c) => c.defaultSelected).map((c) => c.key),
    );
  });
  const [generateKey, setGenerateKey] = useState<string | null>(null);

  const config = REPORT_CONFIGS[reportType];

  // Reset selected columns when report type changes
  const handleReportTypeChange = useCallback((type: ReportType) => {
    setReportType(type);
    const cfg = REPORT_CONFIGS[type];
    setSelectedColumns(
      new Set(cfg.columns.filter((c) => c.defaultSelected).map((c) => c.key)),
    );
    setGenerateKey(null); // clear previous results
  }, []);

  const toggleColumn = useCallback((key: string) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const selectAllColumns = useCallback(() => {
    setSelectedColumns(new Set(config.columns.map((c) => c.key)));
  }, [config]);

  const deselectAllColumns = useCallback(() => {
    setSelectedColumns(new Set());
  }, []);

  // Build query params for the API call
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("startDate", dateFrom);
    if (dateTo) params.set("endDate", dateTo);
    params.set("limit", "500"); // reasonable max for report display
    return params.toString();
  }, [dateFrom, dateTo]);

  // TanStack Query — only runs when generateKey is set (user clicks Generate)
  const {
    data: reportData,
    isLoading,
    error,
    refetch,
  } = useQuery<Record<string, unknown>[]>({
    queryKey: ["report-builder", reportType, queryParams, generateKey],
    queryFn: async () => {
      const endpoint = `${config.endpoint}?${queryParams}`;
      const raw = await fetchAdminAPI<unknown>(endpoint);

      // Normalize: the response might be an array, or an object with a known key
      if (Array.isArray(raw)) return raw as Record<string, unknown>[];

      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        // Try the configured response key first
        if (Array.isArray(obj[config.responseKey])) {
          return obj[config.responseKey] as Record<string, unknown>[];
        }
        // Fall back to common keys
        for (const k of ["data", "items", "records", "results", "list"]) {
          if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
        }
      }

      return [];
    },
    enabled: generateKey !== null,
    staleTime: 60_000,
    retry: 1,
  });

  const handleGenerate = () => {
    if (selectedColumns.size === 0) {
      toast.error("Please select at least one column.");
      return;
    }
    setGenerateKey(`${reportType}-${Date.now()}`);
  };

  const handleExportCsv = () => {
    if (!reportData || reportData.length === 0) {
      toast.error("No data to export.");
      return;
    }
    const visibleCols = config.columns.filter((c) =>
      selectedColumns.has(c.key),
    );
    const csvColumns: CsvColumn<Record<string, unknown>>[] = visibleCols.map(
      (c) => ({
        header: c.label,
        accessor: (row) => cellValue(row, c.key),
      }),
    );
    const filename = `${reportType}-report-${dateFrom}-to-${dateTo}.csv`;
    exportToCsv({ filename, columns: csvColumns, rows: reportData });
    toast.success(`Exported ${reportData.length} rows to ${filename}`);
  };

  const visibleColumns = config.columns.filter((c) =>
    selectedColumns.has(c.key),
  );

  // Shared input classes matching project conventions
  const inputCls =
    "w-full px-3 py-2 border border-input rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary bg-card";
  const labelCls = "block text-sm font-medium text-foreground mb-1";

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold">Custom Report Builder</h1>
        <p className="text-muted-foreground mt-2">
          Build, preview, and export custom reports from hospital data
        </p>
      </div>

      {/* Configuration card */}
      <div className="bg-card rounded-lg border shadow-sm p-6 space-y-6">
        {/* Row 1: Report type + date range */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="rb-type" className={labelCls}>
              Report Type
            </label>
            <select
              id="rb-type"
              value={reportType}
              onChange={(e) =>
                handleReportTypeChange(e.target.value as ReportType)
              }
              className={inputCls}
            >
              {REPORT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="rb-from" className={labelCls}>
              From Date
            </label>
            <input
              id="rb-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="rb-to" className={labelCls}>
              To Date
            </label>
            <input
              id="rb-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {/* Row 2: Column selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className={labelCls}>Columns to Include</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAllColumns}
                className="text-xs text-primary hover:underline"
              >
                Select All
              </button>
              <span className="text-xs text-muted-foreground">|</span>
              <button
                type="button"
                onClick={deselectAllColumns}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Deselect All
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {config.columns.map((col) => (
              <label
                key={col.key}
                className="flex items-center gap-2 px-3 py-2 border border-input rounded-md text-sm cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="checkbox"
                  checked={selectedColumns.has(col.key)}
                  onChange={() => toggleColumn(col.key)}
                  className="rounded border-input text-primary focus:ring-primary"
                />
                <span className="truncate">{col.label}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {selectedColumns.size} of {config.columns.length} columns selected
          </p>
        </div>

        {/* Row 3: Actions */}
        <div className="flex flex-wrap gap-3 pt-2 border-t border-border">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isLoading || selectedColumns.size === 0}
            className="flex items-center gap-2 px-6 py-2 bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
          >
            {isLoading ? (
              <>
                <Spinner size="sm" />
                Generating...
              </>
            ) : (
              <>
                <BarChartIcon className="h-4 w-4" />
                Generate Report
              </>
            )}
          </button>

          {reportData && reportData.length > 0 && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors text-sm font-medium"
            >
              <DownloadIcon className="h-4 w-4" />
              Export CSV
            </button>
          )}

          {generateKey && (
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 border border-input rounded-md text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50"
            >
              <RefreshIcon className="h-4 w-4" />
              Refresh
            </button>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-4">
          <h3 className="font-semibold mb-1">Error Generating Report</h3>
          <p className="text-sm">
            {error instanceof Error
              ? error.message
              : "An unexpected error occurred"}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-2 px-4 py-2 bg-destructive text-white rounded text-sm hover:bg-destructive/90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Spinner />
        </div>
      )}

      {/* Results table */}
      {reportData && !isLoading && (
        <div className="bg-card rounded-lg border shadow-sm overflow-hidden">
          {/* Table header info */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <FileTextIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{config.label} Report</span>
              <span className="text-xs text-muted-foreground">
                ({reportData.length} {reportData.length === 1 ? "row" : "rows"})
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {dateFrom} to {dateTo}
            </span>
          </div>

          {reportData.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <FileTextIcon className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm">No data found for the selected filters.</p>
              <p className="text-xs mt-1">
                Try adjusting the date range or report type.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead>
                  <tr className="bg-muted/50">
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider w-12">
                      #
                    </th>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-card divide-y divide-border">
                  {reportData.map((row, idx) => (
                    <tr
                      key={(row.id as string | number) ?? idx}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {idx + 1}
                      </td>
                      {visibleColumns.map((col) => (
                        <td
                          key={col.key}
                          className="px-4 py-3 whitespace-nowrap text-sm"
                        >
                          {col.key === "status" ? (
                            <StatusBadge value={cellValue(row, col.key)} />
                          ) : (
                            <span className="truncate max-w-[200px] inline-block">
                              {cellValue(row, col.key)}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Prompt when nothing has been generated yet */}
      {!generateKey && !isLoading && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-8 text-center">
          <BarChartIcon className="h-10 w-10 mx-auto mb-3 text-primary/50" />
          <h3 className="text-lg font-medium text-primary mb-1">
            Configure Your Report
          </h3>
          <p className="text-sm text-primary/70 max-w-md mx-auto">
            Select a report type, choose the columns you want, set a date range,
            then click &quot;Generate Report&quot; to see results.
          </p>
        </div>
      )}
    </div>
  );
}

/* ========================================================================
 * Sub-components
 * ======================================================================== */

function StatusBadge({ value }: { value: string }) {
  const colorMap: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-700",
    COMPLETED: "bg-green-100 text-green-700",
    CONFIRMED: "bg-teal-100 text-teal-700",
    SCHEDULED: "bg-orange-100 text-orange-700",
    PENDING: "bg-yellow-100 text-yellow-700",
    INACTIVE: "bg-gray-100 text-gray-600",
    CANCELLED: "bg-red-100 text-red-700",
    NO_SHOW: "bg-gray-100 text-gray-600",
    DISPENSED: "bg-blue-100 text-blue-700",
    PROCESSING: "bg-purple-100 text-purple-700",
    PRESENT: "bg-green-100 text-green-700",
    ABSENT: "bg-red-100 text-red-700",
    LATE: "bg-orange-100 text-orange-700",
    ON_LEAVE: "bg-blue-100 text-blue-700",
  };

  const cls = colorMap[value.toUpperCase()] ?? "bg-blue-100 text-blue-700";

  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {value}
    </span>
  );
}
