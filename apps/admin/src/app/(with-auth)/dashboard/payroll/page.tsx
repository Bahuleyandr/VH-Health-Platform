"use client";

import { useState } from "react";
import ComplianceTab from "./ComplianceTab";
import { PayrollRunsTab } from "./components/PayrollRunsTab";
import { RevisionsTab } from "./components/RevisionsTab";
import { SalaryConfigTab } from "./components/SalaryConfigTab";
import { ToolsTab } from "./components/ToolsTab";

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
