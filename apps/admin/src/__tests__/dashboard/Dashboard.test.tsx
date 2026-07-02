import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import Dashboard from "@/app/(with-auth)/dashboard/Dashboard";
import { useDashboardData } from "@/app/(with-auth)/dashboard/hooks/useDashboardData";

jest.mock("@/app/(with-auth)/dashboard/hooks/useDashboardData", () => ({
  useDashboardData: jest.fn(),
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
  health: null,
  charts: { labels: [], users: [], appts: [] },
  lastUpdated: new Date("2026-07-02T08:00:00.000Z"),
  secondsAgo: 0,
  queue: { waiting: 2, inProgress: 1, completed: 3 },
  prevQueue: { waiting: 1, inProgress: 1, completed: 2 },
  infraHealth: null,
  refreshCache: jest.fn(),
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
    expect(screen.getByTestId("dashboard-kpi-realtime-indicator")).toHaveTextContent(
      "○ Polling",
    );
  });

  it("shows live when admin:kpi is subscribed", () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });

    renderWithQuery(<Dashboard />);

    expect(screen.getByTestId("dashboard-kpi-realtime-indicator")).toHaveTextContent(
      "● Live",
    );
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

    const appointmentsCard = screen
      .getByText("Today's Appointments")
      .parentElement;
    expect(appointmentsCard).not.toBeNull();
    expect(within(appointmentsCard as HTMLElement).getByText("11")).toBeInTheDocument();
  });
});
