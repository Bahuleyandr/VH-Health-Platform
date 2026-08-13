import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import Dashboard from "@/app/(with-auth)/dashboard/Dashboard";
import { useDashboardData } from "@/app/(with-auth)/dashboard/hooks/useDashboardData";
import { useTeleconsultOpsSnapshot } from "@/app/(with-auth)/dashboard/hooks/useTeleconsultOpsSnapshot";

jest.mock("@/app/(with-auth)/dashboard/hooks/useDashboardData", () => ({
  useDashboardData: jest.fn(),
}));

jest.mock(
  "@/app/(with-auth)/dashboard/hooks/useTeleconsultOpsSnapshot",
  () => ({
    useTeleconsultOpsSnapshot: jest.fn(),
  }),
);

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({
    connected: false,
    subscribed: false,
    denied: null as string | null,
    lastEventAt: null as number | null,
  }),
);

jest.mock("@/hooks/useRealtimeData", () => ({
  useRealtimeData: (...args: unknown[]) => mockRealtime(...args),
}));

jest.mock(
  "@/app/(with-auth)/dashboard/components/LiveBedOccupancyTile",
  () =>
    function MockLiveBedOccupancyTile() {
      return <div data-testid="live-bed-occupancy-tile" />;
    },
);

const mockedUseDashboardData = useDashboardData as jest.MockedFunction<
  typeof useDashboardData
>;
const mockedUseTeleconsultOpsSnapshot =
  useTeleconsultOpsSnapshot as jest.MockedFunction<
    typeof useTeleconsultOpsSnapshot
  >;

const dashboardData = {
  loading: false,
  refreshing: false,
  quick: {
    totalUsers: 100,
    presentStaff: 12,
    availableDoctors: 4,
    appointmentsToday: 20,
  },
  prevQuick: {
    totalUsers: 96,
    presentStaff: 10,
    availableDoctors: 5,
    appointmentsToday: 18,
  },
  activity: [],
  health: { status: "unknown" as const },
  charts: { labels: [], users: [], appts: [] },
  lastUpdated: new Date("2026-07-02T08:00:00.000Z"),
  secondsAgo: 0,
  queue: { waiting: 2, inProgress: 1, completed: 3 },
  prevQueue: { waiting: 1, inProgress: 1, completed: 2 },
  infraHealth: null,
  refreshCache: jest.fn(),
};

const teleconsultSnapshot = {
  generated_at: "2026-07-02T08:00:00.000Z",
  window_hours: 24,
  livekit_enabled: false,
  recording_enabled: false,
  media_boundary: "hospital_infra_only",
  queue_model: "doctor_department_badge",
  teleconsult_count: 12,
  active_count: 3,
  waiting_count: 2,
  scheduled_count: 4,
  terminal_count: 6,
  video_session_count: 5,
  join_failure_count: 1,
  turn_session_count: 4,
  turn_usage_rate_pct: 80,
  consent_recorded_count: 9,
  consent_recorded_rate_pct: 75,
  final_modality_distribution: { video: 5, audio: 1, chat: 0, hybrid: 0 },
  status_counts: { scheduled: 4, waiting: 2, in_progress: 3 },
  video_session_counts: { active: 3, failed: 1, ended: 1 },
  provider_counts: { livekit: 5 },
};

function renderWithQuery(
  ui: ReactElement,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("<Dashboard /> realtime KPI row", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseDashboardData.mockReturnValue(dashboardData);
    mockedUseTeleconsultOpsSnapshot.mockReturnValue({
      data: teleconsultSnapshot,
      error: null,
      isLoading: false,
      realtime: {
        connected: false,
        subscribed: false,
        denied: null,
        lastEventAt: null,
      },
    } as unknown as ReturnType<typeof useTeleconsultOpsSnapshot>);
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
  });

  it("subscribes the home stats row to admin:kpi and shows polling", () => {
    renderWithQuery(<Dashboard />);

    expect(mockRealtime).toHaveBeenCalledWith("admin:kpi", [
      "dashboard",
      "admin-kpi",
    ]);
    expect(
      screen.getByTestId("dashboard-kpi-realtime-indicator"),
    ).toHaveTextContent("○ Polling");
  });

  it("shows live when admin:kpi is subscribed", () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });

    renderWithQuery(<Dashboard />);

    expect(
      screen.getByTestId("dashboard-kpi-realtime-indicator"),
    ).toHaveTextContent("● Live");
  });

  it("projects waiting-queue KPI snapshots onto the visible stats row", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["dashboard", "admin-kpi"], {
      tile: "waiting-queue",
      value: { waiting: 6, inProgress: 2, activeDoctors: 3 },
      at: "2026-07-02T08:01:00.000Z",
    });

    renderWithQuery(<Dashboard />, queryClient);

    const appointmentsCard = screen.getByText(
      "Today's Appointments",
    ).parentElement;
    expect(appointmentsCard).not.toBeNull();
    expect(
      within(appointmentsCard as HTMLElement).getByText("11"),
    ).toBeInTheDocument();
  });

  it("renders the teleconsult ops panel from the mocked hook", () => {
    renderWithQuery(<Dashboard />);

    expect(screen.getByTestId("teleconsult-ops-panel")).toBeInTheDocument();
    expect(mockedUseTeleconsultOpsSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Teleconsult Operations")).toBeInTheDocument();
    expect(screen.getByText("TURN usage")).toBeInTheDocument();
    expect(screen.getByText("80.0%")).toBeInTheDocument();
  });
});
