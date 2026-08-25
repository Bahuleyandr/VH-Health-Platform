"use client";

// Feature-flag console.
//
// ★ This page must not imply a rollout control it does not have. ★
//
// GET /admin/feature-flags returns, per row, `inert` / `runtime_effect` /
// `runtime_note` from services/featureFlags/featureFlagService.js. Today every
// row comes back `inert: true` / `runtime_effect: 'none'`, because
// `isEnabled()` — the only function that could gate anything — has no call
// sites: the table, these routes and this page read and write a row that
// nothing consults. The console is queued for retirement, not for wiring; the
// decision and the ordering constraints are in docs/ROADMAP.md
// ("Feature-flag console + `feature_flags` table").
//
// So this page renders that metadata rather than a green "Enabled" pill and a
// "Flag toggled" toast. A stored value is labelled a stored value; a flag that
// gates nothing says so, in the server's own words. If a gate is ever wired,
// the flag joins WIRED_FEATURE_FLAGS server-side, `runtime_effect` becomes
// 'gated', and this page starts reading it as "Gates a code path" — with its
// control relabelled "Turn on/off" — without a change here.

import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Flag,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  RefreshCw,
  Search,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeatureFlag {
  id?: number;
  name: string;
  enabled: boolean;
  description?: string;
  created_at?: string;
  updated_at?: string;
  /** True when no code path consults this flag (featureFlagService.getFlags). */
  inert?: boolean;
  /** 'gated' = a code path reads it; 'none' = nothing does. */
  runtime_effect?: string;
  /** The server's own explanation, present only when the flag is inert. */
  runtime_note?: string;
}

interface CreateFlagPayload {
  name: string;
  enabled: boolean;
  description?: string;
}

/** What the server says this flag actually does at runtime. */
type RuntimeEffect = "gated" | "none" | "unreported";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

/**
 * Never guess. A server that does not send the metadata gets "unreported" —
 * claiming either "gates something" or "gates nothing" on its behalf would be
 * the exact defect this page was rewritten to remove.
 */
function runtimeEffectOf(flag: FeatureFlag): RuntimeEffect {
  if (flag.runtime_effect === "gated" || flag.inert === false) return "gated";
  if (flag.runtime_effect === "none" || flag.inert === true) return "none";
  return "unreported";
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function FeatureFlagsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newFlag, setNewFlag] = useState<CreateFlagPayload>({
    name: "",
    enabled: false,
    description: "",
  });

  // Fetch feature flags
  const {
    data: flags,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<FeatureFlag[]>({
    queryKey: ["feature-flags"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/admin/feature-flags");
      return unwrap<FeatureFlag[]>(res);
    },
  });

  // Create flag mutation
  const createMutation = useMutation({
    mutationFn: (payload: CreateFlagPayload) =>
      fetchAdminAPI("/admin/feature-flags", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      toast.success("Feature flag record created");
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      setShowCreate(false);
      setNewFlag({ name: "", enabled: false, description: "" });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create flag"),
  });

  // Toggle flag mutation. The POST changes the STORED value; whether that
  // changes anything at runtime is the server's `runtime_effect`, so the
  // confirmation has to say which happened.
  const toggleMutation = useMutation({
    mutationFn: (flag: FeatureFlag) =>
      fetchAdminAPI("/admin/feature-flags", {
        method: "POST",
        body: {
          name: flag.name,
          enabled: !flag.enabled,
          description: flag.description,
        },
      }),
    onSuccess: (_data, flag: FeatureFlag) => {
      const effect = runtimeEffectOf(flag);
      toast.success(
        effect === "gated"
          ? `"${flag.name}" is now ${flag.enabled ? "off" : "on"}`
          : `Stored value updated for "${flag.name}" — no runtime behaviour changed`,
      );
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to toggle flag"),
  });

  // Delete flag mutation
  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      fetchAdminAPI(`/admin/feature-flags/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Feature flag deleted");
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to delete flag"),
  });

  const all = useMemo(() => flags ?? [], [flags]);

  const filtered = all.filter(
    (f) =>
      f.name.toLowerCase().includes(search.toLowerCase()) ||
      (f.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  // Console-wide truth, computed from what the server reported.
  const inertFlags = all.filter((f) => runtimeEffectOf(f) === "none");
  const unreportedFlags = all.filter(
    (f) => runtimeEffectOf(f) === "unreported",
  );
  const serverNote = inertFlags.find((f) => f.runtime_note)?.runtime_note;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Flag className="h-6 w-6" />
            Feature Flags
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Stored flag records and what each one actually gates at runtime
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" /> New Flag
          </button>
        </div>
      </div>

      {/* Runtime-effect banner — the console's own honesty statement. */}
      {!isLoading && !isError && inertFlags.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">
              {inertFlags.length} of {all.length}{" "}
              {all.length === 1 ? "flag" : "flags"} gate nothing. Toggling them
              changes no runtime behaviour.
            </p>
            <p>
              {serverNote ??
                "No code path consults these flags, so the stored value is a record only."}
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && unreportedFlags.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            The API did not report a runtime effect for {unreportedFlags.length}{" "}
            {unreportedFlags.length === 1 ? "flag" : "flags"}. Whether{" "}
            {unreportedFlags.length === 1 ? "it gates" : "they gate"} anything
            is unknown here — check the backend version before relying on{" "}
            {unreportedFlags.length === 1 ? "it" : "them"}.
          </p>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search flags..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-border bg-card pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* Create Flag Modal */}
      {showCreate && (
        <div className="border border-border rounded-lg bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold">Create Feature Flag</h2>
          <p className="text-sm text-muted-foreground">
            This stores a row. It does not create a gate: a new flag has no
            runtime effect until a code path is written to consult it.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Name
              </label>
              <input
                type="text"
                value={newFlag.name}
                onChange={(e) =>
                  setNewFlag({ ...newFlag, name: e.target.value })
                }
                placeholder="e.g. enable_telemedicine"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Description
              </label>
              <input
                type="text"
                value={newFlag.description}
                onChange={(e) =>
                  setNewFlag({ ...newFlag, description: e.target.value })
                }
                placeholder="What is this flag a record of?"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="flag-enabled"
              checked={newFlag.enabled}
              onChange={(e) =>
                setNewFlag({ ...newFlag, enabled: e.target.checked })
              }
              className="rounded border-border"
            />
            <label htmlFor="flag-enabled" className="text-sm">
              Store the value as on
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => createMutation.mutate(newFlag)}
              disabled={!newFlag.name.trim() || createMutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {/* Error State */}
      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error
            ? error.message
            : "Failed to load feature flags"}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Flag className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No feature flags found</p>
          <p className="text-sm mt-1">
            {all.length === 0
              ? "No flag records are stored."
              : "No stored flag matches this search."}
          </p>
        </div>
      )}

      {/* Flags Table */}
      {!isLoading && filtered.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Name
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Description
                </th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                  Stored value
                </th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                  Runtime effect
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Updated
                </th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((flag) => {
                const effect = runtimeEffectOf(flag);
                const gated = effect === "gated";
                return (
                  <tr
                    key={flag.name}
                    className="hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-sm font-medium">
                      {flag.name}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {flag.description || "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          flag.enabled
                            ? gated
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-700"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {flag.enabled ? "On" : "Off"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        title={flag.runtime_note ?? undefined}
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          gated
                            ? "bg-green-100 text-green-800"
                            : effect === "none"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {gated
                          ? "Gates a code path"
                          : effect === "none"
                            ? "Gates nothing"
                            : "Not reported"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {fmtDate(flag.updated_at ?? flag.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => toggleMutation.mutate(flag)}
                          disabled={toggleMutation.isPending}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                          title={
                            gated
                              ? flag.enabled
                                ? "Turn this feature off"
                                : "Turn this feature on"
                              : "Changes the stored value only — this flag gates nothing"
                          }
                        >
                          {flag.enabled ? (
                            <ToggleRight
                              className={`h-4 w-4 ${gated ? "text-green-600" : "text-gray-400"}`}
                            />
                          ) : (
                            <ToggleLeft className="h-4 w-4 text-gray-400" />
                          )}
                          {gated
                            ? flag.enabled
                              ? "Turn off"
                              : "Turn on"
                            : flag.enabled
                              ? "Store as off"
                              : "Store as on"}
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete flag "${flag.name}"?`)) {
                              deleteMutation.mutate(flag.name);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
