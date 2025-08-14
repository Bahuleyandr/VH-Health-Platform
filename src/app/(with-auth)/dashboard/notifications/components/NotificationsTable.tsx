// src/app/(with-auth)/dashboard/notifications/components/NotificationsTable.tsx
import { Notification } from "@/lib/types";

export function NotificationsTable({
  notifications,
}: {
  notifications: Notification[];
}) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Date
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Title
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Message
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >
              Type
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {notifications.map((item) => (
            <tr key={item.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(item.created_at).toLocaleDateString("en-GB")}
              </td>
              <td className="px-6 py-4 whitespace-nowrap font-medium text-gray-900">
                {item.title}
              </td>
              <td className="px-6 py-4 text-sm text-gray-500">{item.body}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {item.type}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
