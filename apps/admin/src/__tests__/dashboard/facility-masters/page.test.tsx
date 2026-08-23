import FacilityMastersPage from "@/app/(with-auth)/dashboard/facility-masters/page";
import {
  listFacilities,
  saveFacility,
  seedDefaultFacility,
} from "@/lib/api/facilityMasters";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/facilityMasters", () => ({
  FACILITY_KINDS: ["hospital", "clinic", "other"],
  FACILITY_STATUSES: ["active", "paused", "archived"],
  LOCATION_KINDS: ["ward", "opd", "other"],
  LOCATION_STATUSES: ["active", "paused", "archived"],
  ROOM_KINDS: ["general", "icu", "other"],
  ROOM_STATUSES: ["active", "maintenance", "archived"],
  SERVICE_KINDS: ["consultation", "procedure", "other"],
  SERVICE_STATUSES: ["draft", "active", "paused", "archived"],
  listFacilities: jest.fn(),
  getDefaultFacility: jest.fn(),
  saveFacility: jest.fn(),
  seedDefaultFacility: jest.fn(),
  listFacilityLocations: jest.fn(),
  saveFacilityLocation: jest.fn(),
  listFacilityRooms: jest.fn(),
  saveFacilityRoom: jest.fn(),
  listFacilityServices: jest.fn(),
  saveFacilityService: jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const FACILITY = {
  id: 1,
  tenant_id: "35353535-3535-4353-8535-353535353503",
  facility_code: "MAIN",
  display_name: "Main Hospital",
  facility_kind: "hospital",
  legal_entity_name: null,
  registration_number: null,
  address_line1: null,
  address_line2: null,
  city: "Chennai",
  state: "TN",
  country: "IN",
  postal_code: null,
  timezone: "Asia/Kolkata",
  phone: null,
  email: null,
  status: "active",
  is_default: true,
  geo_lat: null,
  geo_lng: null,
  metadata: {},
  created_by: null,
  created_at: "2026-08-20T05:00:00.000Z",
  updated_at: "2026-08-21T05:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FacilityMastersPage />
    </QueryClientProvider>,
  );
}

describe("<FacilityMastersPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listFacilities as jest.Mock).mockResolvedValue({
      facilities: [FACILITY],
      count: 1,
    });
    (seedDefaultFacility as jest.Mock).mockResolvedValue(FACILITY);
    (saveFacility as jest.Mock).mockResolvedValue(FACILITY);
  });

  it("renders the facility list with status and default badge", async () => {
    renderPage();
    await screen.findByText("Main Hospital");
    expect(screen.getByText("MAIN")).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText("Chennai")).toBeInTheDocument();
  });

  it("seeds the default facility only after explicit confirmation", async () => {
    renderPage();
    await screen.findByText("Main Hospital");

    fireEvent.click(
      screen.getByRole("button", { name: /Seed default facility/ }),
    );
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(seedDefaultFacility).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Seed facility$/ }));
    await waitFor(() => expect(seedDefaultFacility).toHaveBeenCalledTimes(1));
  });

  it("does not seed when the confirmation is cancelled", async () => {
    renderPage();
    await screen.findByText("Main Hospital");

    fireEvent.click(
      screen.getByRole("button", { name: /Seed default facility/ }),
    );
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(seedDefaultFacility).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("saves an edited facility through the upsert endpoint with its id", async () => {
    renderPage();
    await screen.findByText("Main Hospital");

    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    const nameInput = await screen.findByLabelText("Display name");
    fireEvent.change(nameInput, { target: { value: "Main Hospital Annex" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(saveFacility).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          facility_code: "MAIN",
          display_name: "Main Hospital Annex",
        }),
      ),
    );
  });
});
