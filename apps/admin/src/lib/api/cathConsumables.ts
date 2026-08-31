import type { ApiBody, ApiData } from "@/lib/openapi-data";
import { assertIdempotencyKey } from "../idempotencyKey";

import { getJSON, putJSON } from "./core";
import { listFacilities, type Facility } from "./facilityMasters";

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

/**
 * Facility options for the Cath catalog facility selector.
 *
 * The catalog read below is facility-scoped and the backend refuses to guess:
 * `listConsumableCatalog` throws `case_id or facility_id is required for
 * facility-scoped Cath catalog access` when neither is supplied. The admin
 * portal has no case to pin a facility from, so the operator picks one — and
 * the choice comes from the real facility master, never from a client-side
 * assumption about which facility "the" catalog belongs to.
 */
export type CathCatalogFacility = Facility;

export function listCathConsumablesFacilities() {
  return listFacilities({ status: "active", limit: 200 });
}

export function listCathConsumablesCatalog(params: {
  /**
   * REQUIRED. `cathConsumablesRoutes.js` forwards `req.query.facility_id`
   * straight into the facility-scoped service, so a call without it is a hard
   * failure, not a broader search. Typed as required so a call site that
   * forgets it fails to compile instead of failing in production.
   */
  facility_id: number;
  q?: string;
  category?: string;
  status?: string;
  limit?: number;
}) {
  return getJSON<CathConsumablesCatalog>(CATH_CONSUMABLES_CATALOG_PATH, {
    facility_id: params.facility_id,
    q: params.q,
    category: params.category,
    status: params.status,
    limit: params.limit,
  });
}

/**
 * PUT /api/v1/admin/cath-consumables/catalog.
 *
 * The route is mounted with `requireIdempotencyKey({ required: true, scope:
 * 'cath_consumable_catalog_upsert' })`, so the header is not optional —
 * omitting it is a hard 400, not a degraded save. `idempotencyKey` is
 * therefore a REQUIRED parameter: a call site that forgets it fails to
 * compile instead of failing in production.
 *
 * Mint the key with `useIdempotencyKey`/`createAttemptKeyStore`, keyed on
 * `payloadIdentity(payload)`, and `reset()` the attempt once the save
 * concludes. Do NOT hold the store here in the module: a module-level store is
 * never reset, so a deliberate second edit that happens to produce the same
 * payload identity would reuse the first attempt's key and the backend would
 * replay the recorded response instead of writing — silent write loss. Do not
 * pass a fresh `crypto.randomUUID()` per click either: that makes a
 * double-click save twice, which is the failure this header exists to prevent.
 */
export function upsertCathConsumable(
  payload: CathConsumableCatalogInput,
  idempotencyKey: string,
) {
  return putJSON<CathConsumableCatalogResult>(
    CATH_CONSUMABLES_CATALOG_PATH,
    payload,
    true,
    { "Idempotency-Key": assertIdempotencyKey(idempotencyKey) },
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
