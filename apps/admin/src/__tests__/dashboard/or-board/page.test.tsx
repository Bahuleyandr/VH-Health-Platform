import OrBoardPage from "@/app/(with-auth)/dashboard/or-board/page";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const mockRealtime = jest.fn(
   
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

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<OrBoardPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockImplementation(async (endpoint) => {
      if (String(endpoint).startsWith("/theatre/board")) {
        return { date: "2026-06-28", ot_room: null, cases: [] } as never;
      }
      return [] as never; // /theatre/rooms
    });
  });

  it("subscribes to staff:or-board and shows ○ Polling when not live", async () => {
    renderWithQuery(<OrBoardPage />);
    const ind = await screen.findByTestId("or-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:or-board", [["theatre", "board"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<OrBoardPage />);
    const ind = await screen.findByTestId("or-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
