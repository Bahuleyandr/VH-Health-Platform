"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheck,
  Search,
  RefreshCw,
  Eye,
  User,
  FileCheck,
  Clock,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConsentRecord {
  id?: number;
  patient_id?: string;
  patient_name?: string;
  patient_uid?: string;
  consent_type: string;
  status: "granted" | "revoked" | "pending" | "expired";
  granted_at?: string;
  revoked_at?: string;
  expires_at?: string;
  version?: string;
  purpose?: string;
  data_categories?: string[];
  created_at?: string;
  updated_at?: string;
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
    });
  } catch {
    return d;
  }
}

const STATUS_STYLES: Record<string, string> = {
  granted: "bg-green-100 text-green-800",
  revoked: "bg-red-100 text-red-800",
  pending: "bg-yellow-100 text-yellow-800",
  expired: "bg-gray-100 text-gray-600",
};

const CONSENT_TYPE_LABELS: Record<string, string> = {
  treatment: "Treatment",
  data_sharing: "Data Sharing",
  research: "Research Participation",
  marketing: "Marketing",
  telehealth: "Telehealth",
  general: "General",
};

const CONSENT_TYPE_ICONS: Record<string, string> = {
  treatment: "bg-blue-100 text-blue-700",
  data_sharing: "bg-purple-100 text-purple-700",
  research: "bg-indigo-100 text-indigo-700",
  marketing: "bg-pink-100 text-pink-700",
  telehealth: "bg-teal-100 text-teal-700",
  general: "bg-gray-100 text-gray-700",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ConsentManagementPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedRecord, setSelectedRecord] = useState<ConsentRecord | null>(null);

  // Fetch consent records
  const {
    data: records,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<ConsentRecord[]>({
    queryKey: ["consent-records"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/consent/");
      return unwrap<ConsentRecord[]>(res);
    },
  });

  const filtered = (records ?? []).filter((r) => {
    const matchesSearch =
      !search ||
      (r.patient_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (r.patient_uid ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (r.patient_id ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === "all" || r.consent_type === typeFilter;
    const matchesStatus = statusFilter === "all" || r.status === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

  // Compute stats
  const stats = {
    total: records?.length ?? 0,
    granted: records?.filter((r) => r.status === "granted").length ?? 0,
    revoked: records?.filter((r) => r.status === "revoked").length ?? 0,
    pending: records?.filter((r) => r.status === "pending").length ?? 0,
  };

  const consentTypes = [
    "all",
    ...new Set((records ?? []).map((r) => r.consent_type)),
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6" />
            Consent Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Patient consent records and tracking
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="border border-border rounded-lg bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileCheck className="h-4 w-4" /> Total Records
          </div>
          <p className="text-2xl font-bold mt-1">{stats.total}</p>
        </div>
        <div className="border border-green-200 rounded-lg bg-green-50 p-4">
          <div className="flex items-center gap-2 text-sm text-green-600">
            <FileCheck className="h-4 w-4" /> Granted
          </div>
          <p className="text-2xl font-bold mt-1 text-green-700">{stats.granted}</p>
        </div>
        <div className="border border-red-200 rounded-lg bg-red-50 p-4">
          <div className="flex items-center gap-2 text-sm text-red-600">
            <FileCheck className="h-4 w-4" /> Revoked
          </div>
          <p className="text-2xl font-bold mt-1 text-red-700">{stats.revoked}</p>
        </div>
        <div className="border border-yellow-200 rounded-lg bg-yellow-50 p-4">
          <div className="flex items-center gap-2 text-sm text-yellow-600">
            <Clock className="h-4 w-4" /> Pending
          </div>
          <p className="text-2xl font-bold mt-1 text-yellow-700">{stats.pending}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by patient name or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-card pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {consentTypes.map((t) => (
            <option key={t} value={t}>
              {t === "all" ? "All Types" : CONSENT_TYPE_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="all">All Statuses</option>
          <option value="granted">Granted</option>
          <option value="revoked">Revoked</option>
          <option value="pending">Pending</option>
          <option value="expired">Expired</option>
        </select>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error ? error.message : "Failed to load consent records"}
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <ClipboardCheck className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No consent records found</p>
          <p className="text-sm mt-1">
            {search || typeFilter !== "all" || statusFilter !== "all"
              ? "Try adjusting your filters"
              : "No consent data available"}
          </p>
        </div>
      )}

      {/* Detail Panel */}
      {selectedRecord && (
        <div className="border border-border rounded-lg bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <User className="h-5 w-5" />
              {selectedRecord.patient_name ?? selectedRecord.patient_uid ?? "Unknown Patient"}
            </h3>
            <button
              onClick={() => setSelectedRecord(null)}
              className="text-muted-foreground hover:text-foreground text-sm"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Consent Type:</span>
              <p className="font-medium">{CONSENT_TYPE_LABELS[selectedRecord.consent_type] ?? selectedRecord.consent_type}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>
              <p>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[selectedRecord.status] ?? ""}`}>
                  {selectedRecord.status}
                </span>
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Version:</span>
              <p className="font-medium">{selectedRecord.version ?? "\u2014"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Granted:</span>
              <p>{fmtDate(selectedRecord.granted_at)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Expires:</span>
              <p>{fmtDate(selectedRecord.expires_at)}</p>
            </div>
            {selectedRecord.revoked_at && (
              <div>
                <span className="text-muted-foreground">Revoked:</span>
                <p>{fmtDate(selectedRecord.revoked_at)}</p>
              </div>
            )}
          </div>
          {selectedRecord.purpose && (
            <div className="text-sm">
              <span className="text-muted-foreground">Purpose:</span>
              <p>{selectedRecord.purpose}</p>
            </div>
          )}
          {selectedRecord.data_categories && selectedRecord.data_categories.length > 0 && (
            <div className="text-sm">
              <span className="text-muted-foreground">Data Categories:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {selectedRecord.data_categories.map((cat) => (
                  <span key={cat} className="px-2 py-0.5 bg-muted rounded text-xs">{cat}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {!isLoading && filtered.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Patient</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Consent Type</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Granted</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Expires</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((record, idx) => (
                <tr key={record.id ?? idx} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{record.patient_name ?? "\u2014"}</div>
                    <div className="text-xs text-muted-foreground">{record.patient_uid ?? record.patient_id ?? ""}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        CONSENT_TYPE_ICONS[record.consent_type] ?? "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {CONSENT_TYPE_LABELS[record.consent_type] ?? record.consent_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        STATUS_STYLES[record.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {record.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(record.granted_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(record.expires_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedRecord(record)}
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
