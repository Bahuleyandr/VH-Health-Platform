// src/app/dashboard/system-logs/components/ExportLogsButton.tsx
'use client';

import { useState } from 'react';
import { fetchAdminAPI } from '@/lib/api';

interface ExportLogsButtonProps {
  logType: 'audit' | 'system';
  queryParams: URLSearchParams;
}

export function ExportLogsButton({ logType, queryParams }: ExportLogsButtonProps) {
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: 'json' | 'csv') => {
    try {
      setExporting(true);
      const endpoint = logType === 'audit' ? '/logs/audit/export' : '/logs/system/export';
      
      // Add format to query params
      const exportParams = new URLSearchParams(queryParams);
      exportParams.set('format', format);
      
      const response = await fetchAdminAPI(`${endpoint}?${exportParams.toString()}`);
      
      let blob: Blob;
      let filename: string;
      
      if (format === 'json') {
        blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
        filename = `${logType}_logs_${new Date().toISOString().split('T')[0]}.json`;
      } else {
        // For CSV, we assume the API returns a CSV string
        const csvContent = response.csv || convertToCSV(response.logs || response);
        blob = new Blob([csvContent], { type: 'text/csv' });
        filename = `${logType}_logs_${new Date().toISOString().split('T')[0]}.csv`;
      }
      
      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Failed to export logs. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  // Helper function to convert logs to CSV format
  const convertToCSV = (logs: any[]) => {
    if (!logs || logs.length === 0) return '';
    
    const headers = Object.keys(logs[0]);
    const csvHeaders = headers.join(',');
    
    const csvRows = logs.map(log => {
      return headers.map(header => {
        const value = log[header];
        // Escape quotes and wrap in quotes if contains comma
        const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value || '');
        return stringValue.includes(',') || stringValue.includes('"') 
          ? `"${stringValue.replace(/"/g, '""')}"` 
          : stringValue;
      }).join(',');
    });
    
    return [csvHeaders, ...csvRows].join('\n');
  };

  return (
    <div className="relative inline-block text-left">
      <div>
        <button
          type="button"
          className="inline-flex justify-center items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
          disabled={exporting}
        >
          {exporting ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
              Exporting...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
              </svg>
              Export
            </>
          )}
        </button>
      </div>
      
      {/* Dropdown menu - you could implement this with a proper dropdown library */}
      <div className="hidden origin-top-right absolute right-0 mt-2 w-40 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5">
        <div className="py-1" role="menu">
          <button
            onClick={() => handleExport('json')}
            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            role="menuitem"
          >
            Export as JSON
          </button>
          <button
            onClick={() => handleExport('csv')}
            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            role="menuitem"
          >
            Export as CSV
          </button>
        </div>
      </div>
    </div>
  );
}