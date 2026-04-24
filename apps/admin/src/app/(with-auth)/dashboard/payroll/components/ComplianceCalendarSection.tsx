"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getComplianceCalendar,
  type ComplianceDeadline,
} from "@/lib/api/payroll";
import { unwrap, MONTHS, proxyDownloadHref } from "./complianceHelpers";

export function ComplianceCalendarSection() {
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
