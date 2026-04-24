"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Shield } from "lucide-react";
import {
  getAuditDashboard,
  getAdminActivityReport,
  getSLAReport,
  getReportAuditTrail,
} from "@/lib/api/reports";
import { AuditOverviewTab } from "./components/AuditOverviewTab";
import { HRActivityTab } from "./components/HRActivityTab";
import { SLAComplianceTab } from "./components/SLAComplianceTab";
import { AuditTrailDialog } from "./components/AuditTrailDialog";
import type {
  AuditDashboardData,
  AdminActivityData,
  SLAData,
  Tab,
  TrailTarget,
} from "./components/types";

export default function AuditPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState(30);
  const [trailTarget, setTrailTarget] = useState<TrailTarget | null>(null);

  const dashQuery = useQuery<AuditDashboardData>({
    queryKey: ["audit-dashboard"],
    queryFn: async () => {
      const r = await getAuditDashboard<unknown>();
      return (r as { data: AuditDashboardData }).data ?? (r as AuditDashboardData);
    },
    refetchInterval: 60000, // refresh every minute
  });

  const activityQuery = useQuery<AdminActivityData>({
    queryKey: ["audit-activity", days],
    queryFn: async () => {
      const r = await getAdminActivityReport<unknown>(days);
      return (r as { data: AdminActivityData }).data ?? (r as AdminActivityData);
    },
    enabled: tab === "activity",
  });

  const slaQuery = useQuery<SLAData>({
    queryKey: ["audit-sla", days],
    queryFn: async () => {
      const r = await getSLAReport<unknown>(days);
      return (r as { data: SLAData }).data ?? (r as SLAData);
    },
    enabled: tab === "sla",
  });

  const trailQuery = useQuery({
    queryKey: ["audit-trail", trailTarget?.type, trailTarget?.id],
    queryFn: async () => {
      if (!trailTarget) return null;
      const r = await getReportAuditTrail<unknown>(trailTarget.type, trailTarget.id);
      return (r as { data: unknown }).data ?? r;
    },
    enabled: !!trailTarget,
  });

  const dash = dashQuery.data;
  const hasSentinel = (dash?.incidents?.open_sentinel as number) > 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="text-primary" size={22} />
            <h1 className="text-2xl font-bold text-gray-900">Reports Audit</h1>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Super-admin oversight — incident reports, grievances, HR activity, SLA compliance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Period:</label>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* Sentinel alert banner */}
      {hasSentinel && (
        <div className="mb-5 flex items-center gap-3 bg-red-900 text-white px-4 py-3 rounded-xl">
          <AlertTriangle size={18} className="shrink-0 animate-pulse" />
          <span className="font-semibold">
            {dash?.incidents?.open_sentinel} SENTINEL event(s) unresolved — requires immediate investigation
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6">
        {(["overview", "activity", "sla"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize rounded-t-lg transition-colors ${
              tab === t ? "bg-primary text-white" : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {t === "sla" ? "SLA Compliance" : t === "activity" ? "HR Activity" : "Overview"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <AuditOverviewTab
          data={dashQuery.data}
          isLoading={dashQuery.isLoading}
          onOpenTrail={setTrailTarget}
        />
      )}
      {tab === "activity" && (
        <HRActivityTab
          data={activityQuery.data}
          isLoading={activityQuery.isLoading}
          days={days}
        />
      )}
      {tab === "sla" && (
        <SLAComplianceTab data={slaQuery.data} isLoading={slaQuery.isLoading} />
      )}

      {trailTarget && (
        <AuditTrailDialog
          target={trailTarget}
          data={trailQuery.data as Record<string, unknown> | null | undefined}
          isLoading={trailQuery.isLoading}
          onClose={() => setTrailTarget(null)}
        />
      )}
    </div>
  );
}
