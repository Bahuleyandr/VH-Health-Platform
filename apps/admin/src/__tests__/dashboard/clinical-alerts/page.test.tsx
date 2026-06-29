import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import ClinicalAlertsPage from "@/app/(with-auth)/dashboard/clinical-alerts/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const channelCalls: string[] = [];
let rtReturn: {
  lastMessage: null;
  connected: boolean;
  subscribed: boolean;
  denied: string | null;
  latencyMs: number | null;
} = { lastMessage: null, connected: false, subscribed: false, denied: null, latencyMs: null };

jest.mock("@/hooks/useRealtimeChannel", () => ({
  useRealtimeChannel: (channel: string) => {
    channelCalls.push(channel);
    return rtReturn;
  },
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<ClinicalAlertsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    channelCalls.length = 0;
    rtReturn = { lastMessage: null, connected: false, subscribed: false, denied: null, latencyMs: null };
    mockedFetchAdminAPI.mockResolvedValue([
      {
        kind: "vital-anomaly", id: 1, patientId: "42", vitalName: "SpO2", value: 83,
        unit: null, severity: "CRITICAL", message: "low O2", acknowledged: false,
        at: "2026-06-29T10:00:00.000Z",
      },
    ] as never);
  });

  it("subscribes to both alert channels and renders hydrated history", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByText("low O2")).toBeInTheDocument();
    expect(channelCalls).toContain("staff:clinical-alerts");
    expect(channelCalls).toContain("staff:code-blue");
  });

  it("indicator reads Offline when disconnected", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByTestId("clinical-alerts-realtime-indicator")).toHaveTextContent("Offline");
  });

  it("indicator reads Live when subscribed", async () => {
    rtReturn = { lastMessage: null, connected: true, subscribed: true, denied: null, latencyMs: null };
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByTestId("clinical-alerts-realtime-indicator")).toHaveTextContent("Live");
  });
});
