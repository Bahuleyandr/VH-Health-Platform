import FacilityAssetsPage from "@/app/(with-auth)/dashboard/facility-assets/page";
import { APIError } from "@/lib/api/core";
import {
  listFacilityAssets,
  updateFacilityAsset,
  type FacilityAsset,
} from "@/lib/api/facilityAssets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api/facilityAssets", () => ({
  FACILITY_ASSET_CATEGORIES: [
    "furniture",
    "hvac",
    "electrical",
    "plumbing",
    "it_equipment",
    "generator",
    "vehicle",
    "kitchen",
    "laundry",
    "safety",
    "infrastructure",
    "other",
  ],
  FACILITY_ASSET_CONDITIONS: ["good", "fair", "poor"],
  FACILITY_ASSET_STATUSES: [
    "active",
    "under_repair",
    "condemned",
    "disposed",
  ],
  createFacilityAsset: jest.fn(),
  getFacilityAsset: jest.fn(),
  listFacilityAssets: jest.fn(),
  recordFacilityAssetMaintenance: jest.fn(),
  transitionFacilityAsset: jest.fn(),
  updateFacilityAsset: jest.fn(),
}));

const ASSET: FacilityAsset = {
  id: 7,
  assetTag: "GEN-02",
  name: "Generator",
  category: "generator",
  description: null,
  locationDepartment: "Plant room",
  locationRoom: "B-04",
  custodianUid: null,
  vendor: null,
  purchaseDate: null,
  purchaseCost: null,
  warrantyUntil: null,
  condition: "good",
  status: "active",
  version: 3,
  disposalReason: null,
  disposedAt: null,
  disposedBy: null,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FacilityAssetsPage />
    </QueryClientProvider>,
  );
}

describe("<FacilityAssetsPage /> optimistic concurrency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listFacilityAssets as jest.Mock).mockResolvedValue({
      assets: [ASSET],
      total: 1,
      limit: 200,
      offset: 0,
    });
  });

  it("sends the edit snapshot version and keeps the form open on a stale conflict", async () => {
    (updateFacilityAsset as jest.Mock).mockRejectedValue(
      new APIError("Facility asset changed since it was loaded", 409, {
        code: "FACILITY_ASSET_STALE_WRITE",
        details: { expectedVersion: 3, currentVersion: 4 },
      }),
    );
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Edit GEN-02" }),
    );
    fireEvent.change(screen.getByLabelText("Asset name"), {
      target: { value: "Generator revised" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save asset" }));

    await waitFor(() =>
      expect(updateFacilityAsset).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ name: "Generator revised" }),
        3,
      ),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "This asset changed after you opened it. Review the latest values before saving again.",
    );
    expect(screen.getByLabelText("Asset name")).toHaveValue(
      "Generator revised",
    );
  });
});
