// src/app/(with-auth)/dashboard/ward-indents/components/helpers.tsx
//
// Shared presentational helpers + the action catalogue for the ward-indent
// worklist. The catalogue mirrors the backend state machine exactly
// (apps/backend/src/routes/pharmacy/wardIndentRoutes.js /
// wardIndentWorkflowService.js `allowedStatuses`); the backend remains the
// authority — an action fired from a stale view answers 409 and the page
// refetches.

"use client";

import type { WardIndentStatus } from "@/lib/api/wardIndents";

export type WardIndentActionKey =
  | "reserve"
  | "short_supply"
  | "propose_substitution"
  | "approve_substitution"
  | "reject_substitution"
  | "approve"
  | "reject"
  | "controlled_handoff"
  | "issue"
  | "receive"
  | "return_request"
  | "discrepancy"
  | "reconcile"
  | "cancel"
  | "close";

export interface WardIndentActionDef {
  key: WardIndentActionKey;
  label: string;
  /** Statuses the backend accepts this action from. */
  statuses: WardIndentStatus[];
  /** A non-empty reason is required by the backend. */
  needsReason?: boolean;
  /** Rendered as a destructive/terminal button. */
  destructive?: boolean;
  /** Short operator hint shown in the form. */
  hint?: string;
}

// Order matters: rendered top-to-bottom as the natural workflow order.
export const WARD_INDENT_ACTIONS: WardIndentActionDef[] = [
  {
    key: "reserve",
    label: "Reserve stock",
    statuses: ["requested", "short_supply"],
    hint: "Reserves the full requested quantity of every line. If a line cannot be fully reserved, record short supply instead.",
  },
  {
    key: "short_supply",
    label: "Record short supply",
    statuses: ["requested", "reserved", "short_supply"],
    needsReason: true,
    hint: "Enter the quantity actually available per line. At least one line must be below its requested quantity.",
  },
  {
    key: "propose_substitution",
    label: "Propose substitution",
    statuses: ["short_supply"],
    hint: "For short-supplied lines, propose a different catalog item. A doctor must approve the substitution.",
  },
  {
    key: "approve_substitution",
    label: "Approve substitution (doctor)",
    statuses: ["substitution_pending"],
    hint: "Doctor-tier decision. Applies every pending substitution and re-reserves stock.",
  },
  {
    key: "reject_substitution",
    label: "Reject substitution (doctor)",
    statuses: ["substitution_pending"],
    needsReason: true,
    destructive: true,
  },
  {
    key: "approve",
    label: "Approve indent",
    statuses: ["reserved"],
    hint: "Requires every line fully reserved. Controlled lines route to witnessed controlled handoff first.",
  },
  {
    key: "controlled_handoff",
    label: "Record controlled handoff",
    statuses: ["controlled_handoff_required"],
    hint: "Enter the witnessed dispense evidence (stock movement id + schedule-register entry id) for every controlled line.",
  },
  {
    key: "issue",
    label: "Issue to ward",
    statuses: ["approved"],
    hint: "Issues every line at its approved quantity and decrements pharmacy stock.",
  },
  {
    key: "receive",
    label: "Record ward receipt",
    statuses: ["issued", "partially_received"],
    hint: "Cumulative received quantity per line. The issuing pharmacist cannot also acknowledge receipt.",
  },
  {
    key: "return_request",
    label: "Request return",
    statuses: ["partially_received", "received"],
    needsReason: true,
    hint: "Cumulative return quantity per line (cannot exceed received).",
  },
  {
    key: "discrepancy",
    label: "Report discrepancy",
    statuses: ["issued", "partially_received", "received", "return_pending"],
    needsReason: true,
    destructive: true,
  },
  {
    key: "reconcile",
    label: "Reconcile",
    statuses: ["return_pending", "reconciliation_required"],
    needsReason: true,
    hint: "Every unreceived issued unit needs an exact variance disposition; controlled returns need witnessed return evidence.",
  },
  {
    key: "reject",
    label: "Reject indent",
    statuses: [
      "requested",
      "reserved",
      "short_supply",
      "substitution_pending",
      "controlled_handoff_required",
      "approved",
    ],
    needsReason: true,
    destructive: true,
  },
  {
    key: "cancel",
    label: "Cancel indent",
    statuses: [
      "requested",
      "reserved",
      "short_supply",
      "substitution_pending",
      "controlled_handoff_required",
      "approved",
    ],
    needsReason: true,
    destructive: true,
  },
  {
    key: "close",
    label: "Close indent",
    statuses: ["received", "reconciled"],
    needsReason: true,
  },
];

export function actionsForStatus(
  status: WardIndentStatus,
): WardIndentActionDef[] {
  return WARD_INDENT_ACTIONS.filter((a) => a.statuses.includes(status));
}

// ─── Presentational bits ─────────────────────────────────────────────────────

const STATUS_TONES: Record<string, string> = {
  requested: "bg-blue-500/15 text-blue-400",
  reserved: "bg-cyan-500/15 text-cyan-400",
  short_supply: "bg-amber-500/15 text-amber-400",
  substitution_pending: "bg-purple-500/15 text-purple-400",
  controlled_handoff_required: "bg-orange-500/15 text-orange-400",
  approved: "bg-sky-500/15 text-sky-400",
  issued: "bg-indigo-500/15 text-indigo-400",
  partially_received: "bg-teal-500/15 text-teal-400",
  received: "bg-emerald-500/15 text-emerald-400",
  return_pending: "bg-amber-500/15 text-amber-400",
  reconciliation_required: "bg-rose-500/15 text-rose-400",
  reconciled: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-rose-500/15 text-rose-400",
  cancelled: "bg-muted text-muted-foreground",
  closed: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${
        STATUS_TONES[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function num(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}
