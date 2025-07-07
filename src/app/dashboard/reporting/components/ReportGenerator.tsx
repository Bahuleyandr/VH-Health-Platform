// src/app/dashboard/reporting/components/ReportGenerator.tsx
'use client';

import { User, Doctor } from "@/lib/types";
import { useState } from "react";

export function ReportGenerator({ users, doctors }: { users: User[], doctors: Doctor[] }) {
  const [filters, setFilters] = useState({
    patient_id: '',
    doctor_id: '',
    date_from: '',
    date_to: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters({ ...filters, [e.target.name]: e.target.value });
  };

  const handleExport = async (format: 'pdf' | 'excel') => {
    setIsLoading(true);
    setError('');

    const queryParams = new URLSearchParams();
    if (filters.patient_id) queryParams.set('patient_id', filters.patient_id);
    if (filters.doctor_id) queryParams.set('doctor_id', filters.doctor_id);
    if (filters.date_from) queryParams.set('date_from', filters.date_from);
    if (filters.date_to) queryParams.set('date_to', filters.date_to);

    try {
      // We need to fetch directly here to handle the blob response
      const response = await fetch(`/api/v1/records/export/${format}?${queryParams.toString()}`);

      if (!response.ok) {
        throw new Error(`Failed to generate report. Status: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const formattedDate = new Date().toLocaleDateString('en-GB').replace(/\//g, '-'); // DD-MM-YYYY
      a.download = `medical-records-${formattedDate}.${format === 'pdf' ? 'pdf' : 'xlsx'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h3 className="text-lg font-semibold mb-4">Generate Medical Records Report</h3>
      
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Patient</label>
          <select
            name="patient_id"
            value={filters.patient_id}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Patients</option>
            {users.map(user => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Doctor</label>
          <select
            name="doctor_id"
            value={filters.doctor_id}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Doctors</option>
            {doctors.map(doctor => (
              <option key={doctor.user_id} value={doctor.user_id}>{doctor.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From Date</label>
          <input
            type="date"
            name="date_from"
            value={filters.date_from}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">To Date</label>
          <input
            type="date"
            name="date_to"
            value={filters.date_to}
            onChange={handleFilterChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex gap-4">
        <button
          onClick={() => handleExport('pdf')}
          disabled={isLoading}
          className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
        >
          {isLoading ? 'Generating...' : 'Export as PDF'}
        </button>
        <button
          onClick={() => handleExport('excel')}
          disabled={isLoading}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
        >
          {isLoading ? 'Generating...' : 'Export as Excel'}
        </button>
      </div>
    </div>
  );
}