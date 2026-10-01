// Ward directory access is independent of the existing linen write authorization.

import { fetchAdminAPI } from "@/lib/api";
import { z } from "zod";

const wardPageSchema = z.object({
  items: z.array(z.object({ id: z.number().int().positive(), name: z.string() }).strict()).max(200),
  next_cursor: z.string().min(1).max(2048).nullable(),
}).strict();

export type LinenWardPage = z.infer<typeof wardPageSchema>;

export async function listLinenWardOptions(
  params: { q?: string; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<LinenWardPage> {
  signal?.throwIfAborted();
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.size ? `?${query}` : "";
  const payload = await fetchAdminAPI<unknown>(`/linen-laundry/wards${suffix}`);
  signal?.throwIfAborted();
  const parsed = wardPageSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Could not read the ward directory");
  return parsed.data;
}

/** Mirror of ITEM_CATEGORIES in apps/backend/src/services/linen/linenLaundryService.js. */
export const LINEN_ITEM_CATEGORIES = [
  "bed_linen",
  "patient_linen",
  "staff_linen",
  "ot_linen",
  "housekeeping",
  "other",
] as const;

export type LinenItemCategory = (typeof LINEN_ITEM_CATEGORIES)[number];

/**
 * Mirror of CYCLE_TRANSITIONS in
 * apps/backend/src/services/linen/linenLaundryService.js. The service throws
 * AppError.invalidTransition for anything not listed, so a button offered for
 * an unlisted transition would be a control that can only ever 409. Pinned
 * against the backend source by
 * src/__tests__/dashboard/linen-laundry/transition-contract.test.ts.
 */
export const LINEN_CYCLE_TRANSITIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  collection_requested: ["collected", "cancelled"],
  collected: ["in_laundry", "cancelled"],
  in_laundry: ["returned", "cancelled"],
  returned: ["reconciled", "cancelled"],
  reconciled: [],
  cancelled: [],
});

export function linenCycleTransitions(status?: string): readonly string[] {
  return LINEN_CYCLE_TRANSITIONS[String(status || "").toLowerCase()] ?? [];
}

export type LinenItemType = {
  id: number;
  item_code: string;
  display_name: string;
  category: string;
  unit: string;
  active: boolean;
  created_at?: string;
  updated_at?: string;
};

export type LinenParLevel = {
  id: number;
  ward_id: number;
  ward_name: string;
  item_type_id: number;
  item_code: string;
  display_name: string;
  category: string;
  unit: string;
  par_quantity: number;
  actual_quantity: number;
  reorder_threshold: number;
  par_delta: number;
  below_par: boolean;
  last_counted_at?: string | null;
  updated_at?: string;
};

export type LinenCycle = {
  id: number;
  cycle_code: string;
  ward_id: number;
  ward_name: string;
  status: string;
  discrepancy_flag: boolean;
  item_count: number;
  soiled_collected_quantity: number;
  clean_returned_quantity: number;
  notes?: string | null;
  cancellation_reason?: string | null;
  updated_at?: string;
};

export type LinenCycleItem = {
  id: number;
  cycle_id: number;
  item_type_id: number;
  item_code: string;
  display_name: string;
  category: string;
  unit: string;
  soiled_planned_quantity: number;
  soiled_collected_quantity: number;
  clean_returned_quantity: number;
  damaged_quantity: number;
  missing_quantity: number;
  discrepancy_quantity: number;
  discrepancy_flag: boolean;
  notes?: string | null;
};

/** GET /linen-laundry/cycles/{id} — the cycle row plus its per-item counts. */
export type LinenCycleDetail = Omit<LinenCycle, "item_count"> & {
  items: LinenCycleItem[];
};

export type LinenBoard = {
  summary: {
    par_level_count: number;
    below_par_count: number;
    open_cycle_count: number;
    discrepancy_cycle_count: number;
    shortage_quantity: number;
  };
  par_levels: LinenParLevel[];
  cycles: LinenCycle[];
};

export function getLinenBoard(params?: { wardId?: number; limit?: number }) {
  const query = new URLSearchParams();
  if (params?.wardId) query.set("ward_id", String(params.wardId));
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<LinenBoard>(`/linen-laundry/board${suffix}`);
}

export function listLinenItemTypes(params?: { active?: boolean }) {
  const query = new URLSearchParams();
  if (params?.active !== undefined) query.set("active", String(params.active));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<LinenItemType[]>(`/linen-laundry/item-types${suffix}`);
}

/**
 * POST /linen-laundry/item-types — upsert on (tenant_id, item_code). The
 * service upper-cases item_code, so editing an existing type means sending the
 * same code back; a changed code creates a second type rather than renaming.
 */
export function upsertLinenItemType(body: {
  item_code: string;
  display_name: string;
  category: string;
  unit?: string;
  active?: boolean;
}) {
  return fetchAdminAPI<LinenItemType>("/linen-laundry/item-types", {
    method: "POST",
    body,
  });
}

/** PUT /linen-laundry/par-levels — upsert on (tenant_id, ward_id, item_type_id). */
export function upsertLinenParLevel(body: {
  ward_id: number;
  item_type_id: number;
  par_quantity: number;
  actual_quantity?: number;
  reorder_threshold?: number;
  notes?: string;
}) {
  return fetchAdminAPI<LinenParLevel>("/linen-laundry/par-levels", {
    method: "PUT",
    body,
  });
}

export function getLinenCycle(id: number) {
  return fetchAdminAPI<LinenCycleDetail>(`/linen-laundry/cycles/${id}`);
}

export function createLinenCycle(body: {
  ward_id: number;
  items: { item_type_id: number; soiled_planned_quantity: number }[];
  notes?: string;
}) {
  return fetchAdminAPI<LinenCycleDetail>("/linen-laundry/cycles", {
    method: "POST",
    body,
  });
}

/**
 * POST .../collect — an empty `items` array is NOT the same as omitting it:
 * the service copies soiled_planned_quantity into soiled_collected_quantity
 * only when no items are supplied. Callers that send counts must send every
 * item they want counted.
 */
export function collectLinenCycle(
  id: number,
  body: {
    items?: { item_type_id: number; soiled_collected_quantity: number }[];
  },
) {
  return fetchAdminAPI<LinenCycleDetail>(
    `/linen-laundry/cycles/${id}/collect`,
    {
      method: "POST",
      body,
    },
  );
}

export function sendLinenCycleToLaundry(id: number) {
  return fetchAdminAPI<LinenCycleDetail>(
    `/linen-laundry/cycles/${id}/laundry`,
    {
      method: "POST",
      body: {},
    },
  );
}

/** POST .../return — `items` is required and must cover the items being counted. */
export function returnLinenCycle(
  id: number,
  body: {
    items: {
      item_type_id: number;
      soiled_collected_quantity: number;
      clean_returned_quantity: number;
      damaged_quantity: number;
    }[];
  },
) {
  return fetchAdminAPI<LinenCycleDetail>(`/linen-laundry/cycles/${id}/return`, {
    method: "POST",
    body,
  });
}

export function reconcileLinenCycle(id: number) {
  return fetchAdminAPI<LinenCycleDetail>(
    `/linen-laundry/cycles/${id}/reconcile`,
    { method: "POST", body: {} },
  );
}

export function cancelLinenCycle(id: number, body: { reason?: string }) {
  return fetchAdminAPI<LinenCycleDetail>(`/linen-laundry/cycles/${id}/cancel`, {
    method: "POST",
    body,
  });
}
