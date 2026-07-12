// src/app/(with-auth)/dashboard/system-audit/page.tsx
//
// Orchestration-only: tab selector + three feature tabs. Each tab lives in
// its own file under ./components, types in ./auditTypes, shared helpers in
// ./components/auditHelpers.
"use client";

import { useState } from "react";
import { Activity, ClipboardList, Search, Shield, User } from "lucide-react";
import { LiveFeedTab } from "./components/LiveFeedTab";
import { LogSearchTab } from "./components/LogSearchTab";
import { UserHistoryTab } from "./components/UserHistoryTab";
import { ClinicalAuditTab } from "./components/ClinicalAuditTab";

const TABS = [
  { id: "live", label: "Live Feed", icon: <Activity className="h-4 w-4" /> },
  { id: "search", label: "Log Search", icon: <Search className="h-4 w-4" /> },
  { id: "user", label: "User History", icon: <User className="h-4 w-4" /> },
  {
    id: "clinical",
    label: "Clinical Audit",
    icon: <ClipboardList className="h-4 w-4" />,
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function SystemAuditPage() {
  const [activeTab, setActiveTab] = useState<TabId>("live");

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Shield className="h-6 w-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            System Audit Log
          </h1>
          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 text-xs rounded font-medium">
            ADMIN
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Review clinical actions, patient access, staff activity, request outcomes, and audit coverage
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b dark:border-gray-700">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "live" && <LiveFeedTab />}
      {activeTab === "search" && <LogSearchTab />}
      {activeTab === "user" && <UserHistoryTab />}
      {activeTab === "clinical" && <ClinicalAuditTab />}
    </div>
  );
}
