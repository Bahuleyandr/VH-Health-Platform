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
    <div className="p-6 bg-white rounded-lg shadow space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Filter Inputs */}
        <div>
            <label htmlFor="patient_id">Patient</label>
            <select name="patient_id" onChange={handleFilterChange} className="border p-2 rounded w-full">
                <option value="">All Patients</option>
                {users.filter(u => u.role === 'PATIENT').map(p => <option key={p.id} value={p.id.toString()}>{p.name}</option>)}
            </select>
        </div>
         <div>
            <label htmlFor="doctor_id">Doctor</label>
            <select name="doctor_id" onChange={handleFilterChange} className="border p-2 rounded w-full">
                <option value="">All Doctors</option>
                {doctors.map(d => <option key={d.user_id} value={d.user_id.toString()}>{d.name}</option>)}
            </select>
        </div>
        <div>
            <label htmlFor="date_from">From Date</label>
            <input type="date" name="date_from" onChange={handleFilterChange} className="border p-2 rounded w-full" />
        </div>
        <div>
            <label htmlFor="date_to">To Date</label>
            <input type="date" name="date_to" onChange={handleFilterChange} className="border p-2 rounded w-full" />
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-4 pt-4">
        <button onClick={() => handleExport('pdf')} disabled={isLoading} className="bg-red-500 text-white px-4 py-2 rounded-md">
          {isLoading ? 'Generating...' : 'Export as PDF'}
        </button>
        <button onClick={() => handleExport('excel')} disabled={isLoading} className="bg-green-500 text-white px-4 py-2 rounded-md">
          {isLoading ? 'Generating...' : 'Export as Excel'}
        </button>
      </div>
      {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
    </div>
  );
}