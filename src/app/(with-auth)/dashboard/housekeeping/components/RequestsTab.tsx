"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Eye, Plus, RefreshCw, UserPlus, X } from "lucide-react";
import {
  adminCreateHousekeepingRequest,
  assignHousekeepingRequest,
  getHousekeepingRequests,
  getHousekeepingZones,
  verifyHousekeepingRequest,
  type HousekeepingRequest,
  type HousekeepingZone,
} from "@/lib/api/housekeeping";
import { getJSON } from "@/lib/api/core";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";
import { Badge, fmtSLA, STATUS_STYLES, unwrap, URGENCY_STYLES } from "./helpers";
import { DetailPanel } from "./DetailPanel";

export function RequestsTab() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ status: "", urgency: "", assigned_to: "", from: "", to: "" });
  const [assignModal, setAssignModal] = useState<HousekeepingRequest | null>(null);
  const [detailPanel, setDetailPanel] = useState<HousekeepingRequest | null>(null);
  const [newRequestModal, setNewRequestModal] = useState(false);

  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-requests", filters],
    queryFn: () => getHousekeepingRequests({ ...filters, limit: 100 }),
  });

  const { data: zonesRaw } = useQuery({ queryKey: ["hk-zones"], queryFn: getHousekeepingZones });
  const zones = zonesRaw ? unwrap<HousekeepingZone[]>(zonesRaw) : [];

  const result = raw ? unwrap<{ requests: HousekeepingRequest[]; total: number }>(raw) : null;
  const requests = result?.requests ?? [];

  const verifyMut = useMutation({
    mutationFn: (id: number) => verifyHousekeepingRequest(id),
    onSuccess: () => { toast.success("Request verified"); qc.invalidateQueries({ queryKey: ["hk-requests"] }); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-start">
        <div className="bg-white rounded-xl border p-4 grid grid-cols-2 md:grid-cols-5 gap-3 flex-1">
          <select className="border rounded-lg px-3 py-2 text-sm" value={filters.status} onChange={(e) => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All Status</option>
            {["open", "assigned", "in_progress", "completed", "verified", "closed", "cancelled"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ").toUpperCase()}</option>
            ))}
          </select>
          <select className="border rounded-lg px-3 py-2 text-sm" value={filters.urgency} onChange={(e) => setFilters(f => ({ ...f, urgency: e.target.value }))}>
            <option value="">All Urgency</option>
            {["urgent", "high", "normal", "low"].map((u) => (
              <option key={u} value={u}>{u.toUpperCase()}</option>
            ))}
          </select>
          <input placeholder="Assigned to (Staff ID)" className="border rounded-lg px-3 py-2 text-sm" value={filters.assigned_to} onChange={(e) => setFilters(f => ({ ...f, assigned_to: e.target.value }))} />
          <input type="date" className="border rounded-lg px-3 py-2 text-sm" value={filters.from} onChange={(e) => setFilters(f => ({ ...f, from: e.target.value }))} />
          <input type="date" className="border rounded-lg px-3 py-2 text-sm" value={filters.to} onChange={(e) => setFilters(f => ({ ...f, to: e.target.value }))} />
        </div>
        <button
          onClick={() => setNewRequestModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 whitespace-nowrap"
        >
          <Plus size={16} /> New Request
        </button>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-500">{result?.total ?? 0} requests</span>
        <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"><RefreshCw size={14} /> Refresh</button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No requests found</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {["Req#", "Location", "Type", "Urgency", "Raised By", "Assigned To", "Status", "SLA", "Actions"].map((h) => (
                  <th key={h} className="px-3 py-3 text-left font-semibold text-gray-600 text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-3 font-mono text-xs font-semibold text-orange-600">{req.request_number}</td>
                  <td className="px-3 py-3 text-gray-700 max-w-[140px] truncate" title={req.zone_name ?? req.location_text}>{req.zone_name ?? req.location_text}</td>
                  <td className="px-3 py-3 text-gray-500 capitalize text-xs">{req.request_type.replace(/_/g, " ")}</td>
                  <td className="px-3 py-3"><Badge value={req.urgency} styleMap={URGENCY_STYLES} /></td>
                  <td className="px-3 py-3">
                    <div className="text-xs">
                      <div className="font-medium">{req.requester_name ?? "—"}</div>
                      <div className="text-gray-400">{req.requester_dept}</div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-gray-600 text-xs">{req.assigned_to_name ?? <span className="text-gray-400">Unassigned</span>}</td>
                  <td className="px-3 py-3"><Badge value={req.status} styleMap={STATUS_STYLES} /></td>
                  <td className="px-3 py-3">{fmtSLA(req.sla_due_at, req.status)}</td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1.5">
                      {(req.status === "open" || req.status === "assigned") && (
                        <button
                          onClick={() => setAssignModal(req)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-medium border border-blue-200"
                        >
                          <UserPlus size={11} /> Assign
                        </button>
                      )}
                      {req.status === "completed" && (
                        <button
                          onClick={() => verifyMut.mutate(req.id)}
                          disabled={verifyMut.isPending}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100 text-xs font-medium border border-green-200 disabled:opacity-50"
                        >
                          <CheckCircle size={11} /> Verify
                        </button>
                      )}
                      <button
                        onClick={() => setDetailPanel(req)}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-gray-50 text-gray-600 hover:bg-gray-100 text-xs font-medium border border-gray-200"
                      >
                        <Eye size={11} /> Detail
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assignModal && (
        <AssignModal
          req={assignModal}
          onClose={() => setAssignModal(null)}
          onAssigned={() => { qc.invalidateQueries({ queryKey: ["hk-requests"] }); setAssignModal(null); }}
        />
      )}

      {detailPanel && (
        <DetailPanel
          req={detailPanel}
          onClose={() => setDetailPanel(null)}
        />
      )}

      {newRequestModal && (
        <NewRequestModal
          zones={zones}
          onClose={() => setNewRequestModal(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["hk-requests"] }); setNewRequestModal(false); }}
        />
      )}
    </div>
  );
}

function AssignModal({
  req,
  onClose,
  onAssigned,
}: {
  req: HousekeepingRequest;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [staffId, setStaffId] = useState("");
  const [note, setNote] = useState("");

  const { data: staffRaw } = useQuery({
    queryKey: ["staff-list"],
    queryFn: () => getJSON<unknown>("/api/v1/staff/admin/search?limit=100"),
  });

  // Staff search returns s.* from staff table — user_id is the integer FK to users.id.
  // assigned_to in housekeeping_requests is an integer FK to users.id.
  const staffList: Array<{ user_id: number; name: string }> = (() => {
    if (!staffRaw) return [];
    const d = unwrap<{ staff?: Array<{ user_id: number; name: string }> }>(staffRaw);
    return d?.staff ?? [];
  })();

  const mut = useMutation({
    mutationFn: () => assignHousekeepingRequest(req.id, { assigned_to: parseInt(staffId), note: note || undefined }),
    onSuccess: () => { toast.success("Request assigned"); onAssigned(); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Assign {req.request_number}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Assign to Staff *</label>
            {staffList.length > 0 ? (
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">— Select staff member —</option>
                {staffList.map((s) => (
                  <option key={s.user_id} value={s.user_id}>{s.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                placeholder="Enter staff user ID"
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              />
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Note (optional)</label>
            <textarea
              className="w-full border rounded-lg p-3 text-sm h-20 resize-none"
              placeholder="Any instructions..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !staffId}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {mut.isPending ? "Assigning..." : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewRequestModal({
  zones,
  onClose,
  onCreated,
}: {
  zones: HousekeepingZone[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    zone_id: "",
    location_text: "",
    request_type: "cleaning",
    urgency: "normal",
    description: "",
  });

  const mut = useMutation({
    mutationFn: () => adminCreateHousekeepingRequest({
      zone_id: form.zone_id ? parseInt(form.zone_id) : undefined,
      location_text: form.location_text || undefined,
      request_type: form.request_type,
      urgency: form.urgency,
      description: form.description || undefined,
    }),
    onSuccess: () => { toast.success("Request created"); onCreated(); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const valid = form.zone_id || form.location_text.trim();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">New Emergency Request</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Zone</label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={form.zone_id}
              onChange={(e) => setForm(f => ({ ...f, zone_id: e.target.value }))}
            >
              <option value="">— Select zone (or enter location below) —</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name} ({z.zone_type})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Location text (if no zone)</label>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Corridor near OPD"
              value={form.location_text}
              onChange={(e) => setForm(f => ({ ...f, location_text: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Type</label>
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.request_type}
                onChange={(e) => setForm(f => ({ ...f, request_type: e.target.value }))}
              >
                {["cleaning", "deep_clean", "waste_removal", "sanitization", "maintenance", "other"].map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Urgency</label>
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.urgency}
                onChange={(e) => setForm(f => ({ ...f, urgency: e.target.value }))}
              >
                {["urgent", "high", "normal", "low"].map((u) => (
                  <option key={u} value={u}>{u.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Description</label>
            <textarea
              className="w-full border rounded-lg p-3 text-sm h-20 resize-none"
              placeholder="Describe the issue..."
              value={form.description}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !valid}
            className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {mut.isPending ? "Creating..." : "Create Request"}
          </button>
        </div>
      </div>
    </div>
  );
}
