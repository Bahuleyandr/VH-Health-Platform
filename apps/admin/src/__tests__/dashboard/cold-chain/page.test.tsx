import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import ColdChainPage from "@/app/(with-auth)/dashboard/cold-chain/page";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({
    units: [],
    excursions: [],
    recent_readings: [],
    blood_bank_review_flags: [],
  }),
  postJSON: jest.fn().mockResolvedValue({}),
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

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<ColdChainPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });

  it("subscribes to staff:cold-chain on the cold-chain query root and shows Offline when down", async () => {
    renderWithQuery(<ColdChainPage />);
    const indicator = await screen.findByTestId("cold-chain-realtime-indicator");
    expect(indicator).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:cold-chain", [["cold-chain"]]);
  });

  it("shows Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<ColdChainPage />);
    expect(await screen.findByTestId("cold-chain-realtime-indicator")).toHaveTextContent("Live");
  });
});
