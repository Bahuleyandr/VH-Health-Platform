// src/app/(with-auth)/dashboard/reporting/page.tsx
"use client";

import { useState, useEffect } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { Doctor, User } from "@/lib/types";
import { ReportGenerator } from "./components/ReportGenerator";
import { ReportsOverview } from "./components/ReportsOverview";
import { DataExporter } from "./components/DataExporter";
import { Spinner } from "@/components/ui/spinner";

export default function ReportingPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "export" | "bulk">(
    "overview",
  );

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Tell fetchAdminAPI the expected shapes
      const [usersData, doctorsData] = await Promise.all([
        fetchAdminAPI<{ users: User[] }>("/users"),
        fetchAdminAPI<{ doctors: Doctor[] }>("/doctors"),
      ]);

      setUsers(usersData?.users ?? []);
      setDoctors(doctorsData?.doctors ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-4">
        <h3 className="font-semibold mb-1">Error Loading Data</h3>
        <p>{error}</p>
        <button
          onClick={fetchData}
          className="mt-2 px-4 py-2 bg-destructive text-white rounded hover:bg-destructive/90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Reports & Analytics</h1>
        <p className="text-muted-foreground mt-2">
          View comprehensive analytics and export medical records data
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-border">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab("overview")}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === "overview"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-input"
            }`}
          >
            Analytics Overview
          </button>
          <button
            onClick={() => setActiveTab("export")}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === "export"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-input"
            }`}
          >
            Bulk Export
          </button>
          <button
            onClick={() => setActiveTab("bulk")}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === "bulk"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-input"
            }`}
          >
            Records Export
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "overview" ? (
          <ReportsOverview />
        ) : activeTab === "export" ? (
          <DataExporter />
        ) : (
          <div className="bg-card p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">
              Export Medical Records
            </h2>
            <p className="mb-6 text-muted-foreground">
              Select filters to generate a report of medical records. The report
              will be downloaded to your device.
            </p>
            <ReportGenerator users={users} doctors={doctors} />
          </div>
        )}
      </div>
    </div>
  );
}
