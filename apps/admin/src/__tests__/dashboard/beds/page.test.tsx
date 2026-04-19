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

    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[1], "occupied");

    expect(screen.getByText("B-101")).toBeInTheDocument();
    expect(screen.queryByText("B-102")).not.toBeInTheDocument();
  });

  it("opens edit modal and saves updated status through PUT", async () => {
    const user = userEvent.setup();
    renderWithQuery(<BedsPage />);

    await screen.findByText("B-101");
    await user.click(screen.getByText("B-101"));

    await screen.findByRole("button", { name: "Save" });
    const statusSelect = screen.getAllByRole("combobox")[2];
    await user.selectOptions(statusSelect, "reserved");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
        "/beds/1",
        expect.objectContaining({
          method: "PUT",
        }),
      );
    });
  });
});
