"use client";

// Ward pick-list for the linen dialogs.
//
// linen_ward_par_levels.ward_id and linen_laundry_cycles.ward_id are FKs to
// `wards`, and linenLaundryService.loadWard() 404s an id it cannot find, so a
// ward has to be CHOSEN, not typed. The only list endpoint is GET /api/v1/wards
// — which sits behind a different gate from the linen router
// (BED_PARENT_ROUTE_ROLES, plus the `departmentManagement` per-admin proxy flag
// for ADMIN accounts). Housekeeping, nursing, IP-flow and pharmacy roles hold
// both; STORES_PURCHASE_INCHARGE holds the linen gate but not the ward one.
//
// So this hook never pretends: it returns the wards it could read AND the
// error, and the dialogs render the backend's own refusal instead of an empty
// dropdown that looks like "no wards exist".

import { fetchAdminAPI } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export type WardOption = { id: number; name: string };

function unwrapWards(payload: unknown): WardOption[] {
  const data = (payload as { data?: unknown })?.data ?? payload;
  const rows = Array.isArray(data)
    ? data
    : ((data as { wards?: unknown })?.wards ?? []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const ward = row as { id?: unknown; name?: unknown };
      const id = Number(ward.id);
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      return { id, name: String(ward.name ?? `Ward ${id}`) };
    })
    .filter((ward): ward is WardOption => ward !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function useWardOptions() {
  const query = useQuery<WardOption[]>({
    queryKey: ["linen-laundry", "wards"],
    queryFn: async () => unwrapWards(await fetchAdminAPI<unknown>("/wards")),
    staleTime: 5 * 60_000,
    retry: false,
  });

  return {
    wards: query.data ?? [],
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Could not load the ward list"
          : null,
  };
}
