// src/app/(with-auth)/dashboard/ward-indents/components/IndentTable.tsx

"use client";

import type { WardIndent } from "@/lib/api/wardIndents";
import { fmtDateTime, StatusBadge } from "./helpers";

export function IndentTable({
  indents,
  onSelect,
}: {
  indents: WardIndent[];
  onSelect: (id: number) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm" data-testid="ward-indent-table">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="p-3 text-left">Indent #</th>
            <th className="p-3 text-left">Ward</th>
            <th className="p-3 text-left">Type</th>
            <th className="p-3 text-right">Lines</th>
            <th className="p-3 text-left">Status</th>
            <th className="p-3 text-left">Owner roles</th>
            <th className="p-3 text-left">SLA</th>
            <th className="p-3 text-left">Requested</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {indents.map((indent) => {
            const slas = indent.workflow?.active_slas ?? [];
            const breached = slas.some(
              (sla) => sla.status === "breached" || sla.status === "escalated",
            );
            const controlled = indent.items?.some(
              (item) => item.controlled_reference_id,
            );
            return (
              <tr
                key={indent.id}
                className="border-t border-border hover:bg-muted/20"
                data-testid={`ward-indent-row-${indent.id}`}
              >
                <td className="p-3 font-mono">
                  {indent.indent_number}
                  {controlled && (
                    <span
                      className="ml-1 text-amber-400"
                      title="Contains controlled (H/H1/X or narcotic) lines"
                    >
                      ⚠
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {indent.ward_name ?? indent.ward_id ?? "—"}
                </td>
                <td className="p-3 text-xs uppercase">{indent.indent_type}</td>
                <td className="p-3 text-right">{indent.items?.length ?? 0}</td>
                <td className="p-3">
                  <StatusBadge status={indent.status} />
                </td>
                <td className="p-3 text-xs text-muted-foreground">
                  {(indent.workflow?.owner_role_codes ?? []).join(", ") || "—"}
                </td>
                <td className="p-3 text-xs">
                  {slas.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : breached ? (
                    <span className="font-medium text-rose-400">Breached</span>
                  ) : (
                    <span className="text-emerald-400">Active</span>
                  )}
                </td>
                <td className="p-3 text-xs">
                  {fmtDateTime(indent.requested_at)}
                </td>
                <td className="p-3 text-right">
                  <button
                    type="button"
                    onClick={() => onSelect(indent.id)}
                    className="text-xs underline"
                  >
                    View / act
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
