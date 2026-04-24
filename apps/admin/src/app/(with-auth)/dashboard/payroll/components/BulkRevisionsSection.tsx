"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getBulkRevisions,
  createBulkRevision,
  approveBulkRevision,
  type BulkRevisionJob,
} from "@/lib/api/payroll";
import { unwrap, fmtDate } from "./complianceHelpers";

export function BulkRevisionsSection() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    description: "", revision_type: "increment", target_type: "all", target_value: "",
    increment_type: "percentage", increment_value: 0, bonus_amount: 0,
    effective_from: new Date().toISOString().split("T")[0],
  });

  const { data: raw } = useQuery({ queryKey: ["bulk-revisions"], queryFn: () => getBulkRevisions() });
  const revisions = unwrap<BulkRevisionJob[]>(raw) ?? [];

  const createMut = useMutation({
    mutationFn: (d: typeof form) => createBulkRevision({
      ...d,
      increment_value: d.increment_value,
      bonus_amount: d.bonus_amount,
      target_value: d.target_type !== "all" ? d.target_value : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bulk-revisions"] }); setShowForm(false); toast.success("Bulk revision draft created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const approveMut = useMutation({
    mutationFn: (id: number) => approveBulkRevision(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bulk-revisions"] }); toast.success("Processing started"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusChip = (s: string) => {
    const map: Record<string, string> = {
      draft: "bg-gray-100 text-gray-600", approved: "bg-blue-100 text-blue-700",
      completed: "bg-green-100 text-green-700", failed: "bg-red-100 text-red-700",
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[s] ?? "bg-gray-100 text-gray-600"}`}>{s}</span>;
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">Bulk Salary Revisions</h3>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-teal-600 text-white rounded text-sm hover:bg-teal-700">
          + New Bulk Revision
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 border rounded-lg p-4 mb-4">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-gray-600">Description *</label>
              <input type="text" className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
                placeholder="e.g. Annual increment FY 2026" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Type</label>
              <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.revision_type}
                onChange={e => setForm(f => ({ ...f, revision_type: e.target.value }))}>
                <option value="increment">Increment</option>
                <option value="bonus">Bonus</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Target</label>
              <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.target_type}
                onChange={e => setForm(f => ({ ...f, target_type: e.target.value }))}>
                <option value="all">All Staff</option>
                <option value="department">By Department</option>
                <option value="role">By Role</option>
                <option value="designation">By Designation</option>
              </select>
            </div>
            {form.target_type !== "all" && (
              <div>
                <label className="text-xs font-medium text-gray-600">Target Value</label>
                <input type="text" className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
                  placeholder={form.target_type === "department" ? "e.g. Nursing" : "e.g. Nurse"}
                  value={form.target_value}
                  onChange={e => setForm(f => ({ ...f, target_value: e.target.value }))} />
              </div>
            )}
            {form.revision_type === "increment" && (
              <>
                <div>
                  <label className="text-xs font-medium text-gray-600">Increment Type</label>
                  <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.increment_type}
                    onChange={e => setForm(f => ({ ...f, increment_type: e.target.value }))}>
                    <option value="percentage">Percentage (%)</option>
                    <option value="flat">Flat Amount (₹)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">
                    Value ({form.increment_type === "percentage" ? "%" : "₹"})
                  </label>
                  <input type="number" className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
                    value={form.increment_value}
                    onChange={e => setForm(f => ({ ...f, increment_value: +e.target.value }))} />
                </div>
              </>
            )}
            {form.revision_type === "bonus" && (
              <div>
                <label className="text-xs font-medium text-gray-600">Bonus Amount (₹)</label>
                <input type="number" className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
                  value={form.bonus_amount}
                  onChange={e => setForm(f => ({ ...f, bonus_amount: +e.target.value }))} />
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-gray-600">Effective From</label>
              <input type="date" className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
                value={form.effective_from}
                onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending}
              className="px-4 py-1.5 bg-teal-600 text-white rounded text-sm disabled:opacity-50">
              {createMut.isPending ? "Creating..." : "Create Draft"}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-1.5 border rounded text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Description","Target","Staff","Processed","Status","Effective","Created By","Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {revisions.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium">{r.description}</div>
                  <div className="text-xs text-gray-400">{r.revision_type} · {r.increment_type && `${r.increment_value}${r.increment_type === "percentage" ? "%" : "₹"}`}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs">{r.target_type}</span>
                  {r.target_value && <div className="text-xs text-gray-400">{r.target_value}</div>}
                </td>
                <td className="px-4 py-3">{r.staff_count}</td>
                <td className="px-4 py-3">{r.processed_count}</td>
                <td className="px-4 py-3">{statusChip(r.status)}</td>
                <td className="px-4 py-3">{fmtDate(r.effective_from)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{r.created_by_name || "—"}</td>
                <td className="px-4 py-3">
                  {r.status === "draft" && (
                    <button onClick={() => approveMut.mutate(r.id)} disabled={approveMut.isPending}
                      className="px-2 py-1 bg-orange-500 text-white rounded text-xs hover:bg-orange-600 disabled:opacity-50">
                      Approve
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {revisions.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No bulk revisions</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
