// src/app/dashboard/reporting/page.tsx
"use client";

import { useState, useEffect } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { Doctor, User } from "@/lib/types";
import { ReportGenerator } from "./components/ReportGenerator";
import { ReportsOverview } from "./components/ReportsOverview";
import { Spinner } from "@/components/ui/spinner";

export default function ReportingPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "export">("overview");

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
      <div className="bg-red-50 border border-red-200 text-red-600 rounded-lg p-4">
        <h3 className="font-semibold mb-1">Error Loading Data</h3>
        <p>{error}</p>
        <button
          onClick={fetchData}
          className="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
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
        <p className="text-gray-600 mt-2">
          View comprehensive analytics and export medical records data
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab("overview")}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === "overview"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            Analytics Overview
          </button>
          <button
            onClick={() => setActiveTab("export")}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === "export"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            Data Export
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "overview" ? (
          <ReportsOverview />
        ) : (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">
              Export Medical Records
            </h2>
            <p className="mb-6 text-gray-600">
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
