// src/app/(with-auth)/dashboard/notifications/components/NotificationsTable.tsx
"use client";

import { useMemo, useState } from "react";
import { Notification } from "@/lib/types";
import {
  ClientTablePagination,
  compareTableValues,
  ManagedTableToolbar,
  paginateRows,
  SortableTableHeader,
  type SortDirection,
  type SortValue,
} from "@/components/table/client";

type NotificationSortKey = "created_at" | "title" | "body" | "type";

export function NotificationsTable({
  notifications,
  isLoading,
  error,
}: {
  notifications: Notification[];
  isLoading?: boolean;
  error?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<NotificationSortKey>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = notifications.filter((item) => {
      if (!query) return true;
      return [item.title, item.body ?? item.message, item.type]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    filtered.sort((a, b) => {
      const result = compareTableValues(
        getNotificationSortValue(a, sortKey),
        getNotificationSortValue(b, sortKey),
      );
      return sortDirection === "asc" ? result : -result;
    });
    return filtered;
  }, [notifications, search, sortDirection, sortKey]);

  const paged = paginateRows(rows, page, pageSize);

  const handleSort = (key: NotificationSortKey) => {
    setSortDirection((current) =>
      sortKey === key && current === "asc" ? "desc" : "asc",
    );
    setSortKey(key);
    setPage(1);
  };

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Loading notifications...
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-center text-destructive">{error}</div>;
  }

  return (
    <>
      <ManagedTableToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="Search notifications by title, message, type..."
        countLabel={`${rows.length} of ${notifications.length} notifications`}
      />

      <div className="bg-card shadow rounded-lg overflow-hidden border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <SortableTableHeader
                  label="Date"
                  sortKey="created_at"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Title"
                  sortKey="title"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Message"
                  sortKey="body"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Type"
                  sortKey="type"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {paged.rows.map((item) => (
                <tr key={item.id} className="hover:bg-muted/40">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(item.created_at).toLocaleDateString("en-GB")}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-medium text-foreground">
                    {item.title}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {item.body ?? item.message}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                    {item.type}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                        {item.is_read ? "Read" : "Unread"}
                      </span>
                      {item.last_acknowledged_at && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                          Ack {new Date(item.last_acknowledged_at).toLocaleDateString("en-GB")}
                        </span>
                      )}
                      {(item.escalation_count || 0) > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                          Escalated {item.escalation_count}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No notifications match the current search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ClientTablePagination
        page={paged.page}
        pageSize={pageSize}
        total={rows.length}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPageSize(value);
          setPage(1);
        }}
        itemLabel="notifications"
      />
    </>
  );
}

function getNotificationSortValue(
  notification: Notification,
  key: NotificationSortKey,
): SortValue {
  switch (key) {
    case "title":
      return notification.title;
    case "body":
      return notification.body ?? notification.message ?? "";
    case "type":
      return notification.type;
    case "created_at":
    default:
      return Date.parse(notification.created_at);
  }
}
