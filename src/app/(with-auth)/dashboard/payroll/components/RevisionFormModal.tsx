"use client";

import { useEffect, useState } from "react";
import type {
  AnnualReviewStaff,
  StaffForPayroll,
} from "@/lib/api/payroll";
import { Modal } from "./Modal";
import { fmtCurrency } from "./helpers";

export interface ProposePayload {
  staff_uid: string;
  revision_type: string;
  effective_from: string;
  reason: string;
  proposed_basic?: number;
  increment_pct?: number;
  bonus_amount?: number;
  bonus_reason?: string;
}

export function RevisionFormModal({
  open,
  onClose,
  prefilledStaff,
  staffList,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onClose: () => void;
  prefilledStaff: AnnualReviewStaff | null;
  staffList: StaffForPayroll[];
  onSubmit: (payload: ProposePayload) => void;
  isSubmitting: boolean;
}) {
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

  useEffect(() => {
    if (prefilledStaff) {
      setProposeData((d) => ({
        ...d,
        staff_uid: prefilledStaff.uid,
        revision_type: "increment",
      }));
    }
  }, [prefilledStaff]);

  const handleSubmit = () => {
    const payload: ProposePayload = {
      staff_uid: proposeData.staff_uid,
      revision_type: proposeData.revision_type,
      effective_from: proposeData.effective_from,
      reason: proposeData.reason,
    };
    if (proposeData.proposed_basic) payload.proposed_basic = parseFloat(proposeData.proposed_basic);
    if (proposeData.increment_pct) payload.increment_pct = parseFloat(proposeData.increment_pct);
    if (proposeData.bonus_amount) payload.bonus_amount = parseFloat(proposeData.bonus_amount);
    if (proposeData.bonus_reason) payload.bonus_reason = proposeData.bonus_reason;
    onSubmit(payload);
  };

  return (
    <Modal open={open} onClose={onClose} title="Propose Salary Revision" maxW="max-w-2xl">
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
          onClick={handleSubmit}
          disabled={isSubmitting || !proposeData.staff_uid || !proposeData.reason}
          className="w-full bg-teal-700 text-white py-2.5 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? "Submitting..." : "Submit Revision Proposal"}
        </button>
      </div>
    </Modal>
  );
}
