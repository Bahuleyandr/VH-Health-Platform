"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getStaffForPayroll, type StaffForPayroll } from "@/lib/api/payroll";
import { unwrap } from "./components/complianceHelpers";
import { ComplianceCalendarSection } from "./components/ComplianceCalendarSection";
import { FnFSection } from "./components/FnFSection";
import { GratuitySection } from "./components/GratuitySection";
import { DeclarationsSection } from "./components/DeclarationsSection";
import { PayslipQueriesSection } from "./components/PayslipQueriesSection";
import { BulkRevisionsSection } from "./components/BulkRevisionsSection";

// LeaveEncashmentCalculator moved to components/LeaveEncashmentCalculator.tsx
// in the god-page split. Re-exported here so ToolsTab's existing
// `import { LeaveEncashmentCalculator } from "../ComplianceTab"` keeps working.
export { LeaveEncashmentCalculator } from "./components/LeaveEncashmentCalculator";

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
