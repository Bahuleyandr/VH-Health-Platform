import OperationsPage from "@/app/(with-auth)/dashboard/operations/page";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const mockRealtime = jest.fn((..._args: unknown[]) => ({
  connected: false,
  subscribed: false,
  denied: null as string | null,
  lastEventAt: null as number | null,
}));
jest.mock("@/hooks/useRealtimeData", () => ({
  useRealtimeData: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<OperationsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
    mockedFetchAdminAPI.mockImplementation(
      async () =>
        ({
          d: "2026-06-28",
          opd_today: 12,
          opd_completed_today: 8,
          ip_in_house: 7,
          or_cases_today: 3,
          open_critical_alerts: 0,
          collections_today: "34500",
          preauth_pending: 2,
          claims_outstanding: 4,
        }) as never,
    );
  });

  it("subscribes to admin:daily-ops and shows ○ Polling when not live", async () => {
    renderWithQuery(<OperationsPage />);
    const ind = await screen.findByTestId("ops-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("admin:daily-ops", [
      "dashboards",
      "daily-ops",
    ]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });
    renderWithQuery(<OperationsPage />);
    const ind = await screen.findByTestId("ops-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
