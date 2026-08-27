// src/app/(with-auth)/dashboard/ward-indents/components/ActionPanel.tsx
//
// Workflow action buttons + per-action forms for one ward indent. Builds the
// exact request bodies the backend contract requires (reason strings,
// per-item quantity arrays, substitution proposals, controlled evidence) and
// sends every mutation with an attempt-scoped Idempotency-Key plus the
// indent's state_version as expected_version.

"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { payloadIdentity } from "@/lib/idempotencyKey";
import {
  approveWardIndent,
  approveWardIndentSubstitution,
  cancelWardIndent,
  closeWardIndent,
  issueWardIndent,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  receiveWardIndent,
  reconcileWardIndent,
  recordWardIndentControlledHandoff,
  rejectWardIndent,
  rejectWardIndentSubstitution,
  reportWardIndentDiscrepancy,
  requestWardIndentReturn,
  reserveWardIndent,
  type ControlledEvidenceEntry,
  type ItemQuantityEntry,
  type ItemReconciliationEntry,
  type SubstitutionProposal,
  type WardIndent,
} from "@/lib/api/wardIndents";
import { actionsForStatus, num, type WardIndentActionKey } from "./helpers";

interface QtyRowState {
  [itemId: number]: string;
}

interface PairRowState {
  [itemId: number]: { movement_id: string; register_id: string };
}

interface SubstitutionRowState {
  [itemId: number]: { catalog_id: string; quantity: string; reason: string };
}

interface ReconRowState {
  [itemId: number]: { quantity: string; disposition: string; note: string };
}

const RECONCILIATION_DISPOSITIONS = [
  "transit_shortage",
  "ward_count_variance",
  "damaged_in_transit",
  "documented_exception",
] as const;

function qtyEntries(state: QtyRowState, field: string): ItemQuantityEntry[] {
  return Object.entries(state)
    .filter(([, v]) => v !== "")
    .map(([itemId, v]) => ({
      item_id: Number(itemId),
      [field]: Number(v),
    })) as ItemQuantityEntry[];
}

function pairEntries(state: PairRowState): ControlledEvidenceEntry[] {
  return Object.entries(state).map(([itemId, v]) => ({
    item_id: Number(itemId),
    movement_id: Number(v.movement_id),
    register_id: Number(v.register_id),
  }));
}

export function ActionPanel({
  indent,
  onDone,
}: {
  indent: WardIndent;
  onDone: () => void;
}) {
  const [active, setActive] = useState<WardIndentActionKey | null>(null);
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<QtyRowState>({});
  const [pairs, setPairs] = useState<PairRowState>({});
  const [subs, setSubs] = useState<SubstitutionRowState>({});
  const [recon, setRecon] = useState<ReconRowState>({});
  const [error, setError] = useState<string | null>(null);

  const keyStore = useIdempotencyKey(`ward-indent-${indent.id}`);

  const available = useMemo(
    () => actionsForStatus(indent.status),
    [indent.status],
  );
  const activeDef = available.find((a) => a.key === active) ?? null;

  const controlledItems = indent.items.filter(
    (item) => item.controlled_reference_id,
  );
  const shortItems = indent.items.filter(
    (item) => num(item.quantity_reserved) < num(item.quantity_requested),
  );
  const varianceItems = indent.items.filter(
    (item) =>
      num(item.quantity_issued) -
        num(item.quantity_received) -
        num(item.quantity_variance_resolved) >
      0,
  );
  const outstandingControlledReturns = controlledItems.filter(
    (item) => num(item.quantity_return_requested) > num(item.quantity_returned),
  );

  const mutation = useMutation({
    mutationFn: async (action: WardIndentActionKey) => {
      const base = { expected_version: indent.state_version };
      const key = (body: unknown) =>
        keyStore.keyFor(payloadIdentity({ id: indent.id, action, body }));

      switch (action) {
        case "reserve": {
          const body = { ...base };
          return reserveWardIndent(indent.id, body, key(body));
        }
        case "short_supply": {
          const body = {
            ...base,
            reason,
            item_quantities_available: qtyEntries(qty, "quantity_available"),
          };
          return markWardIndentShortSupply(indent.id, body, key(body));
        }
        case "propose_substitution": {
          const substitutions: SubstitutionProposal[] = Object.entries(subs)
            .filter(([, v]) => v.catalog_id !== "")
            .map(([itemId, v]) => ({
              item_id: Number(itemId),
              substitute_catalog_id: Number(v.catalog_id),
              ...(v.quantity !== "" ? { quantity: Number(v.quantity) } : {}),
              reason: v.reason,
            }));
          const body = { ...base, substitutions };
          return proposeWardIndentSubstitution(indent.id, body, key(body));
        }
        case "approve_substitution": {
          const body = { ...base };
          return approveWardIndentSubstitution(indent.id, body, key(body));
        }
        case "reject_substitution": {
          const body = { ...base, reason };
          return rejectWardIndentSubstitution(indent.id, body, key(body));
        }
        case "approve": {
          const body = { ...base };
          return approveWardIndent(indent.id, body, key(body));
        }
        case "reject": {
          const body = { ...base, reason };
          return rejectWardIndent(indent.id, body, key(body));
        }
        case "controlled_handoff": {
          const body = { ...base, item_evidence: pairEntries(pairs) };
          return recordWardIndentControlledHandoff(indent.id, body, key(body));
        }
        case "issue": {
          const body = { ...base };
          return issueWardIndent(indent.id, body, key(body));
        }
        case "receive": {
          const body = {
            ...base,
            item_quantities_received: qtyEntries(qty, "quantity_received"),
          };
          return receiveWardIndent(indent.id, body, key(body));
        }
        case "return_request": {
          const body = {
            ...base,
            reason,
            item_quantities_returned: qtyEntries(qty, "quantity_returned"),
          };
          return requestWardIndentReturn(indent.id, body, key(body));
        }
        case "discrepancy": {
          const body = { ...base, reason };
          return reportWardIndentDiscrepancy(indent.id, body, key(body));
        }
        case "reconcile": {
          const item_reconciliations: ItemReconciliationEntry[] =
            Object.entries(recon)
              .filter(([, v]) => v.quantity !== "")
              .map(([itemId, v]) => ({
                item_id: Number(itemId),
                quantity_variance_resolved: Number(v.quantity),
                disposition:
                  v.disposition as ItemReconciliationEntry["disposition"],
                note: v.note,
              }));
          const controlled_return_evidence = pairEntries(pairs);
          const body = {
            ...base,
            reason,
            ...(item_reconciliations.length ? { item_reconciliations } : {}),
            ...(controlled_return_evidence.length
              ? { controlled_return_evidence }
              : {}),
          };
          return reconcileWardIndent(indent.id, body, key(body));
        }
        case "cancel": {
          const body = { ...base, reason };
          return cancelWardIndent(indent.id, body, key(body));
        }
        case "close": {
          const body = { ...base, reason };
          return closeWardIndent(indent.id, body, key(body));
        }
        default:
          throw new Error(`Unknown ward-indent action: ${action}`);
      }
    },
    onSuccess: () => {
      keyStore.reset();
      setActive(null);
      setReason("");
      setQty({});
      setPairs({});
      setSubs({});
      setRecon({});
      setError(null);
      onDone();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Action failed");
    },
  });

  if (available.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        This indent is in a terminal state — no further actions.
      </div>
    );
  }

  const selectAction = (key: WardIndentActionKey) => {
    setActive(key);
    setError(null);
    setReason("");
    setPairs({});
    setSubs({});
    // Sensible per-item defaults for quantity-bearing actions.
    if (key === "short_supply") {
      setQty(
        Object.fromEntries(
          indent.items.map((item) => [
            item.id,
            String(num(item.quantity_reserved)),
          ]),
        ),
      );
    } else if (key === "receive") {
      setQty(
        Object.fromEntries(
          indent.items.map((item) => [
            item.id,
            String(num(item.quantity_issued)),
          ]),
        ),
      );
    } else if (key === "return_request") {
      setQty(
        Object.fromEntries(
          indent.items.map((item) => [
            item.id,
            String(num(item.quantity_returned)),
          ]),
        ),
      );
    } else {
      setQty({});
    }
    if (key === "reconcile") {
      setRecon(
        Object.fromEntries(
          varianceItems.map((item) => [
            item.id,
            {
              quantity: String(
                num(item.quantity_issued) -
                  num(item.quantity_received) -
                  num(item.quantity_variance_resolved),
              ),
              disposition: "transit_shortage",
              note: "",
            },
          ]),
        ),
      );
    } else {
      setRecon({});
    }
  };

  const reasonMissing = Boolean(activeDef?.needsReason) && !reason.trim();
  const evidenceMissing =
    (active === "controlled_handoff" &&
      controlledItems.some(
        (item) => !pairs[item.id]?.movement_id || !pairs[item.id]?.register_id,
      )) ||
    (active === "reconcile" &&
      outstandingControlledReturns.some(
        (item) => !pairs[item.id]?.movement_id || !pairs[item.id]?.register_id,
      ));
  const substitutionMissing =
    active === "propose_substitution" &&
    !Object.values(subs).some((v) => v.catalog_id !== "" && v.reason.trim());
  const submitDisabled =
    mutation.isPending ||
    reasonMissing ||
    evidenceMissing ||
    substitutionMissing;

  const setPair = (
    itemId: number,
    field: "movement_id" | "register_id",
    value: string,
  ) =>
    setPairs((prev) => ({
      ...prev,
      [itemId]: {
        movement_id: prev[itemId]?.movement_id ?? "",
        register_id: prev[itemId]?.register_id ?? "",
        [field]: value,
      },
    }));

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        Workflow actions
      </div>

      <div className="flex flex-wrap gap-2">
        {available.map((action) => (
          <button
            key={action.key}
            type="button"
            data-testid={`ward-indent-action-${action.key}`}
            onClick={() => selectAction(action.key)}
            className={`rounded px-3 py-1.5 text-sm ${
              active === action.key
                ? "bg-primary text-primary-foreground"
                : action.destructive
                  ? "border border-rose-500/40 text-rose-400"
                  : "border border-border"
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>

      {activeDef && (
        <div className="space-y-3 border-t border-border pt-3">
          {activeDef.hint && (
            <p className="text-xs text-muted-foreground">{activeDef.hint}</p>
          )}

          {activeDef.needsReason && (
            <div>
              <label
                className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground"
                htmlFor="ward-indent-reason"
              >
                Reason *
              </label>
              <textarea
                id="ward-indent-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </div>
          )}

          {(active === "short_supply" ||
            active === "receive" ||
            active === "return_request") && (
            <QuantityGrid
              label={
                active === "short_supply"
                  ? "Quantity available now"
                  : active === "receive"
                    ? "Cumulative quantity received"
                    : "Cumulative quantity to return"
              }
              items={indent.items.map((item) => ({
                id: item.id,
                name: item.item_name,
                context:
                  active === "short_supply"
                    ? `requested ${num(item.quantity_requested)}`
                    : active === "receive"
                      ? `issued ${num(item.quantity_issued)}`
                      : `received ${num(item.quantity_received)}`,
              }))}
              values={qty}
              onChange={(itemId, value) =>
                setQty((prev) => ({ ...prev, [itemId]: value }))
              }
            />
          )}

          {active === "propose_substitution" && (
            <div className="space-y-2">
              {shortItems.length === 0 && (
                <p className="text-xs text-amber-400">
                  No short-supplied lines to substitute.
                </p>
              )}
              {shortItems.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-1 gap-2 rounded border border-border p-2 md:grid-cols-4"
                >
                  <div className="text-sm md:col-span-4">
                    {item.item_name}{" "}
                    <span className="text-xs text-muted-foreground">
                      (reserved {num(item.quantity_reserved)} of{" "}
                      {num(item.quantity_requested)})
                    </span>
                  </div>
                  <input
                    type="number"
                    placeholder="Substitute catalog id"
                    aria-label={`Substitute catalog id for ${item.item_name}`}
                    value={subs[item.id]?.catalog_id ?? ""}
                    onChange={(e) =>
                      setSubs((prev) => ({
                        ...prev,
                        [item.id]: {
                          catalog_id: e.target.value,
                          quantity: prev[item.id]?.quantity ?? "",
                          reason: prev[item.id]?.reason ?? "",
                        },
                      }))
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                  <input
                    type="number"
                    placeholder={`Qty (default ${num(item.quantity_requested)})`}
                    aria-label={`Substitute quantity for ${item.item_name}`}
                    value={subs[item.id]?.quantity ?? ""}
                    onChange={(e) =>
                      setSubs((prev) => ({
                        ...prev,
                        [item.id]: {
                          catalog_id: prev[item.id]?.catalog_id ?? "",
                          quantity: e.target.value,
                          reason: prev[item.id]?.reason ?? "",
                        },
                      }))
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Substitution reason *"
                    aria-label={`Substitution reason for ${item.item_name}`}
                    value={subs[item.id]?.reason ?? ""}
                    onChange={(e) =>
                      setSubs((prev) => ({
                        ...prev,
                        [item.id]: {
                          catalog_id: prev[item.id]?.catalog_id ?? "",
                          quantity: prev[item.id]?.quantity ?? "",
                          reason: e.target.value,
                        },
                      }))
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm md:col-span-2"
                  />
                </div>
              ))}
            </div>
          )}

          {(active === "controlled_handoff" ||
            (active === "reconcile" &&
              outstandingControlledReturns.length > 0)) && (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {active === "controlled_handoff"
                  ? "Witnessed dispense evidence (controlled lines)"
                  : "Witnessed return evidence (controlled returns)"}
              </div>
              {(active === "controlled_handoff"
                ? controlledItems
                : outstandingControlledReturns
              ).map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-1 gap-2 rounded border border-border p-2 md:grid-cols-3"
                >
                  <div className="text-sm">{item.item_name}</div>
                  <input
                    type="number"
                    placeholder="Stock movement id *"
                    aria-label={`Movement id for ${item.item_name}`}
                    value={pairs[item.id]?.movement_id ?? ""}
                    onChange={(e) =>
                      setPair(item.id, "movement_id", e.target.value)
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                  <input
                    type="number"
                    placeholder="Schedule register id *"
                    aria-label={`Register id for ${item.item_name}`}
                    value={pairs[item.id]?.register_id ?? ""}
                    onChange={(e) =>
                      setPair(item.id, "register_id", e.target.value)
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {active === "reconcile" && varianceItems.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Variance dispositions (issued − received, unresolved)
              </div>
              {varianceItems.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-1 gap-2 rounded border border-border p-2 md:grid-cols-4"
                >
                  <div className="text-sm">{item.item_name}</div>
                  <input
                    type="number"
                    aria-label={`Variance quantity for ${item.item_name}`}
                    value={recon[item.id]?.quantity ?? ""}
                    onChange={(e) =>
                      setRecon((prev) => ({
                        ...prev,
                        [item.id]: {
                          quantity: e.target.value,
                          disposition:
                            prev[item.id]?.disposition ?? "transit_shortage",
                          note: prev[item.id]?.note ?? "",
                        },
                      }))
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                  <select
                    aria-label={`Disposition for ${item.item_name}`}
                    value={recon[item.id]?.disposition ?? "transit_shortage"}
                    onChange={(e) =>
                      setRecon((prev) => ({
                        ...prev,
                        [item.id]: {
                          quantity: prev[item.id]?.quantity ?? "",
                          disposition: e.target.value,
                          note: prev[item.id]?.note ?? "",
                        },
                      }))
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  >
                    {RECONCILIATION_DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>
                        {d.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Note *"
                    aria-label={`Reconciliation note for ${item.item_name}`}
                    value={recon[item.id]?.note ?? ""}
                    onChange={(e) =>
                      setRecon((prev) => ({
                        ...prev,
                        [item.id]: {
                          quantity: prev[item.id]?.quantity ?? "",
                          disposition:
                            prev[item.id]?.disposition ?? "transit_shortage",
                          note: e.target.value,
                        },
                      }))
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="text-sm text-rose-400" role="alert">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="px-4 py-2 text-sm"
              onClick={() => {
                setActive(null);
                setError(null);
              }}
            >
              Back
            </button>
            <button
              type="button"
              data-testid="ward-indent-action-submit"
              disabled={submitDisabled}
              onClick={() => mutation.mutate(activeDef.key)}
              className={`rounded px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                activeDef.destructive
                  ? "border border-rose-500/40 text-rose-400"
                  : "bg-primary text-primary-foreground"
              }`}
            >
              {mutation.isPending
                ? "Submitting…"
                : `Confirm: ${activeDef.label}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function QuantityGrid({
  label,
  items,
  values,
  onChange,
}: {
  label: string;
  items: Array<{ id: number; name: string; context: string }>;
  values: QtyRowState;
  onChange: (itemId: number, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className="grid grid-cols-2 items-center gap-2 rounded border border-border p-2"
        >
          <div className="text-sm">
            {item.name}{" "}
            <span className="text-xs text-muted-foreground">
              ({item.context})
            </span>
          </div>
          <input
            type="number"
            aria-label={`${label} for ${item.name}`}
            value={values[item.id] ?? ""}
            onChange={(e) => onChange(item.id, e.target.value)}
            className="rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
      ))}
    </div>
  );
}
