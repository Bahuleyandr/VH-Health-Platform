// src/app/(with-auth)/dashboard/ward-indents/components/IndentDetailModal.tsx
//
// Full detail view of one ward indent: line items with the quantity ledger,
// active SLA clocks, the append-only transition event trail, and the
// ActionPanel that drives the workflow.

"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { getWardIndent, type WardIndent } from "@/lib/api/wardIndents";
import { ActionPanel } from "./ActionPanel";
import { fmtDateTime, num, StatusBadge } from "./helpers";

export function IndentDetailModal({
  indentId,
  onClose,
}: {
  indentId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: indent, isLoading } = useQuery<WardIndent>({
    queryKey: ["ward-indents", "detail", indentId],
    queryFn: () => getWardIndent(indentId),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["ward-indents"] });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 p-6">
      <div
        className="my-8 w-full max-w-4xl space-y-4 rounded-lg border border-border bg-card p-6"
        data-testid="ward-indent-detail"
      >
        {isLoading && <LoadingSpinner label="Loading indent…" />}

        {indent && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {indent.indent_number}
                </h2>
                <div className="text-xs text-muted-foreground">
                  {indent.ward_name ?? `Ward ${indent.ward_id ?? "—"}`}
                  {" · "}
                  {indent.indent_type}
                  {indent.admission_id != null && (
                    <> · admission #{indent.admission_id}</>
                  )}
                  {" · v"}
                  {indent.state_version}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={indent.status} />
                <button
                  type="button"
                  aria-label="Close"
                  className="text-muted-foreground"
                  onClick={onClose}
                >
                  ✕
                </button>
              </div>
            </div>

            {(indent.workflow?.active_slas?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2">
                {indent.workflow.active_slas.map((sla) => (
                  <span
                    key={sla.id}
                    className={`rounded px-2 py-0.5 text-xs ${
                      sla.status === "active"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    {sla.rule_code}: {sla.status}
                    {sla.due_at && <> · due {fmtDateTime(sla.due_at)}</>}
                  </span>
                ))}
              </div>
            )}

            {(indent.short_supply_reason ||
              indent.rejection_reason ||
              indent.reconciliation_reason) && (
              <div className="rounded bg-amber-500/10 p-3 text-sm">
                {indent.short_supply_reason && (
                  <div>
                    <strong>Short supply:</strong> {indent.short_supply_reason}
                  </div>
                )}
                {indent.rejection_reason && (
                  <div>
                    <strong>Rejection:</strong> {indent.rejection_reason}
                  </div>
                )}
                {indent.reconciliation_reason && (
                  <div>
                    <strong>Reconciliation:</strong>{" "}
                    {indent.reconciliation_reason}
                  </div>
                )}
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">Item</th>
                    <th className="p-2 text-right">Req</th>
                    <th className="p-2 text-right">Resv</th>
                    <th className="p-2 text-right">Appr</th>
                    <th className="p-2 text-right">Issued</th>
                    <th className="p-2 text-right">Recv</th>
                    <th className="p-2 text-right">Retn</th>
                    <th className="p-2 text-left">Line status</th>
                  </tr>
                </thead>
                <tbody>
                  {indent.items.map((item) => (
                    <tr key={item.id} className="border-t border-border">
                      <td className="p-2">
                        {item.item_name}
                        {item.controlled_reference_id && (
                          <span
                            className="ml-1 text-amber-400"
                            title="Controlled drug — witnessed handoff required"
                          >
                            ⚠ controlled
                          </span>
                        )}
                        {item.substitution_status === "pending" &&
                          item.proposed_item_name && (
                            <div className="text-xs text-purple-400">
                              → proposed: {item.proposed_item_name} ×{" "}
                              {num(item.proposed_quantity)}
                            </div>
                          )}
                        {item.original_item_name && (
                          <div className="text-xs text-muted-foreground">
                            substituted from {item.original_item_name}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-right">
                        {num(item.quantity_requested)}
                      </td>
                      <td className="p-2 text-right">
                        {num(item.quantity_reserved)}
                      </td>
                      <td className="p-2 text-right">
                        {num(item.quantity_approved)}
                      </td>
                      <td className="p-2 text-right">
                        {num(item.quantity_issued)}
                      </td>
                      <td className="p-2 text-right">
                        {num(item.quantity_received)}
                      </td>
                      <td className="p-2 text-right">
                        {num(item.quantity_returned)}
                        {num(item.quantity_return_requested) >
                          num(item.quantity_returned) && (
                          <span className="text-xs text-amber-400">
                            {" "}
                            / {num(item.quantity_return_requested)}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {item.fulfilment_status.replaceAll("_", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ActionPanel indent={indent} onDone={refresh} />

            {(indent.workflow?.events?.length ?? 0) > 0 && (
              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-xs uppercase tracking-wider text-muted-foreground">
                  Event trail ({indent.workflow.events!.length})
                </summary>
                <div className="mt-2 space-y-1">
                  {indent.workflow.events!.map((event) => (
                    <div
                      key={event.id}
                      className="flex flex-wrap items-baseline gap-2 text-xs"
                    >
                      <span className="font-mono text-muted-foreground">
                        v{event.state_version}
                      </span>
                      <span className="font-medium">
                        {event.action.replaceAll("_", " ")}
                      </span>
                      <span className="text-muted-foreground">
                        {event.from_status ?? "∅"} → {event.to_status}
                      </span>
                      {event.reason && (
                        <span className="text-muted-foreground">
                          “{event.reason}”
                        </span>
                      )}
                      {event.created_at && (
                        <span className="text-muted-foreground">
                          {fmtDateTime(event.created_at)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
