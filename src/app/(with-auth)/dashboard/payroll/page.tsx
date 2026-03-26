"use client";

import React, { useState, useCallback } from "react";
import ComplianceTab, { LeaveEncashmentCalculator } from "./ComplianceTab";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getPayrollRuns,
  getPayrollRunDetail,
  runPayroll,
  issuePayslips,
  hrSignPayrollRun,
  adminSignPayrollRun,
  manualEditPayslip,
  getStaffForPayroll,
  getStaffSalaryConfig,
  upsertSalaryConfig,
  getRevisions,
  getAnnualReviewStatus,
  proposeRevision,
  hrSignRevision,
  adminSignRevision,
  applyRevision,
  rejectRevision,
  // New features
  exportPayrollSummaryUrl,
  exportPFRegisterUrl,
  exportESIRegisterUrl,
  generateTaxSummaries,
  getAllAdvances,
  createAdvance,
  calculateArrears,
  type PayrollRun,
  type Payslip,
  type StaffSalaryConfig,
  type StaffForPayroll,
  type SalaryRevision,
  type AnnualReviewStaff,
} from "@/lib/api/payroll";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmtMonth(m: number) {
  return MONTHS[(m - 1 + 12) % 12] ?? "—";
}

function fmtCurrency(v: string | number | null | undefined): string {
  const n = parseFloat(String(v || 0));
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    processing: "bg-yellow-100 text-yellow-800",
    completed: "bg-green-100 text-green-800",
    locked: "bg-blue-100 text-blue-800",
    issued: "bg-green-100 text-green-800",
    pending_hr: "bg-orange-100 text-orange-800",
    pending_admin: "bg-purple-100 text-purple-800",
    approved: "bg-green-100 text-green-800",
    applied: "bg-teal-100 text-teal-800",
    rejected: "bg-red-100 text-red-800",
    cancelled: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function Modal({
  open,
  onClose,
  title,
  children,
  maxW = "max-w-xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxW?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${maxW} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl font-bold">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// ─── TAB 1: Payroll Runs ──────────────────────────────────────────────────────

function PayrollRunsTab() {
  const qc = useQueryClient();
  const [showRunModal, setShowRunModal] = useState(false);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [runMonth, setRunMonth] = useState(new Date().getMonth() + 1);
  const [runYear, setRunYear] = useState(new Date().getFullYear());

  const { data: runsRaw, isLoading: runsLoading } = useQuery({
    queryKey: ["payroll-runs"],
    queryFn: () => getPayrollRuns(),
  });
  const runs = unwrap<PayrollRun[]>(runsRaw) ?? [];

  const { data: detailRaw, isLoading: detailLoading } = useQuery({
    queryKey: ["payroll-run-detail", selectedRun],
    queryFn: () => getPayrollRunDetail(selectedRun!),
    enabled: !!selectedRun,
  });
  const detail = unwrap<{ run: PayrollRun; payslips: Payslip[] }>(detailRaw);

  const runMut = useMutation({
    mutationFn: (data: { month: number; year: number }) => runPayroll(data),
    onSuccess: () => {
      toast.success("Payroll run complete");
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      setShowRunModal(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const issueMut = useMutation({
    mutationFn: (data: { month: number; year: number }) => issuePayslips(data),
    onSuccess: (r) => {
      const count = (unwrap<{ issued: number }>(r))?.issued ?? 0;
      toast.success(`${count} payslips issued to staff`);
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll-run-detail"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const thisYear = new Date().getFullYear();
  const yearOptions = [thisYear - 1, thisYear, thisYear + 1];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-lg text-gray-800">Payroll Runs</h2>
        <button
          onClick={() => setShowRunModal(true)}
          className="bg-teal-700 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-teal-800 transition-colors"
        >
          + Run Payroll
        </button>
      </div>

      {/* Runs table */}
      {runsLoading ? (
        <div className="text-center py-10 text-gray-400">Loading...</div>
      ) : runs.length === 0 ? (
        <div className="text-center py-10 text-gray-400">No payroll runs yet</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["Month", "Year", "Staff", "Gross", "Net", "Status", "Generated By", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedRun(run.id)}>
                  <td className="px-4 py-3 font-medium">{fmtMonth(run.month)}</td>
                  <td className="px-4 py-3">{run.year}</td>
                  <td className="px-4 py-3">{run.total_staff}</td>
                  <td className="px-4 py-3">{fmtCurrency(run.total_gross)}</td>
                  <td className="px-4 py-3 font-semibold text-teal-700">{fmtCurrency(run.total_net)}</td>
                  <td className="px-4 py-3">{statusBadge(run.status)}</td>
                  <td className="px-4 py-3 text-gray-500">{run.generated_by_name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <RunActions run={run} issueMut={issueMut} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Run detail drawer */}
      {selectedRun && (
        <Modal
          open={!!selectedRun}
          onClose={() => setSelectedRun(null)}
          title={`Payroll Run #${selectedRun} — ${detail?.run ? `${fmtMonth(detail.run.month)} ${detail.run.year}` : "..."}`}
          maxW="max-w-5xl"
        >
          {detailLoading ? (
            <div className="text-center py-8 text-gray-400">Loading payslips...</div>
          ) : !detail?.payslips?.length ? (
            <div className="text-center py-8 text-gray-400">No payslips in this run</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {["Staff", "Dept", "Present", "Gross", "Deductions", "Net", "Status", "PDF"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {detail.payslips.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium">{p.staff_name ?? p.staff_uid?.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-gray-500">{p.department ?? "—"}</td>
                      <td className="px-3 py-2">{p.days_present}/{p.total_working_days}</td>
                      <td className="px-3 py-2">{fmtCurrency(p.gross_salary)}</td>
                      <td className="px-3 py-2 text-red-600">{fmtCurrency(p.total_deductions)}</td>
                      <td className="px-3 py-2 font-bold text-teal-700">{fmtCurrency(p.net_salary)}</td>
                      <td className="px-3 py-2">{statusBadge(p.status)}</td>
                      <td className="px-3 py-2">
                        {p.pdf_key ? (
                          <span className="text-xs text-green-600 font-semibold">✓ PDF</span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {/* Run payroll modal */}
      <Modal open={showRunModal} onClose={() => setShowRunModal(false)} title="Run Payroll">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            This will calculate payslips for all staff with salary config based on attendance and leave data.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Month</label>
              <select
                value={runMonth}
                onChange={(e) => setRunMonth(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {MONTHS.map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
              <select
                value={runYear}
                onChange={(e) => setRunYear(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
          <button
            onClick={() => runMut.mutate({ month: runMonth, year: runYear })}
            disabled={runMut.isPending}
            className="w-full bg-teal-700 text-white py-2.5 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50 transition-colors"
          >
            {runMut.isPending ? "Processing..." : `Run Payroll for ${fmtMonth(runMonth)} ${runYear}`}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// ─── TAB 2: Salary Configuration ─────────────────────────────────────────────

function SalaryConfigTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedStaff, setSelectedStaff] = useState<StaffForPayroll | null>(null);
  const [formData, setFormData] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);

  const { data: staffRaw, isLoading: staffLoading } = useQuery({
    queryKey: ["payroll-staff", search],
    queryFn: () => getStaffForPayroll({ search: search || undefined }),
    enabled: search.length >= 2 || search === "",
  });
  const staffList = unwrap<StaffForPayroll[]>(staffRaw) ?? [];

  const { data: configRaw, isLoading: configLoading } = useQuery({
    queryKey: ["salary-config", selectedStaff?.uid],
    queryFn: () => getStaffSalaryConfig(selectedStaff!.uid),
    enabled: !!selectedStaff?.uid,
  });
  const config = unwrap<StaffSalaryConfig | null>(configRaw);

  // Prefill form when config loads
  React.useEffect(() => {
    if (config) {
      setFormData({
        basic_salary: config.basic_salary ?? "",
        hra_pct: config.hra_pct ?? "40",
        da_pct: config.da_pct ?? "10",
        special_allowance: config.special_allowance ?? "0",
        transport_allowance: config.transport_allowance ?? "0",
        medical_allowance: config.medical_allowance ?? "0",
        pf_employee_pct: config.pf_employee_pct ?? "12",
        esi_applicable: config.esi_applicable ?? false,
        professional_tax: config.professional_tax ?? "200",
        tds_monthly: config.tds_monthly ?? "0",
        designation: config.designation ?? "",
        department: config.department ?? "",
        employee_id: config.employee_id ?? "",
        date_of_joining: config.date_of_joining ? config.date_of_joining.split("T")[0] : "",
        pan_number: "",  // never prefill masked sensitive data
        pf_uan: config.pf_uan ?? "",
        bank_account: "",  // never prefill masked
        bank_name: config.bank_name ?? "",
        bank_ifsc: config.bank_ifsc ?? "",
      });
    } else if (selectedStaff && !configLoading) {
      setFormData({
        basic_salary: "",
        hra_pct: "40",
        da_pct: "10",
        special_allowance: "0",
        transport_allowance: "0",
        medical_allowance: "0",
        pf_employee_pct: "12",
        esi_applicable: false,
        professional_tax: "200",
        tds_monthly: "0",
        designation: "",
        department: "",
        employee_id: "",
        date_of_joining: "",
        pan_number: "",
        pf_uan: "",
        bank_account: "",
        bank_name: "",
        bank_ifsc: "",
      });
    }
  }, [config, configLoading, selectedStaff]);

  const handleSave = async () => {
    if (!selectedStaff) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formData)) {
        if (v !== "" && v !== null) payload[k] = v;
      }
      await upsertSalaryConfig(selectedStaff.uid, payload);
      toast.success("Salary config saved");
      qc.invalidateQueries({ queryKey: ["salary-config", selectedStaff.uid] });
      qc.invalidateQueries({ queryKey: ["payroll-staff"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: string, type = "number", hint?: string) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}{hint ? <span className="text-gray-400 ml-1">({hint})</span> : null}
      </label>
      <input
        type={type}
        value={String(formData[key] ?? "")}
        onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.value }))}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        placeholder={type === "number" ? "0" : ""}
      />
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* Staff List */}
      <div className="md:col-span-1">
        <h3 className="font-semibold text-gray-700 mb-3">Select Staff</h3>
        <input
          type="text"
          placeholder="Search by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        {staffLoading ? (
          <div className="text-center py-4 text-gray-400 text-sm">Loading...</div>
        ) : (
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {staffList.map((s) => (
              <button
                key={s.uid}
                onClick={() => setSelectedStaff(s)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  selectedStaff?.uid === s.uid
                    ? "bg-teal-50 border border-teal-300 text-teal-800"
                    : "hover:bg-gray-50 border border-transparent"
                }`}
              >
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-gray-500 flex items-center gap-2">
                  <span>{s.department ?? s.role}</span>
                  {s.has_salary_config ? (
                    <span className="text-green-600">✓ Configured</span>
                  ) : (
                    <span className="text-orange-500">⚠ No config</span>
                  )}
                </div>
              </button>
            ))}
            {!staffLoading && staffList.length === 0 && (
              <div className="text-sm text-gray-400 text-center py-4">
                {search ? "No staff found" : "Start typing to search"}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Salary Config Form */}
      <div className="md:col-span-2">
        {!selectedStaff ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-center py-16">
            <div>
              <div className="text-4xl mb-3">💼</div>
              <div>Select a staff member to configure their salary</div>
            </div>
          </div>
        ) : configLoading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">Loading config...</div>
        ) : (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-lg">
                {selectedStaff.name[0]}
              </div>
              <div>
                <div className="font-bold">{selectedStaff.name}</div>
                <div className="text-xs text-gray-500">{selectedStaff.department} · {selectedStaff.role}</div>
              </div>
            </div>

            <div className="space-y-4">
              {/* Salary Components */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">💰 Salary Components (Monthly ₹)</h4>
                <div className="grid grid-cols-2 gap-3">
                  {field("Basic Salary *", "basic_salary")}
                  {field("HRA %", "hra_pct", "number", "% of basic")}
                  {field("DA %", "da_pct", "number", "% of basic")}
                  {field("Special Allowance", "special_allowance")}
                  {field("Transport Allowance", "transport_allowance")}
                  {field("Medical Allowance", "medical_allowance")}
                </div>
              </div>

              {/* Deductions */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">📉 Deductions</h4>
                <div className="grid grid-cols-2 gap-3">
                  {field("PF Employee %", "pf_employee_pct", "number", "% of basic")}
                  {field("Professional Tax ₹", "professional_tax")}
                  {field("TDS Monthly ₹", "tds_monthly")}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">ESI Applicable</label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.esi_applicable === true || formData.esi_applicable === "true"}
                        onChange={(e) => setFormData((f) => ({ ...f, esi_applicable: e.target.checked }))}
                        className="w-4 h-4 text-teal-600"
                      />
                      <span className="text-sm text-gray-600">Yes (gross &lt; ₹21,000)</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Employment Details */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">👤 Employment Details</h4>
                <div className="grid grid-cols-2 gap-3">
                  {field("Designation", "designation", "text")}
                  {field("Department", "department", "text")}
                  {field("Employee ID", "employee_id", "text")}
                  {field("Date of Joining", "date_of_joining", "date")}
                  {field("PF UAN", "pf_uan", "text")}
                  {field("PAN Number", "pan_number", "text", "full value required")}
                </div>
              </div>

              {/* Bank Details */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">🏦 Bank Details</h4>
                {config?.bank_account && (
                  <div className="text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded-lg p-2 mb-2">
                    Existing bank account: {config.bank_account} — enter new value only if changing
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {field("Account Number", "bank_account", "text", "leave blank to keep existing")}
                  {field("Bank Name", "bank_name", "text")}
                  {field("IFSC Code", "bank_ifsc", "text")}
                </div>
              </div>

              <button
                onClick={handleSave}
                disabled={saving || !formData.basic_salary}
                className="w-full bg-teal-700 text-white py-2.5 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save Salary Configuration"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TAB 3: Salary Revisions ──────────────────────────────────────────────────

function RevisionsTab() {
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState<"pending_hr" | "pending_admin" | "annual_review" | "history">("pending_hr");
  const [showProposeModal, setShowProposeModal] = useState(false);
  const [prefilledStaff, setPrefilledStaff] = useState<AnnualReviewStaff | null>(null);
  const [signModal, setSignModal] = useState<{ id: number; type: "hr" | "admin" | "reject" } | null>(null);
  const [signComment, setSignComment] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  // Propose form state
  const [proposeData, setProposeData] = useState({
    staff_uid: "",
    revision_type: "increment",
    proposed_basic: "",
    increment_pct: "",
    bonus_amount: "",
    bonus_reason: "",
    effective_from: new Date().toISOString().split("T")[0],
    reason: "",
  });

  const { data: pendingHRRaw } = useQuery({
    queryKey: ["revisions", "pending_hr"],
    queryFn: () => getRevisions({ status: "pending_hr" }),
    enabled: subTab === "pending_hr",
  });
  const pendingHR = unwrap<SalaryRevision[]>(pendingHRRaw) ?? [];

  const { data: pendingAdminRaw } = useQuery({
    queryKey: ["revisions", "pending_admin"],
    queryFn: () => getRevisions({ status: "pending_admin" }),
    enabled: subTab === "pending_admin",
  });
  const pendingAdmin = unwrap<SalaryRevision[]>(pendingAdminRaw) ?? [];

  const { data: annualRaw } = useQuery({
    queryKey: ["annual-review"],
    queryFn: () => getAnnualReviewStatus(),
    enabled: subTab === "annual_review",
  });
  const annualData = unwrap<{ year: number; staff: AnnualReviewStaff[] }>(annualRaw);

  const { data: historyRaw } = useQuery({
    queryKey: ["revisions", "history"],
    queryFn: () => getRevisions({ limit: 100 }),
    enabled: subTab === "history",
  });
  const history = unwrap<SalaryRevision[]>(historyRaw) ?? [];

  const { data: staffRaw } = useQuery({
    queryKey: ["payroll-staff-all"],
    queryFn: () => getStaffForPayroll(),
    enabled: showProposeModal,
  });
  const staffList = unwrap<StaffForPayroll[]>(staffRaw) ?? [];

  const proposeMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => proposeRevision(data),
    onSuccess: () => {
      toast.success("Revision proposed — awaiting HR signature");
      qc.invalidateQueries({ queryKey: ["revisions"] });
      setShowProposeModal(false);
      setProposeData({
        staff_uid: "", revision_type: "increment", proposed_basic: "",
        increment_pct: "", bonus_amount: "", bonus_reason: "",
        effective_from: new Date().toISOString().split("T")[0], reason: "",
      });
      setPrefilledStaff(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hrSignMut = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => hrSignRevision(id, { comment }),
    onSuccess: () => {
      toast.success("HR signature applied");
      qc.invalidateQueries({ queryKey: ["revisions"] });
      setSignModal(null);
      setSignComment("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const adminSignMut = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => adminSignRevision(id, { comment }),
    onSuccess: () => {
      toast.success("Admin countersign complete — revision approved");
      qc.invalidateQueries({ queryKey: ["revisions"] });
      setSignModal(null);
      setSignComment("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const arrearsMut = useMutation({
    mutationFn: (id: number) => calculateArrears(id),
    onSuccess: (res) => {
      const d = (res as { data?: { arrears_amount?: number; months?: number; message?: string } }).data;
      if (d?.arrears_amount && d.arrears_amount > 0) {
        toast.success(`Arrears calculated: ₹${d.arrears_amount.toLocaleString("en-IN")} over ${d.months} months`);
      } else {
        toast.success(d?.message ?? "No arrears found");
      }
    },
    onError: () => toast.error("Failed to calculate arrears"),
  });

  const applyMut = useMutation({
    mutationFn: (id: number) => applyRevision(id),
    onSuccess: () => {
      toast.success("Revision applied to staff salary");
      qc.invalidateQueries({ queryKey: ["revisions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      rejectRevision(id, { reason }),
    onSuccess: () => {
      toast.success("Revision rejected");
      qc.invalidateQueries({ queryKey: ["revisions"] });
      setSignModal(null);
      setRejectReason("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const subTabs = [
    { key: "pending_hr", label: `Pending HR Sign (${pendingHR.length})` },
    { key: "pending_admin", label: `Pending Admin Sign (${pendingAdmin.length})` },
    { key: "annual_review", label: "Annual Review Due" },
    { key: "history", label: "History" },
  ] as const;

  const RevisionRow = ({ rev, showHRSign = false, showAdminSign = false }: {
    rev: SalaryRevision;
    showHRSign?: boolean;
    showAdminSign?: boolean;
  }) => (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-3">
        <div className="font-medium text-sm">{rev.revision_number}</div>
        <div className="text-xs text-gray-400">{fmtDate(rev.created_at)}</div>
      </td>
      <td className="px-3 py-3">
        <div className="font-medium text-sm">{rev.staff_name}</div>
        <div className="text-xs text-gray-400">{rev.department}</div>
      </td>
      <td className="px-3 py-3">
        <span className="capitalize text-xs font-semibold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
          {rev.revision_type}
        </span>
      </td>
      <td className="px-3 py-3 text-sm">
        {rev.revision_type === "bonus" ? (
          <span>{fmtCurrency(rev.bonus_amount)} bonus</span>
        ) : rev.proposed_basic ? (
          <span>
            {fmtCurrency(rev.current_basic)} → {fmtCurrency(rev.proposed_basic)}
            {rev.increment_pct ? <span className="text-green-600 ml-1">+{rev.increment_pct}%</span> : null}
          </span>
        ) : (
          <span className="text-gray-400">Component change</span>
        )}
      </td>
      <td className="px-3 py-3 text-sm text-gray-500">{fmtDate(rev.effective_from)}</td>
      <td className="px-3 py-3">{statusBadge(rev.status)}</td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-1 flex-wrap">
          {showHRSign && (
            <>
              <button
                onClick={() => setSignModal({ id: rev.id, type: "hr" })}
                className="text-xs bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700"
              >
                HR Sign
              </button>
              <button
                onClick={() => setSignModal({ id: rev.id, type: "reject" })}
                className="text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600"
              >
                Reject
              </button>
            </>
          )}
          {showAdminSign && (
            <>
              <button
                onClick={() => setSignModal({ id: rev.id, type: "admin" })}
                className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700"
              >
                Countersign
              </button>
              <button
                onClick={() => setSignModal({ id: rev.id, type: "reject" })}
                className="text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600"
              >
                Reject
              </button>
            </>
          )}
          {rev.status === "approved" && (
            <button
              onClick={() => applyMut.mutate(rev.id)}
              disabled={applyMut.isPending}
              className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 disabled:opacity-50"
            >
              Apply
            </button>
          )}
          {rev.status === "applied" && (
            <button
              onClick={() => arrearsMut.mutate(rev.id)}
              disabled={arrearsMut.isPending}
              className="text-xs bg-amber-500 text-white px-2 py-1 rounded hover:bg-amber-600 disabled:opacity-50"
              title="Calculate backdated arrears for this revision"
            >
              Calc Arrears
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  const RevisionTable = ({ revisions, showHRSign = false, showAdminSign = false }: {
    revisions: SalaryRevision[];
    showHRSign?: boolean;
    showAdminSign?: boolean;
  }) => (
    revisions.length === 0 ? (
      <div className="text-center py-10 text-gray-400">No revisions found</div>
    ) : (
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Ref #", "Staff", "Type", "Change", "Effective", "Status", "Actions"].map((h) => (
                <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {revisions.map((rev) => (
              <RevisionRow
                key={rev.id}
                rev={rev}
                showHRSign={showHRSign}
                showAdminSign={showAdminSign}
              />
            ))}
          </tbody>
        </table>
      </div>
    )
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-lg text-gray-800">Salary Revisions</h2>
        <button
          onClick={() => { setPrefilledStaff(null); setShowProposeModal(true); }}
          className="bg-teal-700 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-teal-800 transition-colors"
        >
          + Propose Revision
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-4 border-b overflow-x-auto">
        {subTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
              subTab === t.key
                ? "border-b-2 border-teal-600 text-teal-700"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {subTab === "pending_hr" && (
        <RevisionTable revisions={pendingHR} showHRSign />
      )}
      {subTab === "pending_admin" && (
        <div>
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            ⚠ <strong>Note:</strong> The Admin countersignatory cannot be the same person who applied the HR signature.
          </div>
          <RevisionTable revisions={pendingAdmin} showAdminSign />
        </div>
      )}
      {subTab === "annual_review" && (
        <div>
          <div className="text-sm text-gray-600 mb-4">
            Staff who have been employed for 11+ months and have not received a salary revision this year.
          </div>
          {!annualData?.staff?.length ? (
            <div className="text-center py-10 text-gray-400">All staff reviewed for {annualData?.year ?? "this year"}</div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {["Staff", "Dept", "Joined", "Years", "Basic", "Revision This Year", "Action"].map((h) => (
                      <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {annualData.staff.map((s) => (
                    <tr key={s.uid} className="hover:bg-gray-50">
                      <td className="px-3 py-3 font-medium">{s.name}</td>
                      <td className="px-3 py-3 text-gray-500">{s.department}</td>
                      <td className="px-3 py-3 text-gray-500">{fmtDate(s.date_of_joining)}</td>
                      <td className="px-3 py-3">{Number(s.years_of_service).toFixed(0)} yrs</td>
                      <td className="px-3 py-3">{fmtCurrency(s.basic_salary)}</td>
                      <td className="px-3 py-3">
                        {s.revision_this_year ? (
                          <span className="text-green-600 text-xs font-semibold">{s.revision_this_year}</span>
                        ) : (
                          <span className="text-orange-500 text-xs">None</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {!s.revision_this_year && (
                          <button
                            onClick={() => {
                              setPrefilledStaff(s);
                              setProposeData((d) => ({
                                ...d,
                                staff_uid: s.uid,
                                revision_type: "increment",
                              }));
                              setShowProposeModal(true);
                            }}
                            className="text-xs bg-teal-600 text-white px-3 py-1 rounded hover:bg-teal-700"
                          >
                            Initiate Review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {subTab === "history" && (
        <RevisionTable revisions={history} />
      )}

      {/* Sign / Reject modal */}
      <Modal
        open={!!signModal}
        onClose={() => { setSignModal(null); setSignComment(""); setRejectReason(""); }}
        title={
          signModal?.type === "hr"
            ? "Apply HR Signature"
            : signModal?.type === "admin"
            ? "Admin Countersign"
            : "Reject Revision"
        }
      >
        {signModal?.type === "reject" ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Please provide a reason for rejection:</p>
            <textarea
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={() => signModal && rejectMut.mutate({ id: signModal.id, reason: rejectReason })}
              disabled={rejectMut.isPending || !rejectReason.trim()}
              className="w-full bg-red-600 text-white py-2 rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50"
            >
              {rejectMut.isPending ? "Rejecting..." : "Confirm Rejection"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              {signModal?.type === "hr"
                ? "You are applying the first HR countersign. The revision will move to admin approval."
                : "You are applying the final admin countersign. This will approve the revision for application."}
            </p>
            <textarea
              rows={3}
              value={signComment}
              onChange={(e) => setSignComment(e.target.value)}
              placeholder="Optional comment..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={() => {
                if (!signModal) return;
                if (signModal.type === "hr") {
                  hrSignMut.mutate({ id: signModal.id, comment: signComment });
                } else {
                  adminSignMut.mutate({ id: signModal.id, comment: signComment });
                }
              }}
              disabled={hrSignMut.isPending || adminSignMut.isPending}
              className="w-full bg-teal-700 text-white py-2 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50"
            >
              {hrSignMut.isPending || adminSignMut.isPending
                ? "Signing..."
                : signModal?.type === "hr"
                ? "Apply HR Signature"
                : "Apply Admin Countersign"}
            </button>
          </div>
        )}
      </Modal>

      {/* Propose revision modal */}
      <Modal
        open={showProposeModal}
        onClose={() => { setShowProposeModal(false); setPrefilledStaff(null); }}
        title="Propose Salary Revision"
        maxW="max-w-2xl"
      >
        <div className="space-y-4">
          {prefilledStaff && (
            <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 text-sm">
              <strong>{prefilledStaff.name}</strong> · {prefilledStaff.department} ·
              Current basic: {fmtCurrency(prefilledStaff.basic_salary)}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Staff Member *</label>
            <select
              value={proposeData.staff_uid}
              onChange={(e) => setProposeData((d) => ({ ...d, staff_uid: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Select staff...</option>
              {staffList.map((s) => (
                <option key={s.uid} value={s.uid}>{s.name} ({s.department})</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Revision Type *</label>
              <select
                value={proposeData.revision_type}
                onChange={(e) => setProposeData((d) => ({ ...d, revision_type: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="increment">Increment</option>
                <option value="bonus">Bonus</option>
                <option value="deduction_change">Deduction Change</option>
                <option value="component_change">Component Change</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Effective From *</label>
              <input
                type="date"
                value={proposeData.effective_from}
                onChange={(e) => setProposeData((d) => ({ ...d, effective_from: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {proposeData.revision_type === "increment" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Proposed Basic Salary ₹</label>
                <input
                  type="number"
                  value={proposeData.proposed_basic}
                  onChange={(e) => {
                    const newBasic = e.target.value;
                    const pct = prefilledStaff?.basic_salary && newBasic
                      ? (((parseFloat(newBasic) - parseFloat(prefilledStaff.basic_salary)) / parseFloat(prefilledStaff.basic_salary)) * 100).toFixed(2)
                      : "";
                    setProposeData((d) => ({ ...d, proposed_basic: newBasic, increment_pct: pct }));
                  }}
                  placeholder="0"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Increment % (auto-calc)</label>
                <input
                  type="number"
                  value={proposeData.increment_pct}
                  onChange={(e) => setProposeData((d) => ({ ...d, increment_pct: e.target.value }))}
                  placeholder="0.00"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50"
                />
              </div>
            </div>
          )}

          {proposeData.revision_type === "bonus" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Bonus Amount ₹ *</label>
                <input
                  type="number"
                  value={proposeData.bonus_amount}
                  onChange={(e) => setProposeData((d) => ({ ...d, bonus_amount: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Bonus Reason</label>
                <input
                  type="text"
                  value={proposeData.bonus_reason}
                  onChange={(e) => setProposeData((d) => ({ ...d, bonus_reason: e.target.value }))}
                  placeholder="Performance bonus, Diwali, etc."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Reason / Justification *</label>
            <textarea
              rows={3}
              value={proposeData.reason}
              onChange={(e) => setProposeData((d) => ({ ...d, reason: e.target.value }))}
              placeholder="Describe the reason for this revision..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={() => {
              const payload: Record<string, unknown> = {
                staff_uid: proposeData.staff_uid,
                revision_type: proposeData.revision_type,
                effective_from: proposeData.effective_from,
                reason: proposeData.reason,
              };
              if (proposeData.proposed_basic) payload.proposed_basic = parseFloat(proposeData.proposed_basic);
              if (proposeData.increment_pct) payload.increment_pct = parseFloat(proposeData.increment_pct);
              if (proposeData.bonus_amount) payload.bonus_amount = parseFloat(proposeData.bonus_amount);
              if (proposeData.bonus_reason) payload.bonus_reason = proposeData.bonus_reason;
              proposeMut.mutate(payload);
            }}
            disabled={proposeMut.isPending || !proposeData.staff_uid || !proposeData.reason}
            className="w-full bg-teal-700 text-white py-2.5 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50 transition-colors"
          >
            {proposeMut.isPending ? "Submitting..." : "Submit Revision Proposal"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// ─── TAB 4: Tools (Exports, Tax Summary, Advances, Arrears) ──────────────────

interface Advance {
  id: number;
  staff_name: string;
  department: string | null;
  amount: string;
  monthly_deduction: string;
  total_deducted: string;
  balance_remaining: string;
  status: string;
  deduction_start_month: number;
  deduction_start_year: number;
  reason: string;
  created_at: string;
}

function ToolsTab() {
  const queryClient = useQueryClient();
  const now = new Date();
  const [exportMonth, setExportMonth] = useState(now.getMonth() + 1);
  const [exportYear, setExportYear] = useState(now.getFullYear());
  const [taxFY, setTaxFY] = useState(() => {
    const m = now.getMonth();
    const y = now.getFullYear();
    return m >= 3 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
  });
  const [showAdvanceForm, setShowAdvanceForm] = useState(false);
  const [advanceForm, setAdvanceForm] = useState({
    staff_uid: "", amount: "", reason: "", monthly_deduction: "",
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
      const d = (res as { data?: { generated?: number; failed?: number } }).data;
      toast.success(`Generated for ${d?.generated ?? 0} staff (${d?.failed ?? 0} failed)`);
    },
    onError: () => toast.error("Failed to generate tax summaries"),
  });

  const advanceMut = useMutation({
    mutationFn: () => createAdvance({
      ...advanceForm,
      amount: parseFloat(advanceForm.amount),
      monthly_deduction: parseFloat(advanceForm.monthly_deduction),
      deduction_start_month: parseInt(advanceForm.deduction_start_month),
      deduction_start_year: parseInt(advanceForm.deduction_start_year),
    }),
    onSuccess: () => {
      toast.success("Advance created successfully");
      setShowAdvanceForm(false);
      setAdvanceForm({ staff_uid: "", amount: "", reason: "", monthly_deduction: "",
        deduction_start_month: String(now.getMonth() + 1), deduction_start_year: String(now.getFullYear()), notes: "" });
      queryClient.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: () => toast.error("Failed to create advance"),
  });

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);
  const fyOptions = Array.from({ length: 3 }, (_, i) => {
    const s = now.getMonth() >= 3 ? now.getFullYear() - i : now.getFullYear() - 1 - i;
    return `${s}-${String(s + 1).slice(-2)}`;
  });

  function downloadWithAuth(url: string) {
    // Open direct download — auth is via session cookie
    window.open(url, "_blank");
  }

  return (
    <div className="space-y-6">
      {/* ── Export Section ── */}
      <div className="bg-white rounded-xl border p-6">
        <h2 className="font-bold text-lg text-gray-800 mb-4">📥 Export Payroll Data</h2>
        <div className="flex gap-3 mb-4 flex-wrap">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Month</label>
            <select
              value={exportMonth}
              onChange={(e) => setExportMonth(Number(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {months.map((m, i) => (
                <option key={i + 1} value={i + 1}>{m}</option>
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
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => downloadWithAuth(exportPayrollSummaryUrl(exportMonth, exportYear))}
            className="flex items-center gap-2 px-4 py-2.5 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors"
          >
            📊 Payroll Summary CSV
          </button>
          <button
            onClick={() => downloadWithAuth(exportPFRegisterUrl(exportMonth, exportYear))}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            🏦 PF ECR Register
          </button>
          <button
            onClick={() => downloadWithAuth(exportESIRegisterUrl(exportMonth, exportYear))}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            🏥 ESI Register
          </button>
        </div>
      </div>

      {/* ── Annual Tax Summary ── */}
      <div className="bg-white rounded-xl border p-6">
        <h2 className="font-bold text-lg text-gray-800 mb-4">🧾 Annual Tax Summary (Form 16 basis)</h2>
        <p className="text-sm text-gray-500 mb-4">
          Generate Form 16 / annual tax summaries for all staff based on their issued payslips for the financial year.
          Uses New Tax Regime slabs.
        </p>
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Financial Year</label>
            <select
              value={taxFY}
              onChange={(e) => setTaxFY(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>FY {fy}</option>
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
      <div className="bg-white rounded-xl border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg text-gray-800">💳 Salary Advances / Loans</h2>
          <button
            onClick={() => setShowAdvanceForm(!showAdvanceForm)}
            className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors"
          >
            {showAdvanceForm ? "Cancel" : "+ Add Advance"}
          </button>
        </div>

        {showAdvanceForm && (
          <div className="mb-6 p-4 bg-teal-50 rounded-xl border border-teal-200">
            <h3 className="font-semibold text-sm text-teal-800 mb-3">New Salary Advance</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="text-xs text-gray-500 block mb-1">Staff UID</label>
                <input
                  type="text"
                  placeholder="staff-uid-here"
                  value={advanceForm.staff_uid}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, staff_uid: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Amount (₹)</label>
                <input
                  type="number"
                  placeholder="50000"
                  value={advanceForm.amount}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, amount: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Monthly Deduction (₹)</label>
                <input
                  type="number"
                  placeholder="5000"
                  value={advanceForm.monthly_deduction}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, monthly_deduction: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Start Month</label>
                <select
                  value={advanceForm.deduction_start_month}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, deduction_start_month: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  {months.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Start Year</label>
                <select
                  value={advanceForm.deduction_start_year}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, deduction_start_year: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <label className="text-xs text-gray-500 block mb-1">Reason</label>
                <input
                  type="text"
                  placeholder="Medical emergency, personal reason..."
                  value={advanceForm.reason}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, reason: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="col-span-2 sm:col-span-3">
                <label className="text-xs text-gray-500 block mb-1">Notes (optional)</label>
                <input
                  type="text"
                  placeholder="Additional notes..."
                  value={advanceForm.notes}
                  onChange={(e) => setAdvanceForm({ ...advanceForm, notes: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            {advanceForm.amount && advanceForm.monthly_deduction && (
              <p className="text-xs text-teal-700 mt-2">
                Approx. {Math.ceil(parseFloat(advanceForm.amount) / parseFloat(advanceForm.monthly_deduction))} monthly deductions of ₹{parseFloat(advanceForm.monthly_deduction).toLocaleString("en-IN")}
              </p>
            )}
            <button
              onClick={() => advanceMut.mutate()}
              disabled={advanceMut.isPending || !advanceForm.staff_uid || !advanceForm.amount || !advanceForm.reason || !advanceForm.monthly_deduction}
              className="mt-3 px-5 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50 transition-colors"
            >
              {advanceMut.isPending ? "Saving..." : "Approve Advance"}
            </button>
          </div>
        )}

        {advancesLoading ? (
          <div className="text-center py-8 text-gray-400">Loading...</div>
        ) : advances.length === 0 ? (
          <div className="text-center py-8 text-gray-400">No salary advances on record</div>
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
              <tbody className="divide-y divide-gray-100 bg-white">
                {advances.map((adv) => (
                  <tr key={adv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{adv.staff_name}</div>
                      <div className="text-xs text-gray-500">{adv.department ?? "—"}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">₹{parseFloat(adv.amount).toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-right">₹{parseFloat(adv.monthly_deduction).toLocaleString("en-IN")}/mo</td>
                    <td className="px-4 py-3 text-right text-orange-600">₹{parseFloat(adv.total_deducted).toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-right font-semibold text-red-600">₹{parseFloat(adv.balance_remaining).toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate" title={adv.reason}>{adv.reason}</td>
                    <td className="px-4 py-3">
                      {statusBadge(adv.status)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Arrears note ── */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <strong>💡 Arrears:</strong> To calculate arrears for a backdated salary revision, go to <strong>Salary Revisions</strong> tab → select an applied revision → the system will compute and create the arrears record automatically when you click &quot;Calculate Arrears&quot;. Arrears are paid automatically in the next payroll run.
      </div>

      {/* ── Leave Encashment Calculator ── */}
      <LeaveEncashmentToolWidget />
    </div>
  );
}

function LeaveEncashmentToolWidget() {
  const { data: staffRaw } = useQuery({
    queryKey: ["staff-for-payroll"],
    queryFn: () => getStaffForPayroll(),
  });
  const staff = unwrap<StaffForPayroll[]>(staffRaw) ?? [];
  return <LeaveEncashmentCalculator staff={staff} />;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PayrollPage() {
  const [tab, setTab] = useState<"runs" | "salary" | "revisions" | "tools" | "compliance">("runs");

  const tabs = [
    { key: "runs", label: "📊 Payroll Runs" },
    { key: "salary", label: "💰 Salary Config" },
    { key: "revisions", label: "📝 Salary Revisions" },
    { key: "tools", label: "🛠️ Tools" },
    { key: "compliance", label: "⚖️ Compliance" },
  ] as const;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payroll & HR Compensation</h1>
          <p className="text-gray-500 mt-1">Manage payroll runs, salary configuration, and revision workflows</p>
        </div>
        <a
          href="/dashboard/payroll/comparison"
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium"
        >
          📊 Payroll Comparison
        </a>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-3 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-b-2 border-teal-600 text-teal-700 bg-teal-50/50"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === "runs" && <PayrollRunsTab />}
        {tab === "salary" && <SalaryConfigTab />}
        {tab === "revisions" && <RevisionsTab />}
        {tab === "tools" && <ToolsTab />}
        {tab === "compliance" && <ComplianceTab />}
      </div>
    </div>
  );
}

// ─── Run Actions component (HR sign → Admin sign → Issue) ────────────────────
interface RunActionsProps {
  run: PayrollRun;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  issueMut: any;
}

function RunActions({ run, issueMut }: RunActionsProps) {
  const qc = useQueryClient();
  const [showComment, setShowComment] = useState<'hr' | 'admin' | null>(null);
  const [comment, setComment] = useState('');

  const hrSignMut = useMutation({
    mutationFn: (c: string) => hrSignPayrollRun(String(run.id), { comment: c }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.success('HR signature applied'); setShowComment(null); setComment(''); },
    onError: (e: Error) => toast.error(e.message),
  });

  const adminSignMut = useMutation({
    mutationFn: (c: string) => adminSignPayrollRun(String(run.id), { comment: c }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.success('Admin countersign complete — ready to issue'); setShowComment(null); setComment(''); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Completed but not HR-signed
  if (run.status === 'completed' && !run.hr_approved_at) {
    return showComment === 'hr' ? (
      <div className="flex flex-col gap-1 min-w-[200px]">
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="HR comment (optional)" className="text-xs border rounded px-2 py-1" />
        <div className="flex gap-1">
          <button onClick={() => hrSignMut.mutate(comment)} disabled={hrSignMut.isPending} className="text-xs bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700 disabled:opacity-50">
            {hrSignMut.isPending ? '…' : 'Confirm HR Sign'}
          </button>
          <button onClick={() => setShowComment(null)} className="text-xs border px-2 py-1 rounded">Cancel</button>
        </div>
      </div>
    ) : (
      <button onClick={() => setShowComment('hr')} className="text-xs bg-blue-600 text-white px-3 py-1 rounded-full hover:bg-blue-700">
        HR Sign
      </button>
    );
  }

  // HR signed but not Admin countersigned
  if (run.status === 'completed' && run.hr_approved_at && !run.admin_approved_at) {
    return showComment === 'admin' ? (
      <div className="flex flex-col gap-1 min-w-[200px]">
        <p className="text-xs text-gray-500">HR signed ✓</p>
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Admin comment (optional)" className="text-xs border rounded px-2 py-1" />
        <div className="flex gap-1">
          <button onClick={() => adminSignMut.mutate(comment)} disabled={adminSignMut.isPending} className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700 disabled:opacity-50">
            {adminSignMut.isPending ? '…' : 'Countersign'}
          </button>
          <button onClick={() => setShowComment(null)} className="text-xs border px-2 py-1 rounded">Cancel</button>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-teal-600">✓ HR Signed</span>
        <button onClick={() => setShowComment('admin')} className="text-xs bg-purple-600 text-white px-3 py-1 rounded-full hover:bg-purple-700">
          Admin Countersign
        </button>
      </div>
    );
  }

  // Both signed — ready to issue
  if (run.status === 'approved') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-teal-600">✓ HR + Admin signed</span>
        <button
          onClick={() => issueMut.mutate({ month: run.month, year: run.year })}
          disabled={issueMut.isPending}
          className="text-xs bg-green-600 text-white px-3 py-1 rounded-full hover:bg-green-700 disabled:opacity-50"
        >
          {issueMut.isPending ? 'Issuing…' : 'Issue to Staff'}
        </button>
      </div>
    );
  }

  // Locked/issued
  if (run.status === 'locked') {
    return <span className="text-xs text-green-600 font-medium">✓ Issued</span>;
  }

  return null;
}
