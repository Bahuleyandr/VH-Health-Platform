import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExpiryAlertsTab } from "@/app/(with-auth)/dashboard/pharmacy/components/ExpiryAlertsTab";
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
      <ExpiryAlertsTab />
    </QueryClientProvider>,
  );
}

describe("<ExpiryAlertsTab />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetch.mockImplementation((url: unknown) => {
      if (typeof url === "string" && url.startsWith("/pharmacy/inventory/v2/expiry-alerts")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({});
    });
  });

  it("runs the expiry scan via POST /pharmacy/inventory/v2/run-expiry-scan", async () => {
    renderTab();

    await screen.findByText("All clear");

    fireEvent.click(screen.getByRole("button", { name: "Run scan" }));

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith("/pharmacy/inventory/v2/run-expiry-scan", {
        method: "POST",
      }),
    );
  });
});
