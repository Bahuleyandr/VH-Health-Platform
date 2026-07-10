import { render, screen, waitFor } from "@testing-library/react";
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
    mockedFetchAdminAPI.mockImplementation(async (path: string) => {
      if (path.startsWith("/resuscitation/events/recent")) {
        return [
          {
            id: 7, patient_uid: "aaaa-bbbb", event_kind: "code_blue",
            trigger_source: "critical_vital", ward_snapshot: "ICU-A",
            bed_snapshot: "B12", reason: "SpO2 62%", is_drill: false,
            started_at: "2026-06-29T09:55:00.000Z", ended_at: null,
            outcome: null, status: "active",
          },
        ] as never;
      }
      return [
        {
          kind: "vital-anomaly", id: 1, patientId: "42", vitalName: "SpO2", value: 83,
          unit: null, severity: "CRITICAL", message: "low O2", acknowledged: false,
          at: "2026-06-29T10:00:00.000Z",
        },
      ] as never;
    });
  });

  it("subscribes to both alert channels and renders hydrated history", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByText("low O2")).toBeInTheDocument();
    expect(channelCalls).toContain("staff:clinical-alerts");
    expect(channelCalls).toContain("staff:code-blue");
  });

  it("hydrates persisted code-blue history with ward/bed/reason context", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByTestId("code-blue-history")).toBeInTheDocument();
    expect(screen.getByText("ICU-A")).toBeInTheDocument();
    expect(screen.getByText("B12")).toBeInTheDocument();
    expect(screen.getByText("SpO2 62%")).toBeInTheDocument();
    expect(
      mockedFetchAdminAPI.mock.calls.some(([p]) =>
        String(p).startsWith("/resuscitation/events/recent"),
      ),
    ).toBe(true);
  });

  it("re-hydrates persisted events when the realtime channel (re)subscribes", async () => {
    // Same QueryClient across the rerender: with staleTime Infinity the query
    // would never refetch on its own, so a second /resuscitation call can only
    // come from the reconnect effect.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <ClinicalAlertsPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("code-blue-history");
    const callsBefore = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
      String(p).startsWith("/resuscitation/events/recent"),
    ).length;

    rtReturn = { lastMessage: null, connected: true, subscribed: true, denied: null, latencyMs: null };
    view.rerender(
      <QueryClientProvider client={qc}>
        <ClinicalAlertsPage />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      const callsAfter = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
        String(p).startsWith("/resuscitation/events/recent"),
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
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
