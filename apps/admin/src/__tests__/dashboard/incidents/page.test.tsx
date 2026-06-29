import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import IncidentsPage from "@/app/(with-auth)/dashboard/incidents/page";
import { getIncidents, getIncidentStats } from "@/lib/api/reports";

jest.mock("@/lib/api/reports", () => ({
  getIncidents: jest.fn(),
  getIncidentStats: jest.fn(),
  updateIncident: jest.fn(),
}));

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({
    connected: false,
    subscribed: false,
    denied: null as string | null,
    lastEventAt: null as number | null,
  }),
);
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedGetIncidents = getIncidents as jest.MockedFunction<typeof getIncidents>;
const mockedGetIncidentStats = getIncidentStats as jest.MockedFunction<typeof getIncidentStats>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<IncidentsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedGetIncidents.mockResolvedValue({ incidents: [], total: 0 } as never);
    mockedGetIncidentStats.mockResolvedValue({
      summary: {
        new_count: "0", active_count: "0", sentinel_count: "0", severe_count: "0",
        this_week: "0", this_month: "0", total: "0",
      },
      by_type: [],
    } as never);
  });

  it("subscribes to staff:incidents on both roots and shows ○ Offline when disconnected", async () => {
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:incidents", [["incidents"], ["incident-stats"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
