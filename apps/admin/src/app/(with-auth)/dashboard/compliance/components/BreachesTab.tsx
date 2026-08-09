"use client";

/**
 * Breach notifications tab. Self-contained: own search state, own
 * detail-panel state, own queries + mutations. The "Report Breach"
 * toggle and form live here too — the parent page only owns
 * tab-switching state.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

import type { BreachNotification, ReportBreachPayload } from "./types";
import { fmtDate, SEVERITY_STYLES, STATUS_STYLES, StatCard, unwrap } from "./shared";

export function BreachesTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [selectedBreach, setSelectedBreach] = useState<BreachNotification | null>(null);
  const [newBreach, setNewBreach] = useState<ReportBreachPayload>({
    title: "",
    description: "",
    severity: "medium",
    affected_individuals: 0,
    phi_involved: false,
  });

  const {
    data: breaches,
    isLoading,
    isError,
    error: queryError,
    refetch,
  } = useQuery<BreachNotification[]>({
    queryKey: ["compliance-breaches"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/compliance/breaches");
      return unwrap<BreachNotification[]>(res);
    },
  });

  const reportMutation = useMutation({
    mutationFn: (payload: ReportBreachPayload) =>
      fetchAdminAPI("/compliance/breach/report", {
        method: "POST",
        body: {
          title: payload.title,
          description: payload.description,
          severity: payload.severity,
          affected_records: payload.affected_individuals,
          phi_involved: payload.phi_involved,
        },
      }),
    onSuccess: () => {
      toast.success("Breach reported successfully");
      queryClient.invalidateQueries({ queryKey: ["compliance-breaches"] });
      queryClient.invalidateQueries({ queryKey: ["compliance-dashboard"] });
      setShowReport(false);
      setNewBreach({ title: "", description: "", severity: "medium", affected_individuals: 0, phi_involved: false });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to report breach"),
  });

  const filtered = (breaches ?? []).filter(
    (b) =>
      b.title.toLowerCase().includes(search.toLowerCase()) ||
      b.description.toLowerCase().includes(search.toLowerCase()) ||
      b.status.toLowerCase().includes(search.toLowerCase()),
  );

  const stats = {
    total: breaches?.length ?? 0,
    critical: breaches?.filter((b) => b.severity === "critical").length ?? 0,
    open: breaches?.filter((b) => !["resolved", "closed"].includes(b.status)).length ?? 0,
    resolved: breaches?.filter((b) => b.status === "resolved").length ?? 0,
  };

  return (
    <div className="space-y-4">
      {/* Toolbar — refresh + report */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
        <button
          onClick={() => setShowReport((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
        >
          <Plus className="h-4 w-4" /> {showReport ? "Cancel" : "Report Breach"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Breaches" value={stats.total} />
        <StatCard label="Critical" value={stats.critical} emphasis="danger" />
        <StatCard label="Open" value={stats.open} emphasis="warn" />
        <StatCard label="Resolved" value={stats.resolved} emphasis="ok" />
      </div>

      {/* Report form */}
      {showReport && (
        <div className="border border-border rounded-lg bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            Report New Breach
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Title</label>
              <input
                type="text"
                value={newBreach.title}
                onChange={(e) => setNewBreach({ ...newBreach, title: e.target.value })}
                placeholder="Brief description of the breach"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Severity</label>
              <select
                value={newBreach.severity}
                onChange={(e) => setNewBreach({ ...newBreach, severity: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Description</label>
            <textarea
              value={newBreach.description}
              onChange={(e) => setNewBreach({ ...newBreach, description: e.target.value })}
              placeholder="Detailed description of what happened..."
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Affected Individuals
              </label>
              <input
                type="number"
                value={newBreach.affected_individuals}
                onChange={(e) =>
                  setNewBreach({ ...newBreach, affected_individuals: parseInt(e.target.value) || 0 })
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                id="phi-involved"
                checked={newBreach.phi_involved}
                onChange={(e) => setNewBreach({ ...newBreach, phi_involved: e.target.checked })}
                className="rounded border-border"
              />
              <label htmlFor="phi-involved" className="text-sm">
                PHI (Protected Health Information) involved
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => reportMutation.mutate(newBreach)}
              disabled={
                !newBreach.title.trim() || !newBreach.description.trim() || reportMutation.isPending
              }
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {reportMutation.isPending ? "Reporting..." : "Submit Report"}
            </button>
            <button
              onClick={() => setShowReport(false)}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search breaches..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-border bg-card pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {queryError instanceof Error ? queryError.message : "Failed to load breaches"}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No breach notifications</p>
          <p className="text-sm mt-1">All clear - no breaches reported</p>
        </div>
      )}

      {selectedBreach && (
        <div className="border border-border rounded-lg bg-card p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">{selectedBreach.title}</h3>
            <button
              onClick={() => setSelectedBreach(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <p className="text-sm text-muted-foreground">{selectedBreach.description}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Severity:</span>{" "}
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  SEVERITY_STYLES[selectedBreach.severity] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {selectedBreach.severity}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  STATUS_STYLES[selectedBreach.status] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {selectedBreach.status}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Affected:</span>{" "}
              {selectedBreach.affected_individuals ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">PHI:</span>{" "}
              {selectedBreach.phi_involved ? "Yes" : "No"}
            </div>
          </div>
          {selectedBreach.resolution && (
            <div className="text-sm">
              <span className="text-muted-foreground">Resolution:</span> {selectedBreach.resolution}
            </div>
          )}
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Title</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Severity</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Affected</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((breach, idx) => (
                <tr key={breach.id ?? idx} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-medium">{breach.title}</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        SEVERITY_STYLES[breach.severity] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {breach.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        STATUS_STYLES[breach.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {breach.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">{breach.affected_individuals ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {fmtDate(breach.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedBreach(breach)}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </button>
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

export default BreachesTab;
