"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getGratuityStatus, type GratuityStatus } from "@/lib/api/payroll";
import { unwrap, fmtCurrency, fmtDate } from "./complianceHelpers";

export function GratuitySection() {
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
