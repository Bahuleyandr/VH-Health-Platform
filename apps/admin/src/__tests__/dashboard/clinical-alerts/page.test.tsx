import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import ClinicalAlertsPage from "@/app/(with-auth)/dashboard/clinical-alerts/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const channelCalls: string[] = [];
const channelOptions = new Map<
  string,
  { onEvent?: (message: unknown) => void }
>();
let rtReturn: {
  lastMessage: null;
  connected: boolean;
  subscribed: boolean;
  denied: string | null;
  latencyMs: number | null;
} = {
  lastMessage: null,
  connected: false,
  subscribed: false,
  denied: null,
  latencyMs: null,
};

jest.mock("@/hooks/useRealtimeChannel", () => ({
  useRealtimeChannel: (
    channel: string,
    options?: { onEvent?: (message: unknown) => void },
  ) => {
    channelCalls.push(channel);
    channelOptions.set(channel, options ?? {});
    return rtReturn;
  },
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<ClinicalAlertsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    channelCalls.length = 0;
    channelOptions.clear();
    rtReturn = {
      lastMessage: null,
      connected: false,
      subscribed: false,
      denied: null,
      latencyMs: null,
    };
    mockedFetchAdminAPI.mockImplementation(async (path: string) => {
      if (path.startsWith("/resuscitation/events/recent")) {
        return [
          {
            id: 7,
            patient_uid: "aaaa-bbbb",
            event_kind: "code_blue",
            trigger_source: "critical_vital",
            ward_snapshot: "ICU-A",
            bed_snapshot: "B12",
            reason: "SpO2 62%",
            is_drill: false,
            started_at: "2026-06-29T09:55:00.000Z",
            ended_at: null,
            outcome: null,
            status: "active",
          },
        ] as never;
      }
      if (path.startsWith("/stemi-pathway/activations")) {
        return {
          activations: [
            {
              id: 19,
              patient_uid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              activation_source: "ed_triage",
              status: "lab_notified",
              activated_at: "2026-07-11T09:56:00.000Z",
              door_time_at: "2026-07-11T09:50:00.000Z",
              ecg_at: "2026-07-11T09:55:00.000Z",
              cath_case_id: 91,
              targets_pending: false,
              sla_instances: [
                {
                  id: "sla-ecg",
                  rule_code: "stemi_door_to_ecg",
                  status: "completed",
                  completed_at: "2026-07-11T09:55:00.000Z",
                },
                {
                  id: "sla-lab",
                  rule_code: "stemi_door_to_lab",
                  status: "active",
                  started_at: null,
                  due_at: null,
                  metadata: { clock_start_pending: true },
                },
                {
                  id: "sla-balloon",
                  rule_code: "stemi_door_to_balloon",
                  status: "active",
                  metadata: { targets_pending: true },
                },
              ],
            },
          ],
          count: 1,
        } as never;
      }
      return [
        {
          kind: "vital-anomaly",
          id: 1,
          patientId: "42",
          vitalName: "SpO2",
          value: 83,
          unit: null,
          severity: "CRITICAL",
          message: "low O2",
          acknowledged: false,
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
    expect(channelCalls).toContain("staff:code-stemi");
  });

  it("hydrates active STEMI pathways from persisted rows with clocks and status", async () => {
    renderWithQuery(<ClinicalAlertsPage />);

    await screen.findByText("Code STEMI #19");
    const board = screen.getByTestId("active-stemi-pathways");
    expect(board).toHaveTextContent("Code STEMI #19");
    expect(board).toHaveTextContent("lab notified");
    expect(board).toHaveTextContent(
      "Patient cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    expect(board).toHaveTextContent("Cath case #91");
    expect(board).toHaveTextContent("Door-to-ECG");
    expect(board).toHaveTextContent("Door-to-lab");
    expect(board).toHaveTextContent("Door-to-balloon");
    expect(board).toHaveTextContent("Target pending");
    expect(board).toHaveTextContent("Door time pending");
    expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
      "/stemi-pathway/activations?active_only=true&limit=50",
    );
  });

  it("uses the STEMI push only to refetch persisted activation history", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    await screen.findByText("Code STEMI #19");
    const callsBefore = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
      String(p).startsWith("/stemi-pathway/activations"),
    ).length;

    channelOptions.get("staff:code-stemi")?.onEvent?.({
      channel: "staff:code-stemi",
      data: { kind: "code-stemi", activationId: 19 },
    });

    await waitFor(() => {
      const callsAfter = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
        String(p).startsWith("/stemi-pathway/activations"),
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("fails closed when durable STEMI pathway hydration is unavailable", async () => {
    mockedFetchAdminAPI.mockImplementation(async (path: string) => {
      if (path.startsWith("/stemi-pathway/activations")) {
        throw new Error("synthetic STEMI API outage");
      }
      return [] as never;
    });

    renderWithQuery(<ClinicalAlertsPage />);

    const board = await screen.findByTestId("active-stemi-pathways");
    await waitFor(() => {
      expect(board).toHaveTextContent(
        "Code STEMI pathway status is unavailable",
      );
    });
    expect(board).toHaveTextContent("Do not treat this as an all-clear");
    expect(board).not.toHaveTextContent("No active Code STEMI pathways");
  });

  it("fails closed when durable STEMI hydration returns a malformed success", async () => {
    mockedFetchAdminAPI.mockImplementation(async (path: string) => {
      if (path.startsWith("/stemi-pathway/activations")) {
        return { count: 0 } as never;
      }
      return [] as never;
    });

    renderWithQuery(<ClinicalAlertsPage />);

    const board = await screen.findByTestId("active-stemi-pathways");
    await waitFor(() => {
      expect(board).toHaveTextContent(
        "Code STEMI pathway status is unavailable",
      );
    });
    expect(board).not.toHaveTextContent("No active Code STEMI pathways");
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
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={qc}>
        <ClinicalAlertsPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("code-blue-history");
    const callsBefore = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
      String(p).startsWith("/resuscitation/events/recent"),
    ).length;
    const stemiCallsBefore = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
      String(p).startsWith("/stemi-pathway/activations"),
    ).length;

    rtReturn = {
      lastMessage: null,
      connected: true,
      subscribed: true,
      denied: null,
      latencyMs: null,
    };
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
      const stemiCallsAfter = mockedFetchAdminAPI.mock.calls.filter(([p]) =>
        String(p).startsWith("/stemi-pathway/activations"),
      ).length;
      expect(stemiCallsAfter).toBeGreaterThan(stemiCallsBefore);
    });
  });

  it("indicator reads Offline when disconnected", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(
      await screen.findByTestId("clinical-alerts-realtime-indicator"),
    ).toHaveTextContent("Offline");
  });

  it("indicator reads Live when subscribed", async () => {
    rtReturn = {
      lastMessage: null,
      connected: true,
      subscribed: true,
      denied: null,
      latencyMs: null,
    };
    renderWithQuery(<ClinicalAlertsPage />);
    expect(
      await screen.findByTestId("clinical-alerts-realtime-indicator"),
    ).toHaveTextContent("Live");
  });
});
