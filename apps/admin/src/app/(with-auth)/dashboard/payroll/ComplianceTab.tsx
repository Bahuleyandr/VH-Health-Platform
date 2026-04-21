"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import { buildProxyUrl } from "@/lib/api-config";
import {
  getComplianceCalendar,
  getFnFList,
  createFnF,
  approveFnF,
  markFnFPaid,
  getGratuityStatus,
  getAllDeclarations,
  approveDeclaration,
  getAllPayslipQueries,
  replyToPayslipQuery,
  getBulkRevisions,
  createBulkRevision,
  approveBulkRevision,
  getLeaveEncashments,
  calculateLeaveEncashment,
  type FnFSettlement,
  type GratuityStatus,
  type InvestmentDeclaration,
  type PayslipQuery,
  type BulkRevisionJob,
  type LeaveEncashment,
  type ComplianceDeadline,
} from "@/lib/api/payroll";
import { getStaffForPayroll, type StaffForPayroll } from "@/lib/api/payroll";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

function fmtCurrency(v: string | number | null | undefined): string {
  const n = parseFloat(String(v || 0));
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function sum80C(d: InvestmentDeclaration): number {
  return [d.ppf, d.epf_voluntary, d.elss, d.lic_premium, d.nsc, d.home_loan_principal, d.tuition_fees, d.other_80c]
    .reduce((a, v) => a + parseFloat(String(v || 0)), 0);
}

function sum80D(d: InvestmentDeclaration): number {
  return parseFloat(String(d.health_insurance_self || 0)) + parseFloat(String(d.health_insurance_parents || 0));
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function proxyDownloadHref(path: string): string {
  return buildProxyUrl(path);
}

// ─── Section A: Compliance Calendar ──────────────────────────────────────────

function ComplianceCalendarSection() {
  const { data: calRaw, isLoading } = useQuery({
    queryKey: ["compliance-calendar"],
    queryFn: () => getComplianceCalendar(),
  });
  const cal = unwrap<{ deadlines: ComplianceDeadline[]; current_month: number; current_year: number }>(calRaw);
  const exportMonth = cal?.current_month ?? new Date().getMonth() + 1;
  const exportYear = cal?.current_year ?? new Date().getFullYear();
  const exportQuery = `month=${exportMonth}&year=${exportYear}`;

  if (isLoading) return <div className="py-8 text-center text-gray-400">Loading calendar...</div>;
  if (!cal) return null;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">
          Compliance Deadlines — {MONTHS[(cal.current_month - 1 + 12) % 12]} {cal.current_year}
        </h3>
        <div className="flex gap-2">
          <a
            href={proxyDownloadHref(`/api/v1/staff/admin/payroll/export/pf?${exportQuery}`)}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            ⬇ PF ECR
          </a>
          <a
            href={proxyDownloadHref(`/api/v1/staff/admin/payroll/export/esi?${exportQuery}`)}
            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
          >
            ⬇ ESI Register
          </a>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cal.deadlines.map((d, i) => {
          const urgency =
            d.due_in_days < 7 ? "border-red-400 bg-red-50" :
            d.due_in_days < 14 ? "border-amber-400 bg-amber-50" :
            "border-green-400 bg-green-50";
          const badge =
            d.status === "ready" ? "bg-green-100 text-green-700" :
            d.status === "pending" ? "bg-amber-100 text-amber-700" :
            "bg-gray-100 text-gray-600";
          return (
            <div key={i} className={`border-l-4 rounded-lg p-4 ${urgency}`}>
              <div className="font-medium text-gray-800 text-sm">{d.label}</div>
              <div className="text-xs text-gray-500 mt-1">Due: {d.due_date}</div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-sm font-bold text-gray-700">
                  {d.due_in_days <= 0 ? "Overdue!" : `${d.due_in_days} days left`}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge}`}>{d.status}</span>
              </div>
              {d.note && <div className="text-xs text-gray-400 mt-1 italic">{d.note}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Section B: F&F Settlements ──────────────────────────────────────────────

function FnFSection({ staff }: { staff: StaffForPayroll[] }) {
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

// ─── Section C: Gratuity Tracker ─────────────────────────────────────────────

function GratuitySection() {
  const { data: raw, isLoading } = useQuery({ queryKey: ["gratuity"], queryFn: () => getGratuityStatus() });
  const list = unwrap<GratuityStatus[]>(raw) ?? [];

  // Sort: near-milestone first (ascending days_to_five_years for non-eligible), then eligible
  const sorted = [...list].sort((a, b) => {
    if (a.gratuity_eligible && !b.gratuity_eligible) return 1;
    if (!a.gratuity_eligible && b.gratuity_eligible) return -1;
    if (!a.gratuity_eligible && !b.gratuity_eligible) return a.days_to_five_years - b.days_to_five_years;
    return b.years_of_service - a.years_of_service;
  });

  if (isLoading) return <div className="py-8 text-center text-gray-400">Loading...</div>;

  return (
    <div>
      <h3 className="text-lg font-semibold text-gray-800 mb-4">Gratuity Tracker</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Staff","Designation","Join Date","Years","Eligible","Projected Gratuity","Days to 5yr"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map(s => (
              <tr key={s.staff_uid} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-gray-400">{s.department}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">{s.designation || "—"}</td>
                <td className="px-4 py-3">{fmtDate(s.date_of_joining)}</td>
                <td className="px-4 py-3">{s.years_of_service}y</td>
                <td className="px-4 py-3">
                  {s.gratuity_eligible
                    ? <span className="text-green-600 font-bold text-base">✓</span>
                    : <span className="text-red-400 text-base">✗</span>}
                </td>
                <td className="px-4 py-3 font-semibold">{fmtCurrency(s.projected_gratuity)}</td>
                <td className="px-4 py-3">
                  {s.gratuity_eligible ? (
                    <span className="text-green-600 text-xs font-medium">Eligible</span>
                  ) : (
                    <span className={`text-xs font-medium ${s.days_to_five_years < 90 ? "text-amber-600" : "text-gray-500"}`}>
                      {s.days_to_five_years}d
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Section D: Investment Declarations ──────────────────────────────────────

function DeclarationsSection() {
  const qc = useQueryClient();
  const now = new Date();
  const [fy, setFy] = useState(() => {
    const m = now.getMonth(); const y = now.getFullYear();
    return m >= 3 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: raw } = useQuery({
    queryKey: ["declarations", fy],
    queryFn: () => getAllDeclarations({ financial_year: fy }),
  });
  const list = unwrap<InvestmentDeclaration[]>(raw) ?? [];

  const approveMut = useMutation({
    mutationFn: (id: number) => approveDeclaration(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["declarations"] }); toast.success("Declaration approved"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const fyOptions = [0, 1, 2].map(i => {
    const m = now.getMonth(); const y = now.getFullYear() - i;
    return m >= 3 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
  });

  const statusChip = (s: string) => {
    const map: Record<string, string> = {
      draft: "bg-gray-100 text-gray-600", submitted: "bg-blue-100 text-blue-700",
      approved: "bg-green-100 text-green-700", locked: "bg-purple-100 text-purple-700",
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[s] ?? "bg-gray-100 text-gray-600"}`}>{s}</span>;
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">Investment Declarations</h3>
        <select className="border rounded px-2 py-1.5 text-sm" value={fy} onChange={e => setFy(e.target.value)}>
          {fyOptions.map(f => <option key={f} value={f}>FY {f}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Staff","Status","80C Total","80D Total","NPS","Submitted At","Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.map(d => (
              <React.Fragment key={d.id}>
                <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{d.staff_name}</div>
                    <div className="text-xs text-gray-400">{d.department} · {d.employee_id}</div>
                  </td>
                  <td className="px-4 py-3">{statusChip(d.status)}</td>
                  <td className="px-4 py-3">{fmtCurrency(Math.min(sum80C(d), 150000))}</td>
                  <td className="px-4 py-3">{fmtCurrency(sum80D(d))}</td>
                  <td className="px-4 py-3">{fmtCurrency(d.nps_contribution)}</td>
                  <td className="px-4 py-3">{fmtDate(d.submitted_at)}</td>
                  <td className="px-4 py-3">
                    {d.status === "submitted" && (
                      <button onClick={e => { e.stopPropagation(); approveMut.mutate(d.id); }}
                        disabled={approveMut.isPending}
                        className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-50">
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === d.id && (
                  <tr>
                    <td colSpan={7} className="px-6 py-4 bg-gray-50 text-sm">
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        {[
                          ["PPF", d.ppf], ["EPF (Voluntary)", d.epf_voluntary], ["ELSS", d.elss],
                          ["LIC Premium", d.lic_premium], ["NSC", d.nsc], ["Home Loan Principal", d.home_loan_principal],
                          ["Tuition Fees", d.tuition_fees], ["Other 80C", d.other_80c],
                          ["Health Insurance (Self)", d.health_insurance_self],
                          ["Health Insurance (Parents)", d.health_insurance_parents],
                          ["Education Loan Interest", d.education_loan_interest],
                          ["Rent (Monthly)", d.rent_paid_monthly],
                          ["Home Loan Interest", d.home_loan_interest],
                          ["NPS Contribution", d.nps_contribution],
                        ].map(([label, val]) => (
                          <div key={String(label)} className="flex justify-between border-b pb-1">
                            <span className="text-gray-500">{label}</span>
                            <span className="font-medium">{fmtCurrency(val as string)}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No declarations for FY {fy}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Section E: Payslip Queries ───────────────────────────────────────────────

function PayslipQueriesSection() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"open" | "in_review" | "resolved">("open");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [replyText, setReplyText] = useState<Record<number, string>>({});
  const [resolveCheck, setResolveCheck] = useState<Record<number, boolean>>({});

  const { data: raw } = useQuery({
    queryKey: ["payslip-queries", statusFilter],
    queryFn: () => getAllPayslipQueries(statusFilter),
  });
  const queries = unwrap<PayslipQuery[]>(raw) ?? [];

  const replyMut = useMutation({
    mutationFn: ({ id, message, resolve }: { id: number; message: string; resolve: boolean }) =>
      replyToPayslipQuery(id, message, resolve),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["payslip-queries"] });
      setReplyText(r => ({ ...r, [vars.id]: "" }));
      toast.success(vars.resolve ? "Query resolved" : "Reply sent");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusChip = (s: string) => {
    const map: Record<string, string> = {
      open: "bg-orange-100 text-orange-700",
      in_review: "bg-blue-100 text-blue-700",
      resolved: "bg-green-100 text-green-700",
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[s] ?? "bg-gray-100 text-gray-600"}`}>{s}</span>;
  };

  const catChip = (c: string) => (
    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">{c}</span>
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">Payslip Queries</h3>
        <div className="flex gap-1 border rounded-lg overflow-hidden">
          {(["open", "in_review", "resolved"] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm ${statusFilter === s ? "bg-teal-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {queries.map(q => (
          <div key={q.id} className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer"
              onClick={() => setExpanded(expanded === q.id ? null : q.id)}>
              <div className="flex-1">
                <div className="font-medium text-sm">{q.subject}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {q.staff_name} · {MONTHS[(q.month - 1 + 12) % 12]} {q.year} · {fmtDate(q.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {catChip(q.category)}
                {statusChip(q.status)}
              </div>
            </div>
            {expanded === q.id && (
              <div className="border-t px-4 py-3 bg-gray-50">
                <p className="text-sm text-gray-700 mb-3">{q.description}</p>
                {/* Reply thread */}
                {q.replies && q.replies.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {q.replies.map(r => (
                      <div key={r.id} className={`flex gap-2 text-xs ${r.author_role === "HR" || r.author_role === "ADMIN" ? "flex-row-reverse" : ""}`}>
                        <div className={`rounded-lg px-3 py-2 max-w-sm ${r.author_role === "HR" || r.author_role === "ADMIN" ? "bg-teal-50 text-teal-900" : "bg-white border text-gray-700"}`}>
                          <div className="font-medium text-xs mb-1">{r.author_role}</div>
                          {r.message}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {q.status !== "resolved" && (
                  <div className="flex gap-2 items-end">
                    <textarea
                      className="flex-1 border rounded px-2 py-1.5 text-sm resize-none"
                      rows={2} placeholder="Type reply..."
                      value={replyText[q.id] ?? ""}
                      onChange={e => setReplyText(r => ({ ...r, [q.id]: e.target.value }))}
                    />
                    <div className="flex flex-col gap-1">
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        <input type="checkbox" checked={resolveCheck[q.id] ?? false}
                          onChange={e => setResolveCheck(r => ({ ...r, [q.id]: e.target.checked }))} />
                        Resolve
                      </label>
                      <button onClick={() => replyMut.mutate({ id: q.id, message: replyText[q.id] ?? "", resolve: resolveCheck[q.id] ?? false })}
                        disabled={!replyText[q.id] || replyMut.isPending}
                        className="px-3 py-1.5 bg-teal-600 text-white rounded text-xs disabled:opacity-50">
                        Send
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {queries.length === 0 && (
          <div className="py-8 text-center text-gray-400">No {statusFilter} queries</div>
        )}
      </div>
    </div>
  );
}

// ─── Section F: Bulk Revisions ────────────────────────────────────────────────

function BulkRevisionsSection() {
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

// ─── Leave Encashment Calculator (for Tools tab) ──────────────────────────────

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

// ─── Main ComplianceTab ───────────────────────────────────────────────────────

export default function ComplianceTab() {
  const { data: staffRaw } = useQuery({
    queryKey: ["staff-for-payroll"],
    queryFn: () => getStaffForPayroll(),
  });
  const staff = unwrap<StaffForPayroll[]>(staffRaw) ?? [];

  const sections = [
    { id: "calendar", label: "📅 Calendar", component: <ComplianceCalendarSection /> },
    { id: "fnf", label: "🏁 F&F", component: <FnFSection staff={staff} /> },
    { id: "gratuity", label: "🏆 Gratuity", component: <GratuitySection /> },
    { id: "declarations", label: "📋 Declarations", component: <DeclarationsSection /> },
    { id: "queries", label: "💬 Queries", component: <PayslipQueriesSection /> },
    { id: "bulk", label: "⚡ Bulk Revisions", component: <BulkRevisionsSection /> },
  ];
  const [active, setActive] = useState("calendar");

  return (
    <div>
      {/* Sub-navigation */}
      <div className="flex gap-1 mb-6 overflow-x-auto border-b">
        {sections.map(s => (
          <button key={s.id} onClick={() => setActive(s.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
              active === s.id
                ? "border-b-2 border-teal-600 text-teal-700 bg-teal-50/50"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
            }`}>
            {s.label}
          </button>
        ))}
      </div>
      {sections.find(s => s.id === active)?.component}
    </div>
  );
}
