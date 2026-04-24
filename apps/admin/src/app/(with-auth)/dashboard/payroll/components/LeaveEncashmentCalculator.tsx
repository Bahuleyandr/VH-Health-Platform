"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getLeaveEncashments,
  calculateLeaveEncashment,
  type LeaveEncashment,
  type StaffForPayroll,
} from "@/lib/api/payroll";
import { unwrap, fmtCurrency, fmtDate } from "./complianceHelpers";

export function LeaveEncashmentCalculator({ staff }: { staff: StaffForPayroll[] }) {
  const qc = useQueryClient();
  const now = new Date();
  const [calcForm, setCalcForm] = useState({
    staff_uid: "", leave_days: 0, encashment_type: "earned_leave",
    financial_year: now.getMonth() >= 3 ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(-2)}` : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(-2)}`,
  });

  const { data: encRaw } = useQuery({ queryKey: ["leave-encashments"], queryFn: () => getLeaveEncashments() });
  const encList = unwrap<LeaveEncashment[]>(encRaw) ?? [];

  const calcMut = useMutation({
    mutationFn: (d: typeof calcForm) => calculateLeaveEncashment({ ...d }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["leave-encashments"] });
      const d = unwrap<LeaveEncashment>(data);
      toast.success(`₹${parseFloat(d.amount).toLocaleString("en-IN")} encashed`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="border rounded-lg p-4">
      <h4 className="font-semibold text-gray-800 mb-3">Leave Encashment Calculator</h4>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-xs font-medium text-gray-600">Staff *</label>
          <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={calcForm.staff_uid}
            onChange={e => setCalcForm(f => ({ ...f, staff_uid: e.target.value }))}>
            <option value="">Select staff</option>
            {staff.map(s => <option key={s.uid} value={s.uid}>{s.name} ({s.employee_id})</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Type</label>
          <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={calcForm.encashment_type}
            onChange={e => setCalcForm(f => ({ ...f, encashment_type: e.target.value }))}>
            <option value="earned_leave">Earned Leave</option>
            <option value="sick_leave">Sick Leave</option>
            <option value="casual_leave">Casual Leave</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Leave Days</label>
          <input type="number" min={1} className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            value={calcForm.leave_days}
            onChange={e => setCalcForm(f => ({ ...f, leave_days: +e.target.value }))} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Financial Year</label>
          <input type="text" className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            value={calcForm.financial_year}
            onChange={e => setCalcForm(f => ({ ...f, financial_year: e.target.value }))} />
        </div>
      </div>
      <button onClick={() => calcMut.mutate(calcForm)} disabled={!calcForm.staff_uid || !calcForm.leave_days || calcMut.isPending}
        className="px-4 py-1.5 bg-teal-600 text-white rounded text-sm disabled:opacity-50">
        {calcMut.isPending ? "Processing..." : "Calculate & Approve"}
      </button>

      {encList.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["Staff","Type","Days","Daily Rate","Amount","FY","Date"].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {encList.slice(0, 10).map(e => (
                <tr key={e.id}>
                  <td className="px-3 py-2">{e.staff_name}</td>
                  <td className="px-3 py-2">{e.encashment_type}</td>
                  <td className="px-3 py-2">{e.leave_days}</td>
                  <td className="px-3 py-2">{fmtCurrency(e.daily_rate)}</td>
                  <td className="px-3 py-2 font-medium">{fmtCurrency(e.amount)}</td>
                  <td className="px-3 py-2">{e.financial_year || "—"}</td>
                  <td className="px-3 py-2">{fmtDate(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
