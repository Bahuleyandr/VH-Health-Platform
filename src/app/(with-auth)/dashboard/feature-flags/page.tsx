"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Flag, Plus, Trash2, ToggleLeft, ToggleRight, RefreshCw, Search } from "lucide-react";
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
}

interface CreateFlagPayload {
  name: string;
  enabled: boolean;
  description?: string;
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
      toast.success("Feature flag created");
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      setShowCreate(false);
      setNewFlag({ name: "", enabled: false, description: "" });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to create flag"),
  });

  // Toggle flag mutation
  const toggleMutation = useMutation({
    mutationFn: (flag: FeatureFlag) =>
      fetchAdminAPI("/admin/feature-flags", {
        method: "POST",
        body: { name: flag.name, enabled: !flag.enabled, description: flag.description },
      }),
    onSuccess: () => {
      toast.success("Flag toggled");
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to toggle flag"),
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
    onError: (err: Error) => toast.error(err.message || "Failed to delete flag"),
  });

  const filtered = (flags ?? []).filter(
    (f) =>
      f.name.toLowerCase().includes(search.toLowerCase()) ||
      (f.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

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
            Manage dynamic feature rollout across the platform
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Name</label>
              <input
                type="text"
                value={newFlag.name}
                onChange={(e) => setNewFlag({ ...newFlag, name: e.target.value })}
                placeholder="e.g. enable_telemedicine"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Description</label>
              <input
                type="text"
                value={newFlag.description}
                onChange={(e) => setNewFlag({ ...newFlag, description: e.target.value })}
                placeholder="What does this flag control?"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="flag-enabled"
              checked={newFlag.enabled}
              onChange={(e) => setNewFlag({ ...newFlag, enabled: e.target.checked })}
              className="rounded border-border"
            />
            <label htmlFor="flag-enabled" className="text-sm">Enable on creation</label>
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
          {error instanceof Error ? error.message : "Failed to load feature flags"}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Flag className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No feature flags found</p>
          <p className="text-sm mt-1">Create a new flag to get started</p>
        </div>
      )}

      {/* Flags Table */}
      {!isLoading && filtered.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Updated</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((flag) => (
                <tr key={flag.name} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-sm font-medium">{flag.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{flag.description || "\u2014"}</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        flag.enabled
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {flag.enabled ? "Enabled" : "Disabled"}
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
                        title={flag.enabled ? "Disable" : "Enable"}
                      >
                        {flag.enabled ? (
                          <ToggleRight className="h-4 w-4 text-green-600" />
                        ) : (
                          <ToggleLeft className="h-4 w-4 text-gray-400" />
                        )}
                        {flag.enabled ? "Disable" : "Enable"}
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
