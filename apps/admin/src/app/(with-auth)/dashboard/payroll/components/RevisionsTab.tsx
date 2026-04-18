"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  adminSignRevision,
  applyRevision,
  calculateArrears,
  getAnnualReviewStatus,
  getRevisions,
  getStaffForPayroll,
  hrSignRevision,
  proposeRevision,
  rejectRevision,
  type AnnualReviewStaff,
  type SalaryRevision,
  type StaffForPayroll,
} from "@/lib/api/payroll";
import { fmtCurrency, fmtDate, statusBadge, unwrap } from "./helpers";
import { RevisionFormModal, type ProposePayload } from "./RevisionFormModal";
import { RevisionSignModal, type SignModalType } from "./RevisionSignModal";

// ── Revision row (inline; only used inside this file) ─────────────────────────

function RevisionRow({
  rev,
  showHRSign = false,
  showAdminSign = false,
  onSign,
  onReject,
  onApply,
  onArrears,
  applyPending,
  arrearsPending,
}: {
  rev: SalaryRevision;
  showHRSign?: boolean;
  showAdminSign?: boolean;
  onSign: (id: number, type: "hr" | "admin") => void;
  onReject: (id: number) => void;
  onApply: (id: number) => void;
  onArrears: (id: number) => void;
  applyPending: boolean;
  arrearsPending: boolean;
}) {
  return (
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
                onClick={() => onSign(rev.id, "hr")}
                className="text-xs bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700"
              >
                HR Sign
              </button>
              <button
                onClick={() => onReject(rev.id)}
                className="text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600"
              >
                Reject
              </button>
            </>
          )}
          {showAdminSign && (
            <>
              <button
                onClick={() => onSign(rev.id, "admin")}
                className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700"
              >
                Countersign
              </button>
              <button
                onClick={() => onReject(rev.id)}
                className="text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600"
              >
                Reject
              </button>
            </>
          )}
          {rev.status === "approved" && (
            <button
              onClick={() => onApply(rev.id)}
              disabled={applyPending}
              className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 disabled:opacity-50"
            >
              Apply
            </button>
          )}
          {rev.status === "applied" && (
            <button
              onClick={() => onArrears(rev.id)}
              disabled={arrearsPending}
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
}

// ── Revision table ────────────────────────────────────────────────────────────

function RevisionTable({
  revisions,
  showHRSign = false,
  showAdminSign = false,
  onSign,
  onReject,
  onApply,
  onArrears,
  applyPending,
  arrearsPending,
}: {
  revisions: SalaryRevision[];
  showHRSign?: boolean;
  showAdminSign?: boolean;
  onSign: (id: number, type: "hr" | "admin") => void;
  onReject: (id: number) => void;
  onApply: (id: number) => void;
  onArrears: (id: number) => void;
  applyPending: boolean;
  arrearsPending: boolean;
}) {
  if (revisions.length === 0) {
    return <div className="text-center py-10 text-gray-400">No revisions found</div>;
  }
  return (
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
              onSign={onSign}
              onReject={onReject}
              onApply={onApply}
              onArrears={onArrears}
              applyPending={applyPending}
              arrearsPending={arrearsPending}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export function RevisionsTab() {
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState<"pending_hr" | "pending_admin" | "annual_review" | "history">("pending_hr");
  const [showProposeModal, setShowProposeModal] = useState(false);
  const [prefilledStaff, setPrefilledStaff] = useState<AnnualReviewStaff | null>(null);
  const [signModal, setSignModal] = useState<{ id: number; type: SignModalType } | null>(null);

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
    mutationFn: (data: ProposePayload) => proposeRevision(data as unknown as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Revision proposed — awaiting HR signature");
      qc.invalidateQueries({ queryKey: ["revisions"] });
      setShowProposeModal(false);
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
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const adminSignMut = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => adminSignRevision(id, { comment }),
    onSuccess: () => {
      toast.success("Admin countersign complete — revision approved");
      qc.invalidateQueries({ queryKey: ["revisions"] });
      setSignModal(null);
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
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const subTabs = [
    { key: "pending_hr", label: `Pending HR Sign (${pendingHR.length})` },
    { key: "pending_admin", label: `Pending Admin Sign (${pendingAdmin.length})` },
    { key: "annual_review", label: "Annual Review Due" },
    { key: "history", label: "History" },
  ] as const;

  // Shared row handlers
  const handleSign = (id: number, type: "hr" | "admin") => setSignModal({ id, type });
  const handleReject = (id: number) => setSignModal({ id, type: "reject" });
  const handleApply = (id: number) => applyMut.mutate(id);
  const handleArrears = (id: number) => arrearsMut.mutate(id);
  const rowProps = {
    onSign: handleSign,
    onReject: handleReject,
    onApply: handleApply,
    onArrears: handleArrears,
    applyPending: applyMut.isPending,
    arrearsPending: arrearsMut.isPending,
  };

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
        <RevisionTable revisions={pendingHR} showHRSign {...rowProps} />
      )}
      {subTab === "pending_admin" && (
        <div>
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            ⚠ <strong>Note:</strong> The Admin countersignatory cannot be the same person who applied the HR signature.
          </div>
          <RevisionTable revisions={pendingAdmin} showAdminSign {...rowProps} />
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
        <RevisionTable revisions={history} {...rowProps} />
      )}

      {/* Sign / Reject modal */}
      <RevisionSignModal
        open={!!signModal}
        signType={signModal?.type ?? null}
        onClose={() => setSignModal(null)}
        onSign={(comment) => {
          if (!signModal) return;
          if (signModal.type === "hr") {
            hrSignMut.mutate({ id: signModal.id, comment });
          } else if (signModal.type === "admin") {
            adminSignMut.mutate({ id: signModal.id, comment });
          }
        }}
        onReject={(reason) => {
          if (!signModal) return;
          rejectMut.mutate({ id: signModal.id, reason });
        }}
        isSigning={hrSignMut.isPending || adminSignMut.isPending}
        isRejecting={rejectMut.isPending}
      />

      {/* Propose revision modal */}
      <RevisionFormModal
        open={showProposeModal}
        onClose={() => { setShowProposeModal(false); setPrefilledStaff(null); }}
        prefilledStaff={prefilledStaff}
        staffList={staffList}
        onSubmit={(payload) => proposeMut.mutate(payload)}
        isSubmitting={proposeMut.isPending}
      />
    </div>
  );
}
