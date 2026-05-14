import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import BedsPage from "@/app/(with-auth)/dashboard/beds/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<BedsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedFetchAdminAPI.mockImplementation(async (endpoint, init) => {
      if (!init && endpoint === "/beds") {
        return [
          { id: 1, bed_number: "B-101", status: "occupied", ward_id: 1, ward_name: "Ward A", patient_name: "Asha" },
          { id: 2, bed_number: "B-102", status: "available", ward_id: 1, ward_name: "Ward A", patient_name: null },
        ] as never;
      }
      // BedsPage gained an /beds/occupancy summary fetch (page.tsx:95-103);
      // the component renders occupancy.overall.total behind a truthy
      // `occupancy ?` guard, so a missing mock case fell through to the
      // `return []` default and `[].overall.total` threw. Provide the
      // real OccupancySummary shape, consistent with the 2 beds above.
      if (!init && endpoint === "/beds/occupancy") {
        return {
          overall: {
            total: 2,
            occupied: 1,
            available: 1,
            reserved: 0,
            maintenance: 0,
            cleaning: 0,
            occupancy_rate: 50,
          },
          by_ward: [
            { ward_id: 1, ward_name: "Ward A", floor: 2, total: 2, occupied: 1, available: 1 },
          ],
          by_type: [],
        } as never;
      }
      if (!init && endpoint === "/wards") {
        return [{ id: 1, name: "Ward A", floor: 2 }] as never;
      }
      if (init?.method === "PUT" && String(endpoint).startsWith("/beds/")) {
        return { success: true } as never;
      }
      return [] as never;
    });
  });

  it("filters beds by status using the status dropdown", async () => {
    const user = userEvent.setup();
    renderWithQuery(<BedsPage />);

    await screen.findByText("B-101");
    expect(screen.getByText("B-102")).toBeInTheDocument();

    // page.tsx renders the Status <select> first, the Ward <select>
    // second — selects[0] is the status filter.
    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0], "occupied");

    expect(screen.getByText("B-101")).toBeInTheDocument();
    expect(screen.queryByText("B-102")).not.toBeInTheDocument();
  });

  // BedsPage has no edit-status modal / Save button / PUT /beds/:id —
  // the component drives status changes through per-bed action buttons
  // (Admit / Transfer / Discharge / Ready) hitting POST endpoints. The
  // old "edit modal + Save + PUT" test was written against a UI that no
  // longer exists. This replacement exercises the real Discharge action
  // on the seeded occupied bed (B-101): window.confirm → POST
  // /beds/:id/discharge.
  it("discharges an occupied bed through POST /beds/:id/discharge", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderWithQuery(<BedsPage />);

      await screen.findByText("B-101");
      // B-101 is occupied → its tile exposes a "Discharge" button.
      await user.click(screen.getByRole("button", { name: "Discharge" }));

      await waitFor(() => {
        expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
          "/beds/1/discharge",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(confirmSpy).toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
