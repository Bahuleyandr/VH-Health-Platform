// src/app/dashboard/system-logs/components/AuditLogsTable.tsx
import { AuditLog } from "@/lib/types";

export function AuditLogsTable({ logs }: { logs: AuditLog[] }) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date & Time</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Details</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">User ID</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(log.created_at).toLocaleString('en-GB')}</td>
              <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-indigo-600">{log.action}</td>
              <td className="px-6 py-4 text-sm text-gray-800">{log.details}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{log.user_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}