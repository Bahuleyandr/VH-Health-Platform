import { fetchAdminAPI } from "@/lib/api/core";
import { updateFacilityAsset } from "@/lib/api/facilityAssets";

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
});
