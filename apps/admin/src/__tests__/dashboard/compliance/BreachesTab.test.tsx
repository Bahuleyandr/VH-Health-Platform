import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { BreachesTab } from "@/app/(with-auth)/dashboard/compliance/components/BreachesTab";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockedFetch = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BreachesTab />
    </QueryClientProvider>,
  );
}

describe("<BreachesTab />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetch.mockImplementation((url: unknown) => {
      if (url === "/compliance/breaches") return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });
  });

  it("reports a new breach via POST /compliance/breach/report with the backend's expected body", async () => {
    renderTab();

    await screen.findByText("No breach notifications");

    fireEvent.click(screen.getByRole("button", { name: /Report Breach/ }));
    fireEvent.change(screen.getByPlaceholderText("Brief description of the breach"), {
      target: { value: "Lost laptop" },
    });
    fireEvent.change(screen.getByPlaceholderText("Detailed description of what happened..."), {
      target: { value: "Unencrypted laptop went missing from the front desk." },
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "high" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith("/compliance/breach/report", {
        method: "POST",
        body: {
          description: "Unencrypted laptop went missing from the front desk.",
          severity: "high",
          affected_records: 12,
        },
      }),
    );
  });
});
