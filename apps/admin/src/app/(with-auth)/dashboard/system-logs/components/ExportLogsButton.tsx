// src/app/(with-auth)/dashboard/system-logs/components/ExportLogsButton.tsx
"use client";

import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { buildCsv, type CsvColumn } from "@/lib/exportToCsv";
import toast from "react-hot-toast";
import { CloudDownload } from "lucide-react";

interface ExportLogsButtonProps {
  logType: "audit" | "system";
  queryParams: URLSearchParams;
}

type CsvResponse = { csv: string };
type LogsResponse = { logs: unknown[] };

function hasCsv(x: unknown): x is CsvResponse {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).csv === "string"
  );
}

function hasLogs(x: unknown): x is LogsResponse {
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray((x as Record<string, unknown>).logs)
  );
}

export function ExportLogsButton({
  logType,
  queryParams,
}: ExportLogsButtonProps) {
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: "json" | "csv") => {
    try {
      setExporting(true);
      const endpoint =
        logType === "audit" ? "/logs/audit/export" : "/logs/system/export";

      const exportParams = new URLSearchParams(queryParams);
      exportParams.set("format", format);

      // Fetch as unknown and narrow below
      const response = await fetchAdminAPI<unknown>(
        `${endpoint}?${exportParams.toString()}`,
      );

      let blob: Blob;
      let filename: string;

      if (format === "json") {
        blob = new Blob([JSON.stringify(response, null, 2)], {
          type: "application/json",
        });
        filename = `${logType}_logs_${new Date().toISOString().split("T")[0]}.json`;
      } else {
        // CSV: use server CSV if provided, else derive from logs/array/object
        let csvContent = "";
        if (typeof response === "string") {
          csvContent = response;
        } else if (hasCsv(response)) {
          csvContent = response.csv;
        } else if (hasLogs(response)) {
          csvContent = convertToCSV(response.logs);
        } else if (Array.isArray(response)) {
          csvContent = convertToCSV(response as unknown[]);
        } else if (response && typeof response === "object") {
          csvContent = convertToCSV([response]);
        } else {
          csvContent = "";
        }

        blob = new Blob([csvContent], { type: "text/csv" });
        filename = `${logType}_logs_${new Date().toISOString().split("T")[0]}.csv`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Failed to export logs. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  // Convert an array of unknowns to CSV by best-effort flattening of keys,
  // routed through the shared buildCsv helper so every field gets the
  // formula-injection guard (a leading =,+,-,@,tab,CR is prefixed with a quote)
  // plus RFC-4180 quoting. Audit/system-log rows carry attacker-influenceable
  // fields (ip_address, user_agent, action/detail strings), so a crafted value
  // like `=WEBSERVICE(...)` must not execute when the CSV is opened in a
  // spreadsheet. (The local builder this replaced quote-wrapped but never
  // formula-escaped — same class as the report-builder / UsersTable fixes.)
  const convertToCSV = (rows: unknown[]) => {
    if (!Array.isArray(rows) || rows.length === 0) return "";

    const objects = rows.map((r) =>
      r && typeof r === "object"
        ? (r as Record<string, unknown>)
        : { value: r },
    );
    const headerSet = new Set<string>();
    objects.forEach((o) => Object.keys(o).forEach((k) => headerSet.add(k)));
    const headers = Array.from(headerSet);

    // Dynamically-keyed rows → derive columns from the union of keys. Cell
    // value logic mirrors the previous behaviour exactly (objects are
    // JSON-stringified, null/undefined collapse to ""); only the escaping moves
    // to escapeCsvField (via buildCsv).
    const columns: CsvColumn<Record<string, unknown>>[] = headers.map((key) => ({
      header: key,
      accessor: (row) => {
        const v = row[key];
        return typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      },
    }));

    return buildCsv(columns, objects);
  };

  return (
    <div className="relative inline-block text-left">
      <div>
        <button
          type="button"
          onClick={() => handleExport("json")} // quick default action; hook up a dropdown if needed
          className="inline-flex justify-center items-center gap-2 px-4 py-2 bg-muted text-foreground rounded-md hover:bg-muted transition-colors"
          disabled={exporting}
        >
          {exporting ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-input" />
              Exporting...
            </>
          ) : (
            <>
              <CloudDownload className="w-5 h-5" />
              Export
            </>
          )}
        </button>
      </div>

      {/* Example dropdown wiring (hidden by default) */}
      <div className="hidden origin-top-right absolute right-0 mt-2 w-40 rounded-md shadow-lg bg-card ring-1 ring-black ring-opacity-5">
        <div className="py-1" role="menu">
          <button
            onClick={() => handleExport("json")}
            className="block w-full text-left px-4 py-2 text-sm text-foreground hover:bg-muted"
            role="menuitem"
          >
            Export as JSON
          </button>
          <button
            onClick={() => handleExport("csv")}
            className="block w-full text-left px-4 py-2 text-sm text-foreground hover:bg-muted"
            role="menuitem"
          >
            Export as CSV
          </button>
        </div>
      </div>
    </div>
  );
}
