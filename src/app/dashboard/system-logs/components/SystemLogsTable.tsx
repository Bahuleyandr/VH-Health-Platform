// src/app/dashboard/system-logs/components/SystemLogsTable.tsx
import { SystemLog } from "@/lib/types";

const levelColorMap = {
  ERROR: 'bg-red-100 text-red-800',
  WARN: 'bg-yellow-100 text-yellow-800',
  INFO: 'bg-blue-100 text-blue-800',
  DEBUG: 'bg-gray-100 text-gray-800',
};

export function SystemLogsTable({ logs }: { logs: SystemLog[] }) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Timestamp</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Level</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(log.timestamp).toLocaleString('en-GB')}</td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${levelColorMap[log.level]}`}>
                  {log.level}
                </span>
              </td>
              <td className="px-6 py-4 text-sm text-gray-800 font-mono">{log.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}