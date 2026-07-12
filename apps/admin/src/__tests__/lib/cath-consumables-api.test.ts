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
      q: "stent",
      category: "stent",
      status: "active",
      limit: 500,
    });
    expect(mockedGetJSON).toHaveBeenCalledWith(CATH_CONSUMABLES_CATALOG_PATH, {
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
    await upsertCathConsumable(payload);
    expect(mockedPutJSON).toHaveBeenCalledWith(
      CATH_CONSUMABLES_CATALOG_PATH,
      payload,
    );
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
