"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldAlert,
  Plus,
  Search,
  RefreshCw,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BreachNotification {
  id?: number;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "reported" | "investigating" | "contained" | "resolved" | "closed";
  affected_individuals?: number;
  breach_date?: string;
  discovered_date?: string;
  reported_by?: string;
  phi_involved?: boolean;
  notification_sent?: boolean;
  resolution?: string;
  created_at?: string;
  updated_at?: string;
}

interface AuditSearchResult {
  id: number;
  action: string;
  user_id?: string;
  resource_type?: string;
  resource_id?: string;
  ip_address?: string;
  details?: string;
  timestamp: string;
}

interface ReportBreachPayload {
  title: string;
  description: string;
  severity: string;
  affected_individuals?: number;
  phi_involved?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

function fmtDate(d?: string | null) {
  if (!d) return "\u2014";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d;
  }
}

const SEVERITY_STYLES: Record<string, string> = {
  low: "bg-green-100 text-green-800",
  medium: "bg-yellow-100 text-yellow-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

const STATUS_STYLES: Record<string, string> = {
  reported: "bg-blue-100 text-blue-800",
  investigating: "bg-yellow-100 text-yellow-800",
  contained: "bg-orange-100 text-orange-800",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-600",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CompliancePage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"breaches" | "audit">("breaches");
  const [search, setSearch] = useState("");
  const [auditQuery, setAuditQuery] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [selectedBreach, setSelectedBreach] = useState<BreachNotification | null>(null);
  const [newBreach, setNewBreach] = useState<ReportBreachPayload>({
    title: "",
    description: "",
    severity: "medium",
    affected_individuals: 0,
    phi_involved: false,
  });

  // Fetch breaches
  const {
    data: breaches,
    isLoading: breachesLoading,
    isError: breachesError,
    error: breachError,
    refetch: refetchBreaches,
  } = useQuery<BreachNotification[]>({
    queryKey: ["compliance-breaches"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/compliance/breaches");
      return unwrap<BreachNotification[]>(res);
    },
  });

  // Search audit logs
  const {
    data: auditResults,
    isLoading: auditLoading,
    refetch: searchAudit,
  } = useQuery<AuditSearchResult[]>({
    queryKey: ["compliance-audit", auditQuery],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>(
        `/compliance/audit-search?q=${encodeURIComponent(auditQuery)}`,
      );
      return unwrap<AuditSearchResult[]>(res);
    },
    enabled: activeTab === "audit" && auditQuery.length > 0,
  });

  // Report breach mutation
  const reportMutation = useMutation({
    mutationFn: (payload: ReportBreachPayload) =>
      fetchAdminAPI("/compliance/breaches", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      toast.success("Breach reported successfully");
      queryClient.invalidateQueries({ queryKey: ["compliance-breaches"] });
      setShowReport(false);
      setNewBreach({ title: "", description: "", severity: "medium", affected_individuals: 0, phi_involved: false });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to report breach"),
  });

  const filteredBreaches = (breaches ?? []).filter(
    (b) =>
      b.title.toLowerCase().includes(search.toLowerCase()) ||
      b.description.toLowerCase().includes(search.toLowerCase()) ||
      b.status.toLowerCase().includes(search.toLowerCase()),
  );

  // Stats from breach data
  const stats = {
    total: breaches?.length ?? 0,
    critical: breaches?.filter((b) => b.severity === "critical").length ?? 0,
    open: breaches?.filter((b) => !["resolved", "closed"].includes(b.status)).length ?? 0,
    resolved: breaches?.filter((b) => b.status === "resolved").length ?? 0,
  };

  const tabs = [
    { key: "breaches" as const, label: "Breach Notifications", icon: ShieldAlert },
    { key: "audit" as const, label: "Audit Log Search", icon: FileText },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" />
            Compliance &amp; HIPAA
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Breach notification management and audit tracking
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetchBreaches()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setShowReport(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            <Plus className="h-4 w-4" /> Report Breach
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="border border-border rounded-lg bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Breaches</p>
          <p className="text-2xl font-bold">{stats.total}</p>
        </div>
        <div className="border border-red-200 rounded-lg bg-red-50 p-4">
          <p className="text-sm text-red-600">Critical</p>
          <p className="text-2xl font-bold text-red-700">{stats.critical}</p>
        </div>
        <div className="border border-yellow-200 rounded-lg bg-yellow-50 p-4">
          <p className="text-sm text-yellow-600">Open</p>
          <p className="text-2xl font-bold text-yellow-700">{stats.open}</p>
        </div>
        <div className="border border-green-200 rounded-lg bg-green-50 p-4">
          <p className="text-sm text-green-600">Resolved</p>
          <p className="text-2xl font-bold text-green-700">{stats.resolved}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Report Breach Form */}
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
              <label htmlFor="phi-involved" className="text-sm">PHI (Protected Health Information) involved</label>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => reportMutation.mutate(newBreach)}
              disabled={!newBreach.title.trim() || !newBreach.description.trim() || reportMutation.isPending}
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

      {/* Breaches Tab */}
      {activeTab === "breaches" && (
        <>
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

          {breachesLoading && (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-lg" />
              ))}
            </div>
          )}

          {breachesError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
              {breachError instanceof Error ? breachError.message : "Failed to load breaches"}
            </div>
          )}

          {!breachesLoading && filteredBreaches.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">No breach notifications</p>
              <p className="text-sm mt-1">All clear - no breaches reported</p>
            </div>
          )}

          {/* Breach Detail Modal */}
          {selectedBreach && (
            <div className="border border-border rounded-lg bg-card p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{selectedBreach.title}</h3>
                <button onClick={() => setSelectedBreach(null)} className="text-muted-foreground hover:text-foreground">
                  Close
                </button>
              </div>
              <p className="text-sm text-muted-foreground">{selectedBreach.description}</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Severity:</span>{" "}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${SEVERITY_STYLES[selectedBreach.severity] ?? ""}`}>
                    {selectedBreach.severity}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[selectedBreach.status] ?? ""}`}>
                    {selectedBreach.status}
                  </span>
                </div>
                <div><span className="text-muted-foreground">Affected:</span> {selectedBreach.affected_individuals ?? "\u2014"}</div>
                <div><span className="text-muted-foreground">PHI:</span> {selectedBreach.phi_involved ? "Yes" : "No"}</div>
              </div>
              {selectedBreach.resolution && (
                <div className="text-sm"><span className="text-muted-foreground">Resolution:</span> {selectedBreach.resolution}</div>
              )}
            </div>
          )}

          {!breachesLoading && filteredBreaches.length > 0 && (
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
                  {filteredBreaches.map((breach, idx) => (
                    <tr key={breach.id ?? idx} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{breach.title}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${SEVERITY_STYLES[breach.severity] ?? "bg-gray-100 text-gray-600"}`}>
                          {breach.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[breach.status] ?? "bg-gray-100 text-gray-600"}`}>
                          {breach.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">{breach.affected_individuals ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(breach.created_at)}</td>
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
        </>
      )}

      {/* Audit Search Tab */}
      {activeTab === "audit" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search audit logs (user, action, resource)..."
                value={auditQuery}
                onChange={(e) => setAuditQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") searchAudit();
                }}
                className="w-full rounded-md border border-border bg-card pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              onClick={() => searchAudit()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Search
            </button>
          </div>

          {auditLoading && (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          )}

          {auditResults && auditResults.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="h-10 w-10 mx-auto mb-2 opacity-40" />
              <p>No audit entries found for this query</p>
            </div>
          )}

          {auditResults && auditResults.length > 0 && (
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
                  {auditResults.map((entry) => (
                    <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDate(entry.timestamp)}</td>
                      <td className="px-4 py-3 font-medium">{entry.action}</td>
                      <td className="px-4 py-3 text-muted-foreground">{entry.user_id ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{entry.resource_type ? `${entry.resource_type}/${entry.resource_id}` : "\u2014"}</td>
                      <td className="px-4 py-3 font-mono text-xs">{entry.ip_address ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs truncate">{entry.details ?? "\u2014"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
