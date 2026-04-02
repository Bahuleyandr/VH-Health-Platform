"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  Link2,
  ShieldCheck,
  HeartPulse,
  Users,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ABDMStatus {
  connected?: boolean;
  bridge_url?: string;
  last_heartbeat?: string;
  abha_registrations?: number;
  health_records_linked?: number;
  consent_requests_total?: number;
  consent_requests_pending?: number;
  consent_requests_granted?: number;
  consent_requests_denied?: number;
  services?: Array<{
    name: string;
    status: "up" | "down" | "degraded";
    last_check?: string;
  }>;
}

interface ConsentRequest {
  id?: string;
  request_id?: string;
  patient_id?: string;
  patient_name?: string;
  purpose?: string;
  hip_id?: string;
  hip_name?: string;
  status?: "REQUESTED" | "GRANTED" | "DENIED" | "EXPIRED" | "REVOKED";
  date_range_from?: string;
  date_range_to?: string;
  created_at?: string;
  updated_at?: string;
  expiry_date?: string;
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

const CONSENT_STATUS_STYLES: Record<string, string> = {
  REQUESTED: "bg-blue-100 text-blue-800",
  GRANTED: "bg-green-100 text-green-800",
  DENIED: "bg-red-100 text-red-800",
  EXPIRED: "bg-gray-100 text-gray-600",
  REVOKED: "bg-orange-100 text-orange-800",
};

function ServiceStatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; icon: React.ReactNode }> = {
    up: { bg: "bg-green-100 text-green-800", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    down: { bg: "bg-red-100 text-red-800", icon: <XCircle className="h-3.5 w-3.5" /> },
    degraded: { bg: "bg-yellow-100 text-yellow-800", icon: <Clock className="h-3.5 w-3.5" /> },
  };
  const s = styles[status] ?? styles.down;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${s.bg}`}>
      {s.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ABDMPage() {
  const [activeTab, setActiveTab] = useState<"overview" | "consent">("overview");
  const [selectedRequest, setSelectedRequest] = useState<ConsentRequest | null>(null);

  // Fetch ABDM status
  const {
    data: status,
    isLoading: statusLoading,
    isError: statusError,
    error: statusErr,
    refetch: refetchStatus,
  } = useQuery<ABDMStatus>({
    queryKey: ["abdm-status"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/abdm/status");
      return unwrap<ABDMStatus>(res);
    },
  });

  // Fetch consent requests
  const {
    data: consentRequests,
    isLoading: consentLoading,
    isError: consentError,
    refetch: refetchConsent,
  } = useQuery<ConsentRequest[]>({
    queryKey: ["abdm-consent-requests"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/abdm/consent-requests");
      return unwrap<ConsentRequest[]>(res);
    },
    enabled: activeTab === "consent",
  });

  const tabs = [
    { key: "overview" as const, label: "Integration Status", icon: Activity },
    { key: "consent" as const, label: "Consent Requests", icon: ShieldCheck },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <HeartPulse className="h-6 w-6" />
            ABDM Integration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Ayushman Bharat Digital Mission - ABHA &amp; Health Record Management
          </p>
        </div>
        <button
          onClick={() => {
            refetchStatus();
            if (activeTab === "consent") refetchConsent();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Connection Status Banner */}
      {!statusLoading && status && (
        <div
          className={`rounded-lg p-4 flex items-center gap-3 ${
            status.connected
              ? "bg-green-50 border border-green-200"
              : "bg-red-50 border border-red-200"
          }`}
        >
          {status.connected ? (
            <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
          ) : (
            <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          )}
          <div>
            <p className={`text-sm font-medium ${status.connected ? "text-green-800" : "text-red-800"}`}>
              ABDM Bridge: {status.connected ? "Connected" : "Disconnected"}
            </p>
            {status.bridge_url && (
              <p className="text-xs text-muted-foreground mt-0.5">{status.bridge_url}</p>
            )}
            {status.last_heartbeat && (
              <p className="text-xs text-muted-foreground">Last heartbeat: {fmtDate(status.last_heartbeat)}</p>
            )}
          </div>
        </div>
      )}

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

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {statusLoading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          )}

          {statusError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
              {statusErr instanceof Error ? statusErr.message : "Failed to load ABDM status"}
            </div>
          )}

          {status && (
            <>
              {/* Stats Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="border border-blue-200 rounded-lg bg-blue-50 p-4">
                  <div className="flex items-center gap-2 text-sm text-blue-600">
                    <Users className="h-4 w-4" /> ABHA Registrations
                  </div>
                  <p className="text-2xl font-bold mt-1 text-blue-700">
                    {status.abha_registrations ?? 0}
                  </p>
                </div>
                <div className="border border-green-200 rounded-lg bg-green-50 p-4">
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <Link2 className="h-4 w-4" /> Records Linked
                  </div>
                  <p className="text-2xl font-bold mt-1 text-green-700">
                    {status.health_records_linked ?? 0}
                  </p>
                </div>
                <div className="border border-purple-200 rounded-lg bg-purple-50 p-4">
                  <div className="flex items-center gap-2 text-sm text-purple-600">
                    <ShieldCheck className="h-4 w-4" /> Consent Requests
                  </div>
                  <p className="text-2xl font-bold mt-1 text-purple-700">
                    {status.consent_requests_total ?? 0}
                  </p>
                </div>
                <div className="border border-yellow-200 rounded-lg bg-yellow-50 p-4">
                  <div className="flex items-center gap-2 text-sm text-yellow-600">
                    <Clock className="h-4 w-4" /> Pending Consent
                  </div>
                  <p className="text-2xl font-bold mt-1 text-yellow-700">
                    {status.consent_requests_pending ?? 0}
                  </p>
                </div>
              </div>

              {/* Consent Breakdown */}
              {(status.consent_requests_granted !== undefined || status.consent_requests_denied !== undefined) && (
                <div className="border border-border rounded-lg bg-card p-6">
                  <h3 className="text-lg font-semibold mb-4">Consent Request Breakdown</h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center p-3 rounded-lg bg-green-50">
                      <p className="text-2xl font-bold text-green-700">{status.consent_requests_granted ?? 0}</p>
                      <p className="text-sm text-green-600">Granted</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-red-50">
                      <p className="text-2xl font-bold text-red-700">{status.consent_requests_denied ?? 0}</p>
                      <p className="text-sm text-red-600">Denied</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-yellow-50">
                      <p className="text-2xl font-bold text-yellow-700">{status.consent_requests_pending ?? 0}</p>
                      <p className="text-sm text-yellow-600">Pending</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Service Health */}
              {status.services && status.services.length > 0 && (
                <div className="border border-border rounded-lg bg-card p-6">
                  <h3 className="text-lg font-semibold mb-4">Service Health</h3>
                  <div className="space-y-3">
                    {status.services.map((svc) => (
                      <div
                        key={svc.name}
                        className="flex items-center justify-between py-2 border-b border-border last:border-0"
                      >
                        <div>
                          <p className="font-medium text-sm">{svc.name}</p>
                          {svc.last_check && (
                            <p className="text-xs text-muted-foreground">Last check: {fmtDate(svc.last_check)}</p>
                          )}
                        </div>
                        <ServiceStatusBadge status={svc.status} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {!statusLoading && !status && !statusError && (
            <div className="text-center py-12 text-muted-foreground">
              <HeartPulse className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">No ABDM status data available</p>
              <p className="text-sm mt-1">ABDM integration may not be configured</p>
            </div>
          )}
        </div>
      )}

      {/* Consent Requests Tab */}
      {activeTab === "consent" && (
        <div className="space-y-4">
          {consentLoading && (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          )}

          {consentError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
              Failed to load consent requests
            </div>
          )}

          {!consentLoading && (!consentRequests || consentRequests.length === 0) && !consentError && (
            <div className="text-center py-12 text-muted-foreground">
              <ShieldCheck className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">No consent requests</p>
              <p className="text-sm mt-1">No ABDM consent requests found</p>
            </div>
          )}

          {/* Detail Panel */}
          {selectedRequest && (
            <div className="border border-border rounded-lg bg-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Consent Request Details</h3>
                <button onClick={() => setSelectedRequest(null)} className="text-muted-foreground hover:text-foreground text-sm">
                  Close
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Patient:</span>
                  <p className="font-medium">{selectedRequest.patient_name ?? selectedRequest.patient_id ?? "\u2014"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Purpose:</span>
                  <p className="font-medium">{selectedRequest.purpose ?? "\u2014"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>
                  <p>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CONSENT_STATUS_STYLES[selectedRequest.status ?? ""] ?? "bg-gray-100 text-gray-600"}`}>
                      {selectedRequest.status ?? "\u2014"}
                    </span>
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">HIP:</span>
                  <p className="font-medium">{selectedRequest.hip_name ?? selectedRequest.hip_id ?? "\u2014"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Date Range:</span>
                  <p className="text-xs">{fmtDate(selectedRequest.date_range_from)} - {fmtDate(selectedRequest.date_range_to)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Expires:</span>
                  <p>{fmtDate(selectedRequest.expiry_date)}</p>
                </div>
              </div>
            </div>
          )}

          {/* Table */}
          {consentRequests && consentRequests.length > 0 && (
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Patient</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Purpose</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">HIP</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Created</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {consentRequests.map((req, idx) => (
                    <tr key={req.id ?? req.request_id ?? idx} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium">{req.patient_name ?? "\u2014"}</div>
                        <div className="text-xs text-muted-foreground">{req.patient_id ?? ""}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{req.purpose ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{req.hip_name ?? req.hip_id ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${CONSENT_STATUS_STYLES[req.status ?? ""] ?? "bg-gray-100 text-gray-600"}`}>
                          {req.status ?? "\u2014"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(req.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedRequest(req)}
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
      )}
    </div>
  );
}
