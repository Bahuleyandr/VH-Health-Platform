// src/app/(with-auth)/dashboard/notifications/components/NotificationsTable.tsx
import { Notification } from "@/lib/types";

export function NotificationsTable({
  notifications,
}: {
  notifications: Notification[];
}) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-border">
        <thead className="bg-muted">
          <tr>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase"
            >
              Date
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase"
            >
              Title
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase"
            >
              Message
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase"
            >
              Type
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-border">
          {notifications.map((item) => (
            <tr key={item.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                {new Date(item.created_at).toLocaleDateString("en-GB")}
              </td>
              <td className="px-6 py-4 whitespace-nowrap font-medium text-foreground">
                {item.title}
              </td>
              <td className="px-6 py-4 text-sm text-muted-foreground">{item.body}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                {item.type}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
