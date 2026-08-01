"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Smartphone,
  Search,
  RefreshCw,
  Trash2,
  Eye,
  Wifi,
  WifiOff,
  Monitor,
  Tablet,
  Server,
  KeyRound,
  Plus,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Device {
  id?: number;
  _id?: string;
  device_id?: string;
  user_id?: string;
  user_name?: string;
  user_type?: "patient" | "staff" | "doctor" | "admin";
  device_type?: string;
  device_name?: string;
  platform?: string;
  os_version?: string;
  app_version?: string;
  fcm_token?: string;
  fcm_status?: "active" | "inactive" | "expired";
  last_active?: string;
  ip_address?: string;
  created_at?: string;
  updated_at?: string;
}

interface DeviceStatsResponse {
  overview?: {
    total_devices?: number;
    active_7_days?: number;
    unique_users?: number;
  };
}

interface ClinicalDevice {
  id: number;
  device_code: string;
  display_name: string;
  kind: string;
  protocol: string;
  status: string;
  vendor?: string | null;
  model?: string | null;
  location_id?: number | null;
  credential_prefix?: string | null;
  allowed_source_ips?: string[];
  last_seen_at?: string | null;
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

function timeAgo(d?: string | null): string {
  if (!d) return "\u2014";
  try {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return d;
  }
}

const USER_TYPE_STYLES: Record<string, string> = {
  patient: "bg-blue-100 text-blue-800",
  staff: "bg-purple-100 text-purple-800",
  doctor: "bg-green-100 text-green-800",
  admin: "bg-orange-100 text-orange-800",
};

const FCM_STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  inactive: "bg-gray-100 text-gray-600",
  expired: "bg-red-100 text-red-800",
};

function DeviceIcon({ type }: { type?: string }) {
  const t = (type ?? "").toLowerCase();
  if (t.includes("tablet") || t.includes("ipad")) return <Tablet className="h-4 w-4" />;
  if (t.includes("desktop") || t.includes("web")) return <Monitor className="h-4 w-4" />;
  return <Smartphone className="h-4 w-4" />;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DevicesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [activeTab, setActiveTab] = useState<"app" | "clinical">("app");

  // Fetch devices
  const {
    data: devices,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Device[]>({
    queryKey: ["admin-devices"],
    queryFn: async () => {
      try {
        const res = await fetchAdminAPI<unknown>("/devices/admin/list");
        return unwrap<Device[]>(res);
      } catch {
        return [];
      }
    },
  });

  const { data: deviceStats } = useQuery<DeviceStatsResponse>({
    queryKey: ["admin-device-stats"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/devices/stats");
      return unwrap<DeviceStatsResponse>(res);
    },
  });

  // Remove device mutation
  const removeMutation = useMutation({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mutationFn: async (_deviceId: string) => {
      throw new Error("Device deletion is not supported by the current backend API");
    },
    onSuccess: () => {
      toast.success("Device removed");
      queryClient.invalidateQueries({ queryKey: ["admin-devices"] });
      setSelectedDevice(null);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to remove device"),
  });

  const filtered = (devices ?? []).filter((d) => {
    const matchesSearch =
      !search ||
      (d.user_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (d.device_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (d.device_id ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (d.platform ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesType =
      typeFilter === "all" || d.user_type === typeFilter;
    return matchesSearch && matchesType;
  });

  // Stats — patient/staff counts are derived from the device list by
  // user_type. Previously `patients` was hardcoded 0 and `staff` used
  // `unique_users` (total distinct users, not staff devices), so the cards
  // never agreed with the table.
  const stats = {
    total: deviceStats?.overview?.total_devices ?? devices?.length ?? 0,
    active: deviceStats?.overview?.active_7_days ?? devices?.filter((d) => d.fcm_status === "active").length ?? 0,
    patients: devices?.filter((d) => d.user_type === "patient").length ?? 0,
    staff: devices?.filter((d) => d.user_type === "staff" || d.user_type === "doctor" || d.user_type === "admin").length ?? 0,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Smartphone className="h-6 w-6" />
            Device Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor registered devices and push notification status
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="inline-flex rounded-md border border-border bg-card p-1">
        <button
          type="button"
          onClick={() => setActiveTab("app")}
          className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "app" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <Smartphone className="h-4 w-4" />
          App Devices
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("clinical")}
          className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "clinical" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <Server className="h-4 w-4" />
          Clinical Devices
        </button>
      </div>

      {activeTab === "app" ? (
        <>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="border border-border rounded-lg bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Smartphone className="h-4 w-4" /> Total Devices
          </div>
          <p className="text-2xl font-bold mt-1">{stats.total}</p>
        </div>
        <div className="border border-green-200 rounded-lg bg-green-50 p-4">
          <div className="flex items-center gap-2 text-sm text-green-600">
            <Wifi className="h-4 w-4" /> FCM Active
          </div>
          <p className="text-2xl font-bold mt-1 text-green-700">{stats.active}</p>
        </div>
        <div className="border border-blue-200 rounded-lg bg-blue-50 p-4">
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <Smartphone className="h-4 w-4" /> Patient Devices
          </div>
          <p className="text-2xl font-bold mt-1 text-blue-700">{stats.patients}</p>
        </div>
        <div className="border border-purple-200 rounded-lg bg-purple-50 p-4">
          <div className="flex items-center gap-2 text-sm text-purple-600">
            <Monitor className="h-4 w-4" /> Staff Devices
          </div>
          <p className="text-2xl font-bold mt-1 text-purple-700">{stats.staff}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by user, device name, platform..."
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
          <option value="all">All User Types</option>
          <option value="patient">Patients</option>
          <option value="staff">Staff</option>
          <option value="doctor">Doctors</option>
          <option value="admin">Admins</option>
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
          {error instanceof Error ? error.message : "Failed to load devices"}
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Smartphone className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No devices found</p>
          <p className="text-sm mt-1">
            {search || typeFilter !== "all" ? "Try adjusting your filters" : "No devices registered"}
          </p>
        </div>
      )}

      {/* Device Detail */}
      {selectedDevice && (
        <div className="border border-border rounded-lg bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <DeviceIcon type={selectedDevice.device_type} />
              {selectedDevice.device_name ?? selectedDevice.device_id ?? "Unknown Device"}
            </h3>
            <button onClick={() => setSelectedDevice(null)} className="text-muted-foreground hover:text-foreground text-sm">
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">User:</span>
              <p className="font-medium">{selectedDevice.user_name ?? "\u2014"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">User Type:</span>
              <p>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${USER_TYPE_STYLES[selectedDevice.user_type ?? ""] ?? "bg-gray-100 text-gray-600"}`}>
                  {selectedDevice.user_type ?? "\u2014"}
                </span>
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Platform:</span>
              <p className="font-medium">{selectedDevice.platform ?? "\u2014"} {selectedDevice.os_version ?? ""}</p>
            </div>
            <div>
              <span className="text-muted-foreground">App Version:</span>
              <p className="font-medium">{selectedDevice.app_version ?? "\u2014"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">FCM Status:</span>
              <p>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${FCM_STATUS_STYLES[selectedDevice.fcm_status ?? ""] ?? "bg-gray-100 text-gray-600"}`}>
                  {selectedDevice.fcm_status ?? "\u2014"}
                </span>
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Last Active:</span>
              <p>{fmtDate(selectedDevice.last_active)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">IP Address:</span>
              <p className="font-mono text-xs">{selectedDevice.ip_address ?? "\u2014"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Registered:</span>
              <p>{fmtDate(selectedDevice.created_at)}</p>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => {
                const id = selectedDevice.device_id ?? selectedDevice._id ?? selectedDevice.id;
                if (!id) { toast.error("Device ID is missing"); return; }
                if (confirm("Remove this device?")) {
                  removeMutation.mutate(String(id));
                }
              }}
              disabled={removeMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
            >
              <Trash2 className="h-4 w-4" /> {removeMutation.isPending ? "Removing..." : "Remove Device"}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {!isLoading && filtered.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">User</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Device</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Platform</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">FCM</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Active</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((device, idx) => (
                <tr key={device.id ?? idx} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{device.user_name ?? "\u2014"}</div>
                    <div className="text-xs text-muted-foreground">{device.user_id ?? ""}</div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${USER_TYPE_STYLES[device.user_type ?? ""] ?? "bg-gray-100 text-gray-600"}`}>
                      {device.user_type ?? "\u2014"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <DeviceIcon type={device.device_type} />
                      <span>{device.device_name ?? device.device_type ?? "\u2014"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{device.platform ?? "\u2014"}</td>
                  <td className="px-4 py-3 text-center">
                    {device.fcm_status === "active" ? (
                      <Wifi className="h-4 w-4 text-green-600 mx-auto" />
                    ) : (
                      <WifiOff className="h-4 w-4 text-gray-400 mx-auto" />
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{timeAgo(device.last_active)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setSelectedDevice(device)}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" /> View
                      </button>
                      <button
                        onClick={() => {
                          const id = device.device_id ?? device._id ?? device.id;
                          if (!id) { toast.error("Device ID is missing"); return; }
                          if (confirm("Remove this device?")) {
                            removeMutation.mutate(String(id));
                          }
                        }}
                        disabled={removeMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

        </>
      ) : (
        <ClinicalDeviceRegistry />
      )}
    </div>
  );
}

function ClinicalDeviceRegistry() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    device_code: "",
    display_name: "",
    kind: "monitor",
    vendor: "",
    model: "",
    allowed_source_ips: "",
  });

  const { data, isLoading, isError, error } = useQuery<{ devices: ClinicalDevice[]; count: number }>({
    queryKey: ["clinical-device-registry"],
    queryFn: () => fetchAdminAPI<{ devices: ClinicalDevice[]; count: number }>("/admin/devices"),
  });

  const createMutation = useMutation({
    mutationFn: () => fetchAdminAPI<{ device: ClinicalDevice; credential_plaintext?: string | null }>("/admin/devices", {
      method: "POST",
      body: {
        ...form,
        issue_credential: true,
        allowed_source_ips: form.allowed_source_ips
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      },
    }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["clinical-device-registry"] });
      setForm({ device_code: "", display_name: "", kind: "monitor", vendor: "", model: "", allowed_source_ips: "" });
      toast.success(res.credential_plaintext ? `Credential issued: ${res.credential_plaintext}` : "Device registered");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to register device"),
  });

  const rotateMutation = useMutation({
    mutationFn: (id: number) => fetchAdminAPI<{ device: ClinicalDevice; credential_plaintext?: string | null }>(
      `/admin/devices/${id}/rotate-credential`,
      { method: "POST" },
    ),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["clinical-device-registry"] });
      toast.success(res.credential_plaintext ? `New credential: ${res.credential_plaintext}` : "Credential rotated");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to rotate credential"),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) => fetchAdminAPI(`/admin/devices/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clinical-device-registry"] });
      toast.success("Device revoked");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to revoke device"),
  });

  const devices = data?.devices ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-6">
        <input
          value={form.device_code}
          onChange={(event) => setForm((prev) => ({ ...prev, device_code: event.target.value }))}
          placeholder="Device code"
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <input
          value={form.display_name}
          onChange={(event) => setForm((prev) => ({ ...prev, display_name: event.target.value }))}
          placeholder="Display name"
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary md:col-span-2"
        />
        <select
          value={form.kind}
          onChange={(event) => setForm((prev) => ({ ...prev, kind: event.target.value }))}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="monitor">Monitor</option>
          <option value="monitor_gateway">Monitor gateway</option>
          <option value="central_station">Central station</option>
          <option value="fridge_sensor">Fridge sensor</option>
          <option value="dialysis_machine">Dialysis machine</option>
          <option value="rtls_feed">RTLS feed</option>
          <option value="other">Other</option>
        </select>
        <input
          value={form.allowed_source_ips}
          onChange={(event) => setForm((prev) => ({ ...prev, allowed_source_ips: event.target.value }))}
          placeholder="Allowed IPs"
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          type="button"
          disabled={createMutation.isPending || !form.device_code || !form.display_name}
          onClick={() => createMutation.mutate()}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </div>

      {isLoading && <Skeleton className="h-40 w-full rounded-lg" />}
      {isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : "Failed to load clinical devices"}
        </div>
      )}

      {!isLoading && !isError && devices.length === 0 && (
        <div className="py-12 text-center text-muted-foreground">
          <Server className="mx-auto mb-3 h-12 w-12 opacity-40" />
          <p className="text-lg font-medium">No clinical devices registered</p>
        </div>
      )}

      {devices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Device</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Kind</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Allowed IPs</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Credential</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Last Seen</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {devices.map((device) => (
                <tr key={device.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{device.display_name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{device.device_code}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{device.kind}</td>
                  <td className="px-4 py-3 font-mono text-xs">{device.allowed_source_ips?.join(", ") || "\u2014"}</td>
                  <td className="px-4 py-3 font-mono text-xs">{device.credential_prefix || "\u2014"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{timeAgo(device.last_seen_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => rotateMutation.mutate(device.id)}
                        disabled={rotateMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => revokeMutation.mutate(device.id)}
                        disabled={revokeMutation.isPending || device.status === "revoked"}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        Revoke
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
