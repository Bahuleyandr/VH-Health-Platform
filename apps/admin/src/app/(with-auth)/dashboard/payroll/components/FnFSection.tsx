"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getFnFList,
  createFnF,
  approveFnF,
  markFnFPaid,
  type FnFSettlement,
} from "@/lib/api/payroll";
import { type StaffForPayroll } from "@/lib/api/payroll";
import { unwrap, fmtCurrency, fmtDate } from "./complianceHelpers";

export function FnFSection({ staff }: { staff: StaffForPayroll[] }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    staff_uid: "", separation_type: "resignation", last_working_day: "",
    notice_shortfall_days: 0, bonus_payable: 0, other_deductions: 0,
    other_deductions_reason: "", notes: "",
  });
  const [payModal, setPayModal] = useState<{ id: number } | null>(null);
  const [payForm, setPayForm] = useState({ payment_date: "", payment_reference: "" });

  const { data: fnfRaw } = useQuery({ queryKey: ["fnf"], queryFn: () => getFnFList() });
  const fnfList = unwrap<FnFSettlement[]>(fnfRaw) ?? [];

  const createMut = useMutation({
    mutationFn: (d: typeof form) => createFnF(d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fnf"] }); setShowCreate(false); toast.success("F&F created"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const approveMut = useMutation({
    mutationFn: (id: number) => approveFnF(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fnf"] }); toast.success("F&F approved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const paidMut = useMutation({
    mutationFn: ({ id, date, ref }: { id: number; date: string; ref: string }) => markFnFPaid(id, date, ref),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fnf"] }); setPayModal(null); toast.success("Marked as paid"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusChip = (s: string) => {
    const map: Record<string, string> = {
      draft: "bg-gray-100 text-gray-600",
      hr_approved: "bg-yellow-100 text-yellow-800",
      admin_approved: "bg-orange-100 text-orange-800",
      paid: "bg-green-100 text-green-700",
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[s] ?? "bg-gray-100 text-gray-600"}`}>{s}</span>;
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">Full &amp; Final Settlements</h3>
        <button onClick={() => setShowCreate(!showCreate)} className="px-3 py-1.5 bg-teal-600 text-white rounded text-sm hover:bg-teal-700">
          + Create F&amp;F
        </button>
      </div>

      {showCreate && (
        <div className="bg-gray-50 border rounded-lg p-4 mb-4">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs font-medium text-gray-600">Staff *</label>
              <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.staff_uid}
                onChange={e => setForm(f => ({ ...f, staff_uid: e.target.value }))}>
                <option value="">Select staff</option>
                {staff.map(s => <option key={s.uid} value={s.uid}>{s.name} ({s.employee_id})</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Separation Type *</label>
              <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.separation_type}
                onChange={e => setForm(f => ({ ...f, separation_type: e.target.value }))}>
                {["resignation","termination","retirement","voluntary_exit"].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Last Working Day *</label>
              <input type="date" className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.last_working_day}
                onChange={e => setForm(f => ({ ...f, last_working_day: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Notice Shortfall Days</label>
              <input type="number" className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.notice_shortfall_days}
                onChange={e => setForm(f => ({ ...f, notice_shortfall_days: +e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Bonus Payable (₹)</label>
              <input type="number" className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.bonus_payable}
                onChange={e => setForm(f => ({ ...f, bonus_payable: +e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Other Deductions (₹)</label>
              <input type="number" className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={form.other_deductions}
                onChange={e => setForm(f => ({ ...f, other_deductions: +e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending}
              className="px-4 py-1.5 bg-teal-600 text-white rounded text-sm disabled:opacity-50">
              {createMut.isPending ? "Calculating..." : "Calculate & Create"}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 border rounded text-sm">Cancel</button>
          </div>
        </div>
      )}

      {payModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 shadow-xl">
            <h4 className="font-semibold mb-4">Mark F&F as Paid</h4>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-600">Payment Date</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-1"
                  value={payForm.payment_date} onChange={e => setPayForm(f => ({ ...f, payment_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-600">Payment Reference</label>
                <input type="text" className="w-full border rounded px-2 py-1.5 text-sm mt-1"
                  placeholder="UTR/Cheque No."
                  value={payForm.payment_reference} onChange={e => setPayForm(f => ({ ...f, payment_reference: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => paidMut.mutate({ id: payModal.id, date: payForm.payment_date, ref: payForm.payment_reference })}
                disabled={paidMut.isPending} className="px-4 py-1.5 bg-green-600 text-white rounded text-sm disabled:opacity-50">
                Confirm Paid
              </button>
              <button onClick={() => setPayModal(null)} className="px-4 py-1.5 border rounded text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Staff","Separation","Last Day","Gross","Net Payable","Status","Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {fnfList.map(f => (
              <tr key={f.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{f.staff_name}</td>
                <td className="px-4 py-3 capitalize">{f.separation_type}</td>
                <td className="px-4 py-3">{fmtDate(f.last_working_day)}</td>
                <td className="px-4 py-3">{fmtCurrency(f.gross_payable)}</td>
                <td className="px-4 py-3 font-semibold">{fmtCurrency(f.net_payable)}</td>
                <td className="px-4 py-3">{statusChip(f.status)}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    {f.status === "draft" && (
                      <button onClick={() => approveMut.mutate(f.id)}
                        className="px-2 py-1 bg-yellow-500 text-white rounded text-xs hover:bg-yellow-600">
                        HR Approve
                      </button>
                    )}
                    {f.status === "hr_approved" && (
                      <button onClick={() => approveMut.mutate(f.id)}
                        className="px-2 py-1 bg-orange-500 text-white rounded text-xs hover:bg-orange-600">
                        Admin Approve
                      </button>
                    )}
                    {f.status === "admin_approved" && (
                      <button onClick={() => setPayModal({ id: f.id })}
                        className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700">
                        Mark Paid
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {fnfList.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No F&F settlements found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
