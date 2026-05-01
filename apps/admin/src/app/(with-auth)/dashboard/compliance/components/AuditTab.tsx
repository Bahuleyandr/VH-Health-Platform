"use client";

/**
 * Audit log search tab. Self-contained query state.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

import type { AuditSearchResult } from "./types";
import { fmtDate, unwrap } from "./shared";

export function AuditTab() {
  const [query, setQuery] = useState("");

  const {
    data: results,
    isLoading,
    refetch,
  } = useQuery<AuditSearchResult[]>({
    queryKey: ["compliance-audit", query],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>(
        `/compliance/audit-search?q=${encodeURIComponent(query)}`,
      );
      return unwrap<AuditSearchResult[]>(res);
    },
    enabled: query.length > 0,
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search audit logs (user, action, resource)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") refetch();
            }}
            className="w-full rounded-md border border-border bg-card pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          onClick={() => refetch()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Search
        </button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}

      {results && results.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-2 opacity-40" />
          <p>No audit entries found for this query</p>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Timestamp</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Action</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">User</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Resource</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">IP</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {results.map((entry) => (
                <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtDate(entry.timestamp)}
                  </td>
                  <td className="px-4 py-3 font-medium">{entry.action}</td>
                  <td className="px-4 py-3 text-muted-foreground">{entry.user_id ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {entry.resource_type ? `${entry.resource_type}/${entry.resource_id}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.ip_address ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs truncate">
                    {entry.details ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default AuditTab;
