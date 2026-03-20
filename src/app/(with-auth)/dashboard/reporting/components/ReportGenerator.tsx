// src/app/(with-auth)/dashboard/reporting/components/ReportGenerator.tsx
"use client";

import { User, Doctor } from "@/lib/types";
import { useState } from "react";
import { API_BASE_URL } from "@/lib/api-config";
import { getAuthToken } from "@/lib/api-client";
import { getHeaders } from "@/lib/api-config";

interface ReportGeneratorProps {
  users: User[];
  doctors: Doctor[];
}

export function ReportGenerator({ users, doctors }: ReportGeneratorProps) {
  const [filters, setFilters] = useState({
    patient_id: "",
    doctor_id: "",
    date_from: "",
    date_to: "",
    report_type: "all", // all, appointments, prescriptions, lab_results
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleFilterChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setFilters({ ...filters, [e.target.name]: e.target.value });
  };

  const handleExport = async (format: "pdf" | "excel") => {
    setIsLoading(true);
    setError("");

    const queryParams = new URLSearchParams();
    if (filters.patient_id) queryParams.set("patient_id", filters.patient_id);
    if (filters.doctor_id) queryParams.set("doctor_id", filters.doctor_id);
    if (filters.date_from) queryParams.set("date_from", filters.date_from);
    if (filters.date_to) queryParams.set("date_to", filters.date_to);
    if (filters.report_type !== "all")
      queryParams.set("report_type", filters.report_type);

    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error("Authentication required");
      }

      // Direct fetch for blob response
      const response = await fetch(
        `${API_BASE_URL}/api/v1/records/export/${format}?${queryParams.toString()}`,
        {
          headers: getHeaders(token),
        },
      );

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(
          errorData || `Export failed with status: ${response.status}`,
        );
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;

      // Generate filename with current date
      const formattedDate = new Date()
        .toLocaleDateString("en-GB")
        .replace(/\//g, "-");
      const reportType =
        filters.report_type !== "all" ? `-${filters.report_type}` : "";
      a.download = `medical-records${reportType}-${formattedDate}.${format === "pdf" ? "pdf" : "xlsx"}`;

      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate report",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const isFiltered =
    filters.patient_id ||
    filters.doctor_id ||
    filters.date_from ||
    filters.date_to ||
    filters.report_type !== "all";

  const clearFilters = () => {
    setFilters({
      patient_id: "",
      doctor_id: "",
      date_from: "",
      date_to: "",
      report_type: "all",
    });
  };

  return (
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Patient
          </label>
          <select
            name="patient_id"
            value={filters.patient_id}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Patients</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} ({user.email})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Doctor
          </label>
          <select
            name="doctor_id"
            value={filters.doctor_id}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Doctors</option>
            {doctors.map((doctor) => (
              <option key={doctor.user_id} value={doctor.user_id}>
                Dr. {doctor.name} - {doctor.specialization}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Report Type
          </label>
          <select
            name="report_type"
            value={filters.report_type}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="all">All Records</option>
            <option value="appointments">Appointments Only</option>
            <option value="prescriptions">Prescriptions Only</option>
            <option value="lab_results">Lab Results Only</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            From Date
          </label>
          <input
            type="date"
            name="date_from"
            value={filters.date_from}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            To Date
          </label>
          <input
            type="date"
            name="date_to"
            value={filters.date_to}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {isFiltered && (
          <div className="flex items-end">
            <button
              onClick={clearFilters}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 underline"
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>

      {/* Export Buttons */}
      <div className="flex flex-wrap gap-4">
        <button
          onClick={() => handleExport("pdf")}
          disabled={isLoading}
          className="flex items-center gap-2 px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
            />
          </svg>
          {isLoading ? "Generating..." : "Export as PDF"}
        </button>

        <button
          onClick={() => handleExport("excel")}
          disabled={isLoading}
          className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          {isLoading ? "Generating..." : "Export as Excel"}
        </button>
      </div>

      {/* Export Information */}
      <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <h4 className="font-medium text-blue-900 mb-2">Export Information</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>
            • PDF exports include formatted reports with headers and styling
          </li>
          <li>
            • Excel exports provide raw data in spreadsheet format for further
            analysis
          </li>
          <li>• Large exports may take a few moments to generate</li>
          <li>• All timestamps are in your local timezone</li>
        </ul>
      </div>
    </div>
  );
}
