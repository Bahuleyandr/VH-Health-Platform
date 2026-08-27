// src/lib/api/wardIndents.ts
//
// Ward-to-pharmacy indent workflow (backend PR #935).
//
// Canonical surface: /api/v1/pharmacy-orders/ward-indents — the route file
// (apps/backend/src/routes/pharmacy/wardIndentRoutes.js) declares that path
// the durable idempotency identity for every mutation, so this module always
// calls the pharmacy-orders spelling rather than the /pharmacy or /ipd
// aliases.
//
// Every mutation below is mounted with `requireIdempotencyKey({ required:
// true })` on the backend — omitting the `Idempotency-Key` header is a hard
// 400. Each mutation therefore takes a REQUIRED `idempotencyKey` parameter.
// Mint it with `useIdempotencyKey`/`createAttemptKeyStore` keyed on the
// payload identity and `reset()` once the attempt concludes; a fresh random
// key per click defeats the replay protection.
//
// Optimistic concurrency: pass the indent's current `state_version` as
// `expected_version`. The backend answers 409 WARD_INDENT_VERSION_CONFLICT
// when the indent moved underneath the operator — refetch and retry.

import { assertIdempotencyKey } from "../idempotencyKey";
import { getJSON, postJSON, type QueryParams } from "./core";

const BASE = "/api/v1/pharmacy-orders/ward-indents";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WardIndentStatus =
  | "requested"
  | "reserved"
  | "short_supply"
  | "substitution_pending"
  | "controlled_handoff_required"
  | "approved"
  | "issued"
  | "partially_received"
  | "received"
  | "return_pending"
  | "reconciliation_required"
  | "reconciled"
  | "rejected"
  | "cancelled"
  | "closed";

export const WARD_INDENT_STATUSES: WardIndentStatus[] = [
  "requested",
  "reserved",
  "short_supply",
  "substitution_pending",
  "controlled_handoff_required",
  "approved",
  "issued",
  "partially_received",
  "received",
  "return_pending",
  "reconciliation_required",
  "reconciled",
  "rejected",
  "cancelled",
  "closed",
];

export interface WardIndentItem {
  id: number;
  item_name: string;
  pharmacy_catalog_id: number | null;
  quantity_requested: string | number;
  quantity_reserved: string | number;
  quantity_approved: string | number;
  quantity_issued: string | number | null;
  quantity_received: string | number;
  quantity_return_requested: string | number;
  quantity_returned: string | number;
  quantity_variance_resolved: string | number;
  fulfilment_status: string;
  unit_price?: string | number | null;
  clinical_order_id?: number | null;
  /** Non-null when this line is a controlled (H/H1/X or narcotic) drug. */
  controlled_reference_id: string | null;
  controlled_movement_id?: number | null;
  controlled_register_id?: number | null;
  substitution_status?: string | null;
  substitution_reason?: string | null;
  proposed_pharmacy_catalog_id?: number | null;
  proposed_item_name?: string | null;
  proposed_quantity?: string | number | null;
  original_item_name?: string | null;
  reconciliation_disposition?: string | null;
  reconciliation_note?: string | null;
  notes?: string | null;
}

export interface WardIndentSla {
  id: number;
  rule_code: string;
  status: "active" | "breached" | "escalated" | string;
  priority: string | null;
  started_at: string;
  due_at: string | null;
}

export interface WardIndentEvent {
  id: number;
  state_version: number;
  action: string;
  from_status: string | null;
  to_status: string;
  actor_uid: string;
  reason: string | null;
  created_at?: string;
}

export interface WardIndentWorkflow {
  owner_role_codes: string[];
  active_slas: WardIndentSla[];
  events?: WardIndentEvent[];
  controlled_handoff_references?: Array<{
    item_id: number;
    reference_id: string;
  }>;
}

export interface WardIndent {
  id: number;
  indent_number: string;
  status: WardIndentStatus;
  state_version: number;
  indent_type: string;
  ward_id: number | null;
  ward_name: string | null;
  admission_id: number | null;
  patient_uid: string | null;
  encounter_id: string | null;
  requested_by: string | null;
  requested_at: string;
  approved_by?: string | null;
  issued_by?: string | null;
  received_by?: string | null;
  last_transition_at?: string | null;
  short_supply_reason?: string | null;
  rejection_reason?: string | null;
  reconciliation_reason?: string | null;
  cancellation_reason?: string | null;
  closure_outcome?: string | null;
  notes?: string | null;
  owner_role_codes: string[] | null;
  items: WardIndentItem[];
  workflow: WardIndentWorkflow;
}

export interface ItemQuantityEntry {
  item_id: number;
  [quantityField: string]: number;
}

export interface SubstitutionProposal {
  item_id: number;
  substitute_catalog_id: number;
  quantity?: number;
  reason: string;
}

export interface ControlledEvidenceEntry {
  item_id: number;
  movement_id: number;
  register_id: number;
}

export interface ItemReconciliationEntry {
  item_id: number;
  quantity_variance_resolved: number;
  disposition:
    | "transit_shortage"
    | "ward_count_variance"
    | "damaged_in_transit"
    | "documented_exception";
  note: string;
}

export interface WardIndentListFilters {
  status?: WardIndentStatus | "";
  ward_id?: number | "";
  admission_id?: number | "";
  patient_uid?: string;
  overdue_only?: boolean;
  limit?: number;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listWardIndents(
  filters: WardIndentListFilters = {},
): Promise<WardIndent[]> {
  const params: QueryParams = {
    status: filters.status || undefined,
    ward_id: filters.ward_id || undefined,
    admission_id: filters.admission_id || undefined,
    patient_uid: filters.patient_uid || undefined,
    overdue_only: filters.overdue_only ? "true" : undefined,
    limit: filters.limit,
  };
  return getJSON<WardIndent[]>(BASE, params);
}

export function getWardIndent(indentId: number): Promise<WardIndent> {
  return getJSON<WardIndent>(`${BASE}/${indentId}`);
}

// ─── Workflow actions ────────────────────────────────────────────────────────
// Each maps 1:1 onto a POST route in wardIndentRoutes.js. `expected_version`
// is the state_version the operator was looking at.

interface ActionBase {
  expected_version?: number;
}

function act<T = WardIndent>(
  indentId: number,
  action: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  return postJSON<T>(`${BASE}/${indentId}/${action}`, body, true, {
    "Idempotency-Key": assertIdempotencyKey(idempotencyKey),
  });
}

/** requested | short_supply → reserved (pharmacy supply roles). */
export function reserveWardIndent(
  indentId: number,
  data: ActionBase & { item_quantities_reserved?: ItemQuantityEntry[] },
  idempotencyKey: string,
) {
  return act(indentId, "reserve", data, idempotencyKey);
}

/** requested | reserved | short_supply → short_supply (pharmacy supply roles). */
export function markWardIndentShortSupply(
  indentId: number,
  data: ActionBase & {
    reason: string;
    item_quantities_available: ItemQuantityEntry[];
  },
  idempotencyKey: string,
) {
  return act(indentId, "short-supply", data, idempotencyKey);
}

/** short_supply → substitution_pending (pharmacy supply roles). */
export function proposeWardIndentSubstitution(
  indentId: number,
  data: ActionBase & { substitutions: SubstitutionProposal[] },
  idempotencyKey: string,
) {
  return act(indentId, "substitutions", data, idempotencyKey);
}

/** substitution_pending → reserved | short_supply (doctor tiers only). */
export function approveWardIndentSubstitution(
  indentId: number,
  data: ActionBase,
  idempotencyKey: string,
) {
  return act(indentId, "substitutions/approve", data, idempotencyKey);
}

/** substitution_pending → short_supply (doctor tiers only). */
export function rejectWardIndentSubstitution(
  indentId: number,
  data: ActionBase & { reason: string },
  idempotencyKey: string,
) {
  return act(indentId, "substitutions/reject", data, idempotencyKey);
}

/** reserved → approved | controlled_handoff_required (pharmacy supply roles). */
export function approveWardIndent(
  indentId: number,
  data: ActionBase,
  idempotencyKey: string,
) {
  return act(indentId, "approve", data, idempotencyKey);
}

/** pre-issue states → rejected (pharmacy supply roles). */
export function rejectWardIndent(
  indentId: number,
  data: ActionBase & { reason: string },
  idempotencyKey: string,
) {
  return act(indentId, "reject", data, idempotencyKey);
}

/**
 * controlled_handoff_required → approved (pharmacy supply roles). Requires
 * witnessed dispense evidence (pharmacy_stock_movements + schedule register
 * ids) per controlled line.
 */
export function recordWardIndentControlledHandoff(
  indentId: number,
  data: ActionBase & { item_evidence: ControlledEvidenceEntry[] },
  idempotencyKey: string,
) {
  return act(indentId, "controlled-handoff", data, idempotencyKey);
}

/** approved → issued (pharmacy supply roles). */
export function issueWardIndent(
  indentId: number,
  data: ActionBase & { item_quantities_issued?: ItemQuantityEntry[] },
  idempotencyKey: string,
) {
  return act(indentId, "issue", data, idempotencyKey);
}

/**
 * issued | partially_received → received | partially_received (ward nursing
 * roles; the backend refuses the issuing actor).
 */
export function receiveWardIndent(
  indentId: number,
  data: ActionBase & { item_quantities_received?: ItemQuantityEntry[] },
  idempotencyKey: string,
) {
  return act(indentId, "receive", data, idempotencyKey);
}

/** partially_received | received → return_pending (ward nursing roles). */
export function requestWardIndentReturn(
  indentId: number,
  data: ActionBase & {
    reason: string;
    item_quantities_returned: ItemQuantityEntry[];
  },
  idempotencyKey: string,
) {
  return act(indentId, "returns", data, idempotencyKey);
}

/** issued/receipt states → reconciliation_required (ward nursing roles). */
export function reportWardIndentDiscrepancy(
  indentId: number,
  data: ActionBase & { reason: string },
  idempotencyKey: string,
) {
  return act(indentId, "discrepancies", data, idempotencyKey);
}

/** return_pending | reconciliation_required → reconciled (incharge roles). */
export function reconcileWardIndent(
  indentId: number,
  data: ActionBase & {
    reason: string;
    item_reconciliations?: ItemReconciliationEntry[];
    controlled_return_evidence?: ControlledEvidenceEntry[];
  },
  idempotencyKey: string,
) {
  return act(indentId, "reconcile", data, idempotencyKey);
}

/** pre-issue states → cancelled (any read role). */
export function cancelWardIndent(
  indentId: number,
  data: ActionBase & { reason: string },
  idempotencyKey: string,
) {
  return act(indentId, "cancel", data, idempotencyKey);
}

/** received | reconciled → closed (incharge roles). */
export function closeWardIndent(
  indentId: number,
  data: ActionBase & { reason: string },
  idempotencyKey: string,
) {
  return act(indentId, "close", data, idempotencyKey);
}
