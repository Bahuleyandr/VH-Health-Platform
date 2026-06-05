// src/app/(with-auth)/dashboard/leave-approvals/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getLeaveApprovals,
  approveLeave,
  rejectLeave,
  hrApproveReplacement,
} from "@/lib/api/attendance";

type LeaveRequest = {
  id: number;
  staff_id?: number;
  staff_name?: string;
  name?: string;
  department?: string;
  leave_type?: string;
  start_date?: string;
  end_date?: string;
  total_days?: number;
  reason?: string;
  status?: string;
  created_at?: string;
  replacement_status?: string;
  replacement_name?: string;
};

type LeaveListResponse = {
  leaveRequests?: LeaveRequest[];
  data?: LeaveRequest[];
  leaves?: LeaveRequest[];
  leave_applications?: LeaveRequest[];
};

type ActiveTab = "pending" | "approved" | "rejected";

type ConfirmDialogProps = {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
};

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card rounded-xl p-6 shadow-lg max-w-sm w-full mx-4">
        <p className="text-sm text-gray-700 mb-4">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border text-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-primary text-white text-sm hover:opacity-90 transition-opacity"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

type StatusBadgeProps = { status: string };
function StatusBadge({ status }: StatusBadgeProps) {
  const s = (status ?? "").toLowerCase();
  const cls =
    s === "approved"
      ? "bg-green-100 text-green-700 border border-green-300"
      : s === "rejected"
        ? "bg-red-100 text-red-700 border border-red-300"
        : s === "pending"
          ? "bg-yellow-100 text-yellow-700 border border-yellow-300"
          : "bg-gray-100 text-gray-600 border border-gray-300";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {status?.toUpperCase() ?? "—"}
    </span>
  );
}

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function calcDays(start?: string, end?: string, totalDays?: number) {
  if (totalDays) return totalDays;
  if (!start || !end) return "—";
  const diff =
    (new Date(end).getTime() - new Date(start).getTime()) /
      (1000 * 60 * 60 * 24) +
    1;
  return Math.max(1, Math.round(diff));
}

export default function LeaveApprovalsPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("pending");
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{
    message: string;
    action: () => Promise<void>;
  } | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getLeaveApprovals({ status: activeTab });
      const data = result as LeaveListResponse | LeaveRequest[];
      let list: LeaveRequest[] = [];
      if (Array.isArray(data)) {
        list = data;
      } else if (data && typeof data === "object") {
        list =
          (data as LeaveListResponse).leaveRequests ??
          (data as LeaveListResponse).data ??
          (data as LeaveListResponse).leaves ??
          (data as LeaveListResponse).leave_applications ??
          [];
      }
      setLeaves(list);
    } catch {
      setLeaves([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = (id: number) => {
    setConfirm({
      message: "Approve this leave request?",
      action: async () => {
        setActionLoading(id);
        try {
          await approveLeave(String(id));
          showToast("✅ Leave approved", true);
          load();
        } catch {
          showToast("❌ Failed to approve", false);
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const handleReject = (id: number) => {
    setConfirm({
      message: "Reject this leave request?",
      action: async () => {
        setActionLoading(id);
        try {
          await rejectLeave(String(id));
          showToast("Leave rejected", true);
          load();
        } catch {
          showToast("❌ Failed to reject", false);
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const handleHRApproveReplacement = async (requestId: number) => {
    setActionLoading(requestId);
    try {
      await hrApproveReplacement(String(requestId));
      showToast("✅ Replacement HR-approved", true);
      load();
    } catch {
      showToast("❌ Failed to approve replacement", false);
    } finally {
      setActionLoading(null);
    }
  };

  const tabs: { key: ActiveTab; label: string }[] = [
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm shadow-lg transition-all ${
            toast.ok ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Confirm Dialog */}
      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={async () => {
            setConfirm(null);
            await confirm.action();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Leave Approvals</h1>
        <button
          onClick={load}
          className="text-sm px-3 py-1.5 rounded-lg border hover:bg-muted transition-colors"
        >
          🔄 Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border rounded-xl p-1 bg-muted/30 w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === t.key
                ? "bg-card shadow text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
      ) : leaves.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-4xl mb-3">📋</p>
          <p>No {activeTab} leave requests</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Staff</th>
                <th className="text-left px-4 py-3 font-medium">Leave Type</th>
                <th className="text-left px-4 py-3 font-medium">Dates</th>
                <th className="text-left px-4 py-3 font-medium">Days</th>
                <th className="text-left px-4 py-3 font-medium">Reason</th>
                <th className="text-left px-4 py-3 font-medium">Replacement</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                {activeTab === "pending" && (
                  <th className="text-left px-4 py-3 font-medium">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {leaves.map((leave) => {
                const replacementStatus = leave.replacement_status ?? "none";
                const replacementLabel =
                  replacementStatus === "hr_approved"
                    ? `✅ ${leave.replacement_name ?? "Confirmed"}`
                    : replacementStatus === "accepted"
                      ? `👍 ${leave.replacement_name ?? "Accepted"}`
                      : replacementStatus === "pending"
                        ? "⏳ Pending"
                        : "—";

                return (
                  <tr
                    key={leave.id}
                    className="hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium">
                        {leave.staff_name ?? leave.name ?? `#${leave.staff_id}`}
                      </p>
                      {leave.department && (
                        <p className="text-xs text-muted-foreground">
                          {leave.department}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize">
                      {(leave.leave_type ?? "—").replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDate(leave.start_date)} →{" "}
                      {formatDate(leave.end_date)}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold">
                      {calcDays(
                        leave.start_date,
                        leave.end_date,
                        leave.total_days,
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate text-muted-foreground">
                      {leave.reason ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs">{replacementLabel}</span>
                        {replacementStatus === "accepted" &&
                          activeTab === "pending" && (
                            <button
                              onClick={() =>
                                handleHRApproveReplacement(leave.id)
                              }
                              disabled={actionLoading === leave.id}
                              className="text-xs px-2 py-0.5 rounded border border-green-500 text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
                            >
                              HR Approve
                            </button>
                          )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={leave.status ?? "pending"} />
                    </td>
                    {activeTab === "pending" && (
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleApprove(leave.id)}
                            disabled={actionLoading === leave.id}
                            className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-semibold hover:bg-green-700 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === leave.id ? "…" : "Approve"}
                          </button>
                          <button
                            onClick={() => handleReject(leave.id)}
                            disabled={actionLoading === leave.id}
                            className="px-3 py-1.5 rounded-lg border border-red-500 text-red-600 text-xs font-semibold hover:bg-red-50 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === leave.id ? "…" : "Reject"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
