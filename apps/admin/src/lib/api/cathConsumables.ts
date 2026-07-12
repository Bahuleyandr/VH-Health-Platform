import type { ApiBody, ApiData } from "@/lib/openapi-data";

import { getJSON, putJSON } from "./core";

export const CATH_CONSUMABLES_CATALOG_PATH =
  "/api/v1/admin/cath-consumables/catalog" as const;
export const CATH_CONSUMABLES_UNBILLED_PATH =
  "/api/v1/admin/cath-consumables/unbilled-usage" as const;
export const CATH_CONSUMABLES_BILLING_SETTINGS_PATH =
  "/api/v1/admin/cath-consumables/billing-settings" as const;

const INVENTORY_LOOKUP_PATH =
  "/api/v1/admin/pharmacy-supply/inventory-items" as const;

export type CathConsumablesCatalog = ApiData<
  typeof CATH_CONSUMABLES_CATALOG_PATH,
  "get"
>;
export type CathConsumableCatalogItem = CathConsumablesCatalog["items"][number];
export type CathConsumableCatalogInput = ApiBody<
  typeof CATH_CONSUMABLES_CATALOG_PATH,
  "put"
>;
export type CathConsumableCatalogResult = ApiData<
  typeof CATH_CONSUMABLES_CATALOG_PATH,
  "put"
>;

export type CathConsumablesUnbilledUsage = ApiData<
  typeof CATH_CONSUMABLES_UNBILLED_PATH,
  "get"
>;
export type CathConsumableUnbilledUsageItem =
  CathConsumablesUnbilledUsage["items"][number];

export type CathConsumablesBillingSettings = ApiData<
  typeof CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
  "get"
>;
export type CathConsumablesBillingSettingsInput = ApiBody<
  typeof CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
  "put"
>;

export interface InventoryLookupItem {
  id: number;
  sku_code: string;
  display_name: string;
  manufacturer: string | null;
  status: string;
}

interface InventoryLookupResponse {
  items: InventoryLookupItem[];
  count: number;
}

export function listCathConsumablesCatalog(
  params: {
    q?: string;
    category?: string;
    status?: string;
    limit?: number;
  } = {},
) {
  return getJSON<CathConsumablesCatalog>(CATH_CONSUMABLES_CATALOG_PATH, {
    q: params.q,
    category: params.category,
    status: params.status,
    limit: params.limit,
  });
}

export function upsertCathConsumable(payload: CathConsumableCatalogInput) {
  return putJSON<CathConsumableCatalogResult>(
    CATH_CONSUMABLES_CATALOG_PATH,
    payload,
  );
}

export function listCathConsumablesUnbilledUsage(
  params: {
    date_from?: string;
    date_to?: string;
    page?: number;
    limit?: number;
  } = {},
) {
  return getJSON<CathConsumablesUnbilledUsage>(CATH_CONSUMABLES_UNBILLED_PATH, {
    date_from: params.date_from,
    date_to: params.date_to,
    page: params.page,
    limit: params.limit,
  });
}

export function getCathConsumablesBillingSettings() {
  return getJSON<CathConsumablesBillingSettings>(
    CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
  );
}

export function updateCathConsumablesBillingSettings(
  payload: CathConsumablesBillingSettingsInput,
) {
  return putJSON<CathConsumablesBillingSettings>(
    CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
    payload,
  );
}

export function listActiveInventoryItems(
  params: { q?: string; limit?: number } = {},
) {
  return getJSON<InventoryLookupResponse>(INVENTORY_LOOKUP_PATH, {
    status: "active",
    q: params.q,
    limit: params.limit ?? 50,
  });
}
