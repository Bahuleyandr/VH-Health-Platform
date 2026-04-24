"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getAllDeclarations,
  approveDeclaration,
  type InvestmentDeclaration,
} from "@/lib/api/payroll";
import { unwrap, fmtCurrency, fmtDate, sum80C, sum80D } from "./complianceHelpers";

export function DeclarationsSection() {
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
