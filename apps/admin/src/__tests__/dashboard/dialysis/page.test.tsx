import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import DialysisPage from "@/app/(with-auth)/dashboard/dialysis/page";

// Stub the three tabs so the page test never mounts real queries/WS.
jest.mock("@/app/(with-auth)/dashboard/dialysis/components/TodayBoardTab", () => ({
  __esModule: true,
  default: () => <div data-testid="today-tab" />,
}));
jest.mock("@/app/(with-auth)/dashboard/dialysis/components/RosterTab", () => ({
  __esModule: true,
  default: () => <div data-testid="roster-tab" />,
}));
jest.mock("@/app/(with-auth)/dashboard/dialysis/components/SessionTab", () => ({
  __esModule: true,
  default: () => <div data-testid="session-tab" />,
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

function renderPage(ui: ReactElement) {
  return render(ui);
}

describe("<DialysisPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });

  it("subscribes to staff:dialysis-board on the [\"dialysis\"] root and shows ○ Polling when down", () => {
    renderPage(<DialysisPage />);
    const ind = screen.getByTestId("dialysis-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:dialysis-board", [["dialysis"]]);
  });

  it("shows ● Live when subscribed", () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderPage(<DialysisPage />);
    expect(screen.getByTestId("dialysis-realtime-indicator")).toHaveTextContent("Live");
  });
});
