import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import MicrobiologyPage from "@/app/(with-auth)/dashboard/microbiology/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

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

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<MicrobiologyPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockResolvedValue([] as never);
  });

  it("subscribes to staff:micro and shows ○ Polling when not live", async () => {
    renderWithQuery(<MicrobiologyPage />);
    const ind = await screen.findByTestId("micro-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:micro", [["micro"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<MicrobiologyPage />);
    const ind = await screen.findByTestId("micro-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
