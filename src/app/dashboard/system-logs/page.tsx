// src/app/dashboard/system-logs/page.tsx

import { getAuditLogs, getSystemLogs } from "@/lib/api";
import { AuditLog, SystemLog } from "@/lib/types";
import { Suspense } from "react";
import Link from "next/link";
import { AuditLogsTable } from "./components/AuditLogsTable";
import { SystemLogsTable } from "./components/SystemLogsTable";

export default async function SystemLogsPage({ searchParams }: {
  searchParams: { tab?: string };
}) {
  const currentTab = searchParams.tab || 'audit'; // Default to audit logs

  const queryParams = new URLSearchParams(); // For potential future filtering

  // Fetch data for both tabs in parallel
  const [auditLogsData, systemLogsData] = await Promise.all([
    getAuditLogs(queryParams),
    getSystemLogs(queryParams)
  ]);

  const auditLogs: AuditLog[] = auditLogsData.logs || [];
  const systemLogs: SystemLog[] = systemLogsData.logs || [];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">System & Audit Logs</h2>
      
      {/* Tab Navigation */}
      <div className="mb-4 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <Link href="?tab=audit" className={`${currentTab === 'audit' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'} whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}>
            Audit Logs
          </Link>
          <Link href="?tab=system" className={`${currentTab === 'system' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'} whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}>
            System Logs
          </Link>
        </nav>
      </div>

      {/* Conditional Content */}
      <Suspense fallback={<div>Loading logs...</div>}>
        {currentTab === 'audit' && <AuditLogsTable logs={auditLogs} />}
        {currentTab === 'system' && <SystemLogsTable logs={systemLogs} />}
      </Suspense>
    </div>
  );
}