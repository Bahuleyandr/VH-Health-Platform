import { getJSON, putJSON } from "@/lib/api/core";
import {
  CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
  CATH_CONSUMABLES_CATALOG_PATH,
  CATH_CONSUMABLES_UNBILLED_PATH,
  getCathConsumablesBillingSettings,
  listActiveInventoryItems,
  listCathConsumablesCatalog,
  listCathConsumablesUnbilledUsage,
  updateCathConsumablesBillingSettings,
  upsertCathConsumable,
} from "@/lib/api/cathConsumables";

jest.mock("@/lib/api/core", () => ({
  getJSON: jest.fn(),
  putJSON: jest.fn(),
}));

const mockedGetJSON = getJSON as jest.MockedFunction<typeof getJSON>;
const mockedPutJSON = putJSON as jest.MockedFunction<typeof putJSON>;

describe("cath consumables admin API client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetJSON.mockResolvedValue({} as never);
    mockedPutJSON.mockResolvedValue({} as never);
  });

  it("uses the exact catalog GET and PUT contract", async () => {
    await listCathConsumablesCatalog({
      facility_id: 7,
      q: "stent",
      category: "stent",
      status: "active",
      limit: 500,
    });
    // facility_id is not decoration: the admin catalog read has no case to pin
    // a facility from, so `listConsumableCatalog` throws without it.
    expect(mockedGetJSON).toHaveBeenCalledWith(CATH_CONSUMABLES_CATALOG_PATH, {
      facility_id: 7,
      q: "stent",
      category: "stent",
      status: "active",
      limit: 500,
    });

    const payload = {
      item_name: "Synthetic stent",
      category: "stent",
      manufacturer: null,
      model: null,
      is_implant: true,
      batch_tracked: true,
      default_unit_cost_reference: null,
      billing_item_code: null,
      inventory_item_id: null,
      status: "active",
    } as never;
    await upsertCathConsumable(payload, "cath-consumable-catalog-upsert:a1b2");
    // The route is mounted with `requireIdempotencyKey({ required: true })`, so
    // a PUT without the header is a hard 400 rather than a degraded save. The
    // key is minted and reset by the React layer (see CatalogTab) and forwarded
    // verbatim here — this module holds no attempt state of its own, because a
    // module-level store is never reset and would swallow a deliberate second
    // save of the same payload as a replay.
    expect(mockedPutJSON).toHaveBeenCalledWith(
      CATH_CONSUMABLES_CATALOG_PATH,
      payload,
      true,
      { "Idempotency-Key": "cath-consumable-catalog-upsert:a1b2" },
    );
  });

  it("refuses a malformed catalog idempotency key before the request leaves the browser", () => {
    const payload = { item_name: "Synthetic stent", status: "active" } as never;

    // A 400 from the server is indistinguishable from "the header was never
    // sent", so a bad key is a call-site programming error caught locally.
    expect(() => upsertCathConsumable(payload, "not a valid key")).toThrow(
      TypeError,
    );
    expect(mockedPutJSON).not.toHaveBeenCalled();
  });

  it("uses the exact unbilled report contract and preserves filters", async () => {
    await listCathConsumablesUnbilledUsage({
      date_from: "2026-07-01",
      date_to: "2026-07-11",
      page: 3,
      limit: 50,
    });

    expect(mockedGetJSON).toHaveBeenCalledWith(CATH_CONSUMABLES_UNBILLED_PATH, {
      date_from: "2026-07-01",
      date_to: "2026-07-11",
      page: 3,
      limit: 50,
    });
  });

  it("uses the exact billing settings GET and PUT contract", async () => {
    await getCathConsumablesBillingSettings();
    expect(mockedGetJSON).toHaveBeenCalledWith(
      CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
    );

    const payload = {
      charge_enabled: false,
      procedure_billing_code: null,
      procedure_unit_price: null,
      gst_rate: null,
      finance_reviewed_at: null,
    } as never;
    await updateCathConsumablesBillingSettings(payload);
    expect(mockedPutJSON).toHaveBeenCalledWith(
      CATH_CONSUMABLES_BILLING_SETTINGS_PATH,
      payload,
    );
  });

  it("loads active inventory choices from the existing supply-chain master", async () => {
    await listActiveInventoryItems({ q: "coronary", limit: 50 });

    expect(mockedGetJSON).toHaveBeenCalledWith(
      "/api/v1/admin/pharmacy-supply/inventory-items",
      { status: "active", q: "coronary", limit: 50 },
    );
  });
});
