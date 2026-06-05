"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  createAdvance,
  exportESIRegisterUrl,
  exportPFRegisterUrl,
  exportPayrollSummaryUrl,
  generateTaxSummaries,
  getAllAdvances,
  getStaffForPayroll,
  type StaffForPayroll,
} from "@/lib/api/payroll";
import { LeaveEncashmentCalculator } from "../ComplianceTab";
import { statusBadge, unwrap, type Advance } from "./helpers";

function LeaveEncashmentToolWidget() {
  const { data: staffRaw } = useQuery({
    queryKey: ["staff-for-payroll"],
    queryFn: () => getStaffForPayroll(),
  });
  const staff = unwrap<StaffForPayroll[]>(staffRaw) ?? [];
  return <LeaveEncashmentCalculator staff={staff} />;
}

export function ToolsTab() {
  const queryClient = useQueryClient();
  const now = new Date();
  const [exportMonth, setExportMonth] = useState(now.getMonth() + 1);
  const [exportYear, setExportYear] = useState(now.getFullYear());
  const [taxFY, setTaxFY] = useState(() => {
    const m = now.getMonth();
    const y = now.getFullYear();
    return m >= 3
      ? `${y}-${String(y + 1).slice(-2)}`
      : `${y - 1}-${String(y).slice(-2)}`;
  });
  const [showAdvanceForm, setShowAdvanceForm] = useState(false);
  const [advanceForm, setAdvanceForm] = useState({
    staff_uid: "",
    amount: "",
    reason: "",
    monthly_deduction: "",
    deduction_start_month: String(now.getMonth() + 1),
    deduction_start_year: String(now.getFullYear()),
    notes: "",
  });

  const { data: advancesRaw, isLoading: advancesLoading } = useQuery({
    queryKey: ["advances"],
    queryFn: () => getAllAdvances(),
  });
  const advances = unwrap<Advance[]>(advancesRaw) ?? [];

  const taxMut = useMutation({
    mutationFn: () => generateTaxSummaries({ financial_year: taxFY }),
    onSuccess: (res) => {
      const d = (res as { data?: { generated?: number; failed?: number } })
        .data;
      toast.success(
        `Generated for ${d?.generated ?? 0} staff (${d?.failed ?? 0} failed)`,
      );
    },
    onError: () => toast.error("Failed to generate tax summaries"),
  });

  const advanceMut = useMutation({
    mutationFn: () =>
      createAdvance({
        ...advanceForm,
        amount: parseFloat(advanceForm.amount),
        monthly_deduction: parseFloat(advanceForm.monthly_deduction),
        deduction_start_month: parseInt(advanceForm.deduction_start_month),
        deduction_start_year: parseInt(advanceForm.deduction_start_year),
      }),
    onSuccess: () => {
      toast.success("Advance created successfully");
      setShowAdvanceForm(false);
      setAdvanceForm({
        staff_uid: "",
        amount: "",
        reason: "",
        monthly_deduction: "",
        deduction_start_month: String(now.getMonth() + 1),
        deduction_start_year: String(now.getFullYear()),
        notes: "",
      });
      queryClient.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: () => toast.error("Failed to create advance"),
  });

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);
  const fyOptions = Array.from({ length: 3 }, (_, i) => {
    const s =
      now.getMonth() >= 3 ? now.getFullYear() - i : now.getFullYear() - 1 - i;
    return `${s}-${String(s + 1).slice(-2)}`;
  });

  function downloadWithAuth(url: string) {
    // Open direct download — auth is via session cookie
    window.open(url, "_blank");
  }

  return (
    <div className="space-y-6">
      {/* ── Export Section ── */}
      <div className="bg-card rounded-xl border p-6">
        <h2 className="font-bold text-lg text-gray-800 mb-4">
          📥 Export Payroll Data
        </h2>
        <div className="flex gap-3 mb-4 flex-wrap">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Month</label>
            <select
              value={exportMonth}
              onChange={(e) => setExportMonth(Number(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {months.map((m, i) => (
                <option key={i + 1} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Year</label>
            <select
              value={exportYear}
              onChange={(e) => setExportYear(Number(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() =>
              downloadWithAuth(exportPayrollSummaryUrl(exportMonth, exportYear))
            }
            className="flex items-center gap-2 px-4 py-2.5 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors"
          >
            📊 Payroll Summary CSV
          </button>
          <button
            onClick={() =>
              downloadWithAuth(exportPFRegisterUrl(exportMonth, exportYear))
            }
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            🏦 PF ECR Register
          </button>
          <button
            onClick={() =>
              downloadWithAuth(exportESIRegisterUrl(exportMonth, exportYear))
            }
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            🏥 ESI Register
          </button>
        </div>
      </div>

      {/* ── Annual Tax Summary ── */}
      <div className="bg-card rounded-xl border p-6">
        <h2 className="font-bold text-lg text-gray-800 mb-4">
          🧾 Annual Tax Summary (Form 16 basis)
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Generate Form 16 / annual tax summaries for all staff based on their
          issued payslips for the financial year. Uses New Tax Regime slabs.
        </p>
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="text-xs text-gray-500 block mb-1">
              Financial Year
            </label>
            <select
              value={taxFY}
              onChange={(e) => setTaxFY(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  FY {fy}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => taxMut.mutate()}
            disabled={taxMut.isPending}
            className="px-5 py-2.5 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50 transition-colors"
          >
            {taxMut.isPending ? "Generating..." : "Generate for All Staff"}
          </button>
        </div>
      </div>

      {/* ── Salary Advances ── */}
      <div className="bg-card rounded-xl border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg text-gray-800">
            💳 Salary Advances / Loans
          </h2>
          <button
            onClick={() => setShowAdvanceForm(!showAdvanceForm)}
            className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors"
          >
            {showAdvanceForm ? "Cancel" : "+ Add Advance"}
          </button>
        </div>

        {showAdvanceForm && (
          <div className="mb-6 p-4 bg-teal-50 rounded-xl border border-teal-200">
            <h3 className="font-semibold text-sm text-teal-800 mb-3">
              New Salary Advance
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="text-xs text-gray-500 block mb-1">
                  Staff UID
                </label>
                <input
                  type="text"
                  placeholder="staff-uid-here"
                  value={advanceForm.staff_uid}
                  onChange={(e) =>
                    setAdvanceForm({
                      ...advanceForm,
                      staff_uid: e.target.value,
                    })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">
                  Amount (₹)
                </label>
                <input
                  type="number"
                  placeholder="50000"
                  value={advanceForm.amount}
                  onChange={(e) =>
                    setAdvanceForm({ ...advanceForm, amount: e.target.value })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">
                  Monthly Deduction (₹)
                </label>
                <input
                  type="number"
                  placeholder="5000"
                  value={advanceForm.monthly_deduction}
                  onChange={(e) =>
                    setAdvanceForm({
                      ...advanceForm,
                      monthly_deduction: e.target.value,
                    })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">
                  Start Month
                </label>
                <select
                  value={advanceForm.deduction_start_month}
                  onChange={(e) =>
                    setAdvanceForm({
                      ...advanceForm,
                      deduction_start_month: e.target.value,
                    })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  {months.map((m, i) => (
                    <option key={i + 1} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">
                  Start Year
                </label>
                <select
                  value={advanceForm.deduction_start_year}
                  onChange={(e) =>
                    setAdvanceForm({
                      ...advanceForm,
                      deduction_start_year: e.target.value,
                    })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <label className="text-xs text-gray-500 block mb-1">
                  Reason
                </label>
                <input
                  type="text"
                  placeholder="Medical emergency, personal reason..."
                  value={advanceForm.reason}
                  onChange={(e) =>
                    setAdvanceForm({ ...advanceForm, reason: e.target.value })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="col-span-2 sm:col-span-3">
                <label className="text-xs text-gray-500 block mb-1">
                  Notes (optional)
                </label>
                <input
                  type="text"
                  placeholder="Additional notes..."
                  value={advanceForm.notes}
                  onChange={(e) =>
                    setAdvanceForm({ ...advanceForm, notes: e.target.value })
                  }
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            {advanceForm.amount && advanceForm.monthly_deduction && (
              <p className="text-xs text-teal-700 mt-2">
                Approx.{" "}
                {Math.ceil(
                  parseFloat(advanceForm.amount) /
                    parseFloat(advanceForm.monthly_deduction),
                )}{" "}
                monthly deductions of ₹
                {parseFloat(advanceForm.monthly_deduction).toLocaleString(
                  "en-IN",
                )}
              </p>
            )}
            <button
              onClick={() => advanceMut.mutate()}
              disabled={
                advanceMut.isPending ||
                !advanceForm.staff_uid ||
                !advanceForm.amount ||
                !advanceForm.reason ||
                !advanceForm.monthly_deduction
              }
              className="mt-3 px-5 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50 transition-colors"
            >
              {advanceMut.isPending ? "Saving..." : "Approve Advance"}
            </button>
          </div>
        )}

        {advancesLoading ? (
          <div className="text-center py-8 text-gray-400">Loading...</div>
        ) : advances.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            No salary advances on record
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">Staff</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Monthly Deduction</th>
                  <th className="px-4 py-3 text-right">Deducted</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                  <th className="px-4 py-3 text-left">Reason</th>
                  <th className="px-4 py-3 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-card">
                {advances.map((adv) => (
                  <tr key={adv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {adv.staff_name}
                      </div>
                      <div className="text-xs text-gray-500">
                        {adv.department ?? "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      ₹{parseFloat(adv.amount).toLocaleString("en-IN")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      ₹
                      {parseFloat(adv.monthly_deduction).toLocaleString(
                        "en-IN",
                      )}
                      /mo
                    </td>
                    <td className="px-4 py-3 text-right text-orange-600">
                      ₹{parseFloat(adv.total_deducted).toLocaleString("en-IN")}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-red-600">
                      ₹
                      {parseFloat(adv.balance_remaining).toLocaleString(
                        "en-IN",
                      )}
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate"
                      title={adv.reason}
                    >
                      {adv.reason}
                    </td>
                    <td className="px-4 py-3">{statusBadge(adv.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Arrears note ── */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <strong>💡 Arrears:</strong> To calculate arrears for a backdated salary
        revision, go to <strong>Salary Revisions</strong> tab → select an
        applied revision → the system will compute and create the arrears record
        automatically when you click &quot;Calculate Arrears&quot;. Arrears are
        paid automatically in the next payroll run.
      </div>

      {/* ── Leave Encashment Calculator ── */}
      <LeaveEncashmentToolWidget />
    </div>
  );
}
