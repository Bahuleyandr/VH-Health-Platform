import LabPage from "@/app/(with-auth)/dashboard/lab/page";
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

describe("<LabPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockResolvedValue([] as never);
  });

  it("subscribes to staff:lab on both tab keys and shows ○ Polling when not live", async () => {
    renderWithQuery(<LabPage />);
    const ind = await screen.findByTestId("lab-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:lab", [["lab", "pathologist"], ["lab", "alerts"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<LabPage />);
    const ind = await screen.findByTestId("lab-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
