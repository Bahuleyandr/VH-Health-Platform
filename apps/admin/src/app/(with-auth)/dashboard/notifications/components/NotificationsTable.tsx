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
      return [item.title, item.body, item.type]
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

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] divide-y divide-border">
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
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-border">
              {paged.rows.map((item) => (
                <tr key={item.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(item.created_at).toLocaleDateString("en-GB")}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-medium text-foreground">
                    {item.title}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {item.body}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                    {item.type}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
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
      return notification.body;
    case "type":
      return notification.type;
    case "created_at":
    default:
      return Date.parse(notification.created_at);
  }
}
