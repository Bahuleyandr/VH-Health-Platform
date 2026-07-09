"use client";

/**
 * Compliance & HIPAA admin page.
 *
 * Thin tab orchestrator after the 2026-05-01 god-page split (the inline
 * ~517-LOC shape made adding the GDPR Art.30 / Art.33 dashboard tab
 * push past the 600-LOC god-page threshold called out in
 * `apps/admin/CLAUDE.md`).
 *
 * Tab content lives under `./components/`:
 *   - DashboardTab: read-only aggregate snapshot from
 *     GET /api/v1/compliance/dashboard (DPAs, DPIA pending, breach
 *     severity grid, regulator-pending Art.33 72h clock, GDPR erasure
 *     log + legal-hold counts).
 *   - BreachesTab: list + report + detail panel (HIPAA breach workflow).
 *   - AuditTab: free-text audit-log search.
 *
 * Stat cards belong with their tabs (each tab fetches its own data); this
 * page only owns title + tab-switcher state.
 */

import { useState } from "react";
import { BadgeCheck, ShieldAlert, FileText, LayoutDashboard } from "lucide-react";

import { DashboardTab } from "./components/DashboardTab";
import { BreachesTab } from "./components/BreachesTab";
import { AuditTab } from "./components/AuditTab";
import { CertificationCockpitTab } from "./components/CertificationCockpitTab";

type Tab = "dashboard" | "certification" | "breaches" | "audit";

const TABS: Array<{ key: Tab; label: string; icon: typeof ShieldAlert }> = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "certification", label: "Certification", icon: BadgeCheck },
  { key: "breaches", label: "Breach Notifications", icon: ShieldAlert },
  { key: "audit", label: "Audit Log Search", icon: FileText },
];

export default function CompliancePage() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <ShieldAlert className="h-6 w-6" />
          Compliance &amp; HIPAA
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          GDPR Art. 30 / Art. 33 / Art. 34 dashboard, breach notification workflow, and audit search.
        </p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "dashboard" && <DashboardTab />}
      {activeTab === "certification" && <CertificationCockpitTab />}
      {activeTab === "breaches" && <BreachesTab />}
      {activeTab === "audit" && <AuditTab />}
    </div>
  );
}
