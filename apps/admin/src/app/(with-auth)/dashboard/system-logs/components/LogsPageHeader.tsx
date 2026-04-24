// src/app/(with-auth)/dashboard/system-logs/components/LogsPageHeader.tsx
// Page header: title, auto-refresh toggle + interval dropdown, export
// button, and the keyboard-shortcut help trigger. Extracted from
// page.tsx in the god-split.

"use client";

import { CloudDownload } from "lucide-react";
import { KeyboardShortcuts } from "./KeyboardShortcuts";

interface Props {
  autoRefresh: boolean;
  refreshInterval: number;
  onAutoRefreshChange: (v: boolean) => void;
  onRefreshIntervalChange: (n: number) => void;
  onExport: () => void | Promise<void>;
}

export function LogsPageHeader({
  autoRefresh,
  refreshInterval,
  onAutoRefreshChange,
  onRefreshIntervalChange,
  onExport,
}: Props) {
  return (
    <div className="flex justify-between items-center mb-6">
      <h1 className="text-3xl font-bold text-foreground">
        System &amp; Audit Logs
      </h1>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => onAutoRefreshChange(e.target.checked)}
              className="h-4 w-4 text-primary rounded border-input"
            />
            <span className="ml-2 text-sm text-foreground">Auto-refresh</span>
          </label>
          {autoRefresh ? (
            <select
              value={refreshInterval}
              onChange={(e) =>
                onRefreshIntervalChange(parseInt(e.target.value, 10))
              }
              className="text-sm border border-input rounded px-2 py-1"
            >
              <option value="10">10s</option>
              <option value="30">30s</option>
              <option value="60">1m</option>
              <option value="300">5m</option>
            </select>
          ) : null}
        </div>

        <button
          onClick={onExport}
          className="px-4 py-2 bg-muted text-foreground rounded-md hover:bg-muted transition-colors flex items-center gap-2"
        >
          <CloudDownload className="w-5 h-5" />
          Export Logs
        </button>

        <KeyboardShortcuts />
      </div>
    </div>
  );
}
