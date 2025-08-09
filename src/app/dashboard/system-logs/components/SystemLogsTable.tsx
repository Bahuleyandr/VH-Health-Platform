// src/app/dashboard/system-logs/components/SystemLogsTable.tsx
'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ExtendedSystemLog } from '@/lib/types';
import { LogDetailsModal } from './LogDetailsModal';

const levelColorMap: Record<string, string> = {
  ERROR: 'bg-red-100 text-red-800 border-red-300',
  WARN: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  INFO: 'bg-blue-100 text-blue-800 border-blue-300',
  DEBUG: 'bg-gray-100 text-gray-800 border-gray-300',
};

const levelIconMap: Record<string, ReactNode> = {
  ERROR: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  WARN: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  ),
  INFO: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  DEBUG: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
};

interface SystemLogsTableProps {
  logs: ExtendedSystemLog[];
  loading?: boolean;
}

export function SystemLogsTable({ logs, loading }: SystemLogsTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [selectedLog, setSelectedLog] = useState<ExtendedSystemLog | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const toggleRow = (id: number) => {
    const next = new Set(expandedRows);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedRows(next);
  };

  const formatStackTrace = (message: string) => {
    if (message.includes('\n') || message.includes('  at ')) {
      return message.split('\n').map((line, i) => (
        <div key={i} className={line.trim().startsWith('at ') ? 'ml-4' : ''}>
          {line}
        </div>
      ));
    }
    return message;
  };

  if (loading && logs.length === 0) {
    return (
      <div className="bg-white shadow rounded-lg p-8">
        <div className="flex justify-center items-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="bg-white shadow rounded-lg p-8">
        <div className="text-center text-gray-500">No system logs found for the selected filters.</div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Level</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Service</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Message</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {logs.map((log) => (
              <tr key={log.id} className={`hover:bg-gray-50 ${log.level === 'ERROR' ? 'bg-red-50' : ''}`}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  <div>
                    {new Date(log.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </div>
                  <div className="text-xs text-gray-400">
                    {new Date(log.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full border ${levelColorMap[log.level]}`}>
                    {levelIconMap[log.level]}
                    {log.level}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">{log.service || 'API'}</div>
                  {log.module && <div className="text-xs text-gray-500">{log.module}</div>}
                </td>
                <td className="px-6 py-4 text-sm">
                  <div className="max-w-2xl">
                    {log.message.length > 150 || log.message.includes('\n') ? (
                      <>
                        <div className={`font-mono text-gray-800 ${expandedRows.has(log.id) ? '' : 'truncate'}`}>
                          {expandedRows.has(log.id) ? formatStackTrace(log.message) : log.message}
                        </div>
                        <button onClick={() => toggleRow(log.id)} className="text-blue-600 hover:text-blue-800 text-xs mt-1">
                          {expandedRows.has(log.id) ? 'Show less' : 'Show more'}
                        </button>
                      </>
                    ) : (
                      <div className="font-mono text-gray-800">{log.message}</div>
                    )}
                    {log.metadata && (
                      <div className="mt-2 text-xs text-gray-500">
                        <details>
                          <summary className="cursor-pointer hover:text-gray-700">Metadata</summary>
                          <pre className="mt-1 p-2 bg-gray-100 rounded overflow-x-auto">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        </details>
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <button
                    onClick={() => {
                      setSelectedLog(log);
                      setIsModalOpen(true);
                    }}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LogDetailsModal
        log={selectedLog}
        type="system"
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedLog(null);
        }}
      />
    </div>
  );
}
