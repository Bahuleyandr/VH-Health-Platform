import FacilityAssetsPage from "@/app/(with-auth)/dashboard/facility-assets/page";
import { APIError } from "@/lib/api/core";
import {
  getFacilityAsset,
  listFacilityAssetCustodians,
  listFacilityAssets,
  recordFacilityAssetMaintenance,
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
  FACILITY_ASSET_STATUSES: ["active", "under_repair", "condemned", "disposed"],
  createFacilityAsset: jest.fn(),
  getFacilityAsset: jest.fn(),
  listFacilityAssets: jest.fn(),
  listFacilityAssetCustodians: jest.fn(),
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
    (listFacilityAssetCustodians as jest.Mock).mockResolvedValue({
      custodians: [
        {
          uid: "33333333-3333-4333-8333-333333333333",
          name: "Maya Rao",
          role: "MAINTENANCE",
        },
      ],
      limit: 500,
    });
    (listFacilityAssets as jest.Mock).mockResolvedValue({
      assets: [ASSET],
      total: 101,
      limit: 50,
      offset: 0,
    });
  });

  it("rebases edited fields onto the latest version after a stale conflict", async () => {
    const latest = { ...ASSET, version: 4, vendor: "Concurrent vendor" };
    (getFacilityAsset as jest.Mock).mockResolvedValue(latest);
    (updateFacilityAsset as jest.Mock)
      .mockRejectedValueOnce(
        new APIError("Facility asset changed since it was loaded", 409, {
          code: "FACILITY_ASSET_STALE_WRITE",
          details: { expectedVersion: 3, currentVersion: 4 },
        }),
      )
      .mockResolvedValueOnce({
        ...latest,
        version: 5,
        name: "Generator revised",
      });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit GEN-02" }));
    fireEvent.change(screen.getByLabelText("Asset name"), {
      target: { value: "Generator revised" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save asset" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This asset changed after you opened it. Latest values were loaded and your edited fields were preserved; review and save again.",
      ),
    );
    expect(screen.getByLabelText("Asset name")).toHaveValue(
      "Generator revised",
    );
    expect(screen.getByLabelText("Vendor")).toHaveValue("Concurrent vendor");

    fireEvent.click(screen.getByRole("button", { name: "Save asset" }));

    await waitFor(() => expect(updateFacilityAsset).toHaveBeenCalledTimes(2));
    expect(updateFacilityAsset).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        name: "Generator revised",
        vendor: "Concurrent vendor",
      }),
      4,
    );
  });

  it("queries the server with search, filters and page offsets", async () => {
    renderPage();

    await waitFor(() =>
      expect(listFacilityAssets).toHaveBeenCalledWith({
        status: "",
        category: "",
        custodianUid: "",
        q: undefined,
        limit: 50,
        offset: 0,
      }),
    );

    fireEvent.change(screen.getByLabelText("Search assets"), {
      target: { value: "basement" },
    });
    await waitFor(() =>
      expect(listFacilityAssets).toHaveBeenCalledWith(
        expect.objectContaining({ q: "basement", offset: 0 }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(listFacilityAssets).toHaveBeenCalledWith(
        expect.objectContaining({ q: "basement", limit: 50, offset: 50 }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Filter by status"), {
      target: { value: "active" },
    });
    await waitFor(() =>
      expect(listFacilityAssets).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active", offset: 0 }),
      ),
    );
  });

  it("selects a tenant custodian in the asset form", async () => {
    (updateFacilityAsset as jest.Mock).mockResolvedValue({
      ...ASSET,
      version: 4,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit GEN-02" }));
    fireEvent.change(screen.getByLabelText("Custodian"), {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save asset" }));

    await waitFor(() =>
      expect(updateFacilityAsset).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          custodianUid: "33333333-3333-4333-8333-333333333333",
        }),
        3,
      ),
    );
  });

  it("sends explicit nulls when nullable fields are cleared", async () => {
    const filledAsset: FacilityAsset = {
      ...ASSET,
      description: "Backup generator",
      custodianUid: "33333333-3333-4333-8333-333333333333",
      vendor: "Old vendor",
      purchaseDate: "2025-01-02",
      purchaseCost: 1234.5,
      warrantyUntil: "2027-01-02",
    };
    (listFacilityAssets as jest.Mock).mockResolvedValue({
      assets: [filledAsset],
      total: 1,
      limit: 50,
      offset: 0,
    });
    (updateFacilityAsset as jest.Mock).mockResolvedValue({
      ...filledAsset,
      version: 4,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit GEN-02" }));
    for (const label of [
      "Description",
      "Department / area",
      "Room",
      "Vendor",
      "Purchased",
      "Cost (₹)",
      "Warranty until",
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
    }
    fireEvent.change(screen.getByLabelText("Custodian"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save asset" }));

    await waitFor(() =>
      expect(updateFacilityAsset).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          description: null,
          locationDepartment: null,
          locationRoom: null,
          custodianUid: null,
          vendor: null,
          purchaseDate: null,
          purchaseCost: null,
          warrantyUntil: null,
        }),
        3,
      ),
    );
  });

  it("records maintenance vendor and cost from the drawer", async () => {
    (getFacilityAsset as jest.Mock).mockResolvedValue({ ...ASSET, events: [] });
    (recordFacilityAssetMaintenance as jest.Mock).mockResolvedValue({
      asset: ASSET,
      event: { id: 8 },
    });
    renderPage();

    const assetRow = (await screen.findByText("GEN-02")).closest("tr");
    expect(assetRow).not.toBeNull();
    fireEvent.click(assetRow!);
    fireEvent.change(await screen.findByLabelText("Maintenance notes"), {
      target: { value: "Replaced coolant hose" },
    });
    fireEvent.change(screen.getByLabelText("Maintenance vendor"), {
      target: { value: "Kirloskar Service" },
    });
    fireEvent.change(screen.getByLabelText("Maintenance cost"), {
      target: { value: "4500.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record maintenance" }));

    await waitFor(() =>
      expect(recordFacilityAssetMaintenance).toHaveBeenCalledWith(
        7,
        "Replaced coolant hose",
        4500.5,
        "Kirloskar Service",
      ),
    );
  });

  it("keeps the form open when a stale refresh also fails", async () => {
    (updateFacilityAsset as jest.Mock).mockRejectedValue(
      new APIError("Facility asset changed since it was loaded", 409, {
        code: "FACILITY_ASSET_STALE_WRITE",
        details: { expectedVersion: 3, currentVersion: 4 },
      }),
    );
    (getFacilityAsset as jest.Mock).mockRejectedValue(new Error("offline"));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit GEN-02" }));
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
      "This asset changed and the latest values could not be loaded. Close and reopen the editor before retrying.",
    );
    expect(screen.getByLabelText("Asset name")).toHaveValue(
      "Generator revised",
    );
  });
});
