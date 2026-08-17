import { fetchAdminAPI } from "@/lib/api/core";
import {
  listFacilityAssetCustodians,
  listFacilityAssets,
  recordFacilityAssetMaintenance,
  updateFacilityAsset,
} from "@/lib/api/facilityAssets";

jest.mock("@/lib/api/core", () => ({ fetchAdminAPI: jest.fn() }));

describe("facility asset API concurrency contract", () => {
  it("includes the edit snapshot version in the PATCH body", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue({ id: 7, version: 4 });

    await updateFacilityAsset(7, { name: "Generator revised" }, 3);

    expect(fetchAdminAPI).toHaveBeenCalledWith("/facility/assets/7", {
      method: "PATCH",
      body: { name: "Generator revised", expectedVersion: 3 },
    });
  });

  it("sends server search, custodian and pagination with the backend query keys", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue({ assets: [], total: 0 });

    await listFacilityAssets({
      status: "active",
      category: "generator",
      custodianUid: "33333333-3333-4333-8333-333333333333",
      q: "plant room",
      limit: 50,
      offset: 0,
    });

    expect(fetchAdminAPI).toHaveBeenCalledWith(
      "/facility/assets?status=active&category=generator&custodian_uid=33333333-3333-4333-8333-333333333333&q=plant+room&limit=50&offset=0",
    );
  });

  it("loads the bounded tenant custodian picker", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue({ custodians: [] });

    await listFacilityAssetCustodians();

    expect(fetchAdminAPI).toHaveBeenCalledWith(
      "/facility/assets/custodians?limit=500",
    );
  });

  it("sends maintenance vendor and cost", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue({ asset: { id: 7 } });

    await recordFacilityAssetMaintenance(
      7,
      "Replaced coolant hose",
      4500.5,
      "Kirloskar Service",
    );

    expect(fetchAdminAPI).toHaveBeenCalledWith(
      "/facility/assets/7/maintenance",
      {
        method: "POST",
        body: {
          notes: "Replaced coolant hose",
          cost: 4500.5,
          vendor: "Kirloskar Service",
        },
      },
    );
  });
});
