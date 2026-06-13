// src/components/DataTable.tsx
"use client";

import { useState } from "react";
import type { ReactNode } from "react";

interface Column<T, K extends keyof T = keyof T> {
  key: K;
  header: string;
  render?: (value: T[K], row: T) => ReactNode;
}

interface DataTableProps<T extends { id: string }> {
  data: T[];
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  onSelectionChange?: (selected: T[]) => void;
}

export function DataTable<T extends { id: string }>({
  data,
  columns,
  onRowClick,
  selectable,
  onSelectionChange,
}: DataTableProps<T>) {
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  const handleSelectRow = (id: string) => {
    const newSelected = new Set(selectedRows);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedRows(newSelected);

    if (onSelectionChange) {
      const selectedData = data.filter((row) => newSelected.has(row.id));
      onSelectionChange(selectedData);
    }
  };

  return (
    <div className="overflow-x-auto w-full">
      <table
        className="min-w-full divide-y divide-border"
        aria-label="Data table"
      >
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="w-12">
                <span className="sr-only">Select</span>
              </th>
            )}
            {columns.map((column) => (
              <th
                key={String(column.key)}
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="bg-card divide-y divide-border">
          {data.map((row) => (
            <tr
              key={row.id}
              onClick={() => onRowClick?.(row)}
              className={onRowClick ? "cursor-pointer hover:bg-muted" : ""}
            >
              {selectable && (
                <td className="px-6 py-4">
                  <label className="sr-only" htmlFor={`select-row-${row.id}`}>
                    Select row {row.id}
                  </label>
                  <input
                    id={`select-row-${row.id}`}
                    type="checkbox"
                    checked={selectedRows.has(row.id)}
                    onChange={() => handleSelectRow(row.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
              )}

              {columns.map((column) => (
                <td
                  key={String(column.key)}
                  className="px-6 py-4 whitespace-nowrap"
                >
                  {column.render
                    ? column.render(row[column.key], row)
                    : String(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
