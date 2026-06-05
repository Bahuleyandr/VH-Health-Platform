"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  createHousekeepingZone,
  deleteHousekeepingZone,
  updateHousekeepingZone,
  type HousekeepingZone,
} from "@/lib/api/housekeeping";
import { getJSON } from "@/lib/api/core";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";
import { unwrap } from "./helpers";

const ZONE_TYPES = [
  "general",
  "ward",
  "corridor",
  "icu",
  "ot",
  "emergency",
  "pharmacy",
  "lab",
  "outpatient",
  "cafeteria",
  "restroom",
  "storage",
];

export function ZonesTab() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [addModal, setAddModal] = useState(false);
  const [editZone, setEditZone] = useState<HousekeepingZone | null>(null);

  const {
    data: raw,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["hk-zones-all"],
    queryFn: () => getJSON<unknown>("/api/v1/staff/admin/housekeeping/zones"),
  });

  const allZones: HousekeepingZone[] = (() => {
    if (!raw) return [];
    const d = unwrap<HousekeepingZone[] | { zones?: HousekeepingZone[] }>(raw);
    if (Array.isArray(d)) return d;
    return (d as { zones?: HousekeepingZone[] }).zones ?? [];
  })();

  const zones = showAll ? allZones : allZones.filter((z) => z.is_active);

  const toggleMut = useMutation({
    mutationFn: (zone: HousekeepingZone) =>
      updateHousekeepingZone(zone.id, { is_active: !zone.is_active }),
    onSuccess: () => {
      toast.success("Zone updated");
      qc.invalidateQueries({ queryKey: ["hk-zones-all"] });
      qc.invalidateQueries({ queryKey: ["hk-zones"] });
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const removeMut = useMutation({
    mutationFn: (zone: HousekeepingZone) => deleteHousekeepingZone(zone.id),
    onSuccess: () => {
      toast.success("Zone removed");
      qc.invalidateQueries({ queryKey: ["hk-zones-all"] });
      qc.invalidateQueries({ queryKey: ["hk-zones"] });
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  function removeZone(zone: HousekeepingZone) {
    const ok = window.confirm(
      `Remove ${zone.name}? Zones with active requests or assignments will be blocked.`,
    );
    if (ok) removeMut.mutate(zone);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{zones.length} zones</span>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="rounded"
            />
            Show inactive
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => setAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700"
          >
            <Plus size={16} /> Add Zone
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : zones.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No zones found</div>
      ) : (
        <div className="bg-card rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {["Name", "Type", "Floor", "Building", "Status", "Actions"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left font-semibold text-gray-600 text-xs"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {zones.map((zone) => (
                <tr
                  key={zone.id}
                  className={`border-b hover:bg-gray-50 ${!zone.is_active ? "opacity-50" : ""}`}
                >
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {zone.name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold border bg-blue-50 text-blue-700 border-blue-200 capitalize">
                      {zone.zone_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {zone.floor ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {zone.building ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleMut.mutate(zone)}
                      disabled={toggleMut.isPending}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${zone.is_active ? "bg-teal-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform ${zone.is_active ? "translate-x-4" : "translate-x-0.5"}`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setEditZone(zone)}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-gray-50 text-gray-600 hover:bg-gray-100 text-xs font-medium border border-gray-200"
                      >
                        <Edit2 size={11} /> Edit
                      </button>
                      <button
                        onClick={() => removeZone(zone)}
                        disabled={removeMut.isPending}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 text-xs font-medium border border-red-100 disabled:opacity-50"
                      >
                        <Trash2 size={11} /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addModal && (
        <ZoneFormModal
          onClose={() => setAddModal(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["hk-zones-all"] });
            qc.invalidateQueries({ queryKey: ["hk-zones"] });
            setAddModal(false);
          }}
        />
      )}

      {editZone && (
        <ZoneFormModal
          zone={editZone}
          onClose={() => setEditZone(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["hk-zones-all"] });
            qc.invalidateQueries({ queryKey: ["hk-zones"] });
            setEditZone(null);
          }}
        />
      )}
    </div>
  );
}

function ZoneFormModal({
  zone,
  onClose,
  onSaved,
}: {
  zone?: HousekeepingZone;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: zone?.name ?? "",
    zone_type: zone?.zone_type ?? "general",
    floor: zone?.floor ?? "",
    building: zone?.building ?? "",
    is_active: zone?.is_active ?? true,
  });

  const mut = useMutation({
    mutationFn: () =>
      zone
        ? updateHousekeepingZone(zone.id, {
            ...form,
            floor: form.floor || undefined,
            building: form.building || undefined,
          })
        : createHousekeepingZone({
            ...form,
            floor: form.floor || undefined,
            building: form.building || undefined,
          }),
    onSuccess: () => {
      toast.success(zone ? "Zone updated" : "Zone created");
      onSaved();
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">
            {zone ? "Edit Zone" : "Add New Zone"}
          </h3>
          <button onClick={onClose}>
            <X size={18} className="text-gray-400" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">
              Zone Name *
            </label>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. ICU East Wing"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">
              Zone Type
            </label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={form.zone_type}
              onChange={(e) =>
                setForm((f) => ({ ...f, zone_type: e.target.value }))
              }
            >
              {ZONE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                Floor
              </label>
              <input
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Ground, First"
                value={form.floor}
                onChange={(e) =>
                  setForm((f) => ({ ...f, floor: e.target.value }))
                }
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                Building
              </label>
              <input
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Main Block"
                value={form.building}
                onChange={(e) =>
                  setForm((f) => ({ ...f, building: e.target.value }))
                }
              />
            </div>
          </div>
          {zone && (
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700">
                Active
              </label>
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({ ...f, is_active: !f.is_active }))
                }
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.is_active ? "bg-teal-500" : "bg-gray-300"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform ${form.is_active ? "translate-x-4" : "translate-x-0.5"}`}
                />
              </button>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.name.trim()}
            className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {mut.isPending ? "Saving..." : zone ? "Update Zone" : "Create Zone"}
          </button>
        </div>
      </div>
    </div>
  );
}
